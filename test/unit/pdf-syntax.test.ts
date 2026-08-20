import { strict as assert } from "node:assert";
import { test } from "node:test";

import { PdfBudgetTracker } from "../../src/pdf-budget.ts";
import { PdfSyntaxParser } from "../../src/pdf-syntax.ts";
import type { PdfNormalizedResourceBudget } from "../../src/public-api.ts";

const limits: PdfNormalizedResourceBudget = {
  maxBytes: 1_000_000,
  maxPages: 100,
  maxObjects: 10_000,
  maxRecursionDepth: 32,
  maxDecodedBytes: 1_000_000,
  maxOperators: 10_000,
  maxImagePixels: 1_000_000,
  maxCacheBytes: 1_000_000,
};

test("the byte parser preserves names, binary strings, nesting, duplicate keys, and references", () => {
  const bytes = new TextEncoder().encode("<< /A#20B (a\\(b\\)\\053) /Hex <00ffA> /Nested [null true -2 3.5 8 0 R] /Dup 1 /Dup 2 >>");
  const value = new PdfSyntaxParser(bytes, new PdfBudgetTracker(limits)).parseValue(0).value;
  assert.equal(value.kind, "dictionary");
  if (value.kind !== "dictionary") {
    return;
  }
  assert.equal(value.entries[0]?.key.value, "A B");
  assert.deepEqual(value.entries[0]?.value.kind === "string" ? [...value.entries[0].value.bytes] : [], [...new TextEncoder().encode("a(b)+")]);
  assert.deepEqual(value.entries[1]?.value.kind === "string" ? [...value.entries[1].value.bytes] : [], [0, 255, 160]);
  assert.equal(value.entries.filter((entry) => entry.key.value === "Dup").length, 2);
  const nested = value.entries[2]?.value;
  assert.equal(nested?.kind, "array");
  assert.deepEqual(nested?.kind === "array" ? nested.items.at(-1) : undefined, {
    kind: "reference",
    value: { objectNumber: 8, generationNumber: 0 },
    source: { start: 62, end: 67 },
  });
});

test("safe stream repair accepts a declared boundary without delimiter evidence", () => {
  const bytes = new TextEncoder().encode("1 0 obj\n<< /Length 3 >>\nstream\nABCendstream\nendobj");
  const strict = new PdfSyntaxParser(bytes, new PdfBudgetTracker(limits));
  assert.throws(() => strict.parseIndirectObject(0), /Missing endstream/u);

  const safe = new PdfSyntaxParser(bytes, new PdfBudgetTracker(limits), true);
  const object = safe.parseIndirectObject(0).object;
  assert.deepEqual(object.stream?.rawBytes, new TextEncoder().encode("ABC"));
  assert.equal(safe.repaired, true);
});
