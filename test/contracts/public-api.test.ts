import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine } from "../../src/index.ts";
import { loadNamedPdfFixture } from "../shared/load-fixture.ts";
import { buildPdfWithPageContents } from "../shared/pdf-builders.ts";

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

test("public observation and render contracts expose path paint state", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithPageContents([
    [
      "2 w",
      "1 J",
      "2 j",
      "5 M",
      "[3 1] 2 d",
      "0 0 m",
      "10 10 l",
      "S",
    ].join("\n"),
  ]);

  const result = await engine.run({
    source: {
      bytes,
      fileName: "public-api-path-paint-state.pdf",
    },
  });

  const pathMark = result.observation.value?.pages[0]?.marks.find((mark) => mark.kind === "path");
  const pathCommand = result.render.value?.pages[0]?.displayList.commands.find((command) => command.kind === "path");

  assert.ok(pathMark);
  assert.ok(pathCommand);
  if (pathMark?.kind !== "path" || pathCommand?.kind !== "path") {
    return;
  }

  assert.deepEqual(pathMark.paintState, {
    lineWidth: 2,
    lineCapStyle: "round",
    lineJoinStyle: "bevel",
    miterLimit: 5,
    dashPattern: {
      segments: [3, 1],
      phase: 2,
    },
  });
  assert.deepEqual(pathCommand.paintState, pathMark.paintState);
});
