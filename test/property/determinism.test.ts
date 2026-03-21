import { strict as assert } from "node:assert";
import { test } from "node:test";

import fc from "fast-check";

import { createPdfEngine } from "../../src/index.ts";
import { buildPdfWithPageContents } from "../shared/pdf-builders.ts";

test("engine.run is deterministic for repeated benign text PDFs", async () => {
  const engine = createPdfEngine();

  await fc.assert(
    fc.asyncProperty(
      fc.stringMatching(/[A-Za-z0-9 ]{1,24}/u),
      async (text) => {
        const bytes = buildPdfWithPageContents([
          `BT\n1 0 0 1 72 720 Tm\n(${text}) Tj\nET`,
        ]);

        const first = await engine.run({
          source: {
            bytes,
            fileName: "determinism.pdf",
          },
        });
        const second = await engine.run({
          source: {
            bytes,
            fileName: "determinism.pdf",
          },
        });

        assert.equal(first.admission.value?.decision, "accepted");
        assert.equal(first.admission.value?.repairState, "clean");
        assert.equal(first.ir.value?.repairState, "clean");
        assert.equal(second.admission.value?.decision, "accepted");
        assert.equal(second.admission.value?.repairState, "clean");
        assert.equal(second.ir.value?.repairState, "clean");
        assert.equal(
          first.observation.value?.extractedText,
          second.observation.value?.extractedText,
        );
        assert.equal(
          first.render.value?.renderHash.hex,
          second.render.value?.renderHash.hex,
        );
        assert.deepEqual(
          first.admission.value?.featureFindings,
          second.admission.value?.featureFindings,
        );
      },
    ),
    {
      numRuns: 24,
      seed: 20260321,
    },
  );
});
