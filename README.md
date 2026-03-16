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

The published surface is still early. This repository currently ships typed contracts, JSR/npm publication scaffolding, and GitHub automation, not the finished engine implementation.
