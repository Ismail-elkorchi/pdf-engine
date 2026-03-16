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

- staged public contracts for admission, IR, observation, and a first heuristic layout stage
- an object-aware shell engine that recovers indirect objects, xref/trailer structure, repair state, page-resolution provenance, inherited page-resource state, content-stream provenance for observed text, run-level anchor and font-size hints, operator-ready stream bodies for unfiltered and `FlateDecode` streams, decoded text-operator observation, and a line-oriented layout stage with explicit heuristic limitation markers, alongside runtime support claims and a no-op disposal contract for future worker or WASM backends
- runtime smoke coverage for Node.js, Deno, Bun, and a real Chromium browser session, plus a browser bundle compatibility proof
- JSR/npm publication scaffolding and public GitHub automation

It does not yet ship a finished parser, a mature layout engine, a knowledge projection layer, a renderer, or benchmark-backed superiority claims.
