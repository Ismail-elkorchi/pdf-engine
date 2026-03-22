import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine } from "../../src/index.ts";
import { loadNamedPdfFixture } from "../shared/load-fixture.ts";
import {
  buildPdfWithPageContents,
  buildPdfWithPageSpecs,
  buildPdfWithRenderResourcePayloads,
} from "../shared/pdf-builders.ts";

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
  assert.equal(typeof result.render.value?.pages[0]?.textIndex.text, "string");
  assert.ok(Array.isArray(result.render.value?.pages[0]?.textIndex.spans));
  assert.ok(Array.isArray(result.render.value?.pages[0]?.selectionModel.units));
  assert.ok(Array.isArray(result.admission.value?.featureFindings));
  assert.equal("featureSignals" in (result.admission.value ?? {}), false);
  assert.equal(result.render.value?.renderHash.algorithm, "sha-256");
  assert.equal(result.render.value?.renderHash.hex.length, 64);
});

test("public observation and render contracts expose path paint state", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithPageSpecs(
    [
      {
        resourcesBody: "<< /Font << /F1 3 0 R >> /ColorSpace << /CS1 /DeviceRGB >> /ExtGState << /GS1 10 0 R >> >>",
        content: [
          "2 w",
          "1 J",
          "2 j",
          "5 M",
          "[3 1] 2 d",
          "/CS1 CS",
          "0.1 0.2 0.3 SC",
          "/CS1 cs",
          "0.4 0.5 0.6 sc",
          "/GS1 gs",
          "0 0 m",
          "10 10 l",
          "S",
        ].join("\n"),
      },
    ],
    [
      {
        objectNumber: 10,
        body: "<< /Type /ExtGState /CA 0.5 /ca 0.25 /BM /Multiply /SMask 11 0 R >>",
      },
      {
        objectNumber: 11,
        body: "<< /Type /Mask >>",
      },
    ],
  );

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
  assert.deepEqual(pathMark.colorState, {
    strokeColorSpace: {
      kind: "device-rgb",
    },
    fillColorSpace: {
      kind: "device-rgb",
    },
    strokeColor: {
      colorSpace: {
        kind: "device-rgb",
      },
      components: [0.1, 0.2, 0.3],
    },
    fillColor: {
      colorSpace: {
        kind: "device-rgb",
      },
      components: [0.4, 0.5, 0.6],
    },
  });
  assert.deepEqual(pathMark.transparencyState, {
    strokeAlpha: 0.5,
    fillAlpha: 0.25,
    blendMode: "multiply",
    softMask: "present",
  });
  assert.deepEqual(pathMark.segments, [
    {
      kind: "move-to",
      to: { x: 0, y: 0 },
    },
    {
      kind: "line-to",
      to: { x: 10, y: 10 },
    },
  ]);
  assert.deepEqual(pathCommand.colorState, pathMark.colorState);
  assert.deepEqual(pathCommand.transparencyState, pathMark.transparencyState);
  assert.deepEqual(pathCommand.segments, pathMark.segments);
});

test("public render contracts expose text index and selection model", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithPageContents([
    [
      "BT",
      "/F1 16 Tf",
      "1 0 0 1 72 720 Tm",
      "(Heading Layer) Tj",
      "0 -24 Td",
      "(Selection Detail) Tj",
      "ET",
    ].join("\n"),
  ]);

  const result = await engine.run({
    source: {
      bytes,
      fileName: "public-api-render-text-selection.pdf",
    },
  });

  const renderPage = result.render.value?.pages[0];
  assert.ok(renderPage);
  assert.equal(renderPage?.textIndex.text, "Heading Layer\nSelection Detail");
  assert.equal(renderPage?.textIndex.spans.length, 2);
  assert.deepEqual(
    renderPage?.textIndex.spans.map((span) => ({
      id: span.id,
      contentOrder: span.contentOrder,
      text: span.text,
      startsNewLine: span.startsNewLine === true,
    })),
    [
      {
        id: "render-text-span-1-1",
        contentOrder: 0,
        text: "Heading Layer",
        startsNewLine: false,
      },
      {
        id: "render-text-span-1-2",
        contentOrder: 1,
        text: "Selection Detail",
        startsNewLine: true,
      },
    ],
  );
  assert.deepEqual(
    renderPage?.selectionModel.units.map((unit) => ({
      id: unit.id,
      textSpanId: unit.textSpanId,
      text: unit.text,
    })),
    [
      {
        id: "render-selection-unit-1-1",
        textSpanId: "render-text-span-1-1",
        text: "Heading Layer",
      },
      {
        id: "render-selection-unit-1-2",
        textSpanId: "render-text-span-1-2",
        text: "Selection Detail",
      },
    ],
  );
});

test("public render contracts expose resource payloads and payload-linked commands", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderResourcePayloads();

  const result = await engine.run({
    source: {
      bytes,
      fileName: "public-api-render-resource-payloads.pdf",
    },
  });

  const renderDocument = result.render.value;
  assert.ok(renderDocument);
  assert.ok(Array.isArray(renderDocument?.resourcePayloads));
  assert.equal(renderDocument?.resourcePayloads.length, 2);
  const fontPayload = renderDocument?.resourcePayloads.find((payload) => payload.kind === "font");
  const imagePayload = renderDocument?.resourcePayloads.find((payload) => payload.kind === "image");
  assert.ok(fontPayload);
  assert.ok(imagePayload);
  if (fontPayload?.kind !== "font" || imagePayload?.kind !== "image") {
    return;
  }

  assert.equal(fontPayload.availability, "available");
  assert.equal(imagePayload.availability, "available");
  assert.equal(fontPayload.byteSource, "decoded-stream");
  assert.equal(imagePayload.byteSource, "decoded-stream");
  const textCommand = renderDocument.pages[0]?.displayList.commands.find((command) => command.kind === "text");
  const imageCommand = renderDocument.pages[0]?.displayList.commands.find((command) => command.kind === "image");
  assert.equal(textCommand?.kind, "text");
  assert.equal(imageCommand?.kind, "image");
  if (textCommand?.kind !== "text" || imageCommand?.kind !== "image") {
    return;
  }

  assert.equal(textCommand.fontPayloadId, fontPayload.id);
  assert.equal(imageCommand.imagePayloadId, imagePayload.id);
});
