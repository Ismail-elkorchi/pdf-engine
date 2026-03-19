function isDigitByte(value: number | undefined): boolean {
  return value !== undefined && value >= 0x30 && value <= 0x39;
}

function isPdfDelimiterByte(value: number | undefined): boolean {
  return value === undefined ||
    value === 0x00 ||
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0c ||
    value === 0x0d ||
    value === 0x20 ||
    value === 0x25 ||
    value === 0x28 ||
    value === 0x29 ||
    value === 0x2f ||
    value === 0x3c ||
    value === 0x3e ||
    value === 0x5b ||
    value === 0x5d ||
    value === 0x7b ||
    value === 0x7d;
}

function toAsciiBytes(value: string): Uint8Array {
  return Uint8Array.from(Array.from(value, (character) => character.charCodeAt(0) & 0xff));
}

export class PdfByteCursor {
  readonly #bytes: Uint8Array;
  readonly #startOffset: number;
  readonly #endOffset: number;

  constructor(bytes: Uint8Array, startOffset: number = 0, endOffset: number = bytes.byteLength) {
    this.#bytes = bytes;
    this.#startOffset = Math.max(0, startOffset);
    this.#endOffset = Math.min(bytes.byteLength, endOffset);
  }

  get startOffset(): number {
    return this.#startOffset;
  }

  get endOffset(): number {
    return this.#endOffset;
  }

  byteAt(offset: number): number | undefined {
    if (offset < this.#startOffset || offset >= this.#endOffset) {
      return undefined;
    }

    return this.#bytes[offset];
  }

  slice(startOffset: number, endOffset: number): Uint8Array {
    return this.#bytes.subarray(
      Math.max(this.#startOffset, startOffset),
      Math.min(this.#endOffset, endOffset),
    );
  }

  isTokenBoundary(offset: number): boolean {
    return isPdfDelimiterByte(this.byteAt(offset));
  }

  skipWhitespaceAndComments(startOffset: number): number {
    let offset = Math.max(this.#startOffset, startOffset);

    while (offset < this.#endOffset) {
      const current = this.byteAt(offset);
      if (current === 0x25) {
        offset = this.skipComment(offset);
        continue;
      }

      if (
        current === 0x00 ||
        current === 0x09 ||
        current === 0x0a ||
        current === 0x0c ||
        current === 0x0d ||
        current === 0x20
      ) {
        offset += 1;
        continue;
      }

      break;
    }

    return offset;
  }

  skipComment(startOffset: number): number {
    let offset = Math.max(this.#startOffset, startOffset);

    while (offset < this.#endOffset) {
      const current = this.byteAt(offset);
      offset += 1;
      if (current === 0x0a) {
        break;
      }
      if (current === 0x0d) {
        if (this.byteAt(offset) === 0x0a) {
          offset += 1;
        }
        break;
      }
    }

    return offset;
  }

  skipStreamLineBreak(startOffset: number): number {
    let offset = Math.max(this.#startOffset, startOffset);
    if (this.byteAt(offset) === 0x0d) {
      offset += 1;
    }
    if (this.byteAt(offset) === 0x0a) {
      offset += 1;
    }
    return offset;
  }

  readUnsignedInteger(startOffset: number): { value: number; nextOffset: number } | undefined {
    let offset = Math.max(this.#startOffset, startOffset);
    const firstByte = this.byteAt(offset);
    if (!isDigitByte(firstByte)) {
      return undefined;
    }

    let value = 0;
    while (offset < this.#endOffset) {
      const current = this.byteAt(offset);
      if (!isDigitByte(current)) {
        break;
      }

      value = value * 10 + ((current ?? 0) - 0x30);
      offset += 1;
    }

    return {
      value,
      nextOffset: offset,
    };
  }

  matchesKeyword(offset: number, keyword: string): boolean {
    const keywordBytes = toAsciiBytes(keyword);
    if (!this.isTokenBoundary(offset - 1) || !this.isTokenBoundary(offset + keywordBytes.length)) {
      return false;
    }

    for (let index = 0; index < keywordBytes.length; index += 1) {
      if (this.byteAt(offset + index) !== keywordBytes[index]) {
        return false;
      }
    }

    return true;
  }

  findKeyword(keyword: string, startOffset: number, endOffset: number = this.#endOffset): number {
    const keywordBytes = toAsciiBytes(keyword);
    const searchStart = Math.max(this.#startOffset, startOffset);
    const searchEnd = Math.min(this.#endOffset, endOffset) - keywordBytes.length;

    for (let offset = searchStart; offset <= searchEnd; offset += 1) {
      if (this.matchesKeyword(offset, keyword)) {
        return offset;
      }
    }

    return -1;
  }

  findLastKeyword(keyword: string, startOffset: number = this.#endOffset): number {
    const keywordBytes = toAsciiBytes(keyword);
    const searchStart = Math.min(this.#endOffset - keywordBytes.length, Math.max(this.#startOffset, startOffset));

    for (let offset = searchStart; offset >= this.#startOffset; offset -= 1) {
      if (this.matchesKeyword(offset, keyword)) {
        return offset;
      }
    }

    return -1;
  }

  findSequence(sequence: string, startOffset: number): number {
    const sequenceBytes = toAsciiBytes(sequence);
    const searchStart = Math.max(this.#startOffset, startOffset);
    const searchEnd = this.#endOffset - sequenceBytes.length;

    for (let offset = searchStart; offset <= searchEnd; offset += 1) {
      let matched = true;
      for (let index = 0; index < sequenceBytes.length; index += 1) {
        if (this.byteAt(offset + index) !== sequenceBytes[index]) {
          matched = false;
          break;
        }
      }

      if (matched) {
        return offset;
      }
    }

    return -1;
  }
}
