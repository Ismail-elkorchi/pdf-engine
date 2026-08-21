import { type PdfBudgetTracker } from "./pdf-budget.ts";
import { decodeTypedPdfStream, type PdfDecodedStream } from "./pdf-stream.ts";
import { PdfSyntaxError, PdfSyntaxParser } from "./pdf-syntax.ts";
import {
  type PdfArrayValue,
  type PdfDictionaryValue,
  type PdfDictionaryEntry,
  type PdfIndirectObject,
  type PdfReference,
  type PdfStreamValue,
  type PdfValue,
  pdfAsArray,
  pdfAsInteger,
  pdfAsName,
  pdfAsReference,
  pdfDictionaryGet,
  pdfReferenceKey,
} from "./pdf-values.ts";

import type { PdfByteSequence, PdfSourceData } from "./pdf-source.ts";
import type { PdfStandardPasswordSecurityHandler } from "./pdf-standard-security.ts";

interface PdfFreeXrefEntry {
  readonly kind: "free";
  readonly objectNumber: number;
  readonly nextFreeObjectNumber: number;
  readonly generationNumber: number;
  readonly revision: number;
}

interface PdfUncompressedXrefEntry {
  readonly kind: "uncompressed";
  readonly objectNumber: number;
  readonly offset: number;
  readonly generationNumber: number;
  readonly revision: number;
}

interface PdfCompressedXrefEntry {
  readonly kind: "compressed";
  readonly objectNumber: number;
  readonly objectStreamNumber: number;
  readonly objectStreamIndex: number;
  readonly generationNumber: 0;
  readonly revision: number;
}

export type PdfXrefEntry = PdfFreeXrefEntry | PdfUncompressedXrefEntry | PdfCompressedXrefEntry;

interface PendingXrefEntry {
  readonly kind: PdfXrefEntry["kind"];
  readonly objectNumber: number;
  readonly field2: number;
  readonly field3: number;
}

export interface PdfXrefSection {
  readonly offset: number;
  readonly kind: "table" | "stream" | "repaired";
  readonly trailer: PdfDictionaryValue;
  readonly entries: readonly PdfXrefEntry[];
  readonly revision: number;
}

interface PendingXrefSection {
  readonly offset: number;
  readonly kind: "table" | "stream";
  readonly trailer: PdfDictionaryValue;
  readonly entries: readonly PendingXrefEntry[];
}

export interface PdfObjectStoreOpenResult {
  readonly store: PdfObjectStore;
  readonly repaired: boolean;
}

export class PdfObjectStore {
  readonly parser: PdfSyntaxParser;
  readonly budget: PdfBudgetTracker;
  readonly version: string;
  readonly startXref: number | undefined;
  readonly sections: readonly PdfXrefSection[];
  readonly trailer: PdfDictionaryValue;
  readonly root: PdfReference;
  readonly encrypt: PdfReference | undefined;
  readonly documentId: Uint8Array | undefined;
  readonly #data: PdfSourceData;
  readonly #xrefRepaired: boolean;
  readonly #entries: ReadonlyMap<string, PdfXrefEntry>;
  readonly #objectBoundaries: readonly number[];
  readonly #objectCache = new Map<string, PdfIndirectObject>();
  readonly #streamCache = new Map<string, PdfDecodedStream>();
  readonly #encodedStreamCache = new Map<string, Uint8Array>();
  readonly #objectStreamCache = new Map<number, ReadonlyMap<number, PdfIndirectObject>>();
  #securityHandler: PdfStandardPasswordSecurityHandler | undefined;

  private constructor(input: {
    readonly data: PdfSourceData;
    readonly parser: PdfSyntaxParser;
    readonly budget: PdfBudgetTracker;
    readonly version: string;
    readonly startXref?: number;
    readonly sections: readonly PdfXrefSection[];
    readonly entries: ReadonlyMap<string, PdfXrefEntry>;
    readonly trailer: PdfDictionaryValue;
    readonly root: PdfReference;
    readonly encrypt?: PdfReference;
    readonly documentId?: Uint8Array;
    readonly repaired: boolean;
  }) {
    this.#data = input.data;
    this.parser = input.parser;
    this.budget = input.budget;
    this.version = input.version;
    this.startXref = input.startXref;
    this.sections = input.sections;
    this.#entries = input.entries;
    this.#objectBoundaries = [
      ...new Set([
        ...input.sections.map((section) => section.offset),
        ...[...input.entries.values()].flatMap((entry) => entry.kind === "uncompressed" ? [entry.offset] : []),
        input.data.byteLength,
      ]),
    ].toSorted((left, right) => left - right);
    this.trailer = input.trailer;
    this.root = input.root;
    this.encrypt = input.encrypt;
    this.documentId = input.documentId;
    this.#xrefRepaired = input.repaired;
  }

  static async open(
    data: PdfSourceData,
    budget: PdfBudgetTracker,
    repairMode: "strict" | "safe",
  ): Promise<PdfObjectStoreOpenResult> {
    const bytes = data.bytes;
    const parser = new PdfSyntaxParser(bytes, budget, repairMode === "safe");
    const version = readPdfVersion(bytes);
    const startXref = readStartXref(parser, bytes);
    let repaired = false;
    let pendingSections: readonly PendingXrefSection[];
    try {
      if (startXref === undefined) {
        throw new PdfSyntaxError("Missing startxref", bytes.byteLength);
      }
      pendingSections = await readXrefChain(parser, budget, startXref, data);
    } catch (error: unknown) {
      if (repairMode === "strict") {
        throw error;
      }
      await data.materialize();
      pendingSections = [repairXref(parser, bytes)];
      repaired = true;
    }

    const sections = finalizeSections(pendingSections);
    const entries = new Map<string, PdfXrefEntry>();
    for (const section of sections) {
      for (const entry of section.entries) {
        entries.set(pdfReferenceKey({ objectNumber: entry.objectNumber, generationNumber: entry.generationNumber }), entry);
      }
    }
    const trailer = sections.at(-1)?.trailer;
    if (trailer === undefined) {
      throw new PdfSyntaxError("No trailer dictionary was recovered", startXref ?? 0);
    }
    const root = pdfAsReference(pdfDictionaryGet(trailer, "Root"));
    if (root === undefined) {
      throw new PdfSyntaxError("Trailer has no catalog reference", trailer.source.start);
    }
    const encrypt = pdfAsReference(pdfDictionaryGet(trailer, "Encrypt"));
    const documentId = readDocumentId(trailer);
    return {
      store: new PdfObjectStore({
        data,
        parser,
        budget,
        version,
        ...(startXref !== undefined ? { startXref } : {}),
        sections,
        entries,
        trailer,
        root,
        ...(encrypt !== undefined ? { encrypt } : {}),
        ...(documentId !== undefined ? { documentId } : {}),
        repaired,
      }),
      repaired,
    };
  }

  get objectCount(): number {
    return [...this.#entries.values()].filter((entry) => entry.kind !== "free").length;
  }

  get byteLength(): number {
    return this.#data.byteLength;
  }

  get repaired(): boolean {
    return this.#xrefRepaired || this.parser.repaired;
  }

  configureSecurity(handler: PdfStandardPasswordSecurityHandler): void {
    if (this.encrypt === undefined) {
      throw new Error("Cannot configure document security for an unencrypted PDF.");
    }
    if (this.#securityHandler !== undefined) {
      throw new Error("Document security has already been configured.");
    }
    this.#securityHandler = handler;
    this.#objectCache.clear();
    this.#streamCache.clear();
    this.#encodedStreamCache.clear();
    this.#objectStreamCache.clear();
  }

  get securityHandler(): PdfStandardPasswordSecurityHandler | undefined {
    return this.#securityHandler;
  }

  refs(): readonly PdfReference[] {
    return [...this.#entries.values()]
      .filter((entry): entry is PdfUncompressedXrefEntry | PdfCompressedXrefEntry => entry.kind !== "free")
      .map((entry) => ({ objectNumber: entry.objectNumber, generationNumber: entry.generationNumber }))
      .toSorted(compareReferences);
  }

  async get(ref: PdfReference): Promise<PdfIndirectObject | undefined> {
    const key = pdfReferenceKey(ref);
    const cached = this.#objectCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.kind === "free") {
      return undefined;
    }
    let parsed: PdfIndirectObject;
    if (entry.kind === "uncompressed") {
      await this.#ensureObjectLoaded(entry.offset);
      parsed = this.parser.parseIndirectObject(entry.offset, entry.revision).object;
    } else {
      parsed = await this.#getCompressedObject(entry);
    }
    const object = entry.kind === "uncompressed" && this.#securityHandler !== undefined
      ? await decryptIndirectObject(parsed, this.#securityHandler, this.budget)
      : parsed;
    if (
      object.ref.objectNumber !== ref.objectNumber ||
      object.ref.generationNumber !== ref.generationNumber
    ) {
      throw new PdfSyntaxError("Cross-reference entry points to a different object", object.source.start);
    }
    this.budget.cacheBytes(Math.max(1, object.source.end - object.source.start));
    this.#objectCache.set(key, object);
    return object;
  }

  async #ensureObjectLoaded(offset: number): Promise<void> {
    const end = this.#objectEnd(offset);
    await this.#data.ensure(offset, Math.max(0, end - offset));
  }

  #objectEnd(offset: number): number {
    return this.#objectBoundaries.find((boundary) => boundary > offset) ?? this.byteLength;
  }

  async require(ref: PdfReference): Promise<PdfIndirectObject> {
    const object = await this.get(ref);
    if (object === undefined) {
      throw new PdfSyntaxError(`Missing indirect object ${String(ref.objectNumber)} ${String(ref.generationNumber)}`, 0);
    }
    return object;
  }

  async isArrayObject(ref: PdfReference): Promise<boolean> {
    const entry = this.#entries.get(pdfReferenceKey(ref));
    if (entry === undefined || entry.kind === "free") {
      return false;
    }
    if (entry.kind === "compressed") {
      return (await this.get(ref))?.value.kind === "array";
    }

    const end = this.#objectEnd(entry.offset);
    let length = Math.min(256, end - entry.offset);
    while (true) {
      await this.#data.ensure(entry.offset, length);
      try {
        let cursor = this.parser.skipWhitespace(entry.offset);
        const objectNumber = this.parser.readUnsignedInteger(cursor);
        if (objectNumber === undefined) {
          throw new PdfSyntaxError("Expected an indirect object number", cursor);
        }
        cursor = this.parser.skipWhitespace(objectNumber.nextOffset);
        const generationNumber = this.parser.readUnsignedInteger(cursor);
        if (generationNumber === undefined) {
          throw new PdfSyntaxError("Expected an indirect object generation number", cursor);
        }
        cursor = this.parser.skipWhitespace(generationNumber.nextOffset);
        if (!this.parser.matchesKeyword(cursor, "obj")) {
          throw new PdfSyntaxError("Expected the obj keyword", cursor);
        }
        const valueOffset = this.parser.skipWhitespace(cursor + 3);
        const valueByte = this.parser.byteAt(valueOffset);
        if (valueByte === undefined) {
          throw new PdfSyntaxError("Expected an indirect object value", valueOffset);
        }
        return valueByte === 0x5b;
      } catch (error: unknown) {
        if (entry.offset + length >= end) {
          throw error;
        }
        length = Math.min(end - entry.offset, Math.max(length + 1, length * 2));
      }
    }
  }

  async resolve(value: PdfValue | undefined): Promise<PdfValue | undefined> {
    if (value?.kind !== "reference") {
      return value;
    }
    return (await this.get(value.value))?.value;
  }

  async resolveDictionary(value: PdfValue | undefined): Promise<PdfDictionaryValue | undefined> {
    const resolved = await this.resolve(value);
    return resolved?.kind === "dictionary" ? resolved : undefined;
  }

  async decodeStream(ref: PdfReference): Promise<PdfDecodedStream | undefined> {
    const key = pdfReferenceKey(ref);
    const cached = this.#streamCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const object = await this.get(ref);
    if (object?.stream === undefined) {
      return undefined;
    }
    const rawBytes = await this.encodedStream(ref);
    if (rawBytes === undefined) {
      return undefined;
    }
    const stream: PdfStreamValue = { ...object.stream, rawBytes };
    const decoded = await decodeTypedPdfStream(stream, this.budget);
    this.budget.cacheBytes(decoded.bytes.byteLength);
    this.#streamCache.set(key, decoded);
    return decoded;
  }

  async encodedStream(ref: PdfReference): Promise<Uint8Array | undefined> {
    const key = pdfReferenceKey(ref);
    const cached = this.#encodedStreamCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const object = await this.get(ref);
    if (object?.stream === undefined) {
      return undefined;
    }
    const typeName = pdfAsName(pdfDictionaryGet(object.stream.dictionary, "Type"));
    const bytes = this.#securityHandler === undefined
      ? Uint8Array.from(object.stream.rawBytes)
      : await this.#securityHandler.decryptStreamBytes(ref, object.stream.rawBytes, {
        ...(typeName !== undefined ? { typeName } : {}),
      });
    this.budget.cacheBytes(bytes.byteLength);
    this.#encodedStreamCache.set(key, bytes);
    return bytes;
  }

  async all(): Promise<readonly PdfIndirectObject[]> {
    const objects: PdfIndirectObject[] = [];
    for (const ref of this.refs()) {
      const object = await this.get(ref);
      if (object !== undefined) {
        objects.push(object);
      }
    }
    return objects;
  }

  async #getCompressedObject(entry: PdfCompressedXrefEntry): Promise<PdfIndirectObject> {
    let members = this.#objectStreamCache.get(entry.objectStreamNumber);
    if (members === undefined) {
      members = await this.#readObjectStream(entry.objectStreamNumber, entry.revision);
      this.#objectStreamCache.set(entry.objectStreamNumber, members);
    }
    const object = members.get(entry.objectNumber);
    if (object === undefined) {
      throw new PdfSyntaxError("Object stream does not contain the indexed object", 0);
    }
    return object;
  }

  async #readObjectStream(objectStreamNumber: number, revision: number): Promise<ReadonlyMap<number, PdfIndirectObject>> {
    const streamObject = await this.require({ objectNumber: objectStreamNumber, generationNumber: 0 });
    if (streamObject.stream === undefined || streamObject.value.kind !== "dictionary") {
      throw new PdfSyntaxError("Compressed object entry references a non-stream object", streamObject.source.start);
    }
    const count = pdfAsInteger(pdfDictionaryGet(streamObject.value, "N"));
    const first = pdfAsInteger(pdfDictionaryGet(streamObject.value, "First"));
    if (count === undefined || first === undefined || count < 0 || first < 0) {
      throw new PdfSyntaxError("Malformed object stream header", streamObject.source.start);
    }
    const decoded = await this.decodeStream(streamObject.ref);
    if (decoded === undefined || first > decoded.bytes.byteLength) {
      throw new PdfSyntaxError("Object stream could not be decoded", streamObject.source.start);
    }
    const parser = new PdfSyntaxParser(decoded.bytes, this.budget);
    const headers: { readonly objectNumber: number; readonly offset: number }[] = [];
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      cursor = parser.skipWhitespace(cursor);
      const objectNumber = parser.readUnsignedInteger(cursor);
      if (objectNumber === undefined) {
        throw new PdfSyntaxError("Malformed object stream object number", streamObject.source.start);
      }
      cursor = parser.skipWhitespace(objectNumber.nextOffset);
      const offset = parser.readUnsignedInteger(cursor);
      if (offset === undefined) {
        throw new PdfSyntaxError("Malformed object stream member offset", streamObject.source.start);
      }
      headers.push({ objectNumber: objectNumber.value, offset: offset.value });
      cursor = offset.nextOffset;
    }
    const members = new Map<number, PdfIndirectObject>();
    for (const header of headers) {
      this.budget.object();
      const parsed = parser.parseValue(first + header.offset);
      members.set(header.objectNumber, {
        ref: { objectNumber: header.objectNumber, generationNumber: 0 },
        revision,
        source: streamObject.stream.dataSource,
        value: parsed.value,
      });
    }
    return members;
  }
}

async function decryptIndirectObject(
  object: PdfIndirectObject,
  handler: PdfStandardPasswordSecurityHandler,
  budget: PdfBudgetTracker,
): Promise<PdfIndirectObject> {
  const typeName = object.value.kind === "dictionary"
    ? pdfAsName(pdfDictionaryGet(object.value, "Type"))
    : undefined;
  const value = await decryptValue(object.value, object.ref, handler, typeName, budget, 0);
  if (object.stream === undefined) {
    return { ...object, value };
  }
  if (value.kind !== "dictionary") {
    throw new PdfSyntaxError("Stream object value is not a dictionary after decryption", object.source.start);
  }
  return {
    ...object,
    value,
    stream: { ...object.stream, dictionary: value },
  };
}

async function decryptValue(
  value: PdfValue,
  objectRef: PdfReference,
  handler: PdfStandardPasswordSecurityHandler,
  typeName: string | undefined,
  budget: PdfBudgetTracker,
  depth: number,
): Promise<PdfValue> {
  budget.depth(depth);
  switch (value.kind) {
    case "string":
      return {
        ...value,
        bytes: await handler.decryptStringBytes(objectRef, value.bytes, {
          ...(typeName !== undefined ? { typeName } : {}),
        }),
      };
    case "array":
      return {
        ...value,
        items: await Promise.all(value.items.map(async (item) =>
          decryptValue(item, objectRef, handler, typeName, budget, depth + 1)
        )),
      };
    case "dictionary": {
      const isSignature = typeName === "Sig" || pdfDictionaryGet(value, "ByteRange") !== undefined;
      const entries: PdfDictionaryEntry[] = await Promise.all(value.entries.map(async (entry) => ({
        key: entry.key,
        value: isSignature && entry.key.value === "Contents"
          ? entry.value
          : await decryptValue(entry.value, objectRef, handler, typeName, budget, depth + 1),
      })));
      return { ...value, entries };
    }
    case "boolean":
    case "integer":
    case "name":
    case "null":
    case "real":
    case "reference":
      return value;
  }
}

async function readXrefChain(
  parser: PdfSyntaxParser,
  budget: PdfBudgetTracker,
  startXref: number,
  data: PdfSourceData,
): Promise<readonly PendingXrefSection[]> {
  const sections: PendingXrefSection[] = [];
  const visited = new Set<number>();
  let offset: number | undefined = startXref;
  while (offset !== undefined) {
    if (visited.has(offset)) {
      throw new PdfSyntaxError("Cross-reference chain contains a cycle", offset);
    }
    visited.add(offset);
    const section = await readXrefSection(parser, budget, data, offset);
    sections.push(section);
    const hybridOffset = pdfAsInteger(pdfDictionaryGet(section.trailer, "XRefStm"));
    if (hybridOffset !== undefined && !visited.has(hybridOffset)) {
      visited.add(hybridOffset);
      sections.push(await readXrefSection(parser, budget, data, hybridOffset, true));
    }
    offset = pdfAsInteger(pdfDictionaryGet(section.trailer, "Prev"));
  }
  return sections;
}

async function readXrefSection(
  parser: PdfSyntaxParser,
  budget: PdfBudgetTracker,
  data: PdfSourceData,
  offset: number,
  requireStream: boolean = false,
): Promise<PendingXrefSection> {
  let length = Math.min(1_048_576, data.byteLength - offset);
  while (true) {
    await data.ensure(offset, length);
    try {
      if (!requireStream && parser.matchesKeyword(parser.skipWhitespace(offset), "xref")) {
        return readClassicXrefSection(parser, offset);
      }
      return await readXrefStreamSection(parser, budget, offset);
    } catch (error: unknown) {
      if (offset + length >= data.byteLength) {
        throw error;
      }
      length = Math.min(data.byteLength - offset, Math.max(length + 1, length * 2));
    }
  }
}

function readClassicXrefSection(parser: PdfSyntaxParser, offset: number): PendingXrefSection {
  let cursor = parser.skipWhitespace(offset);
  if (!parser.matchesKeyword(cursor, "xref")) {
    throw new PdfSyntaxError("Expected xref table", cursor);
  }
  cursor += 4;
  const entries: PendingXrefEntry[] = [];
  while (true) {
    cursor = parser.skipWhitespace(cursor);
    if (parser.matchesKeyword(cursor, "trailer")) {
      const trailer = parser.parseValue(cursor + 7);
      if (trailer.value.kind !== "dictionary") {
        throw new PdfSyntaxError("Expected trailer dictionary", cursor + 7);
      }
      return { offset, kind: "table", trailer: trailer.value, entries };
    }
    const first = parser.readUnsignedInteger(cursor);
    if (first === undefined) {
      throw new PdfSyntaxError("Malformed xref subsection", cursor);
    }
    cursor = parser.skipWhitespace(first.nextOffset);
    const count = parser.readUnsignedInteger(cursor);
    if (count === undefined) {
      throw new PdfSyntaxError("Malformed xref subsection count", cursor);
    }
    cursor = count.nextOffset;
    for (let index = 0; index < count.value; index += 1) {
      cursor = parser.skipWhitespace(cursor);
      const field2 = parser.readUnsignedInteger(cursor);
      if (field2 === undefined) {
        throw new PdfSyntaxError("Malformed xref entry offset", cursor);
      }
      cursor = parser.skipWhitespace(field2.nextOffset);
      const field3 = parser.readUnsignedInteger(cursor);
      if (field3 === undefined) {
        throw new PdfSyntaxError("Malformed xref entry generation", cursor);
      }
      cursor = parser.skipWhitespace(field3.nextOffset);
      const marker = parser.byteAt(cursor);
      if (marker !== 0x6e && marker !== 0x66) {
        throw new PdfSyntaxError("Malformed xref entry marker", cursor);
      }
      entries.push({
        kind: marker === 0x6e ? "uncompressed" : "free",
        objectNumber: first.value + index,
        field2: field2.value,
        field3: field3.value,
      });
      cursor += 1;
    }
  }
}

async function readXrefStreamSection(
  parser: PdfSyntaxParser,
  budget: PdfBudgetTracker,
  offset: number,
): Promise<PendingXrefSection> {
  const object = parser.parseIndirectObject(offset).object;
  if (object.value.kind !== "dictionary" || object.stream === undefined) {
    throw new PdfSyntaxError("startxref does not point to an xref section", offset);
  }
  const widths = integerArray(pdfAsArray(pdfDictionaryGet(object.value, "W")));
  if (widths.length !== 3 || widths.some((width) => width < 0 || width > 8)) {
    throw new PdfSyntaxError("Malformed xref stream field widths", offset);
  }
  const size = pdfAsInteger(pdfDictionaryGet(object.value, "Size"));
  if (size === undefined || size < 0) {
    throw new PdfSyntaxError("Malformed xref stream Size", offset);
  }
  const index = pdfAsArray(pdfDictionaryGet(object.value, "Index"));
  const ranges = index === undefined ? [0, size] : integerArray(index);
  if (ranges.length % 2 !== 0) {
    throw new PdfSyntaxError("Malformed xref stream Index", offset);
  }
  const decoded = await decodeTypedPdfStream(object.stream, budget);
  const entries: PendingXrefEntry[] = [];
  let cursor = 0;
  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 2) {
    const first = ranges[rangeIndex] ?? 0;
    const count = ranges[rangeIndex + 1] ?? 0;
    for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
      const type = (widths[0] ?? 0) === 0 ? 1 : readBigEndian(decoded.bytes, cursor, widths[0] ?? 0);
      cursor += widths[0] ?? 0;
      const field2 = readBigEndian(decoded.bytes, cursor, widths[1] ?? 0);
      cursor += widths[1] ?? 0;
      const field3 = readBigEndian(decoded.bytes, cursor, widths[2] ?? 0);
      cursor += widths[2] ?? 0;
      if (type === 0 || type === 1 || type === 2) {
        entries.push({
          kind: type === 0 ? "free" : type === 1 ? "uncompressed" : "compressed",
          objectNumber: first + entryIndex,
          field2,
          field3,
        });
      }
    }
  }
  return { offset, kind: "stream", trailer: object.value, entries };
}

function repairXref(parser: PdfSyntaxParser, bytes: PdfByteSequence): PendingXrefSection {
  const entries: PendingXrefEntry[] = [];
  let cursor = 0;
  let latestTrailer: PdfDictionaryValue | undefined;
  while (cursor < bytes.byteLength) {
    if (!isDigitByte(bytes.byteAt(cursor)) || !isBoundaryByte(bytes.byteAt(cursor - 1))) {
      cursor += 1;
      continue;
    }
    const first = parser.readUnsignedInteger(cursor);
    if (first === undefined) {
      cursor += 1;
      continue;
    }
    const generationStart = parser.skipWhitespace(first.nextOffset);
    const generation = parser.readUnsignedInteger(generationStart);
    const objectKeyword = generation === undefined ? -1 : parser.skipWhitespace(generation.nextOffset);
    if (generation === undefined || !parser.matchesKeyword(objectKeyword, "obj")) {
      cursor = first.nextOffset;
      continue;
    }
    try {
      const object = parser.parseIndirectObject(cursor);
      entries.push({
        kind: "uncompressed",
        objectNumber: first.value,
        field2: cursor,
        field3: generation.value,
      });
      cursor = object.nextOffset;
    } catch {
      cursor = objectKeyword + 3;
    }
  }
  const trailerOffset = parser.findLastKeyword("trailer");
  if (trailerOffset >= 0) {
    const parsed = parser.parseValue(trailerOffset + 7);
    if (parsed.value.kind === "dictionary") {
      latestTrailer = parsed.value;
    }
  }
  if (latestTrailer === undefined) {
    const catalogEntry = entries.find((entry) => {
      try {
        const object = parser.parseIndirectObject(entry.field2).object;
        return object.value.kind === "dictionary" &&
          object.value.entries.some((item) => item.key.value === "Type" && item.value.kind === "name" && item.value.value === "Catalog");
      } catch {
        return false;
      }
    });
    if (catalogEntry === undefined) {
      throw new PdfSyntaxError("Repair could not recover a catalog", 0);
    }
    latestTrailer = syntheticTrailer(catalogEntry.objectNumber, bytes.byteLength);
  }
  return { offset: 0, kind: "table", trailer: latestTrailer, entries };
}

function finalizeSections(pending: readonly PendingXrefSection[]): readonly PdfXrefSection[] {
  const chronological = [...pending].reverse();
  return chronological.map((section, revision) => ({
    offset: section.offset,
    kind: section.kind,
    trailer: section.trailer,
    revision,
    entries: section.entries.map((entry): PdfXrefEntry => {
      switch (entry.kind) {
        case "free":
          return {
            kind: "free",
            objectNumber: entry.objectNumber,
            nextFreeObjectNumber: entry.field2,
            generationNumber: entry.field3,
            revision,
          };
        case "uncompressed":
          return {
            kind: "uncompressed",
            objectNumber: entry.objectNumber,
            offset: entry.field2,
            generationNumber: entry.field3,
            revision,
          };
        case "compressed":
          return {
            kind: "compressed",
            objectNumber: entry.objectNumber,
            objectStreamNumber: entry.field2,
            objectStreamIndex: entry.field3,
            generationNumber: 0,
            revision,
          };
      }
    }),
  }));
}

function readPdfVersion(bytes: PdfByteSequence): string {
  const limit = Math.min(1024, bytes.byteLength - 8);
  for (let offset = 0; offset <= limit; offset += 1) {
    if (
      bytes.byteAt(offset) === 0x25 && bytes.byteAt(offset + 1) === 0x50 && bytes.byteAt(offset + 2) === 0x44 &&
      bytes.byteAt(offset + 3) === 0x46 && bytes.byteAt(offset + 4) === 0x2d && isDigitByte(bytes.byteAt(offset + 5)) &&
      bytes.byteAt(offset + 6) === 0x2e && isDigitByte(bytes.byteAt(offset + 7))
    ) {
      return `${String.fromCharCode(bytes.byteAt(offset + 5) ?? 0)}.${String.fromCharCode(bytes.byteAt(offset + 7) ?? 0)}`;
    }
  }
  throw new PdfSyntaxError("Input has no PDF header", 0);
}

function readStartXref(parser: PdfSyntaxParser, bytes: PdfByteSequence): number | undefined {
  const marker = parser.findLastKeyword("startxref");
  if (marker < 0) {
    return undefined;
  }
  const token = parser.readUnsignedInteger(parser.skipWhitespace(marker + 9));
  if (token === undefined || token.value >= bytes.byteLength) {
    return undefined;
  }
  return token.value;
}

function readDocumentId(trailer: PdfDictionaryValue): Uint8Array | undefined {
  const id = pdfAsArray(pdfDictionaryGet(trailer, "ID"));
  const first = id?.items[0];
  return first?.kind === "string" ? Uint8Array.from(first.bytes) : undefined;
}

function integerArray(value: PdfArrayValue | undefined): readonly number[] {
  if (value === undefined) {
    return [];
  }
  const result: number[] = [];
  for (const item of value.items) {
    const integer = pdfAsInteger(item);
    if (integer === undefined) {
      return [];
    }
    result.push(integer);
  }
  return result;
}

function readBigEndian(bytes: Uint8Array, offset: number, width: number): number {
  if (offset + width > bytes.byteLength) {
    throw new PdfSyntaxError("Xref stream ended before all entries were decoded", offset);
  }
  let value = 0;
  for (let index = 0; index < width; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
    if (!Number.isSafeInteger(value)) {
      throw new PdfSyntaxError("Xref stream field exceeds the safe integer range", offset);
    }
  }
  return value;
}

function compareReferences(left: PdfReference, right: PdfReference): number {
  return left.objectNumber - right.objectNumber || left.generationNumber - right.generationNumber;
}

function isDigitByte(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

function isBoundaryByte(byte: number | undefined): boolean {
  return byte === undefined || byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d ||
    byte === 0x20 || byte === 0x25 || byte === 0x28 || byte === 0x29 || byte === 0x2f || byte === 0x3c ||
    byte === 0x3e || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d;
}

function syntheticTrailer(rootObjectNumber: number, end: number): PdfDictionaryValue {
  return {
    kind: "dictionary",
    source: { start: 0, end },
    entries: [
      {
        key: { kind: "name", value: "Root", bytes: Uint8Array.from([0x52, 0x6f, 0x6f, 0x74]), source: { start: 0, end: 0 } },
        value: {
          kind: "reference",
          value: { objectNumber: rootObjectNumber, generationNumber: 0 },
          source: { start: 0, end: 0 },
        },
      },
    ],
  };
}
