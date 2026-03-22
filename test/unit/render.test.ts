import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildRenderDocument } from "../../src/render.ts";

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
  assert.ok(renderDocument.knownLimits.includes("render-display-list-only"));
  assert.ok(renderDocument.knownLimits.includes("render-raster-not-implemented"));
  assert.equal(renderDocument.renderHash.algorithm, "sha-256");
  assert.equal(renderDocument.renderHash.hex.length, 64);
});
