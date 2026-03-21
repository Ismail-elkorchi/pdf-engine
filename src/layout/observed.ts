import {
  decodePdfCidHexTextWithKnownCollectionMap,
  type PdfCidCollectionIdentifier,
} from "../cid-collection-unicode.ts";
import { decodePdfHexTextWithUnicodeCMap, parsePdfUnicodeCMap } from "../cmap.ts";
import {
  buildPdfSingleByteFontEncoding,
  decodePdfSingleByteHexText,
  decodePdfSingleByteLiteralText,
  type PdfSingleByteFontEncoding,
} from "../font-encoding.ts";
import { hasDetectedFeatureFinding } from "../pdf-feature-findings.ts";
import {
  decodePdfLiteral,
  findFirstDictionaryToken,
  keyOfObjectRef,
  parseContentStreamOperators,
  parseDictionaryEntries,
  parseTextOperatorRuns,
  readObjectRefValue,
  readObjectRefsValue,
  type ParsedContentStreamOperator,
  type ParsedIndirectObject,
  type ParsedTextOperatorRun,
  type PdfShellAnalysis,
} from "../shell-parse.ts";
import { parseTrueTypeGlyphUnicodeMap } from "../truetype-cmap.ts";

import type {
  PdfDiagnostic,
  PdfFeatureFinding,
  PdfMarkedContentKind,
  PdfObjectRef,
  PdfObservedGlyph,
  PdfObservedMark,
  PdfObservedMarkedContentMark,
  PdfObservedPage,
  PdfObservedPathMark,
  PdfObservedTextRun,
  PdfObservedTextMark,
  PdfTextEncodingKind,
  PdfTransformMatrix,
  PdfUnicodeMappingSource,
  PdfVisibilityState,
  PdfWritingMode,
} from "../contracts.ts";

interface PdfEmbeddedFontMapping {
  readonly glyphUnicodeByGlyphId: ReadonlyMap<number, string>;
  readonly cidToGidByCid?: ReadonlyMap<number, number>;
  readonly requiresExplicitCidToGidMap: boolean;
}

interface PdfTextDecodeResult {
  readonly text: string;
  readonly complete: boolean;
  readonly mappingSource: PdfUnicodeMappingSource;
  readonly sourceUnitCount: number;
  readonly mappedUnitCount: number;
}

interface PdfXObjectBinding {
  readonly objectRef: PdfObjectRef;
  readonly subtypeName?: string;
  readonly width?: number;
  readonly height?: number;
}

interface PdfPropertyBinding {
  readonly objectRef: PdfObjectRef;
}

interface PdfObservedPathBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly pointCount: number;
  readonly closed: boolean;
}

interface PdfObservedGraphicsState {
  readonly transform: PdfTransformMatrix;
  readonly currentPath: PdfObservedPathBounds | undefined;
  readonly pendingClipOperator: "W" | "W*" | undefined;
  readonly pendingClipBounds: PdfObservedPathBounds | undefined;
}

interface PdfObservedContentMarksResult {
  readonly marks: readonly Exclude<PdfObservedMark, PdfObservedTextMark>[];
  readonly textContexts: readonly PdfObservedTextContext[];
  readonly nextContentOrder: number;
}

interface PdfObservedTextContext {
  readonly contentOrder: number;
  readonly markedContentId?: string;
  readonly visibilityState?: PdfVisibilityState;
}

interface PdfObservedMarkedContentState {
  readonly markId: string;
  readonly markIndex: number;
  readonly visibilityState: PdfVisibilityState;
}

interface PdfObservedMarkedContentProperties {
  readonly propertyName?: string;
  readonly actualText?: string;
  readonly mcid?: number;
  readonly optionalContentRef?: PdfObjectRef;
  readonly visibilityState?: PdfVisibilityState;
}

interface PdfOptionalContentVisibilityConfig {
  readonly baseState: "on" | "off" | "unknown";
  readonly onKeys: ReadonlySet<string>;
  readonly offKeys: ReadonlySet<string>;
}

const IDENTITY_TRANSFORM: PdfTransformMatrix = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
};

const PATH_PAINT_OPERATORS = new Set<PdfObservedPathMark["paintOperator"]>(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);

export interface PdfObservationInspection {
  readonly analysis: PdfShellAnalysis;
  readonly featureFindings: readonly PdfFeatureFinding[];
}

export interface PdfObservedPagesBuildResult {
  readonly pages: readonly PdfObservedPage[];
  readonly hasFontMappingGap: boolean;
  readonly hasLiteralFontEncodingGap: boolean;
}

export function buildObservedPages(
  inspection: PdfObservationInspection,
  diagnostics: PdfDiagnostic[],
): PdfObservedPagesBuildResult {
  let hasFontMappingGap = false;
  let hasLiteralFontEncodingGap = false;
  const observedPages = inspection.analysis.pageEntries.map((pageEntry) => {
    const observedPage = buildObservedPage(pageEntry, inspection);
    hasFontMappingGap = hasFontMappingGap || observedPage.hasFontMappingGap;
    hasLiteralFontEncodingGap = hasLiteralFontEncodingGap || observedPage.hasLiteralFontEncodingGap;
    return observedPage.page;
  });

  const hasTextRuns = observedPages.some((page) => page.runs.length > 0);
  if (hasTextRuns || inspection.analysis.pageEntries.length > 0) {
    return { pages: observedPages, hasFontMappingGap, hasLiteralFontEncodingGap };
  }

  diagnostics.push({
    code: "observation-page-fallback",
    stage: "observation",
    level: "medium",
    message: "The parser could not resolve the page tree, so observation fell back to all stream objects in source order.",
  });

  const fallbackStreamRefs = inspection.analysis.indirectObjects
    .filter((objectShell) => objectShell.hasStream && typeof objectShell.streamText === "string")
    .map((objectShell) => objectShell.ref);

  const fallbackPage = buildObservedPage(
    {
      pageNumber: 1,
      contentStreamRefs: fallbackStreamRefs,
      fontBindings: [],
      propertyBindings: [],
      xObjectBindings: [],
    },
    inspection,
    "stream-fallback",
  );
  return {
    pages: [fallbackPage.page],
    hasFontMappingGap: hasFontMappingGap || fallbackPage.hasFontMappingGap,
    hasLiteralFontEncodingGap: hasLiteralFontEncodingGap || fallbackPage.hasLiteralFontEncodingGap,
  };
}

function buildObservedPage(
  pageEntry: {
    readonly pageNumber: number;
    readonly pageRef?: PdfObjectRef;
    readonly contentStreamRefs: readonly PdfObjectRef[];
    readonly fontBindings: readonly { readonly resourceName: string; readonly fontRef: PdfObjectRef }[];
    readonly propertyBindings: readonly { readonly resourceName: string; readonly objectRef: PdfObjectRef }[];
    readonly xObjectBindings: readonly {
      readonly resourceName: string;
      readonly objectRef: PdfObjectRef;
      readonly subtypeName?: string;
      readonly width?: number;
      readonly height?: number;
    }[];
  },
  inspection: PdfObservationInspection,
  resolutionMethodOverride?: "page-tree" | "recovered-page-order" | "stream-fallback",
): { page: PdfObservedPage; hasFontMappingGap: boolean; hasLiteralFontEncodingGap: boolean } {
  const resolutionMethod = resolutionMethodOverride ??
    (inspection.analysis.pageTreeResolved ? "page-tree" : "recovered-page-order");
  const pageNumber = pageEntry.pageNumber;
  const glyphs: PdfObservedGlyph[] = [];
  const marks: PdfObservedMark[] = [];
  const runs: PdfObservedTextRun[] = [];
  let contentOrder = 0;
  let fontMappingGapCount = 0;
  let literalFontEncodingGapCount = 0;
  let hasSevereFontMappingGap = false;
  let hasSevereLiteralFontEncodingGap = false;
  const fontRefByResourceName = new Map(pageEntry.fontBindings.map((binding) => [binding.resourceName, binding.fontRef] as const));
  const propertyBindingByResourceName = new Map(pageEntry.propertyBindings.map((binding) => [binding.resourceName, {
    objectRef: binding.objectRef,
  }] as const));
  const xObjectBindingByResourceName = new Map(pageEntry.xObjectBindings.map((binding) => [binding.resourceName, {
    objectRef: binding.objectRef,
    ...(binding.subtypeName !== undefined ? { subtypeName: binding.subtypeName } : {}),
    ...(binding.width !== undefined ? { width: binding.width } : {}),
    ...(binding.height !== undefined ? { height: binding.height } : {}),
  }] as const));
  const optionalContentVisibilityConfig = resolveOptionalContentVisibilityConfig(inspection);
  const hasDuplicateTextLayerFeature = hasDetectedFeatureFinding(inspection.featureFindings, "duplicate-text-layer");
  const unicodeCMapByFontKey = new Map<string, ReturnType<typeof parsePdfUnicodeCMap>>();
  const embeddedFontMappingByFontKey = new Map<string, PdfEmbeddedFontMapping | undefined>();
  const singleByteFontEncodingByFontKey = new Map<string, PdfSingleByteFontEncoding | undefined>();

  for (const contentStreamRef of pageEntry.contentStreamRefs) {
    const contentStream = inspection.analysis.objectIndex.get(keyOfObjectRef(contentStreamRef));
    if (!contentStream?.streamText) {
      continue;
    }

    const contentMarkResult = observeContentStreamMarks(
      contentStream.streamText,
      pageNumber,
      contentStreamRef,
      propertyBindingByResourceName,
      optionalContentVisibilityConfig,
      inspection.analysis.objectIndex,
      xObjectBindingByResourceName,
      contentOrder,
    );
    contentOrder = contentMarkResult.nextContentOrder;
    marks.push(...contentMarkResult.marks);
    const textContexts = [...contentMarkResult.textContexts];
    const parsedRuns = parseTextOperatorRuns(contentStream.streamText);
    for (const parsedRun of parsedRuns) {
      const observedRun = observeParsedTextRun(
        parsedRun,
        fontRefByResourceName,
        unicodeCMapByFontKey,
        embeddedFontMappingByFontKey,
        singleByteFontEncodingByFontKey,
        inspection,
      );
      if (observedRun.hasFontMappingGap) {
        fontMappingGapCount += 1;
      }
      if (observedRun.hasLiteralFontEncodingGap) {
        literalFontEncodingGapCount += 1;
      }
      hasSevereFontMappingGap = hasSevereFontMappingGap || observedRun.hasSevereFontMappingGap;
      hasSevereLiteralFontEncodingGap =
        hasSevereLiteralFontEncodingGap || observedRun.hasSevereLiteralFontEncodingGap;
      if (observedRun.text.length === 0) {
        continue;
      }

      const textContext = textContexts.shift();
      const runContentOrder = textContext?.contentOrder ?? contentOrder;
      if (runContentOrder >= contentOrder) {
        contentOrder = runContentOrder + 1;
      }

      const glyphIds: string[] = [];
      const codePoints = Array.from(observedRun.text);

      for (const [glyphIndex, text] of codePoints.entries()) {
        const glyphId = `glyph-${pageNumber}-${runContentOrder + 1}-${glyphIndex + 1}`;
        glyphIds.push(glyphId);
        glyphs.push({
          id: glyphId,
          pageNumber,
          glyphIndex,
          contentOrder: runContentOrder,
          text,
          unicodeCodePoint: text.codePointAt(0) ?? 0,
          hidden: false,
          origin: "native-text",
          contentStreamRef,
          ...(observedRun.fontRef !== undefined ? { fontRef: observedRun.fontRef } : {}),
          ...(observedRun.textEncodingKind !== undefined ? { textEncodingKind: observedRun.textEncodingKind } : {}),
          ...(observedRun.unicodeMappingSource !== undefined
            ? { unicodeMappingSource: observedRun.unicodeMappingSource }
            : {}),
          ...(observedRun.writingMode !== undefined ? { writingMode: observedRun.writingMode } : {}),
          objectRef: contentStreamRef,
          ...(observedRun.anchor !== undefined ? { anchor: observedRun.anchor } : {}),
          ...(observedRun.fontSize !== undefined ? { fontSize: observedRun.fontSize } : {}),
          ...(observedRun.startsNewLine ? { startsNewLine: true } : {}),
        });
      }

      runs.push({
        id: `run-${pageNumber}-${runContentOrder + 1}`,
        pageNumber,
        contentOrder: runContentOrder,
        text: observedRun.text,
        glyphIds,
        origin: "native-text",
        contentStreamRef,
        ...(observedRun.fontRef !== undefined ? { fontRef: observedRun.fontRef } : {}),
        ...(observedRun.textEncodingKind !== undefined ? { textEncodingKind: observedRun.textEncodingKind } : {}),
        ...(observedRun.unicodeMappingSource !== undefined ? { unicodeMappingSource: observedRun.unicodeMappingSource } : {}),
        ...(observedRun.writingMode !== undefined ? { writingMode: observedRun.writingMode } : {}),
        objectRef: contentStreamRef,
        ...(observedRun.anchor !== undefined ? { anchor: observedRun.anchor } : {}),
        ...(observedRun.fontSize !== undefined ? { fontSize: observedRun.fontSize } : {}),
        ...(observedRun.startsNewLine ? { startsNewLine: true } : {}),
      });

      marks.push({
        id: `mark-text-${pageNumber}-${runContentOrder + 1}`,
        kind: "text",
        pageNumber,
        contentOrder: runContentOrder,
        runId: `run-${pageNumber}-${runContentOrder + 1}`,
        glyphIds,
        text: observedRun.text,
        origin: "native-text",
        contentStreamRef,
        ...(observedRun.fontRef !== undefined ? { fontRef: observedRun.fontRef } : {}),
        ...(observedRun.textEncodingKind !== undefined ? { textEncodingKind: observedRun.textEncodingKind } : {}),
        ...(observedRun.unicodeMappingSource !== undefined ? { unicodeMappingSource: observedRun.unicodeMappingSource } : {}),
        ...(observedRun.writingMode !== undefined ? { writingMode: observedRun.writingMode } : {}),
        ...(parsedRun.markedContentKind !== undefined ? { markedContentKind: parsedRun.markedContentKind } : {}),
        ...(parsedRun.actualText !== undefined ? { actualText: parsedRun.actualText } : {}),
        objectRef: contentStreamRef,
        ...(textContext?.markedContentId !== undefined ? { markedContentId: textContext.markedContentId } : {}),
        ...(textContext?.visibilityState !== undefined ? { visibilityState: textContext.visibilityState } : {}),
        ...(observedRun.anchor !== undefined ? { anchor: observedRun.anchor } : {}),
        ...(observedRun.fontSize !== undefined ? { fontSize: observedRun.fontSize } : {}),
        ...(observedRun.startsNewLine ? { startsNewLine: true } : {}),
        ...(textContext?.visibilityState === "hidden" ? { hiddenTextCandidate: true } : {}),
        ...(hasDuplicateTextLayerFeature && textContext?.visibilityState === "hidden" ? { duplicateLayerCandidate: true } : {}),
      });
    }
  }

  const pageWritingMode = inferObservedPageWritingMode(runs);
  const normalizedRuns = pageWritingMode === undefined ? runs : runs.map((run) => (
    run.writingMode !== undefined ? run : { ...run, writingMode: pageWritingMode }
  ));
  const normalizedGlyphs = pageWritingMode === undefined ? glyphs : glyphs.map((glyph) => (
    glyph.writingMode !== undefined ? glyph : { ...glyph, writingMode: pageWritingMode }
  ));
  const normalizedMarks = pageWritingMode === undefined ? marks : marks.map((mark) => (
    mark.kind === "text" && mark.writingMode === undefined ? { ...mark, writingMode: pageWritingMode } : mark
  ));

  const hasFontMappingGap = hasSevereFontMappingGap || fontMappingGapCount > 1;
  const hasLiteralFontEncodingGap =
    hasSevereLiteralFontEncodingGap || literalFontEncodingGapCount > 1;

  return {
    page: {
      pageNumber,
      resolutionMethod,
      ...(pageEntry.pageRef !== undefined ? { pageRef: pageEntry.pageRef } : {}),
      glyphs: normalizedGlyphs,
      runs: normalizedRuns,
      marks: normalizedMarks.toSorted((left, right) => left.contentOrder - right.contentOrder || left.id.localeCompare(right.id)),
    },
    hasFontMappingGap,
    hasLiteralFontEncodingGap,
  };
}

function observeContentStreamMarks(
  contentStreamText: string,
  pageNumber: number,
  contentStreamRef: PdfObjectRef,
  propertyBindingByResourceName: ReadonlyMap<string, PdfPropertyBinding>,
  optionalContentVisibilityConfig: PdfOptionalContentVisibilityConfig | undefined,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
  xObjectBindingByResourceName: ReadonlyMap<string, PdfXObjectBinding>,
  startingContentOrder: number,
): PdfObservedContentMarksResult {
  const marks: Array<Exclude<PdfObservedMark, PdfObservedTextMark>> = [];
  const textContexts: PdfObservedTextContext[] = [];
  const operators = parseContentStreamOperators(contentStreamText);
  const graphicsStateStack: PdfObservedGraphicsState[] = [];
  const markedContentStack: PdfObservedMarkedContentState[] = [];
  let graphicsState: PdfObservedGraphicsState = {
    transform: IDENTITY_TRANSFORM,
    currentPath: undefined,
    pendingClipOperator: undefined,
    pendingClipBounds: undefined,
  };
  let contentOrder = startingContentOrder;

  for (const operator of operators) {
    if (isTextShowOperator(operator.operator)) {
      const currentMarkedContentId = resolveCurrentMarkedContentId(markedContentStack);
      const currentVisibilityState = resolveEffectiveVisibilityState(markedContentStack);
      textContexts.push({
        contentOrder,
        ...(currentMarkedContentId !== undefined ? { markedContentId: currentMarkedContentId } : {}),
        ...(currentVisibilityState !== undefined ? { visibilityState: currentVisibilityState } : {}),
      });
      contentOrder += 1;
      continue;
    }

    if (operator.operator === "BDC" || operator.operator === "BMC") {
      const tagName = readMarkedContentTagName(operator) ?? "Unknown";
      const markedContentKind = classifyObservedMarkedContent(tagName);
      const markedContentProperties = operator.operator === "BDC"
        ? readMarkedContentProperties(
          operator,
          propertyBindingByResourceName,
          optionalContentVisibilityConfig,
          objectIndex,
        )
        : {};
      const visibilityState = combineVisibilityStates(
        resolveEffectiveVisibilityState(markedContentStack),
        markedContentProperties.visibilityState,
      ) ?? "visible";
      const markId = `mark-marked-content-${pageNumber}-${contentOrder + 1}`;
      const markedContentMark: PdfObservedMarkedContentMark = {
        id: markId,
        kind: "marked-content",
        pageNumber,
        contentOrder,
        contentStreamRef,
        objectRef: markedContentProperties.optionalContentRef ?? contentStreamRef,
        tagName,
        markedContentKind,
        depth: markedContentStack.length,
        ...(markedContentProperties.propertyName !== undefined ? { propertyName: markedContentProperties.propertyName } : {}),
        ...(markedContentProperties.optionalContentRef !== undefined
          ? { optionalContentRef: markedContentProperties.optionalContentRef }
          : {}),
        ...(markedContentProperties.mcid !== undefined ? { mcid: markedContentProperties.mcid } : {}),
        ...(markedContentProperties.actualText !== undefined ? { actualText: markedContentProperties.actualText } : {}),
        visibilityState,
      };
      marks.push(markedContentMark);
      markedContentStack.push({
        markId,
        markIndex: marks.length - 1,
        visibilityState,
      });
      contentOrder += 1;
      continue;
    }

    if (operator.operator === "EMC") {
      const markedContentState = markedContentStack.pop();
      if (markedContentState) {
        const existingMark = marks[markedContentState.markIndex];
        if (existingMark?.kind === "marked-content") {
          marks[markedContentState.markIndex] = {
            ...existingMark,
            closedContentOrder: contentOrder > existingMark.contentOrder ? contentOrder - 1 : existingMark.contentOrder,
          };
        }
      }
      continue;
    }

    if (operator.operator === "q") {
      graphicsStateStack.push(cloneGraphicsState(graphicsState));
      continue;
    }

    if (operator.operator === "Q") {
      graphicsState = graphicsStateStack.pop() ?? {
        transform: IDENTITY_TRANSFORM,
        currentPath: undefined,
        pendingClipOperator: undefined,
        pendingClipBounds: undefined,
      };
      continue;
    }

    if (operator.operator === "cm") {
      const matrix = readTransformMatrixOperands(operator);
      if (matrix) {
        graphicsState = {
          ...graphicsState,
          transform: multiplyTransformMatrices(graphicsState.transform, matrix),
        };
      }
      continue;
    }

    if (operator.operator === "m") {
      const point = readTrailingPoint(operator, 1);
      if (point) {
        graphicsState = {
          ...graphicsState,
          currentPath: createObservedPathBounds([transformPoint(graphicsState.transform, point)]),
        };
      }
      continue;
    }

    if (operator.operator === "l") {
      const point = readTrailingPoint(operator, 1);
      if (point) {
        graphicsState = {
          ...graphicsState,
          currentPath: extendObservedPathBounds(
            graphicsState.currentPath,
            [transformPoint(graphicsState.transform, point)],
          ),
        };
      }
      continue;
    }

    if (operator.operator === "c") {
      const points = readTrailingPoints(operator, 3);
      if (points.length > 0) {
        graphicsState = {
          ...graphicsState,
          currentPath: extendObservedPathBounds(
            graphicsState.currentPath,
            points.map((point) => transformPoint(graphicsState.transform, point)),
          ),
        };
      }
      continue;
    }

    if (operator.operator === "v" || operator.operator === "y") {
      const points = readTrailingPoints(operator, 2);
      if (points.length > 0) {
        graphicsState = {
          ...graphicsState,
          currentPath: extendObservedPathBounds(
            graphicsState.currentPath,
            points.map((point) => transformPoint(graphicsState.transform, point)),
          ),
        };
      }
      continue;
    }

    if (operator.operator === "h") {
      if (graphicsState.currentPath) {
        graphicsState = {
          ...graphicsState,
          currentPath: {
            ...graphicsState.currentPath,
            closed: true,
          },
        };
      }
      continue;
    }

    if (operator.operator === "re") {
      const rectangle = readTrailingRectangle(operator);
      if (rectangle) {
        graphicsState = {
          ...graphicsState,
          currentPath: extendObservedPathBounds(
            graphicsState.currentPath,
            rectangleToPoints(rectangle).map((point) => transformPoint(graphicsState.transform, point)),
          ),
        };
      }
      continue;
    }

    if (operator.operator === "W" || operator.operator === "W*") {
      if (graphicsState.currentPath) {
        graphicsState = {
          ...graphicsState,
          pendingClipOperator: operator.operator,
          pendingClipBounds: graphicsState.currentPath,
        };
      }
      continue;
    }

    if (PATH_PAINT_OPERATORS.has(operator.operator as PdfObservedPathMark["paintOperator"])) {
      const currentPath = graphicsState.currentPath;
      const pendingClipBounds = graphicsState.pendingClipBounds;
      const pendingClipOperator = graphicsState.pendingClipOperator;
      const currentMarkedContentId = resolveCurrentMarkedContentId(markedContentStack);
      const currentVisibilityState = resolveEffectiveVisibilityState(markedContentStack);
      if (currentPath) {
        const pathBoundingBox = toObservedBoundingBox(currentPath);
        marks.push({
          id: `mark-path-${pageNumber}-${contentOrder + 1}`,
          kind: "path",
          pageNumber,
          contentOrder,
          contentStreamRef,
          objectRef: contentStreamRef,
          paintOperator: operator.operator as PdfObservedPathMark["paintOperator"],
          pointCount: currentPath.pointCount,
          closed: currentPath.closed || operator.operator === "s" || operator.operator === "b" || operator.operator === "b*",
          ...(currentMarkedContentId !== undefined ? { markedContentId: currentMarkedContentId } : {}),
          ...(pathBoundingBox !== undefined ? { bbox: pathBoundingBox } : {}),
          transform: graphicsState.transform,
          ...(currentVisibilityState !== undefined ? { visibilityState: currentVisibilityState } : {}),
        });
        contentOrder += 1;
      }
      if (pendingClipBounds && pendingClipOperator) {
        const clipBoundingBox = toObservedBoundingBox(pendingClipBounds);
        marks.push({
          id: `mark-clip-${pageNumber}-${contentOrder + 1}`,
          kind: "clip",
          pageNumber,
          contentOrder,
          contentStreamRef,
          objectRef: contentStreamRef,
          clipOperator: pendingClipOperator,
          ...(currentMarkedContentId !== undefined ? { markedContentId: currentMarkedContentId } : {}),
          ...(clipBoundingBox !== undefined ? { bbox: clipBoundingBox } : {}),
          transform: graphicsState.transform,
          ...(currentVisibilityState !== undefined ? { visibilityState: currentVisibilityState } : {}),
        });
        contentOrder += 1;
      }
      graphicsState = {
        ...graphicsState,
        currentPath: undefined,
        pendingClipBounds: undefined,
        pendingClipOperator: undefined,
      };
      continue;
    }

    if (operator.operator === "Do") {
      const resourceName = readTrailingNameOperand(operator);
      if (!resourceName) {
        continue;
      }

      const xObjectBinding = xObjectBindingByResourceName.get(resourceName);
      const currentMarkedContentId = resolveCurrentMarkedContentId(markedContentStack);
      const currentVisibilityState = resolveEffectiveVisibilityState(markedContentStack);
      if (xObjectBinding?.subtypeName === "/Image") {
        const imageBoundingBox = resolveXObjectBoundingBox(graphicsState.transform, xObjectBinding);
        marks.push({
          id: `mark-image-${pageNumber}-${contentOrder + 1}`,
          kind: "image",
          pageNumber,
          contentOrder,
          contentStreamRef,
          objectRef: xObjectBinding.objectRef,
          xObjectRef: xObjectBinding.objectRef,
          resourceName,
          ...(currentMarkedContentId !== undefined ? { markedContentId: currentMarkedContentId } : {}),
          ...(xObjectBinding.width !== undefined ? { width: xObjectBinding.width } : {}),
          ...(xObjectBinding.height !== undefined ? { height: xObjectBinding.height } : {}),
          ...(imageBoundingBox !== undefined ? { bbox: imageBoundingBox } : {}),
          transform: graphicsState.transform,
          ...(currentVisibilityState !== undefined ? { visibilityState: currentVisibilityState } : {}),
        });
        contentOrder += 1;
        continue;
      }

      const xObjectBoundingBox = resolveXObjectBoundingBox(graphicsState.transform, xObjectBinding);
      marks.push({
        id: `mark-xobject-${pageNumber}-${contentOrder + 1}`,
        kind: "xobject",
        pageNumber,
        contentOrder,
        contentStreamRef,
        ...(xObjectBinding?.objectRef !== undefined ? { objectRef: xObjectBinding.objectRef } : { objectRef: contentStreamRef }),
        resourceName,
        ...(currentMarkedContentId !== undefined ? { markedContentId: currentMarkedContentId } : {}),
        ...(xObjectBinding?.objectRef !== undefined ? { xObjectRef: xObjectBinding.objectRef } : {}),
        ...(xObjectBinding?.subtypeName !== undefined ? { subtypeName: xObjectBinding.subtypeName } : {}),
        ...(xObjectBoundingBox !== undefined ? { bbox: xObjectBoundingBox } : {}),
        transform: graphicsState.transform,
        ...(currentVisibilityState !== undefined ? { visibilityState: currentVisibilityState } : {}),
      });
      contentOrder += 1;
    }
  }

  return {
    marks,
    textContexts,
    nextContentOrder: contentOrder,
  };
}

function resolveCurrentMarkedContentId(
  markedContentStack: readonly PdfObservedMarkedContentState[],
): string | undefined {
  return markedContentStack.at(-1)?.markId;
}

function resolveEffectiveVisibilityState(
  markedContentStack: readonly PdfObservedMarkedContentState[],
): PdfVisibilityState | undefined {
  if (markedContentStack.length === 0) {
    return undefined;
  }

  if (markedContentStack.some((markedContent) => markedContent.visibilityState === "hidden")) {
    return "hidden";
  }
  if (markedContentStack.some((markedContent) => markedContent.visibilityState === "unknown")) {
    return "unknown";
  }
  return "visible";
}

function combineVisibilityStates(
  inheritedVisibilityState: PdfVisibilityState | undefined,
  currentVisibilityState: PdfVisibilityState | undefined,
): PdfVisibilityState | undefined {
  if (inheritedVisibilityState === "hidden" || currentVisibilityState === "hidden") {
    return "hidden";
  }
  if (inheritedVisibilityState === "unknown" || currentVisibilityState === "unknown") {
    return "unknown";
  }
  if (currentVisibilityState !== undefined) {
    return currentVisibilityState;
  }
  return inheritedVisibilityState;
}

function readMarkedContentTagName(operator: ParsedContentStreamOperator): string | undefined {
  const nameOperand = operator.operands.find((operand) => operand.kind === "name");
  return nameOperand?.kind === "name" ? nameOperand.token.slice(1) : undefined;
}

function classifyObservedMarkedContent(tagName: string): PdfMarkedContentKind {
  if (tagName === "Artifact") {
    return "artifact";
  }
  if (tagName === "Span") {
    return "span";
  }
  return "other";
}

function readMarkedContentProperties(
  operator: ParsedContentStreamOperator,
  propertyBindingByResourceName: ReadonlyMap<string, PdfPropertyBinding>,
  optionalContentVisibilityConfig: PdfOptionalContentVisibilityConfig | undefined,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): PdfObservedMarkedContentProperties {
  const nameOperands = operator.operands.filter((operand) => operand.kind === "name");
  const propertyOperand = nameOperands.length > 1 ? nameOperands[1] : undefined;
  const propertyName = propertyOperand?.kind === "name" ? propertyOperand.token.slice(1) : undefined;
  const dictionaryOperand = operator.operands.find((operand) => operand.kind === "dictionary");
  const dictionaryEntries = dictionaryOperand?.kind === "dictionary"
    ? parseDictionaryEntries(dictionaryOperand.token)
    : undefined;
  const actualTextToken = dictionaryEntries?.get("ActualText");
  const actualText = actualTextToken !== undefined ? decodeMarkedContentActualText(actualTextToken) : undefined;
  const mcid = readMarkedContentIdentifier(dictionaryEntries?.get("MCID"));
  const propertyBindingRef = propertyName !== undefined ? propertyBindingByResourceName.get(propertyName)?.objectRef : undefined;
  const dictionaryOptionalContentRef = readObjectRefValue(dictionaryEntries?.get("OC"));
  const optionalContentRef = propertyBindingRef ?? dictionaryOptionalContentRef;
  const visibilityState = optionalContentRef !== undefined
    ? resolveOptionalContentVisibilityState(optionalContentRef, optionalContentVisibilityConfig, objectIndex)
    : undefined;

  return {
    ...(propertyName !== undefined ? { propertyName } : {}),
    ...(actualText !== undefined ? { actualText } : {}),
    ...(mcid !== undefined ? { mcid } : {}),
    ...(optionalContentRef !== undefined ? { optionalContentRef } : {}),
    ...(visibilityState !== undefined ? { visibilityState } : {}),
  };
}

function decodeMarkedContentActualText(token: string): string | undefined {
  if (token.startsWith("(") && token.endsWith(")")) {
    return decodePdfLiteral(token);
  }

  if (token.startsWith("<") && token.endsWith(">")) {
    return decodeMarkedContentHexText(token);
  }

  return undefined;
}

function decodeMarkedContentHexText(token: string): string {
  const normalized = token.slice(1, -1).replaceAll(/\s+/g, "");
  const padded = normalized.length % 2 === 0 ? normalized : `${normalized}0`;
  const bytes = new Uint8Array(padded.length / 2);

  for (let index = 0; index < padded.length; index += 2) {
    bytes[index / 2] = Number.parseInt(padded.slice(index, index + 2), 16);
  }

  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeMarkedContentUtf16(bytes.subarray(2), "be");
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeMarkedContentUtf16(bytes.subarray(2), "le");
  }

  return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
}

function decodeMarkedContentUtf16(bytes: Uint8Array, endianness: "be" | "le"): string {
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

function readMarkedContentIdentifier(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function resolveOptionalContentVisibilityConfig(
  inspection: PdfObservationInspection,
): PdfOptionalContentVisibilityConfig | undefined {
  const rootRef = inspection.analysis.trailer?.rootRef;
  const rootObject = rootRef ? inspection.analysis.objectIndex.get(keyOfObjectRef(rootRef)) : undefined;
  const rawOcProperties = rootObject?.dictionaryEntries.get("OCProperties");
  const ocPropertiesDictionary = resolveNestedDictionaryText(rawOcProperties, inspection.analysis.objectIndex);
  if (ocPropertiesDictionary === undefined) {
    return undefined;
  }

  const ocPropertiesEntries = parseDictionaryEntries(ocPropertiesDictionary);
  const defaultConfigDictionary = resolveNestedDictionaryText(ocPropertiesEntries.get("D"), inspection.analysis.objectIndex);
  if (defaultConfigDictionary === undefined) {
    return {
      baseState: "unknown",
      onKeys: new Set<string>(),
      offKeys: new Set<string>(),
    };
  }

  const defaultConfigEntries = parseDictionaryEntries(defaultConfigDictionary);
  const baseStateToken = defaultConfigEntries.get("BaseState")?.trim();
  const baseState = baseStateToken === "/OFF"
    ? "off"
    : baseStateToken === "/Unchanged"
      ? "unknown"
      : "on";

  return {
    baseState,
    onKeys: new Set(readObjectRefsValue(defaultConfigEntries.get("ON")).map((ref) => keyOfObjectRef(ref))),
    offKeys: new Set(readObjectRefsValue(defaultConfigEntries.get("OFF")).map((ref) => keyOfObjectRef(ref))),
  };
}

function resolveOptionalContentVisibilityState(
  optionalContentRef: PdfObjectRef,
  config: PdfOptionalContentVisibilityConfig | undefined,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): PdfVisibilityState {
  if (config === undefined) {
    return "unknown";
  }

  const objectShell = objectIndex.get(keyOfObjectRef(optionalContentRef));
  if (!objectShell) {
    return "unknown";
  }

  if (objectShell.typeName === "OCMD") {
    return resolveOptionalContentMembershipVisibility(optionalContentRef, config, objectIndex, new Set<string>());
  }

  return resolveOptionalContentGroupVisibility(optionalContentRef, config);
}

function resolveOptionalContentMembershipVisibility(
  membershipRef: PdfObjectRef,
  config: PdfOptionalContentVisibilityConfig,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
  visitedKeys: Set<string>,
): PdfVisibilityState {
  const membershipKey = keyOfObjectRef(membershipRef);
  if (visitedKeys.has(membershipKey)) {
    return "unknown";
  }
  visitedKeys.add(membershipKey);
  const membershipObject = objectIndex.get(membershipKey);
  const membershipEntries = membershipObject?.dictionaryEntries;
  const policyToken = membershipEntries?.get("P")?.trim() ?? "/AnyOn";
  const memberRefs = dedupeObjectRefs([
    ...readObjectRefsValue(membershipEntries?.get("OCGs")),
    ...(readObjectRefValue(membershipEntries?.get("OCG")) !== undefined
      ? [readObjectRefValue(membershipEntries?.get("OCG")) as PdfObjectRef]
      : []),
  ]);
  if (memberRefs.length === 0) {
    return "unknown";
  }

  const memberVisibilities = memberRefs.map((memberRef) => {
    const memberObject = objectIndex.get(keyOfObjectRef(memberRef));
    return memberObject?.typeName === "OCMD"
      ? resolveOptionalContentMembershipVisibility(memberRef, config, objectIndex, visitedKeys)
      : resolveOptionalContentGroupVisibility(memberRef, config);
  });

  if (memberVisibilities.some((state) => state === "unknown")) {
    return "unknown";
  }

  if (policyToken === "/AllOn") {
    return memberVisibilities.every((state) => state === "visible") ? "visible" : "hidden";
  }
  if (policyToken === "/AnyOff") {
    return memberVisibilities.some((state) => state === "hidden") ? "visible" : "hidden";
  }
  if (policyToken === "/AllOff") {
    return memberVisibilities.every((state) => state === "hidden") ? "visible" : "hidden";
  }

  return memberVisibilities.some((state) => state === "visible") ? "visible" : "hidden";
}

function resolveOptionalContentGroupVisibility(
  groupRef: PdfObjectRef,
  config: PdfOptionalContentVisibilityConfig,
): PdfVisibilityState {
  const groupKey = keyOfObjectRef(groupRef);
  if (config.onKeys.has(groupKey)) {
    return "visible";
  }
  if (config.offKeys.has(groupKey)) {
    return "hidden";
  }
  if (config.baseState === "on") {
    return "visible";
  }
  if (config.baseState === "off") {
    return "hidden";
  }
  return "unknown";
}

function resolveNestedDictionaryText(
  rawValue: string | undefined,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): string | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (rawValue.startsWith("<<") && rawValue.endsWith(">>")) {
    return rawValue;
  }

  const objectRef = readObjectRefValue(rawValue);
  if (objectRef === undefined) {
    return undefined;
  }

  return findFirstDictionaryToken(objectIndex.get(keyOfObjectRef(objectRef))?.objectValueText ?? "");
}

function dedupeObjectRefs(objectRefs: readonly PdfObjectRef[]): readonly PdfObjectRef[] {
  const seenKeys = new Set<string>();
  const deduped: PdfObjectRef[] = [];

  for (const objectRef of objectRefs) {
    const key = keyOfObjectRef(objectRef);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    deduped.push(objectRef);
  }

  return deduped;
}

function isTextShowOperator(operator: string): boolean {
  return operator === "Tj" || operator === "TJ" || operator === "'" || operator === "\"";
}

function cloneGraphicsState(graphicsState: PdfObservedGraphicsState): PdfObservedGraphicsState {
  return {
    transform: { ...graphicsState.transform },
    currentPath: graphicsState.currentPath !== undefined ? { ...graphicsState.currentPath } : undefined,
    pendingClipOperator: graphicsState.pendingClipOperator,
    pendingClipBounds: graphicsState.pendingClipBounds !== undefined ? { ...graphicsState.pendingClipBounds } : undefined,
  };
}

function readTransformMatrixOperands(operator: ParsedContentStreamOperator): PdfTransformMatrix | undefined {
  const values = readTrailingNumericOperandsFromOperator(operator, 6);
  if (values === undefined) {
    return undefined;
  }

  return {
    a: values[0] ?? 1,
    b: values[1] ?? 0,
    c: values[2] ?? 0,
    d: values[3] ?? 1,
    e: values[4] ?? 0,
    f: values[5] ?? 0,
  };
}

function readTrailingPoint(
  operator: ParsedContentStreamOperator,
  count: number,
): { readonly x: number; readonly y: number } | undefined {
  const points = readTrailingPoints(operator, count);
  return points.at(-1);
}

function readTrailingPoints(
  operator: ParsedContentStreamOperator,
  count: number,
): readonly { readonly x: number; readonly y: number }[] {
  const values = readTrailingNumericOperandsFromOperator(operator, count * 2);
  if (values === undefined) {
    return [];
  }

  const points: Array<{ readonly x: number; readonly y: number }> = [];
  for (let index = 0; index < values.length; index += 2) {
    const x = values[index];
    const y = values[index + 1];
    if (x === undefined || y === undefined) {
      continue;
    }
    points.push({ x, y });
  }
  return points;
}

function readTrailingRectangle(
  operator: ParsedContentStreamOperator,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined {
  const values = readTrailingNumericOperandsFromOperator(operator, 4);
  if (values === undefined) {
    return undefined;
  }

  const [x, y, width, height] = values;
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }

  return { x, y, width, height };
}

function rectangleToPoints(
  rectangle: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): readonly { readonly x: number; readonly y: number }[] {
  return [
    { x: rectangle.x, y: rectangle.y },
    { x: rectangle.x + rectangle.width, y: rectangle.y },
    { x: rectangle.x, y: rectangle.y + rectangle.height },
    { x: rectangle.x + rectangle.width, y: rectangle.y + rectangle.height },
  ];
}

function readTrailingNameOperand(operator: ParsedContentStreamOperator): string | undefined {
  const operand = [...operator.operands].reverse().find((candidate) => candidate.kind === "name");
  return operand?.kind === "name" ? operand.token.slice(1) : undefined;
}

function readTrailingNumericOperandsFromOperator(
  operator: ParsedContentStreamOperator,
  count: number,
): readonly number[] | undefined {
  const numericValues: number[] = [];

  for (let index = operator.operands.length - 1; index >= 0 && numericValues.length < count; index -= 1) {
    const operand = operator.operands[index];
    if (operand?.kind !== "other") {
      continue;
    }
    const value = Number(operand.token);
    if (!Number.isFinite(value)) {
      continue;
    }
    numericValues.push(value);
  }

  return numericValues.length === count ? numericValues.reverse() : undefined;
}

function multiplyTransformMatrices(
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

function transformPoint(
  transform: PdfTransformMatrix,
  point: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  return {
    x: point.x * transform.a + point.y * transform.c + transform.e,
    y: point.x * transform.b + point.y * transform.d + transform.f,
  };
}

function createObservedPathBounds(
  points: readonly { readonly x: number; readonly y: number }[],
): PdfObservedPathBounds | undefined {
  if (points.length === 0) {
    return undefined;
  }

  return extendObservedPathBounds(undefined, points);
}

function extendObservedPathBounds(
  currentBounds: PdfObservedPathBounds | undefined,
  points: readonly { readonly x: number; readonly y: number }[],
): PdfObservedPathBounds | undefined {
  if (points.length === 0) {
    return currentBounds;
  }

  let minX = currentBounds?.minX ?? Number.POSITIVE_INFINITY;
  let minY = currentBounds?.minY ?? Number.POSITIVE_INFINITY;
  let maxX = currentBounds?.maxX ?? Number.NEGATIVE_INFINITY;
  let maxY = currentBounds?.maxY ?? Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return currentBounds;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    pointCount: (currentBounds?.pointCount ?? 0) + points.length,
    closed: currentBounds?.closed ?? false,
  };
}

function toObservedBoundingBox(bounds: PdfObservedPathBounds | undefined) {
  if (!bounds) {
    return undefined;
  }

  return {
    x: bounds.minX,
    y: bounds.minY,
    width: Math.max(0, bounds.maxX - bounds.minX),
    height: Math.max(0, bounds.maxY - bounds.minY),
  };
}

function resolveXObjectBoundingBox(
  transform: PdfTransformMatrix,
  xObjectBinding: PdfXObjectBinding | undefined,
) {
  const width = xObjectBinding?.width;
  const height = xObjectBinding?.height;
  if (width === undefined || height === undefined) {
    return undefined;
  }

  return toObservedBoundingBox(createObservedPathBounds([
    transformPoint(transform, { x: 0, y: 0 }),
    transformPoint(transform, { x: width, y: 0 }),
    transformPoint(transform, { x: 0, y: height }),
    transformPoint(transform, { x: width, y: height }),
  ]));
}

function observeParsedTextRun(
  parsedRun: ParsedTextOperatorRun,
  fontRefByResourceName: ReadonlyMap<string, PdfObjectRef>,
  unicodeCMapByFontKey: Map<string, ReturnType<typeof parsePdfUnicodeCMap>>,
  embeddedFontMappingByFontKey: Map<string, PdfEmbeddedFontMapping | undefined>,
  singleByteFontEncodingByFontKey: Map<string, PdfSingleByteFontEncoding | undefined>,
  inspection: PdfObservationInspection,
): {
  text: string;
  hasFontMappingGap: boolean;
  hasLiteralFontEncodingGap: boolean;
  hasSevereFontMappingGap: boolean;
  hasSevereLiteralFontEncodingGap: boolean;
  fontRef?: PdfObjectRef;
  textEncodingKind?: PdfTextEncodingKind;
  unicodeMappingSource?: PdfUnicodeMappingSource;
  writingMode?: PdfWritingMode;
  anchor?: { readonly x: number; readonly y: number };
  fontSize?: number;
  startsNewLine: boolean;
} {
  let text = "";
  let hasFontMappingGap = false;
  let hasLiteralFontEncodingGap = false;
  let hasSevereFontMappingGap = false;
  let hasSevereLiteralFontEncodingGap = false;
  let textEncodingKind: PdfTextEncodingKind | undefined;
  let unicodeMappingSource: PdfUnicodeMappingSource | undefined;
  let pendingTextAdjustment: number | undefined;
  const fontRef = parsedRun.fontResourceName ? fontRefByResourceName.get(parsedRun.fontResourceName) : undefined;
  const unicodeCMap = fontRef ? resolveUnicodeCMapForFont(fontRef, unicodeCMapByFontKey, inspection) : undefined;
  const cidCollection = fontRef ? resolveCidCollectionForFont(fontRef, inspection) : undefined;
  const embeddedFontMapping = fontRef
    ? resolveEmbeddedFontMappingForFont(fontRef, embeddedFontMappingByFontKey, inspection)
    : undefined;
  const singleByteFontEncoding = fontRef
    ? resolveSingleByteFontEncodingForFont(fontRef, singleByteFontEncodingByFontKey, inspection)
    : undefined;
  const writingMode = fontRef ? resolveWritingModeForFont(fontRef, inspection) : undefined;
  const hasHiddenTextFeature = hasDetectedFeatureFinding(inspection.featureFindings, "hidden-text");
  const fontEncodingSpacingProfile = resolveFontEncodingSpacingProfile(parsedRun);
  const shouldSuppressCompactSpacing = !hasHiddenTextFeature;

  for (const operand of parsedRun.operands) {
    if (operand.kind === "adjustment") {
      pendingTextAdjustment = operand.value;
      continue;
    }

    if (operand.kind === "literal") {
      const rawLiteralText = decodePdfLiteral(operand.token);
      const decodedLiteralText = singleByteFontEncoding
        ? decodePdfSingleByteLiteralText(rawLiteralText, singleByteFontEncoding)
        : undefined;
      const preferredLiteralText = decodedLiteralText && decodedLiteralText.text.length > 0
        ? decodedLiteralText.text
        : rawLiteralText;
      const shouldUseHiddenTextRecovery = hasHiddenTextFeature ||
        parsedRun.markedContentKind !== undefined ||
        parsedRun.actualText !== undefined;

      if (shouldUseHiddenTextRecovery) {
        const sanitizedLiteralText = sanitizeLiteralText(preferredLiteralText);
        const preferredActualText = resolvePreferredActualText(
          parsedRun.actualText,
          sanitizedLiteralText.length > 0 ? sanitizedLiteralText : preferredLiteralText,
        );
        if (preferredActualText !== undefined) {
          text = appendObservedOperandText(text, preferredActualText, pendingTextAdjustment, parsedRun.fontSize);
          pendingTextAdjustment = undefined;
          textEncodingKind = textEncodingKind ?? "literal";
          unicodeMappingSource = unicodeMappingSource ?? "actual-text";
          continue;
        }

        if (sanitizedLiteralText.length > 0 && !looksUnreadableLiteralText(sanitizedLiteralText)) {
          text = appendObservedOperandText(
            text,
            sanitizedLiteralText,
            pendingTextAdjustment,
            parsedRun.fontSize,
            decodedLiteralText ? fontEncodingSpacingProfile : "default",
            shouldSuppressCompactSpacing,
          );
          pendingTextAdjustment = undefined;
          textEncodingKind = textEncodingKind ?? "literal";
          unicodeMappingSource = unicodeMappingSource ?? (decodedLiteralText ? "font-encoding" : "literal");
          const hasMaterialDecodeGap = shouldReportMaterialDecodeGap(decodedLiteralText, parsedRun);
          const shouldReportGap = hasMaterialDecodeGap && !shouldSuppressTrivialDecodeGap(
            fontRef,
            inspection,
            decodedLiteralText,
            sanitizedLiteralText,
          );
          hasLiteralFontEncodingGap = hasLiteralFontEncodingGap || shouldReportGap;
          hasSevereLiteralFontEncodingGap = hasSevereLiteralFontEncodingGap ||
            (shouldReportGap && isSevereMaterialDecodeGap(decodedLiteralText));
          continue;
        }

        if (shouldSuppressUnreadableLiteralText(preferredLiteralText, parsedRun.markedContentKind)) {
          pendingTextAdjustment = undefined;
          textEncodingKind = textEncodingKind ?? "literal";
          const shouldReportGap = parsedRun.markedContentKind !== "artifact" &&
            !shouldSuppressTrivialDecodeGap(fontRef, inspection, decodedLiteralText, preferredLiteralText);
          hasLiteralFontEncodingGap = hasLiteralFontEncodingGap || shouldReportGap;
          hasSevereLiteralFontEncodingGap = hasSevereLiteralFontEncodingGap ||
            shouldReportGap;
          continue;
        }
      }

      text = appendObservedOperandText(
        text,
        preferredLiteralText,
        pendingTextAdjustment,
        parsedRun.fontSize,
        decodedLiteralText ? fontEncodingSpacingProfile : "default",
        shouldSuppressCompactSpacing,
      );
      pendingTextAdjustment = undefined;
      textEncodingKind = textEncodingKind ?? "literal";
      unicodeMappingSource = unicodeMappingSource ?? (decodedLiteralText ? "font-encoding" : "literal");
      const hasMaterialDecodeGap = shouldReportMaterialDecodeGap(decodedLiteralText, parsedRun);
      const shouldReportGap = hasMaterialDecodeGap && !shouldSuppressTrivialDecodeGap(
        fontRef,
        inspection,
        decodedLiteralText,
        preferredLiteralText,
      );
      hasLiteralFontEncodingGap = hasLiteralFontEncodingGap || shouldReportGap;
      hasSevereLiteralFontEncodingGap = hasSevereLiteralFontEncodingGap ||
        (shouldReportGap && isSevereMaterialDecodeGap(decodedLiteralText));
      continue;
    }

    textEncodingKind = textEncodingKind ?? inferHexTextEncodingKind(fontRef, inspection);
    const decodedText = decodeHexTextOperand(
      operand.token,
      textEncodingKind,
      unicodeCMap,
      cidCollection,
      embeddedFontMapping,
      singleByteFontEncoding,
    );
    if (!decodedText) {
      const shouldReportGap = shouldReportTextMappingGap(parsedRun) &&
        (fontRef !== undefined || shouldReportNoFontHexDecodeGap(operand.token));
      hasFontMappingGap = hasFontMappingGap || shouldReportGap;
      hasSevereFontMappingGap = hasSevereFontMappingGap || shouldReportGap;
      continue;
    }

    const hasMaterialDecodeGap = shouldReportMaterialDecodeGap(decodedText, parsedRun);
    if (hasMaterialDecodeGap && !shouldSuppressTrivialDecodeGap(fontRef, inspection, decodedText, decodedText.text)) {
      hasFontMappingGap = true;
      hasSevereFontMappingGap = hasSevereFontMappingGap || isSevereMaterialDecodeGap(decodedText);
    }
    text = appendObservedOperandText(
      text,
      decodedText.text,
      pendingTextAdjustment,
      parsedRun.fontSize,
      decodedText.mappingSource === "font-encoding" ? fontEncodingSpacingProfile : "default",
      shouldSuppressCompactSpacing,
    );
    pendingTextAdjustment = undefined;
    unicodeMappingSource = unicodeMappingSource ?? decodedText.mappingSource;
  }

  const normalizedText = normalizeObservedRunText(text);
  return {
    text: normalizedText,
    hasFontMappingGap,
    hasLiteralFontEncodingGap,
    hasSevereFontMappingGap,
    hasSevereLiteralFontEncodingGap,
    startsNewLine: parsedRun.startsNewLine,
    ...(fontRef !== undefined ? { fontRef } : {}),
    ...(textEncodingKind !== undefined ? { textEncodingKind } : {}),
    ...(unicodeMappingSource !== undefined ? { unicodeMappingSource } : {}),
    ...(writingMode !== undefined ? { writingMode } : {}),
    ...(parsedRun.anchor !== undefined ? { anchor: parsedRun.anchor } : {}),
    ...(parsedRun.fontSize !== undefined ? { fontSize: parsedRun.fontSize } : {}),
  };
}

function appendObservedOperandText(
  currentText: string,
  operandText: string,
  adjustment: number | undefined,
  fontSize: number | undefined,
  spacingProfile: "default" | "font-encoding-compact" | "font-encoding-wide" = "default",
  shouldSuppressCompactWordSplit = true,
): string {
  if (operandText.length === 0) {
    return currentText;
  }

  if (!shouldInsertSyntheticSpace(
    currentText,
    operandText,
    adjustment,
    fontSize,
    spacingProfile,
    shouldSuppressCompactWordSplit,
  )) {
    return `${currentText}${operandText}`;
  }

  return `${currentText} ${operandText}`;
}

function shouldInsertSyntheticSpace(
  currentText: string,
  operandText: string,
  adjustment: number | undefined,
  fontSize: number | undefined,
  spacingProfile: "default" | "font-encoding-compact" | "font-encoding-wide",
  shouldSuppressCompactWordSplit: boolean,
): boolean {
  if (currentText.length === 0 || operandText.length === 0 || adjustment === undefined) {
    return false;
  }

  const currentTail = currentText.trimEnd();
  const operandHead = operandText.trimStart();
  if (currentTail.length === 0 || operandHead.length === 0) {
    return false;
  }

  const currentTailCharacter = currentTail.at(-1);
  const operandHeadCharacter = operandHead[0];
  if (currentTailCharacter === undefined || operandHeadCharacter === undefined) {
    return false;
  }

  if (currentTailCharacter === "-" || currentTailCharacter === "'" || currentTailCharacter === "/" || currentTailCharacter === "(") {
    return false;
  }
  if (operandHeadCharacter === "-" || operandHeadCharacter === "'" || operandHeadCharacter === ")" || operandHeadCharacter === "," || operandHeadCharacter === "." || operandHeadCharacter === ":" || operandHeadCharacter === ";" || operandHeadCharacter === "%" || operandHeadCharacter === "]") {
    return false;
  }

  if (
    shouldSuppressCompactWordSplit &&
    spacingProfile === "font-encoding-compact" &&
    shouldSuppressCompactFontEncodingWordSplit(currentTail, operandHead, fontSize)
  ) {
    return false;
  }

  const spaceThreshold = spacingProfile === "font-encoding-compact"
    ? -Math.max(18, (fontSize ?? 10) * 1.8)
    : spacingProfile === "font-encoding-wide"
    ? -Math.max(100, (fontSize ?? 10) * 8)
    : -Math.max(120, (fontSize ?? 10) * 12);
  if (adjustment > spaceThreshold) {
    return false;
  }

  return /\S$/u.test(currentTail) && /^\S/u.test(operandHead);
}

function resolveFontEncodingSpacingProfile(
  parsedRun: ParsedTextOperatorRun,
): "font-encoding-compact" | "font-encoding-wide" {
  let minimumAdjustment = Number.POSITIVE_INFINITY;
  for (const operand of parsedRun.operands) {
    if (operand.kind === "adjustment") {
      minimumAdjustment = Math.min(minimumAdjustment, operand.value);
    }
  }
  return minimumAdjustment <= -100 ? "font-encoding-wide" : "font-encoding-compact";
}

const COMPACT_FONT_ENCODING_WORD_BOUNDARIES = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
]);

function shouldSuppressCompactFontEncodingWordSplit(
  currentTail: string,
  operandHead: string,
  fontSize: number | undefined,
): boolean {
  if ((fontSize ?? 10) > 4) {
    return false;
  }

  const currentTailWord = currentTail.match(/([\p{L}]+)$/u)?.[1];
  const operandHeadWord = operandHead.match(/^([\p{L}]+)/u)?.[1];
  if (!currentTailWord || !operandHeadWord) {
    return false;
  }

  const currentTailCharacter = currentTailWord.at(-1);
  const operandHeadCharacter = operandHeadWord[0];
  if (!currentTailCharacter || !operandHeadCharacter) {
    return false;
  }

  if (!/\p{Ll}/u.test(currentTailCharacter) || !/\p{Ll}/u.test(operandHeadCharacter)) {
    return false;
  }

  if (
    COMPACT_FONT_ENCODING_WORD_BOUNDARIES.has(currentTailWord.toLowerCase()) ||
    COMPACT_FONT_ENCODING_WORD_BOUNDARIES.has(operandHeadWord.toLowerCase())
  ) {
    return false;
  }

  return currentTailWord.length <= 3 || operandHeadWord.length <= 3;
}

function resolvePreferredActualText(actualText: string | undefined, observedText: string): string | undefined {
  if (actualText === undefined) {
    return undefined;
  }

  const normalizedActualText = actualText
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(/[^\S\n]+/g, " ")
    .trim();
  if (normalizedActualText.length === 0) {
    return undefined;
  }

  if (looksUnreadableLiteralText(observedText) || normalizedActualText.length >= observedText.trim().length) {
    return normalizedActualText;
  }

  return undefined;
}

function sanitizeLiteralText(text: string): string {
  return text
    .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/gu, "")
    .replaceAll(/[\t\r\n]+/g, " ")
    .replaceAll(/[ ]{2,}/g, " ")
    .trim();
}

function shouldSuppressUnreadableLiteralText(
  text: string,
  markedContentKind: "artifact" | "span" | "other" | undefined,
): boolean {
  void markedContentKind;
  return looksUnreadableLiteralText(text);
}

function looksUnreadableLiteralText(text: string): boolean {
  if (text.length === 0) {
    return false;
  }

  const characters = Array.from(text);
  const controlCharacterCount = characters.filter((character) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(character)).length;
  if (controlCharacterCount === 0) {
    return false;
  }

  const letterOrDigitCount = characters.filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  if (letterOrDigitCount === 0) {
    return true;
  }

  return controlCharacterCount / characters.length > 0.25 && letterOrDigitCount / characters.length < 0.3;
}

function normalizeObservedRunText(text: string): string {
  return text
    .replaceAll(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replaceAll(/[ ]{2,}/g, " ")
    .trim();
}

function shouldReportTextMappingGap(parsedRun: ParsedTextOperatorRun): boolean {
  return parsedRun.markedContentKind !== "artifact";
}

function shouldReportMaterialDecodeGap(
  decodedText:
    | {
      readonly complete: boolean;
      readonly sourceUnitCount: number;
      readonly mappedUnitCount: number;
    }
    | undefined,
  parsedRun: ParsedTextOperatorRun,
): boolean {
  if (!decodedText || decodedText.complete || !shouldReportTextMappingGap(parsedRun)) {
    return false;
  }

  if (decodedText.mappedUnitCount === 0 || decodedText.sourceUnitCount === 0) {
    return true;
  }

  const missingUnitCount = decodedText.sourceUnitCount - decodedText.mappedUnitCount;
  if (missingUnitCount <= 0) {
    return false;
  }

  if (missingUnitCount === 1 && decodedText.mappedUnitCount >= 8) {
    return false;
  }

  if (missingUnitCount <= 2 && decodedText.mappedUnitCount >= 24) {
    return false;
  }

  if (decodedText.mappedUnitCount < 4) {
    return true;
  }

  return decodedText.mappedUnitCount / decodedText.sourceUnitCount < 0.9;
}

function isSevereMaterialDecodeGap(
  decodedText:
    | {
      readonly sourceUnitCount: number;
      readonly mappedUnitCount: number;
    }
    | undefined,
): boolean {
  if (!decodedText || decodedText.mappedUnitCount === 0 || decodedText.sourceUnitCount === 0) {
    return true;
  }

  const missingUnitCount = decodedText.sourceUnitCount - decodedText.mappedUnitCount;
  if (missingUnitCount <= 0) {
    return false;
  }

  if (missingUnitCount >= 2 && decodedText.mappedUnitCount < 8) {
    return true;
  }

  return decodedText.mappedUnitCount / decodedText.sourceUnitCount < 0.7;
}

function shouldSuppressTrivialDecodeGap(
  fontRef: PdfObjectRef | undefined,
  inspection: PdfObservationInspection,
  decodedText?:
    | {
      readonly sourceUnitCount: number;
      readonly mappedUnitCount: number;
    },
  previewText?: string,
): boolean {
  const normalizedPreview = normalizeObservedRunText(previewText ?? "");

  if (!decodedText) {
    return isSymbolLikeFont(fontRef, inspection) && !hasLetterOrDigit(normalizedPreview);
  }

  if (decodedText.sourceUnitCount === 1 && decodedText.mappedUnitCount === 0 && normalizedPreview.length === 0) {
    return true;
  }

  if (!isSymbolLikeFont(fontRef, inspection)) {
    return false;
  }

  if (decodedText.sourceUnitCount > 8 || hasLetterOrDigit(normalizedPreview)) {
    return false;
  }

  return true;
}

function shouldReportNoFontHexDecodeGap(token: string): boolean {
  const normalizedHex = normalizeHexOperandToken(token);
  if (normalizedHex.length === 0) {
    return false;
  }

  if (normalizedHex.length % 4 === 0) {
    return false;
  }

  return looksPrintableNoFontByteText(readHexOperandBytes(normalizedHex));
}

function normalizeHexOperandToken(token: string): string {
  const normalized = token
    .slice(1, -1)
    .replaceAll(/\s+/g, "");

  return normalized.length % 2 === 0 ? normalized : `${normalized}0`;
}

function readHexOperandBytes(normalizedHex: string): Uint8Array {
  const bytes = new Uint8Array(normalizedHex.length / 2);

  for (let index = 0; index < normalizedHex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalizedHex.slice(index, index + 2), 16);
  }

  return bytes;
}

function looksPrintableNoFontByteText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) {
    return false;
  }

  let printableByteCount = 0;
  let hasLetterOrDigitByte = false;

  for (const value of bytes) {
    const isPrintableWhitespace = value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20;
    const isPrintableAscii = value >= 0x21 && value <= 0x7e;
    if (isPrintableWhitespace || isPrintableAscii) {
      printableByteCount += 1;
    }
    if ((value >= 0x30 && value <= 0x39) || (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a)) {
      hasLetterOrDigitByte = true;
    }
  }

  return hasLetterOrDigitByte && printableByteCount / bytes.byteLength >= 0.6;
}

function isSymbolLikeFont(
  fontRef: PdfObjectRef | undefined,
  inspection: PdfObservationInspection,
): boolean {
  if (!fontRef) {
    return false;
  }

  const fontObject = inspection.analysis.objectIndex.get(keyOfObjectRef(fontRef));
  const fontNameText = [
    fontObject?.dictionaryEntries.get("BaseFont") ?? "",
    fontObject?.dictionaryEntries.get("Subtype") ?? "",
  ].join(" ").toLowerCase();

  return fontNameText.includes("math") ||
    fontNameText.includes("symbol") ||
    fontNameText.includes("dingbat") ||
    fontNameText.includes("txsy") ||
    fontNameText.includes("txex") ||
    fontNameText.includes("txmi");
}

function hasLetterOrDigit(value: string): boolean {
  return /[\p{Letter}\p{Number}]/u.test(value);
}

function decodeHexTextOperand(
  hexToken: string,
  textEncodingKind: PdfTextEncodingKind,
  unicodeCMap: ReturnType<typeof parsePdfUnicodeCMap> | undefined,
  cidCollection: PdfCidCollectionIdentifier | undefined,
  embeddedFontMapping: PdfEmbeddedFontMapping | undefined,
  singleByteFontEncoding: PdfSingleByteFontEncoding | undefined,
): PdfTextDecodeResult | undefined {
  if (unicodeCMap) {
    const decodedText = decodePdfHexTextWithUnicodeCMap(hexToken, unicodeCMap);
    return {
      text: decodedText.text,
      complete: decodedText.complete,
      mappingSource: "tounicode-cmap",
      sourceUnitCount: decodedText.sourceUnitCount,
      mappedUnitCount: decodedText.mappedUnitCount,
    };
  }

  if (textEncodingKind !== "cid") {
    if (!singleByteFontEncoding) {
      return undefined;
    }

    const decodedText = decodePdfSingleByteHexText(hexToken, singleByteFontEncoding);
    return {
      text: decodedText.text,
      complete: decodedText.complete,
      mappingSource: "font-encoding",
      sourceUnitCount: decodedText.sourceUnitCount,
      mappedUnitCount: decodedText.mappedUnitCount,
    };
  }

  const collectionDecodedText = decodePdfCidHexTextWithKnownCollectionMap(hexToken, cidCollection);
  if (collectionDecodedText) {
    return {
      text: collectionDecodedText.text,
      complete: collectionDecodedText.complete,
      mappingSource: "cid-collection-ucs2",
      sourceUnitCount: collectionDecodedText.sourceUnitCount,
      mappedUnitCount: collectionDecodedText.mappedUnitCount,
    };
  }

  if (!embeddedFontMapping) {
    return undefined;
  }

  return decodePdfCidHexTextWithEmbeddedFont(hexToken, embeddedFontMapping);
}

function resolveSingleByteFontEncodingForFont(
  fontRef: PdfObjectRef,
  singleByteFontEncodingByFontKey: Map<string, PdfSingleByteFontEncoding | undefined>,
  inspection: PdfObservationInspection,
): PdfSingleByteFontEncoding | undefined {
  const fontKey = keyOfObjectRef(fontRef);
  if (singleByteFontEncodingByFontKey.has(fontKey)) {
    return singleByteFontEncodingByFontKey.get(fontKey);
  }

  const fontObject = inspection.analysis.objectIndex.get(fontKey);
  const subtype = fontObject?.dictionaryEntries.get("Subtype")?.trim();
  if (!fontObject || subtype === "/Type0" || fontObject.dictionaryEntries.has("DescendantFonts")) {
    singleByteFontEncodingByFontKey.set(fontKey, undefined);
    return undefined;
  }

  const encodingValue = resolveFontEncodingValue(fontObject.dictionaryEntries.get("Encoding"), inspection);
  const baseEncodingName = readBaseEncodingName(encodingValue) ?? inferDefaultBaseEncodingName(subtype);
  const differencesText = readDifferencesArrayText(encodingValue);
  const singleByteFontEncoding = buildPdfSingleByteFontEncoding({
    ...(baseEncodingName !== undefined ? { baseEncodingName } : {}),
    ...(differencesText !== undefined ? { differencesText } : {}),
  });
  singleByteFontEncodingByFontKey.set(fontKey, singleByteFontEncoding);
  return singleByteFontEncoding;
}

function resolveUnicodeCMapForFont(
  fontRef: PdfObjectRef,
  unicodeCMapByFontKey: Map<string, ReturnType<typeof parsePdfUnicodeCMap>>,
  inspection: PdfObservationInspection,
) {
  const fontKey = keyOfObjectRef(fontRef);
  if (unicodeCMapByFontKey.has(fontKey)) {
    return unicodeCMapByFontKey.get(fontKey);
  }

  const fontObject = inspection.analysis.objectIndex.get(fontKey);
  const toUnicodeRef = fontObject ? readOptionalObjectRef(fontObject.dictionaryEntries.get("ToUnicode")) : undefined;
  const unicodeStreamText = toUnicodeRef
    ? inspection.analysis.objectIndex.get(keyOfObjectRef(toUnicodeRef))?.streamText
    : undefined;
  const unicodeCMap = typeof unicodeStreamText === "string" ? parsePdfUnicodeCMap(unicodeStreamText) : undefined;
  unicodeCMapByFontKey.set(fontKey, unicodeCMap);
  return unicodeCMap;
}

function resolveEmbeddedFontMappingForFont(
  fontRef: PdfObjectRef,
  embeddedFontMappingByFontKey: Map<string, PdfEmbeddedFontMapping | undefined>,
  inspection: PdfObservationInspection,
): PdfEmbeddedFontMapping | undefined {
  const fontKey = keyOfObjectRef(fontRef);
  if (embeddedFontMappingByFontKey.has(fontKey)) {
    return embeddedFontMappingByFontKey.get(fontKey);
  }

  const descendantFontObject = resolveDescendantFontObject(fontRef, inspection);
  const fontDescriptorRef = descendantFontObject
    ? readOptionalObjectRef(descendantFontObject.dictionaryEntries.get("FontDescriptor"))
    : undefined;
  const fontDescriptorObject = fontDescriptorRef
    ? inspection.analysis.objectIndex.get(keyOfObjectRef(fontDescriptorRef))
    : undefined;
  const fontFileRef = fontDescriptorObject
    ? readOptionalObjectRef(fontDescriptorObject.dictionaryEntries.get("FontFile2"))
    : undefined;
  const fontFileObject = fontFileRef
    ? inspection.analysis.objectIndex.get(keyOfObjectRef(fontFileRef))
    : undefined;
  const glyphUnicodeByGlyphId = fontFileObject?.decodedStreamBytes
    ? parseTrueTypeGlyphUnicodeMap(fontFileObject.decodedStreamBytes)
    : undefined;

  if (!glyphUnicodeByGlyphId || glyphUnicodeByGlyphId.size === 0) {
    embeddedFontMappingByFontKey.set(fontKey, undefined);
    return undefined;
  }

  const cidToGidByCid = descendantFontObject
    ? resolveCidToGidMap(descendantFontObject.dictionaryEntries.get("CIDToGIDMap"), inspection)
    : undefined;
  const requiresExplicitCidToGidMap = hasExplicitCidToGidMap(descendantFontObject?.dictionaryEntries.get("CIDToGIDMap"));

  const mapping: PdfEmbeddedFontMapping = {
    glyphUnicodeByGlyphId,
    requiresExplicitCidToGidMap,
    ...(cidToGidByCid !== undefined ? { cidToGidByCid } : {}),
  };
  embeddedFontMappingByFontKey.set(fontKey, mapping);
  return mapping;
}

function inferHexTextEncodingKind(
  fontRef: PdfObjectRef | undefined,
  inspection: PdfObservationInspection,
): PdfTextEncodingKind {
  if (fontRef === undefined) {
    return "hex";
  }

  const fontObject = inspection.analysis.objectIndex.get(keyOfObjectRef(fontRef));
  const encodingValue = fontObject?.dictionaryEntries.get("Encoding")?.trim();
  if (
    fontObject?.dictionaryEntries.has("DescendantFonts") ||
    fontObject?.dictionaryEntries.get("Subtype")?.trim() === "/Type0" ||
    encodingValue === "/Identity-H" ||
    encodingValue === "/Identity-V"
  ) {
    return "cid";
  }

  return "hex";
}

function resolveWritingModeForFont(
  fontRef: PdfObjectRef,
  inspection: PdfObservationInspection,
): PdfWritingMode | undefined {
  const fontObject = inspection.analysis.objectIndex.get(keyOfObjectRef(fontRef));
  const encodingValue = fontObject?.dictionaryEntries.get("Encoding")?.trim();
  if (encodingValue === "/Identity-V") {
    return "vertical";
  }

  const descendantFontObject = resolveDescendantFontObject(fontRef, inspection);
  const descendantEncodingValue = descendantFontObject?.dictionaryEntries.get("Encoding")?.trim();
  if (descendantEncodingValue === "/Identity-V") {
    return "vertical";
  }

  return undefined;
}

function inferObservedPageWritingMode(
  runs: readonly PdfObservedTextRun[],
): PdfWritingMode | undefined {
  if (runs.some((run) => run.writingMode === "vertical")) {
    return "vertical";
  }

  const anchoredRuns = runs.filter((run) => run.anchor !== undefined);
  if (anchoredRuns.length < 3 || !anchoredRuns.every((run) => run.startsNewLine === true)) {
    return undefined;
  }

  const averageTextLength = anchoredRuns.reduce((sum, run) => sum + run.text.length, 0) / anchoredRuns.length;
  if (averageTextLength > 20) {
    return undefined;
  }

  let horizontalTransitions = 0;
  let verticalTransitions = 0;

  for (let index = 1; index < anchoredRuns.length; index += 1) {
    const previousRun = anchoredRuns[index - 1] as PdfObservedTextRun;
    const currentRun = anchoredRuns[index] as PdfObservedTextRun;
    const previousAnchor = previousRun.anchor;
    const currentAnchor = currentRun.anchor;
    if (!previousAnchor || !currentAnchor) {
      continue;
    }

    const fontSize = currentRun.fontSize ?? previousRun.fontSize ?? 12;
    const deltaX = Math.abs(currentAnchor.x - previousAnchor.x);
    const deltaY = Math.abs(currentAnchor.y - previousAnchor.y);
    const lateralThreshold = Math.max(10, fontSize * 1.2);
    const stackThreshold = Math.max(16, fontSize * 1.4);

    if (deltaX >= lateralThreshold && deltaY <= stackThreshold) {
      horizontalTransitions += 1;
      continue;
    }

    if (deltaY >= lateralThreshold && deltaX <= stackThreshold) {
      verticalTransitions += 1;
    }
  }

  return horizontalTransitions >= 2 && horizontalTransitions > verticalTransitions ? "vertical" : undefined;
}

function resolveCidCollectionForFont(
  fontRef: PdfObjectRef,
  inspection: PdfObservationInspection,
): PdfCidCollectionIdentifier | undefined {
  const descendantFontObject = resolveDescendantFontObject(fontRef, inspection);
  const cidSystemInfoValue = descendantFontObject?.dictionaryEntries.get("CIDSystemInfo");
  if (!cidSystemInfoValue) {
    return undefined;
  }

  const registryMatch = cidSystemInfoValue.match(/\/Registry\s*\(([^)]+)\)/);
  const orderingMatch = cidSystemInfoValue.match(/\/Ordering\s*\(([^)]+)\)/);
  const registry = registryMatch?.[1];
  const ordering = orderingMatch?.[1];
  if (!registry || !ordering) {
    return undefined;
  }

  return {
    registry,
    ordering,
  };
}

function resolveDescendantFontObject(
  fontRef: PdfObjectRef,
  inspection: PdfObservationInspection,
) {
  const fontObject = inspection.analysis.objectIndex.get(keyOfObjectRef(fontRef));
  if (!fontObject) {
    return undefined;
  }

  if (fontObject.dictionaryEntries.get("Subtype")?.trim() === "/CIDFontType2") {
    return fontObject;
  }

  const descendantFontRefs = readOptionalObjectRefs(fontObject.dictionaryEntries.get("DescendantFonts"));
  const descendantFontRef = descendantFontRefs[0];
  return descendantFontRef ? inspection.analysis.objectIndex.get(keyOfObjectRef(descendantFontRef)) : fontObject;
}

function resolveFontEncodingValue(
  value: string | undefined,
  inspection: PdfObservationInspection,
): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.startsWith("<<") && trimmedValue.endsWith(">>")) {
    return trimmedValue;
  }

  if (trimmedValue.startsWith("/")) {
    return trimmedValue;
  }

  const objectRef = readOptionalObjectRef(trimmedValue);
  if (!objectRef) {
    return undefined;
  }

  return inspection.analysis.objectIndex.get(keyOfObjectRef(objectRef))?.objectValueText?.trim();
}

function readBaseEncodingName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.startsWith("/") && trimmedValue.length > 1) {
    return trimmedValue.slice(1);
  }

  const baseEncodingMatch = trimmedValue.match(/\/BaseEncoding\s*\/([A-Za-z0-9_.-]+)/u);
  return baseEncodingMatch?.[1];
}

function readDifferencesArrayText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const differencesMatch = value.match(/\/Differences\s*(\[[\s\S]*\])/u);
  return differencesMatch?.[1];
}

function inferDefaultBaseEncodingName(subtype: string | undefined): string | undefined {
  if (subtype === "/Type1" || subtype === "/TrueType") {
    return "StandardEncoding";
  }

  return undefined;
}

function resolveCidToGidMap(
  value: string | undefined,
  inspection: PdfObservationInspection,
): ReadonlyMap<number, number> | undefined {
  if (!value) {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue === "/Identity") {
    return undefined;
  }

  const objectRef = readOptionalObjectRef(trimmedValue);
  if (!objectRef) {
    return undefined;
  }

  const objectShell = inspection.analysis.objectIndex.get(keyOfObjectRef(objectRef));
  return objectShell?.decodedStreamBytes ? parseCidToGidMap(objectShell.decodedStreamBytes) : undefined;
}

function hasExplicitCidToGidMap(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 && trimmedValue !== "/Identity";
}

function parseCidToGidMap(decodedStreamBytes: Uint8Array): ReadonlyMap<number, number> | undefined {
  if (decodedStreamBytes.byteLength < 2) {
    return undefined;
  }

  const cidToGidByCid = new Map<number, number>();
  const pairCount = Math.floor(decodedStreamBytes.byteLength / 2);
  for (let cid = 0; cid < pairCount; cid += 1) {
    const offset = cid * 2;
    const highByte = decodedStreamBytes[offset];
    const lowByte = decodedStreamBytes[offset + 1];
    if (highByte === undefined || lowByte === undefined) {
      continue;
    }

    const glyphId = (highByte << 8) | lowByte;
    cidToGidByCid.set(cid, glyphId);
  }

  return cidToGidByCid;
}

function decodePdfCidHexTextWithEmbeddedFont(
  hexToken: string,
  embeddedFontMapping: PdfEmbeddedFontMapping,
): PdfTextDecodeResult {
  const normalizedHex = normalizePdfHexToken(hexToken);
  if (normalizedHex.length === 0 || normalizedHex.length % 4 !== 0) {
    return {
      text: "",
      complete: false,
      mappingSource: "embedded-font-cmap",
      sourceUnitCount: 0,
      mappedUnitCount: 0,
    };
  }

  let text = "";
  let complete = true;
  let sourceUnitCount = 0;
  let mappedUnitCount = 0;

  for (let offset = 0; offset < normalizedHex.length; offset += 4) {
    sourceUnitCount += 1;
    const cid = Number.parseInt(normalizedHex.slice(offset, offset + 4), 16);
    const glyphId = resolveGlyphIdForCid(cid, embeddedFontMapping);
    const glyphText = glyphId === undefined ? undefined : embeddedFontMapping.glyphUnicodeByGlyphId.get(glyphId);
    if (glyphText === undefined) {
      complete = false;
      continue;
    }
    text += glyphText;
    mappedUnitCount += 1;
  }

  return {
    text,
    complete,
    mappingSource: "embedded-font-cmap",
    sourceUnitCount,
    mappedUnitCount,
  };
}

function resolveGlyphIdForCid(
  cid: number,
  embeddedFontMapping: PdfEmbeddedFontMapping,
): number | undefined {
  if (embeddedFontMapping.cidToGidByCid) {
    return embeddedFontMapping.cidToGidByCid.get(cid);
  }

  if (embeddedFontMapping.requiresExplicitCidToGidMap) {
    return undefined;
  }

  return cid;
}

function normalizePdfHexToken(value: string): string {
  const trimmedValue = value.trim();
  const bracketlessValue = trimmedValue.startsWith("<") && trimmedValue.endsWith(">")
    ? trimmedValue.slice(1, -1)
    : trimmedValue;
  const normalizedHex = bracketlessValue.replaceAll(/\s+/g, "");
  return normalizedHex.length % 2 === 0 ? normalizedHex : `${normalizedHex}0`;
}

function readOptionalObjectRef(value: string | undefined): PdfObjectRef | undefined {
  if (!value) {
    return undefined;
  }

  const trimmedValue = value.trim();
  const match = trimmedValue.match(/^(\d+)\s+(\d+)\s+R$/);
  if (!match) {
    return undefined;
  }

  return {
    objectNumber: Number(match[1]),
    generationNumber: Number(match[2]),
  };
}

function readOptionalObjectRefs(value: string | undefined): readonly PdfObjectRef[] {
  if (!value) {
    return [];
  }

  return Array.from(value.matchAll(/(\d+)\s+(\d+)\s+R/g), (match) => ({
    objectNumber: Number(match[1]),
    generationNumber: Number(match[2]),
  }));
}
