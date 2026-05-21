import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine, type PdfOcrProvider } from "../../src/index.ts";
import { loadNamedPdfFixture } from "../shared/load-fixture.ts";
import {
  buildPdfWithPageContents,
  buildPdfWithPageSpecs,
  buildPdfWithRenderImagery,
  buildPdfWithRenderImageMask,
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
  assert.equal(typeof result.knowledge.value?.markdown, "string");
  assert.ok(Array.isArray(result.knowledge.value?.forms));
  const firstCitation = result.knowledge.value?.chunks[0]?.citations[0];
  assert.equal(firstCitation?.sourceSpan?.text, firstCitation?.text);
  assert.equal(firstCitation?.sourceSpan?.blockRange.start, 0);
  assert.ok((firstCitation?.sourceSpan?.runSpans.length ?? 0) > 0);
  const layoutBlock = result.layout.value?.pages[0]?.blocks[0];
  assert.ok(Array.isArray(layoutBlock?.inferences));
  assert.ok(layoutBlock?.inferences?.some((inference) => inference.kind === "reading-order"));
  assert.ok(Array.isArray(result.layout.value?.pages[0]?.regions));
  assert.equal(typeof result.render.value?.pages[0]?.textIndex.text, "string");
  assert.ok(Array.isArray(result.render.value?.pages[0]?.textIndex.spans));
  assert.ok(Array.isArray(result.render.value?.pages[0]?.selectionModel.units));
  assert.ok(Array.isArray(result.admission.value?.featureFindings));
  assert.equal("featureSignals" in (result.admission.value ?? {}), false);
  assert.equal(result.render.value?.renderHash.algorithm, "sha-256");
  assert.equal(result.render.value?.renderHash.hex.length, 64);
});

test("public pipeline intent skips downstream stages without changing the default full run", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithPageContents([
    "BT /F1 12 Tf 1 0 0 1 72 720 Tm (Intent stage skipping) Tj ET",
  ]);

  const admissionOnly = await engine.run({
    source: { bytes, fileName: "public-api-intent-admission.pdf" },
    intent: "admission",
  });
  assert.equal(admissionOnly.admission.status, "completed");
  assert.equal(admissionOnly.ir.status, "skipped");
  assert.equal(admissionOnly.observation.status, "skipped");
  assert.equal(admissionOnly.layout.status, "skipped");
  assert.equal(admissionOnly.knowledge.status, "skipped");
  assert.equal(admissionOnly.render.status, "skipped");
  assert.equal("value" in admissionOnly.ir, false);

  const textOnly = await engine.run({
    source: { bytes, fileName: "public-api-intent-text.pdf" },
    intent: "text",
  });
  assert.equal(textOnly.ir.value?.kind, "pdf-ir");
  assert.equal(textOnly.observation.value?.kind, "pdf-observation");
  assert.equal(textOnly.layout.status, "skipped");
  assert.equal(textOnly.knowledge.status, "skipped");
  assert.equal(textOnly.render.status, "skipped");

  const layoutOnly = await engine.run({
    source: { bytes, fileName: "public-api-intent-layout.pdf" },
    intent: "layout",
  });
  assert.equal(layoutOnly.layout.value?.kind, "pdf-layout");
  assert.equal(layoutOnly.knowledge.status, "skipped");
  assert.equal(layoutOnly.render.status, "skipped");

  const knowledgeOnly = await engine.run({
    source: { bytes, fileName: "public-api-intent-knowledge.pdf" },
    intent: "knowledge",
  });
  assert.equal(knowledgeOnly.knowledge.value?.kind, "pdf-knowledge");
  assert.equal(knowledgeOnly.render.status, "skipped");
  assert.equal(knowledgeOnly.diagnostics.some((diagnostic) => diagnostic.stage === "render"), false);

  const renderIntent = await engine.run({
    source: { bytes, fileName: "public-api-intent-render.pdf" },
    intent: "render",
  });
  const defaultRun = await engine.run({
    source: { bytes, fileName: "public-api-intent-default.pdf" },
  });
  assert.equal(renderIntent.render.value?.kind, "pdf-render");
  assert.equal(defaultRun.render.value?.kind, "pdf-render");
  assert.equal(renderIntent.render.value?.renderHash.hex, defaultRun.render.value?.renderHash.hex);
});

test("public IR object shells expose only contract fields", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderResourcePayloads();
  const result = await engine.run({
    source: { bytes, fileName: "public-api-ir-shells.pdf" },
  });

  const allowedObjectShellKeys = new Set([
    "ref",
    "offset",
    "endOffset",
    "hasStream",
    "typeName",
    "dictionaryKeys",
    "streamByteLength",
    "streamFilterNames",
    "streamDecodeState",
    "decodedStreamByteLength",
    "streamRole",
    "containerObjectRef",
  ]);
  const internalPayloadKeys = [
    "dictionaryEntries",
    "objectValueText",
    "streamText",
    "decodedStreamBytes",
    "streamStartOffset",
    "streamEndOffset",
    "streamLengthRef",
  ];
  const objects = result.ir.value?.indirectObjects ?? [];
  assert.ok(objects.length > 0);
  assert.ok(objects.some((objectShell) => objectShell.hasStream && objectShell.decodedStreamByteLength !== undefined));

  for (const objectShell of objects) {
    for (const key of Object.keys(objectShell)) {
      assert.equal(allowedObjectShellKeys.has(key), true, `unexpected public IR key: ${key}`);
    }
    for (const key of internalPayloadKeys) {
      assert.equal(key in objectShell, false, `internal parser field leaked into public IR: ${key}`);
    }
  }

  assert.equal(result.render.value?.resourcePayloads.some((payload) => payload.availability === "available"), true);
});

test("public pipeline contracts expose opt-in OCR provenance and fusion decisions", async () => {
  const provider: PdfOcrProvider = {
    name: "contract-fake-ocr",
    async recognizePage(input) {
      assert.equal(input.pageImage?.mimeType, "image/png");
      return {
        pageNumber: input.pageNumber,
        lines: [
          {
            text: "Scanned Approval",
            confidence: 0.91,
            bbox: {
              x: 72,
              y: 680,
              width: 120,
              height: 18,
            },
          },
        ],
      };
    },
  };
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderImagery();

  const result = await engine.run({
    source: {
      bytes,
      fileName: "public-api-ocr-fusion.pdf",
    },
    ocr: {
      mode: "always",
      provider,
      languages: ["eng"],
    },
  });

  assert.equal(result.observation.value?.ocr?.mode, "always");
  assert.equal(result.observation.value?.ocr?.providerName, "contract-fake-ocr");
  assert.equal(result.observation.value?.ocr?.pages[0]?.decision, "applied");
  assert.equal(result.observation.value?.pages[0]?.runs.some((run) => run.origin === "ocr" && run.text === "Scanned Approval"), true);
  assert.equal(result.layout.value?.pages[0]?.blocks.some((block) => block.text === "Scanned Approval"), true);
  assert.equal(result.knowledge.value?.markdown.includes("Scanned Approval"), true);
  assert.equal(result.observation.value?.knownLimits.includes("ocr-fusion-heuristic"), true);
});

test("public OCR providers receive page imagery outside full pipeline runs", async () => {
  let sawPageImage = false;
  const provider: PdfOcrProvider = {
    name: "contract-stage-ocr",
    async recognizePage(input) {
      sawPageImage = input.pageImage?.mimeType === "image/png";
      return {
        pageNumber: input.pageNumber,
        lines: [
          {
            text: "Stage OCR",
            confidence: 0.95,
          },
        ],
      };
    },
  };
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderImagery();

  const result = await engine.toKnowledge({
    source: {
      bytes,
      fileName: "public-api-ocr-stage.pdf",
    },
    ocr: {
      mode: "always",
      provider,
    },
  });

  assert.equal(sawPageImage, true);
  assert.equal(result.value?.markdown.includes("Stage OCR"), true);
});

test("public OCR auto mode preserves native text without invoking OCR", async () => {
  let callCount = 0;
  const provider: PdfOcrProvider = {
    name: "contract-auto-ocr",
    async recognizePage(input) {
      callCount += 1;
      return {
        pageNumber: input.pageNumber,
        lines: [
          {
            text: "Unexpected OCR",
            confidence: 1,
          },
        ],
      };
    },
  };
  const engine = createPdfEngine();
  const bytes = buildPdfWithPageContents([
    "BT /F1 12 Tf 72 720 Td (Native Text) Tj ET",
  ]);

  const result = await engine.run({
    source: {
      bytes,
      fileName: "public-api-ocr-auto-native.pdf",
    },
    ocr: {
      mode: "auto",
      provider,
    },
  });

  assert.equal(callCount, 0);
  assert.equal(result.observation.value?.ocr?.pages.length, 0);
  assert.equal(result.observation.value?.extractedText.includes("Native Text"), true);
  assert.equal(result.observation.value?.extractedText.includes("Unexpected OCR"), false);
});

test("public OCR always mode fuses OCR lines without replacing native text", async () => {
  const provider: PdfOcrProvider = {
    name: "contract-hybrid-ocr",
    async recognizePage(input) {
      assert.equal(input.pageImage?.mimeType, "image/png");
      return {
        pageNumber: input.pageNumber,
        lines: [
          {
            text: "Supplemental OCR",
            confidence: 0.92,
          },
        ],
      };
    },
  };
  const engine = createPdfEngine();
  const bytes = buildPdfWithPageContents([
    "BT /F1 12 Tf 72 720 Td (Native Text) Tj ET",
  ]);

  const result = await engine.run({
    source: {
      bytes,
      fileName: "public-api-ocr-hybrid-native.pdf",
    },
    ocr: {
      mode: "always",
      provider,
    },
  });

  assert.equal(result.observation.value?.ocr?.pages[0]?.decision, "applied");
  assert.equal(result.observation.value?.extractedText.includes("Native Text"), true);
  assert.equal(result.observation.value?.extractedText.includes("Supplemental OCR"), true);
  assert.equal(result.observation.value?.pages[0]?.runs.some((run) => run.origin === "native-text" && run.text === "Native Text"), true);
  assert.equal(result.observation.value?.pages[0]?.runs.some((run) => run.origin === "ocr" && run.text === "Supplemental OCR"), true);
});

test("public OCR contracts fail closed when provider evidence is unavailable or weak", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderImagery();

  const missingProviderResult = await engine.run({
    source: {
      bytes,
      fileName: "public-api-ocr-missing-provider.pdf",
    },
    ocr: {
      mode: "always",
    },
  });

  assert.equal(missingProviderResult.observation.value?.ocr?.pages[0]?.decision, "provider-unavailable");
  assert.equal(missingProviderResult.observation.value?.knownLimits.includes("ocr-provider-unavailable"), true);
  assert.equal(missingProviderResult.diagnostics.some((diagnostic) => diagnostic.code === "ocr-provider-unavailable"), true);

  const lowConfidenceProvider: PdfOcrProvider = {
    name: "contract-low-confidence-ocr",
    async recognizePage(input) {
      return {
        pageNumber: input.pageNumber,
        lines: [
          {
            text: "Weak Scan",
            confidence: 0.1,
          },
        ],
      };
    },
  };
  const lowConfidenceResult = await engine.run({
    source: {
      bytes,
      fileName: "public-api-ocr-low-confidence.pdf",
    },
    ocr: {
      mode: "always",
      provider: lowConfidenceProvider,
      minConfidence: 0.8,
    },
  });

  assert.equal(lowConfidenceResult.observation.value?.ocr?.pages[0]?.decision, "low-confidence");
  assert.equal(lowConfidenceResult.observation.value?.knownLimits.includes("ocr-low-confidence"), true);
  assert.equal(lowConfidenceResult.observation.value?.pages[0]?.runs.some((run) => run.text === "Weak Scan"), false);
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

test("public layout contracts expose interpreted regions with inference evidence", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithPageContents([
    [
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
      "ET",
    ].join("\n"),
  ]);

  const result = await engine.run({
    source: {
      bytes,
      fileName: "public-api-layout-regions.pdf",
    },
  });

  const tableRegion = result.layout.value?.pages[0]?.regions?.find((region) => region.kind === "table");

  assert.ok(tableRegion);
  assert.equal(tableRegion?.pageNumber, 1);
  assert.ok(Array.isArray(tableRegion?.blockIds));
  assert.ok(tableRegion?.blockIds.length);
  assert.ok(tableRegion?.inferences?.some((inference) =>
    inference.kind === "region" &&
    inference.status === "inferred" &&
    inference.evidenceBlockIds?.length === tableRegion.blockIds.length
  ));
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

test("public render contracts expose image-mask payload metadata and invocation state", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderImageMask();

  const result = await engine.run({
    source: {
      bytes,
      fileName: "public-api-render-image-mask.pdf",
    },
  });

  const renderDocument = result.render.value;
  assert.ok(renderDocument);
  const imagePayload = renderDocument?.resourcePayloads.find((payload) => payload.kind === "image");
  const imageCommand = renderDocument?.pages[0]?.displayList.commands.find((command) => command.kind === "image");
  assert.equal(imagePayload?.kind, "image");
  assert.equal(imageCommand?.kind, "image");
  if (imagePayload?.kind !== "image" || imageCommand?.kind !== "image") {
    return;
  }

  assert.equal(imagePayload.availability, "available");
  assert.equal(imagePayload.imageMask, true);
  assert.equal(imagePayload.bitsPerComponent, 1);
  assert.deepEqual(imagePayload.decodeValues, [0, 1]);
  assert.equal(imageCommand.imagePayloadId, imagePayload.id);
  assert.deepEqual(imageCommand.colorState?.fillColor?.components, [1, 0, 0]);
  assert.equal(imageCommand.transparencyState?.fillAlpha, 1);
  assert.ok(renderDocument.pages[0]?.imagery?.svg?.markup.includes("<image"));
  assert.equal(renderDocument.knownLimits.includes("render-imagery-partial"), false);
});

test("public render contracts expose page-box-aware imagery", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderImagery();

  const result = await engine.run({
    source: {
      bytes,
      fileName: "public-api-render-imagery-raster.pdf",
    },
  });

  const renderPage = result.render.value?.pages[0];
  assert.ok(renderPage);
  assert.ok(renderPage?.imagery?.svg);
  assert.ok(renderPage?.imagery?.raster);
  if (!renderPage?.imagery?.svg || !renderPage.imagery.raster) {
    return;
  }
  assert.deepEqual(renderPage?.pageBox, {
    x: 10,
    y: 20,
    width: 200,
    height: 160,
  });
  assert.equal(renderPage.imagery.svg.mimeType, "image/svg+xml");
  assert.equal(renderPage.imagery.svg.width, 200);
  assert.equal(renderPage.imagery.svg.height, 160);
  assert.equal(renderPage.imagery.raster.mimeType, "image/png");
  assert.equal(renderPage.imagery.raster.width, 200);
  assert.equal(renderPage.imagery.raster.height, 160);
  assert.deepEqual(
    Array.from(renderPage.imagery.raster.bytes.subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(result.render.value?.knownLimits.includes("render-imagery-partial"), true);
});
