# AGENTS.md (pdf-engine Product Surface)

This repository is the public product surface for `@ismail-elkorchi/pdf-engine`.

## Start Here
- Open [README.md](README.md) first.

## Working Rules
- Keep this repository limited to buildable package code, package metadata, and public docs.
- Do not add research harvesters, raw fixture corpora, private control docs, or benchmark evidence here.
- Keep the public API strictly typed, deterministic, cross-runtime, and security-first.
- Do not collapse extraction into a single text string without preserving provenance and diagnostics in the public contracts.
- Keep release and GitHub automation public, reproducible, and tokenless.

## Required Checks
- TypeScript or package-surface changes: `npm run check`
- Cross-runtime, packaging, or release-workflow changes: `npm run check:ci`
- Published-surface changes: `npm run build`

## Canonical References
- [README.md](README.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [CHANGELOG.md](CHANGELOG.md)
