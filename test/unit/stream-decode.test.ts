import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import {
  decodePdfStreamBytes,
  readPdfStreamFilters,
} from "../../src/stream-decode.ts";

function packBits(bitText: string): Uint8Array {
  const padded = bitText.padEnd(Math.ceil(bitText.length / 8) * 8, "0");
  const bytes: number[] = [];

  for (let offset = 0; offset < padded.length; offset += 8) {
    bytes.push(Number.parseInt(padded.slice(offset, offset + 8), 2));
  }

  return Uint8Array.from(bytes);
}

function packLzwCodes(codes: readonly number[], options: { readonly earlyChange: number }): Uint8Array {
  let codeLength = 9;
  let nextCode = 258;
  let previousCode: number | undefined;
  let bits = "";

  for (const code of codes) {
    bits += code.toString(2).padStart(codeLength, "0");

    if (code === 256) {
      codeLength = 9;
      nextCode = 258;
      previousCode = undefined;
      continue;
    }

    if (code === 257) {
      break;
    }

    if (previousCode !== undefined && nextCode < 4096) {
      nextCode += 1;
      const threshold = 1 << codeLength;
      if (codeLength < 12 && nextCode + options.earlyChange >= threshold) {
        codeLength += 1;
      }
    }

    previousCode = code;
  }

  return packBits(bits);
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

function toAsciiHex(bytes: ArrayLike<number>): Uint8Array {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return new TextEncoder().encode(`${hex}>`);
}

test("readPdfStreamFilters preserves direct and array filter names", () => {
  assert.deepEqual(readPdfStreamFilters("/ASCIIHexDecode"), [
    "ASCIIHexDecode",
  ]);
  assert.deepEqual(readPdfStreamFilters("[/AHx /Fl]"), ["AHx", "Fl"]);
});

test("decodePdfStreamBytes decodes ASCIIHex aliases consistently", async () => {
  const directResult = await decodePdfStreamBytes(
    new TextEncoder().encode("48656c6c6f>"),
    "/ASCIIHexDecode",
  );
  const aliasResult = await decodePdfStreamBytes(
    new TextEncoder().encode("48656c6c6f>"),
    "/AHx",
  );

  assert.equal(directResult.state, "decoded");
  assert.equal(aliasResult.state, "decoded");
  assert.equal(
    new TextDecoder().decode(directResult.decodedBytes),
    "Hello",
  );
  assert.equal(
    new TextDecoder().decode(aliasResult.decodedBytes),
    "Hello",
  );
});

test("decodePdfStreamBytes decodes RunLength streams", async () => {
  const result = await decodePdfStreamBytes(
    Uint8Array.from([3, 65, 66, 67, 68, 128]),
    "/RunLengthDecode",
  );

  assert.equal(result.state, "decoded");
  assert.equal(new TextDecoder().decode(result.decodedBytes), "ABCD");
});

test("decodePdfStreamBytes decodes LZW streams with decode params", async () => {
  const codes = [...Array.from({ length: 260 }, () => 65), 257];
  const rawBytes = packLzwCodes(codes, { earlyChange: 0 });

  const result = await decodePdfStreamBytes(
    rawBytes,
    "/LZWDecode",
    "<< /EarlyChange 0 >>",
  );

  assert.equal(result.state, "decoded");
  assert.equal(result.decodedBytes?.byteLength, 260);
  assert.ok(result.decodedBytes?.every((byte) => byte === 65));
});

test("decodePdfStreamBytes decodes Flate streams with PNG predictors", async () => {
  const rows: readonly [Uint8Array, Uint8Array] = [
    Uint8Array.from([10, 20, 30]),
    Uint8Array.from([20, 35, 50]),
  ];
  const encodedPredictorBytes = Uint8Array.from([
    ...encodePngPredictorRow(rows[0], [0, 0, 0], 0, 1),
    ...encodePngPredictorRow(rows[1], rows[0], 2, 1),
  ]);

  const result = await decodePdfStreamBytes(
    deflateSync(encodedPredictorBytes),
    "/FlateDecode",
    "<< /Predictor 12 /Columns 3 /Colors 1 /BitsPerComponent 8 >>",
  );

  assert.equal(result.state, "decoded");
  assert.deepEqual(Array.from(result.decodedBytes ?? []), rows.flatMap((row) => Array.from(row)));
});

test("decodePdfStreamBytes aligns decode-param arrays to their filter chain", async () => {
  const row = Uint8Array.from([15, 25, 40]);
  const predictorBytes = encodePngPredictorRow(row, [0, 0, 0], 1, 1);

  const result = await decodePdfStreamBytes(
    toAsciiHex(deflateSync(predictorBytes)),
    "[/AHx /Fl]",
    "[null << /Predictor 12 /Columns 3 /Colors 1 /BitsPerComponent 8 >>]",
  );

  assert.equal(result.state, "decoded");
  assert.deepEqual(Array.from(result.decodedBytes ?? []), Array.from(row));
});

test("decodePdfStreamBytes wires CCITT decode params through to the fax decoder", async () => {
  const result = await decodePdfStreamBytes(
    packBits("0111101000"),
    "/CCF",
    "<< /Columns 8 /Rows 1 /EndOfBlock false /BlackIs1 true >>",
  );

  assert.equal(result.state, "decoded");
  assert.deepEqual(Array.from(result.decodedBytes ?? []), [0x38]);
});

test("decodePdfStreamBytes reports unsupported filters explicitly", async () => {
  const result = await decodePdfStreamBytes(
    new TextEncoder().encode("ignored"),
    "/DCTDecode",
  );

  assert.equal(result.state, "unsupported-filter");
  assert.deepEqual(result.filterNames, ["DCTDecode"]);
});

test("decodePdfStreamBytes reports unsupported filters truthfully across filter chains", async () => {
  const result = await decodePdfStreamBytes(
    new TextEncoder().encode("4142>"),
    "[/ASCIIHexDecode /DCTDecode]",
  );

  assert.equal(result.state, "unsupported-filter");
  assert.deepEqual(result.filterNames, ["ASCIIHexDecode", "DCTDecode"]);
  assert.equal(result.decodedBytes, undefined);
});

test("decodePdfStreamBytes reports failed filter chains truthfully", async () => {
  const result = await decodePdfStreamBytes(
    new TextEncoder().encode("4142>"),
    "[/ASCIIHexDecode /FlateDecode]",
  );

  assert.equal(result.state, "failed");
  assert.deepEqual(result.filterNames, ["ASCIIHexDecode", "FlateDecode"]);
  assert.equal(result.decodedBytes, undefined);
});
