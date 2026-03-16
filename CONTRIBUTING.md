# Contributing

## Workflow

- Pull requests only.
- Use short-lived topic branches.
- Keep changes small and logically scoped.
- Merge with `squash` or `rebase`.

## Local verification

Run before opening a pull request:

- `npm ci`
- `npm run check`
- `npm run build`
- `npm run smoke:all`

`npm run check` includes the JSR documentation gates, so full local verification requires Deno as well as Node.js.
Runtime floors and CI-pinned versions are governed by [`tools/runtime-versions.json`](tools/runtime-versions.json).

## Constraints

- Keep this repository limited to public package code, package metadata, public docs, and public GitHub automation.
- Do not add raw fixture corpora, private control material, or internal research artifacts.
- Keep the public API strict, deterministic, and security-first.
