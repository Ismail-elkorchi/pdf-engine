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
  PdfRenderDocument,
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
  const mode = overrides?.mode ?? defaults?.mode ?? "off";
  return {
    mode,
    ...(overrides?.provider !== undefined ? { provider: overrides.provider } : defaults?.provider !== undefined ? { provider: defaults.provider } : {}),
    languages: normalizeOcrLanguages(overrides?.languages ?? defaults?.languages),
    minConfidence: clampConfidence(overrides?.minConfidence ?? defaults?.minConfidence ?? DEFAULT_OCR_MIN_CONFIDENCE),
    maxPages: Math.max(0, Math.floor(overrides?.maxPages ?? defaults?.maxPages ?? DEFAULT_OCR_MAX_PAGES)),
    timeoutMilliseconds: Math.max(1, Math.floor(overrides?.timeoutMilliseconds ?? defaults?.timeoutMilliseconds ?? DEFAULT_OCR_TIMEOUT_MILLISECONDS)),
  };
}

export function collectOcrPageImages(render: PdfRenderDocument | undefined): ReadonlyMap<number, PdfOcrPageImage> {
  const images = new Map<number, PdfOcrPageImage>();
  for (const page of render?.pages ?? []) {
    const raster = page.imagery?.raster;
    if (raster === undefined) {
      continue;
    }
    images.set(page.pageNumber, {
      bytes: raster.bytes,
      mimeType: raster.mimeType,
      width: raster.width,
      height: raster.height,
    });
  }
  return images;
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

    const acceptedLines = providerResult.lines
      .map((line, lineIndex) => ({ line, lineIndex }))
      .filter(({ line }) => shouldAcceptOcrLine(line, options.minConfidence));
    const rejectedLineCount = Math.max(0, providerResult.lines.length - acceptedLines.length);
    if (acceptedLines.length === 0) {
      knownLimits.add("ocr-low-confidence");
      evidencePages.push(createPageEvidence(page.pageNumber, {
        providerName: options.provider.name,
        decision: providerResult.lines.length === 0 ? "failed" : "low-confidence",
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
      provider.recognizePage({ ...input, signal: controller.signal }).catch((error: unknown) => ({
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
  const normalized = (languages ?? DEFAULT_OCR_LANGUAGES)
    .map((language) => language.trim())
    .filter((language) => language.length > 0);
  return normalized.length === 0 ? DEFAULT_OCR_LANGUAGES : [...new Set(normalized)];
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_OCR_MIN_CONFIDENCE;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeOcrText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function dedupeKnownLimits(values: readonly PdfKnownLimitCode[]): readonly PdfKnownLimitCode[] {
  return [...new Set(values)];
}
