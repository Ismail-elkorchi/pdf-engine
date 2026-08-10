import type { PdfSource, PdfSourceDescriptor } from "./public-api.ts";

export interface PdfByteSource {
  readonly descriptor: PdfSourceDescriptor;
  readonly byteLength: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
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

export async function materializePdfSource(
  source: PdfByteSource,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (source.byteLength > maxBytes) {
    throw new PdfSourceLimitError(source.byteLength, maxBytes);
  }

  const output = new Uint8Array(source.byteLength);
  const chunkSize = 1_048_576;
  for (let offset = 0; offset < source.byteLength; offset += chunkSize) {
    throwIfAborted(signal);
    const chunk = await source.read(offset, Math.min(chunkSize, source.byteLength - offset), signal);
    output.set(chunk, offset);
  }
  return output;
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
