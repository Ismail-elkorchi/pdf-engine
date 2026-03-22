import type {
  PdfDisplayCommand,
  PdfDisplayList,
  PdfObservedMark,
  PdfObservedDocument,
  PdfRenderHash,
  PdfRenderDocument,
  PdfRenderPage,
  PdfRenderSelectionModel,
  PdfRenderSelectionUnit,
  PdfRenderTextIndex,
  PdfRenderTextSpan,
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
      displayList: page.displayList,
      textIndex: page.textIndex,
      selectionModel: page.selectionModel,
      renderHash: page.renderHash,
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
  const textIndex = buildRenderTextIndex(pageNumber, displayList.commands);
  const selectionModel = buildRenderSelectionModel(pageNumber, textIndex);
  const renderHash = await buildRenderHash({
    pageNumber,
    resolutionMethod,
    ...(pageRef !== undefined ? { pageRef } : {}),
    displayList,
    textIndex,
    selectionModel,
  });

  return {
    pageNumber,
    resolutionMethod,
    ...(pageRef !== undefined ? { pageRef } : {}),
    displayList,
    textIndex,
    selectionModel,
    renderHash,
  };
}

function buildRenderTextIndex(pageNumber: number, commands: readonly PdfDisplayCommand[]): PdfRenderTextIndex {
  const spans: PdfRenderTextSpan[] = [];

  for (const command of commands) {
    if (command.kind !== "text") {
      continue;
    }

    spans.push({
      id: `render-text-span-${pageNumber}-${spans.length + 1}`,
      contentOrder: command.contentOrder,
      text: command.text,
      glyphIds: command.glyphIds,
      runId: command.runId,
      ...(command.bbox !== undefined ? { bbox: command.bbox } : {}),
      ...(command.anchor !== undefined ? { anchor: command.anchor } : {}),
      ...(command.transform !== undefined ? { transform: command.transform } : {}),
      ...(command.writingMode !== undefined ? { writingMode: command.writingMode } : {}),
      ...(spans.length > 0 && command.startsNewLine ? { startsNewLine: true } : {}),
    });
  }

  return {
    text: flattenRenderText(spans),
    spans,
  };
}

function buildRenderSelectionModel(pageNumber: number, textIndex: PdfRenderTextIndex): PdfRenderSelectionModel {
  const units: PdfRenderSelectionUnit[] = textIndex.spans.map((span, index) => ({
    id: `render-selection-unit-${pageNumber}-${index + 1}`,
    textSpanId: span.id,
    text: span.text,
    glyphIds: span.glyphIds,
    ...(span.bbox !== undefined ? { bbox: span.bbox } : {}),
    ...(span.anchor !== undefined ? { anchor: span.anchor } : {}),
    ...(span.writingMode !== undefined ? { writingMode: span.writingMode } : {}),
  }));

  return {
    units,
  };
}

function flattenRenderText(spans: readonly PdfRenderTextSpan[]): string {
  let text = "";

  for (const [index, span] of spans.entries()) {
    if (index > 0 && span.startsNewLine) {
      text += "\n";
    }

    text += span.text;
  }

  return text;
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
        segments: mark.segments,
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
