import {
  createKnowledgeSourceSpan,
  findSourceTextRange,
} from "./citations.ts";
import { createStableId } from "./stable-id.ts";

import type {
  PdfKnowledgeCitation,
  PdfKnowledgeForm,
  PdfKnowledgeFormHeuristic,
  PdfKnowledgeFormField,
  PdfKnowledgeTable,
  PdfKnowledgeTableCell,
  PdfLayoutBlock,
  PdfLayoutDocument,
  PdfLayoutRegion,
} from "../contracts.ts";

const FORM_TABLE_HEURISTICS = new Set<PdfKnowledgeFormHeuristic>(["field-value-form", "field-label-form"]);

export function buildKnowledgeForms(
  layout: PdfLayoutDocument,
  tables: readonly PdfKnowledgeTable[],
): readonly PdfKnowledgeForm[] {
  const tableForms = tables
    .filter((table) => isKnowledgeFormHeuristic(table.heuristic))
    .map(projectKnowledgeFormFromTable)
    .filter((form): form is PdfKnowledgeForm => form !== undefined);
  return [
    ...tableForms,
    ...projectLayoutRegionForms(layout, tableForms),
  ];
}

function projectKnowledgeFormFromTable(table: PdfKnowledgeTable): PdfKnowledgeForm | undefined {
  if (table.heuristic === "field-value-form") {
    return projectFieldValueKnowledgeForm(table);
  }

  if (table.heuristic === "field-label-form") {
    return projectFieldLabelKnowledgeForm(table);
  }

  return undefined;
}

function projectFieldValueKnowledgeForm(table: PdfKnowledgeTable): PdfKnowledgeForm | undefined {
  const fields = groupCellsByRow(table.cells)
    .filter((row) => row.rowIndex > 0)
    .map((row) => {
      const nameCell = row.cells.find((cell) => cell.columnIndex === 0);
      const valueCell = row.cells.find((cell) => cell.columnIndex === 1);
      const name = normalizeFormText(nameCell?.text ?? "");
      const value = normalizeFormText(valueCell?.text ?? "");
      if (name.length === 0 || value.length === 0) {
        return undefined;
      }

      return createKnowledgeFormField({
        table,
        rowIndex: row.rowIndex,
        name,
        value,
        valueState: "value-present",
        citations: dedupeKnowledgeCitations([
          ...(nameCell?.citations ?? []),
          ...(valueCell?.citations ?? []),
        ]),
      });
    })
    .filter((field): field is PdfKnowledgeFormField => field !== undefined);

  return fields.length === 0 ? undefined : createKnowledgeForm(table, "field-value-form", fields);
}

function projectFieldLabelKnowledgeForm(table: PdfKnowledgeTable): PdfKnowledgeForm | undefined {
  const fields = groupCellsByRow(table.cells)
    .filter((row) => row.rowIndex > 0)
    .map((row) => {
      const nameCell = row.cells.find((cell) => cell.columnIndex === 0);
      const name = normalizeFieldLabel(nameCell?.text ?? "");
      if (name.length === 0) {
        return undefined;
      }

      return createKnowledgeFormField({
        table,
        rowIndex: row.rowIndex,
        name,
        valueState: "not-observed",
        citations: dedupeKnowledgeCitations(nameCell?.citations ?? []),
      });
    })
    .filter((field): field is PdfKnowledgeFormField => field !== undefined);

  return fields.length === 0 ? undefined : createKnowledgeForm(table, "field-label-form", fields, table.headers?.[0]);
}

function createKnowledgeForm(
  table: PdfKnowledgeTable,
  heuristic: PdfKnowledgeFormHeuristic,
  fields: readonly PdfKnowledgeFormField[],
  title?: string,
): PdfKnowledgeForm {
  const normalizedTitle = normalizeFormText(title ?? "");
  const label = normalizedTitle.length > 0 ? normalizedTitle : (fields[0]?.name ?? "form");
  const formId = createStableId(
    "form",
    [
      "knowledge-form",
      table.id,
      table.pageNumber,
      heuristic,
      normalizedTitle,
      fields.map((field) => `${field.name}\u001e${field.value ?? ""}\u001e${field.id}`).join("\u001f"),
    ],
    [heuristic, table.pageNumber, label],
  );

  return {
    id: formId,
    pageNumber: table.pageNumber,
    ...(normalizedTitle.length === 0 ? {} : { title: normalizedTitle }),
    heuristic,
    blockIds: table.blockIds,
    confidence: table.confidence,
    fields,
  };
}

function isKnowledgeFormHeuristic(value: unknown): value is PdfKnowledgeFormHeuristic {
  return typeof value === "string" && FORM_TABLE_HEURISTICS.has(value as PdfKnowledgeFormHeuristic);
}

function projectLayoutRegionForms(
  layout: PdfLayoutDocument,
  existingForms: readonly PdfKnowledgeForm[],
): readonly PdfKnowledgeForm[] {
  const existingBlockIds = new Set(existingForms.flatMap((form) => form.blockIds));
  const forms: PdfKnowledgeForm[] = [];

  for (const page of layout.pages) {
    for (const region of page.regions ?? []) {
      if (region.kind !== "form-like" || region.blockIds.some((blockId) => existingBlockIds.has(blockId))) {
        continue;
      }

      const blocksById = new Map(page.blocks.map((block) => [block.id, block]));
      const regionBlocks = region.blockIds
        .map((blockId) => blocksById.get(blockId))
        .filter((block): block is PdfLayoutBlock => block !== undefined)
        .sort((left, right) => left.readingOrder - right.readingOrder);
      const form = projectLayoutRegionForm(region, regionBlocks);
      if (form !== undefined) {
        forms.push(form);
      }
    }
  }

  return forms;
}

function projectLayoutRegionForm(
  region: PdfLayoutRegion,
  blocks: readonly PdfLayoutBlock[],
): PdfKnowledgeForm | undefined {
  const titleBlock = blocks.find((block) => block.role === "heading");
  const fieldBlocks = blocks
    .filter((block) => block.id !== titleBlock?.id)
    .map((block) => ({
      block,
      name: normalizeRegionFieldLabel(block.text),
    }))
    .filter((field): field is { readonly block: PdfLayoutBlock; readonly name: string } => field.name !== undefined);
  if (fieldBlocks.length < 2) {
    return undefined;
  }

  const sourceTable = createRegionFormTable(region, blocks, titleBlock);
  const fields = fieldBlocks.map(({ block, name }, rowIndex) =>
    createKnowledgeFormField({
      table: sourceTable,
      rowIndex,
      name,
      valueState: "not-observed",
      citations: [createRegionFormCitation(region.id, block, name)],
    })
  );

  return {
    id: createStableId(
      "form",
      [
        "layout-region-form",
        region.id,
        region.pageNumber,
        titleBlock?.text ?? "",
        fields.map((field) => `${field.name}\u001e${field.id}`).join("\u001f"),
      ],
      ["layout-region-form", region.pageNumber, titleBlock?.text ?? fields[0]?.name ?? "form"],
    ),
    pageNumber: region.pageNumber,
    ...(titleBlock !== undefined ? { title: normalizeFormText(titleBlock.text) } : {}),
    heuristic: "layout-region-form",
    blockIds: blocks.map((block) => block.id),
    confidence: Math.min(0.72, region.confidence),
    fields,
  };
}

function createRegionFormTable(
  region: PdfLayoutRegion,
  blocks: readonly PdfLayoutBlock[],
  titleBlock: PdfLayoutBlock | undefined,
): PdfKnowledgeTable {
  return {
    id: createStableId(
      "table",
      ["layout-region-form-source", region.id, blocks.map((block) => block.id).join("\u001f")],
      ["layout-region-form-source", region.pageNumber, titleBlock?.text ?? region.id],
    ),
    pageNumber: region.pageNumber,
    headers: titleBlock === undefined ? ["Field"] : [normalizeFormText(titleBlock.text)],
    blockIds: blocks.map((block) => block.id),
    confidence: Math.min(0.72, region.confidence),
    cells: [],
  };
}

function createRegionFormCitation(
  regionId: string,
  block: PdfLayoutBlock,
  fieldName: string,
): PdfKnowledgeCitation {
  const citationText = selectRegionFormCitationText(block.text, fieldName);
  const sourceRange = findSourceTextRange(block.text, citationText);
  return {
    id: createStableId(
      "citation",
      ["layout-region-form", regionId, block.pageNumber, block.id, block.runIds.join(","), citationText],
      ["form", block.pageNumber, block.id, citationText],
    ),
    pageNumber: block.pageNumber,
    blockId: block.id,
    runIds: block.runIds,
    text: citationText,
    ...(sourceRange === undefined ? {} : { sourceSpan: createKnowledgeSourceSpan(block, citationText, block.runIds, sourceRange) }),
    ...(block.pageRef !== undefined ? { pageRef: block.pageRef } : {}),
  };
}

function createKnowledgeFormField({
  table,
  rowIndex,
  name,
  value,
  valueState,
  citations,
}: {
  readonly table: PdfKnowledgeTable;
  readonly rowIndex: number;
  readonly name: string;
  readonly value?: string;
  readonly valueState: PdfKnowledgeFormField["valueState"];
  readonly citations: readonly PdfKnowledgeCitation[];
}): PdfKnowledgeFormField {
  const blockIds = dedupeStrings(citations.map((citation) => citation.blockId));
  const runIds = dedupeStrings(citations.flatMap((citation) => citation.runIds));
  return {
    id: createStableId(
      "field",
      [
        "knowledge-form-field",
        table.id,
        rowIndex,
        name,
        value ?? "",
        valueState,
        citations.map((citation) => citation.id).join("\u001f"),
      ],
      [rowIndex, name],
    ),
    pageNumber: table.pageNumber,
    name,
    ...(value === undefined ? {} : { value }),
    valueState,
    blockIds,
    runIds,
    confidence: table.confidence,
    citations,
  };
}

function groupCellsByRow(cells: readonly PdfKnowledgeTableCell[]): readonly {
  readonly rowIndex: number;
  readonly cells: readonly PdfKnowledgeTableCell[];
}[] {
  const cellsByRow = new Map<number, PdfKnowledgeTableCell[]>();
  for (const cell of cells) {
    const rowCells = cellsByRow.get(cell.rowIndex) ?? [];
    rowCells.push(cell);
    cellsByRow.set(cell.rowIndex, rowCells);
  }

  return [...cellsByRow.entries()]
    .sort(([leftRowIndex], [rightRowIndex]) => leftRowIndex - rightRowIndex)
    .map(([rowIndex, rowCells]) => ({
      rowIndex,
      cells: rowCells.sort((left, right) => left.columnIndex - right.columnIndex),
    }));
}

function normalizeFieldLabel(text: string): string {
  return normalizeFormText(text).replace(/:\s*$/u, "");
}

function normalizeRegionFieldLabel(text: string): string | undefined {
  const normalizedText = normalizeFormText(text);
  if (normalizedText.length === 0 || normalizedText.length > 80) {
    return undefined;
  }

  const colonIndex = normalizedText.indexOf(":");
  const labelText = colonIndex >= 0 ? normalizedText.slice(0, colonIndex) : normalizedText;
  const label = normalizeFieldLabel(labelText);
  if (
    label.length === 0 ||
    /\d/u.test(label) ||
    /[.!?]$/u.test(label) ||
    label.split(/\s+/u).filter((word) => /\p{L}/u.test(word)).length > 6
  ) {
    return undefined;
  }

  return label;
}

function selectRegionFormCitationText(blockText: string, fieldName: string): string {
  const normalizedText = normalizeFormText(blockText);
  if (normalizedText.includes(fieldName)) {
    return fieldName;
  }

  return normalizedText;
}

function normalizeFormText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function dedupeKnowledgeCitations(citations: readonly PdfKnowledgeCitation[]): readonly PdfKnowledgeCitation[] {
  const seenIds = new Set<string>();
  const deduped: PdfKnowledgeCitation[] = [];
  for (const citation of citations) {
    if (seenIds.has(citation.id)) {
      continue;
    }
    seenIds.add(citation.id);
    deduped.push(citation);
  }
  return deduped;
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
