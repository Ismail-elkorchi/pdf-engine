# @ismail-elkorchi/pdf-engine

`@ismail-elkorchi/pdf-engine` is the public product repository for a strict-TypeScript PDF engine targeting Node.js, Deno, Bun, and the web.

## Repository Scope

This repository is intentionally limited to the buildable package surface:

- `src/`: public TypeScript contracts and package entrypoints
- `jsr/`: JSR entrypoints that stay aligned with the public TypeScript surface
- package/build metadata
- public README, changelog, contribution, and security docs
- public GitHub automation for CI, security scanning, and tokenless publishing

The package goal is broader than a flat PDF parser. It is intended to become a security-first PDF engine that can admit, parse, observe, interpret, project, and render real-world PDFs without collapsing everything into one opaque extraction call.

## Commands

```bash
npm install
npm run check
npm run build
npm run smoke:all
```

## Status

The published surface is still early, but it is no longer contracts-only. This repository currently ships:

- staged public contracts for admission, IR, observation, a first heuristic layout stage, and a first provenance-backed knowledge stage
- a staged parser core that recovers indirect objects, xref/trailer structure, repair state, and page-resolution provenance
- typed feature findings for risky and structural document features, including parsed-object evidence for actions, links, attachments, annotations, forms, outlines, signatures, and optional-content membership
- inherited page-resource state, content-stream provenance for observed text, run-level anchor and font-size hints, and operator-ready stream bodies for unfiltered, `ASCIIHexDecode`, `ASCII85Decode`, `RunLengthDecode`, `FlateDecode` plus predictors, `LZWDecode`, and `CCITTFaxDecode` streams
- content-stream-interpreter observation with page marks for text, paths, images, XObjects, clipping, and first marked-content plus visibility evidence, a line-oriented layout stage with explicit heuristic limitation markers, and extractive knowledge chunks with source citations
- a first render stage that emits deterministic page display lists and stable SHA-256 render hashes from observed page marks while surfacing explicit render limits for raster output
- a first heuristic table projection that stays citation-backed and emits no table when layout evidence is too weak
- a browser-only `./viewer` subpath that renders page and reader views from staged layout blocks, cited knowledge chunks, projected tables, heading outlines, and staged-text search over existing pipeline results
- runtime support claims and a no-op disposal contract for future worker or WASM backends
- runtime smoke coverage for Node.js, Deno, Bun, and a real Chromium browser session, plus a browser bundle compatibility proof
- required browser-compat proof on GitHub for Chromium, Firefox, and WebKit
- JSR/npm publication scaffolding and public GitHub automation

It does not yet ship a finished parser, a mature layout engine, mature structured knowledge projections, a pixel-accurate renderer, or benchmark-backed superiority claims. The current render stage is display-list-only and does not emit raster output yet.
