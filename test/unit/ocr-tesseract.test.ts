import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createTesseractOcrProvider } from "../../src/ocr/tesseract.ts";

test("createTesseractOcrProvider normalizes line confidence and disposes the worker", async () => {
  let recognizeBytesLength = 0;
  let terminated = false;
  const provider = createTesseractOcrProvider({
    async loadModule() {
      return {
        async createWorker(languages) {
          assert.deepEqual(languages, ["eng"]);
          return {
            async recognize(image) {
              recognizeBytesLength = image.byteLength;
              return {
                data: {
                  lines: [
                    {
                      text: "  OCR Line  ",
                      confidence: 95,
                      bbox: {
                        x0: 10,
                        y0: 20,
                        x1: 110,
                        y1: 38,
                      },
                    },
                  ],
                },
              };
            },
            async terminate() {
              terminated = true;
            },
          };
        },
      };
    },
  });

  const result = await provider.recognizePage({
    source: {
      bytes: new Uint8Array([37, 80, 68, 70]),
    },
    pageNumber: 1,
    reason: "explicit",
    languages: ["eng"],
    pageImage: {
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      width: 1,
      height: 1,
    },
  });

  assert.equal(recognizeBytesLength, 3);
  assert.equal(result.lines[0]?.text, "OCR Line");
  assert.equal(result.lines[0]?.confidence, 0.95);
  assert.deepEqual(result.lines[0]?.bbox, {
    x: 10,
    y: 20,
    width: 100,
    height: 18,
  });

  await provider.dispose?.();
  assert.equal(terminated, true);
});

test("createTesseractOcrProvider fails closed when page imagery is absent", async () => {
  const provider = createTesseractOcrProvider({
    async loadModule() {
      throw new Error("module should not load without page imagery");
    },
  });

  await assert.rejects(
    provider.recognizePage({
      source: {
        bytes: new Uint8Array([37, 80, 68, 70]),
      },
      pageNumber: 1,
      reason: "explicit",
      languages: ["eng"],
    }),
    /requires a page image/u,
  );
});
