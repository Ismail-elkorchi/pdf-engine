import { PdfByteCursor } from "./pdf-byte-cursor.ts";
import { decodePdfStreamBytes } from "./stream-decode.ts";

import type {
  PdfCrossReferenceKind,
  PdfCrossReferenceSection,
  PdfDocumentSource,
  PdfIndirectObjectShell,
  PdfNormalizedAdmissionPolicy,
  PdfObjectRef,
  PdfParseCoverage,
  PdfPoint,
  PdfPageValueOrigin,
  PdfRepairState,
  PdfStreamRole,
  PdfTrailerShell,
} from "./contracts.ts";
import type { PdfStandardPasswordSecurityHandler } from "./pdf-standard-security.ts";

export interface ParsedIndirectObject extends PdfIndirectObjectShell {
  readonly dictionaryEntries: ReadonlyMap<string, string>;
  readonly objectValueText?: string;
  readonly streamText?: string;
  readonly decodedStreamBytes?: Uint8Array;
  readonly streamStartOffset?: number;
  readonly streamEndOffset?: number;
  readonly streamLengthRef?: PdfObjectRef;
}

export interface ParsedPageEntry {
  readonly pageNumber: number;
  readonly pageRef: PdfObjectRef;
  readonly contentStreamRefs: readonly PdfObjectRef[];
  readonly annotationRefs: readonly PdfObjectRef[];
  readonly fontBindings: readonly ParsedFontResourceBinding[];
  readonly resourceRef?: PdfObjectRef;
  readonly resourceCount: number;
  readonly resourceOrigin?: PdfPageValueOrigin;
}

export interface ParsedFontResourceBinding {
  readonly resourceName: string;
  readonly fontRef: PdfObjectRef;
}

type ParsedTextArrayOperand =
  | { readonly kind: "literal"; readonly token: string }
  | { readonly kind: "hex"; readonly token: string }
  | { readonly kind: "adjustment"; readonly value: number };

type ParsedMarkedContentKind = "artifact" | "span" | "other";

interface ParsedMarkedContentContext {
  readonly kind: ParsedMarkedContentKind;
  readonly actualText?: string;
}

interface ParsedCrossReferenceSection extends PdfCrossReferenceSection {
  readonly trailer?: PdfTrailerShell;
  readonly trailerEntries?: ReadonlyMap<string, string>;
}

export interface ParsedTextOperatorRun {
  readonly operator: "Tj" | "TJ" | "'" | "\"";
  readonly fontResourceName?: string;
  readonly fontSize?: number;
  readonly startsNewLine: boolean;
  readonly anchor?: PdfPoint;
  readonly operands: ReadonlyArray<ParsedTextArrayOperand>;
  readonly markedContentKind?: ParsedMarkedContentKind;
  readonly actualText?: string;
}

export interface PdfShellAnalysis {
  readonly scanText: string;
  readonly byteLength: number;
  readonly isTruncated: boolean;
  readonly usedFullStructureScan: boolean;
  readonly fileType: "pdf" | "unknown";
  readonly pdfVersion?: string;
  readonly startXrefOffset?: number;
  readonly startXrefResolved: boolean;
  readonly crossReferenceKind: PdfCrossReferenceKind;
  readonly crossReferenceSections: readonly PdfCrossReferenceSection[];
  readonly trailer?: PdfTrailerShell;
  readonly documentId?: Uint8Array;
  readonly indirectObjects: readonly ParsedIndirectObject[];
  readonly objectIndex: ReadonlyMap<string, ParsedIndirectObject>;
  readonly pageEntries: readonly ParsedPageEntry[];
  readonly pageTreeResolved: boolean;
  readonly inheritedPageStateResolved: boolean;
  readonly expandedObjectStreams: boolean;
  readonly decodedXrefStreamEntries: boolean;
  readonly pageCountEstimate?: number;
  readonly objectCountEstimate?: number;
  readonly parseCoverage: PdfParseCoverage;
  readonly repairState: PdfRepairState;
}

const FULL_STRUCTURE_SCAN_LIMIT = 8_000_000;

export async function analyzePdfShell(
  source: PdfDocumentSource,
  policy: PdfNormalizedAdmissionPolicy,
  options: {
    readonly securityHandler?: PdfStandardPasswordSecurityHandler;
  } = {},
): Promise<PdfShellAnalysis> {
  const byteLength = source.bytes.byteLength;
  const scanBytes = source.bytes.subarray(0, Math.min(policy.resourceBudget.maxScanBytes, byteLength));
  const scanText = decodePdfBytes(scanBytes);
  const isTruncated = scanBytes.byteLength < byteLength;
  const shouldUseFullStructureScan = isTruncated &&
    byteLength <= Math.min(policy.resourceBudget.maxBytes, FULL_STRUCTURE_SCAN_LIMIT);
  const structureText = shouldUseFullStructureScan ? decodePdfBytes(source.bytes) : scanText;
  const tailStartOffset = isTruncated
    ? Math.max(0, byteLength - policy.resourceBudget.maxScanBytes)
    : 0;
  const tailBytes = isTruncated ? source.bytes.subarray(tailStartOffset) : scanBytes;
  const tailText = isTruncated ? decodePdfBytes(tailBytes) : scanText;
  const header = findPdfHeaderInBytes(scanBytes);
  const fileType = header ? "pdf" : "unknown";
  const parsedIndirectObjects = shouldUseFullStructureScan
    ? parseIndirectObjectsFromBytes(source.bytes)
    : dedupeIndirectObjectsByRef([
      ...parseIndirectObjectsFromBytes(scanBytes),
      ...(isTruncated ? parseIndirectObjectsFromBytes(tailBytes, tailStartOffset) : []),
    ]);
  const provisionalObjectIndex = new Map(
    parsedIndirectObjects.map((objectShell) => [keyOfObjectRef(objectShell.ref), objectShell] as const),
  );
  const finalizedIndirectObjects = await finalizeIndirectObjects(
    parsedIndirectObjects,
    source.bytes,
    provisionalObjectIndex,
    options.securityHandler,
  );
  const expandedObjectStreamResult = expandObjectStreams(finalizedIndirectObjects);
  let indirectObjects = expandedObjectStreamResult.indirectObjects;
  let objectIndex = new Map(indirectObjects.map((objectShell) => [keyOfObjectRef(objectShell.ref), objectShell] as const));
  if (expandedObjectStreamResult.expanded) {
    indirectObjects = await finalizeIndirectObjects(
      indirectObjects,
      source.bytes,
      objectIndex,
      options.securityHandler,
    );
    objectIndex = new Map(indirectObjects.map((objectShell) => [keyOfObjectRef(objectShell.ref), objectShell] as const));
  }
  const discoveredCrossReferenceSections = shouldUseFullStructureScan
    ? collectCrossReferenceSections(structureText, indirectObjects)
    : dedupeCrossReferenceSections([
      ...collectCrossReferenceSections(scanText, indirectObjects),
      ...(isTruncated ? collectCrossReferenceSections(tailText, [], tailStartOffset, false) : []),
    ]);
  const startXrefOffset = shouldUseFullStructureScan
    ? readStartXrefOffsetFromBytes(source.bytes)
    : readStartXrefOffsetFromBytes(tailBytes) ?? (isTruncated ? readStartXrefOffsetFromBytes(scanBytes) : undefined);
  const resolvedCrossReferenceSections = resolveCrossReferenceSections(discoveredCrossReferenceSections, startXrefOffset);
  const startXrefResolved = resolveStartXref(startXrefOffset, resolvedCrossReferenceSections);
  const crossReferenceSections = resolvedCrossReferenceSections.map((section) => ({
    kind: section.kind,
    offset: section.offset,
    ...(section.entryCount !== undefined ? { entryCount: section.entryCount } : {}),
    ...(section.decodedEntryCount !== undefined ? { decodedEntryCount: section.decodedEntryCount } : {}),
    ...(section.objectRef !== undefined ? { objectRef: section.objectRef } : {}),
  }));
  const trailer = resolveCrossReferenceTrailer(resolvedCrossReferenceSections) ??
    (shouldUseFullStructureScan
      ? parseTrailerShell(structureText, indirectObjects)
      : parseTrailerShell(tailText, indirectObjects) ??
        (isTruncated ? parseTrailerShell(scanText, indirectObjects) : undefined));
  const documentId = resolveCrossReferenceDocumentId(resolvedCrossReferenceSections) ??
    (shouldUseFullStructureScan
      ? parseTrailerDocumentId(structureText, indirectObjects)
      : parseTrailerDocumentId(tailText, indirectObjects) ??
        (isTruncated ? parseTrailerDocumentId(scanText, indirectObjects) : undefined));
  const pageTree = buildPageEntries(trailer, objectIndex, indirectObjects);
  const pageEntries = pageTree.pages;
  const classifiedIndirectObjects = classifyIndirectObjectStreamRoles(indirectObjects, pageEntries, objectIndex);
  objectIndex = new Map(classifiedIndirectObjects.map((objectShell) => [keyOfObjectRef(objectShell.ref), objectShell] as const));
  const pageCountEstimate = pageEntries.length > 0 ? pageEntries.length : countPageObjects(classifiedIndirectObjects);
  const objectCountEstimate = classifiedIndirectObjects.length === 0 ? undefined : classifiedIndirectObjects.length;
  const parseCoverage: PdfParseCoverage = {
    header: header !== undefined,
    indirectObjects: classifiedIndirectObjects.length > 0,
    crossReference: crossReferenceSections.length > 0,
    trailer: trailer !== undefined,
    startXref: startXrefOffset !== undefined,
    pageTree: pageTree.resolved,
  };

  return {
    scanText,
    byteLength,
    isTruncated,
    usedFullStructureScan: shouldUseFullStructureScan,
    fileType,
    ...(header?.version !== undefined ? { pdfVersion: header.version } : {}),
    ...(startXrefOffset !== undefined ? { startXrefOffset } : {}),
    startXrefResolved,
    crossReferenceKind: summarizeCrossReferenceKind(crossReferenceSections),
    crossReferenceSections,
    ...(trailer !== undefined ? { trailer } : {}),
    ...(documentId !== undefined ? { documentId } : {}),
    indirectObjects: classifiedIndirectObjects,
    objectIndex,
    pageEntries,
    pageTreeResolved: pageTree.resolved,
    inheritedPageStateResolved: pageTree.inheritedStateResolved,
    expandedObjectStreams: expandedObjectStreamResult.expanded,
    decodedXrefStreamEntries: crossReferenceSections
      .filter((section) => section.kind === "xref-stream")
      .every((section) => section.decodedEntryCount !== undefined),
    ...(pageCountEstimate !== undefined ? { pageCountEstimate } : {}),
    ...(objectCountEstimate !== undefined ? { objectCountEstimate } : {}),
    parseCoverage,
    repairState: detectRepairState({
      fileType,
      parseCoverage,
      isTruncated,
      usedFullStructureScan: shouldUseFullStructureScan,
      startXrefResolved,
      hasPages: pageEntries.length > 0,
    }),
  };
}

export function keyOfObjectRef(objectRef: PdfObjectRef): string {
  return `${objectRef.objectNumber}:${objectRef.generationNumber}`;
}

function decodePdfBytes(bytes: Uint8Array, limit = bytes.byteLength): string {
  const chunkSize = 0x4000;
  const end = Math.min(limit, bytes.byteLength);
  let output = "";

  for (let offset = 0; offset < end; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, end));
    output += String.fromCharCode(...chunk);
  }

  return output;
}

function findPdfHeaderInBytes(bytes: Uint8Array): { version: string; offset: number } | undefined {
  const cursor = new PdfByteCursor(bytes);
  const marker = "%PDF-";
  const offset = cursor.findSequence(marker, 0);
  if (offset < 0) {
    return undefined;
  }

  const versionStart = offset + marker.length;
  let version = "";
  for (let index = versionStart; index < bytes.byteLength; index += 1) {
    const current = bytes[index];
    if ((current !== undefined && current >= 0x30 && current <= 0x39) || current === 0x2e) {
      version += String.fromCharCode(current);
      continue;
    }
    break;
  }

  return version.length === 0 ? undefined : { version, offset };
}

function readStartXrefOffsetFromBytes(bytes: Uint8Array): number | undefined {
  const cursor = new PdfByteCursor(bytes);
  const keywordIndex = cursor.findLastKeyword("startxref");
  if (keywordIndex < 0) {
    return undefined;
  }

  const valueStart = cursor.skipWhitespaceAndComments(keywordIndex + "startxref".length);
  return cursor.readUnsignedInteger(valueStart)?.value;
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

function parseIndirectObjectsFromBytes(bytes: Uint8Array, offsetBase = 0): ParsedIndirectObject[] {
  const cursor = new PdfByteCursor(bytes);
  const objects: ParsedIndirectObject[] = [];

  for (let index = 0; index < bytes.byteLength; index += 1) {
    const objectShell = readIndirectObjectFromBytes(cursor, index, offsetBase);
    if (!objectShell) {
      continue;
    }

    objects.push(objectShell);
    index = Math.max(index, objectShell.endOffset - offsetBase - 1);
  }

  return objects;
}

function dedupeIndirectObjectsByRef(
  indirectObjects: readonly ParsedIndirectObject[],
): ParsedIndirectObject[] {
  const objectByKey = new Map<string, ParsedIndirectObject>();

  for (const objectShell of indirectObjects) {
    const objectKey = keyOfObjectRef(objectShell.ref);
    if (!objectByKey.has(objectKey)) {
      objectByKey.set(objectKey, objectShell);
      continue;
    }

    const currentObject = objectByKey.get(objectKey);
    if (!currentObject || objectShell.offset < currentObject.offset) {
      objectByKey.set(objectKey, objectShell);
    }
  }

  return [...objectByKey.values()].sort((leftObject, rightObject) => leftObject.offset - rightObject.offset);
}

function readIndirectObjectFromBytes(
  cursor: PdfByteCursor,
  startIndex: number,
  offsetBase = 0,
): ParsedIndirectObject | undefined {
  if (!cursor.isTokenBoundary(startIndex - 1)) {
    return undefined;
  }

  const objectNumber = cursor.readUnsignedInteger(startIndex);
  if (!objectNumber) {
    return undefined;
  }

  const generationStart = cursor.skipWhitespaceAndComments(objectNumber.nextOffset);
  const generationNumber = cursor.readUnsignedInteger(generationStart);
  if (!generationNumber) {
    return undefined;
  }

  const keywordStart = cursor.skipWhitespaceAndComments(generationNumber.nextOffset);
  if (!cursor.matchesKeyword(keywordStart, "obj")) {
    return undefined;
  }

  const bodyStart = cursor.skipWhitespaceAndComments(keywordStart + 3);
  const objectBody = readIndirectObjectBodyFromBytes(cursor, bodyStart);
  if (!objectBody) {
    return undefined;
  }

  const bodyText = decodePdfBytes(cursor.slice(bodyStart, objectBody.endObjectIndex));
  const dictionaryText = objectBody.dictionaryText ?? findFirstDictionaryToken(bodyText);
  const dictionaryEntries = dictionaryText ? parseDictionaryEntries(dictionaryText) : new Map<string, string>();
  const typeName = readNameValue(dictionaryEntries.get("Type"));
  const dictionaryKeys = Array.from(dictionaryEntries.keys());

  return {
    ref: {
      objectNumber: objectNumber.value,
      generationNumber: generationNumber.value,
    },
    offset: offsetBase + startIndex,
    endOffset: offsetBase + objectBody.endObjectIndex + "endobj".length,
    hasStream: objectBody.streamInfo !== undefined,
    ...(typeName !== undefined ? { typeName } : {}),
    dictionaryKeys,
    ...(bodyText.trim().length > 0 ? { objectValueText: bodyText.trim() } : {}),
    ...(objectBody.streamInfo?.dataStartOffset !== undefined
      ? { streamStartOffset: offsetBase + objectBody.streamInfo.dataStartOffset }
      : {}),
    ...(objectBody.streamInfo?.dataEndOffset !== undefined
      ? { streamEndOffset: offsetBase + objectBody.streamInfo.dataEndOffset }
      : {}),
    ...(objectBody.streamInfo?.lengthRef !== undefined ? { streamLengthRef: objectBody.streamInfo.lengthRef } : {}),
    dictionaryEntries,
  };
}

function readIndirectObjectBodyFromBytes(
  cursor: PdfByteCursor,
  bodyStart: number,
): {
  endObjectIndex: number;
  dictionaryText?: string;
  streamInfo?: {
    dataStartOffset: number;
    dataEndOffset?: number;
    lengthRef?: PdfObjectRef;
  };
} | undefined {
  const firstEndObjectIndex = cursor.findKeyword("endobj", bodyStart);
  if (firstEndObjectIndex < 0) {
    return undefined;
  }

  const streamKeywordIndex = cursor.findKeyword("stream", bodyStart, firstEndObjectIndex);
  if (streamKeywordIndex < 0 || streamKeywordIndex > firstEndObjectIndex) {
    return {
      endObjectIndex: firstEndObjectIndex,
    };
  }

  const headerText = decodePdfBytes(cursor.slice(bodyStart, streamKeywordIndex));
  const dictionaryText = findFirstDictionaryToken(headerText);
  const dictionaryEntries = dictionaryText ? parseDictionaryEntries(dictionaryText) : new Map<string, string>();
  const streamInfo = readObjectStreamFromBytes(cursor, streamKeywordIndex, dictionaryEntries);
  if (!streamInfo) {
    return {
      endObjectIndex: firstEndObjectIndex,
      ...(dictionaryText !== undefined ? { dictionaryText } : {}),
    };
  }

  const endObjectIndex = cursor.findKeyword("endobj", streamInfo.dataEndOffset ?? streamInfo.dataStartOffset);
  if (endObjectIndex < 0) {
    return undefined;
  }

  return {
    endObjectIndex,
    ...(dictionaryText !== undefined ? { dictionaryText } : {}),
    streamInfo,
  };
}

function readObjectStreamFromBytes(
  cursor: PdfByteCursor,
  streamKeywordIndex: number,
  dictionaryEntries: ReadonlyMap<string, string>,
): {
  dataStartOffset: number;
  dataEndOffset?: number;
  lengthRef?: PdfObjectRef;
} | undefined {
  const dataStartOffset = cursor.skipStreamLineBreak(streamKeywordIndex + "stream".length);
  const declaredLength = readIntegerValue(dictionaryEntries.get("Length"));
  if (declaredLength !== undefined && dataStartOffset + declaredLength <= cursor.endOffset) {
    return {
      dataStartOffset,
      dataEndOffset: dataStartOffset + declaredLength,
    };
  }

  const lengthRef = readObjectRefValue(dictionaryEntries.get("Length"));
  const endStreamIndex = cursor.findKeyword("endstream", dataStartOffset);
  if (endStreamIndex < 0) {
    return lengthRef ? { dataStartOffset, lengthRef } : undefined;
  }

  return {
    dataStartOffset,
    dataEndOffset: endStreamIndex,
    ...(lengthRef !== undefined ? { lengthRef } : {}),
  };
}

async function finalizeIndirectObjects(
  indirectObjects: readonly ParsedIndirectObject[],
  sourceBytes: Uint8Array,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
  securityHandler?: PdfStandardPasswordSecurityHandler,
): Promise<ParsedIndirectObject[]> {
  const finalized: ParsedIndirectObject[] = [];

  for (const objectShell of indirectObjects) {
    finalized.push(await finalizeIndirectObject(objectShell, sourceBytes, objectIndex, securityHandler));
  }

  return finalized;
}

async function finalizeIndirectObject(
  objectShell: ParsedIndirectObject,
  sourceBytes: Uint8Array,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
  securityHandler?: PdfStandardPasswordSecurityHandler,
): Promise<ParsedIndirectObject> {
  let finalizedObject = objectShell;
  if (
    securityHandler &&
    objectShell.containerObjectRef === undefined &&
    !objectShell.hasStream &&
    objectShell.objectValueText !== undefined
  ) {
    const decryptedObjectValueText = await securityHandler.decryptObjectValueText(
      objectShell.ref,
      objectShell.objectValueText,
      ...(objectShell.typeName !== undefined ? [{ typeName: objectShell.typeName }] : []),
    );
    if (decryptedObjectValueText !== objectShell.objectValueText) {
      const decryptedDictionaryText = findFirstDictionaryToken(decryptedObjectValueText);
      const decryptedDictionaryEntries = decryptedDictionaryText
        ? parseDictionaryEntries(decryptedDictionaryText)
        : objectShell.dictionaryEntries;
      const decryptedTypeName = readNameValue(decryptedDictionaryEntries.get("Type")) ?? objectShell.typeName;

      finalizedObject = {
        ...finalizedObject,
        objectValueText: decryptedObjectValueText,
        dictionaryEntries: decryptedDictionaryEntries,
        dictionaryKeys: Array.from(decryptedDictionaryEntries.keys()),
        ...(decryptedTypeName !== undefined ? { typeName: decryptedTypeName } : {}),
      };
    }
  }

  if (!finalizedObject.hasStream || finalizedObject.streamStartOffset === undefined) {
    return finalizedObject;
  }

  const rawStreamBytes = readStreamBytes(finalizedObject, sourceBytes, objectIndex);
  const decryptedStreamBytes = securityHandler && rawStreamBytes !== undefined
    ? await securityHandler.decryptStreamBytes(
      finalizedObject.ref,
      rawStreamBytes,
      ...(finalizedObject.typeName !== undefined ? [{ typeName: finalizedObject.typeName }] : []),
    )
    : rawStreamBytes;
  const decodedStream = await decodePdfStreamBytes(
    decryptedStreamBytes,
    finalizedObject.dictionaryEntries.get("Filter"),
    finalizedObject.dictionaryEntries.get("DecodeParms") ?? finalizedObject.dictionaryEntries.get("DP"),
  );

  const finalizedBase = {
    ...finalizedObject,
    ...(decryptedStreamBytes !== undefined ? { streamByteLength: decryptedStreamBytes.byteLength } : {}),
    ...(decodedStream.filterNames.length > 0 ? { streamFilterNames: decodedStream.filterNames } : {}),
  } satisfies ParsedIndirectObject;

  if (decodedStream.decodedBytes !== undefined) {
    const streamText = decodePdfBytes(decodedStream.decodedBytes);
    return {
      ...finalizedBase,
      streamDecodeState: decodedStream.state,
      decodedStreamByteLength: decodedStream.decodedBytes.byteLength,
      decodedStreamBytes: decodedStream.decodedBytes,
      streamText,
    };
  }

  return {
    ...finalizedBase,
    streamDecodeState: decodedStream.state,
  };
}

function expandObjectStreams(indirectObjects: readonly ParsedIndirectObject[]): {
  indirectObjects: readonly ParsedIndirectObject[];
  expanded: boolean;
} {
  const expandedMembers: ParsedIndirectObject[] = [];

  for (const objectStream of indirectObjects) {
    if (objectStream.typeName !== "ObjStm" || typeof objectStream.streamText !== "string") {
      continue;
    }

    expandedMembers.push(...expandObjectStreamMembers(objectStream));
  }

  if (expandedMembers.length === 0) {
    return {
      indirectObjects,
      expanded: false,
    };
  }

  return {
    indirectObjects: [...indirectObjects, ...expandedMembers],
    expanded: true,
  };
}

function expandObjectStreamMembers(objectStream: ParsedIndirectObject): ParsedIndirectObject[] {
  const firstOffset = readIntegerValue(objectStream.dictionaryEntries.get("First"));
  const objectCount = readIntegerValue(objectStream.dictionaryEntries.get("N"));
  if (firstOffset === undefined || objectCount === undefined || typeof objectStream.streamText !== "string") {
    return [];
  }

  const headerText = objectStream.streamText.slice(0, firstOffset);
  const bodyText = objectStream.streamText.slice(firstOffset);
  const headerNumbers = headerText.match(/\d+/g)?.map((value) => Number(value)) ?? [];
  if (headerNumbers.length < objectCount * 2) {
    return [];
  }

  const members: ParsedIndirectObject[] = [];
  for (let memberIndex = 0; memberIndex < objectCount; memberIndex += 1) {
    const objectNumber = headerNumbers[memberIndex * 2];
    const objectOffset = headerNumbers[memberIndex * 2 + 1];
    const nextOffset = memberIndex + 1 < objectCount ? headerNumbers[(memberIndex + 1) * 2 + 1] : bodyText.length;
    if (
      objectNumber === undefined ||
      objectOffset === undefined ||
      nextOffset === undefined ||
      objectOffset < 0 ||
      nextOffset < objectOffset
    ) {
      continue;
    }

    const memberValueText = bodyText.slice(objectOffset, nextOffset).trim();
    if (memberValueText.length === 0) {
      continue;
    }

    const dictionaryText = findFirstDictionaryToken(memberValueText);
    const dictionaryEntries = dictionaryText ? parseDictionaryEntries(dictionaryText) : new Map<string, string>();
    const typeName = readNameValue(dictionaryEntries.get("Type"));
    const dictionaryKeys = Array.from(dictionaryEntries.keys());

    members.push({
      ref: {
        objectNumber,
        generationNumber: 0,
      },
      offset: objectStream.offset,
      endOffset: objectStream.endOffset,
      hasStream: false,
      ...(typeName !== undefined ? { typeName } : {}),
      dictionaryKeys,
      objectValueText: memberValueText,
      dictionaryEntries,
      containerObjectRef: objectStream.ref,
    });
  }

  return members;
}

function readStreamBytes(
  objectShell: ParsedIndirectObject,
  sourceBytes: Uint8Array,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): Uint8Array | undefined {
  const dataStartOffset = objectShell.streamStartOffset;
  if (dataStartOffset === undefined) {
    return undefined;
  }

  const dataEndOffset = resolveStreamEndOffset(objectShell, objectIndex);
  if (dataEndOffset === undefined || dataEndOffset < dataStartOffset || dataEndOffset > sourceBytes.byteLength) {
    return undefined;
  }

  return sourceBytes.slice(dataStartOffset, dataEndOffset);
}

function resolveStreamEndOffset(
  objectShell: ParsedIndirectObject,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): number | undefined {
  if (objectShell.streamLengthRef !== undefined) {
    const lengthObject = objectIndex.get(keyOfObjectRef(objectShell.streamLengthRef));
    const integerValue = readIntegerValueFromObject(lengthObject);
    if (integerValue !== undefined) {
      return objectShell.streamStartOffset !== undefined ? objectShell.streamStartOffset + integerValue : undefined;
    }
  }

  return objectShell.streamEndOffset;
}

function readIntegerValueFromObject(objectShell: ParsedIndirectObject | undefined): number | undefined {
  if (!objectShell) {
    return undefined;
  }

  return readIntegerValue(objectShell.objectValueText);
}

function collectCrossReferenceSections(
  text: string,
  indirectObjects: readonly ParsedIndirectObject[],
  offsetBase = 0,
  includeStreamSections = true,
): ParsedCrossReferenceSection[] {
  const sections: ParsedCrossReferenceSection[] = [];

  for (let searchStart = 0; searchStart < text.length; searchStart += 1) {
    const keywordIndex = findPdfKeyword(text, "xref", searchStart);
    if (keywordIndex < 0) {
      break;
    }

    const section = readClassicCrossReferenceSection(text, keywordIndex, offsetBase);
    sections.push(section);
    searchStart = keywordIndex;
  }

  if (!includeStreamSections) {
    return sections.sort((leftSection, rightSection) => leftSection.offset - rightSection.offset);
  }

  for (const objectShell of indirectObjects) {
    if (objectShell.typeName !== "XRef") {
      continue;
    }

    const decodedEntryCount = decodeXrefStreamEntryCount(objectShell);
    sections.push({
      kind: "xref-stream",
      offset: objectShell.offset,
      ...(readIntegerValue(objectShell.dictionaryEntries.get("Size")) !== undefined
        ? { entryCount: readIntegerValue(objectShell.dictionaryEntries.get("Size")) as number }
        : {}),
      ...(decodedEntryCount !== undefined ? { decodedEntryCount } : {}),
      objectRef: objectShell.ref,
      ...(toTrailerShell(objectShell.dictionaryEntries) !== undefined
        ? { trailer: toTrailerShell(objectShell.dictionaryEntries) as PdfTrailerShell }
        : {}),
      trailerEntries: objectShell.dictionaryEntries,
    });
  }

  return sections.sort((leftSection, rightSection) => leftSection.offset - rightSection.offset);
}

function dedupeCrossReferenceSections(
  sections: readonly ParsedCrossReferenceSection[],
): ParsedCrossReferenceSection[] {
  const dedupedSections: ParsedCrossReferenceSection[] = [];
  const seenSectionKeys = new Set<string>();

  for (const section of sections) {
    const sectionKey = `${section.kind}:${section.offset}:${section.objectRef ? keyOfObjectRef(section.objectRef) : "none"}`;
    if (seenSectionKeys.has(sectionKey)) {
      continue;
    }
    seenSectionKeys.add(sectionKey);
    dedupedSections.push(section);
  }

  return dedupedSections.sort((leftSection, rightSection) => leftSection.offset - rightSection.offset);
}

function resolveCrossReferenceSections(
  sections: readonly ParsedCrossReferenceSection[],
  startXrefOffset: number | undefined,
): ParsedCrossReferenceSection[] {
  const sortedSections = [...sections].sort((leftSection, rightSection) => leftSection.offset - rightSection.offset);
  if (startXrefOffset === undefined) {
    return sortedSections;
  }

  const sectionByOffset = new Map(sortedSections.map((section) => [section.offset, section] as const));
  const chain: ParsedCrossReferenceSection[] = [];
  const seenOffsets = new Set<number>();
  let currentSection = sectionByOffset.get(startXrefOffset);

  while (currentSection && !seenOffsets.has(currentSection.offset)) {
    chain.push(currentSection);
    seenOffsets.add(currentSection.offset);
    const prevOffset = currentSection.trailer?.prevOffset;
    currentSection = prevOffset === undefined ? undefined : sectionByOffset.get(prevOffset);
  }

  if (chain.length === 0) {
    return sortedSections;
  }

  return [
    ...chain,
    ...sortedSections.filter((section) => !seenOffsets.has(section.offset)),
  ];
}

function resolveCrossReferenceTrailer(
  sections: readonly ParsedCrossReferenceSection[],
): PdfTrailerShell | undefined {
  for (const section of sections) {
    if (section.trailer !== undefined) {
      return section.trailer;
    }
  }

  return undefined;
}

function resolveCrossReferenceDocumentId(
  sections: readonly ParsedCrossReferenceSection[],
): Uint8Array | undefined {
  for (const section of sections) {
    const documentId = readTrailerDocumentIdBytes(section.trailerEntries);
    if (documentId !== undefined) {
      return documentId;
    }
  }

  return undefined;
}

function classifyIndirectObjectStreamRoles(
  indirectObjects: readonly ParsedIndirectObject[],
  pageEntries: readonly ParsedPageEntry[],
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): ParsedIndirectObject[] {
  const streamRoleByObjectKey = new Map<string, PdfStreamRole>();

  for (const pageEntry of pageEntries) {
    for (const contentStreamRef of pageEntry.contentStreamRefs) {
      setStreamRole(streamRoleByObjectKey, contentStreamRef, "content");
    }
  }

  for (const objectShell of indirectObjects) {
    if (objectShell.typeName === "XRef") {
      setStreamRole(streamRoleByObjectKey, objectShell.ref, "xref");
      continue;
    }

    if (objectShell.typeName === "ObjStm") {
      setStreamRole(streamRoleByObjectKey, objectShell.ref, "object-stream");
    }

    if (objectShell.typeName === "CMap" || objectShell.dictionaryEntries.has("UseCMap")) {
      setStreamRole(streamRoleByObjectKey, objectShell.ref, "cmap");
    }

    const toUnicodeRef = readObjectRefValue(objectShell.dictionaryEntries.get("ToUnicode"));
    if (toUnicodeRef !== undefined) {
      setStreamRole(streamRoleByObjectKey, toUnicodeRef, "tounicode");
    }

    if (isFontLikeObject(objectShell)) {
      const encodingRef = readObjectRefValue(objectShell.dictionaryEntries.get("Encoding"));
      if (encodingRef !== undefined) {
        const encodingObject = objectIndex.get(keyOfObjectRef(encodingRef));
        if (encodingObject?.hasStream) {
          setStreamRole(streamRoleByObjectKey, encodingRef, "cmap");
        }
      }
    }
  }

  return indirectObjects.map((objectShell) => {
    if (!objectShell.hasStream) {
      return objectShell;
    }

    return {
      ...objectShell,
      streamRole: streamRoleByObjectKey.get(keyOfObjectRef(objectShell.ref)) ?? "unknown",
    };
  });
}

function isFontLikeObject(objectShell: ParsedIndirectObject): boolean {
  return objectShell.typeName === "Font" || objectShell.dictionaryEntries.has("BaseFont") || objectShell.dictionaryEntries.has("DescendantFonts");
}

function setStreamRole(
  streamRoleByObjectKey: Map<string, PdfStreamRole>,
  objectRef: PdfObjectRef,
  nextRole: PdfStreamRole,
): void {
  const objectKey = keyOfObjectRef(objectRef);
  const currentRole = streamRoleByObjectKey.get(objectKey);
  if (currentRole === undefined || streamRolePriority(nextRole) > streamRolePriority(currentRole)) {
    streamRoleByObjectKey.set(objectKey, nextRole);
  }
}

function streamRolePriority(streamRole: PdfStreamRole): number {
  switch (streamRole) {
    case "xref":
      return 5;
    case "object-stream":
      return 4;
    case "tounicode":
      return 3;
    case "cmap":
      return 2;
    case "content":
      return 1;
    case "unknown":
      return 0;
  }
}

function decodeXrefStreamEntryCount(objectShell: ParsedIndirectObject): number | undefined {
  const fieldWidths = readIntegerArrayValue(objectShell.dictionaryEntries.get("W"));
  if (fieldWidths.length !== 3 || objectShell.decodedStreamBytes === undefined) {
    return undefined;
  }

  const [typeWidth, fieldOneWidth, fieldTwoWidth] = fieldWidths;
  if (typeWidth === undefined || fieldOneWidth === undefined || fieldTwoWidth === undefined) {
    return undefined;
  }

  const entryWidth = typeWidth + fieldOneWidth + fieldTwoWidth;
  if (entryWidth <= 0 || objectShell.decodedStreamBytes.byteLength % entryWidth !== 0) {
    return undefined;
  }

  const indexValues = readIntegerArrayValue(objectShell.dictionaryEntries.get("Index"));
  if (indexValues.length > 0 && indexValues.length % 2 === 0) {
    let declaredEntries = 0;
    for (let index = 1; index < indexValues.length; index += 2) {
      declaredEntries += indexValues[index] ?? 0;
    }
    if (declaredEntries > 0) {
      return declaredEntries;
    }
  }

  return objectShell.decodedStreamBytes.byteLength / entryWidth;
}

function readIntegerArrayValue(value: string | undefined): number[] {
  if (!value || !value.startsWith("[") || !value.endsWith("]")) {
    return [];
  }

  return [...value.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

function readClassicCrossReferenceSection(
  text: string,
  keywordIndex: number,
  offsetBase = 0,
): ParsedCrossReferenceSection {
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

  const trailerKeywordIndex = skipPdfWhitespaceAndComments(text, offset);
  const trailer = matchesPdfKeyword(text, trailerKeywordIndex, "trailer")
    ? (() => {
      const dictionaryStart = skipPdfWhitespaceAndComments(text, trailerKeywordIndex + "trailer".length);
      const dictionaryText = readPdfDictionaryToken(text, dictionaryStart);
      return dictionaryText ? toTrailerShell(parseDictionaryEntries(dictionaryText.token)) : undefined;
    })()
    : undefined;

  const trailerEntries = (() => {
    const trailerIndex = findPdfKeyword(text, "trailer", offset);
    if (trailerIndex < 0) {
      return undefined;
    }

    const dictionaryStart = skipPdfWhitespaceAndComments(text, trailerIndex + "trailer".length);
    const dictionaryText = readPdfDictionaryToken(text, dictionaryStart);
    return dictionaryText ? parseDictionaryEntries(dictionaryText.token) : undefined;
  })();

  return {
    kind: "classic",
    offset: offsetBase + keywordIndex,
    ...(entryCount > 0 ? { entryCount } : {}),
    ...(trailer !== undefined ? { trailer } : {}),
    ...(trailerEntries !== undefined ? { trailerEntries } : {}),
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

function parseTrailerDocumentId(
  text: string,
  indirectObjects: readonly ParsedIndirectObject[],
): Uint8Array | undefined {
  const trailerIndex = findLastPdfKeyword(text, "trailer");
  if (trailerIndex >= 0) {
    const dictionaryStart = skipPdfWhitespaceAndComments(text, trailerIndex + "trailer".length);
    const dictionaryText = readPdfDictionaryToken(text, dictionaryStart);
    if (dictionaryText) {
      return readTrailerDocumentIdBytes(parseDictionaryEntries(dictionaryText.token));
    }
  }

  const xrefStreamObject = [...indirectObjects].reverse().find((objectShell) => objectShell.typeName === "XRef");
  return readTrailerDocumentIdBytes(xrefStreamObject?.dictionaryEntries);
}

function readTrailerDocumentIdBytes(
  dictionaryEntries: ReadonlyMap<string, string> | undefined,
): Uint8Array | undefined {
  const idValue = dictionaryEntries?.get("ID");
  if (!idValue || !idValue.trim().startsWith("[")) {
    return undefined;
  }

  const stringToken = readFirstPdfStringToken(idValue);
  return stringToken ? decodePdfTokenBytes(stringToken) : undefined;
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
): { pages: ParsedPageEntry[]; resolved: boolean; inheritedStateResolved: boolean } {
  const rootRef = trailer?.rootRef ?? findCatalogRootRef(indirectObjects);
  if (rootRef) {
    const treePages = traversePageTree(rootRef, objectIndex);
    if (treePages.length > 0) {
      return { pages: treePages, resolved: true, inheritedStateResolved: true };
    }
  }

  const fallbackPages = indirectObjects
    .filter((objectShell) => objectShell.typeName === "Page")
    .sort((leftObject, rightObject) => leftObject.offset - rightObject.offset)
    .map((objectShell, pageIndex) => toPageEntry(objectShell, pageIndex + 1, {}, objectIndex));

  return { pages: fallbackPages, resolved: false, inheritedStateResolved: false };
}

function findCatalogRootRef(
  indirectObjects: readonly ParsedIndirectObject[],
): PdfObjectRef | undefined {
  const catalogObject = [...indirectObjects].reverse().find((objectShell) => objectShell.typeName === "Catalog");
  return catalogObject?.ref;
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
  appendPageTreeEntries(pagesRootRef, objectIndex, visited, orderedPages, {});

  return orderedPages;
}

interface InheritedPageValue {
  readonly rawValue: string;
  readonly ref?: PdfObjectRef;
}

interface InheritedPageState {
  readonly resources?: InheritedPageValue;
  readonly mediaBox?: InheritedPageValue;
  readonly cropBox?: InheritedPageValue;
  readonly rotate?: InheritedPageValue;
}

function appendPageTreeEntries(
  currentRef: PdfObjectRef,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
  visited: Set<string>,
  orderedPages: ParsedPageEntry[],
  inheritedState: InheritedPageState,
): void {
  const currentKey = keyOfObjectRef(currentRef);
  if (visited.has(currentKey)) {
    return;
  }
  visited.add(currentKey);

  const currentObject = objectIndex.get(currentKey);
  if (!currentObject) {
    return;
  }

  const nextInheritedState = mergeInheritedPageState(inheritedState, currentObject);
  if (currentObject.typeName === "Page") {
    orderedPages.push(toPageEntry(currentObject, orderedPages.length + 1, nextInheritedState, objectIndex));
    return;
  }

  if (currentObject.typeName !== "Pages") {
    return;
  }

  const kids = readObjectRefsValue(currentObject.dictionaryEntries.get("Kids"));
  for (const kidRef of kids) {
    appendPageTreeEntries(kidRef, objectIndex, visited, orderedPages, nextInheritedState);
  }
}

function mergeInheritedPageState(
  inheritedState: InheritedPageState,
  objectShell: ParsedIndirectObject,
): InheritedPageState {
  const resources = readInheritedPageValue(objectShell, "Resources") ?? inheritedState.resources;
  const mediaBox = readInheritedPageValue(objectShell, "MediaBox") ?? inheritedState.mediaBox;
  const cropBox = readInheritedPageValue(objectShell, "CropBox") ?? inheritedState.cropBox;
  const rotate = readInheritedPageValue(objectShell, "Rotate") ?? inheritedState.rotate;

  return {
    ...(resources !== undefined ? { resources } : {}),
    ...(mediaBox !== undefined ? { mediaBox } : {}),
    ...(cropBox !== undefined ? { cropBox } : {}),
    ...(rotate !== undefined ? { rotate } : {}),
  };
}

function readInheritedPageValue(
  objectShell: ParsedIndirectObject,
  key: "Resources" | "MediaBox" | "CropBox" | "Rotate",
): InheritedPageValue | undefined {
  const rawValue = objectShell.dictionaryEntries.get(key);
  if (!rawValue) {
    return undefined;
  }

  const ref = readObjectRefValue(rawValue);
  return {
    rawValue,
    ...(ref !== undefined ? { ref } : {}),
  };
}

function toPageEntry(
  objectShell: ParsedIndirectObject,
  pageNumber: number,
  inheritedState: InheritedPageState = {},
  objectIndex?: ReadonlyMap<string, ParsedIndirectObject>,
): ParsedPageEntry {
  const contentStreamRefs = readObjectRefsValue(objectShell.dictionaryEntries.get("Contents"));
  const annotationRefs = readObjectRefsValue(objectShell.dictionaryEntries.get("Annots"));
  const directResourceValue = readInheritedPageValue(objectShell, "Resources");
  const resourceValue = directResourceValue ?? inheritedState.resources;
  const resourceOrigin: PdfPageValueOrigin | undefined = directResourceValue
    ? "direct"
    : resourceValue
      ? "inherited"
      : undefined;
  const fontBindings = resourceValue ? readFontResourceBindings(resourceValue.rawValue, objectIndex) : [];

  return {
    pageNumber,
    pageRef: objectShell.ref,
    contentStreamRefs,
    annotationRefs,
    fontBindings,
    ...(resourceValue?.ref !== undefined ? { resourceRef: resourceValue.ref } : {}),
    ...(resourceOrigin !== undefined ? { resourceOrigin } : {}),
    resourceCount: resourceValue ? 1 : 0,
  };
}

function readFontResourceBindings(
  resourceValue: string,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject> | undefined,
): ParsedFontResourceBinding[] {
  const resolvedResourceDictionary = resolveDictionaryValue(resourceValue, objectIndex);
  if (!resolvedResourceDictionary) {
    return [];
  }

  const resourceEntries = parseDictionaryEntries(resolvedResourceDictionary);
  const fontValue = resourceEntries.get("Font");
  if (!fontValue) {
    return [];
  }

  const resolvedFontDictionary = resolveDictionaryValue(fontValue, objectIndex);
  if (!resolvedFontDictionary) {
    return [];
  }

  const fontEntries = parseDictionaryEntries(resolvedFontDictionary);
  const fontBindings: ParsedFontResourceBinding[] = [];

  for (const [resourceName, fontValueToken] of fontEntries.entries()) {
    const fontRef = readObjectRefValue(fontValueToken);
    if (fontRef !== undefined) {
      fontBindings.push({
        resourceName,
        fontRef,
      });
    }
  }

  return fontBindings;
}

function resolveDictionaryValue(
  rawValue: string,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject> | undefined,
): string | undefined {
  if (rawValue.startsWith("<<") && rawValue.endsWith(">>")) {
    return rawValue;
  }

  const objectRef = readObjectRefValue(rawValue);
  if (objectRef === undefined || objectIndex === undefined) {
    return undefined;
  }

  return findFirstDictionaryToken(objectIndex.get(keyOfObjectRef(objectRef))?.objectValueText ?? "");
}

function countPageObjects(indirectObjects: readonly ParsedIndirectObject[]): number | undefined {
  const count = indirectObjects.filter((objectShell) => objectShell.typeName === "Page").length;
  return count === 0 ? undefined : count;
}

function detectRepairState(input: {
  readonly fileType: "pdf" | "unknown";
  readonly parseCoverage: PdfParseCoverage;
  readonly isTruncated: boolean;
  readonly usedFullStructureScan: boolean;
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

  if (cleanStructure && (!input.isTruncated || input.usedFullStructureScan)) {
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

function readFirstPdfStringToken(text: string): string | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const literalToken = readPdfLiteralToken(text, index);
    if (literalToken) {
      return literalToken.token;
    }

    const hexToken = readPdfHexStringToken(text, index);
    if (hexToken) {
      return hexToken.token;
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

  const normalizedValue = value.trim();
  const integerToken = readUnsignedInteger(normalizedValue, 0);
  if (!integerToken) {
    return undefined;
  }

  const trailingIndex = skipPdfWhitespaceAndComments(normalizedValue, integerToken.nextIndex);
  if (trailingIndex !== normalizedValue.length) {
    return undefined;
  }

  return integerToken?.value;
}

function readNameValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const nameToken = readPdfNameToken(value.trim(), 0);
  return nameToken?.name;
}

function readNumericTokenValue(token: string): number | undefined {
  const value = Number(token);
  return Number.isFinite(value) ? value : undefined;
}

function readTrailingNumericOperands(
  operands: ReadonlyArray<
    | { readonly kind: "name"; readonly token: string }
    | { readonly kind: "literal"; readonly token: string }
    | { readonly kind: "hex"; readonly token: string }
    | { readonly kind: "dictionary"; readonly token: string }
    | { readonly kind: "array"; readonly items: ReadonlyArray<ParsedTextArrayOperand> }
    | { readonly kind: "other"; readonly token: string }
  >,
  count: number,
): readonly number[] | undefined {
  const numericValues: number[] = [];

  for (let index = operands.length - 1; index >= 0 && numericValues.length < count; index -= 1) {
    const operand = operands[index];
    if (operand?.kind !== "other") {
      continue;
    }
    const value = readNumericTokenValue(operand.token);
    if (value === undefined) {
      continue;
    }
    numericValues.push(value);
  }

  if (numericValues.length !== count) {
    return undefined;
  }

  return numericValues.reverse();
}

function offsetPoint(anchor: PdfPoint | undefined, dx: number, dy: number): PdfPoint {
  return {
    x: (anchor?.x ?? 0) + dx,
    y: (anchor?.y ?? 0) + dy,
  };
}

function advanceToNextLine(anchor: PdfPoint | undefined, leading: number | undefined): PdfPoint | undefined {
  if (!anchor || leading === undefined || leading === 0) {
    return anchor;
  }

  return {
    x: anchor.x,
    y: anchor.y - leading,
  };
}

export function parseTextOperatorRuns(text: string): readonly ParsedTextOperatorRun[] {
  const runs: ParsedTextOperatorRun[] = [];
  let currentFontResourceName: string | undefined;
  let currentFontSize: number | undefined;
  let currentTextAnchor: PdfPoint | undefined;
  let currentLeading: number | undefined;
  let pendingLineBreak = false;
  const markedContentStack: ParsedMarkedContentContext[] = [];
  const operands: Array<
    | { kind: "name"; token: string }
    | { kind: "literal"; token: string }
    | { kind: "hex"; token: string }
    | { kind: "dictionary"; token: string }
    | { kind: "array"; items: ReadonlyArray<ParsedTextArrayOperand> }
    | { kind: "other"; token: string }
  > = [];

  for (let index = 0; index < text.length; ) {
    index = skipPdfWhitespaceAndComments(text, index);
    const current = text[index];

    if (current === undefined) {
      break;
    }

    if (current === "(") {
      const literal = readPdfLiteralToken(text, index);
      if (!literal) {
        index += 1;
        continue;
      }

      operands.push({ kind: "literal", token: literal.token });
      index = literal.nextIndex;
      continue;
    }

    if (current === "/") {
      const nameToken = readPdfNameToken(text, index);
      if (!nameToken) {
        index += 1;
        continue;
      }

      operands.push({ kind: "name", token: nameToken.raw });
      index = nameToken.nextIndex;
      continue;
    }

    if (current === "<" && text[index + 1] !== "<") {
      const hex = readPdfHexStringToken(text, index);
      if (!hex) {
        index += 1;
        continue;
      }

      operands.push({ kind: "hex", token: hex.token });
      index = hex.nextIndex;
      continue;
    }

    if (current === "<" && text[index + 1] === "<") {
      const dictionary = readPdfDictionaryToken(text, index);
      if (!dictionary) {
        index += 1;
        continue;
      }

      operands.push({ kind: "dictionary", token: dictionary.token });
      index = dictionary.nextIndex;
      continue;
    }

    if (current === "[") {
      const array = readPdfTextArrayToken(text, index);
      if (!array) {
        index += 1;
        continue;
      }

      operands.push({ kind: "array", items: array.items });
      index = array.nextIndex;
      continue;
    }

    const tokenEnd = readUntilDelimiter(text, index);
    if (tokenEnd <= index) {
      index += 1;
      continue;
    }

    const token = text.slice(index, tokenEnd);
    if (token === "BT") {
      operands.length = 0;
      pendingLineBreak = false;
      currentTextAnchor = undefined;
      markedContentStack.length = 0;
      index = tokenEnd;
      continue;
    }

    if (token === "ET") {
      operands.length = 0;
      index = tokenEnd;
      continue;
    }

    if (token === "Tf") {
      const fontOperand = [...operands].reverse().find((operand) => operand.kind === "name");
      currentFontResourceName = fontOperand?.kind === "name" ? fontOperand.token.slice(1) : currentFontResourceName;
      const fontSizeOperand = [...operands]
        .reverse()
        .find((operand) => operand.kind === "other" && readNumericTokenValue(operand.token) !== undefined);
      currentFontSize = fontSizeOperand?.kind === "other"
        ? readNumericTokenValue(fontSizeOperand.token) ?? currentFontSize
        : currentFontSize;
      operands.length = 0;
      index = tokenEnd;
      continue;
    }

    if (token === "Tm") {
      const matrixOperands = readTrailingNumericOperands(operands, 6);
      if (matrixOperands) {
        currentTextAnchor = {
          x: matrixOperands[4] ?? 0,
          y: matrixOperands[5] ?? 0,
        };
        pendingLineBreak = true;
      }
      operands.length = 0;
      index = tokenEnd;
      continue;
    }

    if (token === "Td") {
      const positionOperands = readTrailingNumericOperands(operands, 2);
      if (positionOperands) {
        currentTextAnchor = offsetPoint(currentTextAnchor, positionOperands[0] ?? 0, positionOperands[1] ?? 0);
        pendingLineBreak = true;
      }
      operands.length = 0;
      index = tokenEnd;
      continue;
    }

    if (token === "TD") {
      const positionOperands = readTrailingNumericOperands(operands, 2);
      if (positionOperands) {
        currentTextAnchor = offsetPoint(currentTextAnchor, positionOperands[0] ?? 0, positionOperands[1] ?? 0);
        currentLeading = -(positionOperands[1] ?? 0);
        pendingLineBreak = true;
      }
      operands.length = 0;
      index = tokenEnd;
      continue;
    }

    if (token === "T*") {
      currentTextAnchor = advanceToNextLine(currentTextAnchor, currentLeading);
      pendingLineBreak = true;
      operands.length = 0;
      index = tokenEnd;
      continue;
    }

    if (token === "Tj") {
      const literal = [...operands].reverse().find(
        (operand) => operand.kind === "literal" || operand.kind === "hex",
      );
      const markedContent = markedContentStack.at(-1);
      if (literal?.kind === "literal") {
        runs.push({
          operator: "Tj",
          ...(currentFontResourceName !== undefined ? { fontResourceName: currentFontResourceName } : {}),
          ...(currentFontSize !== undefined ? { fontSize: currentFontSize } : {}),
          ...(currentTextAnchor !== undefined ? { anchor: currentTextAnchor } : {}),
          startsNewLine: pendingLineBreak,
          operands: [literal],
          ...(markedContent?.kind !== undefined ? { markedContentKind: markedContent.kind } : {}),
          ...(markedContent?.actualText !== undefined ? { actualText: markedContent.actualText } : {}),
        });
      } else if (literal?.kind === "hex") {
        runs.push({
          operator: "Tj",
          ...(currentFontResourceName !== undefined ? { fontResourceName: currentFontResourceName } : {}),
          ...(currentFontSize !== undefined ? { fontSize: currentFontSize } : {}),
          ...(currentTextAnchor !== undefined ? { anchor: currentTextAnchor } : {}),
          startsNewLine: pendingLineBreak,
          operands: [literal],
          ...(markedContent?.kind !== undefined ? { markedContentKind: markedContent.kind } : {}),
          ...(markedContent?.actualText !== undefined ? { actualText: markedContent.actualText } : {}),
        });
      }
      operands.length = 0;
      pendingLineBreak = false;
      index = tokenEnd;
      continue;
    }

    if (token === "TJ") {
      const array = operands.at(-1);
      const markedContent = markedContentStack.at(-1);
      if (array?.kind === "array") {
        runs.push({
          operator: "TJ",
          ...(currentFontResourceName !== undefined ? { fontResourceName: currentFontResourceName } : {}),
          ...(currentFontSize !== undefined ? { fontSize: currentFontSize } : {}),
          ...(currentTextAnchor !== undefined ? { anchor: currentTextAnchor } : {}),
          startsNewLine: pendingLineBreak,
          operands: array.items,
          ...(markedContent?.kind !== undefined ? { markedContentKind: markedContent.kind } : {}),
          ...(markedContent?.actualText !== undefined ? { actualText: markedContent.actualText } : {}),
        });
      }
      operands.length = 0;
      pendingLineBreak = false;
      index = tokenEnd;
      continue;
    }

    if (token === "'") {
      const lineAnchor = advanceToNextLine(currentTextAnchor, currentLeading);
      const literal = [...operands].reverse().find(
        (operand) => operand.kind === "literal" || operand.kind === "hex",
      );
      const markedContent = markedContentStack.at(-1);
      if (literal?.kind === "literal") {
        runs.push({
          operator: "'",
          ...(currentFontResourceName !== undefined ? { fontResourceName: currentFontResourceName } : {}),
          ...(currentFontSize !== undefined ? { fontSize: currentFontSize } : {}),
          ...(lineAnchor !== undefined ? { anchor: lineAnchor } : {}),
          startsNewLine: true,
          operands: [literal],
          ...(markedContent?.kind !== undefined ? { markedContentKind: markedContent.kind } : {}),
          ...(markedContent?.actualText !== undefined ? { actualText: markedContent.actualText } : {}),
        });
      } else if (literal?.kind === "hex") {
        runs.push({
          operator: "'",
          ...(currentFontResourceName !== undefined ? { fontResourceName: currentFontResourceName } : {}),
          ...(currentFontSize !== undefined ? { fontSize: currentFontSize } : {}),
          ...(lineAnchor !== undefined ? { anchor: lineAnchor } : {}),
          startsNewLine: true,
          operands: [literal],
          ...(markedContent?.kind !== undefined ? { markedContentKind: markedContent.kind } : {}),
          ...(markedContent?.actualText !== undefined ? { actualText: markedContent.actualText } : {}),
        });
      }
      currentTextAnchor = lineAnchor;
      operands.length = 0;
      pendingLineBreak = false;
      index = tokenEnd;
      continue;
    }

    if (token === "\"") {
      const lineAnchor = advanceToNextLine(currentTextAnchor, currentLeading);
      const literal = [...operands].reverse().find(
        (operand) => operand.kind === "literal" || operand.kind === "hex",
      );
      const markedContent = markedContentStack.at(-1);
      if (literal?.kind === "literal") {
        runs.push({
          operator: "\"",
          ...(currentFontResourceName !== undefined ? { fontResourceName: currentFontResourceName } : {}),
          ...(currentFontSize !== undefined ? { fontSize: currentFontSize } : {}),
          ...(lineAnchor !== undefined ? { anchor: lineAnchor } : {}),
          startsNewLine: true,
          operands: [literal],
          ...(markedContent?.kind !== undefined ? { markedContentKind: markedContent.kind } : {}),
          ...(markedContent?.actualText !== undefined ? { actualText: markedContent.actualText } : {}),
        });
      } else if (literal?.kind === "hex") {
        runs.push({
          operator: "\"",
          ...(currentFontResourceName !== undefined ? { fontResourceName: currentFontResourceName } : {}),
          ...(currentFontSize !== undefined ? { fontSize: currentFontSize } : {}),
          ...(lineAnchor !== undefined ? { anchor: lineAnchor } : {}),
          startsNewLine: true,
          operands: [literal],
          ...(markedContent?.kind !== undefined ? { markedContentKind: markedContent.kind } : {}),
          ...(markedContent?.actualText !== undefined ? { actualText: markedContent.actualText } : {}),
        });
      }
      currentTextAnchor = lineAnchor;
      operands.length = 0;
      pendingLineBreak = false;
      index = tokenEnd;
      continue;
    }

    if (token === "BDC") {
      markedContentStack.push(readMarkedContentContext(operands));
      operands.length = 0;
      index = tokenEnd;
      continue;
    }

    if (token === "BMC") {
      const tagOperand = [...operands].reverse().find((operand) => operand.kind === "name");
      markedContentStack.push(classifyMarkedContent(tagOperand?.kind === "name" ? tagOperand.token : undefined));
      operands.length = 0;
      index = tokenEnd;
      continue;
    }

    if (token === "EMC") {
      markedContentStack.pop();
      operands.length = 0;
      index = tokenEnd;
      continue;
    }

    operands.push({ kind: "other", token });
    index = tokenEnd;
  }

  return runs;
}

export function analyzeTextOperators(text: string): {
  readonly runs: readonly string[];
  readonly hasHexTextOperands: boolean;
} {
  const parsedRuns = parseTextOperatorRuns(text);
  const runs = parsedRuns
    .map((parsedRun) =>
      parsedRun.operands
        .map((operand) => {
          if (operand.kind === "literal") {
            return decodePdfLiteral(operand.token);
          }
          return "";
        })
        .join("")
        .trim()
    )
    .filter((value) => value.length > 0);

  return {
    runs,
    hasHexTextOperands: parsedRuns.some((parsedRun) => parsedRun.operands.some((operand) => operand.kind === "hex")),
  };
}

export function extractTextOperatorRuns(text: string): string[] {
  return [...analyzeTextOperators(text).runs];
}

function readMarkedContentContext(
  operands: ReadonlyArray<
    | { readonly kind: "name"; readonly token: string }
    | { readonly kind: "literal"; readonly token: string }
    | { readonly kind: "hex"; readonly token: string }
    | { readonly kind: "dictionary"; readonly token: string }
    | { readonly kind: "array"; readonly items: ReadonlyArray<ParsedTextArrayOperand> }
    | { readonly kind: "other"; readonly token: string }
  >,
): ParsedMarkedContentContext {
  const tagOperand = [...operands].reverse().find((operand) => operand.kind === "name");
  const dictionaryOperand = [...operands].reverse().find((operand) => operand.kind === "dictionary");
  const baseContext = classifyMarkedContent(tagOperand?.kind === "name" ? tagOperand.token : undefined);
  if (dictionaryOperand?.kind !== "dictionary") {
    return baseContext;
  }

  const actualText = extractMarkedContentActualText(dictionaryOperand.token);
  return actualText === undefined ? baseContext : { ...baseContext, actualText };
}

function classifyMarkedContent(tagToken: string | undefined): ParsedMarkedContentContext {
  if (tagToken === "/Artifact") {
    return { kind: "artifact" };
  }
  if (tagToken === "/Span") {
    return { kind: "span" };
  }
  return { kind: "other" };
}

function extractMarkedContentActualText(dictionaryToken: string): string | undefined {
  const actualTextToken = parseDictionaryEntries(dictionaryToken).get("ActualText");
  if (!actualTextToken) {
    return undefined;
  }

  if (actualTextToken.startsWith("(") && actualTextToken.endsWith(")")) {
    return decodePdfPossibleUnicodeBytes(stringToPdfBytes(decodePdfLiteral(actualTextToken)));
  }

  if (actualTextToken.startsWith("<") && actualTextToken.endsWith(">")) {
    return decodePdfPossibleUnicodeBytes(readPdfHexBytes(actualTextToken));
  }

  return undefined;
}

function stringToPdfBytes(value: string): Uint8Array {
  return Uint8Array.from(Array.from(value, (character) => character.charCodeAt(0) & 0xff));
}

function readPdfHexBytes(token: string): Uint8Array {
  const normalized = token
    .slice(1, -1)
    .replaceAll(/\s+/g, "");
  const padded = normalized.length % 2 === 0 ? normalized : `${normalized}0`;
  const bytes = new Uint8Array(padded.length / 2);

  for (let index = 0; index < padded.length; index += 2) {
    bytes[index / 2] = Number.parseInt(padded.slice(index, index + 2), 16);
  }

  return bytes;
}

function decodePdfPossibleUnicodeBytes(bytes: Uint8Array): string {
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodePdfUtf16Bytes(bytes.subarray(2), "be");
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodePdfUtf16Bytes(bytes.subarray(2), "le");
  }

  return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
}

function decodePdfUtf16Bytes(bytes: Uint8Array, endianness: "be" | "le"): string {
  let value = "";

  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    const firstByte = bytes[index] ?? 0;
    const secondByte = bytes[index + 1] ?? 0;
    const codePoint = endianness === "be"
      ? (firstByte << 8) | secondByte
      : firstByte | (secondByte << 8);
    value += String.fromCharCode(codePoint);
  }

  return value;
}

function readPdfTextArrayToken(
  text: string,
  startIndex: number,
): {
  readonly items: ReadonlyArray<ParsedTextArrayOperand>;
  readonly nextIndex: number;
} | undefined {
  if (text[startIndex] !== "[") {
    return undefined;
  }

  const items: ParsedTextArrayOperand[] = [];
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

      items.push({ kind: "literal", token: literal.token });
      index = literal.nextIndex - 1;
      continue;
    }

    if (current === "<" && text[index + 1] !== "<") {
      const hex = readPdfHexStringToken(text, index);
      if (!hex) {
        return undefined;
      }

      items.push({ kind: "hex", token: hex.token });
      index = hex.nextIndex - 1;
      continue;
    }

    if (/[+\-.\d]/.test(current)) {
      const tokenEnd = readUntilDelimiter(text, index);
      if (tokenEnd <= index) {
        return undefined;
      }

      const numericValue = readNumericTokenValue(text.slice(index, tokenEnd));
      if (numericValue !== undefined) {
        items.push({ kind: "adjustment", value: numericValue });
        index = tokenEnd - 1;
        continue;
      }
    }

    if (current === "[") {
      depth += 1;
      continue;
    }

    if (current === "]") {
      depth -= 1;
      if (depth === 0) {
        return {
          items,
          nextIndex: index + 1,
        };
      }
    }
  }

  return undefined;
}

export function decodePdfLiteral(token: string): string {
  const source = token.startsWith("(") && token.endsWith(")") ? token.slice(1, -1) : token;
  let result = "";

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];

    if (current !== "\\") {
      result += current;
      continue;
    }

    const next = source[index + 1];
    if (next === undefined) {
      break;
    }

    if (/[0-7]/.test(next)) {
      let octal = next;
      if (/[0-7]/.test(source[index + 2] ?? "")) {
        octal += source[index + 2];
      }
      if (/[0-7]/.test(source[index + 3] ?? "")) {
        octal += source[index + 3];
      }
      result += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    if (next === "n") {
      result += "\n";
      index += 1;
      continue;
    }

    if (next === "r") {
      result += "\r";
      index += 1;
      continue;
    }

    if (next === "t") {
      result += "\t";
      index += 1;
      continue;
    }

    if (next === "b") {
      result += "\b";
      index += 1;
      continue;
    }

    if (next === "f") {
      result += "\f";
      index += 1;
      continue;
    }

    result += next;
    index += 1;
  }

  return result;
}

function decodePdfTokenBytes(token: string): Uint8Array {
  if (token.startsWith("(")) {
    const decodedText = decodePdfLiteral(token);
    return Uint8Array.from(decodedText, (character) => character.charCodeAt(0) & 0xff);
  }

  const normalizedHex = token.slice(1, -1).replace(/\s+/g, "");
  const paddedHex = normalizedHex.length % 2 === 0 ? normalizedHex : `${normalizedHex}0`;
  const decodedBytes = new Uint8Array(paddedHex.length / 2);
  for (let index = 0; index < paddedHex.length; index += 2) {
    decodedBytes[index / 2] = Number.parseInt(paddedHex.slice(index, index + 2), 16);
  }
  return decodedBytes;
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
