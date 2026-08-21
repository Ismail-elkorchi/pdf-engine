import { PdfBudgetTracker } from "./pdf-budget.ts";
import {
  parsePdfContentStream,
  parsePdfContentStreams,
  type PdfContentOperator,
  type PdfContentStreamInput,
} from "./pdf-content.ts";
import {
  resolvePageContentReferences,
  type PdfDocumentModel,
  type PdfPageModel,
} from "./pdf-document-model.ts";
import { PdfSyntaxParser } from "./pdf-syntax.ts";
import { formatPdfValue } from "./pdf-value-format.ts";
import {
  type PdfDictionaryValue,
  type PdfIndirectObject,
  type PdfValue,
  pdfAsArray,
  pdfAsInteger,
  pdfAsName,
  pdfAsNumber,
  pdfAsReference,
  pdfDictionaryGet,
  pdfReferenceKey,
} from "./pdf-values.ts";

import type {
  PdfBoundingBox,
  PdfCrossReferenceKind,
  PdfCrossReferenceSection,
  PdfIndirectObjectShell,
  PdfObjectRef,
  PdfPageValueOrigin,
  PdfParseCoverage,
  PdfPoint,
  PdfRepairState,
  PdfTrailerShell,
  PdfTransformMatrix,
} from "./contracts.ts";
import type { PdfObjectStore } from "./pdf-object-store.ts";

export interface ParsedIndirectObject extends PdfIndirectObjectShell {
  readonly dictionaryEntries: ReadonlyMap<string, string>;
  readonly objectValueText?: string;
  readonly streamText?: string;
  readonly decodedStreamBytes?: Uint8Array;
  readonly streamStartOffset?: number;
  readonly streamEndOffset?: number;
}

export interface ParsedFontResourceBinding {
  readonly resourceName: string;
  readonly fontRef: PdfObjectRef;
}

export interface ParsedColorSpaceResourceBinding {
  readonly resourceName: string;
  readonly rawValue: string;
  readonly objectRef?: PdfObjectRef;
}

export interface ParsedGraphicsStateResourceBinding {
  readonly resourceName: string;
  readonly rawValue: string;
  readonly objectRef?: PdfObjectRef;
}

export interface ParsedPropertyResourceBinding {
  readonly resourceName: string;
  readonly objectRef: PdfObjectRef;
}

export interface ParsedTransparencyGroupBinding {
  readonly isolated: boolean;
  readonly knockout: boolean;
  readonly colorSpaceValue?: string;
}

export interface ParsedXObjectResourceBinding {
  readonly resourceName: string;
  readonly objectRef: PdfObjectRef;
  readonly subtypeName?: string;
  readonly width?: number;
  readonly height?: number;
  readonly transparencyGroup?: ParsedTransparencyGroupBinding;
}

export interface ParsedPageEntry {
  readonly pageNumber: number;
  readonly pageRef: PdfObjectRef;
  readonly contentStreamRefs: readonly PdfObjectRef[];
  readonly annotationRefs: readonly PdfObjectRef[];
  readonly fontBindings: readonly ParsedFontResourceBinding[];
  readonly colorSpaceBindings: readonly ParsedColorSpaceResourceBinding[];
  readonly graphicsStateBindings: readonly ParsedGraphicsStateResourceBinding[];
  readonly propertyBindings: readonly ParsedPropertyResourceBinding[];
  readonly xObjectBindings: readonly ParsedXObjectResourceBinding[];
  readonly mediaBox?: PdfBoundingBox;
  readonly cropBox?: PdfBoundingBox;
  readonly pageBox?: PdfBoundingBox;
  readonly pageBoxSource?: "media-box" | "crop-box";
  readonly pageTransform: PdfTransformMatrix;
  readonly resourceCount: number;
  readonly resourceOrigin?: PdfPageValueOrigin;
}

export type ParsedTextArrayOperand =
  | { readonly kind: "literal"; readonly token: string }
  | { readonly kind: "hex"; readonly token: string }
  | { readonly kind: "adjustment"; readonly value: number };

type ParsedMarkedContentKind = "artifact" | "span" | "other";

export interface ParsedTextOperatorRun {
  readonly operator: "Tj" | "TJ" | "'" | "\"";
  readonly fontResourceName?: string;
  readonly fontSize?: number;
  readonly startsNewLine: boolean;
  readonly anchor?: PdfPoint;
  readonly writingMode?: "vertical";
  readonly operands: readonly ParsedTextArrayOperand[];
  readonly markedContentKind?: ParsedMarkedContentKind;
  readonly actualText?: string;
  readonly contentStreamRef?: PdfObjectRef;
}

export type ParsedContentStreamOperand =
  | { readonly kind: "name"; readonly token: string }
  | { readonly kind: "literal"; readonly token: string }
  | { readonly kind: "hex"; readonly token: string }
  | { readonly kind: "dictionary"; readonly token: string }
  | { readonly kind: "array"; readonly items: readonly ParsedTextArrayOperand[] }
  | { readonly kind: "other"; readonly token: string };

export interface ParsedContentStreamOperator {
  readonly operator: string;
  readonly operands: readonly ParsedContentStreamOperand[];
  readonly contentStreamRef?: PdfObjectRef;
}

export interface PdfDocumentAnalysis {
  readonly budget: PdfBudgetTracker;
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

export interface PdfDocumentAnalysisOptions {
  readonly pageNumbers?: ReadonlySet<number>;
}

export async function buildPdfDocumentAnalysis(
  store: PdfObjectStore,
  model: PdfDocumentModel,
  options: PdfDocumentAnalysisOptions = {},
): Promise<PdfDocumentAnalysis> {
  const pages = options.pageNumbers === undefined
    ? model.pages
    : model.pages.filter((page) => options.pageNumbers?.has(page.pageNumber) === true);
  const pageContentRefs = new Map<number, readonly PdfObjectRef[]>();
  for (const page of pages) {
    pageContentRefs.set(page.pageNumber, await resolvePageContentReferences(store, page));
  }
  const contentReferenceKeys = new Set(
    [...pageContentRefs.values()].flatMap((refs) => refs.map(keyOfObjectRef)),
  );
  const indirectObjects: ParsedIndirectObject[] = [];
  const objects = options.pageNumbers === undefined
    ? await store.all()
    : await collectPageAnalysisObjects(store, pages, pageContentRefs);
  for (const object of objects) {
    indirectObjects.push(await projectObject(store, object, contentReferenceKeys));
  }
  const objectIndex = new Map(indirectObjects.map((object) => [keyOfObjectRef(object.ref), object] as const));
  const pageEntries: ParsedPageEntry[] = [];
  for (const page of pages) {
    pageEntries.push(await projectPage(store, page, pageContentRefs.get(page.pageNumber) ?? []));
  }
  const crossReferenceSections: PdfCrossReferenceSection[] = store.sections.map((section) => ({
    kind: section.kind === "stream" ? "xref-stream" : "classic",
    offset: section.offset,
    entryCount: section.entries.length,
    decodedEntryCount: section.entries.length,
  }));
  const trailerSize = pdfAsInteger(pdfDictionaryGet(store.trailer, "Size"));
  const infoRef = pdfAsReference(pdfDictionaryGet(store.trailer, "Info"));
  const prevOffset = pdfAsInteger(pdfDictionaryGet(store.trailer, "Prev"));
  const trailer: PdfTrailerShell = {
    ...(trailerSize !== undefined ? { size: trailerSize } : {}),
    rootRef: store.root,
    ...(infoRef !== undefined ? { infoRef } : {}),
    ...(store.encrypt !== undefined ? { encryptRef: store.encrypt } : {}),
    ...(prevOffset !== undefined ? { prevOffset } : {}),
    hasDocumentId: store.documentId !== undefined,
  };
  return {
    budget: store.budget,
    scanText: "",
    byteLength: store.byteLength,
    isTruncated: false,
    usedFullStructureScan: options.pageNumbers === undefined,
    fileType: "pdf",
    pdfVersion: store.version,
    ...(store.startXref !== undefined ? { startXrefOffset: store.startXref } : {}),
    startXrefResolved: store.startXref !== undefined,
    crossReferenceKind: summarizeXref(crossReferenceSections),
    crossReferenceSections,
    trailer,
    ...(store.documentId !== undefined ? { documentId: store.documentId } : {}),
    indirectObjects,
    objectIndex,
    pageEntries,
    pageTreeResolved: true,
    inheritedPageStateResolved: true,
    expandedObjectStreams: store.sections.some((section) => section.entries.some((entry) => entry.kind === "compressed")),
    decodedXrefStreamEntries: true,
    pageCountEstimate: pageEntries.length,
    objectCountEstimate: store.objectCount,
    parseCoverage: {
      header: true,
      indirectObjects: indirectObjects.length > 0,
      crossReference: crossReferenceSections.length > 0,
      trailer: true,
      startXref: store.startXref !== undefined,
      pageTree: true,
    },
    repairState: store.repaired ? "recovered" : "clean",
  };
}

async function collectPageAnalysisObjects(
  store: PdfObjectStore,
  pages: readonly PdfPageModel[],
  pageContentRefs: ReadonlyMap<number, readonly PdfObjectRef[]>,
): Promise<readonly PdfIndirectObject[]> {
  const objects = new Map<string, PdfIndirectObject>();
  const queued = new Set<string>();
  const pending: PdfObjectRef[] = [];
  const enqueue = (ref: PdfObjectRef): void => {
    const key = keyOfObjectRef(ref);
    if (!queued.has(key)) {
      queued.add(key);
      pending.push(ref);
    }
  };

  for (const page of pages) {
    pageContentRefs.get(page.pageNumber)?.forEach(enqueue);
    page.annotations.forEach(enqueue);
    collectValueReferences(page.resources, enqueue);
  }

  const rootObject = await store.require(store.root);
  objects.set(keyOfObjectRef(rootObject.ref), rootObject);
  if (rootObject.value.kind === "dictionary") {
    collectValueReferences(pdfDictionaryGet(rootObject.value, "OCProperties"), enqueue);
  }

  while (pending.length > 0) {
    const ref = pending.shift();
    if (ref === undefined) {
      break;
    }
    const object = await store.get(ref);
    if (object === undefined) {
      continue;
    }
    objects.set(keyOfObjectRef(ref), object);
    collectValueReferences(object.value, enqueue);
  }

  return [...objects.values()].toSorted((left, right) =>
    left.source.start - right.source.start ||
    left.ref.objectNumber - right.ref.objectNumber ||
    left.ref.generationNumber - right.ref.generationNumber
  );
}

function collectValueReferences(
  value: PdfValue | undefined,
  add: (ref: PdfObjectRef) => void,
): void {
  if (value === undefined) {
    return;
  }
  switch (value.kind) {
    case "reference":
      add(value.value);
      return;
    case "array":
      value.items.forEach((item) => collectValueReferences(item, add));
      return;
    case "dictionary":
      for (const entry of value.entries) {
        if (entry.key.value === "Parent" || entry.key.value === "P" || entry.key.value === "Kids") {
          continue;
        }
        collectValueReferences(entry.value, add);
      }
      return;
    case "boolean":
    case "integer":
    case "name":
    case "null":
    case "real":
    case "string":
      return;
  }
}

async function projectObject(
  store: PdfObjectStore,
  object: PdfIndirectObject,
  contentReferenceKeys: ReadonlySet<string>,
): Promise<ParsedIndirectObject> {
  const dictionary = object.value.kind === "dictionary" ? object.value : undefined;
  const dictionaryEntries = dictionary === undefined
    ? new Map<string, string>()
    : new Map(dictionary.entries.map((entry) => [entry.key.value, formatPdfValue(entry.value)] as const));
  const typeName = pdfAsName(dictionary === undefined ? undefined : await store.resolve(pdfDictionaryGet(dictionary, "Type")));
  let decodedBytes: Uint8Array | undefined;
  let filters: readonly string[] | undefined;
  let decodeState: "available" | "decoded" | "unsupported-filter" | "failed" | undefined;
  const subtype = dictionary === undefined ? undefined : pdfAsName(pdfDictionaryGet(dictionary, "Subtype"));
  if (object.stream !== undefined && subtype !== "Image") {
    try {
      const decoded = await store.decodeStream(object.ref);
      decodedBytes = decoded?.bytes;
      filters = decoded?.filters;
      decodeState = decoded?.decoded === true ? "decoded" : "available";
    } catch (error: unknown) {
      decodeState = error instanceof Error && error.message.includes("unsupported-filter") ? "unsupported-filter" : "failed";
    }
  }
  const streamRole = classifyStreamRole(object, contentReferenceKeys);
  return {
    ref: object.ref,
    offset: object.source.start,
    endOffset: object.source.end,
    hasStream: object.stream !== undefined,
    ...(typeName !== undefined ? { typeName } : {}),
    dictionaryKeys: [...dictionaryEntries.keys()],
    ...(object.stream !== undefined ? { streamByteLength: object.stream.rawBytes.byteLength } : {}),
    ...(filters !== undefined ? { streamFilterNames: filters } : {}),
    ...(decodeState !== undefined ? { streamDecodeState: decodeState } : {}),
    ...(decodedBytes !== undefined ? { decodedStreamByteLength: decodedBytes.byteLength } : {}),
    ...(streamRole !== undefined ? { streamRole } : {}),
    dictionaryEntries,
    objectValueText: formatPdfValue(object.value),
    ...(decodedBytes !== undefined ? {
      decodedStreamBytes: decodedBytes,
      streamText: decodeBinaryText(decodedBytes),
    } : {}),
    ...(object.stream !== undefined ? {
      streamStartOffset: object.stream.dataSource.start,
      streamEndOffset: object.stream.dataSource.end,
    } : {}),
  };
}

async function projectPage(
  store: PdfObjectStore,
  page: PdfPageModel,
  contentStreamRefs: readonly PdfObjectRef[],
): Promise<ParsedPageEntry> {
  const resources = page.resources;
  const fonts = resources === undefined ? undefined : await store.resolveDictionary(pdfDictionaryGet(resources, "Font"));
  const colorSpaces = resources === undefined ? undefined : await store.resolveDictionary(pdfDictionaryGet(resources, "ColorSpace"));
  const graphicsStates = resources === undefined ? undefined : await store.resolveDictionary(pdfDictionaryGet(resources, "ExtGState"));
  const properties = resources === undefined ? undefined : await store.resolveDictionary(pdfDictionaryGet(resources, "Properties"));
  const xObjects = resources === undefined ? undefined : await store.resolveDictionary(pdfDictionaryGet(resources, "XObject"));
  return {
    pageNumber: page.pageNumber,
    pageRef: page.ref,
    contentStreamRefs,
    annotationRefs: page.annotations,
    fontBindings: fontBindings(fonts),
    colorSpaceBindings: valueBindings(colorSpaces),
    graphicsStateBindings: valueBindings(graphicsStates),
    propertyBindings: propertyBindings(properties),
    xObjectBindings: await xObjectBindings(store, xObjects),
    ...(page.mediaBox !== undefined ? { mediaBox: page.mediaBox } : {}),
    ...(page.cropBox !== undefined ? { cropBox: page.cropBox } : {}),
    ...(page.cropBox !== undefined || page.mediaBox !== undefined ? { pageBox: page.cropBox ?? page.mediaBox } : {}),
    ...(page.cropBox !== undefined ? { pageBoxSource: "crop-box" } : page.mediaBox !== undefined ? { pageBoxSource: "media-box" } : {}),
    pageTransform: pageDisplayTransform(page),
    resourceCount: resources === undefined ? 0 : 1,
    ...(resources !== undefined ? { resourceOrigin: "direct" } : {}),
  };
}

function fontBindings(dictionary: PdfDictionaryValue | undefined): readonly ParsedFontResourceBinding[] {
  if (dictionary === undefined) {
    return [];
  }
  return dictionary.entries.flatMap((entry) => {
    const ref = pdfAsReference(entry.value);
    return ref === undefined ? [] : [{ resourceName: entry.key.value, fontRef: ref }];
  });
}

function propertyBindings(dictionary: PdfDictionaryValue | undefined): readonly ParsedPropertyResourceBinding[] {
  if (dictionary === undefined) {
    return [];
  }
  return dictionary.entries.flatMap((entry) => {
    const ref = pdfAsReference(entry.value);
    return ref === undefined ? [] : [{ resourceName: entry.key.value, objectRef: ref }];
  });
}

function valueBindings(
  dictionary: PdfDictionaryValue | undefined,
): readonly ParsedColorSpaceResourceBinding[] {
  if (dictionary === undefined) {
    return [];
  }
  return dictionary.entries.map((entry) => {
    const objectRef = pdfAsReference(entry.value);
    return {
      resourceName: entry.key.value,
      rawValue: formatPdfValue(entry.value),
      ...(objectRef !== undefined ? { objectRef } : {}),
    };
  });
}

async function xObjectBindings(
  store: PdfObjectStore,
  dictionary: PdfDictionaryValue | undefined,
): Promise<readonly ParsedXObjectResourceBinding[]> {
  if (dictionary === undefined) {
    return [];
  }
  const bindings: ParsedXObjectResourceBinding[] = [];
  for (const entry of dictionary.entries) {
    const objectRef = pdfAsReference(entry.value);
    if (objectRef === undefined) {
      continue;
    }
    const target = await store.get(objectRef);
    const targetDictionary = target?.value.kind === "dictionary" ? target.value : undefined;
    const subtypeName = pdfAsName(targetDictionary === undefined ? undefined : await store.resolve(pdfDictionaryGet(targetDictionary, "Subtype")));
    const width = pdfAsNumber(targetDictionary === undefined ? undefined : await store.resolve(pdfDictionaryGet(targetDictionary, "Width")));
    const height = pdfAsNumber(targetDictionary === undefined ? undefined : await store.resolve(pdfDictionaryGet(targetDictionary, "Height")));
    const group = targetDictionary === undefined ? undefined : await store.resolveDictionary(pdfDictionaryGet(targetDictionary, "Group"));
    const transparencyGroup = group === undefined || pdfAsName(pdfDictionaryGet(group, "S")) !== "Transparency"
      ? undefined
      : {
          isolated: booleanValue(pdfDictionaryGet(group, "I")) ?? false,
          knockout: booleanValue(pdfDictionaryGet(group, "K")) ?? false,
          ...(pdfDictionaryGet(group, "CS") !== undefined ? { colorSpaceValue: formatPdfValue(pdfDictionaryGet(group, "CS") as PdfValue) } : {}),
        };
    bindings.push({
      resourceName: entry.key.value,
      objectRef,
      ...(subtypeName !== undefined ? { subtypeName: `/${subtypeName}` } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(transparencyGroup !== undefined ? { transparencyGroup } : {}),
    });
  }
  return bindings;
}

export function keyOfObjectRef(ref: PdfObjectRef): string {
  return pdfReferenceKey(ref);
}

export function parseContentStreamOperators(
  text: string,
  budget: PdfBudgetTracker,
): readonly ParsedContentStreamOperator[] {
  const bytes = encodeBinaryText(text);
  return parsePdfContentStream(bytes, budget)
    .filter((instruction): instruction is PdfContentOperator => instruction.operator !== "BI")
    .map((instruction) => ({
      operator: instruction.operator,
      operands: instruction.operands.map(projectOperand),
    }));
}

export function parsePageContentStreamOperators(
  streams: readonly PdfContentStreamInput[],
  budget: PdfBudgetTracker,
): readonly ParsedContentStreamOperator[] {
  return parsePdfContentStreams(streams, budget)
    .filter((instruction): instruction is PdfContentOperator & { readonly contentStreamRef: PdfObjectRef } =>
      instruction.operator !== "BI"
    )
    .map((instruction) => ({
      operator: instruction.operator,
      operands: instruction.operands.map(projectOperand),
      contentStreamRef: instruction.contentStreamRef,
    }));
}

export function parseTextOperatorRunsFromOperators(
  operators: readonly ParsedContentStreamOperator[],
  pageTransform: PdfTransformMatrix = identityTransform(),
): readonly ParsedTextOperatorRun[] {
  const runs: ParsedTextOperatorRun[] = [];
  let fontResourceName: string | undefined;
  let fontSize: number | undefined;
  let textMatrix = identityTransform();
  let lineMatrix = identityTransform();
  let graphicsTransform = identityTransform();
  const graphicsTransformStack: PdfTransformMatrix[] = [];
  let leading = 0;
  let startsNewLine = false;
  const markedContent: { readonly kind: ParsedMarkedContentKind; readonly actualText?: string }[] = [];
  for (const instruction of operators) {
    const numbers = instruction.operands.flatMap((operand) => operand.kind === "other" && Number.isFinite(Number(operand.token))
      ? [Number(operand.token)]
      : []);
    switch (instruction.operator) {
      case "q":
        graphicsTransformStack.push(graphicsTransform);
        break;
      case "Q":
        graphicsTransform = graphicsTransformStack.pop() ?? identityTransform();
        break;
      case "cm": {
        const matrix = transformFromNumbers(numbers);
        if (matrix !== undefined) {
          graphicsTransform = multiplyTransforms(graphicsTransform, matrix);
        }
        break;
      }
      case "BT":
        textMatrix = identityTransform();
        lineMatrix = identityTransform();
        startsNewLine = true;
        break;
      case "Tf": {
        const name = instruction.operands[0];
        fontResourceName = name?.kind === "name" ? name.token.slice(1) : fontResourceName;
        fontSize = numbers.at(-1) ?? fontSize;
        break;
      }
      case "Tm":
        {
          const matrix = transformFromNumbers(numbers);
          if (matrix !== undefined) {
            textMatrix = matrix;
            lineMatrix = matrix;
            startsNewLine = true;
          }
        }
        break;
      case "Td":
      case "TD":
        if (numbers.length >= 2) {
          const tx = numbers[0];
          const ty = numbers[1];
          if (tx === undefined || ty === undefined) {
            break;
          }
          lineMatrix = multiplyTransforms(translationTransform(tx, ty), lineMatrix);
          textMatrix = lineMatrix;
          if (instruction.operator === "TD") {
            leading = -ty;
          }
          startsNewLine = true;
        }
        break;
      case "T*":
        lineMatrix = multiplyTransforms(translationTransform(0, -leading), lineMatrix);
        textMatrix = lineMatrix;
        startsNewLine = true;
        break;
      case "TL":
        leading = numbers.at(-1) ?? leading;
        break;
      case "BMC": {
        const tag = instruction.operands.at(-1);
        markedContent.push({ kind: classifyMarkedContent(tag?.kind === "name" ? tag.token : undefined) });
        break;
      }
      case "BDC": {
        const tag = instruction.operands[0];
        const properties = instruction.operands.at(-1);
        const actualText = properties?.kind === "dictionary"
          ? decodePdfLiteral(parseDictionaryEntries(properties.token).get("ActualText") ?? "")
          : undefined;
        markedContent.push({
          kind: classifyMarkedContent(tag?.kind === "name" ? tag.token : undefined),
          ...(actualText !== undefined && actualText.length > 0 ? { actualText } : {}),
        });
        break;
      }
      case "EMC":
        markedContent.pop();
        break;
      case "Tj":
      case "TJ":
      case "'":
      case "\"": {
        if (instruction.operator === "'" || instruction.operator === "\"") {
          lineMatrix = multiplyTransforms(translationTransform(0, -leading), lineMatrix);
          textMatrix = lineMatrix;
          startsNewLine = true;
        }
        const textOperands = textArrayOperands(instruction);
        const context = markedContent.at(-1);
        const pageTextMatrix = multiplyTransforms(
          multiplyTransforms(textMatrix, graphicsTransform),
          pageTransform,
        );
        const pageFontSize = fontSize === undefined
          ? undefined
          : Math.abs(fontSize) * Math.hypot(pageTextMatrix.c, pageTextMatrix.d);
        const hasVerticalBaseline = Math.abs(pageTextMatrix.b) > Math.abs(pageTextMatrix.a) * 1.5;
        runs.push({
          operator: instruction.operator,
          ...(instruction.contentStreamRef !== undefined ? { contentStreamRef: instruction.contentStreamRef } : {}),
          ...(fontResourceName !== undefined ? { fontResourceName } : {}),
          ...(pageFontSize !== undefined && Number.isFinite(pageFontSize) ? { fontSize: pageFontSize } : {}),
          startsNewLine,
          anchor: { x: pageTextMatrix.e, y: pageTextMatrix.f },
          ...(hasVerticalBaseline ? { writingMode: "vertical" as const } : {}),
          operands: textOperands,
          ...(context !== undefined ? { markedContentKind: context.kind } : {}),
          ...(context?.actualText !== undefined ? { actualText: context.actualText } : {}),
        });
        startsNewLine = false;
        break;
      }
    }
  }
  return runs;
}

function identityTransform(): PdfTransformMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function translationTransform(x: number, y: number): PdfTransformMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

function transformFromNumbers(numbers: readonly number[]): PdfTransformMatrix | undefined {
  if (numbers.length < 6) {
    return undefined;
  }
  const [a, b, c, d, e, f] = numbers;
  return a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || f === undefined
    ? undefined
    : { a, b, c, d, e, f };
}

function multiplyTransforms(
  left: PdfTransformMatrix,
  right: PdfTransformMatrix,
): PdfTransformMatrix {
  return {
    a: left.a * right.a + left.b * right.c,
    b: left.a * right.b + left.b * right.d,
    c: left.c * right.a + left.d * right.c,
    d: left.c * right.b + left.d * right.d,
    e: left.e * right.a + left.f * right.c + right.e,
    f: left.e * right.b + left.f * right.d + right.f,
  };
}

function pageDisplayTransform(page: PdfPageModel): PdfTransformMatrix {
  const box = page.cropBox ?? page.mediaBox;
  if (box === undefined || page.rotate === 0) {
    return identityTransform();
  }

  switch (page.rotate) {
    case 90:
      return { a: 0, b: -1, c: 1, d: 0, e: -box.y, f: box.width + box.x };
    case 180:
      return { a: -1, b: 0, c: 0, d: -1, e: box.width + box.x, f: box.height + box.y };
    case 270:
      return { a: 0, b: 1, c: -1, d: 0, e: box.height + box.y, f: -box.x };
    default:
      return identityTransform();
  }
}

export function parseDictionaryEntries(text: string): ReadonlyMap<string, string> {
  const bytes = encodeBinaryText(text);
  try {
    const parser = new PdfSyntaxParser(bytes, createUnboundedContentBudget());
    const parsed = parser.parseValue(0);
    if (parsed.value.kind !== "dictionary") {
      return new Map();
    }
    return new Map(parsed.value.entries.map((entry) => [entry.key.value, formatPdfValue(entry.value)] as const));
  } catch {
    return new Map();
  }
}

export function findFirstDictionaryToken(text: string): string | undefined {
  const start = text.indexOf("<<");
  if (start < 0) {
    return undefined;
  }
  const bytes = encodeBinaryText(text.slice(start));
  try {
    const parser = new PdfSyntaxParser(bytes, createUnboundedContentBudget());
    const parsed = parser.parseValue(0);
    return parsed.value.kind === "dictionary" ? formatPdfValue(parsed.value) : undefined;
  } catch {
    return undefined;
  }
}

export function readObjectRefValue(text: string | undefined): PdfObjectRef | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parser = new PdfSyntaxParser(encodeBinaryText(text), createUnboundedContentBudget());
    return pdfAsReference(parser.parseValue(0).value);
  } catch {
    return undefined;
  }
}

export function readObjectRefsValue(text: string | undefined): readonly PdfObjectRef[] {
  if (text === undefined) {
    return [];
  }
  try {
    const parser = new PdfSyntaxParser(encodeBinaryText(text), createUnboundedContentBudget());
    const value = parser.parseValue(0).value;
    const direct = pdfAsReference(value);
    if (direct !== undefined) {
      return [direct];
    }
    return pdfAsArray(value)?.items.flatMap((item) => {
      const ref = pdfAsReference(item);
      return ref === undefined ? [] : [ref];
    }) ?? [];
  } catch {
    return [];
  }
}

export function decodePdfLiteral(token: string): string {
  if (!token.startsWith("(")) {
    return token;
  }
  try {
    const parser = new PdfSyntaxParser(encodeBinaryText(token), createUnboundedContentBudget());
    const value = parser.parseValue(0).value;
    return value.kind === "string" ? decodeBinaryText(value.bytes) : token;
  } catch {
    return token.slice(1, token.endsWith(")") ? -1 : undefined);
  }
}

function projectOperand(value: PdfValue): ParsedContentStreamOperand {
  switch (value.kind) {
    case "name":
      return { kind: "name", token: formatPdfValue(value) };
    case "string":
      return { kind: value.form === "literal" ? "literal" : "hex", token: formatPdfValue(value) };
    case "dictionary":
      return { kind: "dictionary", token: formatPdfValue(value) };
    case "array":
      return { kind: "array", items: value.items.flatMap(projectTextArrayItem) };
    case "boolean":
    case "integer":
    case "null":
    case "real":
    case "reference":
      return { kind: "other", token: formatPdfValue(value) };
  }
}

function projectTextArrayItem(value: PdfValue): readonly ParsedTextArrayOperand[] {
  if (value.kind === "string") {
    return [{ kind: value.form === "literal" ? "literal" : "hex", token: formatPdfValue(value) }];
  }
  const adjustment = pdfAsNumber(value);
  return adjustment === undefined ? [] : [{ kind: "adjustment", value: adjustment }];
}

function textArrayOperands(operator: ParsedContentStreamOperator): readonly ParsedTextArrayOperand[] {
  const textOperand = operator.operands.at(-1);
  if (textOperand?.kind === "array") {
    return textOperand.items;
  }
  if (textOperand?.kind === "literal" || textOperand?.kind === "hex") {
    return [{ kind: textOperand.kind, token: textOperand.token }];
  }
  return [];
}

function classifyMarkedContent(tag: string | undefined): ParsedMarkedContentKind {
  if (tag === "/Artifact") return "artifact";
  if (tag === "/Span") return "span";
  return "other";
}

function classifyStreamRole(
  object: PdfIndirectObject,
  contentReferenceKeys: ReadonlySet<string>,
): ParsedIndirectObject["streamRole"] {
  if (contentReferenceKeys.has(pdfReferenceKey(object.ref))) {
    return "content";
  }
  if (object.value.kind !== "dictionary") {
    return undefined;
  }
  const type = pdfAsName(pdfDictionaryGet(object.value, "Type"));
  const subtype = pdfAsName(pdfDictionaryGet(object.value, "Subtype"));
  if (type === "XRef") return "xref";
  if (type === "ObjStm") return "object-stream";
  if (type === "XObject" && (subtype === "Image" || subtype === "Form")) return "unknown";
  if (type === "Metadata" || type === "EmbeddedFile" || type === "Font" || type === "FontDescriptor") return "unknown";
  return "unknown";
}

function summarizeXref(sections: readonly PdfCrossReferenceSection[]): PdfCrossReferenceKind {
  const table = sections.some((section) => section.kind === "classic");
  const stream = sections.some((section) => section.kind === "xref-stream");
  return table && stream ? "hybrid" : stream ? "xref-stream" : table ? "classic" : "unknown";
}

function booleanValue(value: PdfValue | undefined): boolean | undefined {
  return value?.kind === "boolean" ? value.value : undefined;
}

function decodeBinaryText(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 16_384;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return result;
}

function encodeBinaryText(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff);
}

function createUnboundedContentBudget(): PdfBudgetTracker {
  return new PdfBudgetTracker({
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxPages: Number.MAX_SAFE_INTEGER,
    maxObjects: Number.MAX_SAFE_INTEGER,
    maxRecursionDepth: 256,
    maxDecodedBytes: Number.MAX_SAFE_INTEGER,
    maxOperators: Number.MAX_SAFE_INTEGER,
    maxImagePixels: Number.MAX_SAFE_INTEGER,
    maxCacheBytes: Number.MAX_SAFE_INTEGER,
  });
}
