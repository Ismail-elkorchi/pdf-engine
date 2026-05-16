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
npm run test:unit
npm run test:contracts
npm run test:property
npm run test:coverage:node-lower
npm run test:runtime:all
npm run test:runtime:browser:compat
npm run test:integration
```

## Testing Signals

`npm run test:coverage:node-lower` is a diagnostic signal, not a release or step-completion oracle.

- use coverage to find missing lower-layer tests
- do not treat a percentage alone as proof that a subsystem is correct
- keep contract, property, runtime-parity, integration, and fuzz evidence alongside coverage when behavior changes

## Status

The published surface is still early, but it is no longer contracts-only. This repository currently ships:

- staged public contracts for admission, IR, observation, a first heuristic layout stage, and a first provenance-backed knowledge stage
- a staged parser core that recovers indirect objects, xref/trailer structure, repair state, and page-resolution provenance
- typed feature findings for risky and structural document features, including parsed-object evidence for actions, links, attachments, annotations, forms, outlines, signatures, and optional-content membership
- inherited page-resource state, content-stream provenance for observed text, run-level anchor and font-size hints, and operator-ready stream bodies for unfiltered, `ASCIIHexDecode`, `ASCII85Decode`, `RunLengthDecode`, `FlateDecode` plus predictors, `LZWDecode`, and `CCITTFaxDecode` streams
- content-stream-interpreter observation with page marks for text, paths, images, XObjects, clipping, and first marked-content plus visibility evidence, including normalized path paint-state facts, fill and stroke color-space evidence, fill and stroke color values, transparency evidence, form-XObject transparency-group evidence, and normalized local path segments with page-space bounding boxes
- geometry-aware layout evidence for anchored reading order, paragraph-flow continuity, repeated header/footer separation, conservative table and form-like region inference, and inference records that keep heuristic structure distinct from observed text provenance
- a first render stage that emits deterministic page display lists, page text indexes, selection models, render resource payloads, page-box-aware SVG imagery, deterministic PNG raster output, and stable SHA-256 render hashes from observed page marks while surfacing explicit render limits when page imagery remains partial
- a first geometry-backed knowledge projection with stable chunks, citation anchors, deterministic Markdown text, and heuristic table projection that emits no table when layout evidence is too weak
- a browser-only `./viewer` subpath that prefers canonical render artifacts in page view, falls back explicitly per page when imagery is unavailable, and keeps reader mode on staged layout blocks, cited knowledge chunks, projected tables, heading outlines, and staged-text search over existing pipeline results
- runtime support claims and a no-op disposal contract for future worker or WASM backends
- runtime smoke coverage for Node.js, Deno, Bun, and a real Chromium browser session, plus a browser bundle compatibility proof
- required browser-compat proof on GitHub for Chromium, Firefox, and WebKit
- a layered public verification surface with narrow unit, contract, property, Node lower-layer coverage reporting, runtime-parity, integration, and hostile-input fuzz tests
- JSR/npm publication scaffolding and public GitHub automation

It does not yet ship a finished parser, a mature layout engine, mature structured knowledge projections, a pixel-accurate renderer, or benchmark-backed superiority claims. The current layout stage now exposes early geometry-aware reading flow and boundary separation, the current knowledge stage exposes deterministic Markdown and citation-backed chunks/tables, and the current render stage exposes deterministic text indexing, selection geometry, resource payload references, page imagery, and deterministic raster output. The browser viewer uses those render artifacts in page view with an explicit per-page fallback when imagery is unavailable. Render output still carries truthful partial-imagery limits.
