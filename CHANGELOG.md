# Changelog

All notable changes are documented in this file.

## Unreleased

- Initial public repository scaffold for `@ismail-elkorchi/pdf-engine`.
- Strict TypeScript PDF contracts for the future cross-runtime engine surface.
- npm + JSR metadata and tokenless GitHub publishing workflow baseline.
- Breaking stage-identity update: public engine mode now reports `core`, and IR/observation/layout/knowledge artifacts now use stable `pdf-*` kinds instead of `shell*`.
- Admission now blocks policy-driving risky features when they are only found through scan fallback instead of parsed object authority.
- Breaking admission and IR contract update: coarse `featureSignals`/`featureKinds` are replaced with typed `featureFindings` backed by parsed-object evidence for actions, links, attachments, annotations, forms, outlines, signatures, and optional-content membership.
- Breaking observation contract update: `PdfObservedPage` now exposes canonical `marks`, and observation strategy now reports `content-stream-interpreter` while preserving derived text `runs` and `glyphs`.
