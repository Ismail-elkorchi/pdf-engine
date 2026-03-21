import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "playwright";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};

const args = process.argv.slice(2);
const browserName = readArg("--browser") ?? "chromium";
const reportPath =
  readArg("--report") ?? "reports/test-runtime-browser.json";

const browser = await resolveBrowserLauncher(browserName).launch({
  headless: true,
});
const page = await browser.newPage();
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const server = createStaticServer(rootDir);

await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Browser runtime test server failed to bind.");
}

const baseUrl = `http://127.0.0.1:${String(address.port)}`;

try {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });

  const report = await page.evaluate(async (activeBrowserName) => {
    const { createPdfEngine } = await import("/dist/index.js");
    const { renderPdfViewer } = await import("/dist/viewer.js");

    const readBytes = async (path) =>
      new Uint8Array(await (await fetch(path)).arrayBuffer());
    const engine = createPdfEngine();
    const simpleTextBytes = await readBytes("/test/fixtures/simple-text.pdf");
    const javascriptActionBytes = await readBytes(
      "/test/fixtures/javascript-action.pdf",
    );
    const multiPageBytes = await readBytes(
      "/test/fixtures/multi-page-navigation.pdf",
    );

    const simpleResult = await engine.run({
      source: {
        bytes: simpleTextBytes,
        fileName: "simple-text.pdf",
      },
    });
    const javascriptAdmission = await engine.admit({
      source: {
        bytes: javascriptActionBytes,
        fileName: "javascript-action.pdf",
      },
      policy: {
        javascriptActions: "deny",
      },
    });
    const multiPageResult = await engine.run({
      source: {
        bytes: multiPageBytes,
        fileName: "multi-page-navigation.pdf",
      },
    });

    const browserDocument = globalThis.document;
    const viewerContainer = browserDocument.createElement("div");
    browserDocument.body.append(viewerContainer);
    const viewerHandle = renderPdfViewer(viewerContainer, multiPageResult, {
      showSearch: true,
      showOutline: true,
    });
    viewerHandle.setView("page");
    viewerHandle.goToPage(2);
    const activePageLabel =
      viewerContainer.querySelector("[data-viewer-page-label='true']")?.textContent ?? null;
    viewerHandle.destroy();

    const checks = {
      identityMode: engine.identity.mode === "core",
      renderSupported: engine.identity.supportedStages.includes("render"),
      runtimeKind: simpleResult.runtime.kind === "web",
      simpleText:
        simpleResult.observation.value?.extractedText === "Hello Test Layer",
      simpleRenderHash:
        simpleResult.render.value?.renderHash.algorithm === "sha-256" &&
        simpleResult.render.value?.renderHash.hex.length === 64,
      javascriptRejected:
        javascriptAdmission.value?.decision === "rejected",
      javascriptFinding:
        javascriptAdmission.value?.featureFindings.some((finding) =>
          finding.kind === "javascript-actions"
        ) === true,
      multiPageCount: multiPageResult.render.value?.pages.length === 2,
      viewerPageNavigation: activePageLabel?.includes("Page 2") === true,
    };

    const failedChecks = Object.entries(checks)
      .filter(([, passed]) => passed === false)
      .map(([name]) => name);
    if (failedChecks.length > 0) {
      throw new Error(
        `Browser runtime tests failed: ${failedChecks.join(", ")}`,
      );
    }

    return {
      runtime: "web",
      browserName: activeBrowserName,
      checks,
      oracle: {
        simpleText: simpleResult.observation.value?.extractedText ?? null,
        simpleRenderHash: simpleResult.render.value?.renderHash.hex ?? null,
        javascriptDecision: javascriptAdmission.value?.decision ?? null,
        multiPageCount: multiPageResult.render.value?.pages.length ?? null,
      },
    };
  }, browserName);

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser.close();
  await new Promise((resolvePromise, rejectPromise) =>
    server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
  );
}

function readArg(prefix) {
  const arg = args.find((entry) => entry.startsWith(`${prefix}=`));
  return arg ? arg.slice(prefix.length + 1) : undefined;
}

function resolveBrowserLauncher(name) {
  if (name === "chromium") {
    return chromium;
  }
  if (name === "firefox") {
    return firefox;
  }
  if (name === "webkit") {
    return webkit;
  }

  throw new Error(`Unsupported browser runtime: ${name}`);
}

function createStaticServer(rootDir) {
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      const unsafePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
      const absolutePath = resolve(rootDir, `.${unsafePath}`);
      if (!absolutePath.startsWith(rootDir)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("forbidden");
        return;
      }

      if (pathname === "/index.html") {
        response.writeHead(200, { "content-type": MIME_TYPES[".html"] });
        response.end(
          "<!doctype html><meta charset=\"utf-8\"><title>pdf-engine-browser-runtime-tests</title>",
          "utf8",
        );
        return;
      }

      const content = await readFile(absolutePath);
      const contentType = MIME_TYPES[extname(absolutePath)] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": contentType });
      response.end(content);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "ENOENT") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }

      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("internal error");
    }
  });
}
