import { strict as assert } from "node:assert";
import { test } from "node:test";

import fc from "fast-check";

import { createPdfEngine } from "../../src/index.ts";
import {
  buildPdfWithDenseVectorImagery,
  buildPdfWithPageContents,
  buildPdfWithRenderImagery,
  buildPdfWithRenderResourcePayloads,
} from "../shared/pdf-builders.ts";

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
          first.render.value?.pages.map((page) => page.textIndex),
          second.render.value?.pages.map((page) => page.textIndex),
        );
        assert.deepEqual(
          first.render.value?.pages.map((page) => page.selectionModel),
          second.render.value?.pages.map((page) => page.selectionModel),
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

test("engine.run is deterministic for repeated payload-bearing render PDFs", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderResourcePayloads();

  const first = await engine.run({
    source: {
      bytes,
      fileName: "render-resource-payloads.pdf",
    },
  });
  const second = await engine.run({
    source: {
      bytes,
      fileName: "render-resource-payloads.pdf",
    },
  });

  assert.deepEqual(first.render.value?.resourcePayloads, second.render.value?.resourcePayloads);
  assert.equal(first.render.value?.renderHash.hex, second.render.value?.renderHash.hex);
  assert.equal(first.render.value?.pages[0]?.renderHash.hex, second.render.value?.pages[0]?.renderHash.hex);
});

test("engine.run is deterministic for repeated imagery-bearing render PDFs", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderImagery();

  const first = await engine.run({
    source: {
      bytes,
      fileName: "render-imagery-raster.pdf",
    },
  });
  const second = await engine.run({
    source: {
      bytes,
      fileName: "render-imagery-raster.pdf",
    },
  });

  const firstImagery = first.render.value?.pages[0]?.imagery;
  const secondImagery = second.render.value?.pages[0]?.imagery;
  assert.ok(firstImagery?.svg);
  assert.ok(firstImagery?.raster);
  assert.ok(secondImagery?.svg);
  assert.ok(secondImagery?.raster);
  if (!firstImagery?.svg || !firstImagery.raster || !secondImagery?.svg || !secondImagery.raster) {
    return;
  }
  assert.deepEqual(first.render.value?.pages[0]?.pageBox, second.render.value?.pages[0]?.pageBox);
  assert.equal(
    firstImagery.svg.markup,
    secondImagery.svg.markup,
  );
  assert.deepEqual(
    firstImagery.raster.bytes,
    secondImagery.raster.bytes,
  );
  assert.equal(first.render.value?.pages[0]?.renderHash.hex, second.render.value?.pages[0]?.renderHash.hex);
  assert.equal(first.render.value?.renderHash.hex, second.render.value?.renderHash.hex);
});

test("engine.run is deterministic for repeated dense-vector render PDFs", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithDenseVectorImagery();

  const first = await engine.run({
    source: {
      bytes,
      fileName: "dense-vector-render.pdf",
    },
  });
  const second = await engine.run({
    source: {
      bytes,
      fileName: "dense-vector-render.pdf",
    },
  });

  const firstPages = first.render.value?.pages ?? [];
  const secondPages = second.render.value?.pages ?? [];
  assert.equal(firstPages.length, secondPages.length);
  for (const [pageIndex, firstPage] of firstPages.entries()) {
    const secondPage = secondPages[pageIndex];
    assert.ok(firstPage?.imagery?.svg);
    assert.ok(firstPage?.imagery?.raster);
    assert.ok(secondPage?.imagery?.svg);
    assert.ok(secondPage?.imagery?.raster);
    if (!firstPage?.imagery?.svg || !firstPage.imagery.raster || !secondPage?.imagery?.svg || !secondPage.imagery.raster) {
      continue;
    }
    assert.equal(firstPage.imagery.svg.markup, secondPage.imagery.svg.markup);
    assert.deepEqual(firstPage.imagery.raster.bytes, secondPage.imagery.raster.bytes);
    assert.equal(firstPage.renderHash.hex, secondPage.renderHash.hex);
  }
  assert.equal(first.render.value?.renderHash.hex, second.render.value?.renderHash.hex);
});
