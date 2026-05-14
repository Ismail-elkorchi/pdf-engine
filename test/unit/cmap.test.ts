import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  decodePdfHexTextWithUnicodeCMap,
  parsePdfUnicodeCMap,
} from "../../src/cmap.ts";

const unicodeCMapText = [
  "/CIDInit /ProcSet findresource begin",
  "12 dict begin",
  "begincmap",
  "2 begincodespacerange",
  "<00> <7F>",
  "<8000> <80FF>",
  "endcodespacerange",
  "2 beginbfchar",
  "<41> <0041>",
  "<8001> <03B1>",
  "endbfchar",
  "1 beginbfrange",
  "<42> <44> <0042>",
  "endbfrange",
  "1 beginbfrange",
  "<8002> <8003> [<03B2> <03B3>]",
  "endbfrange",
  "endcmap",
  "CMapName currentdict /CMap defineresource pop",
  "end",
  "end",
].join("\n");

test("parsePdfUnicodeCMap reads code-space, bfchar, and bfrange blocks", () => {
  const unicodeCMap = parsePdfUnicodeCMap(unicodeCMapText);

  assert.ok(unicodeCMap);
  assert.equal(unicodeCMap?.codeSpaceRanges.length, 2);
  assert.equal(unicodeCMap?.bfChars.length, 2);
  assert.equal(unicodeCMap?.bfRanges.length, 2);
  assert.deepEqual(unicodeCMap?.codeSpaceRanges[0], {
    startHex: "00",
    endHex: "7F",
    byteLength: 1,
  });
});

test("decodePdfHexTextWithUnicodeCMap handles mixed code lengths and direct or array ranges", () => {
  const unicodeCMap = parsePdfUnicodeCMap(unicodeCMapText);
  assert.ok(unicodeCMap);
  if (!unicodeCMap) {
    return;
  }

  const decoded = decodePdfHexTextWithUnicodeCMap("<41424344800180028003>", unicodeCMap);

  assert.deepEqual(decoded, {
    text: "ABCDαβγ",
    complete: true,
    sourceUnitCount: 7,
    mappedUnitCount: 7,
  });
});

test("decodePdfHexTextWithUnicodeCMap reports partial decodes truthfully", () => {
  const unicodeCMap = parsePdfUnicodeCMap(unicodeCMapText);
  assert.ok(unicodeCMap);
  if (!unicodeCMap) {
    return;
  }

  const decoded = decodePdfHexTextWithUnicodeCMap("<418004>", unicodeCMap);

  assert.deepEqual(decoded, {
    text: "A",
    complete: false,
    sourceUnitCount: 2,
    mappedUnitCount: 1,
  });
});
