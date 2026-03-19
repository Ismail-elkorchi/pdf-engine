import { decodeCcittFaxBytes } from "./ccitt-fax-decode.ts";
import { decodeLzwBytes } from "./lzw-decode.ts";
import { applyPdfStreamPredictor } from "./pdf-stream-predictor.ts";

import type { PdfStreamDecodeState } from "./contracts.ts";

export interface PdfDecodedStreamResult {
  readonly state: PdfStreamDecodeState;
  readonly filterNames: readonly string[];
  readonly decodedBytes?: Uint8Array;
}

interface NodeZlibModule {
  readonly inflateSync: (input: Uint8Array) => Uint8Array;
}

const PDF_FILTER_NAME_ALIASES = new Map<string, string>([
  ["AHx", "ASCIIHexDecode"],
  ["A85", "ASCII85Decode"],
  ["CCF", "CCITTFaxDecode"],
  ["Fl", "FlateDecode"],
  ["LZW", "LZWDecode"],
  ["RL", "RunLengthDecode"],
]);

export function readPdfStreamFilters(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }

  const directName = readNameValue(value);
  if (directName !== undefined) {
    return [directName];
  }

  const filterNames: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const nameToken = readPdfNameToken(value, index);
    if (!nameToken) {
      continue;
    }

    filterNames.push(nameToken.name);
    index = nameToken.nextIndex - 1;
  }

  return filterNames;
}

export async function decodePdfStreamBytes(
  rawStreamBytes: Uint8Array | undefined,
  filterValue: string | undefined,
  decodeParamsValue?: string,
): Promise<PdfDecodedStreamResult> {
  const filterNames = readPdfStreamFilters(filterValue);
  const decodeParamValues = readPdfStreamDecodeParamValues(decodeParamsValue, filterNames.length);
  if (rawStreamBytes === undefined) {
    return {
      state: "failed",
      filterNames,
    };
  }

  if (filterNames.length === 0) {
    return {
      state: "available",
      filterNames,
      decodedBytes: Uint8Array.from(rawStreamBytes),
    };
  }

  try {
    let decodedBytes = Uint8Array.from(rawStreamBytes);

    for (const [index, filterName] of filterNames.entries()) {
      const stepBytes = await decodePdfFilterBytes(decodedBytes, filterName, decodeParamValues[index]);
      if (stepBytes === undefined) {
        return {
          state: "unsupported-filter",
          filterNames,
        };
      }

      decodedBytes = Uint8Array.from(stepBytes);
    }

    return {
      state: "decoded",
      filterNames,
      decodedBytes,
    };
  } catch {
    return {
      state: "failed",
      filterNames,
    };
  }
}

function readNameValue(value: string): string | undefined {
  const nameToken = readPdfNameToken(value.trim(), 0);
  return nameToken?.name;
}

function readPdfStreamDecodeParamValues(
  value: string | undefined,
  filterCount: number,
): readonly (string | undefined)[] {
  if (filterCount === 0) {
    return [];
  }

  if (!value) {
    return new Array<string | undefined>(filterCount).fill(undefined);
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const arrayItems = readPdfArrayItems(trimmed);
    return Array.from({ length: filterCount }, (_, index) => {
      const item = arrayItems[index]?.trim();
      if (!item || item === "null") {
        return undefined;
      }
      return item;
    });
  }

  return [trimmed, ...new Array<string | undefined>(Math.max(0, filterCount - 1)).fill(undefined)];
}

function readPdfNameToken(
  text: string,
  startIndex: number,
): {
  readonly name: string;
  readonly nextIndex: number;
} | undefined {
  if (text[startIndex] !== "/") {
    return undefined;
  }

  let index = startIndex + 1;
  while (index < text.length && !isPdfDelimiter(text[index] ?? "")) {
    index += 1;
  }

  const name = text.slice(startIndex + 1, index);
  return name.length === 0 ? undefined : { name, nextIndex: index };
}

async function decodePdfFilterBytes(
  rawStreamBytes: Uint8Array,
  filterName: string,
  decodeParamsValue: string | undefined,
): Promise<Uint8Array | undefined> {
  const decodeParamEntries = readDictionaryEntries(decodeParamsValue);
  switch (normalizePdfFilterName(filterName)) {
    case "ASCIIHexDecode":
      return decodeAsciiHexBytes(rawStreamBytes);
    case "ASCII85Decode":
      return decodeAscii85Bytes(rawStreamBytes);
    case "FlateDecode":
      return applyPredictorIfNeeded(await inflateStreamBytes(rawStreamBytes), decodeParamsValue);
    case "LZWDecode":
      return applyPredictorIfNeeded(
        decodeLzwBytes(rawStreamBytes, { earlyChange: readIntegerValue(decodeParamEntries.get("EarlyChange")) ?? 1 }),
        decodeParamsValue,
      );
    case "RunLengthDecode":
      return decodeRunLengthBytes(rawStreamBytes);
    case "CCITTFaxDecode":
      return decodeCcittFaxBytes(rawStreamBytes, {
        k: readIntegerValue(decodeParamEntries.get("K")) ?? 0,
        endOfLine: readBooleanValue(decodeParamEntries.get("EndOfLine")) ?? false,
        encodedByteAlign: readBooleanValue(decodeParamEntries.get("EncodedByteAlign")) ?? false,
        columns: readIntegerValue(decodeParamEntries.get("Columns")) ?? 1728,
        rows: readIntegerValue(decodeParamEntries.get("Rows")) ?? 0,
        endOfBlock: readBooleanValue(decodeParamEntries.get("EndOfBlock")) ?? true,
        blackIs1: readBooleanValue(decodeParamEntries.get("BlackIs1")) ?? false,
      });
    default:
      return undefined;
  }
}

function applyPredictorIfNeeded(
  decodedBytes: Uint8Array,
  decodeParamsValue: string | undefined,
): Uint8Array {
  const dictionaryEntries = readDictionaryEntries(decodeParamsValue);
  const predictor = readIntegerValue(dictionaryEntries.get("Predictor")) ?? 1;
  if (predictor <= 1) {
    return decodedBytes;
  }

  return applyPdfStreamPredictor(decodedBytes, {
    predictor,
    colors: readIntegerValue(dictionaryEntries.get("Colors")) ?? 1,
    bitsPerComponent:
      readIntegerValue(dictionaryEntries.get("BitsPerComponent")) ?? readIntegerValue(dictionaryEntries.get("BPC")) ?? 8,
    columns: readIntegerValue(dictionaryEntries.get("Columns")) ?? 1,
  });
}

function normalizePdfFilterName(filterName: string): string {
  return PDF_FILTER_NAME_ALIASES.get(filterName) ?? filterName;
}

function readDictionaryEntries(value: string | undefined): ReadonlyMap<string, string> {
  if (!value) {
    return new Map<string, string>();
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("<<") || !trimmed.endsWith(">>")) {
    return new Map<string, string>();
  }

  const innerText = trimmed.slice(2, -2);
  const entries = new Map<string, string>();
  let index = 0;

  while (index < innerText.length) {
    index = skipPdfWhitespaceAndComments(innerText, index);
    const keyToken = readPdfNameToken(innerText, index);
    if (!keyToken) {
      index += 1;
      continue;
    }

    const valueStart = skipPdfWhitespaceAndComments(innerText, keyToken.nextIndex);
    const valueToken = readPdfValueToken(innerText, valueStart);
    if (!valueToken) {
      entries.set(keyToken.name, "");
      index = keyToken.nextIndex;
      continue;
    }

    entries.set(keyToken.name, valueToken.token.trim());
    index = valueToken.nextIndex;
  }

  return entries;
}

function readPdfArrayItems(value: string): readonly string[] {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    return [];
  }

  const items: string[] = [];
  let index = 1;
  while (index < value.length - 1) {
    index = skipPdfWhitespaceAndComments(value, index);
    const token = readPdfValueToken(value, index);
    if (!token) {
      index += 1;
      continue;
    }

    items.push(token.token);
    index = token.nextIndex;
  }

  return items;
}

function readPdfValueToken(
  text: string,
  startIndex: number,
): {
  readonly token: string;
  readonly nextIndex: number;
} | undefined {
  const current = text[startIndex];
  if (current === undefined) {
    return undefined;
  }

  if (current === "<" && text[startIndex + 1] === "<") {
    return readPdfDictionaryToken(text, startIndex);
  }
  if (current === "[") {
    return readPdfArrayToken(text, startIndex);
  }
  if (current === "(") {
    return readPdfLiteralToken(text, startIndex);
  }
  if (current === "<") {
    return readPdfHexStringToken(text, startIndex);
  }
  if (current === "/") {
    const nameToken = readPdfNameToken(text, startIndex);
    return nameToken ? { token: text.slice(startIndex, nameToken.nextIndex), nextIndex: nameToken.nextIndex } : undefined;
  }

  const endIndex = readUntilDelimiter(text, startIndex);
  if (endIndex <= startIndex) {
    return undefined;
  }

  return {
    token: text.slice(startIndex, endIndex),
    nextIndex: endIndex,
  };
}

function readPdfDictionaryToken(
  text: string,
  startIndex: number,
): {
  readonly token: string;
  readonly nextIndex: number;
} | undefined {
  if (text[startIndex] !== "<" || text[startIndex + 1] !== "<") {
    return undefined;
  }

  let depth = 1;
  for (let index = startIndex + 2; index < text.length; index += 1) {
    const current = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (current === "%") {
      index = skipPdfComment(text, index);
      continue;
    }

    if (current === "(") {
      const literalToken = readPdfLiteralToken(text, index);
      if (!literalToken) {
        return undefined;
      }
      index = literalToken.nextIndex - 1;
      continue;
    }

    if (current === "<" && next === "<") {
      depth += 1;
      index += 1;
      continue;
    }

    if (current === ">" && next === ">") {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        return {
          token: text.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return undefined;
}

function readPdfArrayToken(
  text: string,
  startIndex: number,
): {
  readonly token: string;
  readonly nextIndex: number;
} | undefined {
  if (text[startIndex] !== "[") {
    return undefined;
  }

  let depth = 1;
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const current = text[index] ?? "";

    if (current === "%") {
      index = skipPdfComment(text, index);
      continue;
    }

    if (current === "(") {
      const literalToken = readPdfLiteralToken(text, index);
      if (!literalToken) {
        return undefined;
      }
      index = literalToken.nextIndex - 1;
      continue;
    }

    if (current === "<" && text[index + 1] === "<") {
      const dictionaryToken = readPdfDictionaryToken(text, index);
      if (!dictionaryToken) {
        return undefined;
      }
      index = dictionaryToken.nextIndex - 1;
      continue;
    }

    if (current === "[") {
      depth += 1;
      continue;
    }

    if (current === "]") {
      depth -= 1;
      if (depth === 0) {
        return {
          token: text.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return undefined;
}

function readPdfHexStringToken(
  text: string,
  startIndex: number,
): {
  readonly token: string;
  readonly nextIndex: number;
} | undefined {
  if (text[startIndex] !== "<" || text[startIndex + 1] === "<") {
    return undefined;
  }

  for (let index = startIndex + 1; index < text.length; index += 1) {
    if (text[index] === ">") {
      return {
        token: text.slice(startIndex, index + 1),
        nextIndex: index + 1,
      };
    }
  }

  return undefined;
}

function readPdfLiteralToken(
  text: string,
  startIndex: number,
): {
  readonly token: string;
  readonly nextIndex: number;
} | undefined {
  if (text[startIndex] !== "(") {
    return undefined;
  }

  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const current = text[index] ?? "";
    if (current === "\\") {
      index += 1;
      continue;
    }
    if (current === "(") {
      depth += 1;
      continue;
    }
    if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          token: text.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return undefined;
}

function decodeAsciiHexBytes(rawStreamBytes: Uint8Array): Uint8Array {
  const decodedBytes: number[] = [];
  let highNibble: number | undefined;

  for (const byte of rawStreamBytes) {
    const character = String.fromCharCode(byte);
    if (character === ">") {
      break;
    }

    if (isPdfWhitespace(character)) {
      continue;
    }

    const hexDigit = readHexDigit(character);
    if (hexDigit === undefined) {
      throw new Error("Malformed ASCIIHexDecode stream.");
    }

    if (highNibble === undefined) {
      highNibble = hexDigit;
      continue;
    }

    decodedBytes.push(highNibble * 16 + hexDigit);
    highNibble = undefined;
  }

  if (highNibble !== undefined) {
    decodedBytes.push(highNibble * 16);
  }

  return Uint8Array.from(decodedBytes);
}

function decodeAscii85Bytes(rawStreamBytes: Uint8Array): Uint8Array {
  const decodedBytes: number[] = [];
  const groupValues: number[] = [];

  for (let index = 0; index < rawStreamBytes.length; index += 1) {
    const character = String.fromCharCode(rawStreamBytes[index] ?? 0);
    if (isPdfWhitespace(character)) {
      continue;
    }

    if (character === "~") {
      const nextCharacter = String.fromCharCode(rawStreamBytes[index + 1] ?? 0);
      if (nextCharacter !== ">") {
        throw new Error("Malformed ASCII85Decode end marker.");
      }
      appendAscii85Group(decodedBytes, groupValues, true);
      return Uint8Array.from(decodedBytes);
    }

    if (character === "z") {
      if (groupValues.length !== 0) {
        throw new Error("Malformed ASCII85Decode z group.");
      }
      decodedBytes.push(0x00, 0x00, 0x00, 0x00);
      continue;
    }

    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 33 || codePoint > 117) {
      throw new Error("Malformed ASCII85Decode stream.");
    }

    groupValues.push(codePoint - 33);
    if (groupValues.length === 5) {
      appendAscii85Group(decodedBytes, groupValues, false);
      groupValues.length = 0;
    }
  }

  appendAscii85Group(decodedBytes, groupValues, true);
  return Uint8Array.from(decodedBytes);
}

function appendAscii85Group(
  decodedBytes: number[],
  groupValues: number[],
  isFinalGroup: boolean,
): void {
  if (groupValues.length === 0) {
    return;
  }

  if (groupValues.length === 1) {
    throw new Error("Malformed ASCII85Decode tail group.");
  }

  const paddedValues = [...groupValues];
  while (paddedValues.length < 5) {
    paddedValues.push(84);
  }

  let value = 0;
  for (const digit of paddedValues) {
    value = value * 85 + digit;
  }

  if (value > 0xffff_ffff) {
    throw new Error("ASCII85Decode group exceeded 32-bit range.");
  }

  const groupBytes = [
    Math.floor(value / 0x1_00_00_00) % 0x100,
    Math.floor(value / 0x1_00_00) % 0x100,
    Math.floor(value / 0x100) % 0x100,
    value % 0x100,
  ];

  if (!isFinalGroup && groupValues.length !== 5) {
    throw new Error("Malformed ASCII85Decode group length.");
  }

  decodedBytes.push(...groupBytes.slice(0, isFinalGroup ? groupValues.length - 1 : 4));
}

function decodeRunLengthBytes(rawStreamBytes: Uint8Array): Uint8Array {
  const decodedBytes: number[] = [];

  for (let index = 0; index < rawStreamBytes.length; index += 1) {
    const lengthByte = rawStreamBytes[index] ?? 128;
    if (lengthByte === 128) {
      return Uint8Array.from(decodedBytes);
    }

    if (lengthByte <= 127) {
      const literalLength = lengthByte + 1;
      const literalEnd = index + 1 + literalLength;
      if (literalEnd > rawStreamBytes.length) {
        throw new Error("Malformed RunLengthDecode literal sequence.");
      }

      decodedBytes.push(...rawStreamBytes.slice(index + 1, literalEnd));
      index = literalEnd - 1;
      continue;
    }

    const repeatByte = rawStreamBytes[index + 1];
    if (repeatByte === undefined) {
      throw new Error("Malformed RunLengthDecode repeat sequence.");
    }

    const repeatLength = 257 - lengthByte;
    decodedBytes.push(...new Array<number>(repeatLength).fill(repeatByte));
    index += 1;
  }

  return Uint8Array.from(decodedBytes);
}

async function inflateStreamBytes(rawStreamBytes: Uint8Array): Promise<Uint8Array> {
  const exactBytes = Uint8Array.from(rawStreamBytes);

  try {
    const response = new Response(new Blob([exactBytes]).stream().pipeThrough(new DecompressionStream("deflate")));
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    if (isBrowserRuntime()) {
      throw new Error("Browser runtime could not decode flate stream with DecompressionStream.");
    }

    // Some valid zlib-wrapped PDF flate streams still fail through current DecompressionStream implementations.
    const zlibModule = readNodeBuiltinModule("zlib");
    if (!zlibModule) {
      throw new Error("Runtime does not expose a built-in zlib module fallback.");
    }

    return Uint8Array.from(zlibModule.inflateSync(exactBytes));
  }
}

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function readNodeBuiltinModule(moduleName: string): NodeZlibModule | undefined {
  const processLike = globalThis as typeof globalThis & {
    readonly process?: {
      readonly getBuiltinModule?: (specifier: string) => unknown;
    };
  };
  const builtinModule = processLike.process?.getBuiltinModule?.(moduleName);

  if (
    !builtinModule ||
    typeof builtinModule !== "object" ||
    !("inflateSync" in builtinModule) ||
    typeof builtinModule.inflateSync !== "function"
  ) {
    return undefined;
  }

  return builtinModule as NodeZlibModule;
}

function readIntegerValue(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return /^-?\d+$/u.test(trimmed) ? Number(trimmed) : undefined;
}

function readBooleanValue(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return undefined;
}

function readUntilDelimiter(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length && !isPdfDelimiter(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function skipPdfWhitespaceAndComments(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length) {
    const current = text[index] ?? "";
    if (isPdfWhitespace(current)) {
      index += 1;
      continue;
    }
    if (current === "%") {
      index = skipPdfComment(text, index);
      continue;
    }
    break;
  }
  return index;
}

function skipPdfComment(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length) {
    const current = text[index] ?? "";
    if (current === "\n" || current === "\r") {
      break;
    }
    index += 1;
  }
  return index;
}

function isPdfDelimiter(value: string): boolean {
  return (
    value === "" ||
    value === " " ||
    value === "\t" ||
    value === "\n" ||
    value === "\r" ||
    value === "\f" ||
    value === "\0" ||
    value === "(" ||
    value === ")" ||
    value === "<" ||
    value === ">" ||
    value === "[" ||
    value === "]" ||
    value === "{" ||
    value === "}" ||
    value === "/" ||
    value === "%"
  );
}

function isPdfWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r" || value === "\f" || value === "\0";
}

function readHexDigit(value: string): number | undefined {
  const codePoint = value.codePointAt(0) ?? -1;
  if (codePoint >= 0x30 && codePoint <= 0x39) {
    return codePoint - 0x30;
  }
  if (codePoint >= 0x41 && codePoint <= 0x46) {
    return codePoint - 0x41 + 10;
  }
  if (codePoint >= 0x61 && codePoint <= 0x66) {
    return codePoint - 0x61 + 10;
  }
  return undefined;
}
