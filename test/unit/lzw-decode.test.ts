import { strict as assert } from "node:assert";
import { test } from "node:test";

import { decodeLzwBytes } from "../../src/lzw-decode.ts";

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

test("decodeLzwBytes resets dictionary growth on clear-table codes", () => {
  const rawBytes = packLzwCodes([65, 66, 256, 67, 257], { earlyChange: 1 });
  const decoded = decodeLzwBytes(rawBytes, { earlyChange: 1 });

  assert.equal(new TextDecoder().decode(decoded), "ABC");
});

test("decodeLzwBytes honors EarlyChange 1 across the 9-bit to 10-bit growth boundary", () => {
  const codes = [...Array.from({ length: 260 }, () => 65), 257];
  const rawBytes = packLzwCodes(codes, { earlyChange: 1 });
  const decoded = decodeLzwBytes(rawBytes, { earlyChange: 1 });

  assert.equal(decoded.byteLength, 260);
  assert.ok(decoded.every((byte) => byte === 65));
});

test("decodeLzwBytes honors EarlyChange 0 across the 9-bit to 10-bit growth boundary", () => {
  const codes = [...Array.from({ length: 260 }, () => 65), 257];
  const rawBytes = packLzwCodes(codes, { earlyChange: 0 });
  const decoded = decodeLzwBytes(rawBytes, { earlyChange: 0 });

  assert.equal(decoded.byteLength, 260);
  assert.ok(decoded.every((byte) => byte === 65));
});

test("decodeLzwBytes rejects malformed code streams", () => {
  const rawBytes = packLzwCodes([258, 257], { earlyChange: 1 });

  assert.throws(
    () => decodeLzwBytes(rawBytes, { earlyChange: 1 }),
    /Malformed LZW code stream/,
  );
});
