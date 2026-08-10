import type { PdfNormalizedResourceBudget } from "./public-api.ts";

export type PdfBudgetKind =
  | "objects"
  | "pages"
  | "depth"
  | "decoded-bytes"
  | "operators"
  | "image-pixels"
  | "ocr-pixels"
  | "cache-bytes";

export class PdfBudgetExceededError extends Error {
  readonly kind: PdfBudgetKind;
  readonly limit: number;

  constructor(kind: PdfBudgetKind, limit: number) {
    super(`PDF ${kind} budget of ${String(limit)} was exceeded.`);
    this.name = "PdfBudgetExceededError";
    this.kind = kind;
    this.limit = limit;
  }
}

export class PdfBudgetTracker {
  readonly limits: PdfNormalizedResourceBudget;
  #objects = 0;
  #pages = 0;
  #decodedBytes = 0;
  #operators = 0;
  #imagePixels = 0;
  #ocrPixels = 0;
  #cacheBytes = 0;
  readonly #imagePixelKeys = new Set<string>();
  readonly #ocrPixelKeys = new Set<string>();

  constructor(limits: PdfNormalizedResourceBudget) {
    this.limits = limits;
  }

  object(): void {
    this.#objects = this.#next("objects", this.#objects, 1, this.limits.maxObjects);
  }

  page(): void {
    this.#pages = this.#next("pages", this.#pages, 1, this.limits.maxPages);
  }

  depth(depth: number): void {
    this.#assert("depth", depth, this.limits.maxRecursionDepth);
  }

  decodedBytes(count: number): void {
    this.#decodedBytes = this.#next("decoded-bytes", this.#decodedBytes, count, this.limits.maxDecodedBytes);
  }

  operator(count: number = 1): void {
    this.#operators = this.#next("operators", this.#operators, count, this.limits.maxOperators);
  }

  imagePixels(count: number, key?: string): void {
    if (key !== undefined && this.#imagePixelKeys.has(key)) {
      return;
    }
    this.#imagePixels = this.#next("image-pixels", this.#imagePixels, count, this.limits.maxImagePixels);
    if (key !== undefined) {
      this.#imagePixelKeys.add(key);
    }
  }

  ocrPixels(count: number, key?: string): void {
    if (key !== undefined && this.#ocrPixelKeys.has(key)) {
      return;
    }
    this.#ocrPixels = this.#next("ocr-pixels", this.#ocrPixels, count, this.limits.maxOcrPixels);
    if (key !== undefined) {
      this.#ocrPixelKeys.add(key);
    }
  }

  cacheBytes(count: number): void {
    this.#cacheBytes = this.#next("cache-bytes", this.#cacheBytes, count, this.limits.maxCacheBytes);
  }

  #next(kind: PdfBudgetKind, current: number, count: number, limit: number): number {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new PdfBudgetExceededError(kind, limit);
    }
    const next = current + count;
    this.#assert(kind, next, limit);
    return next;
  }

  #assert(kind: PdfBudgetKind, value: number, limit: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > limit) {
      throw new PdfBudgetExceededError(kind, limit);
    }
  }
}
