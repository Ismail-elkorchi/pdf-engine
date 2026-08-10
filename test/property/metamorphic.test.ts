import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine, type PdfResult } from "../../src/index.ts";
import { appendTrailingComment, buildPdfWithPageContents } from "../shared/pdf-builders.ts";

function valueOf<T>(result: PdfResult<T>): T {
  if (result.status !== "completed" && result.status !== "partial") {
    assert.fail(`Expected a value result, received ${result.status}.`);
  }
  return result.value;
}

test("a trailing comment does not change semantic products", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithPageContents(["BT\n/F1 12 Tf\n(Metamorphic Text) Tj\nET"]);
  const base = valueOf(await engine.open({ source: { kind: "bytes", bytes } }));
  const changed = valueOf(await engine.open({
    source: { kind: "bytes", bytes: appendTrailingComment(bytes, "ignored after EOF") },
  }));
  assert.deepEqual(valueOf(await base.extract()), valueOf(await changed.extract()));
  assert.deepEqual(valueOf(await base.layout()), valueOf(await changed.layout()));
  assert.deepEqual(valueOf(await base.knowledge()), valueOf(await changed.knowledge()));
  await engine.dispose();
});
