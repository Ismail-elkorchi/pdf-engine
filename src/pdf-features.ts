import {
  readBox,
  readPdfString,
  resolveReferenceArray,
  type PdfDocumentModel,
} from "./pdf-document-model.ts";
import {
  type PdfArrayValue,
  type PdfDictionaryValue,
  type PdfReference,
  type PdfValue,
  pdfAsArray,
  pdfAsInteger,
  pdfAsName,
  pdfAsNumber,
  pdfAsReference,
  pdfDictionaryGet,
  pdfReferenceKey,
} from "./pdf-values.ts";

import type { PdfFeatureFinding } from "./contracts.ts";
import type { PdfObjectStore } from "./pdf-object-store.ts";
import type {
  PdfActiveContent,
  PdfAnnotation,
  PdfAttachment,
  PdfDestination,
  PdfDocumentFeatures,
  PdfFormField,
  PdfMetadata,
  PdfNamedDestination,
  PdfNormalizedPolicy,
  PdfOptionalContentGroup,
  PdfOutlineItem,
  PdfPageLabel,
  PdfSignature,
  PdfStructureElement,
} from "./public-api.ts";


export async function extractPdfFeatures(
  store: PdfObjectStore,
  model: PdfDocumentModel,
  policy: PdfNormalizedPolicy,
): Promise<PdfDocumentFeatures> {
  const metadata = await collectMetadata(store, model.catalog);
  const namedDestinations = await collectNamedDestinations(store, model.catalog, model);
  const pageLabels = await collectPageLabels(store, model.catalog, model.pages.length);
  const structureTree = await collectStructureTree(store, model.catalog, model);
  const annotations = await collectAnnotations(store, model);
  const outlines = await collectOutlines(store, model.catalog, model);
  const formFields = await collectFormFields(store, model.catalog);
  const attachments = await collectAttachments(store, model.catalog);
  const signatures = await collectSignatures(store, formFields);
  const optionalContentGroups = await collectOptionalContentGroups(store, model.catalog);
  const activeContent = await collectActiveContent(store, model);
  const findings = await buildFindings(store, model, policy, {
    annotations,
    outlines,
    formFields,
    attachments,
    signatures,
    optionalContentGroups,
    activeContent,
  });
  return {
    findings,
    metadata,
    namedDestinations,
    pageLabels,
    structureTree,
    outlines,
    annotations,
    formFields,
    attachments,
    signatures,
    optionalContentGroups,
    activeContent,
  };
}

export async function extractPdfAdmissionFindings(
  store: PdfObjectStore,
  model: PdfDocumentModel,
  policy: PdfNormalizedPolicy,
): Promise<readonly PdfFeatureFinding[]> {
  const activeContent = await collectActiveContent(store, model);
  const attachments = policy.embeddedFiles === "deny"
    ? await collectAttachments(store, model.catalog)
    : [];
  const findings: PdfFeatureFinding[] = [];
  for (const item of activeContent) {
    if (item.kind !== "javascript" && item.kind !== "launch") {
      continue;
    }
    const javascript = item.kind === "javascript";
    findings.push({
      kind: javascript ? "javascript-actions" : "launch-actions",
      action: javascript ? policy.javascriptActions : policy.launchActions,
      evidenceSource: "object",
      ...(item.objectRef !== undefined ? { objectRef: item.objectRef, actionRef: item.objectRef } : {}),
      actionName: javascript ? "JavaScript" : "Launch",
      message: `${javascript ? "JavaScript" : "Launch"} action is present and will not be executed.`,
    });
  }
  for (const attachment of attachments) {
    findings.push({
      kind: "embedded-files",
      action: policy.embeddedFiles,
      evidenceSource: "object",
      objectRef: attachment.objectRef,
      embeddedFileRef: attachment.objectRef,
      message: "An embedded file is present and requires explicit extraction.",
    });
  }
  return findings;
}

async function collectMetadata(
  store: PdfObjectStore,
  catalog: PdfDictionaryValue,
): Promise<PdfMetadata> {
  const info = await store.resolveDictionary(pdfDictionaryGet(store.trailer, "Info"));
  const standardKeys = new Set(["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Trapped"]);
  const customEntries: [string, string][] = [];
  for (const entry of info?.entries ?? []) {
    if (standardKeys.has(entry.key.value)) {
      continue;
    }
    const value = readMetadataValue(await store.resolve(entry.value));
    if (value !== undefined) {
      customEntries.push([entry.key.value, value]);
    }
  }
  customEntries.sort(([left], [right]) => left.localeCompare(right));
  const metadataRef = pdfAsReference(pdfDictionaryGet(catalog, "Metadata"));
  const metadataBytes = metadataRef === undefined ? undefined : await decodeOptionalStream(store, metadataRef);
  const read = async (key: string): Promise<string | undefined> =>
    info === undefined ? undefined : readMetadataValue(await store.resolve(pdfDictionaryGet(info, key)));
  const title = await read("Title");
  const author = await read("Author");
  const subject = await read("Subject");
  const keywords = await read("Keywords");
  const creator = await read("Creator");
  const producer = await read("Producer");
  const creationDate = await read("CreationDate");
  const modificationDate = await read("ModDate");
  const trapped = await read("Trapped");
  return {
    ...(title !== undefined ? { title } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(producer !== undefined ? { producer } : {}),
    ...(creationDate !== undefined ? { creationDate } : {}),
    ...(modificationDate !== undefined ? { modificationDate } : {}),
    ...(trapped !== undefined ? { trapped } : {}),
    custom: Object.fromEntries(customEntries),
    ...(metadataRef !== undefined && metadataBytes !== undefined ? {
      xmp: {
        objectRef: metadataRef,
        bytes: Uint8Array.from(metadataBytes.bytes),
        text: new TextDecoder().decode(metadataBytes.bytes),
        mediaType: "application/rdf+xml" as const,
      },
    } : {}),
  };
}

async function decodeOptionalStream(store: PdfObjectStore, ref: PdfReference) {
  try {
    return await store.decodeStream(ref);
  } catch {
    return undefined;
  }
}

function readMetadataValue(value: PdfValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readPdfString(value) ?? pdfAsName(value) ??
    (value.kind === "integer" || value.kind === "real" ? String(value.value) : undefined);
}

async function collectNamedDestinations(
  store: PdfObjectStore,
  catalog: PdfDictionaryValue,
  model: PdfDocumentModel,
): Promise<readonly PdfNamedDestination[]> {
  const values = new Map<string, PdfValue>();
  const names = await store.resolveDictionary(pdfDictionaryGet(catalog, "Names"));
  const destinationTree = names === undefined
    ? undefined
    : await store.resolveDictionary(pdfDictionaryGet(names, "Dests"));
  if (destinationTree !== undefined) {
    for (const pair of await collectNameTreePairs(store, destinationTree, new Set(), 0)) {
      values.set(pair.name, pair.value);
    }
  }
  const legacy = await store.resolveDictionary(pdfDictionaryGet(catalog, "Dests"));
  for (const entry of legacy?.entries ?? []) {
    values.set(entry.key.value, entry.value);
  }
  const destinations: PdfNamedDestination[] = [];
  for (const [name, value] of [...values].toSorted(([left], [right]) => left.localeCompare(right))) {
    const destination = await readDestination(store, value, model);
    if (destination !== undefined) {
      destinations.push({ name, destination });
    }
  }
  return destinations;
}

async function collectPageLabels(
  store: PdfObjectStore,
  catalog: PdfDictionaryValue,
  pageCount: number,
): Promise<readonly PdfPageLabel[]> {
  const root = await store.resolveDictionary(pdfDictionaryGet(catalog, "PageLabels"));
  if (root === undefined) {
    return Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      label: String(index + 1),
      style: "decimal" as const,
      sequenceNumber: index + 1,
    }));
  }
  const ranges = (await collectNumberTreePairs(store, root, new Set(), 0))
    .toSorted((left, right) => left.index - right.index);
  const labels: PdfPageLabel[] = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const range = ranges.findLast((candidate) => candidate.index <= pageIndex);
    const dictionary = range === undefined ? undefined : await store.resolveDictionary(range.value);
    const prefix = readPdfString(dictionary === undefined ? undefined : await store.resolve(pdfDictionaryGet(dictionary, "P")));
    const styleName = pdfAsName(dictionary === undefined ? undefined : await store.resolve(pdfDictionaryGet(dictionary, "S")));
    const style = dictionary === undefined ? "decimal" : pageLabelStyle(styleName);
    const start = dictionary === undefined ? 1 : pdfAsInteger(await store.resolve(pdfDictionaryGet(dictionary, "St"))) ?? 1;
    const sequenceNumber = start + pageIndex - (range?.index ?? 0);
    const numberText = style === undefined ? "" : formatPageLabelNumber(sequenceNumber, style);
    labels.push({
      pageNumber: pageIndex + 1,
      label: `${prefix ?? ""}${numberText}`,
      ...(prefix !== undefined ? { prefix } : {}),
      ...(style !== undefined ? { style } : {}),
      sequenceNumber,
    });
  }
  return labels;
}

async function collectNumberTreePairs(
  store: PdfObjectStore,
  dictionary: PdfDictionaryValue,
  active: Set<string>,
  depth: number,
): Promise<readonly { readonly index: number; readonly value: PdfValue }[]> {
  store.budget.depth(depth);
  const pairs: { index: number; value: PdfValue }[] = [];
  const numbers = pdfAsArray(await store.resolve(pdfDictionaryGet(dictionary, "Nums")));
  if (numbers !== undefined) {
    for (let index = 0; index + 1 < numbers.items.length; index += 2) {
      const key = pdfAsInteger(numbers.items[index]);
      const value = numbers.items[index + 1];
      if (key !== undefined && value !== undefined) {
        pairs.push({ index: key, value });
      }
    }
  }
  for (const kid of await resolveReferenceArray(store, pdfDictionaryGet(dictionary, "Kids"))) {
    const key = pdfReferenceKey(kid);
    if (active.has(key)) {
      continue;
    }
    active.add(key);
    const child = await store.resolveDictionary({ kind: "reference", value: kid, source: { start: 0, end: 0 } });
    if (child !== undefined) {
      pairs.push(...await collectNumberTreePairs(store, child, active, depth + 1));
    }
    active.delete(key);
  }
  return pairs;
}

async function collectStructureTree(
  store: PdfObjectStore,
  catalog: PdfDictionaryValue,
  model: PdfDocumentModel,
): Promise<readonly PdfStructureElement[]> {
  const root = await store.resolveDictionary(pdfDictionaryGet(catalog, "StructTreeRoot"));
  if (root === undefined) {
    return [];
  }
  return readStructureValue(
    store,
    pdfDictionaryGet(root, "K"),
    model,
    undefined,
    new Set(),
    0,
    "root",
  );
}

async function readStructureValue(
  store: PdfObjectStore,
  value: PdfValue | undefined,
  model: PdfDocumentModel,
  inheritedPageRef: PdfReference | undefined,
  active: Set<string>,
  depth: number,
  path: string,
): Promise<readonly PdfStructureElement[]> {
  store.budget.depth(depth);
  if (value === undefined) {
    return [];
  }
  if (value.kind === "array") {
    const children: PdfStructureElement[] = [];
    for (const [index, item] of value.items.entries()) {
      children.push(...await readStructureValue(store, item, model, inheritedPageRef, active, depth + 1, `${path}-${String(index)}`));
    }
    return children;
  }
  if (value.kind === "integer") {
    const pageNumber = inheritedPageRef === undefined
      ? undefined
      : model.pageNumberByRef.get(pdfReferenceKey(inheritedPageRef));
    return [{
      id: `structure-content-${path}`,
      role: "MarkedContent",
      ...(pageNumber !== undefined ? { pageNumber } : {}),
      markedContentId: value.value,
      children: [],
    }];
  }
  const objectRef = pdfAsReference(value);
  const key = objectRef === undefined ? undefined : pdfReferenceKey(objectRef);
  if (key !== undefined && active.has(key)) {
    return [];
  }
  if (key !== undefined) {
    active.add(key);
  }
  try {
    const dictionary = objectRef === undefined
      ? (value.kind === "dictionary" ? value : undefined)
      : await store.resolveDictionary(value);
    if (dictionary === undefined) {
      return [];
    }
    const pageRef = pdfAsReference(pdfDictionaryGet(dictionary, "Pg")) ?? inheritedPageRef;
    const pageNumber = pageRef === undefined ? undefined : model.pageNumberByRef.get(pdfReferenceKey(pageRef));
    const type = pdfAsName(pdfDictionaryGet(dictionary, "Type"));
    const role = pdfAsName(pdfDictionaryGet(dictionary, "S")) ??
      (type === "MCR" ? "MarkedContent" : type === "OBJR" ? "ObjectReference" : "StructureElement");
    const markedContentId = pdfAsInteger(pdfDictionaryGet(dictionary, "MCID"));
    const title = readPdfString(await store.resolve(pdfDictionaryGet(dictionary, "T")));
    const language = readPdfString(await store.resolve(pdfDictionaryGet(dictionary, "Lang")));
    const alternateText = readPdfString(await store.resolve(pdfDictionaryGet(dictionary, "Alt")));
    const actualText = readPdfString(await store.resolve(pdfDictionaryGet(dictionary, "ActualText")));
    const children = await readStructureValue(
      store,
      pdfDictionaryGet(dictionary, "K"),
      model,
      pageRef,
      active,
      depth + 1,
      path,
    );
    return [{
      id: objectRef === undefined
        ? `structure-${path}`
        : `structure-${String(objectRef.objectNumber)}-${String(objectRef.generationNumber)}`,
      role,
      ...(objectRef !== undefined ? { objectRef } : {}),
      ...(pageNumber !== undefined ? { pageNumber } : {}),
      ...(markedContentId !== undefined ? { markedContentId } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(alternateText !== undefined ? { alternateText } : {}),
      ...(actualText !== undefined ? { actualText } : {}),
      children,
    }];
  } finally {
    if (key !== undefined) {
      active.delete(key);
    }
  }
}

function pageLabelStyle(name: string | undefined): PdfPageLabel["style"] {
  switch (name) {
    case undefined: return undefined;
    case "D": return "decimal";
    case "R": return "roman-upper";
    case "r": return "roman-lower";
    case "A": return "letters-upper";
    case "a": return "letters-lower";
    default: return undefined;
  }
}

function formatPageLabelNumber(value: number, style: NonNullable<PdfPageLabel["style"]>): string {
  switch (style) {
    case "decimal": return String(value);
    case "roman-upper": return romanNumber(value);
    case "roman-lower": return romanNumber(value).toLocaleLowerCase("und");
    case "letters-upper": return letterNumber(value);
    case "letters-lower": return letterNumber(value).toLocaleLowerCase("und");
  }
}

function romanNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return "";
  }
  const numerals = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]] as const;
  let remaining = value;
  let text = "";
  for (const [amount, numeral] of numerals) {
    while (remaining >= amount) {
      text += numeral;
      remaining -= amount;
    }
  }
  return text;
}

function letterNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return "";
  }
  const letter = String.fromCharCode(0x41 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

async function collectAnnotations(store: PdfObjectStore, model: PdfDocumentModel): Promise<readonly PdfAnnotation[]> {
  const annotations: PdfAnnotation[] = [];
  for (const page of model.pages) {
    for (const ref of page.annotations) {
      const object = await store.get(ref);
      if (object?.value.kind !== "dictionary") {
        continue;
      }
      const subtype = pdfAsName(await store.resolve(pdfDictionaryGet(object.value, "Subtype"))) ?? "Unknown";
      const action = await store.resolveDictionary(pdfDictionaryGet(object.value, "A"));
      const uri = readPdfString(action === undefined ? undefined : await store.resolve(pdfDictionaryGet(action, "URI")));
      const destination = await readDestination(store, pdfDictionaryGet(object.value, "Dest"), model);
      const bounds = readBox(await store.resolve(pdfDictionaryGet(object.value, "Rect")));
      const contents = readPdfString(await store.resolve(pdfDictionaryGet(object.value, "Contents")));
      annotations.push({
        id: `annotation-${String(ref.objectNumber)}-${String(ref.generationNumber)}`,
        subtype,
        pageNumber: page.pageNumber,
        objectRef: ref,
        ...(bounds !== undefined ? { bounds } : {}),
        ...(contents !== undefined ? { contents } : {}),
        ...(destination !== undefined ? { destination } : {}),
        ...(uri !== undefined ? { uri } : {}),
      });
    }
  }
  return annotations;
}

async function collectOutlines(
  store: PdfObjectStore,
  catalog: PdfDictionaryValue,
  model: PdfDocumentModel,
): Promise<readonly PdfOutlineItem[]> {
  const outlineRoot = await store.resolveDictionary(pdfDictionaryGet(catalog, "Outlines"));
  if (outlineRoot === undefined) {
    return [];
  }
  const first = pdfAsReference(pdfDictionaryGet(outlineRoot, "First"));
  return first === undefined ? [] : readOutlineChain(store, first, model, new Set(), 0);
}

async function readOutlineChain(
  store: PdfObjectStore,
  first: PdfReference,
  model: PdfDocumentModel,
  visited: Set<string>,
  depth: number,
): Promise<readonly PdfOutlineItem[]> {
  store.budget.depth(depth);
  const items: PdfOutlineItem[] = [];
  let current: PdfReference | undefined = first;
  while (current !== undefined) {
    const key = pdfReferenceKey(current);
    if (visited.has(key)) {
      break;
    }
    visited.add(key);
    const object = await store.get(current);
    if (object?.value.kind !== "dictionary") {
      break;
    }
    const child = pdfAsReference(pdfDictionaryGet(object.value, "First"));
    const title = readPdfString(await store.resolve(pdfDictionaryGet(object.value, "Title"))) ?? "";
    const destination = await readDestination(store, pdfDictionaryGet(object.value, "Dest"), model);
    items.push({
      id: `outline-${String(current.objectNumber)}-${String(current.generationNumber)}`,
      title,
      objectRef: current,
      ...(destination !== undefined ? { destination } : {}),
      children: child === undefined ? [] : await readOutlineChain(store, child, model, visited, depth + 1),
    });
    current = pdfAsReference(pdfDictionaryGet(object.value, "Next"));
  }
  return items;
}

async function collectFormFields(store: PdfObjectStore, catalog: PdfDictionaryValue): Promise<readonly PdfFormField[]> {
  const form = await store.resolveDictionary(pdfDictionaryGet(catalog, "AcroForm"));
  const fields = form === undefined ? undefined : pdfAsArray(await store.resolve(pdfDictionaryGet(form, "Fields")));
  if (fields === undefined) {
    return [];
  }
  const result: PdfFormField[] = [];
  for (const field of fields.items) {
    const ref = pdfAsReference(field);
    if (ref !== undefined) {
      const parsed = await readFormField(store, ref, new Set(), 0);
      if (parsed !== undefined) {
        result.push(parsed);
      }
    }
  }
  return result;
}

async function readFormField(
  store: PdfObjectStore,
  ref: PdfReference,
  active: Set<string>,
  depth: number,
): Promise<PdfFormField | undefined> {
  store.budget.depth(depth);
  const key = pdfReferenceKey(ref);
  if (active.has(key)) {
    return undefined;
  }
  active.add(key);
  try {
    const object = await store.get(ref);
    if (object?.value.kind !== "dictionary") {
      return undefined;
    }
    const kids = await resolveReferenceArray(store, pdfDictionaryGet(object.value, "Kids"));
    const children: PdfFormField[] = [];
    for (const kid of kids) {
      const child = await readFormField(store, kid, active, depth + 1);
      if (child !== undefined) {
        children.push(child);
      }
    }
    const value = await readFieldValue(store, pdfDictionaryGet(object.value, "V"));
    const fieldType = pdfAsName(await store.resolve(pdfDictionaryGet(object.value, "FT")));
    const name = readPdfString(await store.resolve(pdfDictionaryGet(object.value, "T")));
    const alternateName = readPdfString(await store.resolve(pdfDictionaryGet(object.value, "TU")));
    return {
      id: `field-${String(ref.objectNumber)}-${String(ref.generationNumber)}`,
      objectRef: ref,
      ...(fieldType !== undefined ? { fieldType } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(alternateName !== undefined ? { alternateName } : {}),
      ...(value !== undefined ? { value } : {}),
      children,
    };
  } finally {
    active.delete(key);
  }
}

async function readFieldValue(
  store: PdfObjectStore,
  value: PdfValue | undefined,
): Promise<string | readonly string[] | undefined> {
  const resolved = await store.resolve(value);
  if (resolved === undefined) {
    return undefined;
  }
  const text = readPdfString(resolved) ?? pdfAsName(resolved);
  if (text !== undefined) {
    return text;
  }
  const array = pdfAsArray(resolved);
  if (array === undefined) {
    return undefined;
  }
  return array.items.flatMap((item) => {
    const itemValue = readPdfString(item) ?? pdfAsName(item);
    return itemValue === undefined ? [] : [itemValue];
  });
}

async function collectAttachments(store: PdfObjectStore, catalog: PdfDictionaryValue): Promise<readonly PdfAttachment[]> {
  const names = await store.resolveDictionary(pdfDictionaryGet(catalog, "Names"));
  const embeddedFiles = names === undefined ? undefined : await store.resolveDictionary(pdfDictionaryGet(names, "EmbeddedFiles"));
  if (embeddedFiles === undefined) {
    return [];
  }
  const pairs = await collectNameTreePairs(store, embeddedFiles, new Set(), 0);
  const attachments: PdfAttachment[] = [];
  for (const pair of pairs) {
    const fileSpec = await store.resolveDictionary(pair.value);
    if (fileSpec === undefined) {
      continue;
    }
    const embedded = await store.resolveDictionary(pdfDictionaryGet(fileSpec, "EF"));
    const streamRef = embedded === undefined
      ? undefined
      : pdfAsReference(pdfDictionaryGet(embedded, "UF")) ?? pdfAsReference(pdfDictionaryGet(embedded, "F"));
    if (streamRef === undefined) {
      continue;
    }
    const streamObject = await store.get(streamRef);
    const params = streamObject?.value.kind === "dictionary"
      ? await store.resolveDictionary(pdfDictionaryGet(streamObject.value, "Params"))
      : undefined;
    const name = readPdfString(await store.resolve(pdfDictionaryGet(fileSpec, "UF"))) ??
      readPdfString(await store.resolve(pdfDictionaryGet(fileSpec, "F"))) ?? pair.name;
    const description = readPdfString(await store.resolve(pdfDictionaryGet(fileSpec, "Desc")));
    const mediaType = streamObject?.value.kind === "dictionary"
      ? pdfAsName(pdfDictionaryGet(streamObject.value, "Subtype"))
      : undefined;
    const size = params === undefined ? undefined : pdfAsInteger(await store.resolve(pdfDictionaryGet(params, "Size")));
    attachments.push({
      id: `attachment-${String(streamRef.objectNumber)}-${String(streamRef.generationNumber)}`,
      name,
      objectRef: streamRef,
      ...(description !== undefined ? { description } : {}),
      ...(mediaType !== undefined ? { mediaType } : {}),
      ...(size !== undefined ? { size } : {}),
    });
  }
  return dedupeById(attachments);
}

async function collectNameTreePairs(
  store: PdfObjectStore,
  dictionary: PdfDictionaryValue,
  active: Set<string>,
  depth: number,
): Promise<readonly { readonly name: string; readonly value: PdfValue }[]> {
  store.budget.depth(depth);
  const names = pdfAsArray(await store.resolve(pdfDictionaryGet(dictionary, "Names")));
  const pairs: { readonly name: string; readonly value: PdfValue }[] = [];
  if (names !== undefined) {
    for (let index = 0; index + 1 < names.items.length; index += 2) {
      const name = readPdfString(names.items[index]);
      const value = names.items[index + 1];
      if (name !== undefined && value !== undefined) {
        pairs.push({ name, value });
      }
    }
  }
  const kids = await resolveReferenceArray(store, pdfDictionaryGet(dictionary, "Kids"));
  for (const kid of kids) {
    const key = pdfReferenceKey(kid);
    if (active.has(key)) {
      continue;
    }
    active.add(key);
    const child = await store.get(kid);
    if (child?.value.kind === "dictionary") {
      pairs.push(...await collectNameTreePairs(store, child.value, active, depth + 1));
    }
    active.delete(key);
  }
  return pairs;
}

async function collectSignatures(
  store: PdfObjectStore,
  fields: readonly PdfFormField[],
): Promise<readonly PdfSignature[]> {
  const signatures: PdfSignature[] = [];
  for (const field of flattenFields(fields)) {
    if (field.objectRef === undefined) {
      continue;
    }
    const fieldObject = await store.get(field.objectRef);
    if (fieldObject?.value.kind !== "dictionary") {
      continue;
    }
    const valueRef = pdfAsReference(pdfDictionaryGet(fieldObject.value, "V"));
    const value = await store.resolveDictionary(pdfDictionaryGet(fieldObject.value, "V"));
    if (value === undefined || (field.fieldType !== "Sig" && pdfAsName(pdfDictionaryGet(value, "Type")) !== "Sig")) {
      continue;
    }
    const signatureRef = valueRef ?? field.objectRef;
    const subFilter = pdfAsName(await store.resolve(pdfDictionaryGet(value, "SubFilter")));
    const signedAt = readPdfString(await store.resolve(pdfDictionaryGet(value, "M")));
    const signerName = readPdfString(await store.resolve(pdfDictionaryGet(value, "Name")));
    signatures.push({
      id: `signature-${String(signatureRef.objectNumber)}-${String(signatureRef.generationNumber)}`,
      objectRef: signatureRef,
      ...(field.name !== undefined ? { fieldName: field.name } : {}),
      ...(subFilter !== undefined ? { subFilter } : {}),
      byteRange: numericArray(pdfAsArray(await store.resolve(pdfDictionaryGet(value, "ByteRange")))),
      ...(signedAt !== undefined ? { signedAt } : {}),
      ...(signerName !== undefined ? { signerName } : {}),
    });
  }
  return signatures;
}

async function collectOptionalContentGroups(
  store: PdfObjectStore,
  catalog: PdfDictionaryValue,
): Promise<readonly PdfOptionalContentGroup[]> {
  const properties = await store.resolveDictionary(pdfDictionaryGet(catalog, "OCProperties"));
  if (properties === undefined) {
    return [];
  }
  const refs = await resolveReferenceArray(store, pdfDictionaryGet(properties, "OCGs"));
  const defaults = await store.resolveDictionary(pdfDictionaryGet(properties, "D"));
  const on = new Set((await resolveReferenceArray(store, defaults === undefined ? undefined : pdfDictionaryGet(defaults, "ON"))).map(pdfReferenceKey));
  const off = new Set((await resolveReferenceArray(store, defaults === undefined ? undefined : pdfDictionaryGet(defaults, "OFF"))).map(pdfReferenceKey));
  const groups: PdfOptionalContentGroup[] = [];
  for (const ref of refs) {
    const dictionary = await store.resolveDictionary({ kind: "reference", value: ref, source: { start: 0, end: 0 } });
    const name = dictionary === undefined ? undefined : readPdfString(await store.resolve(pdfDictionaryGet(dictionary, "Name")));
    groups.push({
      id: `optional-content-${String(ref.objectNumber)}-${String(ref.generationNumber)}`,
      objectRef: ref,
      ...(name !== undefined ? { name } : {}),
      defaultState: on.has(pdfReferenceKey(ref)) ? "on" : off.has(pdfReferenceKey(ref)) ? "off" : "unknown",
    });
  }
  return groups;
}

async function collectActiveContent(
  store: PdfObjectStore,
  model: PdfDocumentModel,
): Promise<readonly PdfActiveContent[]> {
  const active: PdfActiveContent[] = [];
  const visited = new Set<string>();
  const roots: PdfValue[] = [];
  const addRoot = (value: PdfValue | undefined): void => {
    if (value !== undefined) {
      roots.push(value);
    }
  };
  addRoot(pdfDictionaryGet(model.catalog, "OpenAction"));
  addRoot(pdfDictionaryGet(model.catalog, "AA"));
  addRoot(pdfDictionaryGet(model.catalog, "Outlines"));
  addRoot(pdfDictionaryGet(model.catalog, "AcroForm"));
  const names = await store.resolveDictionary(pdfDictionaryGet(model.catalog, "Names"));
  addRoot(names === undefined ? undefined : pdfDictionaryGet(names, "JavaScript"));
  for (const page of model.pages) {
    addRoot(pdfDictionaryGet(page.dictionary, "AA"));
    page.annotations.forEach((ref) => roots.push(referenceValue(ref)));
  }

  const visit = async (
    value: PdfValue,
    objectRef: PdfReference | undefined,
    path: readonly number[],
  ): Promise<void> => {
    if (value.kind === "reference") {
      const key = pdfReferenceKey(value.value);
      if (visited.has(key)) {
        return;
      }
      visited.add(key);
      const object = await store.get(value.value);
      if (object !== undefined) {
        await visit(object.value, object.ref, []);
      }
      return;
    }
    if (value.kind === "array") {
      for (const [index, item] of value.items.entries()) {
        await visit(item, objectRef, [...path, index]);
      }
      return;
    }
    if (value.kind !== "dictionary") {
      return;
    }

    const actionName = pdfAsName(await store.resolve(pdfDictionaryGet(value, "S")));
    const subtype = pdfAsName(await store.resolve(pdfDictionaryGet(value, "Subtype")));
    const kind = classifyActiveContent(actionName, subtype);
    if (kind !== undefined) {
      const payloadSource = pdfDictionaryGet(value, "JS");
      const payloadRef = pdfAsReference(payloadSource);
      const payloadValue = await store.resolve(payloadSource);
      const payloadStream = payloadRef === undefined ? undefined : await decodeOptionalStream(store, payloadRef);
      const payload = payloadValue?.kind === "string" ? payloadValue.bytes : payloadStream?.bytes;
      const pathSuffix = path.length === 0 ? "root" : path.map(String).join("-");
      const idSuffix = objectRef === undefined
        ? `direct-${pathSuffix}`
        : `${String(objectRef.objectNumber)}-${String(objectRef.generationNumber)}-${pathSuffix}`;
      active.push({
        id: `active-${idSuffix}`,
        kind,
        ...(objectRef !== undefined ? { objectRef } : {}),
        ...(payload !== undefined ? { payload: Uint8Array.from(payload) } : {}),
      });
    }

    for (const [index, entry] of value.entries.entries()) {
      if (SKIPPED_ACTIVE_CONTENT_KEYS.has(entry.key.value)) {
        continue;
      }
      await visit(entry.value, objectRef, [...path, index]);
    }
  };

  for (const [index, root] of roots.entries()) {
    await visit(root, undefined, [index]);
  }
  return active;
}

const SKIPPED_ACTIVE_CONTENT_KEYS = new Set([
  "AP",
  "Contents",
  "D",
  "Dest",
  "DR",
  "EF",
  "F",
  "JS",
  "Metadata",
  "P",
  "Parent",
  "Resources",
  "XFA",
]);

function referenceValue(ref: PdfReference): PdfValue {
  return {
    kind: "reference",
    value: ref,
    source: { start: 0, end: 0 },
  };
}

async function buildFindings(
  store: PdfObjectStore,
  model: PdfDocumentModel,
  policy: PdfNormalizedPolicy,
  features: Pick<
    PdfDocumentFeatures,
    | "activeContent"
    | "annotations"
    | "attachments"
    | "formFields"
    | "optionalContentGroups"
    | "outlines"
    | "signatures"
  >,
): Promise<readonly PdfFeatureFinding[]> {
  const findings: PdfFeatureFinding[] = [];
  for (const item of features.activeContent) {
    if (item.kind === "javascript" || item.kind === "launch") {
      const javascript = item.kind === "javascript";
      findings.push({
        kind: javascript ? "javascript-actions" : "launch-actions",
        action: javascript ? policy.javascriptActions : policy.launchActions,
        evidenceSource: "object",
        ...(item.objectRef !== undefined ? { objectRef: item.objectRef, actionRef: item.objectRef } : {}),
        actionName: javascript ? "JavaScript" : "Launch",
        message: `${javascript ? "JavaScript" : "Launch"} action is present and will not be executed.`,
      });
    }
  }
  for (const attachment of features.attachments) {
    findings.push({
      kind: "embedded-files",
      action: policy.embeddedFiles,
      evidenceSource: "object",
      objectRef: attachment.objectRef,
      embeddedFileRef: attachment.objectRef,
      message: "An embedded file is present and requires explicit extraction.",
    });
  }
  for (const annotation of features.annotations) {
    const pageRef = model.pages[annotation.pageNumber - 1]?.ref;
    findings.push({
      kind: "annotations",
      action: "report",
      evidenceSource: "object",
      ...(annotation.objectRef !== undefined ? { objectRef: annotation.objectRef, annotationRef: annotation.objectRef } : {}),
      ...(pageRef !== undefined ? { pageRef } : {}),
      annotationSubtype: annotation.subtype,
      message: `Annotation subtype ${annotation.subtype} is present.`,
    });
    if (annotation.subtype === "Link") {
      findings.push({
        kind: "links",
        action: "report",
        evidenceSource: "object",
        ...(annotation.objectRef !== undefined ? { objectRef: annotation.objectRef, annotationRef: annotation.objectRef } : {}),
        ...(pageRef !== undefined ? { pageRef } : {}),
        annotationSubtype: annotation.subtype,
        message: "A link annotation is present.",
      });
    }
  }
  if (features.formFields.length > 0) {
    findings.push({
      kind: "forms",
      action: "report",
      evidenceSource: "object",
      fieldRefs: flattenFields(features.formFields).flatMap((field) => field.objectRef === undefined ? [] : [field.objectRef]),
      message: "Interactive form fields are present and exposed read-only.",
    });
  }
  if (features.outlines.length > 0) {
    findings.push({
      kind: "outlines",
      action: "report",
      evidenceSource: "object",
      itemRefs: flattenOutlines(features.outlines).flatMap((item) => item.objectRef === undefined ? [] : [item.objectRef]),
      message: "A document outline is present.",
    });
  }
  for (const signature of features.signatures) {
    findings.push({
      kind: "signatures",
      action: "report",
      evidenceSource: "object",
      objectRef: signature.objectRef,
      signatureRef: signature.objectRef,
      message: "A digital signature is present; trust requires caller policy.",
    });
  }
  if (features.optionalContentGroups.length > 0) {
    findings.push({
      kind: "optional-content",
      action: "report",
      evidenceSource: "object",
      groupRefs: features.optionalContentGroups.map((group) => group.objectRef),
      memberObjectRefs: [],
      message: "Optional-content groups are present.",
    });
  }
  if (store.encrypt !== undefined) {
    findings.push({
      kind: "encryption",
      action: "report",
      evidenceSource: "object",
      objectRef: store.encrypt,
      objectRefs: [store.encrypt],
      message: "The document is encrypted.",
    });
  }
  const images: PdfReference[] = [];
  const fonts: PdfReference[] = [];
  for (const object of await store.all()) {
    if (object.value.kind !== "dictionary") {
      continue;
    }
    const type = pdfAsName(pdfDictionaryGet(object.value, "Type"));
    const subtype = pdfAsName(pdfDictionaryGet(object.value, "Subtype"));
    if (type === "XObject" && subtype === "Image") {
      images.push(object.ref);
    }
    if (type === "Font") {
      fonts.push(object.ref);
    }
  }
  if (images.length > 0) {
    findings.push({ kind: "images", action: "report", evidenceSource: "object", objectRefs: images, message: "Image objects are present." });
  }
  if (fonts.length > 0) {
    findings.push({ kind: "fonts", action: "report", evidenceSource: "object", objectRefs: fonts, message: "Font objects are present." });
  }
  if (store.sections.some((section) => section.kind === "stream")) {
    findings.push({ kind: "xref-streams", action: "report", evidenceSource: "object", objectRefs: [], message: "Cross-reference streams are present." });
  }
  if (store.refs().some((ref) => store.sections.some((section) => section.entries.some((entry) => entry.kind === "compressed" && entry.objectNumber === ref.objectNumber)))) {
    findings.push({ kind: "object-streams", action: "report", evidenceSource: "object", objectRefs: [], message: "Compressed object streams are present." });
  }
  return findings;
}

async function readDestination(
  store: PdfObjectStore,
  value: PdfValue | undefined,
  model: PdfDocumentModel,
): Promise<PdfDestination | undefined> {
  const resolved = await store.resolve(value);
  const array = resolved?.kind === "dictionary"
    ? pdfAsArray(await store.resolve(pdfDictionaryGet(resolved, "D")))
    : pdfAsArray(resolved);
  if (array === undefined || array.items.length === 0) {
    return undefined;
  }
  const pageRef = pdfAsReference(array.items[0]);
  const mode = pdfAsName(array.items[1]);
  const pageNumber = pageRef === undefined ? undefined : model.pageNumberByRef.get(pdfReferenceKey(pageRef));
  return {
    ...(pageRef !== undefined ? { pageRef } : {}),
    ...(pageNumber !== undefined ? { pageNumber } : {}),
    ...(mode !== undefined ? { mode } : {}),
    parameters: array.items.slice(2).map((item) => item.kind === "null" ? null : pdfAsNumber(item) ?? null),
  };
}

function classifyActiveContent(
  actionName: string | undefined,
  subtype: string | undefined,
): PdfActiveContent["kind"] | undefined {
  if (actionName === "JavaScript") return "javascript";
  if (actionName === "Launch") return "launch";
  if (subtype === "RichMedia") return "rich-media";
  if (subtype === "Movie" || subtype === "Sound" || subtype === "Screen") return "multimedia";
  if (subtype === "3D") return "three-dimensional";
  return undefined;
}

function numericArray(value: PdfArrayValue | undefined): readonly number[] {
  return value?.items.flatMap((item) => {
    const number = pdfAsNumber(item);
    return number === undefined ? [] : [number];
  }) ?? [];
}

function flattenFields(fields: readonly PdfFormField[]): readonly PdfFormField[] {
  return fields.flatMap((field) => [field, ...flattenFields(field.children)]);
}

function flattenOutlines(items: readonly PdfOutlineItem[]): readonly PdfOutlineItem[] {
  return items.flatMap((item) => [item, ...flattenOutlines(item.children)]);
}

function dedupeById<T extends { readonly id: string }>(items: readonly T[]): readonly T[] {
  return [...new Map(items.map((item) => [item.id, item] as const)).values()];
}
