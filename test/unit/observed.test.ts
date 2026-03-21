import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PdfDiagnostic } from "../../src/contracts.ts";
import { createPdfEngine } from "../../src/engine-core.ts";
import { buildObservedPages } from "../../src/layout/observed.ts";
import { analyzePdfShell } from "../../src/shell-parse.ts";
import { buildPdfWithPageContents } from "../shared/pdf-builders.ts";

test("buildObservedPages preserves marked-content context, path geometry, and linked text marks", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithPageContents([
    [
      "q",
      "2 0 0 2 10 20 cm",
      "/Span <</ActualText (Actual)>> BDC",
      "0 0 m",
      "5 5 l",
      "S",
      "BT",
      "/F1 12 Tf",
      "1 0 0 1 0 0 Tm",
      "(Visible) Tj",
      "ET",
      "EMC",
      "Q",
    ].join("\n"),
  ]);
  const analysis = await analyzePdfShell(
    {
      bytes,
      fileName: "observed-test.pdf",
    },
    engine.defaultPolicy,
  );
  const diagnostics: PdfDiagnostic[] = [];
  const observed = buildObservedPages(
    {
      analysis,
      featureFindings: [],
    },
    diagnostics,
  );

  assert.deepEqual(diagnostics, []);
  assert.equal(observed.pages.length, 1);

  const page = observed.pages[0]!;
  const markedContentMark = page.marks.find((mark) => mark.kind === "marked-content");
  const pathMark = page.marks.find((mark) => mark.kind === "path");
  const textMark = page.marks.find((mark) => mark.kind === "text");

  assert.ok(markedContentMark);
  assert.ok(pathMark);
  assert.ok(textMark);
  if (
    markedContentMark?.kind !== "marked-content" ||
    pathMark?.kind !== "path" ||
    textMark?.kind !== "text"
  ) {
    return;
  }

  assert.equal(markedContentMark.tagName, "Span");
  assert.equal(markedContentMark.markedContentKind, "span");
  assert.equal(markedContentMark.actualText, "Actual");
  assert.equal(markedContentMark.visibilityState, "visible");

  assert.equal(pathMark.paintOperator, "S");
  assert.equal(pathMark.pointCount, 2);
  assert.equal(pathMark.closed, false);
  assert.deepEqual(pathMark.bbox, {
    x: 10,
    y: 20,
    width: 10,
    height: 10,
  });
  assert.deepEqual(pathMark.transform, {
    a: 2,
    b: 0,
    c: 0,
    d: 2,
    e: 10,
    f: 20,
  });

  assert.equal(textMark.text, "Visible");
  assert.equal(textMark.markedContentId, markedContentMark.id);
  assert.equal(pathMark.markedContentId, markedContentMark.id);
  assert.equal(textMark.visibilityState, "visible");
  assert.equal(page.runs[0]?.text, "Visible");
  assert.equal(page.glyphs.length, "Visible".length);
});
