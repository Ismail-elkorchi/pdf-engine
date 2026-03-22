import type {
  PdfDisplayCommand,
  PdfDisplayList,
  PdfObservedMark,
  PdfObservedDocument,
  PdfRenderHash,
  PdfRenderDocument,
  PdfRenderPage,
} from "./contracts.ts";

export async function buildRenderDocument(observation: PdfObservedDocument): Promise<PdfRenderDocument> {
  const pages = await Promise.all(
    observation.pages.map((page) => buildRenderPage(page.pageNumber, page.resolutionMethod, page.pageRef, page.marks)),
  );
  const renderHash = await buildRenderHash({
    strategy: "observed-display-list",
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      resolutionMethod: page.resolutionMethod,
      ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
      renderHash: page.renderHash,
      displayList: page.displayList,
    })),
  });

  return {
    kind: "pdf-render",
    strategy: "observed-display-list",
    pages,
    renderHash,
    knownLimits: dedupeKnownLimits([
      ...observation.knownLimits,
      "render-display-list-only",
      "render-raster-not-implemented",
    ]),
  };
}

async function buildRenderPage(
  pageNumber: number,
  resolutionMethod: PdfRenderPage["resolutionMethod"],
  pageRef: PdfRenderPage["pageRef"],
  marks: readonly PdfObservedMark[],
): Promise<PdfRenderPage> {
  const displayList: PdfDisplayList = {
    commands: marks.map((mark) => toDisplayCommand(mark)),
  };
  const renderHash = await buildRenderHash({
    pageNumber,
    resolutionMethod,
    ...(pageRef !== undefined ? { pageRef } : {}),
    displayList,
  });

  return {
    pageNumber,
    resolutionMethod,
    ...(pageRef !== undefined ? { pageRef } : {}),
    displayList,
    renderHash,
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
        paintState: mark.paintState,
        colorState: mark.colorState,
        transparencyState: mark.transparencyState,
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
        ...(mark.transparencyGroup !== undefined ? { transparencyGroup: mark.transparencyGroup } : {}),
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

async function buildRenderHash(value: unknown): Promise<PdfRenderHash> {
  const json = canonicalizeJson(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

  return {
    algorithm: "sha-256",
    hex,
  };
}

function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) =>
      left.localeCompare(right)
    );

    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeJson(entry)}`).join(",")}}`;
  }

  throw new Error(`Render hashing does not support values of type ${typeof value}.`);
}
