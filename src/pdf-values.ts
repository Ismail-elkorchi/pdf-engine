/** A half-open byte range in the original PDF source. */
export interface PdfByteRange {
  readonly start: number;
  readonly end: number;
}

/** An indirect PDF object reference. */
export interface PdfReference {
  readonly objectNumber: number;
  readonly generationNumber: number;
}

interface PdfValueBase {
  readonly source: PdfByteRange;
}

export interface PdfNullValue extends PdfValueBase {
  readonly kind: "null";
}

export interface PdfBooleanValue extends PdfValueBase {
  readonly kind: "boolean";
  readonly value: boolean;
}

export interface PdfIntegerValue extends PdfValueBase {
  readonly kind: "integer";
  readonly value: number;
}

export interface PdfRealValue extends PdfValueBase {
  readonly kind: "real";
  readonly value: number;
}

export interface PdfNameValue extends PdfValueBase {
  readonly kind: "name";
  /** Decoded name value without the leading slash. */
  readonly value: string;
  /** Original name bytes after the leading slash. */
  readonly bytes: Uint8Array;
}

export interface PdfStringValue extends PdfValueBase {
  readonly kind: "string";
  readonly form: "literal" | "hexadecimal";
  /** Decoded binary string bytes. Text interpretation is context dependent. */
  readonly bytes: Uint8Array;
}

export interface PdfArrayValue extends PdfValueBase {
  readonly kind: "array";
  readonly items: readonly PdfValue[];
}

export interface PdfDictionaryEntry {
  readonly key: PdfNameValue;
  readonly value: PdfValue;
}

export interface PdfDictionaryValue extends PdfValueBase {
  readonly kind: "dictionary";
  /** Entries in source order. Later duplicate keys take precedence when resolved. */
  readonly entries: readonly PdfDictionaryEntry[];
}

export interface PdfReferenceValue extends PdfValueBase {
  readonly kind: "reference";
  readonly value: PdfReference;
}

export type PdfValue =
  | PdfNullValue
  | PdfBooleanValue
  | PdfIntegerValue
  | PdfRealValue
  | PdfNameValue
  | PdfStringValue
  | PdfArrayValue
  | PdfDictionaryValue
  | PdfReferenceValue;

export interface PdfStreamValue {
  readonly dictionary: PdfDictionaryValue;
  readonly source: PdfByteRange;
  readonly dataSource: PdfByteRange;
  readonly rawBytes: Uint8Array;
}

export interface PdfIndirectObject {
  readonly ref: PdfReference;
  readonly revision: number;
  readonly source: PdfByteRange;
  readonly value: PdfValue;
  readonly stream?: PdfStreamValue;
}

export function pdfReferenceKey(ref: PdfReference): string {
  return `${String(ref.objectNumber)}:${String(ref.generationNumber)}`;
}

export function pdfDictionaryGet(
  dictionary: PdfDictionaryValue,
  key: string,
): PdfValue | undefined {
  for (let index = dictionary.entries.length - 1; index >= 0; index -= 1) {
    const entry = dictionary.entries[index];
    if (entry?.key.value === key) {
      return entry.value;
    }
  }
  return undefined;
}

export function pdfAsDictionary(value: PdfValue | undefined): PdfDictionaryValue | undefined {
  return value?.kind === "dictionary" ? value : undefined;
}

export function pdfAsArray(value: PdfValue | undefined): PdfArrayValue | undefined {
  return value?.kind === "array" ? value : undefined;
}

export function pdfAsName(value: PdfValue | undefined): string | undefined {
  return value?.kind === "name" ? value.value : undefined;
}

export function pdfAsInteger(value: PdfValue | undefined): number | undefined {
  return value?.kind === "integer" ? value.value : undefined;
}

export function pdfAsNumber(value: PdfValue | undefined): number | undefined {
  return value?.kind === "integer" || value?.kind === "real" ? value.value : undefined;
}

export function pdfAsReference(value: PdfValue | undefined): PdfReference | undefined {
  return value?.kind === "reference" ? value.value : undefined;
}
