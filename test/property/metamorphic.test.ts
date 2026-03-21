import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine } from "../../src/index.ts";
import {
  appendTrailingComment,
  buildPdfWithPageContents,
} from "../shared/pdf-builders.ts";

test("trailing comments after EOF do not change semantic text or render hash", async () => {
  const engine = createPdfEngine();
  const baseBytes = buildPdfWithPageContents([
    "BT\n1 0 0 1 72 720 Tm\n(Metamorphic Hello) Tj\nET",
  ]);
  const mutatedBytes = appendTrailingComment(baseBytes, "harmless trailing comment");

  const baseResult = await engine.run({
    source: {
      bytes: baseBytes,
      fileName: "metamorphic-base.pdf",
    },
  });
  const mutatedResult = await engine.run({
    source: {
      bytes: mutatedBytes,
      fileName: "metamorphic-mutated.pdf",
    },
  });

  assert.equal(baseResult.admission.value?.decision, "accepted");
  assert.equal(baseResult.admission.value?.repairState, "clean");
  assert.equal(baseResult.ir.value?.repairState, "clean");
  assert.equal(mutatedResult.admission.value?.decision, "accepted");
  assert.equal(mutatedResult.admission.value?.repairState, "clean");
  assert.equal(mutatedResult.ir.value?.repairState, "clean");
  assert.equal(
    baseResult.observation.value?.extractedText,
    mutatedResult.observation.value?.extractedText,
  );
  assert.equal(
    baseResult.render.value?.renderHash.hex,
    mutatedResult.render.value?.renderHash.hex,
  );
});
