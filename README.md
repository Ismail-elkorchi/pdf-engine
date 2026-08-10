# @ismail-elkorchi/pdf-engine

`@ismail-elkorchi/pdf-engine` is a security-first, read-only PDF engine for Node.js, Deno, Bun, and browsers. Version `0.1.0` exposes one typed document session for parsing, extraction, structured reading, deterministic search, and provenance-preserving semantic projection.

The package does not display or modify PDFs. It never executes JavaScript, launch actions, media, rich content, or 3D content found in a document.

## Capabilities

- byte-accurate parsing of classic cross-reference tables, cross-reference streams, hybrid references, incremental revisions, object streams, trailers, page trees, inherited resources, and bounded structural repair
- typed low-level values, indirect objects, dictionaries, encoded or decoded streams, byte ranges, object references, and diagnostics
- byte, `Blob`, and caller-owned random-access sources; paths, URLs, and network access are never inferred
- standard password security revisions 2 through 6, including RC4, AES-128, and AES-256, with permissions enforced by default
- document metadata and XMP, named destinations, page labels, outlines, annotations, AcroForm fields, attachments, signatures, optional content, tagged structure, and active-content reporting
- native text, glyph, marked-content, path, image, color, transparency, geometry, layout, table, form, citation, Markdown, and chunk provenance
- image resources, inline images, masks, decode arrays, filters, and page placements
- deterministic literal or word search and cursor-based bounded reads across visible, accessibility, OCR, annotation, form, attachment-description, script, and metadata channels
- opt-in OCR with caller-supplied offline assets; embedded page imagery is converted internally when needed and is never exposed as a display surface
- detached CMS signature integrity checks and caller-supplied certificate trust policy with offline CRL evidence
- explicit policy and resource budgets for bytes, pages, objects, nesting, decoded data, operators, image pixels, OCR pixels, and caches

## Install and build

The package is currently developed from source:

```bash
npm ci
npm run build
```

## Open and read a document

```js
import { readFile } from "node:fs/promises";

import { createPdfEngine } from "./dist/index.js";

const engine = createPdfEngine();

try {
  const opened = await engine.open({
    source: {
      kind: "bytes",
      bytes: new Uint8Array(await readFile("document.pdf")),
      fileName: "document.pdf",
    },
  });

  if (opened.status !== "completed" && opened.status !== "partial") {
    throw new Error(opened.diagnostics.map((item) => item.message).join("; "));
  }

  const document = opened.value;
  const extracted = await document.extract();
  const matches = await document.search({ query: "invoice", mode: "word" });
  const firstPart = await document.read({ maxCharacters: 4_000 });

  if (extracted.status === "completed" || extracted.status === "partial") {
    console.log(extracted.value.extractedText);
  }
  if (matches.status === "completed" || matches.status === "partial") {
    console.log(matches.value.matches);
  }
  if (firstPart.status === "completed" || firstPart.status === "partial") {
    console.log(firstPart.value.fragments, firstPart.value.nextCursor);
  }

  await document.dispose();
} finally {
  await engine.dispose();
}
```

Expected document failures return a discriminated `PdfResult`: `blocked`, `failed`, or `cancelled`. Invalid API arguments and calls on disposed instances throw. A successful open may be `partial` when bounded repair was required.

## Source and policy boundaries

Callers must supply one of these source kinds:

- `{ kind: "bytes", bytes }`
- `{ kind: "blob", blob }`
- `{ kind: "random-access", byteLength, read }`

Use `policy` on `engine.open()` to control active-content admission, attachments, repair, passwords, permissions, and resource budgets. Password callbacks are invoked at most three times. No credential, OCR model, trust store, revocation feed, file, or network resource is discovered automatically.

## Public document products

An opened document provides:

- `structure()`, `object()`, and `stream()` for typed structural access
- `features()` for metadata and native PDF feature catalogs
- `extract()`, `layout()`, and `knowledge()` for progressively interpreted content with provenance
- `images()` and `attachment()` for explicit binary extraction
- `search()` and `read()` for deterministic retrieval
- `verifySignatures()` for caller-controlled offline validation

Results are cached within the document session. Dispose the document when it is no longer needed.

## OCR

OCR is disabled by default. Configure a `PdfOcrProvider` or use the optional `@ismail-elkorchi/pdf-engine/ocr/tesseract` helper with a caller-supplied Tesseract-compatible module. The helper does not download code, workers, language data, or models.

## Current limits

PDF is a large format and semantic recovery is not equivalent to visual interpretation. Layout, reading order, tables, and forms remain conservative inferences and carry diagnostics or provenance. Unsupported terminal image encodings remain available as original encoded bytes. OCR currently uses a dominant embedded page image when one can be recovered safely; it does not expose a general page rasterizer. OCSP evidence is accepted as a typed input but reported as unsupported by the offline verifier.

Treat every PDF as untrusted input and set budgets appropriate to the deployment.

## Runtime support

The development floor is Node.js 24. Runtime parity is checked on the pinned Node.js, Deno, and Bun versions, plus Chromium, Firefox, and WebKit.

See [CONTRIBUTING.md](CONTRIBUTING.md) for verification and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

Licensed under the [MIT License](LICENSE).
