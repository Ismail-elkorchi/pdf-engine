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
  ["Fl", "FlateDecode"],
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
): Promise<PdfDecodedStreamResult> {
  const filterNames = readPdfStreamFilters(filterValue);
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

    for (const filterName of filterNames) {
      const stepBytes = await decodePdfFilterBytes(decodedBytes, filterName);
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
): Promise<Uint8Array | undefined> {
  switch (normalizePdfFilterName(filterName)) {
    case "ASCIIHexDecode":
      return decodeAsciiHexBytes(rawStreamBytes);
    case "ASCII85Decode":
      return decodeAscii85Bytes(rawStreamBytes);
    case "FlateDecode":
      return await inflateStreamBytes(rawStreamBytes);
    case "RunLengthDecode":
      return decodeRunLengthBytes(rawStreamBytes);
    default:
      return undefined;
  }
}

function normalizePdfFilterName(filterName: string): string {
  return PDF_FILTER_NAME_ALIASES.get(filterName) ?? filterName;
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
