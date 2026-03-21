import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine } from "../../src/index.ts";
import { loadNamedPdfFixture } from "../shared/load-fixture.ts";

test("public pipeline contracts expose staged artifacts with current kinds", async () => {
  const engine = createPdfEngine();
  const { fixture, bytes } = await loadNamedPdfFixture("simpleText");

  const result = await engine.run({
    source: {
      bytes,
      fileName: fixture.fileName,
    },
  });

  assert.equal(engine.identity.mode, "core");
  assert.ok(engine.identity.supportedStages.includes("render"));
  assert.equal(result.admission.stage, "admission");
  assert.equal(result.ir.stage, "ir");
  assert.equal(result.observation.stage, "observation");
  assert.equal(result.layout.stage, "layout");
  assert.equal(result.knowledge.stage, "knowledge");
  assert.equal(result.render.stage, "render");
  assert.equal(result.ir.value?.kind, "pdf-ir");
  assert.equal(result.observation.value?.kind, "pdf-observation");
  assert.equal(result.layout.value?.kind, "pdf-layout");
  assert.equal(result.knowledge.value?.kind, "pdf-knowledge");
  assert.equal(result.render.value?.kind, "pdf-render");
  assert.ok(Array.isArray(result.admission.value?.featureFindings));
  assert.equal("featureSignals" in (result.admission.value ?? {}), false);
  assert.equal(result.render.value?.renderHash.algorithm, "sha-256");
  assert.equal(result.render.value?.renderHash.hex.length, 64);
});
