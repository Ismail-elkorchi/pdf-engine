import type { PdfSource, PdfSourceDescriptor } from "./public-api.ts";

export interface PdfByteSource {
  readonly descriptor: PdfSourceDescriptor;
  readonly byteLength: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface PdfSourceData {
  readonly descriptor: PdfSourceDescriptor;
  readonly byteLength: number;
  readonly bytes: PdfByteSequence;
  readonly fullyLoaded: boolean;
  ensure(offset: number, length: number, signal?: AbortSignal): Promise<void>;
  materialize(signal?: AbortSignal): Promise<Uint8Array>;
}

export interface PdfByteSequence {
  readonly byteLength: number;
  byteAt(offset: number): number | undefined;
  slice(start: number, end: number): Uint8Array;
}

class MemoryByteSource implements PdfByteSource {
  readonly descriptor: PdfSourceDescriptor;
  readonly byteLength: number;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array, descriptor: PdfSourceDescriptor) {
    this.#bytes = Uint8Array.from(bytes);
    this.byteLength = bytes.byteLength;
    this.descriptor = descriptor;
  }

  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    validateRange(offset, length, this.byteLength);
    return Promise.resolve(Uint8Array.from(this.#bytes.subarray(offset, Math.min(this.byteLength, offset + length))));
  }
}

class BlobByteSource implements PdfByteSource {
  readonly descriptor: PdfSourceDescriptor;
  readonly byteLength: number;
  readonly #blob: Blob;

  constructor(blob: Blob, descriptor: PdfSourceDescriptor) {
    this.#blob = blob;
    this.byteLength = blob.size;
    this.descriptor = descriptor;
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    validateRange(offset, length, this.byteLength);
    const bytes = new Uint8Array(await this.#blob.slice(offset, Math.min(this.byteLength, offset + length)).arrayBuffer());
    throwIfAborted(signal);
    return bytes;
  }
}

class RandomAccessByteSource implements PdfByteSource {
  readonly descriptor: PdfSourceDescriptor;
  readonly byteLength: number;
  readonly #source: Extract<PdfSource, { readonly kind: "random-access" }>;

  constructor(source: Extract<PdfSource, { readonly kind: "random-access" }>) {
    this.#source = source;
    this.byteLength = source.byteLength;
    this.descriptor = sourceDescriptor(source);
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    validateRange(offset, length, this.byteLength);
    const expectedLength = Math.min(length, this.byteLength - offset);
    const bytes = await this.#source.read({
      offset,
      length: expectedLength,
      ...(signal !== undefined ? { signal } : {}),
    });
    throwIfAborted(signal);
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Random-access source reads must return Uint8Array values.");
    }
    if (bytes.byteLength !== expectedLength) {
      throw new RangeError(
        `Random-access source returned ${String(bytes.byteLength)} bytes; expected ${String(expectedLength)}.`,
      );
    }
    return Uint8Array.from(bytes);
  }
}

export function createPdfByteSource(source: PdfSource): PdfByteSource {
  if (typeof source !== "object" || source === null) {
    throw new TypeError("PDF source must be a source descriptor.");
  }
  switch (source.kind) {
    case "bytes": {
      if (!(source.bytes instanceof Uint8Array)) {
        throw new TypeError("Byte sources must provide a Uint8Array.");
      }
      return new MemoryByteSource(source.bytes, sourceDescriptor(source));
    }
    case "blob": {
      if (!(source.blob instanceof Blob)) {
        throw new TypeError("Blob sources must provide a Blob.");
      }
      return new BlobByteSource(source.blob, sourceDescriptor(source));
    }
    case "random-access": {
      if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0 || typeof source.read !== "function") {
        throw new TypeError("Random-access sources require a non-negative safe byte length and a read function.");
      }
      return new RandomAccessByteSource(source);
    }
    default:
      throw new TypeError("PDF source kind must be bytes, blob, or random-access.");
  }
}

export async function loadPdfSource(
  source: PdfByteSource,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<PdfSourceData> {
  if (source.byteLength > maxBytes) {
    throw new PdfSourceLimitError(source.byteLength, maxBytes);
  }

  if (source.descriptor.kind === "bytes") {
    const bytes = await source.read(0, source.byteLength, signal);
    return new MaterializedPdfSourceData(source.descriptor, bytes);
  }

  const data = new SparsePdfSourceData(source);
  await data.ensure(0, Math.min(1024, data.byteLength), signal);
  const tailLength = Math.min(65_536, data.byteLength);
  await data.ensure(data.byteLength - tailLength, tailLength, signal);
  return data;
}

class MaterializedPdfSourceData implements PdfSourceData {
  readonly descriptor: PdfSourceDescriptor;
  readonly bytes: PdfByteSequence;
  readonly #materializedBytes: Uint8Array;

  constructor(descriptor: PdfSourceDescriptor, bytes: Uint8Array) {
    this.descriptor = descriptor;
    this.#materializedBytes = bytes;
    this.bytes = new MaterializedPdfByteSequence(this.#materializedBytes);
  }

  get byteLength(): number {
    return this.bytes.byteLength;
  }

  get fullyLoaded(): boolean {
    return true;
  }

  ensure(offset: number, length: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    validateRange(offset, length, this.byteLength);
    return Promise.resolve();
  }

  materialize(signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    return Promise.resolve(this.#materializedBytes);
  }
}

class MaterializedPdfByteSequence implements PdfByteSequence {
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get byteLength(): number {
    return this.#bytes.byteLength;
  }

  byteAt(offset: number): number | undefined {
    return offset < 0 || offset >= this.byteLength ? undefined : this.#bytes[offset];
  }

  slice(start: number, end: number): Uint8Array {
    return this.#bytes.slice(start, end);
  }
}

interface LoadedRange {
  readonly start: number;
  readonly end: number;
}

interface LoadedChunk extends LoadedRange {
  readonly bytes: Uint8Array;
}

class SparsePdfSourceData implements PdfSourceData {
  readonly descriptor: PdfSourceDescriptor;
  readonly byteLength: number;
  readonly bytes: SparsePdfByteSequence;
  readonly #source: PdfByteSource;
  #loadedRanges: readonly LoadedRange[] = [];
  #readQueue: Promise<void> = Promise.resolve();

  constructor(source: PdfByteSource) {
    this.#source = source;
    this.descriptor = source.descriptor;
    this.byteLength = source.byteLength;
    this.bytes = new SparsePdfByteSequence(source.byteLength);
  }

  get fullyLoaded(): boolean {
    const range = this.#loadedRanges[0];
    return this.#loadedRanges.length === 1 && range?.start === 0 && range.end === this.byteLength;
  }

  ensure(offset: number, length: number, signal?: AbortSignal): Promise<void> {
    validateRange(offset, length, this.byteLength);
    if (length === 0) {
      throwIfAborted(signal);
      return Promise.resolve();
    }
    const read = this.#readQueue.then(async () => {
      throwIfAborted(signal);
      for (const range of missingRanges(offset, offset + length, this.#loadedRanges)) {
        const bytes = await this.#source.read(range.start, range.end - range.start, signal);
        this.bytes.add({ ...range, bytes });
        this.#loadedRanges = mergeLoadedRange(this.#loadedRanges, range);
      }
    });
    this.#readQueue = read.catch(() => undefined);
    return read;
  }

  async materialize(signal?: AbortSignal): Promise<Uint8Array> {
    await this.ensure(0, this.byteLength, signal);
    return this.bytes.slice(0, this.byteLength);
  }
}

class SparsePdfByteSequence implements PdfByteSequence {
  readonly byteLength: number;
  #chunks: readonly LoadedChunk[] = [];

  constructor(byteLength: number) {
    this.byteLength = byteLength;
  }

  add(chunk: LoadedChunk): void {
    this.#chunks = [...this.#chunks, chunk]
      .toSorted((left, right) => left.start - right.start);
  }

  byteAt(offset: number): number | undefined {
    if (offset < 0 || offset >= this.byteLength) return undefined;
    const chunk = this.#findChunk(offset);
    return chunk?.bytes[offset - chunk.start];
  }

  slice(start: number, end: number): Uint8Array {
    const boundedStart = Math.max(0, Math.min(this.byteLength, start));
    const boundedEnd = Math.max(boundedStart, Math.min(this.byteLength, end));
    const result = new Uint8Array(boundedEnd - boundedStart);
    let cursor = boundedStart;
    for (const chunk of this.#chunks) {
      const overlapStart = Math.max(boundedStart, chunk.start);
      const overlapEnd = Math.min(boundedEnd, chunk.end);
      if (overlapStart >= overlapEnd) continue;
      if (overlapStart > cursor) {
        throw new RangeError("PDF byte range has not been loaded.");
      }
      result.set(
        chunk.bytes.subarray(overlapStart - chunk.start, overlapEnd - chunk.start),
        overlapStart - boundedStart,
      );
      cursor = Math.max(cursor, overlapEnd);
    }
    if (cursor < boundedEnd) {
      throw new RangeError("PDF byte range has not been loaded.");
    }
    return result;
  }

  #findChunk(offset: number): LoadedChunk | undefined {
    let lower = 0;
    let upper = this.#chunks.length - 1;
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      const chunk = this.#chunks[middle];
      if (chunk === undefined) return undefined;
      if (offset < chunk.start) upper = middle - 1;
      else if (offset >= chunk.end) lower = middle + 1;
      else return chunk;
    }
    return undefined;
  }
}

function missingRanges(start: number, end: number, loaded: readonly LoadedRange[]): readonly LoadedRange[] {
  const missing: LoadedRange[] = [];
  let cursor = start;
  for (const range of loaded) {
    if (range.end <= cursor) {
      continue;
    }
    if (range.start >= end) {
      break;
    }
    if (range.start > cursor) {
      missing.push({ start: cursor, end: Math.min(range.start, end) });
    }
    cursor = Math.max(cursor, range.end);
    if (cursor >= end) {
      break;
    }
  }
  if (cursor < end) {
    missing.push({ start: cursor, end });
  }
  return missing;
}

function mergeLoadedRange(loaded: readonly LoadedRange[], added: LoadedRange): readonly LoadedRange[] {
  const ranges = [...loaded, added].toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: LoadedRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous === undefined || previous.end < range.start) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
  }
  return merged;
}

export class PdfSourceLimitError extends Error {
  readonly byteLength: number;
  readonly maxBytes: number;

  constructor(byteLength: number, maxBytes: number) {
    super(`PDF source length ${String(byteLength)} exceeds the ${String(maxBytes)} byte limit.`);
    this.name = "PdfSourceLimitError";
    this.byteLength = byteLength;
    this.maxBytes = maxBytes;
  }
}

function sourceDescriptor(source: PdfSource): PdfSourceDescriptor {
  return {
    kind: source.kind,
    ...(source.fileName !== undefined ? { fileName: source.fileName } : {}),
    ...(source.mediaType !== undefined ? { mediaType: source.mediaType } : {}),
    ...(source.sha256 !== undefined ? { sha256: source.sha256 } : {}),
  };
}

function validateRange(offset: number, length: number, byteLength: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > byteLength) {
    throw new RangeError("PDF read offset must be a safe integer inside the source.");
  }
  if (!Number.isSafeInteger(length) || length < 0 || offset + length > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("PDF read length must be a non-negative safe integer.");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
  }
}
