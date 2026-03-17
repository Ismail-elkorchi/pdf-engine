interface SfntTableRecord {
  readonly offset: number;
  readonly length: number;
}

interface CmapEncodingRecord {
  readonly platformId: number;
  readonly encodingId: number;
  readonly subtableOffset: number;
  readonly format: number;
}

/**
 * Builds a glyph-id to Unicode map from an embedded TrueType/OpenType font program.
 *
 * The current shell only needs enough coverage to recover common `FontFile2` text when a PDF
 * omits `ToUnicode`. The parser therefore supports the `cmap` table formats most commonly used
 * by searchable PDF fonts: format 4 and format 12.
 *
 * @param fontBytes Embedded font program bytes from `FontFile2`.
 * @returns A glyph-id keyed Unicode map when a supported `cmap` table is available.
 */
export function parseTrueTypeGlyphUnicodeMap(fontBytes: Uint8Array): ReadonlyMap<number, string> | undefined {
  const view = createDataView(fontBytes);
  if (!view) {
    return undefined;
  }

  const cmapRecord = readSfntTableDirectory(view).get("cmap");
  if (!cmapRecord) {
    return undefined;
  }

  return parseCmapTable(view, cmapRecord);
}

function createDataView(bytes: Uint8Array): DataView | undefined {
  if (bytes.byteLength === 0) {
    return undefined;
  }

  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readSfntTableDirectory(view: DataView): Map<string, SfntTableRecord> {
  const tableRecords = new Map<string, SfntTableRecord>();
  const numTables = readUint16(view, 4);
  if (numTables === undefined) {
    return tableRecords;
  }

  for (let index = 0; index < numTables; index += 1) {
    const recordOffset = 12 + index * 16;
    const tag = readAscii(view, recordOffset, 4);
    const offset = readUint32(view, recordOffset + 8);
    const length = readUint32(view, recordOffset + 12);
    if (tag === undefined || offset === undefined || length === undefined) {
      continue;
    }
    if (!isRangeWithinView(view, offset, length)) {
      continue;
    }

    tableRecords.set(tag, { offset, length });
  }

  return tableRecords;
}

function parseCmapTable(view: DataView, cmapRecord: SfntTableRecord): ReadonlyMap<number, string> | undefined {
  const version = readUint16(view, cmapRecord.offset);
  const numTables = readUint16(view, cmapRecord.offset + 2);
  if (version !== 0 || numTables === undefined) {
    return undefined;
  }

  const encodingRecords: CmapEncodingRecord[] = [];
  for (let index = 0; index < numTables; index += 1) {
    const recordOffset = cmapRecord.offset + 4 + index * 8;
    const platformId = readUint16(view, recordOffset);
    const encodingId = readUint16(view, recordOffset + 2);
    const subtableOffset = readUint32(view, recordOffset + 4);
    if (platformId === undefined || encodingId === undefined || subtableOffset === undefined) {
      continue;
    }

    const absoluteOffset = cmapRecord.offset + subtableOffset;
    const format = readUint16(view, absoluteOffset);
    if (format === undefined) {
      continue;
    }

    encodingRecords.push({
      platformId,
      encodingId,
      subtableOffset: absoluteOffset,
      format,
    });
  }

  const glyphUnicodeByGlyphId = new Map<number, string>();
  const sortedRecords = encodingRecords.sort(compareEncodingRecords);
  for (const record of sortedRecords) {
    if (record.format === 12) {
      mergeGlyphUnicodeMap(glyphUnicodeByGlyphId, parseFormat12Subtable(view, record.subtableOffset));
      continue;
    }
    if (record.format === 4) {
      mergeGlyphUnicodeMap(glyphUnicodeByGlyphId, parseFormat4Subtable(view, record.subtableOffset));
    }
  }

  return glyphUnicodeByGlyphId.size > 0 ? glyphUnicodeByGlyphId : undefined;
}

function compareEncodingRecords(left: CmapEncodingRecord, right: CmapEncodingRecord): number {
  return scoreEncodingRecord(right) - scoreEncodingRecord(left);
}

function scoreEncodingRecord(record: CmapEncodingRecord): number {
  const formatScore = record.format === 12 ? 40 : record.format === 4 ? 20 : 0;

  if (record.platformId === 0) {
    return formatScore + 10;
  }
  if (record.platformId === 3 && record.encodingId === 10) {
    return formatScore + 9;
  }
  if (record.platformId === 3 && record.encodingId === 1) {
    return formatScore + 8;
  }

  return formatScore;
}

function mergeGlyphUnicodeMap(
  target: Map<number, string>,
  source: ReadonlyMap<number, string> | undefined,
): void {
  if (!source) {
    return;
  }

  for (const [glyphId, text] of source) {
    if (!target.has(glyphId)) {
      target.set(glyphId, text);
    }
  }
}

function parseFormat4Subtable(view: DataView, offset: number): ReadonlyMap<number, string> | undefined {
  const length = readUint16(view, offset + 2);
  const segCountX2 = readUint16(view, offset + 6);
  if (length === undefined || segCountX2 === undefined || segCountX2 === 0 || segCountX2 % 2 !== 0) {
    return undefined;
  }
  if (!isRangeWithinView(view, offset, length)) {
    return undefined;
  }

  const segCount = segCountX2 / 2;
  const endCodesOffset = offset + 14;
  const startCodesOffset = endCodesOffset + segCount * 2 + 2;
  const idDeltasOffset = startCodesOffset + segCount * 2;
  const idRangeOffsetsOffset = idDeltasOffset + segCount * 2;
  const glyphIdArrayOffset = idRangeOffsetsOffset + segCount * 2;

  const glyphUnicodeByGlyphId = new Map<number, string>();

  for (let segmentIndex = 0; segmentIndex < segCount; segmentIndex += 1) {
    const endCode = readUint16(view, endCodesOffset + segmentIndex * 2);
    const startCode = readUint16(view, startCodesOffset + segmentIndex * 2);
    const idDelta = readInt16(view, idDeltasOffset + segmentIndex * 2);
    const idRangeOffset = readUint16(view, idRangeOffsetsOffset + segmentIndex * 2);
    if (endCode === undefined || startCode === undefined || idDelta === undefined || idRangeOffset === undefined) {
      continue;
    }
    if (startCode === 0xffff && endCode === 0xffff) {
      continue;
    }

    for (let codePoint = startCode; codePoint <= endCode; codePoint += 1) {
      const glyphId = readFormat4GlyphId(view, {
        codePoint,
        segmentIndex,
        startCode,
        idDelta,
        idRangeOffset,
        idRangeOffsetsOffset,
        glyphIdArrayOffset,
      });
      if (glyphId === undefined || glyphId === 0) {
        continue;
      }
      if (!glyphUnicodeByGlyphId.has(glyphId)) {
        glyphUnicodeByGlyphId.set(glyphId, String.fromCodePoint(codePoint));
      }
    }
  }

  return glyphUnicodeByGlyphId.size > 0 ? glyphUnicodeByGlyphId : undefined;
}

function readFormat4GlyphId(
  view: DataView,
  options: {
    readonly codePoint: number;
    readonly segmentIndex: number;
    readonly startCode: number;
    readonly idDelta: number;
    readonly idRangeOffset: number;
    readonly idRangeOffsetsOffset: number;
    readonly glyphIdArrayOffset: number;
  },
): number | undefined {
  if (options.idRangeOffset === 0) {
    return (options.codePoint + options.idDelta) & 0xffff;
  }

  const idRangeOffsetAddress = options.idRangeOffsetsOffset + options.segmentIndex * 2;
  const glyphIndexAddress = idRangeOffsetAddress + options.idRangeOffset + (options.codePoint - options.startCode) * 2;
  if (glyphIndexAddress < options.glyphIdArrayOffset || !isRangeWithinView(view, glyphIndexAddress, 2)) {
    return undefined;
  }

  const glyphIndex = readUint16(view, glyphIndexAddress);
  if (glyphIndex === undefined || glyphIndex === 0) {
    return glyphIndex;
  }

  return (glyphIndex + options.idDelta) & 0xffff;
}

function parseFormat12Subtable(view: DataView, offset: number): ReadonlyMap<number, string> | undefined {
  const reserved = readUint16(view, offset + 2);
  const length = readUint32(view, offset + 4);
  const numGroups = readUint32(view, offset + 12);
  if (reserved !== 0 || length === undefined || numGroups === undefined) {
    return undefined;
  }
  if (!isRangeWithinView(view, offset, length)) {
    return undefined;
  }

  const glyphUnicodeByGlyphId = new Map<number, string>();
  const groupsOffset = offset + 16;

  for (let groupIndex = 0; groupIndex < numGroups; groupIndex += 1) {
    const groupOffset = groupsOffset + groupIndex * 12;
    const startCharCode = readUint32(view, groupOffset);
    const endCharCode = readUint32(view, groupOffset + 4);
    const startGlyphId = readUint32(view, groupOffset + 8);
    if (startCharCode === undefined || endCharCode === undefined || startGlyphId === undefined) {
      continue;
    }

    for (let codePoint = startCharCode; codePoint <= endCharCode; codePoint += 1) {
      const glyphId = startGlyphId + (codePoint - startCharCode);
      if (!glyphUnicodeByGlyphId.has(glyphId)) {
        glyphUnicodeByGlyphId.set(glyphId, String.fromCodePoint(codePoint));
      }
    }
  }

  return glyphUnicodeByGlyphId.size > 0 ? glyphUnicodeByGlyphId : undefined;
}

function readUint16(view: DataView, offset: number): number | undefined {
  if (!isRangeWithinView(view, offset, 2)) {
    return undefined;
  }

  return view.getUint16(offset, false);
}

function readInt16(view: DataView, offset: number): number | undefined {
  if (!isRangeWithinView(view, offset, 2)) {
    return undefined;
  }

  return view.getInt16(offset, false);
}

function readUint32(view: DataView, offset: number): number | undefined {
  if (!isRangeWithinView(view, offset, 4)) {
    return undefined;
  }

  return view.getUint32(offset, false);
}

function readAscii(view: DataView, offset: number, length: number): string | undefined {
  if (!isRangeWithinView(view, offset, length)) {
    return undefined;
  }

  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(view.getUint8(offset + index));
  }
  return text;
}

function isRangeWithinView(view: DataView, offset: number, length: number): boolean {
  return Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length >= 0 && offset + length <= view.byteLength;
}
