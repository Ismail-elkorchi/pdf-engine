interface PdfCodeSpaceRange {
  readonly startHex: string;
  readonly endHex: string;
  readonly byteLength: number;
}

interface PdfBfCharMapping {
  readonly sourceHex: string;
  readonly targetHex: string;
}

interface PdfBfRangeMapping {
  readonly sourceStartHex: string;
  readonly sourceEndHex: string;
  readonly targetHexes?: readonly string[];
  readonly targetStartHex?: string;
}

export interface PdfUnicodeCMap {
  readonly codeSpaceRanges: readonly PdfCodeSpaceRange[];
  readonly bfChars: readonly PdfBfCharMapping[];
  readonly bfRanges: readonly PdfBfRangeMapping[];
}

export interface PdfUnicodeDecodeResult {
  readonly text: string;
  readonly complete: boolean;
  readonly sourceUnitCount: number;
  readonly mappedUnitCount: number;
}

export function parsePdfUnicodeCMap(text: string): PdfUnicodeCMap | undefined {
  const codeSpaceRanges = parseCodeSpaceRanges(text);
  const bfChars = parseBfChars(text);
  const bfRanges = parseBfRanges(text);

  if (codeSpaceRanges.length === 0 && bfChars.length === 0 && bfRanges.length === 0) {
    return undefined;
  }

  return {
    codeSpaceRanges,
    bfChars,
    bfRanges,
  };
}

export function decodePdfHexTextWithUnicodeCMap(
  hexToken: string,
  unicodeCMap: PdfUnicodeCMap,
): PdfUnicodeDecodeResult {
  const normalizedHex = normalizePdfHexToken(hexToken);
  const codeLengths = collectCandidateCodeLengths(unicodeCMap);
  if (normalizedHex.length === 0 || codeLengths.length === 0) {
    return { text: "", complete: false, sourceUnitCount: 0, mappedUnitCount: 0 };
  }

  let offset = 0;
  let text = "";
  let mappedUnitCount = 0;

  while (offset < normalizedHex.length) {
    let matched = false;

    for (const codeLength of codeLengths) {
      const nextOffset = offset + codeLength * 2;
      if (nextOffset > normalizedHex.length) {
        continue;
      }

      const sourceHex = normalizedHex.slice(offset, nextOffset);
      if (!matchesAnyCodeSpaceRange(sourceHex, unicodeCMap.codeSpaceRanges)) {
        continue;
      }

      const mappedText = decodeMappedSourceHex(sourceHex, unicodeCMap);
      if (mappedText === undefined) {
        continue;
      }

      text += mappedText;
      offset = nextOffset;
      mappedUnitCount += 1;
      matched = true;
      break;
    }

    if (!matched) {
      return {
        text,
        complete: false,
        sourceUnitCount: mappedUnitCount + 1,
        mappedUnitCount,
      };
    }
  }

  return {
    text,
    complete: true,
    sourceUnitCount: mappedUnitCount,
    mappedUnitCount,
  };
}

function parseCodeSpaceRanges(text: string): PdfCodeSpaceRange[] {
  const ranges: PdfCodeSpaceRange[] = [];

  for (const block of matchBlocks(text, "begincodespacerange", "endcodespacerange")) {
    const matches = block.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g);
    for (const match of matches) {
      const startHex = normalizeHexDigits(match[1] ?? "");
      const endHex = normalizeHexDigits(match[2] ?? "");
      if (startHex.length === 0 || startHex.length !== endHex.length || startHex.length % 2 !== 0) {
        continue;
      }

      ranges.push({
        startHex,
        endHex,
        byteLength: startHex.length / 2,
      });
    }
  }

  return ranges;
}

function parseBfChars(text: string): PdfBfCharMapping[] {
  const mappings: PdfBfCharMapping[] = [];

  for (const block of matchBlocks(text, "beginbfchar", "endbfchar")) {
    const matches = block.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g);
    for (const match of matches) {
      const sourceHex = normalizeHexDigits(match[1] ?? "");
      const targetHex = normalizeHexDigits(match[2] ?? "");
      if (sourceHex.length === 0 || targetHex.length === 0) {
        continue;
      }

      mappings.push({
        sourceHex,
        targetHex,
      });
    }
  }

  return mappings;
}

function parseBfRanges(text: string): PdfBfRangeMapping[] {
  const mappings: PdfBfRangeMapping[] = [];

  for (const block of matchBlocks(text, "beginbfrange", "endbfrange")) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    for (const line of lines) {
      const arrayMatch = line.match(/^<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*\[(.+)\]$/);
      if (arrayMatch) {
        const targetHexes = [...(arrayMatch[3] ?? "").matchAll(/<([0-9A-Fa-f\s]+)>/g)]
          .map((match) => normalizeHexDigits(match[1] ?? ""))
          .filter((value) => value.length > 0);
        mappings.push({
          sourceStartHex: normalizeHexDigits(arrayMatch[1] ?? ""),
          sourceEndHex: normalizeHexDigits(arrayMatch[2] ?? ""),
          targetHexes,
        });
        continue;
      }

      const directMatch = line.match(/^<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>$/);
      if (directMatch) {
        mappings.push({
          sourceStartHex: normalizeHexDigits(directMatch[1] ?? ""),
          sourceEndHex: normalizeHexDigits(directMatch[2] ?? ""),
          targetStartHex: normalizeHexDigits(directMatch[3] ?? ""),
        });
      }
    }
  }

  return mappings.filter((mapping) => mapping.sourceStartHex.length > 0 && mapping.sourceEndHex.length > 0);
}

function matchBlocks(text: string, startKeyword: string, endKeyword: string): string[] {
  const pattern = new RegExp(`\\d+\\s+${startKeyword}([\\s\\S]*?)${endKeyword}`, "g");
  const blocks: string[] = [];

  for (const match of text.matchAll(pattern)) {
    blocks.push(match[1] ?? "");
  }

  return blocks;
}

function collectCandidateCodeLengths(unicodeCMap: PdfUnicodeCMap): number[] {
  const codeLengths = new Set<number>();

  for (const range of unicodeCMap.codeSpaceRanges) {
    codeLengths.add(range.byteLength);
  }
  for (const mapping of unicodeCMap.bfChars) {
    if (mapping.sourceHex.length % 2 === 0) {
      codeLengths.add(mapping.sourceHex.length / 2);
    }
  }
  for (const mapping of unicodeCMap.bfRanges) {
    if (mapping.sourceStartHex.length % 2 === 0) {
      codeLengths.add(mapping.sourceStartHex.length / 2);
    }
  }

  return [...codeLengths].sort((leftLength, rightLength) => rightLength - leftLength);
}

function matchesAnyCodeSpaceRange(sourceHex: string, codeSpaceRanges: readonly PdfCodeSpaceRange[]): boolean {
  const byteLength = sourceHex.length / 2;
  const matchingRanges = codeSpaceRanges.filter((range) => range.byteLength === byteLength);
  if (matchingRanges.length === 0) {
    return true;
  }

  const sourceValue = BigInt(`0x${sourceHex}`);
  return matchingRanges.some((range) => {
    const startValue = BigInt(`0x${range.startHex}`);
    const endValue = BigInt(`0x${range.endHex}`);
    return sourceValue >= startValue && sourceValue <= endValue;
  });
}

function decodeMappedSourceHex(sourceHex: string, unicodeCMap: PdfUnicodeCMap): string | undefined {
  const bfChar = unicodeCMap.bfChars.find((mapping) => mapping.sourceHex === sourceHex);
  if (bfChar) {
    return decodeUnicodeHexString(bfChar.targetHex);
  }

  const sourceValue = BigInt(`0x${sourceHex}`);
  for (const mapping of unicodeCMap.bfRanges) {
    if (mapping.sourceStartHex.length !== sourceHex.length || mapping.sourceEndHex.length !== sourceHex.length) {
      continue;
    }

    const rangeStart = BigInt(`0x${mapping.sourceStartHex}`);
    const rangeEnd = BigInt(`0x${mapping.sourceEndHex}`);
    if (sourceValue < rangeStart || sourceValue > rangeEnd) {
      continue;
    }

    const offset = Number(sourceValue - rangeStart);
    if (mapping.targetHexes !== undefined) {
      const targetHex = mapping.targetHexes[offset];
      return targetHex ? decodeUnicodeHexString(targetHex) : undefined;
    }

    if (mapping.targetStartHex !== undefined) {
      const targetValue = BigInt(`0x${mapping.targetStartHex}`) + BigInt(offset);
      const targetHex = targetValue.toString(16).toUpperCase().padStart(mapping.targetStartHex.length, "0");
      return decodeUnicodeHexString(targetHex);
    }
  }

  return undefined;
}

function decodeUnicodeHexString(value: string): string {
  const normalized = normalizeHexDigits(value);
  let text = "";

  for (let offset = 0; offset < normalized.length; offset += 4) {
    const segment = normalized.slice(offset, offset + 4);
    if (segment.length === 0) {
      continue;
    }

    const codePoint = Number.parseInt(segment, 16);
    if (!Number.isFinite(codePoint)) {
      continue;
    }
    text += String.fromCodePoint(codePoint);
  }

  return text;
}

function normalizePdfHexToken(token: string): string {
  const normalized = normalizeHexDigits(token);
  if (normalized.length % 2 === 0) {
    return normalized;
  }

  return `${normalized}0`;
}

function normalizeHexDigits(value: string): string {
  return value.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
}
