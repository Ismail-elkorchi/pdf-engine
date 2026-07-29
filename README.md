# @ismail-elkorchi/pdf-engine

`@ismail-elkorchi/pdf-engine` is a strict TypeScript PDF engine for Node.js,
Deno, Bun, and browsers. It exposes staged, typed results for admission,
parsing, observation, layout, knowledge projection, and rendering.

> This project is pre-release and is not yet published to npm or JSR. Its API
> can change before the first release.

## Capabilities

- recovers PDF objects, trailers, page trees, inherited resources, xref streams,
  object streams, and supported stream filters
- reports typed diagnostics and policy findings for malformed or risky documents
- preserves page, object, stream, run, glyph, and citation provenance
- observes native text, paths, images, marked content, color, transparency, and
  geometry
- derives conservative reading order, paragraphs, repeated boundaries, tables,
  and form-like regions
- projects deterministic Markdown, chunks, citations, tables, and forms
- produces deterministic display lists, text indexes, selection geometry, SVG,
  PNG, and render hashes
- provides an opt-in OCR provider contract and a browser viewer

## Current Limits

The parser, layout interpretation, knowledge projection, and renderer are still
in development. Rendering is not pixel-compatible with mature native PDF
renderers, layout and table recovery remain heuristic, and some PDF filters,
fonts, graphics operations, and encrypted documents are unsupported. Do not
treat this package as a drop-in replacement for a mature PDF SDK yet.

OCR is disabled unless a caller supplies and enables a provider. PDF input must
always be treated as untrusted.

## Try It

Until the first package release, build the repository locally:

```bash
npm ci
npm run build
```

```js
import { readFile } from "node:fs/promises";

import { createPdfEngine } from "./dist/index.js";

const engine = createPdfEngine();

try {
  const result = await engine.run({
    source: {
      bytes: new Uint8Array(await readFile("document.pdf")),
      fileName: "document.pdf",
    },
  });

  console.log(result.observation.value?.extractedText ?? "");
  console.log(result.diagnostics);
} finally {
  await engine.dispose();
}
```

The engine also exposes individual `admit`, `toIr`, `observe`, `toLayout`,
`toKnowledge`, and `toRender` methods when a caller does not need the full
pipeline.

## Runtime Support

The current development floors are Node.js 24, Deno 2.6.9, and Bun 1.3.9.
Browser compatibility is checked in Chromium, Firefox, and WebKit.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and verification. Report
security vulnerabilities using [SECURITY.md](SECURITY.md).

Licensed under the [MIT License](LICENSE).
