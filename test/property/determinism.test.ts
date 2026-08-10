import { strict as assert } from "node:assert";
import { test } from "node:test";

import fc from "fast-check";

import { createPdfEngine, type PdfResult } from "../../src/index.ts";
import { buildPdfWithPageContents } from "../shared/pdf-builders.ts";

function valueOf<T>(result: PdfResult<T>): T {
  if (result.status !== "completed" && result.status !== "partial") {
    assert.fail(`Expected a value result, received ${result.status}.`);
  }
  return result.value;
}

test("extraction, layout, knowledge, search, and bounded reads are deterministic", async () => {
  const engine = createPdfEngine();
  await fc.assert(fc.asyncProperty(
    fc.stringMatching(/[A-Za-z0-9 ]{1,24}/u),
    async (text) => {
      const bytes = buildPdfWithPageContents([`BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(${text}) Tj\nET`]);
      const left = valueOf(await engine.open({ source: { kind: "bytes", bytes } }));
      const right = valueOf(await engine.open({ source: { kind: "bytes", bytes } }));
      assert.deepEqual(valueOf(await left.extract()), valueOf(await right.extract()));
      assert.deepEqual(valueOf(await left.layout()), valueOf(await right.layout()));
      assert.deepEqual(valueOf(await left.knowledge()), valueOf(await right.knowledge()));
      assert.deepEqual(
        valueOf(await left.search({ query: text.slice(0, 1), limit: 20 })),
        valueOf(await right.search({ query: text.slice(0, 1), limit: 20 })),
      );
      assert.deepEqual(
        valueOf(await left.read({ maxCharacters: 8 })),
        valueOf(await right.read({ maxCharacters: 8 })),
      );
    },
  ), { numRuns: 24, seed: 20260810 });
  await engine.dispose();
});
