import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildRenderDocument, canonicalizeRenderHashValue } from "../../src/render.ts";
import { createPdfEngine } from "../../src/index.ts";
import {
  buildPdfWithRenderImagery,
  buildPdfWithRenderResourcePayloads,
} from "../shared/pdf-builders.ts";

test("buildRenderDocument lifts observed marks into a render document", async () => {
  const renderDocument = await buildRenderDocument({
    kind: "pdf-observation",
    strategy: "content-stream-interpreter",
    extractedText: "Hello Render",
    knownLimits: ["layout-block-heuristic"],
    pages: [
      {
        pageNumber: 1,
        resolutionMethod: "page-tree",
        glyphs: [],
        runs: [],
        marks: [
          {
            id: "text-1",
            kind: "text",
            pageNumber: 1,
            contentOrder: 0,
            runId: "run-1",
            glyphIds: ["glyph-1"],
            text: "Hello Render",
            origin: "native-text",
            bbox: {
              x: 10,
              y: 20,
              width: 80,
              height: 12,
            },
            anchor: {
              x: 10,
              y: 20,
            },
            writingMode: "horizontal",
            fontSize: 12,
          },
          {
            id: "path-1",
            kind: "path",
            pageNumber: 1,
            contentOrder: 1,
            paintOperator: "S",
            paintState: {
              lineWidth: 2,
              lineCapStyle: "round",
              lineJoinStyle: "bevel",
              miterLimit: 5,
              dashPattern: {
                segments: [3, 1],
                phase: 2,
              },
            },
            colorState: {
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
            },
            transparencyState: {
              strokeAlpha: 0.5,
              fillAlpha: 0.25,
              blendMode: "multiply",
              softMask: "present",
            },
            segments: [
              {
                kind: "move-to",
                to: { x: 0, y: 0 },
              },
              {
                kind: "line-to",
                to: { x: 10, y: 10 },
              },
            ],
            pointCount: 2,
            closed: false,
          },
          {
            id: "xobject-1",
            kind: "xobject",
            pageNumber: 1,
            contentOrder: 2,
            resourceName: "Fx1",
            xObjectRef: {
              objectNumber: 12,
              generationNumber: 0,
            },
            subtypeName: "/Form",
            transparencyGroup: {
              isolated: true,
              knockout: false,
              colorSpace: {
                kind: "device-rgb",
              },
            },
          },
        ],
      },
    ],
  });

  assert.equal(renderDocument.kind, "pdf-render");
  assert.equal(renderDocument.strategy, "observed-display-list");
  assert.equal(renderDocument.pages.length, 1);
  assert.equal(renderDocument.pages[0]?.textIndex.text, "Hello Render");
  assert.deepEqual(renderDocument.pages[0]?.textIndex.spans, [
    {
      id: "render-text-span-1-1",
      contentOrder: 0,
      text: "Hello Render",
      glyphIds: ["glyph-1"],
      runId: "run-1",
      bbox: {
        x: 10,
        y: 20,
        width: 80,
        height: 12,
      },
      anchor: {
        x: 10,
        y: 20,
      },
      writingMode: "horizontal",
    },
  ]);
  assert.deepEqual(renderDocument.pages[0]?.selectionModel.units, [
    {
      id: "render-selection-unit-1-1",
      textSpanId: "render-text-span-1-1",
      text: "Hello Render",
      glyphIds: ["glyph-1"],
      bbox: {
        x: 10,
        y: 20,
        width: 80,
        height: 12,
      },
      anchor: {
        x: 10,
        y: 20,
      },
      writingMode: "horizontal",
    },
  ]);
  assert.equal(renderDocument.pages[0]?.displayList.commands.length, 3);
  assert.equal(renderDocument.pages[0]?.displayList.commands[0]?.kind, "text");
  assert.equal(renderDocument.pages[0]?.displayList.commands[1]?.kind, "path");
  assert.equal(renderDocument.pages[0]?.displayList.commands[2]?.kind, "xobject");
  assert.deepEqual(
    renderDocument.pages[0]?.displayList.commands[1]?.kind === "path"
      ? renderDocument.pages[0].displayList.commands[1].paintState
      : undefined,
    {
      lineWidth: 2,
      lineCapStyle: "round",
      lineJoinStyle: "bevel",
      miterLimit: 5,
      dashPattern: {
        segments: [3, 1],
        phase: 2,
      },
    },
  );
  assert.deepEqual(
    renderDocument.pages[0]?.displayList.commands[1]?.kind === "path"
      ? renderDocument.pages[0].displayList.commands[1].colorState
      : undefined,
    {
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
    },
  );
  assert.deepEqual(
    renderDocument.pages[0]?.displayList.commands[1]?.kind === "path"
      ? renderDocument.pages[0].displayList.commands[1].transparencyState
      : undefined,
    {
      strokeAlpha: 0.5,
      fillAlpha: 0.25,
      blendMode: "multiply",
      softMask: "present",
    },
  );
  assert.deepEqual(
    renderDocument.pages[0]?.displayList.commands[1]?.kind === "path"
      ? renderDocument.pages[0].displayList.commands[1].segments
      : undefined,
    [
      {
        kind: "move-to",
        to: { x: 0, y: 0 },
      },
      {
        kind: "line-to",
        to: { x: 10, y: 10 },
      },
    ],
  );
  assert.deepEqual(
    renderDocument.pages[0]?.displayList.commands[2]?.kind === "xobject"
      ? renderDocument.pages[0].displayList.commands[2].transparencyGroup
      : undefined,
    {
      isolated: true,
      knockout: false,
      colorSpace: {
        kind: "device-rgb",
      },
    },
  );
  assert.ok(renderDocument.knownLimits.includes("layout-block-heuristic"));
  assert.ok(renderDocument.knownLimits.includes("render-imagery-partial"));
  assert.deepEqual(renderDocument.pages[0]?.pageBox, {
    x: 10,
    y: 20,
    width: 80,
    height: 12,
  });
  assert.ok(renderDocument.pages[0]?.imagery?.svg);
  assert.ok(renderDocument.pages[0]?.imagery?.raster);
  if (!renderDocument.pages[0]?.imagery?.svg || !renderDocument.pages[0].imagery.raster) {
    return;
  }
  assert.equal(renderDocument.pages[0].imagery.svg.mimeType, "image/svg+xml");
  assert.equal(renderDocument.pages[0].imagery.raster.mimeType, "image/png");
  assert.deepEqual(
    Array.from(renderDocument.pages[0].imagery.raster.bytes.subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.deepEqual(renderDocument.resourcePayloads, []);
  assert.equal(renderDocument.renderHash.algorithm, "sha-256");
  assert.equal(renderDocument.renderHash.hex.length, 64);
});

test("buildRenderDocument exposes font and image resource payloads for later imagery work", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderResourcePayloads();

  const result = await engine.run({
    source: {
      bytes,
      fileName: "render-resource-payloads.pdf",
    },
  });

  const renderDocument = result.render.value;
  assert.ok(renderDocument);
  assert.equal(renderDocument?.resourcePayloads.length, 2);
  const fontPayload = renderDocument?.resourcePayloads.find((payload) => payload.kind === "font");
  const imagePayload = renderDocument?.resourcePayloads.find((payload) => payload.kind === "image");
  assert.ok(fontPayload);
  assert.ok(imagePayload);
  if (fontPayload?.kind !== "font" || imagePayload?.kind !== "image") {
    return;
  }

  assert.equal(fontPayload.availability, "available");
  assert.equal(fontPayload.fontProgramFormat, "type1");
  assert.deepEqual(Array.from(fontPayload.bytes ?? []), [84, 69, 83, 84]);
  assert.equal(imagePayload.availability, "available");
  assert.deepEqual(Array.from(imagePayload.bytes ?? []), [65]);
  assert.equal(imagePayload.width, 1);
  assert.equal(imagePayload.height, 1);
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

test("buildRenderDocument emits page-box-aware SVG and PNG imagery", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithRenderImagery();

  const result = await engine.run({
    source: {
      bytes,
      fileName: "render-imagery-raster.pdf",
    },
  });

  const renderDocument = result.render.value;
  const renderPage = renderDocument?.pages[0];
  assert.ok(renderDocument);
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
  assert.ok(renderPage.imagery.svg.markup.includes("<svg"));
  assert.ok(renderPage.imagery.svg.markup.includes("<text"));
  assert.ok(renderPage.imagery.svg.markup.includes("<path"));
  assert.ok(renderPage.imagery.svg.markup.includes("<image"));
  assert.equal(renderPage.imagery.raster.mimeType, "image/png");
  assert.equal(renderPage.imagery.raster.width, 200);
  assert.equal(renderPage.imagery.raster.height, 160);
  assert.deepEqual(
    Array.from(renderPage.imagery.raster.bytes.subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.ok(renderDocument?.knownLimits.includes("render-imagery-partial"));
});

test("canonicalizeRenderHashValue compacts large byte arrays into deterministic digests", async () => {
  const largeBytes = new Uint8Array(4096);
  for (let index = 0; index < largeBytes.length; index += 1) {
    largeBytes[index] = index % 251;
  }

  const first = await canonicalizeRenderHashValue({
    kind: "raster",
    bytes: largeBytes,
  });
  const second = await canonicalizeRenderHashValue({
    kind: "raster",
    bytes: largeBytes,
  });

  assert.equal(first, second);
  assert.ok(first.includes(`"byteLength":${String(largeBytes.byteLength)}`));
  assert.ok(first.includes(`"$$type":"Uint8Array"`));
  assert.equal(first.includes(`"bytes":[`), false);
  assert.ok(first.length < largeBytes.byteLength);
});
