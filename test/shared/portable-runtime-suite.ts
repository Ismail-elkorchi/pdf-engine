import { createPdfEngine, type PdfResult } from "../../src/index.ts";

import { loadNamedPdfFixture } from "./load-fixture.ts";

export interface PortableRuntimeSuiteResult {
  readonly runtime: string;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly oracle: {
    readonly simpleText: string | null;
    readonly knowledgeMarkdown: string | null;
    readonly searchCount: number | null;
    readonly pageCount: number | null;
    readonly geometryPath: unknown;
    readonly javascriptDenied: boolean;
    readonly javascriptKinds: readonly string[];
  };
}

function valueOf<T>(result: PdfResult<T>): T | undefined {
  return result.status === "completed" || result.status === "partial" ? result.value : undefined;
}

export async function runPortableRuntimeSuite(): Promise<PortableRuntimeSuiteResult> {
  const engine = createPdfEngine();
  try {
    const simpleFixture = await loadNamedPdfFixture("simpleText");
    const javascriptFixture = await loadNamedPdfFixture("javascriptAction");
    const multiPageFixture = await loadNamedPdfFixture("multiPageNavigation");
    const geometryFixture = await loadNamedPdfFixture("observedPathGeometry");

    const simple = valueOf(await engine.open({
      source: { kind: "bytes", bytes: simpleFixture.bytes, fileName: simpleFixture.fixture.fileName },
    }));
    const simpleAgain = valueOf(await engine.open({
      source: { kind: "bytes", bytes: simpleFixture.bytes, fileName: simpleFixture.fixture.fileName },
    }));
    const deniedJavascript = await engine.open({
      source: { kind: "bytes", bytes: javascriptFixture.bytes, fileName: javascriptFixture.fixture.fileName },
      policy: { javascriptActions: "deny" },
    });
    const reportedJavascript = valueOf(await engine.open({
      source: { kind: "bytes", bytes: javascriptFixture.bytes, fileName: javascriptFixture.fixture.fileName },
      policy: { javascriptActions: "report" },
    }));
    const multiPage = valueOf(await engine.open({
      source: { kind: "bytes", bytes: multiPageFixture.bytes, fileName: multiPageFixture.fixture.fileName },
    }));
    const geometry = valueOf(await engine.open({
      source: { kind: "bytes", bytes: geometryFixture.bytes, fileName: geometryFixture.fixture.fileName },
    }));

    const simpleObservation = simple === undefined ? undefined : valueOf(await simple.extract());
    const secondObservation = simpleAgain === undefined ? undefined : valueOf(await simpleAgain.extract());
    const knowledge = simple === undefined ? undefined : valueOf(await simple.knowledge());
    const secondKnowledge = simpleAgain === undefined ? undefined : valueOf(await simpleAgain.knowledge());
    const search = simple === undefined ? undefined : valueOf(await simple.search({ query: "Hello" }));
    const features = reportedJavascript === undefined ? undefined : valueOf(await reportedJavascript.features());
    const geometryObservation = geometry === undefined ? undefined : valueOf(await geometry.extract());
    const geometryPath = geometryObservation?.pages[0]?.marks.find((mark) => mark.kind === "path") ?? null;
    const javascriptKinds = features?.activeContent.map((item) => item.kind) ?? [];

    const checks = {
      identity: engine.identity.mode === "read" && engine.identity.version === "0.1.0",
      simpleText: simpleObservation?.extractedText === simpleFixture.fixture.expectedText,
      extractionStable: JSON.stringify(simpleObservation) === JSON.stringify(secondObservation),
      knowledgePresent: knowledge?.markdown.includes(simpleFixture.fixture.expectedText ?? "") === true,
      knowledgeStable: knowledge?.markdown === secondKnowledge?.markdown,
      searchPresent: (search?.matches.length ?? 0) > 0,
      javascriptDenied: deniedJavascript.status === "blocked",
      javascriptReported: javascriptKinds.includes("javascript"),
      multiPage: multiPage?.summary.pageCount === multiPageFixture.fixture.expectedPageCount,
      geometryPath: geometryPath?.kind === "path" && geometryPath.pointCount === 15 && geometryPath.closed,
    };
    assertChecks(checks);
    return {
      runtime: engine.runtime.kind,
      checks,
      oracle: {
        simpleText: simpleObservation?.extractedText ?? null,
        knowledgeMarkdown: knowledge?.markdown ?? null,
        searchCount: search?.matches.length ?? null,
        pageCount: multiPage?.summary.pageCount ?? null,
        geometryPath,
        javascriptDenied: deniedJavascript.status === "blocked",
        javascriptKinds,
      },
    };
  } finally {
    await engine.dispose();
  }
}

function assertChecks(checks: Readonly<Record<string, boolean>>): void {
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Portable runtime suite failed: ${failed.join(", ")}`);
  }
}
