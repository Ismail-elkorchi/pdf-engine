import { buildObservationParagraphText } from "./layout.ts";

import type {
  PdfDiagnostic,
  PdfDocumentSource,
  PdfKnownLimitCode,
  PdfObservedDocument,
  PdfObservedGlyph,
  PdfObservedPage,
  PdfObservedTextMark,
  PdfObservedTextRun,
  PdfOcrDocumentEvidence,
  PdfOcrFusionDecision,
  PdfOcrOptions,
  PdfOcrPageEvidence,
  PdfOcrPageImage,
  PdfOcrPageInput,
  PdfOcrPageReason,
  PdfOcrPageResult,
  PdfOcrProvider,
  PdfOcrTextLine,
} from "./contracts.ts";

const DEFAULT_OCR_LANGUAGES = ["eng"] as const;
const DEFAULT_OCR_MIN_CONFIDENCE = 0.5;
const DEFAULT_OCR_MAX_PAGES = 25;
const DEFAULT_OCR_TIMEOUT_MILLISECONDS = 30_000;

export interface PdfResolvedOcrOptions {
  readonly mode: "off" | "auto" | "always";
  readonly provider?: PdfOcrProvider;
  readonly languages: readonly string[];
  readonly minConfidence: number;
  readonly maxPages: number;
  readonly timeoutMilliseconds: number;
}

export interface PdfOcrFusionInput {
  readonly source: PdfDocumentSource;
  readonly observation: PdfObservedDocument;
  readonly options: PdfResolvedOcrOptions;
  readonly pageImages?: ReadonlyMap<number, PdfOcrPageImage>;
}

export interface PdfOcrFusionResult {
  readonly observation: PdfObservedDocument;
  readonly diagnostics: readonly PdfDiagnostic[];
}

interface AcceptedOcrLine {
  readonly line: PdfOcrTextLine;
  readonly lineIndex: number;
}

export function resolveOcrOptions(
  defaults: PdfOcrOptions | undefined,
  overrides: PdfOcrOptions | undefined,
): PdfResolvedOcrOptions {
  const mode = validateOcrMode(overrides?.mode ?? defaults?.mode ?? "off");
  const provider = overrides?.provider ?? defaults?.provider;
  if (
    provider !== undefined &&
    (typeof provider.name !== "string" || provider.name.trim().length === 0 || typeof provider.recognizePage !== "function")
  ) {
    throw new TypeError("OCR providers require a non-empty name and a recognizePage function.");
  }
  return {
    mode,
    ...(provider !== undefined ? { provider } : {}),
    languages: normalizeOcrLanguages(overrides?.languages ?? defaults?.languages),
    minConfidence: validateConfidence(overrides?.minConfidence ?? defaults?.minConfidence ?? DEFAULT_OCR_MIN_CONFIDENCE),
    maxPages: validateNonNegativeInteger(overrides?.maxPages ?? defaults?.maxPages ?? DEFAULT_OCR_MAX_PAGES, "OCR maxPages"),
    timeoutMilliseconds: validatePositiveInteger(
      overrides?.timeoutMilliseconds ?? defaults?.timeoutMilliseconds ?? DEFAULT_OCR_TIMEOUT_MILLISECONDS,
      "OCR timeoutMilliseconds",
    ),
  };
}

export async function applyOcrToObservation(input: PdfOcrFusionInput): Promise<PdfOcrFusionResult> {
  const diagnostics: PdfDiagnostic[] = [];
  const { options } = input;
  if (options.mode === "off") {
    return { observation: input.observation, diagnostics };
  }

  const selectedPages = selectOcrPages(input.observation.pages, options.mode).slice(0, options.maxPages);
  if (selectedPages.length === 0) {
    return {
      observation: {
        ...input.observation,
        ocr: {
          mode: options.mode,
          ...(options.provider !== undefined ? { providerName: options.provider.name } : {}),
          languages: options.languages,
          pages: [],
        },
      },
      diagnostics,
    };
  }

  if (options.provider === undefined) {
    const evidence: PdfOcrDocumentEvidence = {
      mode: options.mode,
      languages: options.languages,
      pages: selectedPages.map(({ page, reason }) =>
        createPageEvidence(page.pageNumber, {
          decision: "provider-unavailable",
          reason,
          acceptedLineCount: 0,
          rejectedLineCount: 0,
          diagnostics: ["OCR was requested but no provider was configured."],
        })
      ),
    };
    diagnostics.push(createOcrDiagnostic("ocr-provider-unavailable", "OCR was requested but no provider was configured."));
    return {
      observation: {
        ...input.observation,
        ocr: evidence,
        knownLimits: dedupeKnownLimits([...input.observation.knownLimits, "ocr-provider-unavailable"]),
      },
      diagnostics,
    };
  }

  const pages: PdfObservedPage[] = [];
  const evidencePages: PdfOcrPageEvidence[] = [];
  const knownLimits = new Set<PdfKnownLimitCode>(input.observation.knownLimits);

  for (const page of input.observation.pages) {
    const selectedPage = selectedPages.find((candidate) => candidate.page.pageNumber === page.pageNumber);
    if (selectedPage === undefined) {
      pages.push(page);
      continue;
    }

    const pageImage = input.pageImages?.get(page.pageNumber);
    const providerInput: PdfOcrPageInput = {
      source: input.source,
      pageNumber: page.pageNumber,
      ...(page.pageRef !== undefined ? { pageRef: page.pageRef } : {}),
      reason: selectedPage.reason,
      languages: options.languages,
      ...(pageImage !== undefined ? { pageImage } : {}),
    };
    const providerResult = await recognizeWithTimeout(options.provider, providerInput, options.timeoutMilliseconds);
    if (providerResult === "timeout") {
      knownLimits.add("ocr-timeout");
      diagnostics.push(createOcrDiagnostic("ocr-timeout", `OCR provider timed out on page ${String(page.pageNumber)}.`));
      evidencePages.push(createPageEvidence(page.pageNumber, {
        providerName: options.provider.name,
        decision: "timeout",
        reason: selectedPage.reason,
        acceptedLineCount: 0,
        rejectedLineCount: 0,
        diagnostics: ["OCR provider timed out."],
      }));
      pages.push(page);
      continue;
    }

    if ("error" in providerResult) {
      diagnostics.push({
        code: "ocr-provider-failed",
        stage: "observation",
        level: "medium",
        message: `OCR provider failed on page ${String(page.pageNumber)}: ${providerResult.error}`,
      });
      evidencePages.push(createPageEvidence(page.pageNumber, {
        providerName: options.provider.name,
        decision: "failed",
        reason: selectedPage.reason,
        acceptedLineCount: 0,
        rejectedLineCount: 0,
        diagnostics: [providerResult.error],
      }));
      pages.push(page);
      continue;
    }

    const normalizedLines = normalizeOcrLineBounds(providerResult.lines, pageImage);
    const acceptedLines = normalizedLines
      .map((line, lineIndex) => ({ line, lineIndex }))
      .filter(({ line }) => shouldAcceptOcrLine(line, options.minConfidence));
    const rejectedLineCount = Math.max(0, normalizedLines.length - acceptedLines.length);
    if (acceptedLines.length === 0) {
      knownLimits.add("ocr-low-confidence");
      evidencePages.push(createPageEvidence(page.pageNumber, {
        providerName: options.provider.name,
        decision: normalizedLines.length === 0 ? "failed" : "low-confidence",
        reason: selectedPage.reason,
        acceptedLineCount: 0,
        rejectedLineCount,
        diagnostics: providerResult.diagnostics ?? [],
      }));
      pages.push(page);
      continue;
    }

    knownLimits.add("ocr-fusion-heuristic");
    if (rejectedLineCount > 0) {
      knownLimits.add("ocr-low-confidence");
    }
    pages.push(mergeOcrLinesIntoPage(page, acceptedLines));
    evidencePages.push(createPageEvidence(page.pageNumber, {
      providerName: options.provider.name,
      decision: "applied",
      reason: selectedPage.reason,
      acceptedLineCount: acceptedLines.length,
      rejectedLineCount,
      diagnostics: providerResult.diagnostics ?? [],
    }));
  }

  const observation: PdfObservedDocument = {
    ...input.observation,
    pages,
    extractedText: buildObservationParagraphText({
      ...input.observation,
      pages,
    }),
    ocr: {
      mode: options.mode,
      providerName: options.provider.name,
      languages: options.languages,
      pages: evidencePages,
    },
    knownLimits: [...knownLimits],
  };

  return { observation, diagnostics };
}

function normalizeOcrLineBounds(
  lines: readonly PdfOcrTextLine[],
  pageImage: PdfOcrPageImage | undefined,
): readonly PdfOcrTextLine[] {
  if (
    pageImage?.contentBounds === undefined || pageImage.width === undefined || pageImage.height === undefined ||
    pageImage.width <= 0 || pageImage.height <= 0
  ) {
    return lines;
  }
  const imageWidth = pageImage.width;
  const imageHeight = pageImage.height;
  const target = pageImage.contentBounds;
  return lines.map((line) => {
    if (line.bbox === undefined) {
      return line;
    }
    return {
      ...line,
      bbox: {
        x: target.x + line.bbox.x / imageWidth * target.width,
        y: target.y + (imageHeight - line.bbox.y - line.bbox.height) / imageHeight * target.height,
        width: line.bbox.width / imageWidth * target.width,
        height: line.bbox.height / imageHeight * target.height,
      },
    };
  });
}

function selectOcrPages(
  pages: readonly PdfObservedPage[],
  mode: "auto" | "always",
): readonly { readonly page: PdfObservedPage; readonly reason: PdfOcrPageReason }[] {
  if (mode === "always") {
    return pages.map((page) => ({ page, reason: "explicit" }));
  }

  return pages
    .filter((page) => page.runs.length === 0 && pageHasRasterizableEvidence(page))
    .map((page) => ({ page, reason: "no-native-text" }));
}

function pageHasRasterizableEvidence(page: PdfObservedPage): boolean {
  return page.marks.some((mark) => mark.kind === "image" || mark.kind === "xobject");
}

async function recognizeWithTimeout(
  provider: PdfOcrProvider,
  input: PdfOcrPageInput,
  timeoutMilliseconds: number,
): Promise<PdfOcrPageResult | "timeout" | { readonly error: string }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, timeoutMilliseconds);
    });
    return await Promise.race([
      Promise.resolve()
        .then(async () => provider.recognizePage({ ...input, signal: controller.signal }))
        .then((result) => validateOcrResult(result, input.pageNumber))
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        })),
      timeoutPromise,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function shouldAcceptOcrLine(line: PdfOcrTextLine, minConfidence: number): boolean {
  return normalizeOcrText(line.text).length > 0 && (line.confidence === undefined || line.confidence >= minConfidence);
}

function mergeOcrLinesIntoPage(
  page: PdfObservedPage,
  lines: readonly AcceptedOcrLine[],
): PdfObservedPage {
  const nextContentOrder = Math.max(-1, ...page.marks.map((mark) => mark.contentOrder), ...page.runs.map((run) => run.contentOrder)) + 1;
  const glyphs: PdfObservedGlyph[] = [];
  const runs: PdfObservedTextRun[] = [];
  const marks: PdfObservedTextMark[] = [];

  for (const [acceptedIndex, { line, lineIndex }] of lines.entries()) {
    const text = normalizeOcrText(line.text);
    const contentOrder = nextContentOrder + acceptedIndex;
    const runId = `ocr-run-${page.pageNumber}-${lineIndex + 1}`;
    const glyphIds = Array.from(text).map((_, glyphIndex) => `ocr-glyph-${page.pageNumber}-${lineIndex + 1}-${glyphIndex + 1}`);
    glyphs.push(...Array.from(text).map((character, glyphIndex) => ({
      id: glyphIds[glyphIndex] ?? `ocr-glyph-${page.pageNumber}-${lineIndex + 1}-${glyphIndex + 1}`,
      pageNumber: page.pageNumber,
      glyphIndex,
      contentOrder,
      text: character,
      unicodeCodePoint: character.codePointAt(0) ?? 0,
      hidden: false,
      origin: "ocr" as const,
      ...(line.bbox !== undefined ? { bbox: line.bbox } : {}),
    })));
    runs.push({
      id: runId,
      pageNumber: page.pageNumber,
      contentOrder,
      text,
      glyphIds,
      origin: "ocr",
      startsNewLine: true,
      ...(line.bbox !== undefined ? { bbox: line.bbox, anchor: { x: line.bbox.x, y: line.bbox.y + line.bbox.height } } : {}),
    });
    marks.push({
      id: `ocr-text-${page.pageNumber}-${lineIndex + 1}`,
      kind: "text",
      pageNumber: page.pageNumber,
      contentOrder,
      runId,
      glyphIds,
      text,
      origin: "ocr",
      startsNewLine: true,
      ...(line.bbox !== undefined ? { bbox: line.bbox, anchor: { x: line.bbox.x, y: line.bbox.y + line.bbox.height } } : {}),
    });
  }

  return {
    ...page,
    glyphs: [...page.glyphs, ...glyphs],
    runs: [...page.runs, ...runs],
    marks: [...page.marks, ...marks].toSorted((left, right) => left.contentOrder - right.contentOrder),
  };
}

function createPageEvidence(
  pageNumber: number,
  input: {
    readonly providerName?: string;
    readonly decision: PdfOcrFusionDecision;
    readonly reason: PdfOcrPageReason;
    readonly acceptedLineCount: number;
    readonly rejectedLineCount: number;
    readonly diagnostics: readonly string[];
  },
): PdfOcrPageEvidence {
  return {
    pageNumber,
    ...(input.providerName !== undefined ? { providerName: input.providerName } : {}),
    decision: input.decision,
    reason: input.reason,
    acceptedLineCount: input.acceptedLineCount,
    rejectedLineCount: input.rejectedLineCount,
    diagnostics: input.diagnostics,
  };
}

function createOcrDiagnostic(code: PdfKnownLimitCode, message: string): PdfDiagnostic {
  return {
    code,
    stage: "observation",
    level: "medium",
    message,
  };
}

function normalizeOcrLanguages(languages: readonly string[] | undefined): readonly string[] {
  const candidate: unknown = languages ?? DEFAULT_OCR_LANGUAGES;
  if (!Array.isArray(candidate)) {
    throw new TypeError("OCR languages must be non-empty strings.");
  }
  const normalized: string[] = [];
  for (const value of candidate as readonly unknown[]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError("OCR languages must be non-empty strings.");
    }
    normalized.push(value.trim());
  }
  if (normalized.length === 0) {
    throw new TypeError("OCR languages must contain at least one language.");
  }
  return [...new Set(normalized)];
}

function validateOcrMode(value: PdfOcrOptions["mode"]): PdfResolvedOcrOptions["mode"] {
  if (value !== "off" && value !== "auto" && value !== "always") {
    throw new TypeError("OCR mode must be off, auto, or always.");
  }
  return value;
}

function validateConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("OCR minConfidence must be a finite number from 0 through 1.");
  }
  return value;
}

function validateNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function validateOcrResult(result: PdfOcrPageResult, pageNumber: number): PdfOcrPageResult {
  const candidate: unknown = result;
  if (!isRecord(candidate) || candidate["pageNumber"] !== pageNumber || !Array.isArray(candidate["lines"])) {
    throw new TypeError("OCR results must identify the requested page and contain a lines array.");
  }
  for (const line of candidate["lines"] as readonly unknown[]) {
    if (
      !isRecord(line) || typeof line["text"] !== "string" ||
      !isConfidence(line["confidence"]) ||
      (line["bbox"] !== undefined && !isFiniteBounds(line["bbox"]))
    ) {
      throw new TypeError("OCR lines must contain valid text, confidence, and finite non-negative bounds.");
    }
  }
  return result;
}

function isConfidence(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
}

function isFiniteBounds(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const x = value["x"];
  const y = value["y"];
  const width = value["width"];
  const height = value["height"];
  return typeof x === "number" && Number.isFinite(x) &&
    typeof y === "number" && Number.isFinite(y) &&
    typeof width === "number" && Number.isFinite(width) && width >= 0 &&
    typeof height === "number" && Number.isFinite(height) && height >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function normalizeOcrText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function dedupeKnownLimits(values: readonly PdfKnownLimitCode[]): readonly PdfKnownLimitCode[] {
  return [...new Set(values)];
}
