import { type PdfBudgetTracker } from "./pdf-budget.ts";
import { type PdfByteSequence } from "./pdf-source.ts";
import {
  type PdfArrayValue,
  type PdfBooleanValue,
  type PdfByteRange,
  type PdfDictionaryEntry,
  type PdfDictionaryValue,
  type PdfIndirectObject,
  type PdfIntegerValue,
  type PdfNameValue,
  type PdfNullValue,
  type PdfRealValue,
  type PdfReferenceValue,
  type PdfStringValue,
  type PdfValue,
  pdfAsInteger,
  pdfDictionaryGet,
} from "./pdf-values.ts";

const TEXT_DECODER = new TextDecoder("latin1");
const MAX_STREAM_REPAIR_DISTANCE = 1_048_576;

export class PdfSyntaxError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at byte ${String(offset)}.`);
    this.name = "PdfSyntaxError";
    this.offset = offset;
  }
}

export interface PdfParsedValue {
  readonly value: PdfValue;
  readonly nextOffset: number;
}

export interface PdfParsedIndirectObject {
  readonly object: PdfIndirectObject;
  readonly nextOffset: number;
}

export class PdfSyntaxParser {
  readonly #bytes: PdfByteSequence;
  readonly #budget: PdfBudgetTracker;
  readonly #repairStreams: boolean;
  #repaired = false;

  constructor(bytes: PdfByteSequence | Uint8Array, budget: PdfBudgetTracker, repairStreams: boolean = false) {
    this.#bytes = bytes instanceof Uint8Array ? new Uint8ArrayByteSequence(bytes) : bytes;
    this.#budget = budget;
    this.#repairStreams = repairStreams;
  }

  get byteLength(): number {
    return this.#bytes.byteLength;
  }

  get repaired(): boolean {
    return this.#repaired;
  }

  byteAt(offset: number): number | undefined {
    return this.#bytes.byteAt(offset);
  }

  parseValue(offset: number, depth: number = 0): PdfParsedValue {
    this.#budget.depth(depth);
    const start = this.skipWhitespace(offset);
    const current = this.#bytes.byteAt(start);
    if (current === undefined) {
      throw new PdfSyntaxError("Expected a PDF value", start);
    }

    if (current === 0x2f) {
      return this.#parseName(start);
    }
    if (current === 0x28) {
      return this.#parseLiteralString(start);
    }
    if (current === 0x5b) {
      return this.#parseArray(start, depth + 1);
    }
    if (current === 0x3c) {
      return this.#bytes.byteAt(start + 1) === 0x3c
        ? this.#parseDictionary(start, depth + 1)
        : this.#parseHexadecimalString(start);
    }
    if (isNumberStart(current)) {
      return this.#parseNumberOrReference(start);
    }
    if (this.matchesKeyword(start, "true")) {
      const value: PdfBooleanValue = { kind: "boolean", value: true, source: range(start, start + 4) };
      return { value, nextOffset: start + 4 };
    }
    if (this.matchesKeyword(start, "false")) {
      const value: PdfBooleanValue = { kind: "boolean", value: false, source: range(start, start + 5) };
      return { value, nextOffset: start + 5 };
    }
    if (this.matchesKeyword(start, "null")) {
      const value: PdfNullValue = { kind: "null", source: range(start, start + 4) };
      return { value, nextOffset: start + 4 };
    }

    throw new PdfSyntaxError("Unsupported or malformed PDF value", start);
  }

  parseIndirectObject(offset: number, revision: number = 0): PdfParsedIndirectObject {
    const start = this.skipWhitespace(offset);
    const objectNumberToken = this.readUnsignedInteger(start);
    if (objectNumberToken === undefined) {
      throw new PdfSyntaxError("Expected an indirect object number", start);
    }
    const generationStart = this.skipWhitespace(objectNumberToken.nextOffset);
    const generationToken = this.readUnsignedInteger(generationStart);
    if (generationToken === undefined) {
      throw new PdfSyntaxError("Expected an indirect object generation number", generationStart);
    }
    const objectKeywordOffset = this.skipWhitespace(generationToken.nextOffset);
    if (!this.matchesKeyword(objectKeywordOffset, "obj")) {
      throw new PdfSyntaxError("Expected the obj keyword", objectKeywordOffset);
    }

    this.#budget.object();
    const parsedValue = this.parseValue(objectKeywordOffset + 3);
    let nextOffset = this.skipWhitespace(parsedValue.nextOffset);
    let stream: PdfIndirectObject["stream"];

    if (parsedValue.value.kind === "dictionary" && this.matchesKeyword(nextOffset, "stream")) {
      const streamStart = this.skipStreamLineBreak(nextOffset + 6);
      const declaredLength = pdfAsInteger(pdfDictionaryGet(parsedValue.value, "Length"));
      let dataEnd = declaredLength === undefined
        ? this.findKeyword("endstream", streamStart)
        : streamStart + declaredLength;
      if (dataEnd < 0 && this.#repairStreams) {
        dataEnd = this.#findRepairKeyword("endstream", streamStart, streamStart + MAX_STREAM_REPAIR_DISTANCE);
        this.#repaired = dataEnd >= 0;
      }
      if (dataEnd < streamStart || dataEnd > this.#bytes.byteLength) {
        throw new PdfSyntaxError("Invalid PDF stream length", streamStart);
      }
      const endstreamOffset = this.skipWhitespace(dataEnd);
      let recoveredEndstream = this.matchesKeyword(endstreamOffset, "endstream")
        ? endstreamOffset
        : -1;
      if (recoveredEndstream < 0 && this.#repairStreams) {
        recoveredEndstream = this.#recoverStreamEnd(streamStart, dataEnd);
        if (recoveredEndstream >= 0) {
          dataEnd = recoveredEndstream;
          this.#repaired = true;
        }
      }
      if (recoveredEndstream < 0) {
        throw new PdfSyntaxError("Missing endstream keyword", dataEnd);
      }
      stream = {
        dictionary: parsedValue.value,
        source: range(nextOffset, recoveredEndstream + 9),
        dataSource: range(streamStart, dataEnd),
        rawBytes: this.#bytes.slice(streamStart, dataEnd),
      };
      nextOffset = this.skipWhitespace(recoveredEndstream + 9);
    }

    const endObjectOffset = this.matchesKeyword(nextOffset, "endobj")
      ? nextOffset
      : this.findKeyword("endobj", nextOffset);
    if (endObjectOffset < 0) {
      throw new PdfSyntaxError("Missing endobj keyword", nextOffset);
    }
    const end = endObjectOffset + 6;
    const object: PdfIndirectObject = {
      ref: {
        objectNumber: objectNumberToken.value,
        generationNumber: generationToken.value,
      },
      revision,
      source: range(start, end),
      value: parsedValue.value,
      ...(stream !== undefined ? { stream } : {}),
    };
    return { object, nextOffset: end };
  }

  skipWhitespace(offset: number): number {
    let cursor = Math.max(0, offset);
    while (cursor < this.#bytes.byteLength) {
      const byte = this.#bytes.byteAt(cursor);
      if (byte === 0x25) {
        cursor += 1;
        while (cursor < this.#bytes.byteLength) {
          const commentByte = this.#bytes.byteAt(cursor);
          if (commentByte === undefined) {
            return cursor;
          }
          cursor += 1;
          if (commentByte === 0x0a) {
            break;
          }
          if (commentByte === 0x0d) {
            if (this.#bytes.byteAt(cursor) === 0x0a) {
              cursor += 1;
            }
            break;
          }
        }
        continue;
      }
      if (isWhitespace(byte)) {
        cursor += 1;
        continue;
      }
      break;
    }
    return cursor;
  }

  readUnsignedInteger(offset: number): { readonly value: number; readonly nextOffset: number } | undefined {
    let cursor = offset;
    let value = 0;
    let digits = 0;
    while (cursor < this.#bytes.byteLength && isDigit(this.#bytes.byteAt(cursor))) {
      value = value * 10 + ((this.#bytes.byteAt(cursor) ?? 0) - 0x30);
      if (!Number.isSafeInteger(value)) {
        throw new PdfSyntaxError("PDF integer exceeds the safe integer range", offset);
      }
      cursor += 1;
      digits += 1;
    }
    return digits === 0 ? undefined : { value, nextOffset: cursor };
  }

  matchesKeyword(offset: number, keyword: string): boolean {
    if (!isBoundary(this.#bytes.byteAt(offset - 1))) {
      return false;
    }
    for (let index = 0; index < keyword.length; index += 1) {
      if (this.#bytes.byteAt(offset + index) !== keyword.charCodeAt(index)) {
        return false;
      }
    }
    return isBoundary(this.#bytes.byteAt(offset + keyword.length));
  }

  findKeyword(keyword: string, offset: number, limit: number = this.#bytes.byteLength): number {
    const end = Math.min(limit, this.#bytes.byteLength) - keyword.length;
    for (let cursor = Math.max(0, offset); cursor <= end; cursor += 1) {
      if (this.matchesKeyword(cursor, keyword)) {
        return cursor;
      }
    }
    return -1;
  }

  findLastKeyword(keyword: string, offset: number = this.#bytes.byteLength): number {
    for (let cursor = Math.min(offset, this.#bytes.byteLength - keyword.length); cursor >= 0; cursor -= 1) {
      if (this.matchesKeyword(cursor, keyword)) {
        return cursor;
      }
    }
    return -1;
  }

  #recoverStreamEnd(streamStart: number, declaredEnd: number): number {
    const lowerBound = Math.max(streamStart, declaredEnd - MAX_STREAM_REPAIR_DISTANCE);
    const upperBound = Math.min(this.#bytes.byteLength, declaredEnd + MAX_STREAM_REPAIR_DISTANCE);
    let before = -1;
    for (let cursor = Math.min(declaredEnd, upperBound - 9); cursor >= lowerBound; cursor -= 1) {
      if (this.#matchesRepairKeyword(cursor, "endstream")) {
        before = cursor;
        break;
      }
    }
    const after = this.#findRepairKeyword("endstream", Math.max(streamStart, declaredEnd), upperBound);
    if (before < 0) {
      return after;
    }
    if (after < 0) {
      return before;
    }
    return declaredEnd - before <= after - declaredEnd ? before : after;
  }

  #findRepairKeyword(keyword: string, offset: number, limit: number): number {
    const end = Math.min(limit, this.#bytes.byteLength) - keyword.length;
    for (let cursor = Math.max(0, offset); cursor <= end; cursor += 1) {
      if (this.#matchesRepairKeyword(cursor, keyword)) {
        return cursor;
      }
    }
    return -1;
  }

  #matchesRepairKeyword(offset: number, keyword: string): boolean {
    for (let index = 0; index < keyword.length; index += 1) {
      if (this.#bytes.byteAt(offset + index) !== keyword.charCodeAt(index)) {
        return false;
      }
    }
    return isBoundary(this.#bytes.byteAt(offset + keyword.length));
  }

  #parseName(start: number): PdfParsedValue {
    let cursor = start + 1;
    const bytes: number[] = [];
    while (cursor < this.#bytes.byteLength) {
      const byte = this.#bytes.byteAt(cursor);
      if (byte === undefined) {
        throw new PdfSyntaxError("Name crosses an unloaded byte range", cursor);
      }
      if (isDelimiter(byte)) {
        break;
      }
      if (byte === 0x23 && isHex(this.#bytes.byteAt(cursor + 1)) && isHex(this.#bytes.byteAt(cursor + 2))) {
        bytes.push((hexValue(this.#bytes.byteAt(cursor + 1) ?? 0) << 4) | hexValue(this.#bytes.byteAt(cursor + 2) ?? 0));
        cursor += 3;
        continue;
      }
      bytes.push(byte);
      cursor += 1;
    }
    const rawBytes = Uint8Array.from(bytes);
    const value: PdfNameValue = {
      kind: "name",
      value: TEXT_DECODER.decode(rawBytes),
      bytes: rawBytes,
      source: range(start, cursor),
    };
    return { value, nextOffset: cursor };
  }

  #parseLiteralString(start: number): PdfParsedValue {
    const bytes: number[] = [];
    let cursor = start + 1;
    let depth = 1;
    while (cursor < this.#bytes.byteLength) {
      const byte = this.#bytes.byteAt(cursor);
      if (byte === undefined) {
        throw new PdfSyntaxError("Literal string crosses an unloaded byte range", cursor);
      }
      if (byte === 0x5c) {
        const escaped = this.#bytes.byteAt(cursor + 1);
        if (escaped === undefined) {
          throw new PdfSyntaxError("Unterminated literal string escape", cursor);
        }
        if (escaped === 0x0d || escaped === 0x0a) {
          cursor += escaped === 0x0d && this.#bytes.byteAt(cursor + 2) === 0x0a ? 3 : 2;
          continue;
        }
        const simpleEscape = escapedByte(escaped);
        if (simpleEscape !== undefined) {
          bytes.push(simpleEscape);
          cursor += 2;
          continue;
        }
        if (isOctal(escaped)) {
          let octal = escaped - 0x30;
          let digits = 1;
          while (digits < 3 && isOctal(this.#bytes.byteAt(cursor + 1 + digits))) {
            octal = octal * 8 + ((this.#bytes.byteAt(cursor + 1 + digits) ?? 0) - 0x30);
            digits += 1;
          }
          bytes.push(octal & 0xff);
          cursor += 1 + digits;
          continue;
        }
        bytes.push(escaped);
        cursor += 2;
        continue;
      }
      if (byte === 0x28) {
        depth += 1;
        bytes.push(byte);
        cursor += 1;
        continue;
      }
      if (byte === 0x29) {
        depth -= 1;
        cursor += 1;
        if (depth === 0) {
          const value: PdfStringValue = {
            kind: "string",
            form: "literal",
            bytes: Uint8Array.from(bytes),
            source: range(start, cursor),
          };
          return { value, nextOffset: cursor };
        }
        bytes.push(byte);
        continue;
      }
      bytes.push(byte ?? 0);
      cursor += 1;
    }
    throw new PdfSyntaxError("Unterminated literal string", start);
  }

  #parseHexadecimalString(start: number): PdfParsedValue {
    const nibbles: number[] = [];
    let cursor = start + 1;
    while (cursor < this.#bytes.byteLength && this.#bytes.byteAt(cursor) !== 0x3e) {
      const byte = this.#bytes.byteAt(cursor);
      if (isWhitespace(byte)) {
        cursor += 1;
        continue;
      }
      if (!isHex(byte)) {
        throw new PdfSyntaxError("Invalid hexadecimal string digit", cursor);
      }
      nibbles.push(hexValue(byte ?? 0));
      cursor += 1;
    }
    if (this.#bytes.byteAt(cursor) !== 0x3e) {
      throw new PdfSyntaxError("Unterminated hexadecimal string", start);
    }
    if (nibbles.length % 2 !== 0) {
      nibbles.push(0);
    }
    const bytes = new Uint8Array(nibbles.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = ((nibbles[index * 2] ?? 0) << 4) | (nibbles[index * 2 + 1] ?? 0);
    }
    const end = cursor + 1;
    const value: PdfStringValue = {
      kind: "string",
      form: "hexadecimal",
      bytes,
      source: range(start, end),
    };
    return { value, nextOffset: end };
  }

  #parseArray(start: number, depth: number): PdfParsedValue {
    const items: PdfValue[] = [];
    let cursor = start + 1;
    while (true) {
      cursor = this.skipWhitespace(cursor);
      if (this.#bytes.byteAt(cursor) === 0x5d) {
        const end = cursor + 1;
        const value: PdfArrayValue = { kind: "array", items, source: range(start, end) };
        return { value, nextOffset: end };
      }
      if (cursor >= this.#bytes.byteLength) {
        throw new PdfSyntaxError("Unterminated array", start);
      }
      const item = this.parseValue(cursor, depth);
      items.push(item.value);
      cursor = item.nextOffset;
    }
  }

  #parseDictionary(start: number, depth: number): PdfParsedValue {
    const entries: PdfDictionaryEntry[] = [];
    let cursor = start + 2;
    while (true) {
      cursor = this.skipWhitespace(cursor);
      if (this.#bytes.byteAt(cursor) === 0x3e && this.#bytes.byteAt(cursor + 1) === 0x3e) {
        const end = cursor + 2;
        const value: PdfDictionaryValue = { kind: "dictionary", entries, source: range(start, end) };
        return { value, nextOffset: end };
      }
      if (cursor >= this.#bytes.byteLength) {
        throw new PdfSyntaxError("Unterminated dictionary", start);
      }
      const key = this.#parseName(cursor);
      if (key.value.kind !== "name") {
        throw new PdfSyntaxError("Dictionary key must be a name", cursor);
      }
      const parsedValue = this.parseValue(key.nextOffset, depth);
      entries.push({ key: key.value, value: parsedValue.value });
      cursor = parsedValue.nextOffset;
    }
  }

  #parseNumberOrReference(start: number): PdfParsedValue {
    const first = this.#readNumber(start);
    if (first.integer) {
      const secondStart = this.skipWhitespace(first.nextOffset);
      const second = this.readUnsignedInteger(secondStart);
      if (second !== undefined) {
        const referenceMarker = this.skipWhitespace(second.nextOffset);
        if (this.matchesKeyword(referenceMarker, "R")) {
          const value: PdfReferenceValue = {
            kind: "reference",
            value: { objectNumber: first.value, generationNumber: second.value },
            source: range(start, referenceMarker + 1),
          };
          return { value, nextOffset: referenceMarker + 1 };
        }
      }
    }
    const source = range(start, first.nextOffset);
    if (first.integer) {
      const value: PdfIntegerValue = { kind: "integer", value: first.value, source };
      return { value, nextOffset: first.nextOffset };
    }
    const value: PdfRealValue = { kind: "real", value: first.value, source };
    return { value, nextOffset: first.nextOffset };
  }

  #readNumber(start: number): { readonly value: number; readonly integer: boolean; readonly nextOffset: number } {
    let cursor = start;
    if (this.#bytes.byteAt(cursor) === 0x2b || this.#bytes.byteAt(cursor) === 0x2d) {
      cursor += 1;
    }
    let digits = 0;
    let decimalPoints = 0;
    while (cursor < this.#bytes.byteLength) {
      const byte = this.#bytes.byteAt(cursor);
      if (isDigit(byte)) {
        digits += 1;
        cursor += 1;
        continue;
      }
      if (byte === 0x2e && decimalPoints === 0) {
        decimalPoints += 1;
        cursor += 1;
        continue;
      }
      break;
    }
    if (digits === 0) {
      throw new PdfSyntaxError("Malformed number", start);
    }
    const value = Number(TEXT_DECODER.decode(this.#bytes.slice(start, cursor)));
    if (!Number.isFinite(value) || (decimalPoints === 0 && !Number.isSafeInteger(value))) {
      throw new PdfSyntaxError("PDF number is outside the supported finite range", start);
    }
    return { value, integer: decimalPoints === 0, nextOffset: cursor };
  }

  skipStreamLineBreak(offset: number): number {
    if (this.#bytes.byteAt(offset) === 0x0d && this.#bytes.byteAt(offset + 1) === 0x0a) {
      return offset + 2;
    }
    if (this.#bytes.byteAt(offset) === 0x0d || this.#bytes.byteAt(offset) === 0x0a) {
      return offset + 1;
    }
    throw new PdfSyntaxError("The stream keyword must be followed by a line break", offset);
  }
}

class Uint8ArrayByteSequence implements PdfByteSequence {
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get byteLength(): number {
    return this.#bytes.byteLength;
  }

  byteAt(offset: number): number | undefined {
    return offset < 0 || offset >= this.byteLength ? undefined : this.#bytes[offset];
  }

  slice(start: number, end: number): Uint8Array {
    return this.#bytes.slice(start, end);
  }
}

function range(start: number, end: number): PdfByteRange {
  return { start, end };
}

function isWhitespace(byte: number | undefined): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function isDelimiter(byte: number | undefined): boolean {
  return byte === undefined ||
    isWhitespace(byte) ||
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x7b ||
    byte === 0x7d ||
    byte === 0x2f ||
    byte === 0x25;
}

function isBoundary(byte: number | undefined): boolean {
  return isDelimiter(byte);
}

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

function isNumberStart(byte: number): boolean {
  return isDigit(byte) || byte === 0x2b || byte === 0x2d || byte === 0x2e;
}

function isOctal(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x37;
}

function isHex(byte: number | undefined): boolean {
  return byte !== undefined && (isDigit(byte) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66));
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) {
    return byte - 0x30;
  }
  if (byte >= 0x41 && byte <= 0x46) {
    return byte - 0x41 + 10;
  }
  return byte - 0x61 + 10;
}

function escapedByte(byte: number): number | undefined {
  switch (byte) {
    case 0x6e:
      return 0x0a;
    case 0x72:
      return 0x0d;
    case 0x74:
      return 0x09;
    case 0x62:
      return 0x08;
    case 0x66:
      return 0x0c;
    case 0x28:
    case 0x29:
    case 0x5c:
      return byte;
    default:
      return undefined;
  }
}
