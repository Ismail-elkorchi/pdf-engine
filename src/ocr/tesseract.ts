import type {
  PdfBoundingBox,
  PdfOcrPageInput,
  PdfOcrPageResult,
  PdfOcrProvider,
  PdfOcrTextLine,
} from "../contracts.ts";

/**
 * Minimal Tesseract-compatible line shape consumed by the provider helper.
 */
export interface PdfTesseractRecognitionLine {
  /** Recognized line text. */
  readonly text?: string;
  /** Tesseract line confidence as either 0..1 or 0..100. */
  readonly confidence?: number;
  /** Tesseract line bounds in image pixel coordinates. */
  readonly bbox?: {
    /** Left bound. */
    readonly x0?: number;
    /** Top bound. */
    readonly y0?: number;
    /** Right bound. */
    readonly x1?: number;
    /** Bottom bound. */
    readonly y1?: number;
  };
}

/**
 * Minimal recognition result shape consumed from a Tesseract-compatible worker.
 */
export interface PdfTesseractRecognitionResult {
  /** Recognition payload returned by the worker. */
  readonly data?: {
    /** Full recognized text fallback. */
    readonly text?: string;
    /** Full-result confidence as either 0..1 or 0..100. */
    readonly confidence?: number;
    /** Recognized text lines when the worker exposes line segmentation. */
    readonly lines?: readonly PdfTesseractRecognitionLine[];
  };
}

/**
 * Minimal worker shape used by the optional Tesseract OCR provider.
 */
export interface PdfTesseractWorker {
  /** Recognizes text from image bytes. */
  recognize(image: Uint8Array): Promise<PdfTesseractRecognitionResult>;
  /** Releases worker resources when the loaded module supports termination. */
  terminate?(): Promise<void>;
}

/**
 * Minimal Tesseract-compatible module shape loaded by callers.
 */
export interface PdfTesseractModule {
  /** Creates or returns a worker for the requested languages. */
  createWorker(languages?: string | readonly string[]): Promise<PdfTesseractWorker> | PdfTesseractWorker;
}

/**
 * Options for the optional Tesseract OCR provider helper.
 */
export interface PdfTesseractOcrProviderOptions {
  /** Loads a caller-supplied Tesseract-compatible module. */
  readonly loadModule: () => Promise<PdfTesseractModule>;
}

/**
 * Creates an OCR provider backed by a caller-supplied Tesseract-compatible module.
 *
 * The helper does not import Tesseract.js, fetch trained data, or choose a model. Callers own
 * dependency loading, worker configuration, language data, and deployment policy.
 */
export function createTesseractOcrProvider(options: PdfTesseractOcrProviderOptions): PdfOcrProvider {
  let workerPromise: Promise<PdfTesseractWorker> | undefined;

  async function getWorker(languages: readonly string[]): Promise<PdfTesseractWorker> {
    workerPromise ??= options.loadModule().then(async (module) => await module.createWorker(languages));
    return await workerPromise;
  }

  return {
    name: "tesseract.js",
    async recognizePage(input: PdfOcrPageInput): Promise<PdfOcrPageResult> {
      if (input.pageImage === undefined) {
        throw new Error("Tesseract OCR requires a page image.");
      }

      const worker = await getWorker(input.languages);
      const result = await worker.recognize(input.pageImage.bytes);
      const lines = normalizeTesseractLines(result);
      return {
        pageNumber: input.pageNumber,
        lines,
      };
    },
    async dispose(): Promise<void> {
      const worker = await workerPromise;
      await worker?.terminate?.();
      workerPromise = undefined;
    },
  };
}

function normalizeTesseractLines(result: PdfTesseractRecognitionResult): readonly PdfOcrTextLine[] {
  const rawLines = result.data?.lines ?? [];
  const lines = rawLines
    .map((line) => {
      const bbox = toBoundingBox(line.bbox);
      return {
        text: normalizeText(line.text ?? ""),
        ...(line.confidence === undefined ? {} : { confidence: normalizeConfidence(line.confidence) }),
        ...(bbox === undefined ? {} : { bbox }),
      };
    })
    .filter((line) => line.text.length > 0);
  if (lines.length > 0) {
    return lines;
  }

  const text = normalizeText(result.data?.text ?? "");
  if (text.length === 0) {
    return [];
  }

  return [{
    text,
    ...(result.data?.confidence === undefined ? {} : { confidence: normalizeConfidence(result.data.confidence) }),
  }];
}

function toBoundingBox(bbox: PdfTesseractRecognitionLine["bbox"]): PdfBoundingBox | undefined {
  if (
    bbox === undefined ||
    bbox.x0 === undefined ||
    bbox.y0 === undefined ||
    bbox.x1 === undefined ||
    bbox.y1 === undefined
  ) {
    return undefined;
  }

  return {
    x: bbox.x0,
    y: bbox.y0,
    width: Math.max(0, bbox.x1 - bbox.x0),
    height: Math.max(0, bbox.y1 - bbox.y0),
  };
}

function normalizeConfidence(confidence: number): number {
  return confidence > 1 ? Math.max(0, Math.min(1, confidence / 100)) : Math.max(0, Math.min(1, confidence));
}

function normalizeText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}
