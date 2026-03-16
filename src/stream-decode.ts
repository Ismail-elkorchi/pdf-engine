import type { PdfStreamDecodeState } from "./contracts.ts";

export interface PdfDecodedStreamResult {
  readonly state: PdfStreamDecodeState;
  readonly filterNames: readonly string[];
  readonly decodedBytes?: Uint8Array;
}

export function readPdfStreamFilters(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }

  const directName = readNameValue(value);
  if (directName !== undefined) {
    return [directName];
  }

  const filterNames: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const nameToken = readPdfNameToken(value, index);
    if (!nameToken) {
      continue;
    }

    filterNames.push(nameToken.name);
    index = nameToken.nextIndex - 1;
  }

  return filterNames;
}

export async function decodePdfStreamBytes(
  rawStreamBytes: Uint8Array | undefined,
  filterValue: string | undefined,
): Promise<PdfDecodedStreamResult> {
  const filterNames = readPdfStreamFilters(filterValue);
  if (rawStreamBytes === undefined) {
    return {
      state: "failed",
      filterNames,
    };
  }

  if (filterNames.length === 0) {
    return {
      state: "available",
      filterNames,
      decodedBytes: Uint8Array.from(rawStreamBytes),
    };
  }

  if (!filterNames.every((filterName) => filterName === "FlateDecode")) {
    return {
      state: "unsupported-filter",
      filterNames,
    };
  }

  try {
    return {
      state: "decoded",
      filterNames,
      decodedBytes: await inflateStreamBytes(rawStreamBytes),
    };
  } catch {
    return {
      state: "failed",
      filterNames,
    };
  }
}

function readNameValue(value: string): string | undefined {
  const nameToken = readPdfNameToken(value.trim(), 0);
  return nameToken?.name;
}

function readPdfNameToken(
  text: string,
  startIndex: number,
): {
  readonly name: string;
  readonly nextIndex: number;
} | undefined {
  if (text[startIndex] !== "/") {
    return undefined;
  }

  let index = startIndex + 1;
  while (index < text.length && !isPdfDelimiter(text[index] ?? "")) {
    index += 1;
  }

  const name = text.slice(startIndex + 1, index);
  return name.length === 0 ? undefined : { name, nextIndex: index };
}

async function inflateStreamBytes(rawStreamBytes: Uint8Array): Promise<Uint8Array> {
  const exactBytes = Uint8Array.from(rawStreamBytes);
  const response = new Response(new Blob([exactBytes]).stream().pipeThrough(new DecompressionStream("deflate")));
  return new Uint8Array(await response.arrayBuffer());
}

function isPdfDelimiter(value: string): boolean {
  return (
    value === "" ||
    value === " " ||
    value === "\t" ||
    value === "\n" ||
    value === "\r" ||
    value === "\f" ||
    value === "\0" ||
    value === "(" ||
    value === ")" ||
    value === "<" ||
    value === ">" ||
    value === "[" ||
    value === "]" ||
    value === "{" ||
    value === "}" ||
    value === "/" ||
    value === "%"
  );
}
