import { createPdfEngine } from "../../src/index.ts";

import { loadNamedPdfFixture } from "./load-fixture.ts";

export interface PortableRuntimeSuiteResult {
  readonly runtime: string;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly oracle: {
    readonly simpleText: string | null;
    readonly simpleRenderHash: string | null;
    readonly javascriptDecision: string | null;
    readonly javascriptFeatureKinds: readonly string[];
    readonly multiPageCount: number | null;
    readonly renderPageCount: number | null;
    readonly geometryPathSignature: PortableGeometryPathSignature | null;
    readonly geometryRenderHash: string | null;
    readonly renderTextIndexText: string | null;
    readonly renderTextSelectionSignature: PortableRenderTextSelectionSignature | null;
    readonly renderTextSelectionHash: string | null;
    readonly renderResourcePayloadSignature: PortableRenderResourcePayloadSignature | null;
    readonly renderResourcePayloadHash: string | null;
  };
}

interface PortableGeometryPathSignature {
  readonly paintOperator: string;
  readonly paintState: unknown;
  readonly colorState: unknown;
  readonly transparencyState: unknown;
  readonly segments: unknown;
  readonly pointCount: number;
  readonly closed: boolean;
  readonly bbox: unknown;
  readonly transform: unknown;
}

interface PortableRenderTextSelectionSignature {
  readonly spans: readonly {
    readonly id: string;
    readonly contentOrder: number;
    readonly text: string;
    readonly glyphIds: readonly string[];
    readonly bbox: unknown;
    readonly anchor: unknown;
    readonly writingMode: unknown;
    readonly startsNewLine: boolean;
  }[];
  readonly units: readonly {
    readonly id: string;
    readonly textSpanId: string;
    readonly text: string;
    readonly glyphIds: readonly string[];
    readonly bbox: unknown;
    readonly anchor: unknown;
    readonly writingMode: unknown;
  }[];
}

interface PortableRenderResourcePayloadSignature {
  readonly payloads: readonly {
    readonly id: string;
    readonly kind: string;
    readonly availability: string;
    readonly pageNumbers: readonly number[];
    readonly resourceNames: readonly string[];
    readonly fontRef: unknown;
    readonly xObjectRef: unknown;
    readonly fontProgramFormat: string | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly colorSpaceValue: string | null;
    readonly streamDecodeState: string | null;
    readonly byteSignature: readonly number[] | null;
  }[];
  readonly textCommandFontPayloadIds: readonly (string | null)[];
  readonly imageCommandPayloadIds: readonly (string | null)[];
}

export async function runPortableRuntimeSuite(): Promise<PortableRuntimeSuiteResult> {
  const engine = createPdfEngine();
  const simpleTextFixture = await loadNamedPdfFixture("simpleText");
  const javascriptActionFixture = await loadNamedPdfFixture("javascriptAction");
  const multiPageFixture = await loadNamedPdfFixture("multiPageNavigation");
  const geometryFixture = await loadNamedPdfFixture("observedPathGeometry");
  const renderTextFixture = await loadNamedPdfFixture("renderTextSelection");
  const renderResourceFixture = await loadNamedPdfFixture("renderResourcePayloads");

  const simpleFirst = await engine.run({
    source: {
      bytes: simpleTextFixture.bytes,
      fileName: simpleTextFixture.fixture.fileName,
    },
  });
  const simpleSecond = await engine.run({
    source: {
      bytes: simpleTextFixture.bytes,
      fileName: simpleTextFixture.fixture.fileName,
    },
  });
  const javascriptAdmission = await engine.admit({
    source: {
      bytes: javascriptActionFixture.bytes,
      fileName: javascriptActionFixture.fixture.fileName,
    },
    policy: {
      javascriptActions: "deny",
    },
  });
  const multiPageResult = await engine.run({
    source: {
      bytes: multiPageFixture.bytes,
      fileName: multiPageFixture.fixture.fileName,
    },
  });
  const geometryResult = await engine.run({
    source: {
      bytes: geometryFixture.bytes,
      fileName: geometryFixture.fixture.fileName,
    },
  });
  const renderTextResult = await engine.run({
    source: {
      bytes: renderTextFixture.bytes,
      fileName: renderTextFixture.fixture.fileName,
    },
  });
  const renderResourceResult = await engine.run({
    source: {
      bytes: renderResourceFixture.bytes,
      fileName: renderResourceFixture.fixture.fileName,
    },
  });

  const javascriptFeatureKinds = javascriptAdmission.value?.featureFindings.map(
    (finding) => finding.kind,
  ) ?? [];
  const geometryPathMark = geometryResult.observation.value?.pages[0]?.marks.find((mark) => mark.kind === "path");
  const geometryPathCommand = geometryResult.render.value?.pages[0]?.displayList.commands.find((command) => command.kind === "path");
  const geometryPathSignature = geometryPathMark?.kind === "path"
    ? toPortableGeometryPathSignature(geometryPathMark)
    : null;
  const geometryRenderPathSignature = geometryPathCommand?.kind === "path"
    ? toPortableGeometryPathSignature(geometryPathCommand)
    : null;
  const renderTextSelectionSignature = toPortableRenderTextSelectionSignature(
    renderTextResult.render.value?.pages[0]?.textIndex,
    renderTextResult.render.value?.pages[0]?.selectionModel,
  );
  const renderResourcePayloadSignature = toPortableRenderResourcePayloadSignature(
    renderResourceResult.render.value,
  );
  const checks = {
    identityMode: engine.identity.mode === "core",
    renderSupported: engine.identity.supportedStages.includes("render"),
    simpleText:
      simpleFirst.observation.value?.extractedText ===
      simpleTextFixture.fixture.expectedText,
    simpleObservationStrategy:
      simpleFirst.observation.value?.strategy === "content-stream-interpreter",
    simpleMarksPresent:
      simpleFirst.observation.value?.pages[0]?.marks[0]?.kind === "text",
    simpleRenderPresent: simpleFirst.render.value?.kind === "pdf-render",
    simpleRenderStable:
      simpleFirst.render.value?.renderHash.hex ===
      simpleSecond.render.value?.renderHash.hex,
    javascriptRejected:
      javascriptAdmission.value?.decision ===
      javascriptActionFixture.fixture.expectedPolicyDecision,
    javascriptFinding:
      javascriptFeatureKinds.includes("javascript-actions"),
    multiPageCount:
      multiPageResult.layout.value?.pages.length ===
      multiPageFixture.fixture.expectedPageCount,
    renderPageCount:
      multiPageResult.render.value?.pages.length ===
      multiPageFixture.fixture.expectedPageCount,
    geometryPathPresent: geometryPathSignature !== null,
    geometryRenderPathPresent: geometryRenderPathSignature !== null,
    geometrySegmentsPreserved:
      geometryPathSignature !== null &&
      geometryRenderPathSignature !== null &&
      JSON.stringify(geometryPathSignature) === JSON.stringify(geometryRenderPathSignature),
    geometryPointCount: geometryPathSignature?.pointCount === 15,
    geometryClosed: geometryPathSignature?.closed === true,
    geometryBlendMode:
      geometryPathSignature !== null &&
      hasPortableBlendMode(geometryPathSignature.transparencyState, "multiply"),
    renderTextIndexPresent: renderTextResult.render.value?.pages[0]?.textIndex.spans.length === 2,
    renderTextIndexText:
      renderTextResult.render.value?.pages[0]?.textIndex.text === renderTextFixture.fixture.expectedText,
    renderSelectionUnitsPresent: renderTextResult.render.value?.pages[0]?.selectionModel.units.length === 2,
    renderSelectionMatchesSpans:
      renderTextSelectionSignature !== null &&
      renderTextSelectionSignature.spans.every((span, index) =>
        renderTextSelectionSignature.units[index]?.textSpanId === span.id
      ),
    renderResourcePayloadsPresent:
      renderResourceResult.render.value?.resourcePayloads.length === renderResourceFixture.fixture.expectedRenderResourcePayloadCount,
    renderFontPayloadAvailable:
      renderResourcePayloadSignature !== null &&
      renderResourcePayloadSignature.payloads.some((payload) => payload.kind === "font" && payload.availability === "available"),
    renderImagePayloadAvailable:
      renderResourcePayloadSignature !== null &&
      renderResourcePayloadSignature.payloads.some((payload) => payload.kind === "image" && payload.availability === "available"),
    renderFontPayloadLinked:
      renderResourcePayloadSignature !== null &&
      renderResourcePayloadSignature.textCommandFontPayloadIds.every((value) => value !== null),
    renderImagePayloadLinked:
      renderResourcePayloadSignature !== null &&
      renderResourcePayloadSignature.imageCommandPayloadIds.every((value) => value !== null),
  } as const;

  assertChecks(checks);

  return {
    runtime: simpleFirst.runtime.kind,
    checks,
    oracle: {
      simpleText: simpleFirst.observation.value?.extractedText ?? null,
      simpleRenderHash: simpleFirst.render.value?.renderHash.hex ?? null,
      javascriptDecision: javascriptAdmission.value?.decision ?? null,
      javascriptFeatureKinds,
      multiPageCount: multiPageResult.layout.value?.pages.length ?? null,
      renderPageCount: multiPageResult.render.value?.pages.length ?? null,
      geometryPathSignature,
      geometryRenderHash: geometryResult.render.value?.renderHash.hex ?? null,
      renderTextIndexText: renderTextResult.render.value?.pages[0]?.textIndex.text ?? null,
      renderTextSelectionSignature,
      renderTextSelectionHash: renderTextResult.render.value?.pages[0]?.renderHash.hex ?? null,
      renderResourcePayloadSignature,
      renderResourcePayloadHash: renderResourceResult.render.value?.renderHash.hex ?? null,
    },
  };
}

function toPortableGeometryPathSignature(
  pathLike: {
    readonly paintOperator: string;
    readonly paintState: unknown;
    readonly colorState: unknown;
    readonly transparencyState: unknown;
    readonly segments: unknown;
    readonly pointCount: number;
    readonly closed: boolean;
    readonly bbox?: unknown;
    readonly transform?: unknown;
  },
): PortableGeometryPathSignature {
  return {
    paintOperator: pathLike.paintOperator,
    paintState: pathLike.paintState,
    colorState: pathLike.colorState,
    transparencyState: pathLike.transparencyState,
    segments: pathLike.segments,
    pointCount: pathLike.pointCount,
    closed: pathLike.closed,
    bbox: pathLike.bbox ?? null,
    transform: pathLike.transform ?? null,
  };
}

function hasPortableBlendMode(transparencyState: unknown, expectedBlendMode: string): boolean {
  if (!transparencyState || typeof transparencyState !== "object") {
    return false;
  }

  return "blendMode" in transparencyState && transparencyState.blendMode === expectedBlendMode;
}

function toPortableRenderTextSelectionSignature(
  textIndex: {
    readonly spans: readonly {
      readonly id: string;
      readonly contentOrder: number;
      readonly text: string;
      readonly glyphIds: readonly string[];
      readonly bbox?: unknown;
      readonly anchor?: unknown;
      readonly writingMode?: unknown;
      readonly startsNewLine?: boolean;
    }[];
  } | undefined,
  selectionModel: {
    readonly units: readonly {
      readonly id: string;
      readonly textSpanId: string;
      readonly text: string;
      readonly glyphIds: readonly string[];
      readonly bbox?: unknown;
      readonly anchor?: unknown;
      readonly writingMode?: unknown;
    }[];
  } | undefined,
): PortableRenderTextSelectionSignature | null {
  if (textIndex === undefined || selectionModel === undefined) {
    return null;
  }

  return {
    spans: textIndex.spans.map((span) => ({
      id: span.id,
      contentOrder: span.contentOrder,
      text: span.text,
      glyphIds: span.glyphIds,
      bbox: span.bbox ?? null,
      anchor: span.anchor ?? null,
      writingMode: span.writingMode ?? null,
      startsNewLine: span.startsNewLine === true,
    })),
    units: selectionModel.units.map((unit) => ({
      id: unit.id,
      textSpanId: unit.textSpanId,
      text: unit.text,
      glyphIds: unit.glyphIds,
      bbox: unit.bbox ?? null,
      anchor: unit.anchor ?? null,
      writingMode: unit.writingMode ?? null,
    })),
  };
}

function toPortableRenderResourcePayloadSignature(
  renderDocument:
    | {
        readonly resourcePayloads: readonly {
          readonly id: string;
          readonly kind: string;
          readonly availability: string;
          readonly pageNumbers: readonly number[];
          readonly resourceNames: readonly string[];
          readonly fontRef?: unknown;
          readonly xObjectRef?: unknown;
          readonly fontProgramFormat?: string;
          readonly width?: number;
          readonly height?: number;
          readonly colorSpaceValue?: string;
          readonly streamDecodeState?: string;
          readonly bytes?: Uint8Array;
        }[];
        readonly pages: readonly {
          readonly displayList: {
            readonly commands: readonly {
              readonly kind: string;
              readonly fontPayloadId?: string;
              readonly imagePayloadId?: string;
            }[];
          };
        }[];
      }
    | undefined,
): PortableRenderResourcePayloadSignature | null {
  if (renderDocument === undefined) {
    return null;
  }

  return {
    payloads: renderDocument.resourcePayloads.map((payload) => ({
      id: payload.id,
      kind: payload.kind,
      availability: payload.availability,
      pageNumbers: payload.pageNumbers,
      resourceNames: payload.resourceNames,
      fontRef: "fontRef" in payload ? payload.fontRef : null,
      xObjectRef: "xObjectRef" in payload ? payload.xObjectRef : null,
      fontProgramFormat: "fontProgramFormat" in payload ? payload.fontProgramFormat ?? null : null,
      width: "width" in payload ? payload.width ?? null : null,
      height: "height" in payload ? payload.height ?? null : null,
      colorSpaceValue: "colorSpaceValue" in payload ? payload.colorSpaceValue ?? null : null,
      streamDecodeState: payload.streamDecodeState ?? null,
      byteSignature: payload.bytes ? Array.from(payload.bytes) : null,
    })),
    textCommandFontPayloadIds: renderDocument.pages.flatMap((page) =>
      page.displayList.commands
        .filter((command) => command.kind === "text")
        .map((command) => command.fontPayloadId ?? null)
    ),
    imageCommandPayloadIds: renderDocument.pages.flatMap((page) =>
      page.displayList.commands
        .filter((command) => command.kind === "image")
        .map((command) => command.imagePayloadId ?? null)
    ),
  };
}

function assertChecks(checks: Readonly<Record<string, boolean>>): void {
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => passed === false)
    .map(([name]) => name);
  if (failedChecks.length > 0) {
    throw new Error(
      `Portable runtime suite failed: ${failedChecks.join(", ")}`,
    );
  }
}
