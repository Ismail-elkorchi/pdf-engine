import { parsePdfContentStreams, type PdfInlineImage } from "./pdf-content.ts";
import { formatPdfValue } from "./pdf-value-format.ts";
import {
  type PdfDictionaryValue,
  type PdfReference,
  type PdfValue,
  pdfAsInteger,
  pdfAsNumber,
  pdfAsReference,
  pdfDictionaryGet,
  pdfReferenceKey,
} from "./pdf-values.ts";
import { decodePdfStreamBytes } from "./stream-decode.ts";

import type { PdfObservedDocument } from "./contracts.ts";
import type { PdfDocumentModel } from "./pdf-document-model.ts";
import type { PdfObjectStore } from "./pdf-object-store.ts";
import type {
  PdfImageOptions,
  PdfImagePlacement,
  PdfImageResource,
  PdfImages,
  PdfPageSelection,
} from "./public-api.ts";

type Matrix = readonly [number, number, number, number, number, number];

export async function extractPdfImages(
  store: PdfObjectStore,
  model: PdfDocumentModel,
  observation: PdfObservedDocument,
  options: PdfImageOptions,
): Promise<PdfImages> {
  const selectedPages = selectPages(options.pages, model.pages.length);
  const placements: PdfImagePlacement[] = [];
  const resourceRefs = new Map<string, PdfReference>();

  for (const page of observation.pages) {
    if (!selectedPages.has(page.pageNumber)) {
      continue;
    }
    for (const mark of page.marks) {
      if (mark.kind !== "image" || mark.xObjectRef === undefined) {
        continue;
      }
      const resourceId = imageResourceId(mark.xObjectRef);
      resourceRefs.set(resourceId, mark.xObjectRef);
      placements.push({
        id: mark.id,
        resourceId,
        pageNumber: page.pageNumber,
        resourceName: mark.resourceName,
        ...(mark.bbox !== undefined ? { bounds: mark.bbox } : {}),
        ...(mark.transform !== undefined ? {
          transform: [
            mark.transform.a,
            mark.transform.b,
            mark.transform.c,
            mark.transform.d,
            mark.transform.e,
            mark.transform.f,
          ],
        } : {}),
        ...(mark.contentStreamRef !== undefined ? { contentStreamRef: mark.contentStreamRef } : {}),
      });
    }
  }

  const resources: PdfImageResource[] = [];
  for (const [id, ref] of [...resourceRefs].toSorted(([left], [right]) => left.localeCompare(right))) {
    const resource = await readImageObject(store, id, ref, options.includeBytes === true);
    if (resource !== undefined) {
      resources.push(resource);
    }
  }

  for (const page of model.pages) {
    if (!selectedPages.has(page.pageNumber)) {
      continue;
    }
    const contentStreams = [];
    for (const contentStreamRef of page.contents) {
      const decoded = await store.decodeStream(contentStreamRef);
      if (decoded !== undefined) {
        contentStreams.push({ bytes: decoded.bytes, contentStreamRef });
      }
    }
    const instructions = parsePdfContentStreams(contentStreams, store.budget);
    const stack: Matrix[] = [];
    const pageTransform = pageDisplayMatrix(page);
    let transform: Matrix = [1, 0, 0, 1, 0, 0];
    let inlineIndex = 0;
    for (const instruction of instructions) {
      const contentRef = instruction.contentStreamRef;
      if ("dictionary" in instruction) {
        const displayTransform = multiplyMatrices(transform, pageTransform);
        inlineIndex += 1;
        const id = `image-inline-${String(page.pageNumber)}-${String(contentRef.objectNumber)}-${String(inlineIndex)}`;
        const resource = await readInlineImage(store, id, instruction, options.includeBytes === true);
        resources.push(resource);
        placements.push({
          id: `placement-${id}`,
          resourceId: id,
          pageNumber: page.pageNumber,
          resourceName: `inline-${String(inlineIndex)}`,
          bounds: matrixBounds(displayTransform),
          transform: displayTransform,
          contentStreamRef: contentRef,
        });
        continue;
      }
      if (instruction.operator === "q") {
        stack.push(transform);
        continue;
      }
      if (instruction.operator === "Q") {
        transform = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        continue;
      }
      if (instruction.operator === "cm") {
        const matrix = numberMatrix(instruction.operands);
        if (matrix !== undefined) {
          transform = multiplyMatrices(transform, matrix);
        }
      }
    }
  }

  return {
    resources: resources.toSorted((left, right) => left.id.localeCompare(right.id)),
    placements: placements.toSorted((left, right) =>
      left.pageNumber - right.pageNumber || left.id.localeCompare(right.id)
    ),
  };
}

async function readImageObject(
  store: PdfObjectStore,
  id: string,
  ref: PdfReference,
  includeBytes: boolean,
): Promise<PdfImageResource | undefined> {
  const object = await store.get(ref);
  if (object?.stream === undefined || object.value.kind !== "dictionary") {
    return undefined;
  }
  const base = readImageProperties(id, object.value, ref);
  accountForPixels(store, base);
  if (!includeBytes) {
    return base;
  }
  if (base.mediaType !== undefined) {
    const bytes = await store.encodedStream(ref);
    return bytes === undefined ? base : { ...base, bytes: Uint8Array.from(bytes) };
  }
  const decoded = await store.decodeStream(ref);
  return decoded === undefined ? base : {
    ...base,
    bytes: Uint8Array.from(decoded.bytes),
    decoded: decoded.decoded,
  };
}

async function readInlineImage(
  store: PdfObjectStore,
  id: string,
  image: PdfInlineImage,
  includeBytes: boolean,
): Promise<PdfImageResource> {
  const base = readImageProperties(id, image.dictionary);
  accountForPixels(store, base);
  if (!includeBytes) {
    return base;
  }
  if (base.mediaType !== undefined) {
    return { ...base, bytes: Uint8Array.from(image.bytes) };
  }
  const filter = dictionaryValue(image.dictionary, "Filter", "F");
  const decodeParameters = dictionaryValue(image.dictionary, "DecodeParms", "DP");
  const decoded = await decodePdfStreamBytes(
    image.bytes,
    filter === undefined ? undefined : formatPdfValue(filter),
    decodeParameters === undefined ? undefined : formatPdfValue(decodeParameters),
  );
  if (decoded.decodedBytes === undefined) {
    return { ...base, bytes: Uint8Array.from(image.bytes) };
  }
  store.budget.decodedBytes(decoded.decodedBytes.byteLength);
  return { ...base, bytes: decoded.decodedBytes, decoded: decoded.state === "decoded" };
}

function readImageProperties(
  id: string,
  dictionary: PdfDictionaryValue,
  objectRef?: PdfReference,
): PdfImageResource {
  const width = pdfAsInteger(dictionaryValue(dictionary, "Width", "W"));
  const height = pdfAsInteger(dictionaryValue(dictionary, "Height", "H"));
  const bitsPerComponent = pdfAsInteger(dictionaryValue(dictionary, "BitsPerComponent", "BPC"));
  const colorSpaceValue = dictionaryValue(dictionary, "ColorSpace", "CS");
  const decode = numericValues(dictionaryValue(dictionary, "Decode", "D"));
  const imageMask = booleanValue(dictionaryValue(dictionary, "ImageMask", "IM")) ?? false;
  const interpolate = booleanValue(dictionaryValue(dictionary, "Interpolate", "I")) ?? false;
  const intentValue = pdfDictionaryGet(dictionary, "Intent");
  const renderingIntent = intentValue?.kind === "name" ? intentValue.value : undefined;
  const maskRef = pdfAsReference(pdfDictionaryGet(dictionary, "Mask"));
  const softMaskRef = pdfAsReference(pdfDictionaryGet(dictionary, "SMask"));
  const filters = filterNames(dictionaryValue(dictionary, "Filter", "F"));
  const mediaType = mediaTypeForFilters(filters);
  return {
    id,
    ...(objectRef !== undefined ? { objectRef } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(bitsPerComponent !== undefined ? { bitsPerComponent } : {}),
    ...(colorSpaceValue !== undefined ? { colorSpace: formatPdfValue(colorSpaceValue) } : {}),
    ...(decode.length > 0 ? { decode } : {}),
    imageMask,
    interpolate,
    ...(renderingIntent !== undefined ? { renderingIntent } : {}),
    ...(maskRef !== undefined ? { maskRef } : {}),
    ...(softMaskRef !== undefined ? { softMaskRef } : {}),
    filters,
    ...(mediaType !== undefined ? { mediaType } : {}),
    decoded: false,
  };
}

function numericValues(value: PdfValue | undefined): readonly number[] {
  return value?.kind === "array"
    ? value.items.flatMap((item) => {
        const number = pdfAsNumber(item);
        return number === undefined ? [] : [number];
      })
    : [];
}

function accountForPixels(store: PdfObjectStore, resource: PdfImageResource): void {
  if (resource.width !== undefined && resource.height !== undefined) {
    store.budget.imagePixels(resource.width * resource.height, resource.id);
  }
}

function dictionaryValue(
  dictionary: PdfDictionaryValue,
  fullName: string,
  abbreviation: string,
): PdfValue | undefined {
  return pdfDictionaryGet(dictionary, fullName) ?? pdfDictionaryGet(dictionary, abbreviation);
}

function booleanValue(value: PdfValue | undefined): boolean | undefined {
  return value?.kind === "boolean" ? value.value : undefined;
}

function filterNames(value: PdfValue | undefined): readonly string[] {
  if (value?.kind === "name") {
    return [expandFilterName(value.value)];
  }
  if (value?.kind === "array") {
    return value.items.flatMap((item) => item.kind === "name" ? [expandFilterName(item.value)] : []);
  }
  return [];
}

function expandFilterName(name: string): string {
  switch (name) {
    case "DCT": return "DCTDecode";
    case "JPX": return "JPXDecode";
    case "JBIG2": return "JBIG2Decode";
    case "CCF": return "CCITTFaxDecode";
    case "Fl": return "FlateDecode";
    case "LZW": return "LZWDecode";
    case "RL": return "RunLengthDecode";
    case "A85": return "ASCII85Decode";
    case "AHx": return "ASCIIHexDecode";
    default: return name;
  }
}

function mediaTypeForFilters(filters: readonly string[]): string | undefined {
  if (filters.includes("DCTDecode")) return "image/jpeg";
  if (filters.includes("JPXDecode")) return "image/jp2";
  if (filters.includes("JBIG2Decode")) return "image/jbig2";
  return undefined;
}

function imageResourceId(ref: PdfReference): string {
  return `image-${pdfReferenceKey(ref).replace(":", "-")}`;
}

function numberMatrix(values: readonly PdfValue[]): Matrix | undefined {
  if (values.length !== 6) {
    return undefined;
  }
  const numbers = values.map(pdfAsNumber);
  if (numbers.some((value) => value === undefined)) {
    return undefined;
  }
  const [a, b, c, d, e, f] = numbers;
  return a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || f === undefined
    ? undefined
    : [a, b, c, d, e, f];
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[1] * right[2],
    left[0] * right[1] + left[1] * right[3],
    left[2] * right[0] + left[3] * right[2],
    left[2] * right[1] + left[3] * right[3],
    left[4] * right[0] + left[5] * right[2] + right[4],
    left[4] * right[1] + left[5] * right[3] + right[5],
  ];
}

function pageDisplayMatrix(page: PdfDocumentModel["pages"][number]): Matrix {
  const box = page.cropBox ?? page.mediaBox;
  if (box === undefined || page.rotate === 0) {
    return [1, 0, 0, 1, 0, 0];
  }
  switch (page.rotate) {
    case 90:
      return [0, -1, 1, 0, -box.y, box.width + box.x];
    case 180:
      return [-1, 0, 0, -1, box.width + box.x, box.height + box.y];
    case 270:
      return [0, 1, -1, 0, box.height + box.y, -box.x];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

function matrixBounds(matrix: Matrix): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const points = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
  const transformed = points.map(([x, y]) => ({
    x: x * matrix[0] + y * matrix[2] + matrix[4],
    y: x * matrix[1] + y * matrix[3] + matrix[5],
  }));
  const xs = transformed.map((point) => point.x);
  const ys = transformed.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function selectPages(selection: PdfPageSelection | undefined, pageCount: number): ReadonlySet<number> {
  if (selection === undefined || selection.kind === "all") {
    return new Set(Array.from({ length: pageCount }, (_, index) => index + 1));
  }
  if (selection.kind === "range") {
    return new Set(Array.from({ length: selection.to - selection.from + 1 }, (_, index) => selection.from + index));
  }
  return new Set(selection.pages);
}
