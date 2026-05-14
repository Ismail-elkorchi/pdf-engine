import { strict as assert } from "node:assert";
import { test } from "node:test";

import { decodeCcittFaxBytes } from "../../src/ccitt-fax-decode.ts";

function packBits(bitText: string): Uint8Array {
  const padded = bitText.padEnd(Math.ceil(bitText.length / 8) * 8, "0");
  const bytes: number[] = [];

  for (let offset = 0; offset < padded.length; offset += 8) {
    bytes.push(Number.parseInt(padded.slice(offset, offset + 8), 2));
  }

  return Uint8Array.from(bytes);
}

test("decodeCcittFaxBytes decodes one-dimensional rows", () => {
  const decoded = decodeCcittFaxBytes(packBits("0111101000"), {
    k: 0,
    endOfLine: false,
    encodedByteAlign: false,
    columns: 8,
    rows: 1,
    endOfBlock: false,
    blackIs1: false,
  });

  assert.deepEqual(Array.from(decoded), [0xc7]);
});

test("decodeCcittFaxBytes decodes two-dimensional rows", () => {
  const decoded = decodeCcittFaxBytes(packBits("00101110010"), {
    k: -1,
    endOfLine: false,
    encodedByteAlign: false,
    columns: 8,
    rows: 1,
    endOfBlock: false,
    blackIs1: false,
  });

  assert.deepEqual(Array.from(decoded), [0xc0]);
});

test("decodeCcittFaxBytes respects BlackIs1 output polarity", () => {
  const decoded = decodeCcittFaxBytes(packBits("0111101000"), {
    k: 0,
    endOfLine: false,
    encodedByteAlign: false,
    columns: 8,
    rows: 1,
    endOfBlock: false,
    blackIs1: true,
  });

  assert.deepEqual(Array.from(decoded), [0x38]);
});

test("decodeCcittFaxBytes respects declared row and column counts", () => {
  const decoded = decodeCcittFaxBytes(packBits("011110100010011"), {
    k: 0,
    endOfLine: false,
    encodedByteAlign: false,
    columns: 8,
    rows: 2,
    endOfBlock: false,
    blackIs1: false,
  });

  assert.deepEqual(Array.from(decoded), [0xc7, 0xff]);
});

test("decodeCcittFaxBytes rejects malformed streams", () => {
  const malformed = packBits("1");
  assert.throws(
    () =>
      decodeCcittFaxBytes(malformed, {
        k: 0,
        endOfLine: false,
        encodedByteAlign: false,
        columns: 8,
        rows: 1,
        endOfBlock: false,
        blackIs1: false,
      }),
    /Malformed CCITT fax stream\./,
  );
});
