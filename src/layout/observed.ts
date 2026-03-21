import {
  decodePdfCidHexTextWithKnownCollectionMap,
  type PdfCidCollectionIdentifier,
} from "../cid-collection-unicode.ts";
import { decodePdfHexTextWithUnicodeCMap, parsePdfUnicodeCMap } from "../cmap.ts";
import {
  buildPdfSingleByteFontEncoding,
  decodePdfSingleByteHexText,
  decodePdfSingleByteLiteralText,
  type PdfSingleByteFontEncoding,
} from "../font-encoding.ts";
import { hasDetectedFeatureFinding } from "../pdf-feature-findings.ts";
import {
  decodePdfLiteral,
  keyOfObjectRef,
  parseTextOperatorRuns,
  type ParsedTextOperatorRun,
  type PdfShellAnalysis,
} from "../shell-parse.ts";
import { parseTrueTypeGlyphUnicodeMap } from "../truetype-cmap.ts";

import type {
  PdfDiagnostic,
  PdfFeatureFinding,
  PdfObjectRef,
  PdfObservedGlyph,
  PdfObservedPage,
  PdfObservedTextRun,
  PdfTextEncodingKind,
  PdfUnicodeMappingSource,
  PdfWritingMode,
} from "../contracts.ts";

interface PdfEmbeddedFontMapping {
  readonly glyphUnicodeByGlyphId: ReadonlyMap<number, string>;
  readonly cidToGidByCid?: ReadonlyMap<number, number>;
  readonly requiresExplicitCidToGidMap: boolean;
}

interface PdfTextDecodeResult {
  readonly text: string;
  readonly complete: boolean;
  readonly mappingSource: PdfUnicodeMappingSource;
  readonly sourceUnitCount: number;
  readonly mappedUnitCount: number;
}

export interface PdfObservationInspection {
  readonly analysis: PdfShellAnalysis;
  readonly featureFindings: readonly PdfFeatureFinding[];
}

export interface PdfObservedPagesBuildResult {
  readonly pages: readonly PdfObservedPage[];
  readonly hasFontMappingGap: boolean;
  readonly hasLiteralFontEncodingGap: boolean;
}

export function buildObservedPages(
  inspection: PdfObservationInspection,
  diagnostics: PdfDiagnostic[],
): PdfObservedPagesBuildResult {
  let hasFontMappingGap = false;
  let hasLiteralFontEncodingGap = false;
  const observedPages = inspection.analysis.pageEntries.map((pageEntry) => {
    const observedPage = buildObservedPage(pageEntry, inspection);
    hasFontMappingGap = hasFontMappingGap || observedPage.hasFontMappingGap;
    hasLiteralFontEncodingGap = hasLiteralFontEncodingGap || observedPage.hasLiteralFontEncodingGap;
    return observedPage.page;
  });

  const hasTextRuns = observedPages.some((page) => page.runs.length > 0);
  if (hasTextRuns || inspection.analysis.pageEntries.length > 0) {
    return { pages: observedPages, hasFontMappingGap, hasLiteralFontEncodingGap };
  }

  diagnostics.push({
    code: "observation-page-fallback",
    stage: "observation",
    level: "medium",
    message: "The parser could not resolve the page tree, so observation fell back to all stream objects in source order.",
  });

  const fallbackStreamRefs = inspection.analysis.indirectObjects
    .filter((objectShell) => objectShell.hasStream && typeof objectShell.streamText === "string")
    .map((objectShell) => objectShell.ref);

  const fallbackPage = buildObservedPage(
    {
      pageNumber: 1,
      contentStreamRefs: fallbackStreamRefs,
      fontBindings: [],
    },
    inspection,
    "stream-fallback",
  );
  return {
    pages: [fallbackPage.page],
    hasFontMappingGap: hasFontMappingGap || fallbackPage.hasFontMappingGap,
    hasLiteralFontEncodingGap: hasLiteralFontEncodingGap || fallbackPage.hasLiteralFontEncodingGap,
  };
}

function buildObservedPage(
  pageEntry: {
    readonly pageNumber: number;
    readonly pageRef?: PdfObjectRef;
    readonly contentStreamRefs: readonly PdfObjectRef[];
    readonly fontBindings: readonly { readonly resourceName: string; readonly fontRef: PdfObjectRef }[];
  },
  inspection: PdfObservationInspection,
  resolutionMethodOverride?: "page-tree" | "recovered-page-order" | "stream-fallback",
): { page: PdfObservedPage; hasFontMappingGap: boolean; hasLiteralFontEncodingGap: boolean } {
  const resolutionMethod = resolutionMethodOverride ??
    (inspection.analysis.pageTreeResolved ? "page-tree" : "recovered-page-order");
  const pageNumber = pageEntry.pageNumber;
  const glyphs: PdfObservedGlyph[] = [];
  const runs: PdfObservedTextRun[] = [];
  let contentOrder = 0;
  let fontMappingGapCount = 0;
  let literalFontEncodingGapCount = 0;
  let hasSevereFontMappingGap = false;
  let hasSevereLiteralFontEncodingGap = false;
  const fontRefByResourceName = new Map(pageEntry.fontBindings.map((binding) => [binding.resourceName, binding.fontRef] as const));
  const unicodeCMapByFontKey = new Map<string, ReturnType<typeof parsePdfUnicodeCMap>>();
  const embeddedFontMappingByFontKey = new Map<string, PdfEmbeddedFontMapping | undefined>();
  const singleByteFontEncodingByFontKey = new Map<string, PdfSingleByteFontEncoding | undefined>();

  for (const contentStreamRef of pageEntry.contentStreamRefs) {
    const contentStream = inspection.analysis.objectIndex.get(keyOfObjectRef(contentStreamRef));
    if (!contentStream?.streamText) {
      continue;
    }

    const parsedRuns = parseTextOperatorRuns(contentStream.streamText);
    for (const parsedRun of parsedRuns) {
      const observedRun = observeParsedTextRun(
        parsedRun,
        fontRefByResourceName,
        unicodeCMapByFontKey,
        embeddedFontMappingByFontKey,
        singleByteFontEncodingByFontKey,
        inspection,
      );
      if (observedRun.hasFontMappingGap) {
        fontMappingGapCount += 1;
      }
      if (observedRun.hasLiteralFontEncodingGap) {
        literalFontEncodingGapCount += 1;
      }
      hasSevereFontMappingGap = hasSevereFontMappingGap || observedRun.hasSevereFontMappingGap;
      hasSevereLiteralFontEncodingGap =
        hasSevereLiteralFontEncodingGap || observedRun.hasSevereLiteralFontEncodingGap;
      if (observedRun.text.length === 0) {
        continue;
      }

      const glyphIds: string[] = [];
      const codePoints = Array.from(observedRun.text);

      for (const [glyphIndex, text] of codePoints.entries()) {
        const glyphId = `glyph-${pageNumber}-${contentOrder + 1}-${glyphIndex + 1}`;
        glyphIds.push(glyphId);
        glyphs.push({
          id: glyphId,
          pageNumber,
          glyphIndex,
          contentOrder,
          text,
          unicodeCodePoint: text.codePointAt(0) ?? 0,
          hidden: false,
          origin: "native-text",
          contentStreamRef,
          ...(observedRun.fontRef !== undefined ? { fontRef: observedRun.fontRef } : {}),
          ...(observedRun.textEncodingKind !== undefined ? { textEncodingKind: observedRun.textEncodingKind } : {}),
          ...(observedRun.unicodeMappingSource !== undefined
            ? { unicodeMappingSource: observedRun.unicodeMappingSource }
            : {}),
          ...(observedRun.writingMode !== undefined ? { writingMode: observedRun.writingMode } : {}),
          objectRef: contentStreamRef,
          ...(observedRun.anchor !== undefined ? { anchor: observedRun.anchor } : {}),
          ...(observedRun.fontSize !== undefined ? { fontSize: observedRun.fontSize } : {}),
          ...(observedRun.startsNewLine ? { startsNewLine: true } : {}),
        });
      }

      runs.push({
        id: `run-${pageNumber}-${contentOrder + 1}`,
        pageNumber,
        contentOrder,
        text: observedRun.text,
        glyphIds,
        origin: "native-text",
        contentStreamRef,
        ...(observedRun.fontRef !== undefined ? { fontRef: observedRun.fontRef } : {}),
        ...(observedRun.textEncodingKind !== undefined ? { textEncodingKind: observedRun.textEncodingKind } : {}),
        ...(observedRun.unicodeMappingSource !== undefined ? { unicodeMappingSource: observedRun.unicodeMappingSource } : {}),
        ...(observedRun.writingMode !== undefined ? { writingMode: observedRun.writingMode } : {}),
        objectRef: contentStreamRef,
        ...(observedRun.anchor !== undefined ? { anchor: observedRun.anchor } : {}),
        ...(observedRun.fontSize !== undefined ? { fontSize: observedRun.fontSize } : {}),
        ...(observedRun.startsNewLine ? { startsNewLine: true } : {}),
      });

      contentOrder += 1;
    }
  }

  const pageWritingMode = inferObservedPageWritingMode(runs);
  const normalizedRuns = pageWritingMode === undefined ? runs : runs.map((run) => (
    run.writingMode !== undefined ? run : { ...run, writingMode: pageWritingMode }
  ));
  const normalizedGlyphs = pageWritingMode === undefined ? glyphs : glyphs.map((glyph) => (
    glyph.writingMode !== undefined ? glyph : { ...glyph, writingMode: pageWritingMode }
  ));

  const hasFontMappingGap = hasSevereFontMappingGap || fontMappingGapCount > 1;
  const hasLiteralFontEncodingGap =
    hasSevereLiteralFontEncodingGap || literalFontEncodingGapCount > 1;

  return {
    page: {
      pageNumber,
      resolutionMethod,
      ...(pageEntry.pageRef !== undefined ? { pageRef: pageEntry.pageRef } : {}),
      glyphs: normalizedGlyphs,
      runs: normalizedRuns,
    },
    hasFontMappingGap,
    hasLiteralFontEncodingGap,
  };
}

function observeParsedTextRun(
  parsedRun: ParsedTextOperatorRun,
  fontRefByResourceName: ReadonlyMap<string, PdfObjectRef>,
  unicodeCMapByFontKey: Map<string, ReturnType<typeof parsePdfUnicodeCMap>>,
  embeddedFontMappingByFontKey: Map<string, PdfEmbeddedFontMapping | undefined>,
  singleByteFontEncodingByFontKey: Map<string, PdfSingleByteFontEncoding | undefined>,
  inspection: PdfObservationInspection,
): {
  text: string;
  hasFontMappingGap: boolean;
  hasLiteralFontEncodingGap: boolean;
  hasSevereFontMappingGap: boolean;
  hasSevereLiteralFontEncodingGap: boolean;
  fontRef?: PdfObjectRef;
  textEncodingKind?: PdfTextEncodingKind;
  unicodeMappingSource?: PdfUnicodeMappingSource;
  writingMode?: PdfWritingMode;
  anchor?: { readonly x: number; readonly y: number };
  fontSize?: number;
  startsNewLine: boolean;
} {
  let text = "";
  let hasFontMappingGap = false;
  let hasLiteralFontEncodingGap = false;
  let hasSevereFontMappingGap = false;
  let hasSevereLiteralFontEncodingGap = false;
  let textEncodingKind: PdfTextEncodingKind | undefined;
  let unicodeMappingSource: PdfUnicodeMappingSource | undefined;
  let pendingTextAdjustment: number | undefined;
  const fontRef = parsedRun.fontResourceName ? fontRefByResourceName.get(parsedRun.fontResourceName) : undefined;
  const unicodeCMap = fontRef ? resolveUnicodeCMapForFont(fontRef, unicodeCMapByFontKey, inspection) : undefined;
  const cidCollection = fontRef ? resolveCidCollectionForFont(fontRef, inspection) : undefined;
  const embeddedFontMapping = fontRef
    ? resolveEmbeddedFontMappingForFont(fontRef, embeddedFontMappingByFontKey, inspection)
    : undefined;
  const singleByteFontEncoding = fontRef
    ? resolveSingleByteFontEncodingForFont(fontRef, singleByteFontEncodingByFontKey, inspection)
    : undefined;
  const writingMode = fontRef ? resolveWritingModeForFont(fontRef, inspection) : undefined;
  const hasHiddenTextFeature = hasDetectedFeatureFinding(inspection.featureFindings, "hidden-text");
  const fontEncodingSpacingProfile = resolveFontEncodingSpacingProfile(parsedRun);
  const shouldSuppressCompactSpacing = !hasHiddenTextFeature;

  for (const operand of parsedRun.operands) {
    if (operand.kind === "adjustment") {
      pendingTextAdjustment = operand.value;
      continue;
    }

    if (operand.kind === "literal") {
      const rawLiteralText = decodePdfLiteral(operand.token);
      const decodedLiteralText = singleByteFontEncoding
        ? decodePdfSingleByteLiteralText(rawLiteralText, singleByteFontEncoding)
        : undefined;
      const preferredLiteralText = decodedLiteralText && decodedLiteralText.text.length > 0
        ? decodedLiteralText.text
        : rawLiteralText;
      const shouldUseHiddenTextRecovery = hasHiddenTextFeature ||
        parsedRun.markedContentKind !== undefined ||
        parsedRun.actualText !== undefined;

      if (shouldUseHiddenTextRecovery) {
        const sanitizedLiteralText = sanitizeLiteralText(preferredLiteralText);
        const preferredActualText = resolvePreferredActualText(
          parsedRun.actualText,
          sanitizedLiteralText.length > 0 ? sanitizedLiteralText : preferredLiteralText,
        );
        if (preferredActualText !== undefined) {
          text = appendObservedOperandText(text, preferredActualText, pendingTextAdjustment, parsedRun.fontSize);
          pendingTextAdjustment = undefined;
          textEncodingKind = textEncodingKind ?? "literal";
          unicodeMappingSource = unicodeMappingSource ?? "actual-text";
          continue;
        }

        if (sanitizedLiteralText.length > 0 && !looksUnreadableLiteralText(sanitizedLiteralText)) {
          text = appendObservedOperandText(
            text,
            sanitizedLiteralText,
            pendingTextAdjustment,
            parsedRun.fontSize,
            decodedLiteralText ? fontEncodingSpacingProfile : "default",
            shouldSuppressCompactSpacing,
          );
          pendingTextAdjustment = undefined;
          textEncodingKind = textEncodingKind ?? "literal";
          unicodeMappingSource = unicodeMappingSource ?? (decodedLiteralText ? "font-encoding" : "literal");
          const hasMaterialDecodeGap = shouldReportMaterialDecodeGap(decodedLiteralText, parsedRun);
          const shouldReportGap = hasMaterialDecodeGap && !shouldSuppressTrivialDecodeGap(
            fontRef,
            inspection,
            decodedLiteralText,
            sanitizedLiteralText,
          );
          hasLiteralFontEncodingGap = hasLiteralFontEncodingGap || shouldReportGap;
          hasSevereLiteralFontEncodingGap = hasSevereLiteralFontEncodingGap ||
            (shouldReportGap && isSevereMaterialDecodeGap(decodedLiteralText));
          continue;
        }

        if (shouldSuppressUnreadableLiteralText(preferredLiteralText, parsedRun.markedContentKind)) {
          pendingTextAdjustment = undefined;
          textEncodingKind = textEncodingKind ?? "literal";
          const shouldReportGap = parsedRun.markedContentKind !== "artifact" &&
            !shouldSuppressTrivialDecodeGap(fontRef, inspection, decodedLiteralText, preferredLiteralText);
          hasLiteralFontEncodingGap = hasLiteralFontEncodingGap || shouldReportGap;
          hasSevereLiteralFontEncodingGap = hasSevereLiteralFontEncodingGap ||
            shouldReportGap;
          continue;
        }
      }

      text = appendObservedOperandText(
        text,
        preferredLiteralText,
        pendingTextAdjustment,
        parsedRun.fontSize,
        decodedLiteralText ? fontEncodingSpacingProfile : "default",
        shouldSuppressCompactSpacing,
      );
      pendingTextAdjustment = undefined;
      textEncodingKind = textEncodingKind ?? "literal";
      unicodeMappingSource = unicodeMappingSource ?? (decodedLiteralText ? "font-encoding" : "literal");
      const hasMaterialDecodeGap = shouldReportMaterialDecodeGap(decodedLiteralText, parsedRun);
      const shouldReportGap = hasMaterialDecodeGap && !shouldSuppressTrivialDecodeGap(
        fontRef,
        inspection,
        decodedLiteralText,
        preferredLiteralText,
      );
      hasLiteralFontEncodingGap = hasLiteralFontEncodingGap || shouldReportGap;
      hasSevereLiteralFontEncodingGap = hasSevereLiteralFontEncodingGap ||
        (shouldReportGap && isSevereMaterialDecodeGap(decodedLiteralText));
      continue;
    }

    textEncodingKind = textEncodingKind ?? inferHexTextEncodingKind(fontRef, inspection);
    const decodedText = decodeHexTextOperand(
      operand.token,
      textEncodingKind,
      unicodeCMap,
      cidCollection,
      embeddedFontMapping,
      singleByteFontEncoding,
    );
    if (!decodedText) {
      const shouldReportGap = shouldReportTextMappingGap(parsedRun) &&
        (fontRef !== undefined || shouldReportNoFontHexDecodeGap(operand.token));
      hasFontMappingGap = hasFontMappingGap || shouldReportGap;
      hasSevereFontMappingGap = hasSevereFontMappingGap || shouldReportGap;
      continue;
    }

    const hasMaterialDecodeGap = shouldReportMaterialDecodeGap(decodedText, parsedRun);
    if (hasMaterialDecodeGap && !shouldSuppressTrivialDecodeGap(fontRef, inspection, decodedText, decodedText.text)) {
      hasFontMappingGap = true;
      hasSevereFontMappingGap = hasSevereFontMappingGap || isSevereMaterialDecodeGap(decodedText);
    }
    text = appendObservedOperandText(
      text,
      decodedText.text,
      pendingTextAdjustment,
      parsedRun.fontSize,
      decodedText.mappingSource === "font-encoding" ? fontEncodingSpacingProfile : "default",
      shouldSuppressCompactSpacing,
    );
    pendingTextAdjustment = undefined;
    unicodeMappingSource = unicodeMappingSource ?? decodedText.mappingSource;
  }

  const normalizedText = normalizeObservedRunText(text);
  return {
    text: normalizedText,
    hasFontMappingGap,
    hasLiteralFontEncodingGap,
    hasSevereFontMappingGap,
    hasSevereLiteralFontEncodingGap,
    startsNewLine: parsedRun.startsNewLine,
    ...(fontRef !== undefined ? { fontRef } : {}),
    ...(textEncodingKind !== undefined ? { textEncodingKind } : {}),
    ...(unicodeMappingSource !== undefined ? { unicodeMappingSource } : {}),
    ...(writingMode !== undefined ? { writingMode } : {}),
    ...(parsedRun.anchor !== undefined ? { anchor: parsedRun.anchor } : {}),
    ...(parsedRun.fontSize !== undefined ? { fontSize: parsedRun.fontSize } : {}),
  };
}

function appendObservedOperandText(
  currentText: string,
  operandText: string,
  adjustment: number | undefined,
  fontSize: number | undefined,
  spacingProfile: "default" | "font-encoding-compact" | "font-encoding-wide" = "default",
  shouldSuppressCompactWordSplit = true,
): string {
  if (operandText.length === 0) {
    return currentText;
  }

  if (!shouldInsertSyntheticSpace(
    currentText,
    operandText,
    adjustment,
    fontSize,
    spacingProfile,
    shouldSuppressCompactWordSplit,
  )) {
    return `${currentText}${operandText}`;
  }

  return `${currentText} ${operandText}`;
}

function shouldInsertSyntheticSpace(
  currentText: string,
  operandText: string,
  adjustment: number | undefined,
  fontSize: number | undefined,
  spacingProfile: "default" | "font-encoding-compact" | "font-encoding-wide",
  shouldSuppressCompactWordSplit: boolean,
): boolean {
  if (currentText.length === 0 || operandText.length === 0 || adjustment === undefined) {
    return false;
  }

  const currentTail = currentText.trimEnd();
  const operandHead = operandText.trimStart();
  if (currentTail.length === 0 || operandHead.length === 0) {
    return false;
  }

  const currentTailCharacter = currentTail.at(-1);
  const operandHeadCharacter = operandHead[0];
  if (currentTailCharacter === undefined || operandHeadCharacter === undefined) {
    return false;
  }

  if (currentTailCharacter === "-" || currentTailCharacter === "'" || currentTailCharacter === "/" || currentTailCharacter === "(") {
    return false;
  }
  if (operandHeadCharacter === "-" || operandHeadCharacter === "'" || operandHeadCharacter === ")" || operandHeadCharacter === "," || operandHeadCharacter === "." || operandHeadCharacter === ":" || operandHeadCharacter === ";" || operandHeadCharacter === "%" || operandHeadCharacter === "]") {
    return false;
  }

  if (
    shouldSuppressCompactWordSplit &&
    spacingProfile === "font-encoding-compact" &&
    shouldSuppressCompactFontEncodingWordSplit(currentTail, operandHead, fontSize)
  ) {
    return false;
  }

  const spaceThreshold = spacingProfile === "font-encoding-compact"
    ? -Math.max(18, (fontSize ?? 10) * 1.8)
    : spacingProfile === "font-encoding-wide"
    ? -Math.max(100, (fontSize ?? 10) * 8)
    : -Math.max(120, (fontSize ?? 10) * 12);
  if (adjustment > spaceThreshold) {
    return false;
  }

  return /\S$/u.test(currentTail) && /^\S/u.test(operandHead);
}

function resolveFontEncodingSpacingProfile(
  parsedRun: ParsedTextOperatorRun,
): "font-encoding-compact" | "font-encoding-wide" {
  let minimumAdjustment = Number.POSITIVE_INFINITY;
  for (const operand of parsedRun.operands) {
    if (operand.kind === "adjustment") {
      minimumAdjustment = Math.min(minimumAdjustment, operand.value);
    }
  }
  return minimumAdjustment <= -100 ? "font-encoding-wide" : "font-encoding-compact";
}

const COMPACT_FONT_ENCODING_WORD_BOUNDARIES = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
]);

function shouldSuppressCompactFontEncodingWordSplit(
  currentTail: string,
  operandHead: string,
  fontSize: number | undefined,
): boolean {
  if ((fontSize ?? 10) > 4) {
    return false;
  }

  const currentTailWord = currentTail.match(/([\p{L}]+)$/u)?.[1];
  const operandHeadWord = operandHead.match(/^([\p{L}]+)/u)?.[1];
  if (!currentTailWord || !operandHeadWord) {
    return false;
  }

  const currentTailCharacter = currentTailWord.at(-1);
  const operandHeadCharacter = operandHeadWord[0];
  if (!currentTailCharacter || !operandHeadCharacter) {
    return false;
  }

  if (!/\p{Ll}/u.test(currentTailCharacter) || !/\p{Ll}/u.test(operandHeadCharacter)) {
    return false;
  }

  if (
    COMPACT_FONT_ENCODING_WORD_BOUNDARIES.has(currentTailWord.toLowerCase()) ||
    COMPACT_FONT_ENCODING_WORD_BOUNDARIES.has(operandHeadWord.toLowerCase())
  ) {
    return false;
  }

  return currentTailWord.length <= 3 || operandHeadWord.length <= 3;
}

function resolvePreferredActualText(actualText: string | undefined, observedText: string): string | undefined {
  if (actualText === undefined) {
    return undefined;
  }

  const normalizedActualText = actualText
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(/[^\S\n]+/g, " ")
    .trim();
  if (normalizedActualText.length === 0) {
    return undefined;
  }

  if (looksUnreadableLiteralText(observedText) || normalizedActualText.length >= observedText.trim().length) {
    return normalizedActualText;
  }

  return undefined;
}

function sanitizeLiteralText(text: string): string {
  return text
    .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/gu, "")
    .replaceAll(/[\t\r\n]+/g, " ")
    .replaceAll(/[ ]{2,}/g, " ")
    .trim();
}

function shouldSuppressUnreadableLiteralText(
  text: string,
  markedContentKind: "artifact" | "span" | "other" | undefined,
): boolean {
  void markedContentKind;
  return looksUnreadableLiteralText(text);
}

function looksUnreadableLiteralText(text: string): boolean {
  if (text.length === 0) {
    return false;
  }

  const characters = Array.from(text);
  const controlCharacterCount = characters.filter((character) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(character)).length;
  if (controlCharacterCount === 0) {
    return false;
  }

  const letterOrDigitCount = characters.filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  if (letterOrDigitCount === 0) {
    return true;
  }

  return controlCharacterCount / characters.length > 0.25 && letterOrDigitCount / characters.length < 0.3;
}

function normalizeObservedRunText(text: string): string {
  return text
    .replaceAll(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replaceAll(/[ ]{2,}/g, " ")
    .trim();
}

function shouldReportTextMappingGap(parsedRun: ParsedTextOperatorRun): boolean {
  return parsedRun.markedContentKind !== "artifact";
}

function shouldReportMaterialDecodeGap(
  decodedText:
    | {
      readonly complete: boolean;
      readonly sourceUnitCount: number;
      readonly mappedUnitCount: number;
    }
    | undefined,
  parsedRun: ParsedTextOperatorRun,
): boolean {
  if (!decodedText || decodedText.complete || !shouldReportTextMappingGap(parsedRun)) {
    return false;
  }

  if (decodedText.mappedUnitCount === 0 || decodedText.sourceUnitCount === 0) {
    return true;
  }

  const missingUnitCount = decodedText.sourceUnitCount - decodedText.mappedUnitCount;
  if (missingUnitCount <= 0) {
    return false;
  }

  if (missingUnitCount === 1 && decodedText.mappedUnitCount >= 8) {
    return false;
  }

  if (missingUnitCount <= 2 && decodedText.mappedUnitCount >= 24) {
    return false;
  }

  if (decodedText.mappedUnitCount < 4) {
    return true;
  }

  return decodedText.mappedUnitCount / decodedText.sourceUnitCount < 0.9;
}

function isSevereMaterialDecodeGap(
  decodedText:
    | {
      readonly sourceUnitCount: number;
      readonly mappedUnitCount: number;
    }
    | undefined,
): boolean {
  if (!decodedText || decodedText.mappedUnitCount === 0 || decodedText.sourceUnitCount === 0) {
    return true;
  }

  const missingUnitCount = decodedText.sourceUnitCount - decodedText.mappedUnitCount;
  if (missingUnitCount <= 0) {
    return false;
  }

  if (missingUnitCount >= 2 && decodedText.mappedUnitCount < 8) {
    return true;
  }

  return decodedText.mappedUnitCount / decodedText.sourceUnitCount < 0.7;
}

function shouldSuppressTrivialDecodeGap(
  fontRef: PdfObjectRef | undefined,
  inspection: PdfObservationInspection,
  decodedText?:
    | {
      readonly sourceUnitCount: number;
      readonly mappedUnitCount: number;
    },
  previewText?: string,
): boolean {
  const normalizedPreview = normalizeObservedRunText(previewText ?? "");

  if (!decodedText) {
    return isSymbolLikeFont(fontRef, inspection) && !hasLetterOrDigit(normalizedPreview);
  }

  if (decodedText.sourceUnitCount === 1 && decodedText.mappedUnitCount === 0 && normalizedPreview.length === 0) {
    return true;
  }

  if (!isSymbolLikeFont(fontRef, inspection)) {
    return false;
  }

  if (decodedText.sourceUnitCount > 8 || hasLetterOrDigit(normalizedPreview)) {
    return false;
  }

  return true;
}

function shouldReportNoFontHexDecodeGap(token: string): boolean {
  const normalizedHex = normalizeHexOperandToken(token);
  if (normalizedHex.length === 0) {
    return false;
  }

  if (normalizedHex.length % 4 === 0) {
    return false;
  }

  return looksPrintableNoFontByteText(readHexOperandBytes(normalizedHex));
}

function normalizeHexOperandToken(token: string): string {
  const normalized = token
    .slice(1, -1)
    .replaceAll(/\s+/g, "");

  return normalized.length % 2 === 0 ? normalized : `${normalized}0`;
}

function readHexOperandBytes(normalizedHex: string): Uint8Array {
  const bytes = new Uint8Array(normalizedHex.length / 2);

  for (let index = 0; index < normalizedHex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalizedHex.slice(index, index + 2), 16);
  }

  return bytes;
}

function looksPrintableNoFontByteText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) {
    return false;
  }

  let printableByteCount = 0;
  let hasLetterOrDigitByte = false;

  for (const value of bytes) {
    const isPrintableWhitespace = value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20;
    const isPrintableAscii = value >= 0x21 && value <= 0x7e;
    if (isPrintableWhitespace || isPrintableAscii) {
      printableByteCount += 1;
    }
    if ((value >= 0x30 && value <= 0x39) || (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a)) {
      hasLetterOrDigitByte = true;
    }
  }

  return hasLetterOrDigitByte && printableByteCount / bytes.byteLength >= 0.6;
}

function isSymbolLikeFont(
  fontRef: PdfObjectRef | undefined,
  inspection: PdfObservationInspection,
): boolean {
  if (!fontRef) {
    return false;
  }

  const fontObject = inspection.analysis.objectIndex.get(keyOfObjectRef(fontRef));
  const fontNameText = [
    fontObject?.dictionaryEntries.get("BaseFont") ?? "",
    fontObject?.dictionaryEntries.get("Subtype") ?? "",
  ].join(" ").toLowerCase();

  return fontNameText.includes("math") ||
    fontNameText.includes("symbol") ||
    fontNameText.includes("dingbat") ||
    fontNameText.includes("txsy") ||
    fontNameText.includes("txex") ||
    fontNameText.includes("txmi");
}

function hasLetterOrDigit(value: string): boolean {
  return /[\p{Letter}\p{Number}]/u.test(value);
}

function decodeHexTextOperand(
  hexToken: string,
  textEncodingKind: PdfTextEncodingKind,
  unicodeCMap: ReturnType<typeof parsePdfUnicodeCMap> | undefined,
  cidCollection: PdfCidCollectionIdentifier | undefined,
  embeddedFontMapping: PdfEmbeddedFontMapping | undefined,
  singleByteFontEncoding: PdfSingleByteFontEncoding | undefined,
): PdfTextDecodeResult | undefined {
  if (unicodeCMap) {
    const decodedText = decodePdfHexTextWithUnicodeCMap(hexToken, unicodeCMap);
    return {
      text: decodedText.text,
      complete: decodedText.complete,
      mappingSource: "tounicode-cmap",
      sourceUnitCount: decodedText.sourceUnitCount,
      mappedUnitCount: decodedText.mappedUnitCount,
    };
  }

  if (textEncodingKind !== "cid") {
    if (!singleByteFontEncoding) {
      return undefined;
    }

    const decodedText = decodePdfSingleByteHexText(hexToken, singleByteFontEncoding);
    return {
      text: decodedText.text,
      complete: decodedText.complete,
      mappingSource: "font-encoding",
      sourceUnitCount: decodedText.sourceUnitCount,
      mappedUnitCount: decodedText.mappedUnitCount,
    };
  }

  const collectionDecodedText = decodePdfCidHexTextWithKnownCollectionMap(hexToken, cidCollection);
  if (collectionDecodedText) {
    return {
      text: collectionDecodedText.text,
      complete: collectionDecodedText.complete,
      mappingSource: "cid-collection-ucs2",
      sourceUnitCount: collectionDecodedText.sourceUnitCount,
      mappedUnitCount: collectionDecodedText.mappedUnitCount,
    };
  }

  if (!embeddedFontMapping) {
    return undefined;
  }

  return decodePdfCidHexTextWithEmbeddedFont(hexToken, embeddedFontMapping);
}

function resolveSingleByteFontEncodingForFont(
  fontRef: PdfObjectRef,
  singleByteFontEncodingByFontKey: Map<string, PdfSingleByteFontEncoding | undefined>,
  inspection: PdfObservationInspection,
): PdfSingleByteFontEncoding | undefined {
  const fontKey = keyOfObjectRef(fontRef);
  if (singleByteFontEncodingByFontKey.has(fontKey)) {
    return singleByteFontEncodingByFontKey.get(fontKey);
  }

  const fontObject = inspection.analysis.objectIndex.get(fontKey);
  const subtype = fontObject?.dictionaryEntries.get("Subtype")?.trim();
  if (!fontObject || subtype === "/Type0" || fontObject.dictionaryEntries.has("DescendantFonts")) {
    singleByteFontEncodingByFontKey.set(fontKey, undefined);
    return undefined;
  }

  const encodingValue = resolveFontEncodingValue(fontObject.dictionaryEntries.get("Encoding"), inspection);
  const baseEncodingName = readBaseEncodingName(encodingValue) ?? inferDefaultBaseEncodingName(subtype);
  const differencesText = readDifferencesArrayText(encodingValue);
  const singleByteFontEncoding = buildPdfSingleByteFontEncoding({
    ...(baseEncodingName !== undefined ? { baseEncodingName } : {}),
    ...(differencesText !== undefined ? { differencesText } : {}),
  });
  singleByteFontEncodingByFontKey.set(fontKey, singleByteFontEncoding);
  return singleByteFontEncoding;
}

function resolveUnicodeCMapForFont(
  fontRef: PdfObjectRef,
  unicodeCMapByFontKey: Map<string, ReturnType<typeof parsePdfUnicodeCMap>>,
  inspection: PdfObservationInspection,
) {
  const fontKey = keyOfObjectRef(fontRef);
  if (unicodeCMapByFontKey.has(fontKey)) {
    return unicodeCMapByFontKey.get(fontKey);
  }

  const fontObject = inspection.analysis.objectIndex.get(fontKey);
  const toUnicodeRef = fontObject ? readOptionalObjectRef(fontObject.dictionaryEntries.get("ToUnicode")) : undefined;
  const unicodeStreamText = toUnicodeRef
    ? inspection.analysis.objectIndex.get(keyOfObjectRef(toUnicodeRef))?.streamText
    : undefined;
  const unicodeCMap = typeof unicodeStreamText === "string" ? parsePdfUnicodeCMap(unicodeStreamText) : undefined;
  unicodeCMapByFontKey.set(fontKey, unicodeCMap);
  return unicodeCMap;
}

function resolveEmbeddedFontMappingForFont(
  fontRef: PdfObjectRef,
  embeddedFontMappingByFontKey: Map<string, PdfEmbeddedFontMapping | undefined>,
  inspection: PdfObservationInspection,
): PdfEmbeddedFontMapping | undefined {
  const fontKey = keyOfObjectRef(fontRef);
  if (embeddedFontMappingByFontKey.has(fontKey)) {
    return embeddedFontMappingByFontKey.get(fontKey);
  }

  const descendantFontObject = resolveDescendantFontObject(fontRef, inspection);
  const fontDescriptorRef = descendantFontObject
    ? readOptionalObjectRef(descendantFontObject.dictionaryEntries.get("FontDescriptor"))
    : undefined;
  const fontDescriptorObject = fontDescriptorRef
    ? inspection.analysis.objectIndex.get(keyOfObjectRef(fontDescriptorRef))
    : undefined;
  const fontFileRef = fontDescriptorObject
    ? readOptionalObjectRef(fontDescriptorObject.dictionaryEntries.get("FontFile2"))
    : undefined;
  const fontFileObject = fontFileRef
    ? inspection.analysis.objectIndex.get(keyOfObjectRef(fontFileRef))
    : undefined;
  const glyphUnicodeByGlyphId = fontFileObject?.decodedStreamBytes
    ? parseTrueTypeGlyphUnicodeMap(fontFileObject.decodedStreamBytes)
    : undefined;

  if (!glyphUnicodeByGlyphId || glyphUnicodeByGlyphId.size === 0) {
    embeddedFontMappingByFontKey.set(fontKey, undefined);
    return undefined;
  }

  const cidToGidByCid = descendantFontObject
    ? resolveCidToGidMap(descendantFontObject.dictionaryEntries.get("CIDToGIDMap"), inspection)
    : undefined;
  const requiresExplicitCidToGidMap = hasExplicitCidToGidMap(descendantFontObject?.dictionaryEntries.get("CIDToGIDMap"));

  const mapping: PdfEmbeddedFontMapping = {
    glyphUnicodeByGlyphId,
    requiresExplicitCidToGidMap,
    ...(cidToGidByCid !== undefined ? { cidToGidByCid } : {}),
  };
  embeddedFontMappingByFontKey.set(fontKey, mapping);
  return mapping;
}

function inferHexTextEncodingKind(
  fontRef: PdfObjectRef | undefined,
  inspection: PdfObservationInspection,
): PdfTextEncodingKind {
  if (fontRef === undefined) {
    return "hex";
  }

  const fontObject = inspection.analysis.objectIndex.get(keyOfObjectRef(fontRef));
  const encodingValue = fontObject?.dictionaryEntries.get("Encoding")?.trim();
  if (
    fontObject?.dictionaryEntries.has("DescendantFonts") ||
    fontObject?.dictionaryEntries.get("Subtype")?.trim() === "/Type0" ||
    encodingValue === "/Identity-H" ||
    encodingValue === "/Identity-V"
  ) {
    return "cid";
  }

  return "hex";
}

function resolveWritingModeForFont(
  fontRef: PdfObjectRef,
  inspection: PdfObservationInspection,
): PdfWritingMode | undefined {
  const fontObject = inspection.analysis.objectIndex.get(keyOfObjectRef(fontRef));
  const encodingValue = fontObject?.dictionaryEntries.get("Encoding")?.trim();
  if (encodingValue === "/Identity-V") {
    return "vertical";
  }

  const descendantFontObject = resolveDescendantFontObject(fontRef, inspection);
  const descendantEncodingValue = descendantFontObject?.dictionaryEntries.get("Encoding")?.trim();
  if (descendantEncodingValue === "/Identity-V") {
    return "vertical";
  }

  return undefined;
}

function inferObservedPageWritingMode(
  runs: readonly PdfObservedTextRun[],
): PdfWritingMode | undefined {
  if (runs.some((run) => run.writingMode === "vertical")) {
    return "vertical";
  }

  const anchoredRuns = runs.filter((run) => run.anchor !== undefined);
  if (anchoredRuns.length < 3 || !anchoredRuns.every((run) => run.startsNewLine === true)) {
    return undefined;
  }

  const averageTextLength = anchoredRuns.reduce((sum, run) => sum + run.text.length, 0) / anchoredRuns.length;
  if (averageTextLength > 20) {
    return undefined;
  }

  let horizontalTransitions = 0;
  let verticalTransitions = 0;

  for (let index = 1; index < anchoredRuns.length; index += 1) {
    const previousRun = anchoredRuns[index - 1] as PdfObservedTextRun;
    const currentRun = anchoredRuns[index] as PdfObservedTextRun;
    const previousAnchor = previousRun.anchor;
    const currentAnchor = currentRun.anchor;
    if (!previousAnchor || !currentAnchor) {
      continue;
    }

    const fontSize = currentRun.fontSize ?? previousRun.fontSize ?? 12;
    const deltaX = Math.abs(currentAnchor.x - previousAnchor.x);
    const deltaY = Math.abs(currentAnchor.y - previousAnchor.y);
    const lateralThreshold = Math.max(10, fontSize * 1.2);
    const stackThreshold = Math.max(16, fontSize * 1.4);

    if (deltaX >= lateralThreshold && deltaY <= stackThreshold) {
      horizontalTransitions += 1;
      continue;
    }

    if (deltaY >= lateralThreshold && deltaX <= stackThreshold) {
      verticalTransitions += 1;
    }
  }

  return horizontalTransitions >= 2 && horizontalTransitions > verticalTransitions ? "vertical" : undefined;
}

function resolveCidCollectionForFont(
  fontRef: PdfObjectRef,
  inspection: PdfObservationInspection,
): PdfCidCollectionIdentifier | undefined {
  const descendantFontObject = resolveDescendantFontObject(fontRef, inspection);
  const cidSystemInfoValue = descendantFontObject?.dictionaryEntries.get("CIDSystemInfo");
  if (!cidSystemInfoValue) {
    return undefined;
  }

  const registryMatch = cidSystemInfoValue.match(/\/Registry\s*\(([^)]+)\)/);
  const orderingMatch = cidSystemInfoValue.match(/\/Ordering\s*\(([^)]+)\)/);
  const registry = registryMatch?.[1];
  const ordering = orderingMatch?.[1];
  if (!registry || !ordering) {
    return undefined;
  }

  return {
    registry,
    ordering,
  };
}

function resolveDescendantFontObject(
  fontRef: PdfObjectRef,
  inspection: PdfObservationInspection,
) {
  const fontObject = inspection.analysis.objectIndex.get(keyOfObjectRef(fontRef));
  if (!fontObject) {
    return undefined;
  }

  if (fontObject.dictionaryEntries.get("Subtype")?.trim() === "/CIDFontType2") {
    return fontObject;
  }

  const descendantFontRefs = readOptionalObjectRefs(fontObject.dictionaryEntries.get("DescendantFonts"));
  const descendantFontRef = descendantFontRefs[0];
  return descendantFontRef ? inspection.analysis.objectIndex.get(keyOfObjectRef(descendantFontRef)) : fontObject;
}

function resolveFontEncodingValue(
  value: string | undefined,
  inspection: PdfObservationInspection,
): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.startsWith("<<") && trimmedValue.endsWith(">>")) {
    return trimmedValue;
  }

  if (trimmedValue.startsWith("/")) {
    return trimmedValue;
  }

  const objectRef = readOptionalObjectRef(trimmedValue);
  if (!objectRef) {
    return undefined;
  }

  return inspection.analysis.objectIndex.get(keyOfObjectRef(objectRef))?.objectValueText?.trim();
}

function readBaseEncodingName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.startsWith("/") && trimmedValue.length > 1) {
    return trimmedValue.slice(1);
  }

  const baseEncodingMatch = trimmedValue.match(/\/BaseEncoding\s*\/([A-Za-z0-9_.-]+)/u);
  return baseEncodingMatch?.[1];
}

function readDifferencesArrayText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const differencesMatch = value.match(/\/Differences\s*(\[[\s\S]*\])/u);
  return differencesMatch?.[1];
}

function inferDefaultBaseEncodingName(subtype: string | undefined): string | undefined {
  if (subtype === "/Type1" || subtype === "/TrueType") {
    return "StandardEncoding";
  }

  return undefined;
}

function resolveCidToGidMap(
  value: string | undefined,
  inspection: PdfObservationInspection,
): ReadonlyMap<number, number> | undefined {
  if (!value) {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue === "/Identity") {
    return undefined;
  }

  const objectRef = readOptionalObjectRef(trimmedValue);
  if (!objectRef) {
    return undefined;
  }

  const objectShell = inspection.analysis.objectIndex.get(keyOfObjectRef(objectRef));
  return objectShell?.decodedStreamBytes ? parseCidToGidMap(objectShell.decodedStreamBytes) : undefined;
}

function hasExplicitCidToGidMap(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 && trimmedValue !== "/Identity";
}

function parseCidToGidMap(decodedStreamBytes: Uint8Array): ReadonlyMap<number, number> | undefined {
  if (decodedStreamBytes.byteLength < 2) {
    return undefined;
  }

  const cidToGidByCid = new Map<number, number>();
  const pairCount = Math.floor(decodedStreamBytes.byteLength / 2);
  for (let cid = 0; cid < pairCount; cid += 1) {
    const offset = cid * 2;
    const highByte = decodedStreamBytes[offset];
    const lowByte = decodedStreamBytes[offset + 1];
    if (highByte === undefined || lowByte === undefined) {
      continue;
    }

    const glyphId = (highByte << 8) | lowByte;
    cidToGidByCid.set(cid, glyphId);
  }

  return cidToGidByCid;
}

function decodePdfCidHexTextWithEmbeddedFont(
  hexToken: string,
  embeddedFontMapping: PdfEmbeddedFontMapping,
): PdfTextDecodeResult {
  const normalizedHex = normalizePdfHexToken(hexToken);
  if (normalizedHex.length === 0 || normalizedHex.length % 4 !== 0) {
    return {
      text: "",
      complete: false,
      mappingSource: "embedded-font-cmap",
      sourceUnitCount: 0,
      mappedUnitCount: 0,
    };
  }

  let text = "";
  let complete = true;
  let sourceUnitCount = 0;
  let mappedUnitCount = 0;

  for (let offset = 0; offset < normalizedHex.length; offset += 4) {
    sourceUnitCount += 1;
    const cid = Number.parseInt(normalizedHex.slice(offset, offset + 4), 16);
    const glyphId = resolveGlyphIdForCid(cid, embeddedFontMapping);
    const glyphText = glyphId === undefined ? undefined : embeddedFontMapping.glyphUnicodeByGlyphId.get(glyphId);
    if (glyphText === undefined) {
      complete = false;
      continue;
    }
    text += glyphText;
    mappedUnitCount += 1;
  }

  return {
    text,
    complete,
    mappingSource: "embedded-font-cmap",
    sourceUnitCount,
    mappedUnitCount,
  };
}

function resolveGlyphIdForCid(
  cid: number,
  embeddedFontMapping: PdfEmbeddedFontMapping,
): number | undefined {
  if (embeddedFontMapping.cidToGidByCid) {
    return embeddedFontMapping.cidToGidByCid.get(cid);
  }

  if (embeddedFontMapping.requiresExplicitCidToGidMap) {
    return undefined;
  }

  return cid;
}

function normalizePdfHexToken(value: string): string {
  const trimmedValue = value.trim();
  const bracketlessValue = trimmedValue.startsWith("<") && trimmedValue.endsWith(">")
    ? trimmedValue.slice(1, -1)
    : trimmedValue;
  const normalizedHex = bracketlessValue.replaceAll(/\s+/g, "");
  return normalizedHex.length % 2 === 0 ? normalizedHex : `${normalizedHex}0`;
}

function readOptionalObjectRef(value: string | undefined): PdfObjectRef | undefined {
  if (!value) {
    return undefined;
  }

  const trimmedValue = value.trim();
  const match = trimmedValue.match(/^(\d+)\s+(\d+)\s+R$/);
  if (!match) {
    return undefined;
  }

  return {
    objectNumber: Number(match[1]),
    generationNumber: Number(match[2]),
  };
}

function readOptionalObjectRefs(value: string | undefined): readonly PdfObjectRef[] {
  if (!value) {
    return [];
  }

  return Array.from(value.matchAll(/(\d+)\s+(\d+)\s+R/g), (match) => ({
    objectNumber: Number(match[1]),
    generationNumber: Number(match[2]),
  }));
}
