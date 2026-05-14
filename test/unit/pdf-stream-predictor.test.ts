import { strict as assert } from "node:assert";
import { test } from "node:test";

import { applyPdfStreamPredictor } from "../../src/pdf-stream-predictor.ts";

function packBits(bits: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));

  for (const [index, bit] of bits.entries()) {
    if (bit !== 0) {
      const byteIndex = Math.floor(index / 8);
      const current = bytes[byteIndex] ?? 0;
      bytes[byteIndex] = current | (1 << (7 - (index % 8)));
    }
  }

  return bytes;
}

function encodeTiff1BitRow(decodedBits: readonly number[]): Uint8Array {
  const encodedBits: number[] = [];
  let previousBit = 0;

  for (const bit of decodedBits) {
    encodedBits.push(bit ^ previousBit);
    previousBit = bit;
  }

  return packBits(encodedBits);
}

function encodePngPredictorRow(
  decodedRow: ArrayLike<number>,
  previousRow: ArrayLike<number>,
  predictorByte: number,
  pixelBytes: number,
): Uint8Array {
  const encoded = new Uint8Array(decodedRow.length + 1);
  encoded[0] = predictorByte;

  for (let index = 0; index < decodedRow.length; index += 1) {
    const current = decodedRow[index] ?? 0;
    const left = index >= pixelBytes ? decodedRow[index - pixelBytes] ?? 0 : 0;
    const up = previousRow[index] ?? 0;
    const upLeft = index >= pixelBytes ? previousRow[index - pixelBytes] ?? 0 : 0;

    switch (predictorByte) {
      case 0:
        encoded[index + 1] = current;
        break;
      case 1:
        encoded[index + 1] = (current - left + 256) & 0xff;
        break;
      case 2:
        encoded[index + 1] = (current - up + 256) & 0xff;
        break;
      case 3:
        encoded[index + 1] = (current - Math.floor((left + up) / 2) + 256) & 0xff;
        break;
      case 4: {
        const prediction = left + up - upLeft;
        const leftDistance = Math.abs(prediction - left);
        const upDistance = Math.abs(prediction - up);
        const upLeftDistance = Math.abs(prediction - upLeft);
        const paeth =
          leftDistance <= upDistance && leftDistance <= upLeftDistance
            ? left
            : upDistance <= upLeftDistance
              ? up
              : upLeft;
        encoded[index + 1] = (current - paeth + 256) & 0xff;
        break;
      }
      default:
        throw new Error(`Unsupported predictor byte in test helper: ${String(predictorByte)}`);
    }
  }

  return encoded;
}

test("applyPdfStreamPredictor decodes TIFF predictor rows for 1-bit samples", () => {
  const firstRow = [1, 0, 1, 1, 0, 0, 1, 0];
  const secondRow = [0, 1, 1, 0, 0, 1, 0, 1];
  const encoded = Uint8Array.from([
    ...encodeTiff1BitRow(firstRow),
    ...encodeTiff1BitRow(secondRow),
  ]);

  const decoded = applyPdfStreamPredictor(encoded, {
    predictor: 2,
    colors: 1,
    bitsPerComponent: 1,
    columns: 8,
  });

  assert.deepEqual(Array.from(decoded), [0b10110010, 0b01100101]);
});

test("applyPdfStreamPredictor decodes TIFF predictor rows for 8-bit samples", () => {
  const decoded = applyPdfStreamPredictor(Uint8Array.from([5, 2, 3, 4]), {
    predictor: 2,
    colors: 1,
    bitsPerComponent: 8,
    columns: 4,
  });

  assert.deepEqual(Array.from(decoded), [5, 7, 10, 14]);
});

test("applyPdfStreamPredictor decodes TIFF predictor rows for 16-bit samples", () => {
  const decoded = applyPdfStreamPredictor(
    Uint8Array.from([0x00, 0x01, 0x00, 0x02, 0x00, 0x03]),
    {
      predictor: 2,
      colors: 1,
      bitsPerComponent: 16,
      columns: 3,
    },
  );

  assert.deepEqual(Array.from(decoded), [0x00, 0x01, 0x00, 0x03, 0x00, 0x06]);
});

test("applyPdfStreamPredictor decodes PNG predictor rows 0 through 4", () => {
  const rows: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [
    Uint8Array.from([10, 20, 30]),
    Uint8Array.from([15, 25, 40]),
    Uint8Array.from([20, 35, 50]),
    Uint8Array.from([25, 45, 60]),
    Uint8Array.from([26, 50, 70]),
  ];
  const encoded = Uint8Array.from([
    ...encodePngPredictorRow(rows[0], [0, 0, 0], 0, 1),
    ...encodePngPredictorRow(rows[1], rows[0], 1, 1),
    ...encodePngPredictorRow(rows[2], rows[1], 2, 1),
    ...encodePngPredictorRow(rows[3], rows[2], 3, 1),
    ...encodePngPredictorRow(rows[4], rows[3], 4, 1),
  ]);

  const decoded = applyPdfStreamPredictor(encoded, {
    predictor: 12,
    colors: 1,
    bitsPerComponent: 8,
    columns: 3,
  });

  assert.deepEqual(Array.from(decoded), rows.flatMap((row) => Array.from(row)));
});

test("applyPdfStreamPredictor rejects malformed PNG predictor row lengths", () => {
  assert.throws(
    () =>
      applyPdfStreamPredictor(Uint8Array.from([0, 1, 2]), {
        predictor: 10,
        colors: 1,
        bitsPerComponent: 8,
        columns: 3,
      }),
    /Malformed PNG predictor row/,
  );
});

test("applyPdfStreamPredictor rejects unsupported predictors", () => {
  assert.throws(
    () =>
      applyPdfStreamPredictor(Uint8Array.from([1, 2, 3]), {
        predictor: 9,
        colors: 1,
        bitsPerComponent: 8,
        columns: 3,
      }),
    /Unsupported PDF predictor/,
  );
});
