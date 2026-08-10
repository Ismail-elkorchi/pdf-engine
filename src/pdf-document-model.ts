import { PdfSyntaxError } from "./pdf-syntax.ts";
import {
  type PdfArrayValue,
  type PdfDictionaryValue,
  type PdfReference,
  type PdfValue,
  pdfAsArray,
  pdfAsInteger,
  pdfAsNumber,
  pdfAsReference,
  pdfDictionaryGet,
  pdfReferenceKey,
} from "./pdf-values.ts";

import type { PdfBoundingBox } from "./contracts.ts";
import type { PdfObjectStore } from "./pdf-object-store.ts";

export interface PdfPageModel {
  readonly pageNumber: number;
  readonly ref: PdfReference;
  readonly dictionary: PdfDictionaryValue;
  readonly contents: readonly PdfReference[];
  readonly annotations: readonly PdfReference[];
  readonly resources?: PdfDictionaryValue;
  readonly mediaBox?: PdfBoundingBox;
  readonly cropBox?: PdfBoundingBox;
  readonly rotate: number;
}

export interface PdfDocumentModel {
  readonly catalog: PdfDictionaryValue;
  readonly pages: readonly PdfPageModel[];
  readonly pageNumberByRef: ReadonlyMap<string, number>;
  readonly repaired: boolean;
}

interface InheritedPageValues {
  readonly resources?: PdfDictionaryValue;
  readonly mediaBox?: PdfBoundingBox;
  readonly cropBox?: PdfBoundingBox;
  readonly rotate: number;
}

export async function buildPdfDocumentModel(
  store: PdfObjectStore,
  repairMode: "strict" | "safe" = "strict",
): Promise<PdfDocumentModel> {
  const catalogObject = await store.require(store.root);
  if (catalogObject.value.kind !== "dictionary") {
    throw new PdfSyntaxError("Catalog object is not a dictionary", catalogObject.source.start);
  }
  const pagesRef = pdfAsReference(pdfDictionaryGet(catalogObject.value, "Pages"));
  if (pagesRef === undefined) {
    throw new PdfSyntaxError("Catalog has no page tree", catalogObject.source.start);
  }
  const pages: PdfPageModel[] = [];
  const active = new Set<string>();
  const repair = { occurred: false };
  await visitPageTree(store, pagesRef, emptyInheritedPageValues(), pages, active, 0, repairMode, repair);
  const pageNumberByRef = new Map(pages.map((page) => [pdfReferenceKey(page.ref), page.pageNumber] as const));
  return { catalog: catalogObject.value, pages, pageNumberByRef, repaired: repair.occurred };
}

async function visitPageTree(
  store: PdfObjectStore,
  ref: PdfReference,
  inherited: InheritedPageValues,
  pages: PdfPageModel[],
  active: Set<string>,
  depth: number,
  repairMode: "strict" | "safe",
  repair: { occurred: boolean },
): Promise<void> {
  store.budget.depth(depth);
  const key = pdfReferenceKey(ref);
  if (active.has(key)) {
    if (repairMode === "safe") {
      repair.occurred = true;
      return;
    }
    throw new PdfSyntaxError("Page tree contains a cycle", 0);
  }
  active.add(key);
  try {
    const object = await store.require(ref);
    if (object.value.kind !== "dictionary") {
      throw new PdfSyntaxError("Page tree node is not a dictionary", object.source.start);
    }
    const type = await resolvedName(store, pdfDictionaryGet(object.value, "Type"));
    const nextInherited = await inheritPageValues(store, object.value, inherited);
    if (type === "Page") {
      store.budget.page();
      pages.push({
        pageNumber: pages.length + 1,
        ref,
        dictionary: object.value,
        contents: await resolveReferenceArray(store, pdfDictionaryGet(object.value, "Contents")),
        annotations: await resolveReferenceArray(store, pdfDictionaryGet(object.value, "Annots")),
        ...(nextInherited.resources !== undefined ? { resources: nextInherited.resources } : {}),
        ...(nextInherited.mediaBox !== undefined ? { mediaBox: nextInherited.mediaBox } : {}),
        ...(nextInherited.cropBox !== undefined ? { cropBox: nextInherited.cropBox } : {}),
        rotate: normalizeRotation(nextInherited.rotate),
      });
      return;
    }
    const kids = pdfAsArray(await store.resolve(pdfDictionaryGet(object.value, "Kids")));
    if (kids === undefined) {
      throw new PdfSyntaxError("Pages node has no Kids array", object.source.start);
    }
    for (const kid of kids.items) {
      const kidRef = pdfAsReference(kid);
      if (kidRef === undefined) {
        throw new PdfSyntaxError("Page tree kid is not an indirect reference", kid.source.start);
      }
      await visitPageTree(store, kidRef, nextInherited, pages, active, depth + 1, repairMode, repair);
    }
  } finally {
    active.delete(key);
  }
}

async function inheritPageValues(
  store: PdfObjectStore,
  dictionary: PdfDictionaryValue,
  inherited: InheritedPageValues,
): Promise<InheritedPageValues> {
  const resourcesValue = pdfDictionaryGet(dictionary, "Resources");
  const resources = resourcesValue === undefined ? inherited.resources : await store.resolveDictionary(resourcesValue);
  const mediaBoxValue = pdfDictionaryGet(dictionary, "MediaBox");
  const cropBoxValue = pdfDictionaryGet(dictionary, "CropBox");
  const rotateValue = await store.resolve(pdfDictionaryGet(dictionary, "Rotate"));
  const mediaBox = mediaBoxValue === undefined ? inherited.mediaBox : readBox(await store.resolve(mediaBoxValue));
  const cropBox = cropBoxValue === undefined ? inherited.cropBox : readBox(await store.resolve(cropBoxValue));
  return {
    ...(resources !== undefined ? { resources } : {}),
    ...(mediaBox !== undefined ? { mediaBox } : {}),
    ...(cropBox !== undefined ? { cropBox } : {}),
    rotate: pdfAsInteger(rotateValue) ?? inherited.rotate,
  };
}

export async function resolveReferenceArray(
  store: PdfObjectStore,
  value: PdfValue | undefined,
): Promise<readonly PdfReference[]> {
  if (value === undefined) {
    return [];
  }
  const direct = pdfAsReference(value);
  if (direct !== undefined) {
    const object = await store.get(direct);
    if (object?.value.kind === "array") {
      return referencesFromArray(object.value);
    }
    return [direct];
  }
  const array = pdfAsArray(await store.resolve(value));
  return array === undefined ? [] : referencesFromArray(array);
}

export function readPdfString(value: PdfValue | undefined): string | undefined {
  if (value?.kind !== "string") {
    return undefined;
  }
  const bytes = value.bytes;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16(bytes.subarray(2), false);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeUtf16(bytes.subarray(2), true);
  }
  let text = "";
  for (const byte of bytes) {
    text += PDF_DOC_ENCODING[byte] ?? String.fromCharCode(byte);
  }
  return text;
}

export function readBox(value: PdfValue | undefined): PdfBoundingBox | undefined {
  const array = pdfAsArray(value);
  if (array === undefined || array.items.length < 4) {
    return undefined;
  }
  const x1 = pdfAsNumber(array.items[0]);
  const y1 = pdfAsNumber(array.items[1]);
  const x2 = pdfAsNumber(array.items[2]);
  const y2 = pdfAsNumber(array.items[3]);
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    return undefined;
  }
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export async function resolvedName(store: PdfObjectStore, value: PdfValue | undefined): Promise<string | undefined> {
  const resolved = await store.resolve(value);
  return resolved?.kind === "name" ? resolved.value : undefined;
}

function referencesFromArray(array: PdfArrayValue): readonly PdfReference[] {
  const refs: PdfReference[] = [];
  for (const item of array.items) {
    const ref = pdfAsReference(item);
    if (ref !== undefined) {
      refs.push(ref);
    }
  }
  return refs;
}

function emptyInheritedPageValues(): InheritedPageValues {
  return { rotate: 0 };
}

function normalizeRotation(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let text = "";
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const codeUnit = littleEndian
      ? (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
      : ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    text += String.fromCharCode(codeUnit);
  }
  return text;
}

const PDF_DOC_ENCODING: Readonly<Record<number, string>> = {
  0x18: "˘", 0x19: "ˇ", 0x1a: "ˆ", 0x1b: "˙", 0x1c: "˝", 0x1d: "˛", 0x1e: "˚", 0x1f: "˜",
  0x80: "•", 0x81: "†", 0x82: "‡", 0x83: "…", 0x84: "—", 0x85: "–", 0x86: "ƒ", 0x87: "⁄",
  0x88: "‹", 0x89: "›", 0x8a: "−", 0x8b: "‰", 0x8c: "„", 0x8d: "“", 0x8e: "”", 0x8f: "‘",
  0x90: "’", 0x91: "‚", 0x92: "™", 0x93: "ﬁ", 0x94: "ﬂ", 0x95: "Ł", 0x96: "Œ", 0x97: "Š",
  0x98: "Ÿ", 0x99: "Ž", 0x9a: "ı", 0x9b: "ł", 0x9c: "œ", 0x9d: "š", 0x9e: "ž", 0xa0: "€",
};
