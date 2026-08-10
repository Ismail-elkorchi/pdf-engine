import { type PdfBudgetTracker } from "./pdf-budget.ts";
import { PdfSyntaxError, PdfSyntaxParser } from "./pdf-syntax.ts";

import type { PdfByteRange, PdfDictionaryValue, PdfNameValue, PdfReference, PdfValue } from "./pdf-values.ts";

export interface PdfContentOperator {
  readonly operator: string;
  readonly operands: readonly PdfValue[];
  readonly source: PdfByteRange;
}

export interface PdfInlineImage {
  readonly operator: "BI";
  readonly dictionary: PdfDictionaryValue;
  readonly bytes: Uint8Array;
  readonly source: PdfByteRange;
}

export type PdfContentInstruction = PdfContentOperator | PdfInlineImage;

export interface PdfContentStreamInput {
  readonly bytes: Uint8Array;
  readonly contentStreamRef: PdfReference;
}

export type PdfReferencedContentInstruction =
  | (PdfContentOperator & { readonly contentStreamRef: PdfReference })
  | (PdfInlineImage & { readonly contentStreamRef: PdfReference });

export function parsePdfContentStream(
  bytes: Uint8Array,
  budget: PdfBudgetTracker,
): readonly PdfContentInstruction[] {
  const parser = new PdfSyntaxParser(bytes, budget);
  const instructions: PdfContentInstruction[] = [];
  const operands: PdfValue[] = [];
  let cursor = 0;
  let instructionStart = 0;

  while (cursor < bytes.byteLength) {
    cursor = parser.skipWhitespace(cursor);
    if (cursor >= bytes.byteLength) {
      break;
    }
    if (canStartValue(bytes[cursor])) {
      const parsed = parser.parseValue(cursor);
      if (operands.length === 0) {
        instructionStart = cursor;
      }
      operands.push(parsed.value);
      cursor = parsed.nextOffset;
      continue;
    }

    const token = readOperatorToken(bytes, cursor);
    if (token.value.length === 0) {
      throw new PdfSyntaxError("Malformed content stream token", cursor);
    }
    if (token.value === "true" || token.value === "false" || token.value === "null") {
      const parsed = parser.parseValue(cursor);
      operands.push(parsed.value);
      cursor = parsed.nextOffset;
      continue;
    }
    budget.operator();
    if (token.value === "BI") {
      if (operands.length !== 0) {
        instructions.push({
          operator: "BI",
          operands: [...operands],
          source: { start: instructionStart, end: token.nextOffset },
        });
        operands.length = 0;
      }
      const inlineImage = parseInlineImage(bytes, parser, token.nextOffset);
      instructions.push(inlineImage.image);
      cursor = inlineImage.nextOffset;
      instructionStart = cursor;
      continue;
    }
    instructions.push({
      operator: token.value,
      operands: [...operands],
      source: { start: operands.length === 0 ? cursor : instructionStart, end: token.nextOffset },
    });
    operands.length = 0;
    cursor = token.nextOffset;
    instructionStart = cursor;
  }

  if (operands.length !== 0) {
    throw new PdfSyntaxError("Content stream ended with operands but no operator", instructionStart);
  }
  return instructions;
}

export function parsePdfContentStreams(
  streams: readonly PdfContentStreamInput[],
  budget: PdfBudgetTracker,
): readonly PdfReferencedContentInstruction[] {
  if (streams.length === 0) {
    return [];
  }
  const byteLength = streams.reduce((length, stream) => length + stream.bytes.byteLength, streams.length - 1);
  if (!Number.isSafeInteger(byteLength)) {
    throw new PdfSyntaxError("Content stream sequence is too large", 0);
  }
  const bytes = new Uint8Array(byteLength);
  const ranges: Array<{
    readonly start: number;
    readonly end: number;
    readonly contentStreamRef: PdfReference;
  }> = [];
  let offset = 0;
  for (const [index, stream] of streams.entries()) {
    const start = offset;
    bytes.set(stream.bytes, offset);
    offset += stream.bytes.byteLength;
    ranges.push({ start, end: offset, contentStreamRef: stream.contentStreamRef });
    if (index + 1 < streams.length) {
      bytes[offset] = 0x0a;
      offset += 1;
    }
  }
  return parsePdfContentStream(bytes, budget).map((instruction) => {
    const range = ranges.find((candidate) =>
      instruction.source.start >= candidate.start && instruction.source.start < candidate.end
    ) ?? ranges.at(-1);
    if (range === undefined) {
      throw new PdfSyntaxError("Content instruction has no source stream", instruction.source.start);
    }
    return { ...instruction, contentStreamRef: range.contentStreamRef };
  });
}

function parseInlineImage(
  bytes: Uint8Array,
  parser: PdfSyntaxParser,
  start: number,
): { readonly image: PdfInlineImage; readonly nextOffset: number } {
  const entries: { readonly key: PdfNameValue; readonly value: PdfValue }[] = [];
  let cursor = start;
  while (true) {
    cursor = parser.skipWhitespace(cursor);
    const token = readOperatorToken(bytes, cursor);
    if (token.value === "ID") {
      cursor = token.nextOffset;
      break;
    }
    const key = parser.parseValue(cursor);
    if (key.value.kind !== "name") {
      throw new PdfSyntaxError("Inline image dictionary key must be a name", cursor);
    }
    const value = parser.parseValue(key.nextOffset);
    entries.push({ key: key.value, value: value.value });
    cursor = value.nextOffset;
  }

  if (bytes[cursor] === 0x0d && bytes[cursor + 1] === 0x0a) {
    cursor += 2;
  } else if (isWhitespace(bytes[cursor])) {
    cursor += 1;
  }
  const dataStart = cursor;
  const dataEnd = findInlineImageEnd(bytes, dataStart);
  if (dataEnd < 0) {
    throw new PdfSyntaxError("Inline image has no EI terminator", dataStart);
  }
  const end = dataEnd + 2;
  return {
    image: {
      operator: "BI",
      dictionary: { kind: "dictionary", entries, source: { start, end: dataStart } },
      bytes: Uint8Array.from(bytes.subarray(dataStart, trimInlineImageWhitespace(bytes, dataStart, dataEnd))),
      source: { start, end },
    },
    nextOffset: end,
  };
}

function findInlineImageEnd(bytes: Uint8Array, start: number): number {
  for (let cursor = start + 1; cursor < bytes.byteLength - 1; cursor += 1) {
    if (
      bytes[cursor] === 0x45 &&
      bytes[cursor + 1] === 0x49 &&
      isWhitespace(bytes[cursor - 1]) &&
      (isWhitespace(bytes[cursor + 2]) || isDelimiter(bytes[cursor + 2]))
    ) {
      return cursor;
    }
  }
  return -1;
}

function trimInlineImageWhitespace(bytes: Uint8Array, start: number, end: number): number {
  let cursor = end;
  while (cursor > start && isWhitespace(bytes[cursor - 1])) {
    cursor -= 1;
  }
  return cursor;
}

function readOperatorToken(bytes: Uint8Array, offset: number): { readonly value: string; readonly nextOffset: number } {
  let cursor = offset;
  while (cursor < bytes.byteLength && !isWhitespace(bytes[cursor]) && !isDelimiter(bytes[cursor])) {
    cursor += 1;
  }
  let value = "";
  for (let index = offset; index < cursor; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return { value, nextOffset: cursor };
}

function canStartValue(byte: number | undefined): boolean {
  return byte === 0x2f || byte === 0x28 || byte === 0x5b || byte === 0x3c ||
    byte === 0x2b || byte === 0x2d || byte === 0x2e ||
    (byte !== undefined && byte >= 0x30 && byte <= 0x39);
}

function isWhitespace(byte: number | undefined): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function isDelimiter(byte: number | undefined): boolean {
  return byte === undefined || byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e ||
    byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;
}
