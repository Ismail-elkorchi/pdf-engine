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
- Observation marks now carry first marked-content, optional-content visibility, and hidden-layer evidence needed for the remaining render and geometry-backed interpretation work.
- Path observation and render commands now carry normalized line-width, cap, join, miter-limit, and dash-pattern evidence needed for later render-fidelity work.
- Path observation and render commands now carry normalized fill and stroke color-space evidence, fill and stroke color values, and transparency state; form XObject marks and display commands now also surface transparency-group evidence.
- Path observation and render commands now carry normalized local path segments for `m`, `l`, `c`, `v`, `y`, `h`, and `re`, while keeping page-space bounding boxes and derived `pointCount` and `closed` summaries.
- Breaking pipeline contract update: `PdfPipelineResult` now includes a first `render` stage, and `PdfEngine` now exposes `toRender(...)` with deterministic display-list output and explicit render limits.
- Render artifacts now include stable SHA-256 hashes for the document and each rendered page so cross-runtime determinism can be proven directly from the public stage output.
- Breaking render contract update: rendered pages now expose deterministic `textIndex` and `selectionModel` artifacts derived from render text commands, and page or document render hashes now include those fields.
- Breaking render contract update: render documents now expose deterministic `resourcePayloads`, and text or image display commands now carry payload links that preserve font and image bytes when the current PDF exposes usable embedded streams.
- Breaking render contract update: rendered pages now expose `pageBox` and `imagery`, with deterministic SVG page imagery, deterministic PNG raster output, and truthful `render-imagery-partial` limits when available payloads or supported semantics are not enough for complete page imagery.
- Render hashing now canonicalizes byte payloads through deterministic byte digests so large imagery-bearing pages remain hashable under the validation proof sets.
- The browser viewer now prefers render imagery in page mode, uses render selection geometry for page-mode search highlights, surfaces render-text hits in search results, and falls back explicitly per page when render imagery is unavailable.
- Knowledge table projection now recovers compact row-run measurement tables with citation-backed cells when header and body rows are consistent.
- Knowledge table projection now rejects compact row-run candidates whose numeric evidence is only incidental prose.
