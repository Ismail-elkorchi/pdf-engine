import { type PdfBudgetTracker } from "./pdf-budget.ts";
import { formatPdfValue } from "./pdf-value-format.ts";
import {
  type PdfDictionaryValue,
  type PdfStreamValue,
  pdfDictionaryGet,
} from "./pdf-values.ts";
import { decodePdfStreamBytes } from "./stream-decode.ts";

export interface PdfDecodedStream {
  readonly bytes: Uint8Array;
  readonly decoded: boolean;
  readonly filters: readonly string[];
}

export async function decodeTypedPdfStream(
  stream: PdfStreamValue,
  budget: PdfBudgetTracker,
): Promise<PdfDecodedStream> {
  const filter = pdfDictionaryGet(stream.dictionary, "Filter");
  const decodeParameters = pdfDictionaryGet(stream.dictionary, "DecodeParms") ??
    pdfDictionaryGet(stream.dictionary, "DP");
  const result = await decodePdfStreamBytes(
    stream.rawBytes,
    filter === undefined ? undefined : formatPdfValue(filter),
    decodeParameters === undefined ? undefined : formatPdfValue(decodeParameters),
  );
  if (result.decodedBytes === undefined) {
    throw new PdfStreamDecodeError(result.state, result.filterNames, stream.dictionary);
  }
  budget.decodedBytes(result.decodedBytes.byteLength);
  return {
    bytes: result.decodedBytes,
    decoded: result.state === "decoded",
    filters: result.filterNames,
  };
}

export class PdfStreamDecodeError extends Error {
  readonly state: "available" | "decoded" | "unsupported-filter" | "failed";
  readonly filters: readonly string[];
  readonly dictionary: PdfDictionaryValue;

  constructor(
    state: "available" | "decoded" | "unsupported-filter" | "failed",
    filters: readonly string[],
    dictionary: PdfDictionaryValue,
  ) {
    super(`Unable to decode PDF stream (${state}; filters: ${filters.join(", ") || "none"}).`);
    this.name = "PdfStreamDecodeError";
    this.state = state;
    this.filters = filters;
    this.dictionary = dictionary;
  }
}
