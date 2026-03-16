import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, normalize, resolve } from "node:path";

import { chromium } from "playwright";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function parseArgs(argv) {
  let reportPath = "reports/smoke-browser-runtime.json";
  for (const arg of argv) {
    if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length);
    }
  }
  return { reportPath };
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

async function runBrowserSmoke(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });

    const smoke = await page.evaluate(async () => {
      const { createPdfEngine } = await import("/dist/index.js");

      const encodeText = (value) => new TextEncoder().encode(value);
      const decodeBase64 = (value) => {
        if (typeof Uint8Array.fromBase64 === "function") {
          return Uint8Array.fromBase64(value);
        }

        return Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
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

      const flateStreamBytes = decodeBase64("eJxzCuHS8EjNyclXcMtJLEnVVAjJ4nIN4QIAUIcGfQ==");
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

        const checks = {
          exportsPresent: typeof createPdfEngine === "function",
          runtime: plainResult.runtime.kind === "web",
          supportedRuntimeClaim: engine.identity.supportedRuntimes.includes("web"),
          plainText: plainResult.observation.value?.extractedText === "Browser Hello",
          flateText: flateResult.observation.value?.extractedText === "Hello Flate",
          observationStrategy: plainResult.observation.value?.strategy === "decoded-text-operators",
          flateDecoded: flateResult.ir.value?.decodedStreams === true
        };
        const stablePayload = {
          runtime: plainResult.runtime.kind,
          plainText: plainResult.observation.value?.extractedText ?? null,
          flateText: flateResult.observation.value?.extractedText ?? null,
          strategy: plainResult.observation.value?.strategy ?? null
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
  const { reportPath } = parseArgs(process.argv.slice(2));
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

    const smoke = await runBrowserSmoke(`http://127.0.0.1:${String(address.port)}`);
    const report = {
      suite: "browser-runtime-smoke",
      timestamp: new Date().toISOString(),
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
    process.stdout.write(`browser runtime smoke passed: ${reportPath}\n`);
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
