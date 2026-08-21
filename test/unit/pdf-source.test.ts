import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfByteSource, loadPdfSource } from "../../src/pdf-source.ts";

test("random-access sources retain only requested byte ranges", async () => {
  const byteLength = 100_000_000;
  const reads: Array<{ readonly offset: number; readonly length: number }> = [];
  const source = createPdfByteSource({
    kind: "random-access",
    byteLength,
    read({ offset, length }) {
      reads.push({ offset, length });
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = (offset + index) % 251;
      }
      return Promise.resolve(bytes);
    },
  });

  const data = await loadPdfSource(source, byteLength);

  assert.equal(data.fullyLoaded, false);
  assert.equal(data.bytes.byteLength, byteLength);
  assert.equal(data.bytes.byteAt(50_000_000), undefined);
  assert.throws(
    () => data.bytes.slice(50_000_000, 50_000_004),
    /has not been loaded/u,
  );
  assert.equal(
    reads.reduce((total, read) => total + read.length, 0),
    66_560,
  );

  await data.ensure(50_000_000, 4);

  assert.equal(data.bytes.byteAt(50_000_000), 50_000_000 % 251);
  assert.deepEqual(data.bytes.slice(50_000_000, 50_000_004),
    Uint8Array.from([
      50_000_000 % 251,
      50_000_001 % 251,
      50_000_002 % 251,
      50_000_003 % 251,
    ]),
  );
  assert.equal(
    reads.reduce((total, read) => total + read.length, 0),
    66_564,
  );
});
