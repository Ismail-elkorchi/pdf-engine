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
      const { renderPdfViewer } = await import("/dist/viewer.js");
      const { decodePdfStreamBytes } = await import("/dist/stream-decode.js");
      const { publicSmokeFixtures, decodeFixturePdfBytes } = await import("/scripts/smoke/fixture-data.mjs");
      const encryptedStandardTextFixture = publicSmokeFixtures.encryptedStandardText;
      const encryptedStandardTextFixtureBytes = decodeFixturePdfBytes(encryptedStandardTextFixture.bytesBase64);

      const encodeText = (value) => new TextEncoder().encode(value);
      const decodeHex = (value) => {
        if (value.length % 2 !== 0) {
          throw new Error("Hex fixture text must contain an even number of digits.");
        }

        const decoded = new Uint8Array(value.length / 2);
        for (let index = 0; index < value.length; index += 2) {
          decoded[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
        }
        return decoded;
      };
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
      const buildFilteredContentStreamPdfBytes = ({ streamBytes, filterValue }) => {
        const prefix = [
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
          `<< /Length ${String(streamBytes.byteLength)} /Filter ${filterValue} >>`,
          "stream"
        ].join("\n") + "\n";
        const middle = "\nendstream\nendobj\n";
        const xrefOffset = encodeText(prefix).byteLength + streamBytes.byteLength + encodeText(middle).byteLength;
        const suffix = [
          "xref",
          "0 5",
          "0000000000 65535 f",
          "trailer",
          "<< /Root 1 0 R /Size 5 >>",
          "startxref",
          String(xrefOffset),
          "%%EOF",
          ""
        ].join("\n");

        return joinBytes([encodeText(prefix), streamBytes, encodeText(middle), encodeText(suffix)]);
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
      const coverMatterPdf = buildPdfWithPageContents([
        [
          "BT",
          "/F1 18 Tf",
          "1 0 0 1 72 720 Tm",
          "(The Crazy Ones) Tj",
          "/F1 12 Tf",
          "1 0 0 1 72 700 Tm",
          "(October 14, 1998) Tj",
          "1 0 0 1 72 666 Tm",
          "(Heres to the crazy ones.) Tj",
          "ET"
        ].join("\n")
      ]);
      const viewerNavigationPdf = buildPdfWithPageContents([
        [
          "BT",
          "/F1 18 Tf",
          "1 0 0 1 72 720 Tm",
          "(First Page Summary) Tj",
          "/F1 12 Tf",
          "1 0 0 1 72 692 Tm",
          "(First page narrative block.) Tj",
          "ET"
        ].join("\n"),
        [
          "BT",
          "/F1 18 Tf",
          "1 0 0 1 72 720 Tm",
          "(Second Page Overview) Tj",
          "/F1 12 Tf",
          "1 0 0 1 72 692 Tm",
          "(Second page body block.) Tj",
          "ET"
        ].join("\n"),
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
      const asciiHexPdf = buildFilteredContentStreamPdfBytes({
        streamBytes: encodeText("42540A2842726F777365722041534349494845582920546A0A4554>"),
        filterValue: "/ASCIIHexDecode"
      });
      const predictorChainAscii85Bytes = Uint8Array.from(
        globalThis.atob("R2FyOGMnJiJcMVUlSi5GbFMkKjNiai4pcmZicDAkSTVfYUJAKksyXktQMVptfj4="),
        (character) => character.charCodeAt(0),
      );
      const toUnicodeLzwBytes = Uint8Array.from(
        globalThis.atob("gAvIZJIhJNxpOggF5QORvMZTMsJMxpNxkORlOZvOpyMZlEBiMpnigKGIyEBkNJjhMgkRuBUsihjNphOAKgUEKZ5OZ0MptgxmN4gHg8hRSkJpnZyPIgFBBMhvkAphRPORkMpyihnphVIZTqQvKZ1OBwNk9MpuhIwEA+H0nMpmmxDJs0JxhNseF9OqBlFpJq1ohB5FtcKduuECuZwKh5OEek1WuAxj9HNxjN9WOZwMMdORhNxnMoKHgwGFtHhmMw+BVnMmWzGazme0AKk0wNxiMxjNBhOWiGQx02k3+qHg0HHBGHG1Ws3G63kkyct3Gdz+hHg2GumG2poWk7HLivT2Wh1kymgKuV0u0eMcbi9olEqhXpOGGilXjEajkeOBvmrWNWiqAg=="),
        (character) => character.charCodeAt(0),
      );
      const ccittGroup4Bytes = Uint8Array.from(
        globalThis.atob("JqiOiOglABAB"),
        (character) => character.charCodeAt(0),
      );
      const chainedFilterPdf = buildFilteredContentStreamPdfBytes({
        streamBytes: encodeText("Garg^iR2ZpatGDC/Q-Q58Bf:N:!loGal7=M!<@$9#U9~>"),
        filterValue: "[/ASCII85Decode /FlateDecode]"
      });
      const runLengthPdf = buildFilteredContentStreamPdfBytes({
        streamBytes: decodeHex("1B42540A2842726F777365722052756E4C656E6774682920546A0A455480"),
        filterValue: "/RunLengthDecode"
      });

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
        const asciiHexResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: asciiHexPdf
          }
        });
        const chainedFilterResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: chainedFilterPdf
          }
        });
        const runLengthResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: runLengthPdf
          }
        });
        const chainedPredictorDecodeResult = await decodePdfStreamBytes(
          predictorChainAscii85Bytes,
          "[/ASCII85Decode /FlateDecode]",
          "[null << /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 26 >>]",
        );
        const lzwDecodeResult = await decodePdfStreamBytes(toUnicodeLzwBytes, "/LZWDecode");
        const ccittDecodeResult = await decodePdfStreamBytes(
          ccittGroup4Bytes,
          "/CCITTFaxDecode",
          "<< /K -1 /Columns 8 /Rows 1 /EndOfBlock false /BlackIs1 true >>",
        );
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
        const coverMatterResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: coverMatterPdf
          }
        });
        const viewerNavigationResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: viewerNavigationPdf
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
        const stackedHeaderTableResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: decodeFixturePdfBytes(
              await (await fetch("/scripts/smoke/fixtures/stacked-header-table.base64.txt")).text()
            )
          }
        });
        const fieldValueFormResult = await engine.run({
          source: {
            kind: "bytes",
            bytes: decodeFixturePdfBytes(
              await (await fetch("/scripts/smoke/fixtures/field-value-form.base64.txt")).text()
            )
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
        const browserEncryptedWithoutPassword = await engine.observe({
          source: {
            kind: "bytes",
            bytes: encryptedStandardTextFixtureBytes,
            fileName: encryptedStandardTextFixture.fileName,
            mediaType: "application/pdf"
          }
        });
        const browserEncryptedWrongPassword = await engine.observe({
          source: {
            kind: "bytes",
            bytes: encryptedStandardTextFixtureBytes,
            fileName: encryptedStandardTextFixture.fileName,
            mediaType: "application/pdf"
          },
          passwordProvider: () => "wrong-password"
        });
        const browserEncryptedWithPassword = await engine.observe({
          source: {
            kind: "bytes",
            bytes: encryptedStandardTextFixtureBytes,
            fileName: encryptedStandardTextFixture.fileName,
            mediaType: "application/pdf"
          },
          passwordProvider: () => encryptedStandardTextFixture.userPassword
        });
        const browserEncryptedAdmission = await engine.admit({
          source: {
            kind: "bytes",
            bytes: encryptedStandardTextFixtureBytes,
            fileName: encryptedStandardTextFixture.fileName,
            mediaType: "application/pdf"
          },
          passwordProvider: () => encryptedStandardTextFixture.userPassword
        });
        const viewerContainer = globalThis.document.createElement("div");
        globalThis.document.body.append(viewerContainer);

        const readBlockTexts = () => Array.from(
          viewerContainer.querySelectorAll(".pdf-engine-viewer__block-text"),
          (element) => element.textContent ?? "",
        );
        const findButton = (label) => Array.from(viewerContainer.querySelectorAll("button")).find(
          (button) => button.textContent === label,
        ) ?? null;
        const readTableHeaders = () => Array.from(
          viewerContainer.querySelectorAll(".pdf-engine-viewer__table th"),
          (element) => element.textContent ?? "",
        );
        const readTableCells = () => Array.from(
          viewerContainer.querySelectorAll(".pdf-engine-viewer__table td"),
          (element) => element.textContent ?? "",
        );
        const readSearchHighlights = () =>
          Array.from(viewerContainer.querySelectorAll(".pdf-engine-viewer__highlight")).length;

        const viewerHandle = renderPdfViewer(viewerContainer, viewerNavigationResult, {
          initialPage: 2,
          showBlockOutlines: true,
          showChunkAnchors: true,
          showSearch: true,
          showOutline: true,
        });
        const initialViewerLabel =
          viewerContainer.querySelector("[data-viewer-page-label='true']")?.textContent ?? null;
        const initialViewerBlocks = readBlockTexts();
        const initialPreviousDisabled = findButton("Previous")?.disabled ?? null;
        const initialNextDisabled = findButton("Next")?.disabled ?? null;
        const initialOutlineCount =
          viewerContainer.querySelector("[data-viewer-outline-count]")?.dataset.viewerOutlineCount ?? null;

        viewerHandle.goToPage(1);
        const navigatedViewerLabel =
          viewerContainer.querySelector("[data-viewer-page-label='true']")?.textContent ?? null;
        const navigatedViewerBlocks = readBlockTexts();
        const navigatedPreviousDisabled = findButton("Previous")?.disabled ?? null;
        const navigatedNextDisabled = findButton("Next")?.disabled ?? null;

        viewerHandle.setView("reader");
        viewerHandle.setSearchQuery("Second");
        const readerViewerLabel =
          viewerContainer.querySelector("[data-viewer-page-label='true']")?.textContent ?? null;
        const readerViewerMode =
          viewerContainer.querySelector("[data-viewer-current-view]")?.dataset.viewerCurrentView ?? null;
        const readerViewerPageCount =
          viewerContainer.querySelector("[data-viewer-reader-page-count]")?.dataset.viewerReaderPageCount ?? null;
        const readerSearchCount =
          viewerContainer.querySelector("[data-viewer-search-count]")?.dataset.viewerSearchCount ?? null;
        const readerOutlineCount =
          viewerContainer.querySelector("[data-viewer-outline-count]")?.dataset.viewerOutlineCount ?? null;
        const readerSearchHighlights = readSearchHighlights();
        const firstPageChunkId = viewerNavigationResult.knowledge.value?.chunks.find((chunk) =>
          chunk.pageNumbers.includes(1)
        )?.id ?? null;
        if (firstPageChunkId) {
          viewerHandle.goToChunk(firstPageChunkId);
        }
        const readerChunkLabel =
          viewerContainer.querySelector("[data-viewer-page-label='true']")?.textContent ?? null;
        const activeChunkId =
          viewerContainer.querySelector("[data-viewer-active-chunk]")?.dataset.viewerActiveChunk ?? null;

        viewerHandle.setView("page");
        viewerHandle.update(denseGridTableResult, { showTables: true, showSearch: true, showOutline: true });
        const updatedViewerLabel =
          viewerContainer.querySelector("[data-viewer-page-label='true']")?.textContent ?? null;
        const updatedViewerBlocks = readBlockTexts();
        const updatedViewerTableCount =
          viewerContainer.querySelector("[data-viewer-table-count]")?.dataset.viewerTableCount ?? null;
        const updatedViewerChunkCount =
          viewerContainer.querySelector("[data-viewer-chunk-count]")?.dataset.viewerChunkCount ?? null;
        const updatedViewerBlockCount =
          viewerContainer.querySelector("[data-viewer-block-count]")?.dataset.viewerBlockCount ?? null;
        const updatedViewerHeaders = readTableHeaders();
        const updatedViewerCells = readTableCells();
        const updatedViewerOutlineCount =
          viewerContainer.querySelector("[data-viewer-outline-count]")?.dataset.viewerOutlineCount ?? null;
        const updatedViewerSearchCount =
          viewerContainer.querySelector("[data-viewer-search-count]")?.dataset.viewerSearchCount ?? null;

        viewerHandle.destroy();
        const viewerDestroyed = viewerContainer.childElementCount === 0;
        viewerContainer.remove();
        const browserEncryptedFeatureSignals = browserEncryptedAdmission.value?.featureSignals ?? [];
        const browserEncryptionSignal = browserEncryptedFeatureSignals.find((signal) => signal.kind === "encryption");
        const browserObjectStreamSignal = browserEncryptedFeatureSignals.find((signal) => signal.kind === "object-streams");
        const browserXrefStreamSignal = browserEncryptedFeatureSignals.find((signal) => signal.kind === "xref-streams");

        const checks = {
          exportsPresent: typeof createPdfEngine === "function",
          viewerExportPresent: typeof renderPdfViewer === "function",
          runtime: plainResult.runtime.kind === "web",
          supportedRuntimeClaim: engine.identity.supportedRuntimes.includes("web"),
          plainText: plainResult.observation.value?.extractedText === "Browser Hello",
          flateText: flateResult.observation.value?.extractedText === "Hello Flate",
          asciiHexText: asciiHexResult.observation.value?.extractedText === "Browser ASCIIHEX",
          asciiHexDecoded:
            asciiHexResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamDecodeState ===
            "decoded",
          chainedText: chainedFilterResult.observation.value?.extractedText === "Browser Chained",
          chainedFilters:
            chainedFilterResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamFilterNames?.join(",") ===
            "ASCII85Decode,FlateDecode",
          predictorChainedDecode:
            chainedPredictorDecodeResult.state === "decoded" &&
            new TextDecoder().decode(chainedPredictorDecodeResult.decodedBytes ?? new Uint8Array()) === "BT\n(Predictor Hello) Tj\nET",
          lzwDecode:
            lzwDecodeResult.state === "decoded" &&
            new TextDecoder().decode(lzwDecodeResult.decodedBytes ?? new Uint8Array()).includes("beginbfchar"),
          ccittDecode:
            ccittDecodeResult.state === "decoded" &&
            Array.from(ccittDecodeResult.decodedBytes ?? [], (byte) => byte.toString(16).padStart(2, "0")).join("") === "aa",
          runLengthText: runLengthResult.observation.value?.extractedText === "Browser RunLength",
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
          coverMatterTitleRole: coverMatterResult.layout.value?.pages[0]?.blocks[0]?.role === "heading",
          coverMatterDateRole: coverMatterResult.layout.value?.pages[0]?.blocks[1]?.role === "heading",
          coverMatterBodyRole: coverMatterResult.layout.value?.pages[0]?.blocks[2]?.role === "body",
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
          stackedHeaderProjected: stackedHeaderTableResult.knowledge.value?.tables.length === 1,
          stackedHeaderHeuristic:
            stackedHeaderTableResult.knowledge.value?.tables[0]?.heuristic === "stacked-header-sequence",
          stackedHeaderHeaders:
            stackedHeaderTableResult.knowledge.value?.tables[0]?.headers?.join(",") ===
            "Qty,Description with linebreak,Price,Amount",
          stackedHeaderCell: stackedHeaderTableResult.knowledge.value?.tables[0]?.cells.some((cell) =>
            cell.rowIndex === 2 && cell.columnIndex === 1 && cell.text === "Unicorn"
          ) === true,
          fieldValueProjected: fieldValueFormResult.knowledge.value?.tables.length === 1,
          fieldValueHeuristic: fieldValueFormResult.knowledge.value?.tables[0]?.heuristic === "field-value-form",
          fieldValueHeaders: fieldValueFormResult.knowledge.value?.tables[0]?.headers?.join(",") === "Field,Value",
          fieldValueCell: fieldValueFormResult.knowledge.value?.tables[0]?.cells.some((cell) =>
            cell.rowIndex === 3 && cell.columnIndex === 1 && cell.text === "MBL-SF424Family-AllForms"
          ) === true,
          delayedContentText: delayedContentResult.observation.value?.extractedText === "Delayed Content",
          delayedContentOrder: delayedContentResult.observation.value?.pages[0]?.resolutionMethod === "page-tree",
          singleByteText: singleByteEncodedResult.observation.value?.extractedText === "Encoded Text",
          singleByteMapping: singleByteEncodedResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource === "font-encoding",
          singleByteLimitCleared:
            !singleByteEncodedResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
          encryptedWithoutPassword: browserEncryptedWithoutPassword.status === "blocked",
          encryptedPasswordRequired:
            browserEncryptedWithoutPassword.diagnostics.some((diagnostic) => diagnostic.code === "password-required"),
          encryptedWrongPassword: browserEncryptedWrongPassword.status === "blocked",
          encryptedPasswordInvalid:
            browserEncryptedWrongPassword.diagnostics.some((diagnostic) => diagnostic.code === "password-invalid"),
          encryptedWithPassword:
            browserEncryptedWithPassword.status === "partial" || browserEncryptedWithPassword.status === "completed",
          encryptedText: browserEncryptedWithPassword.value?.extractedText === encryptedStandardTextFixture.expectedText,
          encryptedLimitCleared:
            !browserEncryptedWithPassword.diagnostics.some((diagnostic) => diagnostic.code === "decryption-not-implemented"),
          encryptedAdmission: browserEncryptedAdmission.status === "completed",
          encryptedObjectEvidence:
            browserEncryptionSignal?.detected === true &&
            browserEncryptionSignal.evidenceSource === "object" &&
            browserEncryptionSignal.objectRef?.objectNumber === 12,
          objectStreamEvidence:
            browserObjectStreamSignal?.detected === true &&
            browserObjectStreamSignal.evidenceSource === "object" &&
            browserObjectStreamSignal.objectRef?.objectNumber === 8,
          xrefStreamEvidence:
            browserXrefStreamSignal?.detected === true &&
            browserXrefStreamSignal.evidenceSource === "object" &&
            browserXrefStreamSignal.objectRef?.objectNumber === 13,
          viewerInitialPage: initialViewerLabel === "Page 2 of 2",
          viewerInitialBlocks: initialViewerBlocks.some((text) => text.includes("Second Page Overview")),
          viewerInitialButtons: initialPreviousDisabled === false && initialNextDisabled === true,
          viewerInitialOutline: initialOutlineCount === "2",
          viewerNavigatedPage: navigatedViewerLabel === "Page 1 of 2",
          viewerNavigatedBlocks: navigatedViewerBlocks.some((text) => text.includes("First Page Summary")),
          viewerNavigatedButtons: navigatedPreviousDisabled === true && navigatedNextDisabled === false,
          viewerReaderMode: readerViewerMode === "reader",
          viewerReaderLabel: readerViewerLabel === "Reader view • page 1 of 2",
          viewerReaderPages: readerViewerPageCount === "2",
          viewerReaderSearch: Number(readerSearchCount ?? "0") >= 2 && readerSearchHighlights >= 2,
          viewerReaderOutline: readerOutlineCount === "2",
          viewerGoToChunk: readerChunkLabel === "Reader view • page 1 of 2" && activeChunkId === firstPageChunkId,
          viewerUpdatePreservedPage: updatedViewerLabel === "Page 1 of 1",
          viewerUpdatePreservedPanels:
            updatedViewerChunkCount !== null &&
            updatedViewerBlockCount !== null &&
            updatedViewerOutlineCount !== null &&
            updatedViewerSearchCount !== null,
          viewerUpdatedBlocks: updatedViewerBlocks.some((text) => text.includes("Code")) === true,
          viewerTableCount: updatedViewerTableCount === "1",
          viewerTableHeaders: updatedViewerHeaders.join(",") === "Code,Label,Amount",
          viewerTableCells:
            updatedViewerCells.includes("Base Salary") && updatedViewerCells.includes("Hours 25%"),
          viewerDestroy: viewerDestroyed === true,
        };
        const stablePayload = {
          runtime: plainResult.runtime.kind,
          plainText: plainResult.observation.value?.extractedText ?? null,
          flateText: flateResult.observation.value?.extractedText ?? null,
          asciiHexText: asciiHexResult.observation.value?.extractedText ?? null,
          chainedText: chainedFilterResult.observation.value?.extractedText ?? null,
          runLengthText: runLengthResult.observation.value?.extractedText ?? null,
          strategy: plainResult.observation.value?.strategy ?? null,
          identityHText: identityHCidFontResult.observation.value?.extractedText ?? null,
          identityVText: identityVCidFontResult.observation.value?.extractedText ?? null,
          verticalOrder: verticalWordColumnsResult.layout.value?.pages[0]?.blocks.map((block) => block.text).join(" ") ?? null,
          sectionHeadingText: sectionHeadingResult.layout.value?.pages[0]?.blocks[0]?.text ?? null,
          sectionInlineFlow: sectionHeadingResult.layout.value?.pages[0]?.blocks[1]?.text ?? null,
          coverMatterRoles: coverMatterResult.layout.value?.pages[0]?.blocks.slice(0, 3).map((block) => block.role).join(",") ?? null,
          gridTableHeaders: gridTableResult.knowledge.value?.tables[0]?.headers?.join(",") ?? null,
          denseGridHeaders: denseGridTableResult.knowledge.value?.tables[0]?.headers?.join(",") ?? null,
          stackedHeaderHeaders: stackedHeaderTableResult.knowledge.value?.tables[0]?.headers?.join(",") ?? null,
          fieldValueHeaders: fieldValueFormResult.knowledge.value?.tables[0]?.headers?.join(",") ?? null,
          delayedContentText: delayedContentResult.observation.value?.extractedText ?? null,
          singleByteText: singleByteEncodedResult.observation.value?.extractedText ?? null,
          encryptedText: browserEncryptedWithPassword.value?.extractedText ?? null,
          viewerInitialPage: initialViewerLabel,
          viewerNavigatedPage: navigatedViewerLabel,
          viewerReaderPage: readerViewerLabel,
          viewerUpdatedPage: updatedViewerLabel,
          viewerHeaders: updatedViewerHeaders.join(","),
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
