import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine } from "../../src/index.ts";
import {
  appendTrailingComment,
  buildPdfWithPageContents,
  buildPdfWithPageSpecs,
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
