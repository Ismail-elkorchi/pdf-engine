import { buildRenderPageImagery } from "./render-imagery.ts";
import {
  keyOfObjectRef,
  readNameValue,
  readObjectRefValue,
  readObjectRefsValue,
  type ParsedIndirectObject,
  type ParsedPageEntry,
  type PdfShellAnalysis,
} from "./shell-parse.ts";

import type {
  PdfDisplayCommand,
  PdfDisplayList,
  PdfObservedDocument,
  PdfObservedMark,
  PdfObjectRef,
  PdfRenderDocument,
  PdfRenderFontPayload,
  PdfRenderHash,
  PdfRenderImagePayload,
  PdfRenderPage,
  PdfRenderResourcePayload,
  PdfRenderSelectionModel,
  PdfRenderSelectionUnit,
  PdfRenderTextIndex,
  PdfRenderTextSpan,
  PdfRenderXObjectPayload,
} from "./contracts.ts";

interface RenderResourcePayloadCatalog {
  readonly resourcePayloads: readonly PdfRenderResourcePayload[];
  readonly fontPayloadIdByFontKey: ReadonlyMap<string, string>;
  readonly imagePayloadIdByXObjectKey: ReadonlyMap<string, string>;
  readonly xObjectPayloadIdByXObjectKey: ReadonlyMap<string, string>;
  readonly hasUnavailablePayloads: boolean;
}

interface RenderFontUsage {
  readonly fontRef: PdfObjectRef;
  readonly pageNumbers: Set<number>;
  readonly resourceNames: Set<string>;
}

interface RenderImageUsage {
  readonly xObjectRef: PdfObjectRef;
  readonly pageNumbers: Set<number>;
  readonly resourceNames: Set<string>;
}

interface RenderXObjectUsage {
  readonly xObjectRef: PdfObjectRef;
  readonly pageNumbers: Set<number>;
  readonly resourceNames: Set<string>;
}

export async function buildRenderDocument(
  observation: PdfObservedDocument,
  analysis?: PdfShellAnalysis,
): Promise<PdfRenderDocument> {
  const payloadCatalog = buildRenderResourcePayloadCatalog(observation, analysis);
  const pageEntryByPageNumber = new Map<number, ParsedPageEntry>(
    (analysis?.pageEntries ?? []).map((pageEntry) => [pageEntry.pageNumber, pageEntry] as const),
  );
  const resourcePayloadKnownLimits: PdfRenderDocument["knownLimits"] = payloadCatalog.hasUnavailablePayloads
    ? ["render-resource-payloads-partial"]
    : [];
  const pages = await Promise.all(
    observation.pages.map((page) =>
      buildRenderPage(
        page.pageNumber,
        page.resolutionMethod,
        page.pageRef,
        page.marks,
        payloadCatalog,
        pageEntryByPageNumber.get(page.pageNumber),
      )
    ),
  );
  const imageryKnownLimits = dedupeKnownLimits(
    pages.flatMap((page) => page.knownLimits),
  );
  const renderHash = await buildRenderHash({
    strategy: "observed-display-list",
    resourcePayloads: payloadCatalog.resourcePayloads,
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      resolutionMethod: page.resolutionMethod,
      ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
      ...(page.pageBox !== undefined ? { pageBox: page.pageBox } : {}),
      displayList: page.displayList,
      textIndex: page.textIndex,
      selectionModel: page.selectionModel,
      ...(page.imagery !== undefined ? { imagery: page.imagery } : {}),
      renderHash: page.renderHash,
    })),
  });

  return {
    kind: "pdf-render",
    strategy: "observed-display-list",
    pages: pages.map(stripInternalKnownLimits),
    resourcePayloads: payloadCatalog.resourcePayloads,
    renderHash,
    knownLimits: dedupeKnownLimits([
      ...observation.knownLimits,
      ...resourcePayloadKnownLimits,
      ...imageryKnownLimits,
    ]),
  };
}

async function buildRenderPage(
  pageNumber: number,
  resolutionMethod: PdfRenderPage["resolutionMethod"],
  pageRef: PdfRenderPage["pageRef"],
  marks: readonly PdfObservedMark[],
  payloadCatalog: RenderResourcePayloadCatalog,
  pageEntry: ParsedPageEntry | undefined,
): Promise<PdfRenderPage & { readonly knownLimits: readonly PdfRenderDocument["knownLimits"][number][] }> {
  const displayList: PdfDisplayList = {
    commands: marks.map((mark) => toDisplayCommand(mark, payloadCatalog)),
  };
  const textIndex = buildRenderTextIndex(pageNumber, displayList.commands);
  const selectionModel = buildRenderSelectionModel(pageNumber, textIndex);
  const pageResourcePayloads = payloadCatalog.resourcePayloads.filter((payload) => payload.pageNumbers.includes(pageNumber));
  const imageryResult = buildRenderPageImagery({
    displayList,
    ...(pageEntry?.pageBox !== undefined ? { pageBox: pageEntry.pageBox } : {}),
    resourcePayloads: pageResourcePayloads,
  });
  const renderHash = await buildRenderHash({
    pageNumber,
    resolutionMethod,
    ...(pageRef !== undefined ? { pageRef } : {}),
    ...(imageryResult.pageBox !== undefined ? { pageBox: imageryResult.pageBox } : {}),
    displayList,
    textIndex,
    selectionModel,
    ...(imageryResult.imagery !== undefined ? { imagery: imageryResult.imagery } : {}),
    resourcePayloads: pageResourcePayloads,
  });

  return {
    pageNumber,
    resolutionMethod,
    ...(pageRef !== undefined ? { pageRef } : {}),
    ...(imageryResult.pageBox !== undefined ? { pageBox: imageryResult.pageBox } : {}),
    displayList,
    textIndex,
    selectionModel,
    ...(imageryResult.imagery !== undefined ? { imagery: imageryResult.imagery } : {}),
    renderHash,
    knownLimits: imageryResult.knownLimits,
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

function toDisplayCommand(mark: PdfObservedMark, payloadCatalog: RenderResourcePayloadCatalog): PdfDisplayCommand {
  switch (mark.kind) {
    case "text": {
      const fontPayloadId = mark.fontRef ? payloadCatalog.fontPayloadIdByFontKey.get(keyOfObjectRef(mark.fontRef)) : undefined;
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
        ...(fontPayloadId !== undefined ? { fontPayloadId } : {}),
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
    }
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
    case "image": {
      const imagePayloadId = mark.xObjectRef ? payloadCatalog.imagePayloadIdByXObjectKey.get(keyOfObjectRef(mark.xObjectRef)) : undefined;
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
        ...(imagePayloadId !== undefined ? { imagePayloadId } : {}),
        ...(mark.width !== undefined ? { width: mark.width } : {}),
        ...(mark.height !== undefined ? { height: mark.height } : {}),
      };
    }
    case "xobject": {
      const xObjectPayloadId = mark.xObjectRef ? payloadCatalog.xObjectPayloadIdByXObjectKey.get(keyOfObjectRef(mark.xObjectRef)) : undefined;
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
        ...(xObjectPayloadId !== undefined ? { xObjectPayloadId } : {}),
        ...(mark.subtypeName !== undefined ? { subtypeName: mark.subtypeName } : {}),
        ...(mark.transparencyGroup !== undefined ? { transparencyGroup: mark.transparencyGroup } : {}),
      };
    }
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

function stripInternalKnownLimits(
  page: PdfRenderPage & { readonly knownLimits: readonly PdfRenderDocument["knownLimits"][number][] },
): PdfRenderPage {
  const { knownLimits, ...publicPage } = page;
  void knownLimits;
  return publicPage;
}

function buildRenderResourcePayloadCatalog(
  observation: PdfObservedDocument,
  analysis: PdfShellAnalysis | undefined,
): RenderResourcePayloadCatalog {
  if (analysis === undefined) {
    return {
      resourcePayloads: [],
      fontPayloadIdByFontKey: new Map(),
      imagePayloadIdByXObjectKey: new Map(),
      xObjectPayloadIdByXObjectKey: new Map(),
      hasUnavailablePayloads: false,
    };
  }

  const fontUsageByFontKey = new Map<string, RenderFontUsage>();
  const imageUsageByXObjectKey = new Map<string, RenderImageUsage>();
  const xObjectUsageByXObjectKey = new Map<string, RenderXObjectUsage>();
  const fontResourceNameLookup = buildFontResourceNameLookup(analysis);

  for (const page of observation.pages) {
    for (const mark of page.marks) {
      if (mark.kind === "text" && mark.fontRef !== undefined) {
        const fontKey = keyOfObjectRef(mark.fontRef);
        let usage = fontUsageByFontKey.get(fontKey);
        if (!usage) {
          usage = {
            fontRef: mark.fontRef,
            pageNumbers: new Set<number>(),
            resourceNames: new Set<string>(),
          };
          fontUsageByFontKey.set(fontKey, usage);
        }
        usage.pageNumbers.add(page.pageNumber);
        for (const resourceName of fontResourceNameLookup.get(`${String(page.pageNumber)}:${fontKey}`) ?? []) {
          usage.resourceNames.add(resourceName);
        }
        continue;
      }

      if (mark.kind === "image" && mark.xObjectRef !== undefined) {
        const xObjectKey = keyOfObjectRef(mark.xObjectRef);
        let usage = imageUsageByXObjectKey.get(xObjectKey);
        if (!usage) {
          usage = {
            xObjectRef: mark.xObjectRef,
            pageNumbers: new Set<number>(),
            resourceNames: new Set<string>(),
          };
          imageUsageByXObjectKey.set(xObjectKey, usage);
        }
        usage.pageNumbers.add(page.pageNumber);
        usage.resourceNames.add(mark.resourceName);
        continue;
      }

      if (mark.kind === "xobject" && mark.xObjectRef !== undefined && isDirectRasterizableXObject(mark.subtypeName)) {
        const xObjectKey = keyOfObjectRef(mark.xObjectRef);
        let usage = xObjectUsageByXObjectKey.get(xObjectKey);
        if (!usage) {
          usage = {
            xObjectRef: mark.xObjectRef,
            pageNumbers: new Set<number>(),
            resourceNames: new Set<string>(),
          };
          xObjectUsageByXObjectKey.set(xObjectKey, usage);
        }
        usage.pageNumbers.add(page.pageNumber);
        usage.resourceNames.add(mark.resourceName);
      }
    }
  }

  const resourcePayloads: PdfRenderResourcePayload[] = [];
  const fontPayloadIdByFontKey = new Map<string, string>();
  const imagePayloadIdByXObjectKey = new Map<string, string>();
  const xObjectPayloadIdByXObjectKey = new Map<string, string>();
  let fontPayloadCount = 0;
  let imagePayloadCount = 0;
  let xObjectPayloadCount = 0;
  let hasUnavailablePayloads = false;

  for (const [fontKey, usage] of [...fontUsageByFontKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const id = `render-font-payload-${String(++fontPayloadCount)}`;
    const payload = buildFontResourcePayload(id, usage, analysis);
    resourcePayloads.push(payload);
    fontPayloadIdByFontKey.set(fontKey, id);
    hasUnavailablePayloads ||= payload.availability === "unavailable";
  }

  for (const [xObjectKey, usage] of [...imageUsageByXObjectKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const id = `render-image-payload-${String(++imagePayloadCount)}`;
    const payload = buildImageResourcePayload(id, usage, analysis);
    resourcePayloads.push(payload);
    imagePayloadIdByXObjectKey.set(xObjectKey, id);
    hasUnavailablePayloads ||= payload.availability === "unavailable";
  }

  for (const [xObjectKey, usage] of [...xObjectUsageByXObjectKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const id = `render-xobject-payload-${String(++xObjectPayloadCount)}`;
    const payload = buildXObjectResourcePayload(id, usage, analysis);
    resourcePayloads.push(payload);
    xObjectPayloadIdByXObjectKey.set(xObjectKey, id);
    hasUnavailablePayloads ||= payload.availability === "unavailable";
  }

  return {
    resourcePayloads,
    fontPayloadIdByFontKey,
    imagePayloadIdByXObjectKey,
    xObjectPayloadIdByXObjectKey,
    hasUnavailablePayloads,
  };
}

function buildFontResourceNameLookup(analysis: PdfShellAnalysis): Map<string, readonly string[]> {
  const lookup = new Map<string, string[]>();

  for (const pageEntry of analysis.pageEntries) {
    for (const binding of pageEntry.fontBindings) {
      const key = `${String(pageEntry.pageNumber)}:${keyOfObjectRef(binding.fontRef)}`;
      const names = lookup.get(key) ?? [];
      if (!names.includes(binding.resourceName)) {
        names.push(binding.resourceName);
      }
      lookup.set(key, names);
    }
  }

  return lookup;
}

function buildFontResourcePayload(
  id: string,
  usage: RenderFontUsage,
  analysis: PdfShellAnalysis,
): PdfRenderFontPayload {
  const fontObject = analysis.objectIndex.get(keyOfObjectRef(usage.fontRef));
  const descendantFontObject = resolveDescendantFontObject(usage.fontRef, analysis);
  const fontDescriptorRef =
    readObjectRefValue(descendantFontObject?.dictionaryEntries.get("FontDescriptor"))
    ?? readObjectRefValue(fontObject?.dictionaryEntries.get("FontDescriptor"));
  const fontDescriptorObject = fontDescriptorRef
    ? analysis.objectIndex.get(keyOfObjectRef(fontDescriptorRef))
    : undefined;
  const fontProgramReference = fontDescriptorObject ? resolveFontProgramReference(fontDescriptorObject) : undefined;
  const fontProgramObject = fontProgramReference?.fontProgramRef
    ? analysis.objectIndex.get(keyOfObjectRef(fontProgramReference.fontProgramRef))
    : undefined;
  const fontSubtypeName = readNameValue(fontObject?.dictionaryEntries.get("Subtype"))
    ?? readNameValue(descendantFontObject?.dictionaryEntries.get("Subtype"));
  const baseFontName = readNameValue(fontObject?.dictionaryEntries.get("BaseFont"))
    ?? readNameValue(descendantFontObject?.dictionaryEntries.get("BaseFont"))
    ?? readNameValue(fontDescriptorObject?.dictionaryEntries.get("FontName"));

  const basePayload = {
    id,
    kind: "font" as const,
    fontRef: usage.fontRef,
    pageNumbers: toSortedNumbers(usage.pageNumbers),
    resourceNames: toSortedStrings(usage.resourceNames),
    ...(fontSubtypeName !== undefined ? { fontSubtypeName } : {}),
    ...(baseFontName !== undefined ? { baseFontName } : {}),
    ...(fontProgramReference?.fontProgramRef !== undefined ? { fontProgramRef: fontProgramReference.fontProgramRef } : {}),
    ...(fontProgramReference?.fontProgramFormat !== undefined ? { fontProgramFormat: fontProgramReference.fontProgramFormat } : {}),
    ...(fontProgramObject?.streamDecodeState !== undefined ? { streamDecodeState: fontProgramObject.streamDecodeState } : {}),
    ...(fontProgramObject?.streamFilterNames !== undefined ? { streamFilterNames: fontProgramObject.streamFilterNames } : {}),
  };

  if (fontDescriptorObject === undefined) {
    return {
      ...basePayload,
      availability: "unavailable",
      unavailableReason: "missing-font-descriptor",
    };
  }

  if (fontProgramReference === undefined) {
    return {
      ...basePayload,
      availability: "unavailable",
      unavailableReason: "missing-embedded-font-program",
    };
  }

  if (!fontProgramObject?.decodedStreamBytes) {
    return {
      ...basePayload,
      availability: "unavailable",
      unavailableReason: "missing-decoded-font-program",
    };
  }

  return {
    ...basePayload,
    availability: "available",
    byteSource: "decoded-stream",
    bytes: fontProgramObject.decodedStreamBytes,
  };
}

function buildImageResourcePayload(
  id: string,
  usage: RenderImageUsage,
  analysis: PdfShellAnalysis,
): PdfRenderImagePayload {
  const imageObject = analysis.objectIndex.get(keyOfObjectRef(usage.xObjectRef));
  const width = readNumericValue(imageObject?.dictionaryEntries.get("Width"));
  const height = readNumericValue(imageObject?.dictionaryEntries.get("Height"));
  const colorSpaceValue = imageObject?.dictionaryEntries.get("ColorSpace")?.trim();
  const bitsPerComponent = readNumericValue(imageObject?.dictionaryEntries.get("BitsPerComponent"));
  const basePayload = {
    id,
    kind: "image" as const,
    xObjectRef: usage.xObjectRef,
    pageNumbers: toSortedNumbers(usage.pageNumbers),
    resourceNames: toSortedStrings(usage.resourceNames),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(colorSpaceValue !== undefined ? { colorSpaceValue } : {}),
    ...(bitsPerComponent !== undefined ? { bitsPerComponent } : {}),
    ...(imageObject?.streamDecodeState !== undefined ? { streamDecodeState: imageObject.streamDecodeState } : {}),
    ...(imageObject?.streamFilterNames !== undefined ? { streamFilterNames: imageObject.streamFilterNames } : {}),
  };

  if (imageObject === undefined || imageObject.hasStream !== true) {
    return {
      ...basePayload,
      availability: "unavailable",
      unavailableReason: "missing-image-stream",
    };
  }

  if (!imageObject.decodedStreamBytes) {
    return {
      ...basePayload,
      availability: "unavailable",
      unavailableReason: "missing-decoded-image-stream",
    };
  }

  return {
    ...basePayload,
    availability: "available",
    byteSource: "decoded-stream",
    bytes: imageObject.decodedStreamBytes,
  };
}

function buildXObjectResourcePayload(
  id: string,
  usage: RenderXObjectUsage,
  analysis: PdfShellAnalysis,
): PdfRenderXObjectPayload {
  const xObjectObject = analysis.objectIndex.get(keyOfObjectRef(usage.xObjectRef));
  const subtypeName = readNameValue(xObjectObject?.dictionaryEntries.get("Subtype"));
  const basePayload = {
    id,
    kind: "xobject" as const,
    xObjectRef: usage.xObjectRef,
    pageNumbers: toSortedNumbers(usage.pageNumbers),
    resourceNames: toSortedStrings(usage.resourceNames),
    ...(subtypeName !== undefined ? { subtypeName } : {}),
    ...(xObjectObject?.streamDecodeState !== undefined ? { streamDecodeState: xObjectObject.streamDecodeState } : {}),
    ...(xObjectObject?.streamFilterNames !== undefined ? { streamFilterNames: xObjectObject.streamFilterNames } : {}),
  };

  if (subtypeName === undefined || !isDirectRasterizableXObject(subtypeName)) {
    return {
      ...basePayload,
      availability: "unavailable",
      unavailableReason: "xobject-not-direct-rasterizable",
    };
  }

  if (!xObjectObject?.decodedStreamBytes) {
    return {
      ...basePayload,
      availability: "unavailable",
      unavailableReason: "missing-decoded-xobject-stream",
    };
  }

  return {
    ...basePayload,
    availability: "available",
    byteSource: "decoded-stream",
    bytes: xObjectObject.decodedStreamBytes,
  };
}

function resolveDescendantFontObject(
  fontRef: PdfObjectRef,
  analysis: PdfShellAnalysis,
): ParsedIndirectObject | undefined {
  const fontObject = analysis.objectIndex.get(keyOfObjectRef(fontRef));
  if (!fontObject) {
    return undefined;
  }

  const descendantFontRefs = readObjectRefsValue(fontObject.dictionaryEntries.get("DescendantFonts"));
  const descendantFontRef = descendantFontRefs[0];
  if (!descendantFontRef) {
    return fontObject;
  }

  return analysis.objectIndex.get(keyOfObjectRef(descendantFontRef)) ?? fontObject;
}

function resolveFontProgramReference(
  fontDescriptorObject: ParsedIndirectObject,
): {
  readonly fontProgramRef: PdfObjectRef;
  readonly fontProgramFormat: PdfRenderFontPayload["fontProgramFormat"];
} | undefined {
  const fontFile2Ref = readObjectRefValue(fontDescriptorObject.dictionaryEntries.get("FontFile2"));
  if (fontFile2Ref) {
    return {
      fontProgramRef: fontFile2Ref,
      fontProgramFormat: "truetype",
    };
  }

  const fontFile3Ref = readObjectRefValue(fontDescriptorObject.dictionaryEntries.get("FontFile3"));
  if (fontFile3Ref) {
    return {
      fontProgramRef: fontFile3Ref,
      fontProgramFormat: resolveFontProgramFormatFromFontFile3(fontDescriptorObject),
    };
  }

  const fontFileRef = readObjectRefValue(fontDescriptorObject.dictionaryEntries.get("FontFile"));
  if (fontFileRef) {
    return {
      fontProgramRef: fontFileRef,
      fontProgramFormat: "type1",
    };
  }

  return undefined;
}

function resolveFontProgramFormatFromFontFile3(fontDescriptorObject: ParsedIndirectObject): PdfRenderFontPayload["fontProgramFormat"] {
  const fontFile3Ref = readObjectRefValue(fontDescriptorObject.dictionaryEntries.get("FontFile3"));
  if (!fontFile3Ref) {
    return "unknown";
  }

  return "unknown";
}

function isDirectRasterizableXObject(subtypeName: string | undefined): boolean {
  return subtypeName === "/Image";
}

function toSortedNumbers(values: ReadonlySet<number>): readonly number[] {
  return [...values].sort((left, right) => left - right);
}

function toSortedStrings(values: ReadonlySet<string>): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function readNumericValue(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

  if (value instanceof Uint8Array) {
    return `[${Array.from(value, (entry) => canonicalizeJson(entry)).join(",")}]`;
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
