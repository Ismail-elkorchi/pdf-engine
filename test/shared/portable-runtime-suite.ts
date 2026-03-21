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
  };
}

export async function runPortableRuntimeSuite(): Promise<PortableRuntimeSuiteResult> {
  const engine = createPdfEngine();
  const simpleTextFixture = await loadNamedPdfFixture("simpleText");
  const javascriptActionFixture = await loadNamedPdfFixture("javascriptAction");
  const multiPageFixture = await loadNamedPdfFixture("multiPageNavigation");

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

  const javascriptFeatureKinds = javascriptAdmission.value?.featureFindings.map(
    (finding) => finding.kind,
  ) ?? [];
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
    },
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
