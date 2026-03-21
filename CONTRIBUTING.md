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
- `npm run test:unit`
- `npm run test:contracts`
- `npm run test:property`
- `npm run test:coverage:node-lower`
- `npm run test:runtime:browser:compat`
- `npm run check:ci`

`npm run check` includes lint, type, runtime-policy, and JSR documentation gates.
`npm run test:unit`, `npm run test:contracts`, and `npm run test:property` are the lower-layer public test suites. They are required for any logic change even when the existing smoke coverage stays green.
`npm run test:coverage:node-lower` reports line, branch, and function coverage for the Node lower-layer suites without replacing the lower-layer suites themselves.
`npm run test:runtime:browser:compat` adds cross-browser runtime parity for Chromium, Firefox, and WebKit.
`npm run check:ci` adds full cross-runtime parity, integration smokes, and the hostile-input fuzz check, so full local verification requires Deno, Bun, Node.js, and Playwright browser installs.
Runtime floors and CI-pinned versions are governed by [`tools/runtime-versions.json`](tools/runtime-versions.json).

## Constraints

- Keep this repository limited to public package code, package metadata, public docs, and public GitHub automation.
- Do not add raw fixture corpora, private control material, or internal research artifacts.
- Keep the public API strict, deterministic, and security-first.
- Any pull request that changes logic should add or tighten an invariant test, a relation-based test, or explain concretely why no new test is needed.
