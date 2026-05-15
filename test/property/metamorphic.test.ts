import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine } from "../../src/index.ts";
import {
  appendTrailingComment,
  buildPdfWithPageContents,
  buildPdfWithRenderImagery,
  buildPdfWithPageSpecs,
  buildPdfWithRenderResourcePayloads,
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
  assert.deepEqual(
    baseResult.render.value?.pages.map((page) => page.textIndex),
    mutatedResult.render.value?.pages.map((page) => page.textIndex),
  );
  assert.deepEqual(
    baseResult.render.value?.pages.map((page) => page.selectionModel),
    mutatedResult.render.value?.pages.map((page) => page.selectionModel),
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

test("RG and CS plus SC produce equivalent observed path color evidence and render hash", async () => {
  const engine = createPdfEngine();
  const directRgbBytes = buildPdfWithPageContents([
    "0.1 0.2 0.3 RG\n0 0 m\n10 10 l\nS",
  ]);
  const namedColorSpaceBytes = buildPdfWithPageSpecs([
    {
      resourcesBody: "<< /Font << /F1 3 0 R >> /ColorSpace << /CS1 /DeviceRGB >> >>",
      content: "/CS1 CS\n0.1 0.2 0.3 SC\n0 0 m\n10 10 l\nS",
    },
  ]);

  const directRgbResult = await engine.run({
    source: {
      bytes: directRgbBytes,
      fileName: "direct-rgb.pdf",
    },
  });
  const namedColorSpaceResult = await engine.run({
    source: {
      bytes: namedColorSpaceBytes,
      fileName: "named-rgb.pdf",
    },
  });

  const directPathMark = directRgbResult.observation.value?.pages[0]?.marks.find((mark) => mark.kind === "path");
  const namedPathMark = namedColorSpaceResult.observation.value?.pages[0]?.marks.find((mark) => mark.kind === "path");
  if (directPathMark?.kind !== "path" || namedPathMark?.kind !== "path") {
    assert.fail("Expected both PDFs to emit one observed path mark.");
  }

  assert.equal(directPathMark.colorState.strokeColorSpace.kind, "device-rgb");
  assert.equal(namedPathMark.colorState.strokeColorSpace.kind, "device-rgb");
  assert.deepEqual(directPathMark.colorState.strokeColor?.components, namedPathMark.colorState.strokeColor?.components);
  assert.equal(
    directRgbResult.render.value?.renderHash.hex,
    namedColorSpaceResult.render.value?.renderHash.hex,
  );
});

test("explicit default transparency state does not change observed path evidence or render hash", async () => {
  const engine = createPdfEngine();
  const implicitDefaultBytes = buildPdfWithPageContents([
    "0 0 m\n10 10 l\nS",
  ]);
  const explicitDefaultBytes = buildPdfWithPageSpecs(
    [
      {
        resourcesBody: "<< /Font << /F1 3 0 R >> /ExtGState << /GS1 10 0 R >> >>",
        content: "/GS1 gs\n0 0 m\n10 10 l\nS",
      },
    ],
    [
      {
        objectNumber: 10,
        body: "<< /Type /ExtGState /CA 1 /ca 1 /BM /Normal /SMask /None >>",
      },
    ],
  );

  const implicitDefaultResult = await engine.run({
    source: {
      bytes: implicitDefaultBytes,
      fileName: "transparency-default-implicit.pdf",
    },
  });
  const explicitDefaultResult = await engine.run({
    source: {
      bytes: explicitDefaultBytes,
      fileName: "transparency-default-explicit.pdf",
    },
  });

  const implicitPathMark = implicitDefaultResult.observation.value?.pages[0]?.marks.find((mark) => mark.kind === "path");
  const explicitPathMark = explicitDefaultResult.observation.value?.pages[0]?.marks.find((mark) => mark.kind === "path");
  if (implicitPathMark?.kind !== "path" || explicitPathMark?.kind !== "path") {
    assert.fail("Expected both PDFs to emit one observed path mark.");
  }

  assert.deepEqual(explicitPathMark.transparencyState, implicitPathMark.transparencyState);
  assert.equal(
    implicitDefaultResult.render.value?.renderHash.hex,
    explicitDefaultResult.render.value?.renderHash.hex,
  );
});

test("v and y shortcuts produce equivalent normalized segments and render hash as explicit c curves", async () => {
  const engine = createPdfEngine();
  const shortcutCurveBytes = buildPdfWithPageContents([
    [
      "0 0 m",
      "5 5 10 10 v",
      "15 15 20 20 y",
      "S",
    ].join("\n"),
  ]);
  const explicitCurveBytes = buildPdfWithPageContents([
    [
      "0 0 m",
      "0 0 5 5 10 10 c",
      "15 15 20 20 20 20 c",
      "S",
    ].join("\n"),
  ]);

  const shortcutCurveResult = await engine.run({
    source: {
      bytes: shortcutCurveBytes,
      fileName: "shortcut-curves.pdf",
    },
  });
  const explicitCurveResult = await engine.run({
    source: {
      bytes: explicitCurveBytes,
      fileName: "explicit-curves.pdf",
    },
  });

  const shortcutPathMark = shortcutCurveResult.observation.value?.pages[0]?.marks.find((mark) => mark.kind === "path");
  const explicitPathMark = explicitCurveResult.observation.value?.pages[0]?.marks.find((mark) => mark.kind === "path");
  if (shortcutPathMark?.kind !== "path" || explicitPathMark?.kind !== "path") {
    assert.fail("Expected both PDFs to emit one observed path mark.");
  }

  assert.deepEqual(shortcutPathMark.segments, explicitPathMark.segments);
  assert.equal(
    shortcutCurveResult.render.value?.renderHash.hex,
    explicitCurveResult.render.value?.renderHash.hex,
  );
});

test("unused resource ordering does not change render resource payloads or render hash", async () => {
  const engine = createPdfEngine();
  const baseBytes = buildPdfWithRenderResourcePayloads({
    includeUnusedResources: true,
    reorderResourceEntries: false,
  });
  const reorderedBytes = buildPdfWithRenderResourcePayloads({
    includeUnusedResources: true,
    reorderResourceEntries: true,
  });

  const baseResult = await engine.run({
    source: {
      bytes: baseBytes,
      fileName: "render-resource-payloads-base.pdf",
    },
  });
  const reorderedResult = await engine.run({
    source: {
      bytes: reorderedBytes,
      fileName: "render-resource-payloads-reordered.pdf",
    },
  });

  assert.deepEqual(baseResult.render.value?.resourcePayloads, reorderedResult.render.value?.resourcePayloads);
  assert.equal(baseResult.render.value?.renderHash.hex, reorderedResult.render.value?.renderHash.hex);
});

test("adding unrelated prose does not change the interpreted table-region evidence", async () => {
  const engine = createPdfEngine();
  const baseBytes = buildPdfWithPageContents([buildMeasurementTableContent()]);
  const withProseBytes = buildPdfWithPageContents([
    buildMeasurementTableContent([
      "1 0 0 1 72 600 Tm",
      "(This paragraph mentions an amount and remarks but is not part of the table.) Tj",
    ]),
  ]);

  const baseResult = await engine.run({
    source: {
      bytes: baseBytes,
      fileName: "layout-region-table-base.pdf",
    },
  });
  const withProseResult = await engine.run({
    source: {
      bytes: withProseBytes,
      fileName: "layout-region-table-with-prose.pdf",
    },
  });

  const baseRegionText = tableRegionText(baseResult.layout.value?.pages[0]);
  const withProseRegionText = tableRegionText(withProseResult.layout.value?.pages[0]);
  for (const marker of ["Specimen", "Nominal Width", "Measured Width", "Result", "Alpha", "Beta"]) {
    assert.match(baseRegionText, new RegExp(marker, "u"));
    assert.match(withProseRegionText, new RegExp(marker, "u"));
  }
  assert.doesNotMatch(baseRegionText, /not part of the table/u);
  assert.doesNotMatch(withProseRegionText, /not part of the table/u);
});

function buildMeasurementTableContent(extraLines: readonly string[] = []): string {
  return [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 700 Tm",
    "(Specimen) Tj",
    "1 0 0 1 180 700 Tm",
    "(Nominal Width) Tj",
    "1 0 0 1 310 700 Tm",
    "(Measured Width) Tj",
    "1 0 0 1 450 700 Tm",
    "(Result) Tj",
    "1 0 0 1 72 676 Tm",
    "(Alpha 10.0 mm 10.4 mm pass) Tj",
    "1 0 0 1 72 656 Tm",
    "(Beta 12.0 mm 11.1 mm review) Tj",
    ...extraLines,
    "ET",
  ].join("\n");
}

function tableRegionText(
  page: {
    readonly blocks: readonly { readonly id: string; readonly text: string }[];
    readonly regions?: readonly { readonly kind: string; readonly blockIds: readonly string[] }[];
  } | undefined,
): string {
  const blockById = new Map((page?.blocks ?? []).map((block) => [block.id, block.text]));
  const tableRegion = page?.regions?.find((region) => region.kind === "table");
  assert.ok(tableRegion);
  return tableRegion.blockIds.map((blockId) => blockById.get(blockId) ?? "").join(" | ");
}

test("resource ordering does not change page imagery or render hash", async () => {
  const engine = createPdfEngine();
  const baseBytes = buildPdfWithRenderImagery({
    reorderResourceEntries: false,
  });
  const reorderedBytes = buildPdfWithRenderImagery({
    reorderResourceEntries: true,
  });

  const baseResult = await engine.run({
    source: {
      bytes: baseBytes,
      fileName: "render-imagery-base.pdf",
    },
  });
  const reorderedResult = await engine.run({
    source: {
      bytes: reorderedBytes,
      fileName: "render-imagery-reordered.pdf",
    },
  });

  const baseImagery = baseResult.render.value?.pages[0]?.imagery;
  const reorderedImagery = reorderedResult.render.value?.pages[0]?.imagery;
  assert.ok(baseImagery?.svg);
  assert.ok(baseImagery?.raster);
  assert.ok(reorderedImagery?.svg);
  assert.ok(reorderedImagery?.raster);
  if (!baseImagery?.svg || !baseImagery.raster || !reorderedImagery?.svg || !reorderedImagery.raster) {
    return;
  }
  assert.deepEqual(baseResult.render.value?.pages[0]?.pageBox, reorderedResult.render.value?.pages[0]?.pageBox);
  assert.equal(
    baseImagery.svg.markup,
    reorderedImagery.svg.markup,
  );
  assert.deepEqual(
    baseImagery.raster.bytes,
    reorderedImagery.raster.bytes,
  );
  assert.equal(baseResult.render.value?.renderHash.hex, reorderedResult.render.value?.renderHash.hex);
});
