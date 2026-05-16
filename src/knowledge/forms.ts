import type {
  PdfLayoutBlock,
  PdfLayoutPage,
  PdfObservedPage,
  PdfObservedTextRun,
} from "../contracts.ts";
import type {
  AnchoredLayoutBlock,
  ProjectedTableCandidate,
  ProjectedTableRowSeed,
} from "./projection-types.ts";

const FIELD_VALUE_MIN_ROWS = 2;
const FIELD_LABEL_MIN_ROWS = 4;
const FIELD_LABEL_MAX_X_SPAN = 240;
const FORM_OPTION_TEXTS = new Set(["female", "male", "non-binary", "verified"]);

export function projectFieldValueFormTable(page: PdfLayoutPage): ProjectedTableCandidate | undefined {
  const blocks = page.blocks.filter((block) => block.role !== "header" && block.role !== "footer");
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

  for (const run of observationPage.runs) {
    const block = runToBlock.get(run.id);
    if (
      !block ||
      block.id === headerBlock.id ||
      block.role === "header" ||
      (block.role === "heading" && !(canReuseHeadingFieldLabels && looksLikeCompactHeadingFieldLabel(block.text))) ||
      (block.role === "footer" && !looksLikeFormFooterFieldCluster(block.text))
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

  const projectedRows = selectFieldLabelProjectionRows(rows);
  if (projectedRows.length - 1 < FIELD_LABEL_MIN_ROWS) {
    return undefined;
  }

  const labelAnchors = projectedRows
    .slice(1)
    .flatMap((row) => row.cells)
    .flatMap((cell) => cell.blocks)
    .filter((block): block is AnchoredLayoutBlock => block.anchor !== undefined)
    .map((block) => block.anchor.x);
  if (labelAnchors.length > 0) {
    const xSpan = Math.max(...labelAnchors) - Math.min(...labelAnchors);
    if (xSpan > FIELD_LABEL_MAX_X_SPAN) {
      return undefined;
    }
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
          looksLikeSupplementalFieldLabel(normalizeCellText(cell.text))
        )
      ),
    ];
  }

  return rows;
}

function looksLikeSupplementalFieldLabel(text: string): boolean {
  const normalizedText = normalizeCellText(text);
  if (normalizedText.length === 0 || normalizedText.length > 64 || /[.!?:]$/u.test(normalizedText) || /\d/u.test(normalizedText)) {
    return false;
  }

  const words = normalizedText.split(/\s+/u).filter((word) => /\p{L}/u.test(word));
  if (words.length < 2 || words.length > 8) {
    return false;
  }

  return /^(?:accept|acknowledge|agree|authorize|certify|confirm|consent|verify)\b/iu.test(normalizedText);
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
      looksLikeFormMetadataText(normalizedText) ||
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
    looksLikeFormMetadataText(normalizedText) ||
    looksLikePageMarkerText(normalizedText) ||
    looksLikeNumericCell(normalizedText)
  ) {
    return undefined;
  }

  const lowerText = normalizedText.toLowerCase();
  if (FORM_OPTION_TEXTS.has(lowerText)) {
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
    !normalizedText.endsWith(":") ||
    normalizedText.length > 32 ||
    looksLikeNumberedFormPromptLabel(normalizedText) ||
    looksLikeFormMetadataText(normalizedText) ||
    looksLikePageMarkerText(normalizedText)
  ) {
    return false;
  }

  const words = normalizedText
    .slice(0, -1)
    .split(/\s+/u)
    .filter((word) => /\p{L}|\p{N}/u.test(word));
  return words.length >= 1 && words.length <= 3;
}

function looksLikeFormFooterFieldCluster(text: string): boolean {
  const lines = text
    .split(/\n+/u)
    .map((line) => normalizeCellText(line))
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return false;
  }

  return lines.some((line) => parseFieldLabel(line) !== undefined) &&
    lines.some((line) => FORM_OPTION_TEXTS.has(line.toLowerCase()));
}

function looksLikeFormMetadataText(text: string): boolean {
  return /^(?:created:|optimized\b|pdfcpu:|pr\. name:|source:|testdata\/)/iu.test(text);
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
