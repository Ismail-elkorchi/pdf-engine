import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
};

export async function runBrowserSessionSuite(browserName) {
  const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const bundle = await build({
    entryPoints: [resolve(rootDirectory, "src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    write: false,
    logLevel: "silent",
  });
  const bundleBytes = bundle.outputFiles[0]?.contents;
  if (bundleBytes === undefined) {
    throw new Error("Browser bundle was not produced.");
  }
  const server = createStaticServer(rootDirectory, bundleBytes);
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Browser test server did not expose a TCP address.");
  }
  const browser = await browserLauncher(browserName).launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${String(address.port)}/`, { waitUntil: "domcontentloaded" });
    return await page.evaluate(async (activeBrowser) => {
      const { createPdfEngine } = await import("/pdf-engine.js");
      const readFixture = async (name) => new Uint8Array(
        await (await fetch(`/test/fixtures/${name}`)).arrayBuffer(),
      );
      const valueOf = (result) => result.status === "completed" || result.status === "partial" ? result.value : undefined;
      const [simpleBytes, javascriptBytes, multiPageBytes, geometryBytes] = await Promise.all([
        readFixture("simple-text.pdf"),
        readFixture("javascript-action.pdf"),
        readFixture("multi-page-navigation.pdf"),
        readFixture("observed-path-geometry.pdf"),
      ]);
      const engine = createPdfEngine();
      try {
        const simple = valueOf(await engine.open({ source: { kind: "bytes", bytes: simpleBytes } }));
        const simpleAgain = valueOf(await engine.open({ source: { kind: "bytes", bytes: simpleBytes } }));
        const deniedJavascript = await engine.open({
          source: { kind: "bytes", bytes: javascriptBytes },
          policy: { javascriptActions: "deny" },
        });
        const reportedJavascript = valueOf(await engine.open({
          source: { kind: "bytes", bytes: javascriptBytes },
          policy: { javascriptActions: "report" },
        }));
        const multiPage = valueOf(await engine.open({ source: { kind: "bytes", bytes: multiPageBytes } }));
        const geometry = valueOf(await engine.open({ source: { kind: "bytes", bytes: geometryBytes } }));
        const simpleObservation = simple === undefined ? undefined : valueOf(await simple.extract());
        const repeatedObservation = simpleAgain === undefined ? undefined : valueOf(await simpleAgain.extract());
        const knowledge = simple === undefined ? undefined : valueOf(await simple.knowledge());
        const search = simple === undefined ? undefined : valueOf(await simple.search({ query: "Hello" }));
        const features = reportedJavascript === undefined ? undefined : valueOf(await reportedJavascript.features());
        const geometryObservation = geometry === undefined ? undefined : valueOf(await geometry.extract());
        const geometryPath = geometryObservation?.pages[0]?.marks.find((mark) => mark.kind === "path") ?? null;
        const javascriptKinds = features?.activeContent.map((item) => item.kind) ?? [];
        const checks = {
          identity: engine.identity.mode === "read" && engine.identity.version === "0.1.0",
          simpleText: simpleObservation?.extractedText === "Hello Test Layer",
          extractionStable: JSON.stringify(simpleObservation) === JSON.stringify(repeatedObservation),
          knowledgePresent: knowledge?.markdown.includes("Hello Test Layer") === true,
          searchPresent: search?.matches.length === 1,
          javascriptDenied: deniedJavascript.status === "blocked",
          javascriptReported: javascriptKinds.includes("javascript"),
          multiPage: multiPage?.summary.pageCount === 2,
          geometryPath: geometryPath?.kind === "path" && geometryPath.pointCount === 15 && geometryPath.closed,
        };
        const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
        if (failed.length > 0) {
          throw new Error(`Browser session checks failed: ${failed.join(", ")}`);
        }
        return {
          runtime: `web-${activeBrowser}`,
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
    }, browserName);
  } finally {
    await browser.close();
    await new Promise((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
  }
}

function browserLauncher(name) {
  switch (name) {
    case "chromium": return chromium;
    case "firefox": return firefox;
    case "webkit": return webkit;
    default: throw new Error(`Unsupported browser runtime: ${name}`);
  }
}

function createStaticServer(rootDirectory, bundleBytes) {
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/") {
        response.writeHead(200, { "content-type": MIME_TYPES[".html"] });
        response.end("<!doctype html><meta charset=utf-8><title>pdf-engine runtime</title>");
        return;
      }
      if (requestUrl.pathname === "/pdf-engine.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(bundleBytes);
        return;
      }
      const relativePath = normalize(requestUrl.pathname).replace(/^[/\\]+/u, "");
      const absolutePath = resolve(rootDirectory, relativePath);
      if (!absolutePath.startsWith(`${rootDirectory}/`)) {
        response.writeHead(403).end();
        return;
      }
      const content = await readFile(absolutePath);
      response.writeHead(200, { "content-type": MIME_TYPES[extname(absolutePath)] ?? "application/octet-stream" });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
}
