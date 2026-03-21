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
          },
          {
            id: "path-1",
            kind: "path",
            pageNumber: 1,
            contentOrder: 1,
            paintOperator: "S",
            pointCount: 2,
            closed: false,
          },
        ],
      },
    ],
  });

  assert.equal(renderDocument.kind, "pdf-render");
  assert.equal(renderDocument.strategy, "observed-display-list");
  assert.equal(renderDocument.pages.length, 1);
  assert.equal(renderDocument.pages[0]?.displayList.commands.length, 2);
  assert.equal(renderDocument.pages[0]?.displayList.commands[0]?.kind, "text");
  assert.equal(renderDocument.pages[0]?.displayList.commands[1]?.kind, "path");
  assert.ok(renderDocument.knownLimits.includes("layout-block-heuristic"));
  assert.ok(renderDocument.knownLimits.includes("render-display-list-only"));
  assert.ok(renderDocument.knownLimits.includes("render-raster-not-implemented"));
  assert.equal(renderDocument.renderHash.algorithm, "sha-256");
  assert.equal(renderDocument.renderHash.hex.length, 64);
});
