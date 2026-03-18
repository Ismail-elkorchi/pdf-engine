import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, normalize, resolve } from "node:path";

import { chromium, firefox, webkit } from "playwright";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function parseArgs(argv) {
  let browserName = "chromium";
  let reportPath = "reports/smoke-browser-runtime.json";
  for (const arg of argv) {
    if (arg.startsWith("--browser=")) {
      browserName = arg.slice("--browser=".length);
      continue;
    }
    if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length);
    }
  }
  return { browserName, reportPath };
}

function resolveBrowserLauncher(browserName) {
  if (browserName === "chromium") {
    return chromium;
  }
  if (browserName === "firefox") {
    return firefox;
  }
  if (browserName === "webkit") {
    return webkit;
  }

  throw new Error(`Unsupported browser runtime: ${browserName}`);
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
        response.end("<!doctype html><meta charset=\"utf-8\"><title>pdf-engine-browser-smoke</title>", "utf8");
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

async function runBrowserSmoke(baseUrl, browserName) {
  const browserLauncher = resolveBrowserLauncher(browserName);
  const browser = await browserLauncher.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });

    const smoke = await page.evaluate(async () => {
      const { createPdfEngine } = await import("/dist/index.js");
      const { publicSmokeFixtures, decodeFixturePdfBytes } = await import("/scripts/smoke/fixture-data.mjs");

      const encodeText = (value) => new TextEncoder().encode(value);
      const joinBytes = (parts) => {
        const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
        const joined = new Uint8Array(totalLength);
        let offset = 0;

        for (const part of parts) {
          joined.set(part, offset);
          offset += part.byteLength;
        }

        return joined;
      };
      const sha256Hex = async (value) => {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      const buildPdfWithPageContents = (pageContents) => {
        const lines = [
          "%PDF-1.4",
          "1 0 obj",
          "<< /Type /Catalog /Pages 2 0 R >>",
          "endobj",
          "2 0 obj",
          `<< /Type /Pages /Kids [${pageContents.map((_, index) => `${String(3 + index * 2)} 0 R`).join(" ")}] /Count ${String(pageContents.length)} >>`,
          "endobj"
        ];

        for (const [index, contentStreamText] of pageContents.entries()) {
          const pageObjectNumber = 3 + index * 2;
          const contentObjectNumber = pageObjectNumber + 1;
          lines.push(
            `${String(pageObjectNumber)} 0 obj`,
            `<< /Type /Page /Parent 2 0 R /Contents ${String(contentObjectNumber)} 0 R >>`,
            "endobj",
            `${String(contentObjectNumber)} 0 obj`,
            `<< /Length ${String(encodeText(contentStreamText).byteLength)} >>`,
            "stream",
            contentStreamText,
            "endstream",
            "endobj"
          );
        }

        lines.push(
          "xref",
          `0 ${String(3 + pageContents.length * 2)}`,
          "0000000000 65535 f",
          "trailer",
          `<< /Root 1 0 R /Size ${String(3 + pageContents.length * 2)} >>`,
          "startxref",
          "__STARTXREF__",
          "%%EOF",
          ""
        );

        const template = lines.join("\n");
        const xrefOffset = template.indexOf("\nxref\n") + 1;
        return encodeText(template.replace("__STARTXREF__", String(xrefOffset)));
      };
      const verticalWordColumnsPdf = buildPdfWithPageContents([
        [
          "BT",
          "1 0 0 1 90.264 697.18 Tm",
          "(Test) Tj",
          "1 0 0 1 117.74 681.82 Tm",
          "(Vertical) Tj",
          "1 0 0 1 145.34 685.9 Tm",
          "(Layout) Tj",
          "ET"
        ].join("\n")
      ]);
      const sectionHeadingPdf = buildPdfWithPageContents([
        [
          "BT",
          "/F1 18 Tf",
          "1 0 0 1 72 720 Tm",
          "(1 INTRODUCTION) Tj",
          "1 0 0 1 72 700 Tm",
          "(Retrieval Architecture) Tj",
          "/F1 12 Tf",
          "1 0 0 1 72 670 Tm",
          "(Search engine architectures often follow a) Tj",
          "1 0 0 1 278 670 Tm",
          "(cascading architecture.) Tj",
          "1 0 0 1 72 642 Tm",
          "(Second paragraph starts here.) Tj",
          "ET"
        ].join("\n")
      ]);
      const buildDelayedContentPdf = () => {
        const delayedContentStreamText = [
          "BT",
          "(Delayed Content) Tj",
          "ET"
        ].join("\n");
        const fillerText = "% filler block to force full structure recovery\n".repeat(34000);
        const template = [
          "%PDF-1.4",
          "1 0 obj",
          "<< /Type /Catalog /Pages 2 0 R >>",
          "endobj",
          "2 0 obj",
          "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
          "endobj",
          "3 0 obj",
          "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
          "endobj",
          fillerText,
          "4 0 obj",
          `<< /Length ${String(encodeText(delayedContentStreamText).byteLength)} >>`,
          "stream",
          delayedContentStreamText,
          "endstream",
          "endobj",
          "xref",
          "0 5",
          "0000000000 65535 f",
          "trailer",
          "<< /Root 1 0 R /Size 5 >>",
          "startxref",
          "__DELAYED_STARTXREF__",
          "%%EOF",
          ""
        ].join("\n");
        const startXref = template.indexOf("\nxref\n0 5") + 1;
        return encodeText(template.replace("__DELAYED_STARTXREF__", String(startXref)));
      };
      const gridTablePdf = buildPdfWithPageContents([
        [
          "BT",
          "/F1 16 Tf",
          "1 0 0 1 72 720 Tm",
          "(Quarter) Tj",
          "1 0 0 1 220 720 Tm",
          "(Revenue) Tj",
          "1 0 0 1 360 720 Tm",
          "(Profit) Tj",
          "/F1 12 Tf",
          "1 0 0 1 72 690 Tm",
          "(Q1) Tj",
          "1 0 0 1 220 690 Tm",
          "($10) Tj",
          "1 0 0 1 360 690 Tm",
          "($2) Tj",
          "1 0 0 1 72 670 Tm",
          "(Q2) Tj",
          "1 0 0 1 220 670 Tm",
          "($12) Tj",
          "1 0 0 1 360 670 Tm",
          "($3) Tj",
          "ET",
        ].join("\n"),
      ]);
      const denseGridTablePdf = buildPdfWithPageContents([
        [
          "BT",
          "/F1 12 Tf",
          "1 0 0 1 72 720 Tm",
          "(Code) Tj",
          "1 0 0 1 180 720 Tm",
          "(Label) Tj",
          "1 0 0 1 320 720 Tm",
          "(Amount) Tj",
          "1 0 0 1 72 711 Tm",
          "(100040) Tj",
          "1 0 0 1 180 711 Tm",
          "(Base Salary) Tj",
          "1 0 0 1 320 711 Tm",
          "(1820.04) Tj",
          "1 0 0 1 72 702 Tm",
          "(109510) Tj",
          "1 0 0 1 180 702 Tm",
          "(Hours 25%) Tj",
          "1 0 0 1 320 702 Tm",
          "(259.95) Tj",
          "ET"
        ].join("\n")
      ]);
      const singleByteEncodedContentStreamText = [
        "BT",
        "/F1 12 Tf",
        "<01020304050605070806090A> Tj",
        "ET"
      ].join("\n");
      const singleByteEncodedPdfTemplate = [
        "%PDF-1.4",
        "1 0 obj",
        "<< /Type /Catalog /Pages 2 0 R >>",
        "endobj",
        "2 0 obj",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "endobj",
        "3 0 obj",
        "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        "endobj",
        "4 0 obj",
        `<< /Length ${String(encodeText(singleByteEncodedContentStreamText).byteLength)} >>`,
        "stream",
        singleByteEncodedContentStreamText,
        "endstream",
        "endobj",
        "5 0 obj",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 6 0 R >>",
        "endobj",
        "6 0 obj",
        "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /E /n /c /o /d /e 7 /space /T 9 /x /t] >>",
        "endobj",
        "xref",
        "0 7",
        "0000000000 65535 f",
        "trailer",
        "<< /Root 1 0 R /Size 7 >>",
        "startxref",
        "__SINGLE_BYTE_STARTXREF__",
        "%%EOF",
        ""
      ].join("\n");
      const singleByteStartXref = singleByteEncodedPdfTemplate.indexOf("xref\n0 7");
      const singleByteEncodedPdf = encodeText(
        singleByteEncodedPdfTemplate.replace("__SINGLE_BYTE_STARTXREF__", String(singleByteStartXref))
      );
      const delayedContentPdf = buildDelayedContentPdf();

      const plainPdfTemplate = [
        "%PDF-1.4",
        "1 0 obj",
        "<< /Type /Catalog /Pages 2 0 R >>",
        "endobj",
        "2 0 obj",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "endobj",
        "3 0 obj",
        "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
        "endobj",
        "4 0 obj",
        "<< /Length 24 >>",
        "stream",
        "BT",
        "(Browser Hello) Tj",
        "ET",
        "endstream",
        "endobj",
        "xref",
        "0 5",
        "0000000000 65535 f",
        "trailer",
        "<< /Root 1 0 R /Size 5 >>",
        "startxref",
        "__STARTXREF__",
        "%%EOF",
        ""
      ].join("\n");
      const plainStartXref = plainPdfTemplate.indexOf("xref\n0 5");
      const plainPdf = plainPdfTemplate.replace("__STARTXREF__", String(plainStartXref));

      const flateStreamBytes = decodeFixturePdfBytes("eJxzCuHS8EjNyclXcMtJLEnVVAjJ4nIN4QIAUIcGfQ==");
      const flatePdfPrefix = [
        "%PDF-1.4",
        "1 0 obj",
        "<< /Type /Catalog /Pages 2 0 R >>",
        "endobj",
        "2 0 obj",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "endobj",
        "3 0 obj",
        "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
        "endobj",
        "4 0 obj",
        `<< /Length ${String(flateStreamBytes.byteLength)} /Filter /FlateDecode >>`,
        "stream"
      ].join("\n") + "\n";
      const flatePdfMiddle = "\nendstream\nendobj\n";
      const flateXrefOffset = encodeText(flatePdfPrefix).byteLength +
        flateStreamBytes.byteLength +
        encodeText(flatePdfMiddle).byteLength;
      const flatePdfSuffix = [
        "xref",
        "0 5",
        "0000000000 65535 f",
        "trailer",
        "<< /Root 1 0 R /Size 5 >>",
        "startxref",
        String(flateXrefOffset),
        "%%EOF",
        ""
      ].join("\n");
      const flatePdf = joinBytes([
        encodeText(flatePdfPrefix),
        flateStreamBytes,
        encodeText(flatePdfMiddle),
        encodeText(flatePdfSuffix)
      ]);

      const engine = createPdfEngine();
      try {
        const plainResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: encodeText(plainPdf)
          }
        });
        const flateResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: flatePdf
          }
        });
        const identityHCidFontResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: decodeFixturePdfBytes(publicSmokeFixtures.identityHCidFont.bytesBase64)
          }
        });
        const identityVCidFontResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: decodeFixturePdfBytes(publicSmokeFixtures.identityVCidFont.bytesBase64)
          }
        });
        const verticalWordColumnsResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: verticalWordColumnsPdf
          }
        });
        const sectionHeadingResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: sectionHeadingPdf
          }
        });
        const gridTableResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: gridTablePdf
          }
        });
        const denseGridTableResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: denseGridTablePdf
          }
        });
        const delayedContentResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: delayedContentPdf
          }
        });
        const singleByteEncodedResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: singleByteEncodedPdf
          }
        });

        const checks = {
          exportsPresent: typeof createPdfEngine === "function",
          runtime: plainResult.runtime.kind === "web",
          supportedRuntimeClaim: engine.identity.supportedRuntimes.includes("web"),
          plainText: plainResult.observation.value?.extractedText === "Browser Hello",
          flateText: flateResult.observation.value?.extractedText === "Hello Flate",
          observationStrategy: plainResult.observation.value?.strategy === "decoded-text-operators",
          flateDecoded: flateResult.ir.value?.decodedStreams === true,
          identityHMarkers: publicSmokeFixtures.identityHCidFont.expectedMarkers.every((marker) =>
            identityHCidFontResult.observation.value?.extractedText.includes(marker)
          ),
          identityVMarkers: publicSmokeFixtures.identityVCidFont.expectedMarkers.every((marker) =>
            identityVCidFontResult.observation.value?.extractedText.includes(marker)
          ),
          identityHProvenance: identityHCidFontResult.observation.value?.pages.some((page) =>
            page.runs.some((run) => run.unicodeMappingSource === "cid-collection-ucs2" && run.textEncodingKind === "cid")
          ) === true,
          identityVProvenance: identityVCidFontResult.observation.value?.pages.some((page) =>
            page.runs.some((run) => run.unicodeMappingSource === "cid-collection-ucs2" && run.textEncodingKind === "cid")
          ) === true,
          identityHLimitCleared: !identityHCidFontResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
          identityVLimitCleared: !identityVCidFontResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
          verticalObservedMode: verticalWordColumnsResult.observation.value?.pages[0]?.runs.every((run) => run.writingMode === "vertical") === true,
          verticalLayoutMode: verticalWordColumnsResult.layout.value?.pages[0]?.blocks.every((block) => block.writingMode === "vertical") === true,
          verticalLayoutOrder: verticalWordColumnsResult.layout.value?.pages[0]?.blocks.map((block) => block.text).join(" ") === "Layout Vertical Test",
          sectionHeadingRole: sectionHeadingResult.layout.value?.pages[0]?.blocks[0]?.role === "heading",
          sectionHeadingText: sectionHeadingResult.layout.value?.pages[0]?.blocks[0]?.text === "1 INTRODUCTION Retrieval Architecture",
          sectionInlineFlow:
            sectionHeadingResult.layout.value?.pages[0]?.blocks[1]?.text ===
            "Search engine architectures often follow a cascading architecture.",
          sectionParagraphBreak: sectionHeadingResult.layout.value?.pages[0]?.blocks[2]?.startsParagraph === true,
          gridTableProjected: gridTableResult.knowledge.value?.tables.length === 1,
          gridTableHeuristic: gridTableResult.knowledge.value?.tables[0]?.heuristic === "layout-grid",
          gridTableHeaders: gridTableResult.knowledge.value?.tables[0]?.headers?.join(",") === "Quarter,Revenue,Profit",
          gridTableCell: gridTableResult.knowledge.value?.tables[0]?.cells.some((cell) =>
            cell.rowIndex === 1 && cell.columnIndex === 1 && cell.text === "$10"
          ) === true,
          gridTableCitations: gridTableResult.knowledge.value?.tables[0]?.cells.every((cell) =>
            cell.citations.length > 0
          ) === true,
          gridTableLimit: gridTableResult.knowledge.value?.knownLimits.includes("table-projection-heuristic") === true,
          denseGridProjected: denseGridTableResult.knowledge.value?.tables.length === 1,
          denseGridHeaders: denseGridTableResult.knowledge.value?.tables[0]?.headers?.join(",") === "Code,Label,Amount",
          denseGridFirstRow: denseGridTableResult.knowledge.value?.tables[0]?.cells.some((cell) =>
            cell.rowIndex === 1 && cell.columnIndex === 1 && cell.text === "Base Salary"
          ) === true,
          denseGridSecondRow: denseGridTableResult.knowledge.value?.tables[0]?.cells.some((cell) =>
            cell.rowIndex === 2 && cell.columnIndex === 1 && cell.text === "Hours 25%"
          ) === true,
          delayedContentText: delayedContentResult.observation.value?.extractedText === "Delayed Content",
          delayedContentOrder: delayedContentResult.observation.value?.pages[0]?.resolutionMethod === "page-tree",
          singleByteText: singleByteEncodedResult.observation.value?.extractedText === "Encoded Text",
          singleByteMapping: singleByteEncodedResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource === "font-encoding",
          singleByteLimitCleared:
            !singleByteEncodedResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented")
        };
        const stablePayload = {
          runtime: plainResult.runtime.kind,
          plainText: plainResult.observation.value?.extractedText ?? null,
          flateText: flateResult.observation.value?.extractedText ?? null,
          strategy: plainResult.observation.value?.strategy ?? null,
          identityHText: identityHCidFontResult.observation.value?.extractedText ?? null,
          identityVText: identityVCidFontResult.observation.value?.extractedText ?? null,
          verticalOrder: verticalWordColumnsResult.layout.value?.pages[0]?.blocks.map((block) => block.text).join(" ") ?? null,
          sectionHeadingText: sectionHeadingResult.layout.value?.pages[0]?.blocks[0]?.text ?? null,
          sectionInlineFlow: sectionHeadingResult.layout.value?.pages[0]?.blocks[1]?.text ?? null,
          gridTableHeaders: gridTableResult.knowledge.value?.tables[0]?.headers?.join(",") ?? null,
          denseGridHeaders: denseGridTableResult.knowledge.value?.tables[0]?.headers?.join(",") ?? null,
          delayedContentText: delayedContentResult.observation.value?.extractedText ?? null,
          singleByteText: singleByteEncodedResult.observation.value?.extractedText ?? null
        };

        return {
          ok: Object.values(checks).every((value) => value === true),
          checks,
          hash: await sha256Hex(JSON.stringify(stablePayload)),
          userAgent: globalThis.navigator.userAgent
        };
      } finally {
        await engine.dispose();
      }
    });

    return {
      ok: smoke.ok,
      browserName,
      checks: smoke.checks,
      hash: smoke.hash,
      userAgent: smoke.userAgent,
      version: browser.version()
    };
  } finally {
    await page.close();
    await browser.close();
  }
}

async function main() {
  const { browserName, reportPath } = parseArgs(process.argv.slice(2));
  const rootDir = resolve(".");
  const server = createStaticServer(rootDir);

  await new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve browser smoke server address");
    }

    const smoke = await runBrowserSmoke(`http://127.0.0.1:${String(address.port)}`, browserName);
    const report = {
      suite: "browser-runtime-smoke",
      timestamp: new Date().toISOString(),
      browser: smoke.browserName,
      runtime: "browser",
      ok: smoke.ok,
      version: smoke.version,
      userAgent: smoke.userAgent,
      hash: smoke.hash,
      determinismHash: smoke.hash,
      checks: smoke.checks
    };

    const reportAbsolutePath = resolve(reportPath);
    await mkdir(dirname(reportAbsolutePath), { recursive: true });
    await writeFile(reportAbsolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    if (!report.ok) {
      throw new Error("browser runtime smoke checks failed");
    }
    process.stdout.write(`browser runtime smoke passed for ${browserName}: ${reportPath}\n`);
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
