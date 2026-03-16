import type {
  PdfCrossReferenceKind,
  PdfCrossReferenceSection,
  PdfDocumentSource,
  PdfIndirectObjectShell,
  PdfNormalizedAdmissionPolicy,
  PdfObjectRef,
  PdfParseCoverage,
  PdfRepairState,
  PdfTrailerShell,
} from "./contracts.ts";

export interface ParsedIndirectObject extends PdfIndirectObjectShell {
  readonly dictionaryEntries: ReadonlyMap<string, string>;
  readonly streamText?: string;
}

export interface ParsedPageEntry {
  readonly pageNumber: number;
  readonly pageRef: PdfObjectRef;
  readonly contentStreamRefs: readonly PdfObjectRef[];
  readonly annotationRefs: readonly PdfObjectRef[];
  readonly resourceRef?: PdfObjectRef;
  readonly resourceCount: number;
}

export interface PdfShellAnalysis {
  readonly scanText: string;
  readonly byteLength: number;
  readonly isTruncated: boolean;
  readonly fileType: "pdf" | "unknown";
  readonly pdfVersion?: string;
  readonly startXrefOffset?: number;
  readonly startXrefResolved: boolean;
  readonly crossReferenceKind: PdfCrossReferenceKind;
  readonly crossReferenceSections: readonly PdfCrossReferenceSection[];
  readonly trailer?: PdfTrailerShell;
  readonly indirectObjects: readonly ParsedIndirectObject[];
  readonly objectIndex: ReadonlyMap<string, ParsedIndirectObject>;
  readonly pageEntries: readonly ParsedPageEntry[];
  readonly pageTreeResolved: boolean;
  readonly pageCountEstimate?: number;
  readonly objectCountEstimate?: number;
  readonly parseCoverage: PdfParseCoverage;
  readonly repairState: PdfRepairState;
}

export function analyzePdfShell(
  source: PdfDocumentSource,
  policy: PdfNormalizedAdmissionPolicy,
): PdfShellAnalysis {
  const scanText = decodeLatin1(source.bytes, policy.resourceBudget.maxScanBytes);
  const byteLength = source.bytes.byteLength;
  const isTruncated = scanText.length < byteLength;
  const header = findPdfHeader(scanText);
  const fileType = header ? "pdf" : "unknown";
  const indirectObjects = parseIndirectObjects(scanText);
  const objectIndex = new Map(indirectObjects.map((objectShell) => [keyOfObjectRef(objectShell.ref), objectShell] as const));
  const crossReferenceSections = collectCrossReferenceSections(scanText, indirectObjects);
  const startXrefOffset = readStartXrefOffset(scanText);
  const startXrefResolved = resolveStartXref(startXrefOffset, crossReferenceSections);
  const trailer = parseTrailerShell(scanText, indirectObjects);
  const pageTree = buildPageEntries(trailer, objectIndex, indirectObjects);
  const pageEntries = pageTree.pages;
  const pageCountEstimate = pageEntries.length > 0 ? pageEntries.length : countPageObjects(indirectObjects);
  const objectCountEstimate = indirectObjects.length === 0 ? undefined : indirectObjects.length;
  const parseCoverage: PdfParseCoverage = {
    header: header !== undefined,
    indirectObjects: indirectObjects.length > 0,
    crossReference: crossReferenceSections.length > 0,
    trailer: trailer !== undefined,
    startXref: startXrefOffset !== undefined,
    pageTree: pageTree.resolved,
  };

  return {
    scanText,
    byteLength,
    isTruncated,
    fileType,
    ...(header?.version !== undefined ? { pdfVersion: header.version } : {}),
    ...(startXrefOffset !== undefined ? { startXrefOffset } : {}),
    startXrefResolved,
    crossReferenceKind: summarizeCrossReferenceKind(crossReferenceSections),
    crossReferenceSections,
    ...(trailer !== undefined ? { trailer } : {}),
    indirectObjects,
    objectIndex,
    pageEntries,
    pageTreeResolved: pageTree.resolved,
    ...(pageCountEstimate !== undefined ? { pageCountEstimate } : {}),
    ...(objectCountEstimate !== undefined ? { objectCountEstimate } : {}),
    parseCoverage,
    repairState: detectRepairState({
      fileType,
      parseCoverage,
      isTruncated,
      startXrefResolved,
      hasPages: pageEntries.length > 0,
    }),
  };
}

export function keyOfObjectRef(objectRef: PdfObjectRef): string {
  return `${objectRef.objectNumber}:${objectRef.generationNumber}`;
}

function decodeLatin1(bytes: Uint8Array, limit = bytes.byteLength): string {
  return new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(limit, bytes.byteLength)));
}

function findPdfHeader(text: string): { version: string; offset: number } | undefined {
  const marker = "%PDF-";
  const offset = text.indexOf(marker);
  if (offset < 0) {
    return undefined;
  }

  const versionStart = offset + marker.length;
  let version = "";
  for (let index = versionStart; index < text.length; index += 1) {
    const current = text[index] ?? "";
    if (isDigit(current) || current === ".") {
      version += current;
      continue;
    }
    break;
  }

  return version.length === 0 ? undefined : { version, offset };
}

function readStartXrefOffset(text: string): number | undefined {
  const keywordIndex = text.lastIndexOf("startxref");
  if (keywordIndex < 0) {
    return undefined;
  }

  const valueStart = skipPdfWhitespaceAndComments(text, keywordIndex + "startxref".length);
  const integerToken = readUnsignedInteger(text, valueStart);
  return integerToken?.value;
}

function resolveStartXref(
  startXrefOffset: number | undefined,
  crossReferenceSections: readonly PdfCrossReferenceSection[],
): boolean {
  if (startXrefOffset === undefined) {
    return false;
  }

  return crossReferenceSections.some((section) => section.offset === startXrefOffset);
}

function summarizeCrossReferenceKind(
  crossReferenceSections: readonly PdfCrossReferenceSection[],
): PdfCrossReferenceKind {
  const hasClassic = crossReferenceSections.some((section) => section.kind === "classic");
  const hasStream = crossReferenceSections.some((section) => section.kind === "xref-stream");

  if (hasClassic && hasStream) {
    return "hybrid";
  }
  if (hasStream) {
    return "xref-stream";
  }
  if (hasClassic) {
    return "classic";
  }
  return "unknown";
}

function parseIndirectObjects(text: string): ParsedIndirectObject[] {
  const objects: ParsedIndirectObject[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const objectShell = readIndirectObject(text, index);
    if (!objectShell) {
      continue;
    }

    objects.push(objectShell);
    index = Math.max(index, objectShell.endOffset - 1);
  }

  return objects;
}

function readIndirectObject(text: string, startIndex: number): ParsedIndirectObject | undefined {
  if (!isTokenBoundary(text, startIndex - 1)) {
    return undefined;
  }

  const objectNumber = readUnsignedInteger(text, startIndex);
  if (!objectNumber) {
    return undefined;
  }

  const generationStart = skipPdfWhitespaceAndComments(text, objectNumber.nextIndex);
  const generationNumber = readUnsignedInteger(text, generationStart);
  if (!generationNumber) {
    return undefined;
  }

  const keywordStart = skipPdfWhitespaceAndComments(text, generationNumber.nextIndex);
  if (!matchesPdfKeyword(text, keywordStart, "obj")) {
    return undefined;
  }

  const bodyStart = keywordStart + 3;
  const endObjectIndex = findPdfKeyword(text, "endobj", bodyStart);
  if (endObjectIndex < 0) {
    return undefined;
  }

  const bodyText = text.slice(bodyStart, endObjectIndex);
  const dictionaryText = findFirstDictionaryToken(bodyText);
  const dictionaryEntries = dictionaryText ? parseDictionaryEntries(dictionaryText) : new Map<string, string>();
  const streamInfo = readObjectStream(bodyText);
  const typeName = readNameValue(dictionaryEntries.get("Type"));
  const dictionaryKeys = Array.from(dictionaryEntries.keys());

  return {
    ref: {
      objectNumber: objectNumber.value,
      generationNumber: generationNumber.value,
    },
    offset: startIndex,
    endOffset: endObjectIndex + "endobj".length,
    hasStream: streamInfo !== undefined,
    ...(typeName !== undefined ? { typeName } : {}),
    dictionaryKeys,
    ...(streamInfo?.text !== undefined ? { streamText: streamInfo.text } : {}),
    ...(streamInfo?.text !== undefined ? { streamByteLength: streamInfo.text.length } : {}),
    dictionaryEntries,
  };
}

function readObjectStream(bodyText: string): { text: string } | undefined {
  const streamKeywordIndex = findPdfKeyword(bodyText, "stream", 0);
  if (streamKeywordIndex < 0) {
    return undefined;
  }

  const dataStart = skipStreamLineBreak(bodyText, streamKeywordIndex + "stream".length);
  const endStreamIndex = findPdfKeyword(bodyText, "endstream", dataStart);
  if (endStreamIndex < 0) {
    return undefined;
  }

  return {
    text: bodyText.slice(dataStart, endStreamIndex),
  };
}

function collectCrossReferenceSections(
  text: string,
  indirectObjects: readonly ParsedIndirectObject[],
): PdfCrossReferenceSection[] {
  const sections: PdfCrossReferenceSection[] = [];

  for (let searchStart = 0; searchStart < text.length; searchStart += 1) {
    const keywordIndex = findPdfKeyword(text, "xref", searchStart);
    if (keywordIndex < 0) {
      break;
    }

    const section = readClassicCrossReferenceSection(text, keywordIndex);
    sections.push(section);
    searchStart = keywordIndex;
  }

  for (const objectShell of indirectObjects) {
    if (objectShell.typeName !== "XRef") {
      continue;
    }

    sections.push({
      kind: "xref-stream",
      offset: objectShell.offset,
      ...(readIntegerValue(objectShell.dictionaryEntries.get("Size")) !== undefined
        ? { entryCount: readIntegerValue(objectShell.dictionaryEntries.get("Size")) as number }
        : {}),
      objectRef: objectShell.ref,
    });
  }

  return sections.sort((leftSection, rightSection) => leftSection.offset - rightSection.offset);
}

function readClassicCrossReferenceSection(text: string, keywordIndex: number): PdfCrossReferenceSection {
  let offset = skipPdfWhitespaceAndComments(text, keywordIndex + "xref".length);
  let entryCount = 0;

  while (offset < text.length) {
    const subsectionStart = readUnsignedInteger(text, offset);
    if (!subsectionStart) {
      break;
    }

    const subsectionCountStart = skipPdfWhitespaceAndComments(text, subsectionStart.nextIndex);
    const subsectionCount = readUnsignedInteger(text, subsectionCountStart);
    if (!subsectionCount) {
      break;
    }

    entryCount += subsectionCount.value;
    offset = subsectionCount.nextIndex;
    offset = skipPdfWhitespaceAndComments(text, offset);

    for (let lineIndex = 0; lineIndex < subsectionCount.value; lineIndex += 1) {
      offset = skipCrossReferenceEntry(text, offset);
    }
  }

  return {
    kind: "classic",
    offset: keywordIndex,
    ...(entryCount > 0 ? { entryCount } : {}),
  };
}

function skipCrossReferenceEntry(text: string, startIndex: number): number {
  let index = startIndex;

  while (index < text.length) {
    const current = text[index] ?? "";
    index += 1;
    if (current === "\n") {
      break;
    }
    if (current === "\r") {
      if (text[index] === "\n") {
        index += 1;
      }
      break;
    }
  }

  return skipPdfWhitespaceAndComments(text, index);
}

function parseTrailerShell(
  text: string,
  indirectObjects: readonly ParsedIndirectObject[],
): PdfTrailerShell | undefined {
  const trailerIndex = findLastPdfKeyword(text, "trailer");
  if (trailerIndex >= 0) {
    const dictionaryStart = skipPdfWhitespaceAndComments(text, trailerIndex + "trailer".length);
    const dictionaryText = readPdfDictionaryToken(text, dictionaryStart);
    if (dictionaryText) {
      return toTrailerShell(parseDictionaryEntries(dictionaryText.token));
    }
  }

  const xrefStreamObject = [...indirectObjects].reverse().find((objectShell) => objectShell.typeName === "XRef");
  if (!xrefStreamObject) {
    return undefined;
  }

  return toTrailerShell(xrefStreamObject.dictionaryEntries);
}

function toTrailerShell(dictionaryEntries: ReadonlyMap<string, string>): PdfTrailerShell | undefined {
  const size = readIntegerValue(dictionaryEntries.get("Size"));
  const rootRef = readObjectRefValue(dictionaryEntries.get("Root"));
  const infoRef = readObjectRefValue(dictionaryEntries.get("Info"));
  const encryptRef = readObjectRefValue(dictionaryEntries.get("Encrypt"));
  const prevOffset = readIntegerValue(dictionaryEntries.get("Prev"));
  const hasDocumentId = dictionaryEntries.has("ID");

  if (
    size === undefined &&
    rootRef === undefined &&
    infoRef === undefined &&
    encryptRef === undefined &&
    prevOffset === undefined &&
    !hasDocumentId
  ) {
    return undefined;
  }

  return {
    ...(size !== undefined ? { size } : {}),
    ...(rootRef !== undefined ? { rootRef } : {}),
    ...(infoRef !== undefined ? { infoRef } : {}),
    ...(encryptRef !== undefined ? { encryptRef } : {}),
    ...(prevOffset !== undefined ? { prevOffset } : {}),
    hasDocumentId,
  };
}

function buildPageEntries(
  trailer: PdfTrailerShell | undefined,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
  indirectObjects: readonly ParsedIndirectObject[],
): { pages: ParsedPageEntry[]; resolved: boolean } {
  const rootRef = trailer?.rootRef;
  if (rootRef) {
    const treePages = traversePageTree(rootRef, objectIndex);
    if (treePages.length > 0) {
      return { pages: treePages, resolved: true };
    }
  }

  const fallbackPages = indirectObjects
    .filter((objectShell) => objectShell.typeName === "Page")
    .sort((leftObject, rightObject) => leftObject.offset - rightObject.offset)
    .map((objectShell, pageIndex) => toPageEntry(objectShell, pageIndex + 1));

  return { pages: fallbackPages, resolved: false };
}

function traversePageTree(
  rootRef: PdfObjectRef,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): ParsedPageEntry[] {
  const catalogObject = objectIndex.get(keyOfObjectRef(rootRef));
  if (!catalogObject) {
    return [];
  }

  const pagesRootRef = readObjectRefValue(catalogObject.dictionaryEntries.get("Pages"));
  if (!pagesRootRef) {
    return [];
  }

  const orderedPages: ParsedPageEntry[] = [];
  const visited = new Set<string>();
  const queue: PdfObjectRef[] = [pagesRootRef];

  while (queue.length > 0) {
    const currentRef = queue.shift();
    if (!currentRef) {
      continue;
    }

    const currentKey = keyOfObjectRef(currentRef);
    if (visited.has(currentKey)) {
      continue;
    }
    visited.add(currentKey);

    const currentObject = objectIndex.get(currentKey);
    if (!currentObject) {
      continue;
    }

    if (currentObject.typeName === "Page") {
      orderedPages.push(toPageEntry(currentObject, orderedPages.length + 1));
      continue;
    }

    if (currentObject.typeName !== "Pages") {
      continue;
    }

    const kids = readObjectRefsValue(currentObject.dictionaryEntries.get("Kids"));
    for (const kidRef of kids) {
      queue.push(kidRef);
    }
  }

  return orderedPages;
}

function toPageEntry(objectShell: ParsedIndirectObject, pageNumber: number): ParsedPageEntry {
  const contentStreamRefs = readObjectRefsValue(objectShell.dictionaryEntries.get("Contents"));
  const annotationRefs = readObjectRefsValue(objectShell.dictionaryEntries.get("Annots"));
  const resourceValue = objectShell.dictionaryEntries.get("Resources");
  const resourceRef = readObjectRefValue(resourceValue);

  return {
    pageNumber,
    pageRef: objectShell.ref,
    contentStreamRefs,
    annotationRefs,
    ...(resourceRef !== undefined ? { resourceRef } : {}),
    resourceCount: resourceValue ? 1 : 0,
  };
}

function countPageObjects(indirectObjects: readonly ParsedIndirectObject[]): number | undefined {
  const count = indirectObjects.filter((objectShell) => objectShell.typeName === "Page").length;
  return count === 0 ? undefined : count;
}

function detectRepairState(input: {
  readonly fileType: "pdf" | "unknown";
  readonly parseCoverage: PdfParseCoverage;
  readonly isTruncated: boolean;
  readonly startXrefResolved: boolean;
  readonly hasPages: boolean;
}): PdfRepairState {
  if (input.fileType !== "pdf" || !input.parseCoverage.indirectObjects) {
    return "recovery-required";
  }

  const cleanStructure =
    input.parseCoverage.crossReference &&
    input.parseCoverage.trailer &&
    input.parseCoverage.startXref &&
    input.startXrefResolved;

  if (cleanStructure && !input.isTruncated) {
    return "clean";
  }

  if (!input.hasPages && !input.parseCoverage.trailer && !input.parseCoverage.crossReference) {
    return "recovery-required";
  }

  return "recovered";
}

function parseDictionaryEntries(dictionaryText: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!dictionaryText.startsWith("<<") || !dictionaryText.endsWith(">>")) {
    return entries;
  }

  const innerText = dictionaryText.slice(2, -2);
  let index = 0;

  while (index < innerText.length) {
    index = skipPdfWhitespaceAndComments(innerText, index);
    const keyToken = readPdfNameToken(innerText, index);
    if (!keyToken) {
      index += 1;
      continue;
    }

    const valueStart = skipPdfWhitespaceAndComments(innerText, keyToken.nextIndex);
    const valueToken = readPdfValueToken(innerText, valueStart);
    if (!valueToken) {
      entries.set(keyToken.name, "");
      index = keyToken.nextIndex;
      continue;
    }

    entries.set(keyToken.name, valueToken.token.trim());
    index = valueToken.nextIndex;
  }

  return entries;
}

function readPdfValueToken(
  text: string,
  startIndex: number,
): { token: string; nextIndex: number } | undefined {
  const current = text[startIndex];
  if (current === undefined) {
    return undefined;
  }

  if (current === "<" && text[startIndex + 1] === "<") {
    return readPdfDictionaryToken(text, startIndex);
  }
  if (current === "[") {
    return readPdfRawArrayToken(text, startIndex);
  }
  if (current === "(") {
    return readPdfLiteralToken(text, startIndex);
  }
  if (current === "<") {
    return readPdfHexStringToken(text, startIndex);
  }
  if (current === "/") {
    const nameToken = readPdfNameToken(text, startIndex);
    return nameToken ? { token: nameToken.raw, nextIndex: nameToken.nextIndex } : undefined;
  }

  const firstNumber = readUnsignedInteger(text, startIndex);
  if (firstNumber) {
    const secondStart = skipPdfWhitespaceAndComments(text, firstNumber.nextIndex);
    const secondNumber = readUnsignedInteger(text, secondStart);
    if (secondNumber) {
      const refMarkerStart = skipPdfWhitespaceAndComments(text, secondNumber.nextIndex);
      if (matchesPdfKeyword(text, refMarkerStart, "R")) {
        return {
          token: text.slice(startIndex, refMarkerStart + 1),
          nextIndex: refMarkerStart + 1,
        };
      }
    }

    return {
      token: text.slice(startIndex, firstNumber.nextIndex),
      nextIndex: firstNumber.nextIndex,
    };
  }

  const keywordEnd = readUntilDelimiter(text, startIndex);
  if (keywordEnd <= startIndex) {
    return undefined;
  }

  return {
    token: text.slice(startIndex, keywordEnd),
    nextIndex: keywordEnd,
  };
}

function readPdfDictionaryToken(
  text: string,
  startIndex: number,
): { token: string; nextIndex: number } | undefined {
  if (text[startIndex] !== "<" || text[startIndex + 1] !== "<") {
    return undefined;
  }

  let depth = 1;

  for (let index = startIndex + 2; index < text.length; index += 1) {
    const current = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (current === "%") {
      index = skipPdfComment(text, index);
      continue;
    }

    if (current === "(") {
      const literal = readPdfLiteralToken(text, index);
      if (!literal) {
        return undefined;
      }
      index = literal.nextIndex - 1;
      continue;
    }

    if (current === "<" && next === "<") {
      depth += 1;
      index += 1;
      continue;
    }

    if (current === ">" && next === ">") {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        return {
          token: text.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return undefined;
}

function readPdfRawArrayToken(
  text: string,
  startIndex: number,
): { token: string; nextIndex: number } | undefined {
  if (text[startIndex] !== "[") {
    return undefined;
  }

  let depth = 1;

  for (let index = startIndex + 1; index < text.length; index += 1) {
    const current = text[index] ?? "";

    if (current === "%") {
      index = skipPdfComment(text, index);
      continue;
    }

    if (current === "(") {
      const literal = readPdfLiteralToken(text, index);
      if (!literal) {
        return undefined;
      }
      index = literal.nextIndex - 1;
      continue;
    }

    if (current === "<" && text[index + 1] === "<") {
      const dictionary = readPdfDictionaryToken(text, index);
      if (!dictionary) {
        return undefined;
      }
      index = dictionary.nextIndex - 1;
      continue;
    }

    if (current === "[") {
      depth += 1;
      continue;
    }

    if (current === "]") {
      depth -= 1;
      if (depth === 0) {
        return {
          token: text.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return undefined;
}

function readPdfHexStringToken(
  text: string,
  startIndex: number,
): { token: string; nextIndex: number } | undefined {
  if (text[startIndex] !== "<" || text[startIndex + 1] === "<") {
    return undefined;
  }

  for (let index = startIndex + 1; index < text.length; index += 1) {
    if (text[index] === ">") {
      return {
        token: text.slice(startIndex, index + 1),
        nextIndex: index + 1,
      };
    }
  }

  return undefined;
}

function readPdfLiteralToken(
  text: string,
  startIndex: number,
): { token: string; nextIndex: number } | undefined {
  if (text[startIndex] !== "(") {
    return undefined;
  }

  let depth = 0;

  for (let index = startIndex; index < text.length; index += 1) {
    const current = text[index] ?? "";

    if (current === "\\") {
      index += 1;
      continue;
    }

    if (current === "(") {
      depth += 1;
      continue;
    }

    if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          token: text.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return undefined;
}

function readPdfNameToken(
  text: string,
  startIndex: number,
): { raw: string; name: string; nextIndex: number } | undefined {
  if (text[startIndex] !== "/") {
    return undefined;
  }

  let endIndex = startIndex + 1;
  while (endIndex < text.length && !isPdfDelimiter(text[endIndex] ?? "")) {
    endIndex += 1;
  }

  if (endIndex <= startIndex + 1) {
    return undefined;
  }

  const raw = text.slice(startIndex, endIndex);
  return {
    raw,
    name: raw.slice(1),
    nextIndex: endIndex,
  };
}

function readUnsignedInteger(
  text: string,
  startIndex: number,
): { value: number; nextIndex: number } | undefined {
  if (!isDigit(text[startIndex] ?? "")) {
    return undefined;
  }

  let endIndex = startIndex + 1;
  while (isDigit(text[endIndex] ?? "")) {
    endIndex += 1;
  }

  return {
    value: Number(text.slice(startIndex, endIndex)),
    nextIndex: endIndex,
  };
}

function readObjectRefValue(value: string | undefined): PdfObjectRef | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  const firstNumber = readUnsignedInteger(trimmed, 0);
  if (!firstNumber) {
    return undefined;
  }

  const secondStart = skipPdfWhitespaceAndComments(trimmed, firstNumber.nextIndex);
  const secondNumber = readUnsignedInteger(trimmed, secondStart);
  if (!secondNumber) {
    return undefined;
  }

  const refMarkerStart = skipPdfWhitespaceAndComments(trimmed, secondNumber.nextIndex);
  if (!matchesPdfKeyword(trimmed, refMarkerStart, "R")) {
    return undefined;
  }

  return {
    objectNumber: firstNumber.value,
    generationNumber: secondNumber.value,
  };
}

function readObjectRefsValue(value: string | undefined): PdfObjectRef[] {
  if (!value) {
    return [];
  }

  const directRef = readObjectRefValue(value);
  if (directRef) {
    return [directRef];
  }

  const refs: PdfObjectRef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const objectRef = readObjectRefValue(value.slice(index));
    if (!objectRef) {
      continue;
    }

    refs.push(objectRef);

    const key = `${objectRef.objectNumber} ${objectRef.generationNumber} R`;
    const localIndex = value.indexOf(key, index);
    if (localIndex < 0) {
      continue;
    }
    index = localIndex + key.length - 1;
  }

  return refs;
}

function readIntegerValue(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const integerToken = readUnsignedInteger(value.trim(), 0);
  return integerToken?.value;
}

function readNameValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const nameToken = readPdfNameToken(value.trim(), 0);
  return nameToken?.name;
}

function findFirstDictionaryToken(text: string): string | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const dictionary = readPdfDictionaryToken(text, index);
    if (dictionary) {
      return dictionary.token;
    }
  }

  return undefined;
}

function findPdfKeyword(text: string, keyword: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index += 1) {
    if (matchesPdfKeyword(text, index, keyword)) {
      return index;
    }
  }

  return -1;
}

function findLastPdfKeyword(text: string, keyword: string): number {
  for (let index = text.length - keyword.length; index >= 0; index -= 1) {
    if (matchesPdfKeyword(text, index, keyword)) {
      return index;
    }
  }

  return -1;
}

function matchesPdfKeyword(text: string, index: number, keyword: string): boolean {
  if (text.slice(index, index + keyword.length) !== keyword) {
    return false;
  }

  return isTokenBoundary(text, index - 1) && isTokenBoundary(text, index + keyword.length);
}

function isTokenBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return true;
  }

  return isPdfDelimiter(text[index] ?? "");
}

function isPdfDelimiter(value: string): boolean {
  return (
    value === "" ||
    value === " " ||
    value === "\t" ||
    value === "\n" ||
    value === "\r" ||
    value === "\f" ||
    value === "\0" ||
    value === "(" ||
    value === ")" ||
    value === "<" ||
    value === ">" ||
    value === "[" ||
    value === "]" ||
    value === "{" ||
    value === "}" ||
    value === "/" ||
    value === "%"
  );
}

function skipPdfWhitespaceAndComments(text: string, startIndex: number): number {
  let index = startIndex;

  while (index < text.length) {
    const current = text[index] ?? "";
    if (current === "%") {
      index = skipPdfComment(text, index);
      continue;
    }

    if (
      current === " " ||
      current === "\t" ||
      current === "\n" ||
      current === "\r" ||
      current === "\f" ||
      current === "\0"
    ) {
      index += 1;
      continue;
    }

    break;
  }

  return index;
}

function skipPdfComment(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length) {
    const current = text[index] ?? "";
    index += 1;
    if (current === "\n") {
      break;
    }
    if (current === "\r") {
      if (text[index] === "\n") {
        index += 1;
      }
      break;
    }
  }
  return index;
}

function skipStreamLineBreak(text: string, startIndex: number): number {
  let index = startIndex;
  if (text[index] === "\r") {
    index += 1;
  }
  if (text[index] === "\n") {
    index += 1;
  }
  return index;
}

function readUntilDelimiter(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length && !isPdfDelimiter(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function isDigit(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  const charCode = value.charCodeAt(0);
  return charCode >= 48 && charCode <= 57;
}
