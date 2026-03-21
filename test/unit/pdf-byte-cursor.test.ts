import { strict as assert } from "node:assert";
import { test } from "node:test";

import { PdfByteCursor } from "../../src/pdf-byte-cursor.ts";

test("PdfByteCursor skips whitespace and PDF comments", () => {
  const cursor = new PdfByteCursor(new TextEncoder().encode("% header\r\n   123 /Type"));

  const offset = cursor.skipWhitespaceAndComments(0);
  assert.equal(offset, 13);
  assert.deepEqual(cursor.readUnsignedInteger(offset), {
    value: 123,
    nextOffset: 16,
  });
});

test("PdfByteCursor matches keywords only at token boundaries", () => {
  const cursor = new PdfByteCursor(new TextEncoder().encode("xref xrefstream startxref"));

  assert.equal(cursor.findKeyword("xref", 0), 0);
  assert.equal(cursor.findKeyword("startxref", 0), 16);
  assert.equal(cursor.findKeyword("ref", 0), -1);
  assert.equal(cursor.findLastKeyword("xref"), 0);
  assert.equal(cursor.findLastKeyword("startxref"), 16);
});

test("PdfByteCursor respects start and end offsets when slicing", () => {
  const cursor = new PdfByteCursor(new TextEncoder().encode("0123456789"), 2, 8);

  assert.equal(cursor.byteAt(1), undefined);
  assert.equal(cursor.byteAt(7), 55);
  assert.equal(cursor.byteAt(8), undefined);
  assert.equal(new TextDecoder().decode(cursor.slice(0, 99)), "234567");
});
