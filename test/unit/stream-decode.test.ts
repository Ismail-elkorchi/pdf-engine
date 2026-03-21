import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  decodePdfStreamBytes,
  readPdfStreamFilters,
} from "../../src/stream-decode.ts";

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

test("decodePdfStreamBytes reports unsupported filters explicitly", async () => {
  const result = await decodePdfStreamBytes(
    new TextEncoder().encode("ignored"),
    "/DCTDecode",
  );

  assert.equal(result.state, "unsupported-filter");
  assert.deepEqual(result.filterNames, ["DCTDecode"]);
});
