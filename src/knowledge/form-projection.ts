import type {
  PdfKnowledgeCitation,
  PdfKnowledgeForm,
  PdfKnowledgeFormHeuristic,
  PdfKnowledgeFormField,
  PdfKnowledgeTable,
  PdfKnowledgeTableCell,
} from "../contracts.ts";

const FORM_TABLE_HEURISTICS = new Set<PdfKnowledgeFormHeuristic>(["field-value-form", "field-label-form"]);
const STABLE_ID_SLUG_MAX_LENGTH = 56;

export function buildKnowledgeForms(tables: readonly PdfKnowledgeTable[]): readonly PdfKnowledgeForm[] {
  return tables
    .filter((table) => isKnowledgeFormHeuristic(table.heuristic))
    .map(projectKnowledgeFormFromTable)
    .filter((form): form is PdfKnowledgeForm => form !== undefined);
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

function createStableId(
  prefix: string,
  fingerprintParts: readonly unknown[],
  labelParts: readonly unknown[] = fingerprintParts,
): string {
  const fingerprint = fingerprintParts.map(canonicalizeStableIdPart).join("\u001f");
  const label = labelParts
    .map(canonicalizeStableIdPart)
    .map(slugifyStableIdPart)
    .filter((part) => part.length > 0)
    .join("-");
  const slug = truncateStableIdPart(label.length === 0 ? "source" : label, STABLE_ID_SLUG_MAX_LENGTH);
  return `${prefix}-${slug}-${hashStableIdFingerprint(fingerprint)}`;
}

function canonicalizeStableIdPart(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number") {
    return formatStableNumber(value);
  }
  if (typeof value === "string") {
    return normalizeFormText(value);
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeStableIdPart).join("\u001d");
  }
  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return normalizeFormText(JSON.stringify(value) ?? "");
}

function formatStableNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

function slugifyStableIdPart(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

function truncateStableIdPart(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength).replaceAll(/-+$/gu, "");
}

function hashStableIdFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(36).padStart(13, "0");
}
