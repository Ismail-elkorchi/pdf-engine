import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  decodePdfLiteral,
  findFirstDictionaryToken,
  parseContentStreamOperators,
  parseDictionaryEntries,
  parseTextOperatorRuns,
  readObjectRefValue,
  readObjectRefsValue,
} from "../../src/shell-parse.ts";

test("parseDictionaryEntries keeps nested dictionaries and arrays intact", () => {
  const entries = parseDictionaryEntries(
    "<< /Type /Page /Kids [4 0 R 5 0 R] /Resources << /Font << /F1 3 0 R >> >> >>",
  );

  assert.equal(entries.get("Type"), "/Page");
  assert.equal(entries.get("Kids"), "[4 0 R 5 0 R]");
  assert.equal(entries.get("Resources"), "<< /Font << /F1 3 0 R >> >>");
});

test("parseDictionaryEntries preserves decimal numeric values", () => {
  const entries = parseDictionaryEntries(
    "<< /Type /ExtGState /CA 0.5 /ca 0.25 /BM /Multiply >>",
  );

  assert.equal(entries.get("CA"), "0.5");
  assert.equal(entries.get("ca"), "0.25");
  assert.equal(entries.get("BM"), "/Multiply");
});

test("readObjectRefValue and readObjectRefsValue recover direct and array references", () => {
  assert.deepEqual(readObjectRefValue("12 0 R"), {
    objectNumber: 12,
    generationNumber: 0,
  });
  assert.equal(readObjectRefValue("12 0"), undefined);
  assert.deepEqual(readObjectRefsValue("[4 0 R 5 2 R 9 0 R]"), [
    {
      objectNumber: 4,
      generationNumber: 0,
    },
    {
      objectNumber: 5,
      generationNumber: 2,
    },
    {
      objectNumber: 9,
      generationNumber: 0,
    },
  ]);
});

test("parseContentStreamOperators and parseTextOperatorRuns recover operator-level text state", () => {
  const text = [
    "q",
    "% comment before path",
    "0 0 m",
    "10 0 l",
    "S",
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Hello\\040World) Tj",
    "ET",
    "Q",
  ].join("\n");

  assert.deepEqual(
    parseContentStreamOperators(text).map((operator) => operator.operator),
    ["q", "m", "l", "S", "BT", "Tf", "Tm", "Tj", "ET", "Q"],
  );

  const runs = parseTextOperatorRuns(text);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.operator, "Tj");
  assert.equal(runs[0]?.fontResourceName, "F1");
  assert.equal(runs[0]?.fontSize, 12);
  assert.equal(runs[0]?.startsNewLine, true);
  assert.deepEqual(runs[0]?.anchor, {
    x: 72,
    y: 720,
  });
  assert.deepEqual(runs[0]?.operands, [
    {
      kind: "literal",
      token: "(Hello\\040World)",
    },
  ]);
});

test("decodePdfLiteral and findFirstDictionaryToken handle escaped content", () => {
  assert.equal(
    decodePdfLiteral("(Hello\\040World\\n\\050ok\\051)"),
    "Hello World\n(ok)",
  );
  assert.equal(
    findFirstDictionaryToken("5 0 obj\n<< /Type /Page /Count 1 >>\nendobj"),
    "<< /Type /Page /Count 1 >>",
  );
});
