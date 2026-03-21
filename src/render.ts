import type {
  PdfDisplayCommand,
  PdfDisplayList,
  PdfObservedMark,
  PdfObservedDocument,
  PdfRenderDocument,
  PdfRenderPage,
} from "./contracts.ts";

export function buildRenderDocument(observation: PdfObservedDocument): PdfRenderDocument {
  const pages = observation.pages.map((page) => buildRenderPage(page.pageNumber, page.resolutionMethod, page.pageRef, page.marks));

  return {
    kind: "pdf-render",
    strategy: "observed-display-list",
    pages,
    knownLimits: dedupeKnownLimits([
      ...observation.knownLimits,
      "render-display-list-only",
      "render-raster-not-implemented",
    ]),
  };
}

function buildRenderPage(
  pageNumber: number,
  resolutionMethod: PdfRenderPage["resolutionMethod"],
  pageRef: PdfRenderPage["pageRef"],
  marks: readonly PdfObservedMark[],
): PdfRenderPage {
  const displayList: PdfDisplayList = {
    commands: marks.map((mark) => toDisplayCommand(mark)),
  };

  return {
    pageNumber,
    resolutionMethod,
    ...(pageRef !== undefined ? { pageRef } : {}),
    displayList,
  };
}

function toDisplayCommand(mark: PdfObservedMark): PdfDisplayCommand {
  switch (mark.kind) {
    case "text":
      return {
        id: mark.id,
        kind: "text",
        contentOrder: mark.contentOrder,
        runId: mark.runId,
        glyphIds: mark.glyphIds,
        text: mark.text,
        origin: mark.origin,
        ...(mark.objectRef !== undefined ? { objectRef: mark.objectRef } : {}),
        ...(mark.markedContentId !== undefined ? { markedContentId: mark.markedContentId } : {}),
        ...(mark.bbox !== undefined ? { bbox: mark.bbox } : {}),
        ...(mark.transform !== undefined ? { transform: mark.transform } : {}),
        ...(mark.visibilityState !== undefined ? { visibilityState: mark.visibilityState } : {}),
        ...(mark.fontRef !== undefined ? { fontRef: mark.fontRef } : {}),
        ...(mark.textEncodingKind !== undefined ? { textEncodingKind: mark.textEncodingKind } : {}),
        ...(mark.unicodeMappingSource !== undefined ? { unicodeMappingSource: mark.unicodeMappingSource } : {}),
        ...(mark.writingMode !== undefined ? { writingMode: mark.writingMode } : {}),
        ...(mark.markedContentKind !== undefined ? { markedContentKind: mark.markedContentKind } : {}),
        ...(mark.actualText !== undefined ? { actualText: mark.actualText } : {}),
        ...(mark.anchor !== undefined ? { anchor: mark.anchor } : {}),
        ...(mark.fontSize !== undefined ? { fontSize: mark.fontSize } : {}),
        ...(mark.startsNewLine ? { startsNewLine: true } : {}),
        ...(mark.hiddenTextCandidate ? { hiddenTextCandidate: true } : {}),
        ...(mark.duplicateLayerCandidate ? { duplicateLayerCandidate: true } : {}),
      };
    case "path":
      return {
        id: mark.id,
        kind: "path",
        contentOrder: mark.contentOrder,
        paintOperator: mark.paintOperator,
        pointCount: mark.pointCount,
        closed: mark.closed,
        ...(mark.objectRef !== undefined ? { objectRef: mark.objectRef } : {}),
        ...(mark.markedContentId !== undefined ? { markedContentId: mark.markedContentId } : {}),
        ...(mark.bbox !== undefined ? { bbox: mark.bbox } : {}),
        ...(mark.transform !== undefined ? { transform: mark.transform } : {}),
        ...(mark.visibilityState !== undefined ? { visibilityState: mark.visibilityState } : {}),
      };
    case "image":
      return {
        id: mark.id,
        kind: "image",
        contentOrder: mark.contentOrder,
        resourceName: mark.resourceName,
        ...(mark.objectRef !== undefined ? { objectRef: mark.objectRef } : {}),
        ...(mark.markedContentId !== undefined ? { markedContentId: mark.markedContentId } : {}),
        ...(mark.bbox !== undefined ? { bbox: mark.bbox } : {}),
        ...(mark.transform !== undefined ? { transform: mark.transform } : {}),
        ...(mark.visibilityState !== undefined ? { visibilityState: mark.visibilityState } : {}),
        ...(mark.xObjectRef !== undefined ? { xObjectRef: mark.xObjectRef } : {}),
        ...(mark.width !== undefined ? { width: mark.width } : {}),
        ...(mark.height !== undefined ? { height: mark.height } : {}),
      };
    case "xobject":
      return {
        id: mark.id,
        kind: "xobject",
        contentOrder: mark.contentOrder,
        resourceName: mark.resourceName,
        ...(mark.objectRef !== undefined ? { objectRef: mark.objectRef } : {}),
        ...(mark.markedContentId !== undefined ? { markedContentId: mark.markedContentId } : {}),
        ...(mark.bbox !== undefined ? { bbox: mark.bbox } : {}),
        ...(mark.transform !== undefined ? { transform: mark.transform } : {}),
        ...(mark.visibilityState !== undefined ? { visibilityState: mark.visibilityState } : {}),
        ...(mark.xObjectRef !== undefined ? { xObjectRef: mark.xObjectRef } : {}),
        ...(mark.subtypeName !== undefined ? { subtypeName: mark.subtypeName } : {}),
      };
    case "clip":
      return {
        id: mark.id,
        kind: "clip",
        contentOrder: mark.contentOrder,
        clipOperator: mark.clipOperator,
        ...(mark.objectRef !== undefined ? { objectRef: mark.objectRef } : {}),
        ...(mark.markedContentId !== undefined ? { markedContentId: mark.markedContentId } : {}),
        ...(mark.bbox !== undefined ? { bbox: mark.bbox } : {}),
        ...(mark.transform !== undefined ? { transform: mark.transform } : {}),
        ...(mark.visibilityState !== undefined ? { visibilityState: mark.visibilityState } : {}),
      };
    case "marked-content":
      return {
        id: mark.id,
        kind: "marked-content",
        contentOrder: mark.contentOrder,
        tagName: mark.tagName,
        markedContentKind: mark.markedContentKind,
        depth: mark.depth,
        ...(mark.objectRef !== undefined ? { objectRef: mark.objectRef } : {}),
        ...(mark.markedContentId !== undefined ? { markedContentId: mark.markedContentId } : {}),
        ...(mark.bbox !== undefined ? { bbox: mark.bbox } : {}),
        ...(mark.transform !== undefined ? { transform: mark.transform } : {}),
        ...(mark.visibilityState !== undefined ? { visibilityState: mark.visibilityState } : {}),
        ...(mark.propertyName !== undefined ? { propertyName: mark.propertyName } : {}),
        ...(mark.optionalContentRef !== undefined ? { optionalContentRef: mark.optionalContentRef } : {}),
        ...(mark.mcid !== undefined ? { mcid: mark.mcid } : {}),
        ...(mark.actualText !== undefined ? { actualText: mark.actualText } : {}),
        ...(mark.closedContentOrder !== undefined ? { closedContentOrder: mark.closedContentOrder } : {}),
      };
  }
}

function dedupeKnownLimits(knownLimits: readonly PdfRenderDocument["knownLimits"][number][]): readonly PdfRenderDocument["knownLimits"][number][] {
  return [...new Set(knownLimits)];
}
