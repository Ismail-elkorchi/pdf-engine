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
- `npm run check:ci`

`npm run check` includes lint, type, runtime-policy, and JSR documentation gates.
`npm run check:ci` adds cross-runtime smoke coverage and the hostile-input fuzz check, so full local verification requires Deno, Bun, and Node.js.
Runtime floors and CI-pinned versions are governed by [`tools/runtime-versions.json`](tools/runtime-versions.json).

## Constraints

- Keep this repository limited to public package code, package metadata, public docs, and public GitHub automation.
- Do not add raw fixture corpora, private control material, or internal research artifacts.
- Keep the public API strict, deterministic, and security-first.
