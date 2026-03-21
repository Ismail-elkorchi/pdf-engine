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

test("explicit default paint-state operators do not change observed path evidence or render hash", async () => {
  const engine = createPdfEngine();
  const implicitDefaultBytes = buildPdfWithPageContents([
    "0 0 m\n10 10 l\nS",
  ]);
  const explicitDefaultBytes = buildPdfWithPageContents([
    [
      "1 w",
      "0 J",
      "0 j",
      "10 M",
      "[] 0 d",
      "0 0 m",
      "10 10 l",
      "S",
    ].join("\n"),
  ]);

  const implicitDefaultResult = await engine.run({
    source: {
      bytes: implicitDefaultBytes,
      fileName: "paint-state-default-implicit.pdf",
    },
  });
  const explicitDefaultResult = await engine.run({
    source: {
      bytes: explicitDefaultBytes,
      fileName: "paint-state-default-explicit.pdf",
    },
  });

  assert.equal(implicitDefaultResult.admission.value?.decision, "accepted");
  assert.equal(explicitDefaultResult.admission.value?.decision, "accepted");
  const implicitPathMark = implicitDefaultResult.observation.value?.pages[0]?.marks.find((mark) => mark.kind === "path");
  const explicitPathMark = explicitDefaultResult.observation.value?.pages[0]?.marks.find((mark) => mark.kind === "path");
  if (implicitPathMark?.kind !== "path" || explicitPathMark?.kind !== "path") {
    assert.fail("Expected both PDFs to emit one observed path mark.");
  }

  assert.deepEqual(explicitPathMark.paintState, implicitPathMark.paintState);
  assert.equal(
    implicitDefaultResult.render.value?.renderHash.hex,
    explicitDefaultResult.render.value?.renderHash.hex,
  );
});
