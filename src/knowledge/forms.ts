import type {
  PdfLayoutBlock,
  PdfLayoutPage,
  PdfObservedPage,
  PdfObservedTextRun,
} from "../contracts.ts";
import type {
  ProjectedTableCandidate,
  ProjectedTableRowSeed,
} from "./projection-types.ts";

const FIELD_VALUE_MIN_ROWS = 2;
const FIELD_LABEL_MIN_ROWS = 4;
const FIELD_LABEL_COLUMN_TOLERANCE = 72;

export function projectFieldValueFormTable(page: PdfLayoutPage): ProjectedTableCandidate | undefined {
  const blocks = page.blocks;
  if (blocks.length < 3) {
    return undefined;
  }

  const rows: ProjectedTableRowSeed[] = [];
  const blockIds = new Set<string>();

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex] as PdfLayoutBlock;
    const inlineFieldValue = parseInlineFieldValueRow(block);
    if (inlineFieldValue) {
      rows.push(createFieldValueRow(inlineFieldValue.field, inlineFieldValue.value, [block]));
      blockIds.add(block.id);
      continue;
    }

    const label = parseFieldLabel(block.text);
    if (!label) {
      continue;
    }

    const nextBlock = blocks[blockIndex + 1];
    if (nextBlock === undefined || !looksLikeFieldValuePair(block, nextBlock)) {
      continue;
    }

    rows.push(createFieldValueRow(label, normalizeCellText(nextBlock.text), [block, nextBlock]));
    blockIds.add(block.id);
    blockIds.add(nextBlock.id);
    blockIndex += 1;
  }

  if (rows.length < FIELD_VALUE_MIN_ROWS) {
    return undefined;
  }

  const candidateRows: ProjectedTableRowSeed[] = [
    {
      cells: [
        { columnIndex: 0, text: "Field", blocks: [] },
        { columnIndex: 1, text: "Value", blocks: [] },
      ],
    },
    ...rows,
  ];

  return {
    pageNumber: page.pageNumber,
    heuristic: "field-value-form",
    headers: ["Field", "Value"],
    blockIds: [...blockIds],
    confidence: Number(Math.min(0.78, 0.52 + rows.length * 0.04).toFixed(2)),
    rows: candidateRows,
  };
}

export function projectFieldLabelFormTable(
  page: PdfLayoutPage,
  observationPage: PdfObservedPage,
  runToBlock: ReadonlyMap<string, PdfLayoutBlock>,
  hasFieldValueTable: boolean,
): ProjectedTableCandidate | undefined {
  const headerBlock = selectFormHeaderBlock(page.blocks);
  if (!headerBlock) {
    return undefined;
  }

  const seenLabels = new Set<string>();
  const inlineValueBlockIds = collectInlineValueBlockIds(page.blocks);
  const rows: ProjectedTableRowSeed[] = [
    {
      cells: [
        {
          columnIndex: 0,
          text: normalizeCellText(headerBlock.text),
          blocks: [headerBlock],
        },
      ],
    },
  ];
  const canReuseHeadingFieldLabels = !hasFieldValueTable;

  const orderedRuns = [...observationPage.runs].sort((left, right) =>
    (runToBlock.get(left.id)?.readingOrder ?? Number.POSITIVE_INFINITY) -
    (runToBlock.get(right.id)?.readingOrder ?? Number.POSITIVE_INFINITY)
  );
  for (const run of orderedRuns) {
    const block = runToBlock.get(run.id);
    if (
      !block ||
      block.id === headerBlock.id ||
      inlineValueBlockIds.has(block.id) ||
      block.role === "header" ||
      (block.role === "heading" && !(canReuseHeadingFieldLabels && looksLikeCompactHeadingFieldLabel(block.text)))
    ) {
      continue;
    }

    const labelText = normalizeStandaloneFormFieldLabel(run.text);
    if (!labelText || seenLabels.has(labelText)) {
      continue;
    }

    seenLabels.add(labelText);
    rows.push({
      cells: [
        {
          columnIndex: 0,
          text: labelText,
          blocks: toRunBlocks([run], runToBlock),
        },
      ],
    });
  }

  const projectedRows = selectSpatiallyCoherentProjectionRows(selectFieldLabelProjectionRows(rows));
  if (projectedRows.length - 1 < FIELD_LABEL_MIN_ROWS) {
    return undefined;
  }

  const headerText = normalizeCellText(headerBlock.text);
  return {
    pageNumber: page.pageNumber,
    heuristic: "field-label-form",
    headers: [headerText],
    blockIds: dedupeStrings(projectedRows.flatMap((row) => row.cells.flatMap((cell) => cell.blocks.map((block) => block.id)))),
    confidence: Number(Math.min(0.76, 0.48 + (projectedRows.length - 1) * 0.03).toFixed(2)),
    rows: projectedRows,
  };
}

function selectSpatiallyCoherentProjectionRows(
  rows: readonly ProjectedTableRowSeed[],
): readonly ProjectedTableRowSeed[] {
  const header = rows[0];
  if (header === undefined) return [];
  const body = rows.slice(1);
  const anchored = body.flatMap((row) => row.cells.flatMap((cell) =>
    cell.blocks.flatMap((block) => block.anchor === undefined ? [] : [{ row, block }])
  ));
  if (anchored.length < FIELD_LABEL_MIN_ROWS) return rows;
  if (hasRepeatedHorizontalFieldBands(anchored)) return rows;

  const clusters = anchored.map(({ block }) => {
    const x = block.anchor?.x;
    return x === undefined
      ? []
      : anchored.filter((candidate) =>
        candidate.block.anchor !== undefined && Math.abs(candidate.block.anchor.x - x) <= FIELD_LABEL_COLUMN_TOLERANCE
      );
  });
  const primary = clusters.toSorted((left, right) => right.length - left.length)[0] ?? [];
  if (new Set(primary.map((candidate) => candidate.row)).size < FIELD_LABEL_MIN_ROWS) {
    return [header];
  }
  const primaryRows = new Set(primary.map((candidate) => candidate.row));
  const primaryYs = primary.flatMap((candidate) =>
    candidate.block.anchor === undefined ? [] : [candidate.block.anchor.y]
  );
  return [
    header,
    ...body.filter((row) => primaryRows.has(row) || row.cells.some((cell) => cell.blocks.some((block) => {
      const anchor = block.anchor;
      if (anchor === undefined) return false;
      return primaryYs.some((y) => Math.abs(anchor.y - y) <= Math.max(5, (block.fontSize ?? 12) * 0.6));
    }))),
  ];
}

function hasRepeatedHorizontalFieldBands(
  anchored: readonly { readonly row: ProjectedTableRowSeed; readonly block: PdfLayoutBlock }[],
): boolean {
  const bands: { y: number; rows: Set<ProjectedTableRowSeed> }[] = [];
  for (const candidate of anchored) {
    const anchor = candidate.block.anchor;
    if (anchor === undefined) continue;
    const tolerance = Math.max(5, (candidate.block.fontSize ?? 12) * 0.6);
    const band = bands.find((value) => Math.abs(value.y - anchor.y) <= tolerance);
    if (band === undefined) bands.push({ y: anchor.y, rows: new Set([candidate.row]) });
    else band.rows.add(candidate.row);
  }
  return bands.filter((band) => band.rows.size >= 2).length >= 2;
}

function selectFieldLabelProjectionRows(rows: readonly ProjectedTableRowSeed[]): readonly ProjectedTableRowSeed[] {
  const [headerRow, ...bodyRows] = rows;
  if (headerRow === undefined) {
    return rows;
  }

  const explicitLabelRows = bodyRows.filter((row) =>
    row.cells.some((cell) => normalizeCellText(cell.text).endsWith(":"))
  );
  if (explicitLabelRows.length >= FIELD_LABEL_MIN_ROWS) {
    return [
      headerRow,
      ...bodyRows.filter((row) =>
        row.cells.some((cell) =>
          normalizeCellText(cell.text).endsWith(":") ||
          looksLikeSupplementalFieldLabel(row, explicitLabelRows)
        )
      ),
    ];
  }

  return rows;
}

function looksLikeSupplementalFieldLabel(
  row: ProjectedTableRowSeed,
  explicitLabelRows: readonly ProjectedTableRowSeed[],
): boolean {
  const normalizedText = normalizeCellText(row.cells[0]?.text ?? "");
  if (normalizedText.length === 0 || normalizedText.length > 64 || /[.!?:]$/u.test(normalizedText) || /\d/u.test(normalizedText)) {
    return false;
  }

  const words = normalizedText.split(/\s+/u).filter((word) => /\p{L}/u.test(word));
  if (words.length === 0 || words.length > 8) {
    return false;
  }
  const anchors = row.cells.flatMap((cell) => cell.blocks.flatMap((block) => block.anchor === undefined ? [] : [block.anchor.x]));
  const labelAnchors = explicitLabelRows.flatMap((labelRow) =>
    labelRow.cells.flatMap((cell) => cell.blocks.flatMap((block) => block.anchor === undefined ? [] : [block.anchor.x]))
  );
  const candidateYs = row.cells.flatMap((cell) =>
    cell.blocks.flatMap((block) => block.anchor === undefined ? [] : [block.anchor.y])
  );
  const labelYs = explicitLabelRows.flatMap((labelRow) =>
    labelRow.cells.flatMap((cell) => cell.blocks.flatMap((block) => block.anchor === undefined ? [] : [block.anchor.y]))
  );
  const followsLabelBand = candidateYs.length > 0 && labelYs.length > 0 &&
    Math.min(...labelYs) - Math.max(...candidateYs) >= 30;
  return followsLabelBand &&
    anchors.some((anchor) => labelAnchors.some((labelAnchor) => Math.abs(anchor - labelAnchor) <= 48));
}

function parseInlineFieldValueRow(
  block: PdfLayoutBlock,
): { readonly field: string; readonly value: string } | undefined {
  const normalizedText = normalizeCellText(block.text);
  if (normalizedText.length === 0) {
    return undefined;
  }

  const colonCount = [...normalizedText].filter((character) => character === ":").length;
  if (colonCount !== 1) {
    return undefined;
  }

  const colonIndex = normalizedText.lastIndexOf(":");
  if (colonIndex < 0) {
    return undefined;
  }

  const field = stripFieldPrefix(normalizedText.slice(0, colonIndex));
  const value = normalizeCellText(normalizedText.slice(colonIndex + 1));
  if (!field || !value || looksLikeUrlSchemeField(field) || !looksLikeFieldValueText(value)) {
    return undefined;
  }

  return { field, value };
}

function parseFieldLabel(text: string): string | undefined {
  const normalizedText = normalizeCellText(text);
  if (normalizedText.length === 0 || !normalizedText.endsWith(":")) {
    return undefined;
  }

  const field = stripFieldPrefix(normalizedText.slice(0, -1));
  if (!field || looksLikeNumericCell(field)) {
    return undefined;
  }

  return field;
}

function stripFieldPrefix(text: string): string {
  return text.replace(/^\*\s*/u, "").trim();
}

function looksLikeUrlSchemeField(text: string): boolean {
  const compact = normalizeCellText(text).toLowerCase().replaceAll(/[^a-z0-9]+/gu, "");
  return /^(?:https?|ftp)$/u.test(compact);
}

function looksLikeFieldValuePair(
  labelBlock: PdfLayoutBlock,
  valueBlock: PdfLayoutBlock,
): boolean {
  const label = parseFieldLabel(labelBlock.text);
  const value = normalizeCellText(valueBlock.text);
  if (
    !label ||
    value.length === 0 ||
    parseFieldLabel(valueBlock.text) ||
    parseInlineFieldValueRow(valueBlock)
  ) {
    return false;
  }

  if (!looksLikeFieldValueText(value)) {
    return false;
  }

  const labelAnchor = labelBlock.anchor;
  const valueAnchor = valueBlock.anchor;
  if (labelAnchor === undefined || valueAnchor === undefined) {
    return false;
  }

  const sameColumn = Math.abs(labelAnchor.x - valueAnchor.x) <= 12;
  const closeInFlow = labelAnchor.y - valueAnchor.y <= 40 && labelAnchor.y > valueAnchor.y;
  return sameColumn && closeInFlow;
}

function looksLikeFieldValueText(text: string): boolean {
  const normalizedText = normalizeCellText(text);
  if (normalizedText.length === 0 || normalizedText.length > 96) {
    return false;
  }

  if (normalizedText.endsWith(":")) {
    return false;
  }

  return !/^(?:\*?\s*)?(?:\d+\.\s+)?[A-Z][^:]{0,80}:$/u.test(normalizedText);
}

function selectFormHeaderBlock(blocks: readonly PdfLayoutBlock[]): PdfLayoutBlock | undefined {
  const candidates = blocks.filter((block) => {
    const normalizedText = normalizeCellText(block.text);
    if (block.role !== "heading" || normalizedText.length === 0 || normalizedText.length > 80) {
      return false;
    }

    if (
      looksLikeNumericCell(normalizedText) ||
      looksLikePageMarkerText(normalizedText) ||
      looksLikeTechnicalMetadataText(normalizedText) ||
      normalizedText.split(/\s+/u).filter((word) => /\p{L}/u.test(word)).length < 2 ||
      ((block.fontSize ?? 0) < 18 && normalizeStandaloneFormFieldLabel(normalizedText) !== undefined)
    ) {
      return false;
    }

    return true;
  });

  return candidates.sort((left, right) => {
    const leftFontSize = left.fontSize ?? 0;
    const rightFontSize = right.fontSize ?? 0;
    if (leftFontSize !== rightFontSize) {
      return rightFontSize - leftFontSize;
    }
    return left.readingOrder - right.readingOrder;
  })[0];
}

function normalizeStandaloneFormFieldLabel(text: string): string | undefined {
  const normalizedText = normalizeCellText(text);
  if (normalizedText.length === 0 || normalizedText.length > 64) {
    return undefined;
  }

  if (
    looksLikeTechnicalMetadataText(normalizedText) ||
    looksLikePageMarkerText(normalizedText) ||
    looksLikeNumericCell(normalizedText)
  ) {
    return undefined;
  }

  if (looksLikeNumberedFormPromptLabel(normalizedText)) {
    return undefined;
  }

  if (normalizedText.endsWith(":")) {
    const fieldText = stripFieldPrefix(normalizedText.slice(0, -1));
    return fieldText.length === 0 ? undefined : `${fieldText}:`;
  }

  if (/[.!?]$/.test(normalizedText) || /\d/u.test(normalizedText)) {
    return undefined;
  }

  const words = normalizedText.split(/\s+/u).filter((word) => /\p{L}/u.test(word));
  if (words.length === 0 || words.length > 5 || !/[\p{Ll}]/u.test(normalizedText)) {
    return undefined;
  }

  if (looksLikeSentenceCaseFormFieldLabel(words)) {
    return normalizedText;
  }

  if (!words.every((word) => isHeadingWord(word))) {
    return undefined;
  }

  return normalizedText;
}

function looksLikeNumberedFormPromptLabel(text: string): boolean {
  return /^\d+(?:\.\d+)*[.)]\s+/u.test(text);
}

function looksLikeCompactHeadingFieldLabel(text: string): boolean {
  const normalizedText = normalizeCellText(text);
  if (
    normalizedText.length === 0 ||
    normalizedText.length > 32 ||
    looksLikeNumberedFormPromptLabel(normalizedText) ||
    looksLikeTechnicalMetadataText(normalizedText) ||
    looksLikePageMarkerText(normalizedText) ||
    /[.!?]$/u.test(normalizedText)
  ) {
    return false;
  }

  const labelText = normalizedText.endsWith(":") ? normalizedText.slice(0, -1) : normalizedText;
  const words = labelText
    .split(/\s+/u)
    .filter((word) => /\p{L}|\p{N}/u.test(word));
  return words.length >= 1 && words.length <= 3;
}

function looksLikeTechnicalMetadataText(text: string): boolean {
  const normalized = normalizeCellText(text);
  return /\bv?\d+\.\d+\.\d+\b/iu.test(normalized) ||
    /\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2})?\b/u.test(normalized) ||
    /(?:^|\s)(?:[\w.-]+\/){2,}[\w.-]+(?:$|\s)/u.test(normalized);
}

function collectInlineValueBlockIds(blocks: readonly PdfLayoutBlock[]): ReadonlySet<string> {
  const labels = blocks.filter((block) => parseFieldLabel(block.text) !== undefined && block.anchor !== undefined);
  const valueBlockIds = new Set<string>();
  for (const block of blocks) {
    const blockAnchor = block.anchor;
    if (blockAnchor === undefined || parseFieldLabel(block.text) !== undefined) continue;
    const sameRowLabel = labels.find((label) => {
      if (label.anchor === undefined) return false;
      const fontSize = Math.max(label.fontSize ?? 12, block.fontSize ?? 12);
      return blockAnchor.x > label.anchor.x + Math.max(8, fontSize * 0.6) &&
        Math.abs(blockAnchor.y - label.anchor.y) <= Math.max(5, fontSize * 0.6);
    });
    if (sameRowLabel !== undefined) valueBlockIds.add(block.id);
  }
  const compactRows: PdfLayoutBlock[][] = [];
  for (const block of blocks.filter((candidate) => candidate.anchor !== undefined)) {
    const anchor = block.anchor;
    if (anchor === undefined) continue;
    const row = compactRows.find((candidate) => {
      const candidateAnchor = candidate[0]?.anchor;
      return candidateAnchor !== undefined &&
        Math.abs(candidateAnchor.y - anchor.y) <= Math.max(5, (block.fontSize ?? 12) * 0.6);
    });
    if (row === undefined) compactRows.push([block]);
    else row.push(block);
  }
  for (const row of compactRows) {
    if (
      row.length >= 2 &&
      row.every((block) => parseFieldLabel(block.text) === undefined) &&
      row.every((block) => /^\p{L}[\p{L}\p{M}'’/-]{0,19}$/u.test(normalizeCellText(block.text)))
    ) {
      row.forEach((block) => valueBlockIds.add(block.id));
    }
  }
  return valueBlockIds;
}

function looksLikePageMarkerText(text: string): boolean {
  return /^page \d+ of \d+$/iu.test(text);
}

function isHeadingWord(word: string): boolean {
  const normalized = word.replaceAll(/^[("'[]+|[)"'\].,:;!?]+$/gu, "");
  if (normalized.length === 0) {
    return false;
  }

  return /^[\p{Lu}\p{Lt}\p{N}][\p{L}\p{N}'’/-]*$/u.test(normalized) ||
    /^(?:a|an|and|as|at|by|de|for|from|in|into|of|on|or|the|to|und|von|with)$/iu.test(normalized);
}

function looksLikeSentenceCaseFormFieldLabel(words: readonly string[]): boolean {
  const [firstWord, ...remainingWords] = words;
  if (firstWord === undefined || !startsWithUppercaseLetter(firstWord)) {
    return false;
  }

  return remainingWords.every((word) => {
    if (/^(?:a|an|and|as|at|by|de|for|from|in|into|of|on|or|the|to|und|von|with)$/iu.test(word)) {
      return true;
    }

    return /^[\p{Ll}][\p{L}\p{N}'’/-]*$/u.test(word) || isHeadingWord(word);
  });
}

function startsWithUppercaseLetter(word: string): boolean {
  const normalized = word.replaceAll(/^[("'[]+|[)"'\].,:;!?]+$/gu, "");
  return /^[\p{Lu}\p{Lt}]/u.test(normalized);
}

function createFieldValueRow(
  field: string,
  value: string,
  blocks: readonly PdfLayoutBlock[],
): ProjectedTableRowSeed {
  return {
    cells: [
      {
        columnIndex: 0,
        text: field,
        blocks,
      },
      {
        columnIndex: 1,
        text: value,
        blocks,
      },
    ],
  };
}

function normalizeCellText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function looksLikeNumericCell(text: string): boolean {
  return /^[\d\s.,$()%+-]+$/u.test(text);
}

function toRunBlocks(
  runs: readonly PdfObservedTextRun[],
  runToBlock: ReadonlyMap<string, PdfLayoutBlock>,
): readonly PdfLayoutBlock[] {
  return dedupeById(runs.map((run) => runToBlock.get(run.id)).filter((block): block is PdfLayoutBlock => block !== undefined));
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function dedupeById<T extends { readonly id: string }>(values: readonly T[]): readonly T[] {
  const seenIds = new Set<string>();
  const deduped: T[] = [];
  for (const value of values) {
    if (seenIds.has(value.id)) {
      continue;
    }
    seenIds.add(value.id);
    deduped.push(value);
  }
  return deduped;
}
