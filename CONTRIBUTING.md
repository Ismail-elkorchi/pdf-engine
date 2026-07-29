# Contributing

## Setup

Use Node.js 24 or later. Full cross-runtime verification also requires Deno,
Bun, and Playwright's Chromium, Firefox, and WebKit installations.

```bash
npm ci
npx playwright install --with-deps chromium firefox webkit
```

## Development

- Use a short-lived branch and keep each pull request focused.
- Run `npm run check` for every change.
- Run the narrowest relevant test suite while developing.
- Run `npm run check:ci` before requesting merge.
- Use a squash or rebase merge so `main` remains linear.

`npm run check:ci` includes static checks, focused Node tests, coverage
reporting, runtime parity, built-package integration, browser checks, and
hostile-input fuzzing. Coverage is a missing-test signal, not proof of
correctness.

Changes to behavior should add or strengthen a focused invariant, relation, or
regression test. Changes to runtime or published surfaces should also include
the relevant runtime, browser, or packaging validation.

Keep the repository limited to package code, package metadata, public
documentation, reproducible tests, and public automation. Do not commit private
control material or non-redistributable fixture corpora.
