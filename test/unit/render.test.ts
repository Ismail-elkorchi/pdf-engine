import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildRenderDocument, canonicalizeRenderHashValue } from "../../src/render.ts";
import { buildRenderPageImagery } from "../../src/render-imagery.ts";
import { createPdfEngine } from "../../src/index.ts";
import type { PdfObservedPage } from "../../src/contracts.ts";
import {
  buildPdfWithDenseVectorImagery,
  buildPdfWithOverscaledImageImagery,
  buildPdfWithPageSpecs,
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

test("buildRenderPageImagery downscales raster when eager raster work exceeds the page budget", () => {
  const imagery = buildRenderPageImagery({
    pageBox: {
      x: 0,
      y: 0,
      width: 1_000,
      height: 1_000,
    },
    resourcePayloads: [],
    rasterBudgetBytes: 100_000,
    displayList: {
      commands: [
        {
          id: "large-path-1",
          kind: "path",
          contentOrder: 0,
          paintOperator: "f",
          paintState: {
            lineWidth: 1,
            lineCapStyle: "butt",
            lineJoinStyle: "miter",
            miterLimit: 10,
            dashPattern: {
              segments: [],
              phase: 0,
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
              components: [0, 0, 0],
            },
            fillColor: {
              colorSpace: {
                kind: "device-rgb",
              },
              components: [0.8, 0.8, 0.8],
            },
          },
          transparencyState: {
            strokeAlpha: 1,
            fillAlpha: 1,
            blendMode: "normal",
            softMask: "none",
          },
          segments: [
            {
              kind: "rectangle",
              x: 0,
              y: 0,
              width: 1_000,
              height: 1_000,
            },
          ],
          pointCount: 4,
          closed: true,
          bbox: {
            x: 0,
            y: 0,
            width: 1_000,
            height: 1_000,
          },
        },
      ],
    },
  });

  assert.ok(imagery.imagery?.svg);
  assert.ok(imagery.imagery?.raster);
  assert.equal(imagery.imagery?.svg.width, 1_000);
  assert.equal(imagery.imagery?.svg.height, 1_000);
  assert.ok((imagery.imagery?.raster?.width ?? 1_000) < 1_000);
  assert.ok((imagery.imagery?.raster?.height ?? 1_000) < 1_000);
  assert.ok((imagery.imagery?.raster?.bytes.byteLength ?? 0) <= 100_000);
  assert.equal(imagery.knownLimits.includes("render-imagery-partial"), true);
});

test("buildRenderPageImagery omits oversized SVG while preserving raster imagery", () => {
  const imagery = buildRenderPageImagery({
    pageBox: {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    },
    resourcePayloads: [],
    svgBudgetCharacters: 1,
    displayList: {
      commands: [
        {
          id: "path-1",
          kind: "path",
          contentOrder: 0,
          paintOperator: "f",
          paintState: {
            lineWidth: 1,
            lineCapStyle: "butt",
            lineJoinStyle: "miter",
            miterLimit: 10,
            dashPattern: {
              segments: [],
              phase: 0,
            },
          },
          colorState: {
            strokeColorSpace: {
              kind: "device-rgb",
            },
            fillColorSpace: {
              kind: "device-rgb",
            },
            fillColor: {
              colorSpace: {
                kind: "device-rgb",
              },
              components: [0.2, 0.4, 0.6],
            },
          },
          transparencyState: {
            strokeAlpha: 1,
            fillAlpha: 1,
            blendMode: "normal",
            softMask: "none",
          },
          segments: [
            {
              kind: "rectangle",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
            },
          ],
          pointCount: 4,
          closed: true,
          bbox: {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
          },
        },
      ],
    },
  });

  assert.equal(imagery.imagery?.svg, undefined);
  assert.ok(imagery.imagery?.raster);
  assert.equal(imagery.imagery?.raster?.width, 100);
  assert.equal(imagery.imagery?.raster?.height, 100);
  assert.equal(imagery.knownLimits.includes("render-imagery-partial"), true);
});

test("buildRenderDocument preserves raster page coverage when the document raster budget is shared", async () => {
  const pages: PdfObservedPage[] = Array.from({ length: 3 }, (_, pageIndex) => ({
    pageNumber: pageIndex + 1,
    resolutionMethod: "page-tree",
    glyphs: [],
    runs: [],
    marks: [
      {
        id: `large-path-${pageIndex + 1}`,
        kind: "path",
        pageNumber: pageIndex + 1,
        contentOrder: 0,
        paintOperator: "f",
        paintState: {
          lineWidth: 1,
          lineCapStyle: "butt",
          lineJoinStyle: "miter",
          miterLimit: 10,
          dashPattern: {
            segments: [],
            phase: 0,
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
            components: [0, 0, 0],
          },
          fillColor: {
            colorSpace: {
              kind: "device-rgb",
            },
            components: [0.8, 0.8, 0.8],
          },
        },
        transparencyState: {
          strokeAlpha: 1,
          fillAlpha: 1,
          blendMode: "normal",
          softMask: "none",
        },
        segments: [
          {
            kind: "rectangle",
            x: 0,
            y: 0,
            width: 10_000,
            height: 3_000,
          },
        ],
        pointCount: 4,
        closed: true,
        bbox: {
          x: 0,
          y: 0,
          width: 10_000,
          height: 3_000,
        },
      },
    ],
  }));
  const renderDocument = await buildRenderDocument({
    kind: "pdf-observation",
    strategy: "content-stream-interpreter",
    extractedText: "",
    knownLimits: [],
    pages,
  });

  assert.equal(renderDocument.pages.length, 3);
  for (const renderPage of renderDocument.pages) {
    assert.ok(renderPage.imagery?.svg);
    assert.ok(renderPage.imagery?.raster);
    assert.ok(renderPage.imagery.raster.width < 10_000);
    assert.ok(renderPage.imagery.raster.height < 3_000);
  }
  assert.equal(renderDocument.knownLimits.includes("render-imagery-partial"), true);
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
  assertValidPngWithStoredZlib(renderPage.imagery.raster.bytes);
  assert.ok(renderDocument?.knownLimits.includes("render-imagery-partial"));
});

test("buildRenderDocument emits imagery for dense vector-heavy PDFs", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithDenseVectorImagery();

  const result = await engine.run({
    source: {
      bytes,
      fileName: "dense-vector-render.pdf",
    },
  });

  const renderDocument = result.render.value;
  assert.ok(renderDocument);
  assert.equal(renderDocument?.pages.length, 3);
  for (const page of renderDocument?.pages ?? []) {
    assert.ok(page.imagery?.svg);
    assert.ok(page.imagery?.raster);
    if (!page.imagery?.svg || !page.imagery.raster) {
      continue;
    }
    assert.equal(page.imagery.svg.mimeType, "image/svg+xml");
    assert.equal(page.imagery.raster.mimeType, "image/png");
    assert.deepEqual(
      Array.from(page.imagery.raster.bytes.subarray(0, 8)),
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  }
});

test("buildRenderDocument keeps dense rectangle imagery deterministic", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithDenseVectorImagery({
    ruleCount: 64,
    rectangleCount: 96,
  });

  const first = await engine.run({
    source: {
      bytes,
      fileName: "dense-rectangles.pdf",
    },
  });
  const second = await engine.run({
    source: {
      bytes,
      fileName: "dense-rectangles.pdf",
    },
  });

  const firstPages = first.render.value?.pages ?? [];
  const secondPages = second.render.value?.pages ?? [];
  assert.equal(firstPages.length, secondPages.length);
  for (const [pageIndex, firstPage] of firstPages.entries()) {
    const secondPage = secondPages[pageIndex];
    assert.ok(firstPage?.imagery?.raster);
    assert.ok(secondPage?.imagery?.raster);
    if (!firstPage?.imagery?.raster || !secondPage?.imagery?.raster) {
      continue;
    }
    assert.deepEqual(firstPage.imagery.raster.bytes, secondPage.imagery.raster.bytes);
    assert.equal(firstPage.renderHash.hex, secondPage.renderHash.hex);
  }
});

test("buildRenderDocument treats dashed vector paths as supported imagery", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithPageSpecs([
    {
      mediaBox: [0, 0, 200, 120],
      content: [
        "0 0 0 RG",
        "2 w",
        "[6 3] 0 d",
        "20 60 m",
        "180 60 l",
        "S",
      ].join("\n"),
    },
  ]);

  const result = await engine.run({
    source: {
      bytes,
      fileName: "render-dashed-vector-path.pdf",
    },
  });

  assert.ok(result.render.value?.pages[0]?.imagery?.svg?.markup.includes("stroke-dasharray=\"6 3\""));
  assert.equal(result.render.value?.knownLimits.includes("render-imagery-partial"), false);
});

test("buildRenderDocument clips overscaled image raster work to the visible page box", async () => {
  const engine = createPdfEngine();
  const bytes = buildPdfWithOverscaledImageImagery();

  const result = await engine.run({
    source: {
      bytes,
      fileName: "overscaled-image-render.pdf",
    },
  });

  const renderPage = result.render.value?.pages[0];
  assert.ok(renderPage?.imagery?.svg);
  assert.ok(renderPage?.imagery?.raster);
  if (!renderPage?.imagery?.svg || !renderPage.imagery.raster) {
    return;
  }
  assert.deepEqual(renderPage.pageBox, {
    x: 10,
    y: 20,
    width: 200,
    height: 160,
  });
  assert.equal(renderPage.imagery.raster.width, 200);
  assert.equal(renderPage.imagery.raster.height, 160);
  assert.deepEqual(
    Array.from(renderPage.imagery.raster.bytes.subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
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

test("canonicalizeRenderHashValue compacts large strings into deterministic digests", async () => {
  const largeString = "Dense render hash content ".repeat(512);

  const first = await canonicalizeRenderHashValue(largeString);
  const second = await canonicalizeRenderHashValue(largeString);

  assert.equal(first, second);
  assert.ok(first.includes(`"$$type":"LargeString"`));
  assert.ok(first.includes(`"byteLength":${String(new TextEncoder().encode(largeString).byteLength)}`));
  assert.equal(first.includes(largeString.slice(0, 24)), false);
});

function assertValidPngWithStoredZlib(bytes: Uint8Array): void {
  assert.deepEqual(
    Array.from(bytes.subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );

  let offset = 8;
  const idatParts: Uint8Array[] = [];
  let sawIhdr = false;
  let sawIend = false;

  while (offset < bytes.length) {
    const length = readUint32(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    assert.ok(crcOffset + 4 <= bytes.length, "PNG chunk extends beyond the byte buffer.");

    const typeBytes = bytes.subarray(typeStart, dataStart);
    const data = bytes.subarray(dataStart, dataEnd);
    const type = new TextDecoder().decode(typeBytes);
    assert.equal(crc32ForTest(typeBytes, data), readUint32(bytes, crcOffset));

    if (type === "IHDR") {
      sawIhdr = true;
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      sawIend = true;
      offset = crcOffset + 4;
      break;
    }

    offset = crcOffset + 4;
  }

  assert.equal(sawIhdr, true);
  assert.equal(sawIend, true);
  assert.equal(offset, bytes.length);

  const compressed = concatForTest(idatParts);
  assert.equal(compressed[0], 0x78);
  assert.equal(compressed[1], 0x01);
  assertStoredZlibBlocks(compressed);
}

function assertStoredZlibBlocks(compressed: Uint8Array): void {
  let offset = 2;
  const rawParts: Uint8Array[] = [];

  while (offset < compressed.length - 4) {
    const blockHeader = compressed[offset] ?? 0;
    const isFinal = (blockHeader & 1) === 1;
    const blockType = (blockHeader >> 1) & 0b11;
    assert.equal(blockType, 0);

    const length = (compressed[offset + 1] ?? 0) | ((compressed[offset + 2] ?? 0) << 8);
    const complement = (compressed[offset + 3] ?? 0) | ((compressed[offset + 4] ?? 0) << 8);
    assert.equal((length ^ complement) & 0xffff, 0xffff);

    const dataStart = offset + 5;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd <= compressed.length - 4, "Stored zlib block extends beyond the byte buffer.");
    rawParts.push(compressed.subarray(dataStart, dataEnd));
    offset = dataEnd;

    if (isFinal) {
      break;
    }
  }

  assert.equal(offset, compressed.length - 4);
  const rawBytes = concatForTest(rawParts);
  assert.equal(adler32ForTest(rawBytes), readUint32(compressed, compressed.length - 4));
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    (((bytes[offset + 1] ?? 0) << 16) >>> 0) +
    (((bytes[offset + 2] ?? 0) << 8) >>> 0) +
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function concatForTest(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function adler32ForTest(bytes: Uint8Array): number {
  let s1 = 1;
  let s2 = 0;
  for (const value of bytes) {
    s1 = (s1 + value) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

function crc32ForTest(...parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const bytes of parts) {
    for (const value of bytes) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
