import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseTrueTypeGlyphUnicodeMap } from "../../src/truetype-cmap.ts";

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const byteLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const combined = new Uint8Array(byteLength);
  let offset = 0;

  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }

  return combined;
}

function alignToFourBytes(bytes: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(bytes.byteLength / 4) * 4;
  if (paddedLength === bytes.byteLength) {
    return bytes;
  }

  return concatBytes(bytes, new Uint8Array(paddedLength - bytes.byteLength));
}

function buildFormat4Subtable(codePoint: number, glyphId: number): Uint8Array {
  const delta = (glyphId - codePoint) & 0xffff;

  return concatBytes(
    uint16(4),
    uint16(32),
    uint16(0),
    uint16(4),
    uint16(4),
    uint16(1),
    uint16(0),
    uint16(codePoint),
    uint16(0xffff),
    uint16(0),
    uint16(codePoint),
    uint16(0xffff),
    uint16(delta),
    uint16(1),
    uint16(0),
    uint16(0),
  );
}

function buildFormat12Subtable(startCharCode: number, endCharCode: number, startGlyphId: number): Uint8Array {
  return concatBytes(
    uint16(12),
    uint16(0),
    uint32(28),
    uint32(0),
    uint32(1),
    uint32(startCharCode),
    uint32(endCharCode),
    uint32(startGlyphId),
  );
}

function buildCmapTable(
  records: readonly {
    readonly platformId: number;
    readonly encodingId: number;
    readonly subtable: Uint8Array;
  }[],
): Uint8Array {
  const header = concatBytes(uint16(0), uint16(records.length));
  const recordBytes: Uint8Array[] = [];
  const subtableBytes: Uint8Array[] = [];
  let nextOffset = 4 + records.length * 8;

  for (const record of records) {
    recordBytes.push(
      concatBytes(
        uint16(record.platformId),
        uint16(record.encodingId),
        uint32(nextOffset),
      ),
    );
    subtableBytes.push(record.subtable);
    nextOffset += record.subtable.byteLength;
  }

  return concatBytes(header, ...recordBytes, ...subtableBytes);
}

function buildSfnt(tables: readonly { readonly tag: string; readonly bytes: Uint8Array }[]): Uint8Array {
  const numTables = tables.length;
  const searchRange = 16 * 2 ** Math.floor(Math.log2(Math.max(1, numTables)));
  const entrySelector = Math.floor(Math.log2(Math.max(1, numTables)));
  const rangeShift = numTables * 16 - searchRange;
  const header = concatBytes(
    uint32(0x00010000),
    uint16(numTables),
    uint16(searchRange),
    uint16(entrySelector),
    uint16(rangeShift),
  );

  const recordBytes: Uint8Array[] = [];
  const tableBytes: Uint8Array[] = [];
  let nextOffset = 12 + numTables * 16;

  for (const table of tables) {
    const padded = alignToFourBytes(table.bytes);
    const tagBytes = new TextEncoder().encode(table.tag);
    recordBytes.push(
      concatBytes(
        tagBytes,
        uint32(0),
        uint32(nextOffset),
        uint32(table.bytes.byteLength),
      ),
    );
    tableBytes.push(padded);
    nextOffset += padded.byteLength;
  }

  return concatBytes(header, ...recordBytes, ...tableBytes);
}

test("parseTrueTypeGlyphUnicodeMap reads a minimal format 4 cmap table", () => {
  const fontBytes = buildSfnt([
    {
      tag: "cmap",
      bytes: buildCmapTable([
        {
          platformId: 3,
          encodingId: 1,
          subtable: buildFormat4Subtable(0x0041, 5),
        },
      ]),
    },
  ]);

  const glyphMap = parseTrueTypeGlyphUnicodeMap(fontBytes);

  assert.equal(glyphMap?.get(5), "A");
});

test("parseTrueTypeGlyphUnicodeMap reads a minimal format 12 cmap table", () => {
  const fontBytes = buildSfnt([
    {
      tag: "cmap",
      bytes: buildCmapTable([
        {
          platformId: 3,
          encodingId: 10,
          subtable: buildFormat12Subtable(0x1f600, 0x1f600, 9),
        },
      ]),
    },
  ]);

  const glyphMap = parseTrueTypeGlyphUnicodeMap(fontBytes);

  assert.equal(glyphMap?.get(9), "😀");
});

test("parseTrueTypeGlyphUnicodeMap prefers higher-priority encoding records", () => {
  const fontBytes = buildSfnt([
    {
      tag: "cmap",
      bytes: buildCmapTable([
        {
          platformId: 3,
          encodingId: 1,
          subtable: buildFormat4Subtable(0x0042, 7),
        },
        {
          platformId: 0,
          encodingId: 0,
          subtable: buildFormat4Subtable(0x0041, 7),
        },
      ]),
    },
  ]);

  const glyphMap = parseTrueTypeGlyphUnicodeMap(fontBytes);

  assert.equal(glyphMap?.get(7), "A");
});

test("parseTrueTypeGlyphUnicodeMap rejects truncated cmap tables", () => {
  const validFontBytes = buildSfnt([
    {
      tag: "cmap",
      bytes: buildCmapTable([
        {
          platformId: 3,
          encodingId: 10,
          subtable: buildFormat12Subtable(0x1f600, 0x1f600, 9),
        },
      ]),
    },
  ]);
  const truncatedFontBytes = validFontBytes.slice(0, validFontBytes.byteLength - 1);

  assert.equal(parseTrueTypeGlyphUnicodeMap(truncatedFontBytes), undefined);
});

test("parseTrueTypeGlyphUnicodeMap returns undefined when cmap is absent", () => {
  const fontBytes = buildSfnt([
    {
      tag: "head",
      bytes: new Uint8Array(4),
    },
  ]);

  assert.equal(parseTrueTypeGlyphUnicodeMap(fontBytes), undefined);
});
