export interface PdfCidCollectionIdentifier {
  readonly registry: string;
  readonly ordering: string;
}

export interface PdfCidCollectionDecodeResult {
  readonly text: string;
  readonly complete: boolean;
  readonly sourceUnitCount: number;
  readonly mappedUnitCount: number;
}

const ADOBE_JAPAN1_UCS2_SUBSET = new Map<number, string>([
  [0x0001, " "],
  [0x000f, "."],
  [0x0022, "A"],
  [0x0025, "D"],
  [0x0027, "F"],
  [0x0030, "O"],
  [0x0031, "P"],
  [0x0035, "T"],
  [0x0036, "U"],
  [0x0042, "a"],
  [0x0044, "c"],
  [0x0045, "d"],
  [0x0046, "e"],
  [0x0047, "f"],
  [0x0049, "h"],
  [0x004a, "i"],
  [0x004d, "l"],
  [0x004e, "m"],
  [0x004f, "n"],
  [0x0050, "o"],
  [0x0051, "p"],
  [0x0053, "r"],
  [0x0054, "s"],
  [0x034b, "あ"],
  [0x034d, "い"],
  [0x034f, "う"],
  [0x0351, "え"],
  [0x0353, "お"],
  [0x07a0, "語"],
  [0x0cd4, "日"],
  [0x0e8a, "本"],
]);

/**
 * Decodes CID hex operands through the small built-in collection map subset that the shell
 * currently carries for audited Adobe character collections.
 *
 * @param hexToken PDF hex token such as `<034B034D>`.
 * @param cidCollection Character collection resolved from `CIDSystemInfo`.
 * @returns Decoded text when the shell has a matching built-in subset for the collection.
 */
export function decodePdfCidHexTextWithKnownCollectionMap(
  hexToken: string,
  cidCollection: PdfCidCollectionIdentifier | undefined,
): PdfCidCollectionDecodeResult | undefined {
  const cidUnicodeMap = resolveKnownCidUnicodeMap(cidCollection);
  if (!cidUnicodeMap) {
    return undefined;
  }

  const normalizedHex = normalizePdfHexToken(hexToken);
  if (normalizedHex.length === 0 || normalizedHex.length % 4 !== 0) {
    return {
      text: "",
      complete: false,
      sourceUnitCount: 0,
      mappedUnitCount: 0,
    };
  }

  let text = "";
  let complete = true;
  let sourceUnitCount = 0;
  let mappedUnitCount = 0;

  for (let offset = 0; offset < normalizedHex.length; offset += 4) {
    sourceUnitCount += 1;
    const cid = Number.parseInt(normalizedHex.slice(offset, offset + 4), 16);
    const mappedText = cidUnicodeMap.get(cid);
    if (mappedText === undefined) {
      complete = false;
      continue;
    }
    text += mappedText;
    mappedUnitCount += 1;
  }

  return {
    text,
    complete,
    sourceUnitCount,
    mappedUnitCount,
  };
}

function resolveKnownCidUnicodeMap(
  cidCollection: PdfCidCollectionIdentifier | undefined,
): ReadonlyMap<number, string> | undefined {
  if (!cidCollection) {
    return undefined;
  }

  if (cidCollection.registry === "Adobe" && cidCollection.ordering === "Japan1") {
    return ADOBE_JAPAN1_UCS2_SUBSET;
  }

  return undefined;
}

function normalizePdfHexToken(value: string): string {
  const trimmedValue = value.trim();
  const bracketlessValue = trimmedValue.startsWith("<") && trimmedValue.endsWith(">")
    ? trimmedValue.slice(1, -1)
    : trimmedValue;
  const normalizedHex = bracketlessValue.replaceAll(/\s+/g, "");
  return normalizedHex.length % 2 === 0 ? normalizedHex : `${normalizedHex}0`;
}
