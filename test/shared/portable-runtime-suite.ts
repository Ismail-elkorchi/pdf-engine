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

export async function runPortableRuntimeSuite(): Promise<PortableRuntimeSuiteResult> {
  const engine = createPdfEngine();
  const simpleTextFixture = await loadNamedPdfFixture("simpleText");
  const javascriptActionFixture = await loadNamedPdfFixture("javascriptAction");
  const multiPageFixture = await loadNamedPdfFixture("multiPageNavigation");
  const geometryFixture = await loadNamedPdfFixture("observedPathGeometry");

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
