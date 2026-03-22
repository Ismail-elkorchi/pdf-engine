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
    const geometryBytes = await readBytes(
      "/test/fixtures/observed-path-geometry.pdf",
    );
    const renderTextBytes = await readBytes(
      "/test/fixtures/render-text-selection.pdf",
    );
    const renderResourceBytes = await readBytes(
      "/test/fixtures/render-resource-payloads.pdf",
    );
    const renderImageryBytes = await readBytes(
      "/test/fixtures/render-imagery-raster.pdf",
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
    const geometryResult = await engine.run({
      source: {
        bytes: geometryBytes,
        fileName: "observed-path-geometry.pdf",
      },
    });
    const renderTextResult = await engine.run({
      source: {
        bytes: renderTextBytes,
        fileName: "render-text-selection.pdf",
      },
    });
    const renderResourceResult = await engine.run({
      source: {
        bytes: renderResourceBytes,
        fileName: "render-resource-payloads.pdf",
      },
    });
    const renderImageryResult = await engine.run({
      source: {
        bytes: renderImageryBytes,
        fileName: "render-imagery-raster.pdf",
      },
    });
    const geometryPathMark =
      geometryResult.observation.value?.pages[0]?.marks.find((mark) =>
        mark.kind === "path"
      ) ?? null;
    const geometryPathCommand =
      geometryResult.render.value?.pages[0]?.displayList.commands.find((command) =>
        command.kind === "path"
      ) ?? null;
    const geometryPathSignature = geometryPathMark?.kind === "path"
      ? toGeometryPathSignature(geometryPathMark)
      : null;
    const geometryRenderPathSignature = geometryPathCommand?.kind === "path"
      ? toGeometryPathSignature(geometryPathCommand)
      : null;
    const renderTextSelectionSignature = toRenderTextSelectionSignature(
      renderTextResult.render.value?.pages[0]?.textIndex,
      renderTextResult.render.value?.pages[0]?.selectionModel,
    );
    const renderResourcePayloadSignature = toRenderResourcePayloadSignature(
      renderResourceResult.render.value,
    );
    const renderImagerySignature = await toRenderImagerySignature(
      renderImageryResult.render.value?.pages[0],
    );

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
      geometryPathPresent: geometryPathSignature !== null,
      geometryRenderPathPresent: geometryRenderPathSignature !== null,
      geometrySegmentsPreserved:
        geometryPathSignature !== null &&
        geometryRenderPathSignature !== null &&
        JSON.stringify(geometryPathSignature) ===
          JSON.stringify(geometryRenderPathSignature),
      geometryPointCount: geometryPathSignature?.pointCount === 15,
      geometryClosed: geometryPathSignature?.closed === true,
      geometryBlendMode:
        geometryPathSignature?.transparencyState?.blendMode === "multiply",
      renderTextIndexPresent: renderTextResult.render.value?.pages[0]?.textIndex.spans.length === 2,
      renderTextIndexText:
        renderTextResult.render.value?.pages[0]?.textIndex.text === "Heading Layer\nSelection Detail",
      renderSelectionUnitsPresent: renderTextResult.render.value?.pages[0]?.selectionModel.units.length === 2,
      renderSelectionMatchesSpans:
        renderTextSelectionSignature !== null &&
        renderTextSelectionSignature.spans.every((span, index) =>
          renderTextSelectionSignature.units[index]?.textSpanId === span.id
        ),
      renderResourcePayloadsPresent:
        renderResourceResult.render.value?.resourcePayloads.length === 2,
      renderFontPayloadAvailable:
        renderResourcePayloadSignature !== null &&
        renderResourcePayloadSignature.payloads.some((payload) =>
          payload.kind === "font" && payload.availability === "available"
        ),
      renderImagePayloadAvailable:
        renderResourcePayloadSignature !== null &&
        renderResourcePayloadSignature.payloads.some((payload) =>
          payload.kind === "image" && payload.availability === "available"
        ),
      renderFontPayloadLinked:
        renderResourcePayloadSignature !== null &&
        renderResourcePayloadSignature.textCommandFontPayloadIds.every((value) =>
          value !== null
        ),
      renderImagePayloadLinked:
        renderResourcePayloadSignature !== null &&
        renderResourcePayloadSignature.imageCommandPayloadIds.every((value) =>
          value !== null
        ),
      renderImageryPageBox:
        JSON.stringify(renderImageryResult.render.value?.pages[0]?.pageBox ?? null) ===
          JSON.stringify({ x: 10, y: 20, width: 200, height: 160 }),
      renderImagerySvgPresent:
        renderImageryResult.render.value?.pages[0]?.imagery?.svg.mimeType === "image/svg+xml",
      renderImageryRasterPresent:
        renderImageryResult.render.value?.pages[0]?.imagery?.raster.mimeType === "image/png",
      renderImageryPngSignature:
        JSON.stringify(Array.from(renderImageryResult.render.value?.pages[0]?.imagery?.raster.bytes.slice(0, 8) ?? [])) ===
          JSON.stringify([137, 80, 78, 71, 13, 10, 26, 10]),
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
        geometryPathSignature,
        geometryRenderHash: geometryResult.render.value?.renderHash.hex ?? null,
        renderTextIndexText: renderTextResult.render.value?.pages[0]?.textIndex.text ?? null,
        renderTextSelectionSignature,
        renderTextSelectionHash: renderTextResult.render.value?.pages[0]?.renderHash.hex ?? null,
        renderResourcePayloadSignature,
        renderResourcePayloadHash: renderResourceResult.render.value?.renderHash.hex ?? null,
        renderImagerySignature,
        renderImageryHash: renderImageryResult.render.value?.pages[0]?.renderHash.hex ?? null,
      },
    };

    function toGeometryPathSignature(pathLike) {
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

    function toRenderTextSelectionSignature(textIndex, selectionModel) {
      if (!textIndex || !selectionModel) {
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

    function toRenderResourcePayloadSignature(renderDocument) {
      if (!renderDocument) {
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

    async function toRenderImagerySignature(renderPage) {
      const svg = renderPage?.imagery?.svg;
      const raster = renderPage?.imagery?.raster;
      if (!svg || !raster) {
        return null;
      }

      return {
        pageBox: renderPage?.pageBox ?? null,
        svgMarkup: svg.markup,
        svgWidth: svg.width,
        svgHeight: svg.height,
        rasterWidth: raster.width,
        rasterHeight: raster.height,
        rasterPngSignature: Array.from(raster.bytes.slice(0, 8)),
        rasterByteLength: raster.bytes.byteLength,
        rasterSha256: await sha256Hex(raster.bytes),
      };
    }

    async function sha256Hex(bytes) {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest))
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    }
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
