import {
  decodePdfCidHexTextWithKnownCollectionMap,
  type PdfCidCollectionIdentifier,
} from "./cid-collection-unicode.ts";
import { decodePdfHexTextWithUnicodeCMap, parsePdfUnicodeCMap } from "./cmap.ts";
import {
  buildPdfSingleByteFontEncoding,
  decodePdfSingleByteHexText,
  decodePdfSingleByteLiteralText,
  type PdfSingleByteFontEncoding,
} from "./font-encoding.ts";
import { buildKnowledgeDocument } from "./knowledge.ts";
import { buildLayoutDocument, buildObservationParagraphText } from "./layout.ts";
import { preparePdfStandardPasswordSecurity } from "./pdf-standard-security.ts";
import {
  analyzePdfShell,
  decodePdfLiteral,
  keyOfObjectRef,
  parseTextOperatorRuns,
  type PdfShellAnalysis,
} from "./shell-parse.ts";
import { parseTrueTypeGlyphUnicodeMap } from "./truetype-cmap.ts";

import type {
  PdfAdmissionArtifact,
  PdfAdmissionDecision,
  PdfAdmissionPolicy,
  PdfAdmissionRequest,
  PdfDiagnostic,
  PdfEngine,
  PdfEngineIdentity,
  PdfEngineOptions,
  PdfFeatureEvidenceSource,
  PdfFeatureKind,
  PdfFeatureSignal,
  PdfIrDocument,
  PdfIrPageShell,
  PdfIrRequest,
  PdfKnownLimitCode,
  PdfLayoutDocument,
  PdfLayoutRequest,
  PdfKnowledgeDocument,
  PdfKnowledgeRequest,
  PdfNormalizedAdmissionPolicy,
  PdfObjectRef,
  PdfObservedDocument,
  PdfObservedGlyph,
  PdfObservedPage,
  PdfObservedTextRun,
  PdfObservationRequest,
  PdfPipelineRequest,
  PdfPipelineResult,
  PdfRuntimeCapabilities,
  PdfRuntimeDescriptor,
  PdfStageResult,
  PdfTextEncodingKind,
  PdfUnicodeMappingSource,
  PdfWritingMode,
} from "./contracts.ts";

const DEFAULT_POLICY: PdfNormalizedAdmissionPolicy = {
  javascriptActions: "deny",
  launchActions: "deny",
  embeddedFiles: "report",
  repairMode: "safe",
  passwordPolicy: "known-only",
  allowEncryptedMetadata: false,
  resourceBudget: {
    maxBytes: 64_000_000,
    maxPages: 10_000,
    maxObjects: 2_000_000,
    maxMilliseconds: 5_000,
    maxRecursionDepth: 64,
    maxScanBytes: 1_500_000,
  },
};

const ENGINE_IDENTITY: PdfEngineIdentity = {
  name: "@ismail-elkorchi/pdf-engine",
  version: "0.1.0-shell",
  mode: "shell",
  supportedRuntimes: ["node", "deno", "bun", "web"],
  supportedStages: ["admission", "ir", "observation", "layout", "knowledge"],
};

const HIDDEN_TEXT_PATTERN = /\/(?:OC|ActualText)\b/;

const FEATURE_PATTERNS: ReadonlyArray<{
  kind: PdfFeatureKind;
  pattern: RegExp;
  actionKey: "javascriptActions" | "launchActions" | "embeddedFiles" | null;
}> = [
  { kind: "javascript-actions", pattern: /\/(?:JS|JavaScript)\b/, actionKey: "javascriptActions" },
  { kind: "embedded-files", pattern: /\/EmbeddedFile\b/, actionKey: "embeddedFiles" },
  { kind: "launch-actions", pattern: /\/Launch\b/, actionKey: "launchActions" },
  { kind: "forms", pattern: /\/AcroForm\b/, actionKey: null },
  { kind: "annotations", pattern: /\/Annots\b/, actionKey: null },
  { kind: "outlines", pattern: /\/Outlines\b/, actionKey: null },
  { kind: "signatures", pattern: /\/Sig\b/, actionKey: null },
  { kind: "encryption", pattern: /\/Encrypt\b/, actionKey: null },
  { kind: "object-streams", pattern: /\/ObjStm\b/, actionKey: null },
  { kind: "xref-streams", pattern: /\/Type\s*\/XRef\b/, actionKey: null },
  { kind: "images", pattern: /\/Subtype\s*\/Image\b/, actionKey: null },
  { kind: "fonts", pattern: /\/Font\b/, actionKey: null },
  { kind: "hidden-text", pattern: HIDDEN_TEXT_PATTERN, actionKey: null },
  { kind: "duplicate-text-layer", pattern: /\/Subtype\s*\/Image\b[\s\S]{0,500}\/Font\b/, actionKey: null },
] as const;

interface PdfShellInspection {
  readonly analysis: PdfShellAnalysis;
  readonly featureSignals: readonly PdfFeatureSignal[];
  readonly isEncrypted: boolean;
  readonly policy: PdfNormalizedAdmissionPolicy;
  readonly decryptionStatus: "not-needed" | "decrypted" | "password-required" | "invalid-password" | "unsupported";
  readonly decryptionDetail?: string;
}

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

/**
 * Creates a `pdf-engine` instance with a normalized default admission policy and runtime detection.
 *
 * The current implementation is a shell engine for admission, IR, and observation stages.
 * It is suitable for smoke checks, contract shaping, and early integration work, but it is not
 * yet a full PDF parser, layout engine, or renderer.
 *
 * @param options Optional default policy overrides applied to every request unless a request provides its own policy.
 * @returns A runtime-aware engine instance exposing staged admission, IR, observation, and pipeline operations.
 */
export function createPdfEngine(options: PdfEngineOptions = {}): PdfEngine {
  const defaultPolicy = mergePolicy(DEFAULT_POLICY, options.defaultPolicy);
  const runtime = detectRuntime();
  const capabilities = detectRuntimeCapabilities(runtime);

  return {
    identity: ENGINE_IDENTITY,
    runtime,
    capabilities,
    defaultPolicy,
    dispose,
    admit,
    toIr,
    observe,
    toLayout,
    toKnowledge,
    run,
  };

  async function dispose(): Promise<void> {}

  async function admit(request: PdfAdmissionRequest): Promise<PdfStageResult<PdfAdmissionArtifact>> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const inspection = await inspectSource(request.source, policy, request.passwordProvider);
    return buildAdmissionStage(request, inspection);
  }

  async function toIr(request: PdfIrRequest): Promise<PdfStageResult<PdfIrDocument>> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const inspection = await inspectSource(request.source, policy, request.passwordProvider);
    const admission = buildAdmissionStage(
      {
        source: request.source,
        ...(request.policy !== undefined ? { policy: request.policy } : {}),
        ...(request.passwordProvider !== undefined ? { passwordProvider: request.passwordProvider } : {}),
      },
      inspection,
    );
    return buildIrStage(inspection, admission);
  }

  async function observe(request: PdfObservationRequest): Promise<PdfStageResult<PdfObservedDocument>> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const inspection = await inspectSource(request.source, policy, request.passwordProvider);
    const admission = buildAdmissionStage(
      {
        source: request.source,
        ...(request.policy !== undefined ? { policy: request.policy } : {}),
        ...(request.passwordProvider !== undefined ? { passwordProvider: request.passwordProvider } : {}),
      },
      inspection,
    );
    return buildObservationStage(inspection, admission);
  }

  async function toLayout(request: PdfLayoutRequest): Promise<PdfStageResult<PdfLayoutDocument>> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const inspection = await inspectSource(request.source, policy, request.passwordProvider);
    const admission = buildAdmissionStage(
      {
        source: request.source,
        ...(request.policy !== undefined ? { policy: request.policy } : {}),
        ...(request.passwordProvider !== undefined ? { passwordProvider: request.passwordProvider } : {}),
      },
      inspection,
    );
    const observation = buildObservationStage(inspection, admission);
    return buildLayoutStage(observation);
  }

  async function toKnowledge(request: PdfKnowledgeRequest): Promise<PdfStageResult<PdfKnowledgeDocument>> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const inspection = await inspectSource(request.source, policy, request.passwordProvider);
    const admission = buildAdmissionStage(
      {
        source: request.source,
        ...(request.policy !== undefined ? { policy: request.policy } : {}),
        ...(request.passwordProvider !== undefined ? { passwordProvider: request.passwordProvider } : {}),
      },
      inspection,
    );
    const observation = buildObservationStage(inspection, admission);
    const layout = buildLayoutStage(observation);
    return buildKnowledgeStage(observation, layout);
  }

  async function run(request: PdfPipelineRequest): Promise<PdfPipelineResult> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const inspection = await inspectSource(request.source, policy, request.passwordProvider);
    const admission = buildAdmissionStage(request, inspection);
    const ir = buildIrStage(inspection, admission);
    const observation = buildObservationStage(inspection, admission);
    const layout = buildLayoutStage(observation);
    const knowledge = buildKnowledgeStage(observation, layout);

    return {
      engine: ENGINE_IDENTITY,
      runtime,
      source: {
        byteLength: request.source.bytes.byteLength,
        ...(request.source.fileName !== undefined ? { fileName: request.source.fileName } : {}),
        ...(request.source.mediaType !== undefined ? { mediaType: request.source.mediaType } : {}),
        ...(request.source.sha256 !== undefined ? { sha256: request.source.sha256 } : {}),
      },
      admission,
      ir,
      observation,
      layout,
      knowledge,
      diagnostics: dedupeDiagnostics([...admission.diagnostics, ...ir.diagnostics, ...observation.diagnostics, ...layout.diagnostics, ...knowledge.diagnostics]),
    };
  }
}

async function inspectSource(
  source: PdfAdmissionRequest["source"],
  policy: PdfNormalizedAdmissionPolicy,
  passwordProvider?: PdfAdmissionRequest["passwordProvider"],
): Promise<PdfShellInspection> {
  const analysis = await analyzePdfShell(source, policy);

  if (!isEncryptedAnalysis(analysis, policy)) {
    return buildInspection(analysis, policy, "not-needed");
  }

  if (analysis.trailer?.encryptRef === undefined || analysis.documentId === undefined) {
    return buildInspection(
      analysis,
      policy,
      "unsupported",
      "The shell detected encryption markers but could not resolve the encryption dictionary and document identifier.",
    );
  }

  const encryptObject = analysis.objectIndex.get(keyOfObjectRef(analysis.trailer.encryptRef));
  if (!encryptObject) {
    return buildInspection(
      analysis,
      policy,
      "unsupported",
      "The trailer referenced an encryption dictionary that the shell could not recover.",
    );
  }

  const emptyPasswordAttempt = await preparePdfStandardPasswordSecurity({
    documentId: analysis.documentId,
    encryptDictionaryEntries: encryptObject.dictionaryEntries,
    encryptObjectRef: encryptObject.ref,
    password: "",
  });
  if (emptyPasswordAttempt.status === "decrypted") {
    return buildInspection(
      await analyzePdfShell(source, policy, { securityHandler: emptyPasswordAttempt.handler }),
      policy,
      "decrypted",
    );
  }
  if (emptyPasswordAttempt.status === "unsupported") {
    return buildInspection(analysis, policy, "unsupported", emptyPasswordAttempt.detail);
  }

  if (!passwordProvider) {
    return buildInspection(analysis, policy, "password-required");
  }

  const password = await passwordProvider({
    reason: "document-encrypted",
    attempts: 0,
    ...(source.fileName !== undefined ? { fileName: source.fileName } : {}),
  });
  if (!password) {
    return buildInspection(analysis, policy, "password-required");
  }

  const suppliedPasswordAttempt = await preparePdfStandardPasswordSecurity({
    documentId: analysis.documentId,
    encryptDictionaryEntries: encryptObject.dictionaryEntries,
    encryptObjectRef: encryptObject.ref,
    password,
  });
  if (suppliedPasswordAttempt.status === "decrypted") {
    return buildInspection(
      await analyzePdfShell(source, policy, { securityHandler: suppliedPasswordAttempt.handler }),
      policy,
      "decrypted",
    );
  }

  return buildInspection(analysis, policy, suppliedPasswordAttempt.status, suppliedPasswordAttempt.detail);
}

function buildInspection(
  analysis: PdfShellAnalysis,
  policy: PdfNormalizedAdmissionPolicy,
  decryptionStatus: PdfShellInspection["decryptionStatus"],
  decryptionDetail?: string,
): PdfShellInspection {
  const featureSignals = detectFeatureSignals(analysis, policy);
  const isEncrypted = featureSignals.some((signal) => signal.kind === "encryption" && signal.detected);
  return {
    analysis,
    featureSignals,
    isEncrypted,
    policy,
    decryptionStatus,
    ...(decryptionDetail !== undefined ? { decryptionDetail } : {}),
  };
}

function buildAdmissionStage(
  request: Pick<PdfAdmissionRequest, "source" | "policy" | "passwordProvider">,
  inspection: PdfShellInspection,
): PdfStageResult<PdfAdmissionArtifact> {
  const diagnostics = createAdmissionDiagnostics(inspection);
  const knownLimits = collectAdmissionKnownLimits(inspection);
  const artifactBase = {
    fileType: inspection.analysis.fileType,
    byteLength: request.source.bytes.byteLength,
    isEncrypted: inspection.isEncrypted,
    repairState: inspection.analysis.repairState,
    parseCoverage: inspection.analysis.parseCoverage,
    featureSignals: inspection.featureSignals,
    policy: inspection.policy,
    knownLimits,
    ...(request.source.fileName !== undefined ? { fileName: request.source.fileName } : {}),
    ...(inspection.analysis.pdfVersion !== undefined ? { pdfVersion: inspection.analysis.pdfVersion } : {}),
    ...(inspection.analysis.pageCountEstimate !== undefined ? { pageCountEstimate: inspection.analysis.pageCountEstimate } : {}),
    ...(inspection.analysis.objectCountEstimate !== undefined ? { objectCountEstimate: inspection.analysis.objectCountEstimate } : {}),
    ...(inspection.analysis.startXrefOffset !== undefined ? { startXrefOffset: inspection.analysis.startXrefOffset } : {}),
  } as const;

  if (request.source.bytes.byteLength > inspection.policy.resourceBudget.maxBytes) {
    diagnostics.push({
      code: "resource-budget-bytes-exceeded",
      stage: "admission",
      level: "critical",
      message: `Document exceeds the configured byte budget of ${inspection.policy.resourceBudget.maxBytes} bytes.`,
    });
    return stageResult("admission", "blocked", diagnostics, {
      ...artifactBase,
      decision: "rejected",
    });
  }

  if (inspection.analysis.fileType !== "pdf") {
    diagnostics.push({
      code: "unsupported-file-type",
      stage: "admission",
      level: "high",
      message: "The source does not look like a PDF file.",
    });
    return stageResult("admission", "blocked", diagnostics, {
      ...artifactBase,
      decision: "rejected",
    });
  }

  if (
    inspection.analysis.pageCountEstimate !== undefined &&
    inspection.analysis.pageCountEstimate > inspection.policy.resourceBudget.maxPages
  ) {
    diagnostics.push({
      code: "resource-budget-pages-exceeded",
      stage: "admission",
      level: "critical",
      message: `Document page estimate exceeds the configured page budget of ${inspection.policy.resourceBudget.maxPages}.`,
    });
    return stageResult("admission", "blocked", diagnostics, {
      ...artifactBase,
      decision: "rejected",
    });
  }

  if (
    inspection.analysis.objectCountEstimate !== undefined &&
    inspection.analysis.objectCountEstimate > inspection.policy.resourceBudget.maxObjects
  ) {
    diagnostics.push({
      code: "resource-budget-objects-exceeded",
      stage: "admission",
      level: "critical",
      message: `Document object estimate exceeds the configured object budget of ${inspection.policy.resourceBudget.maxObjects}.`,
    });
    return stageResult("admission", "blocked", diagnostics, {
      ...artifactBase,
      decision: "rejected",
    });
  }

  for (const signal of inspection.featureSignals) {
    if (!signal.detected) {
      continue;
    }

    diagnostics.push({
      code: `feature-${signal.kind}`,
      stage: "admission",
      level: signal.action === "deny" ? "high" : "medium",
      message: signal.message,
      feature: signal.kind,
      ...(signal.objectRef !== undefined ? { objectRef: signal.objectRef } : {}),
    });
  }

  if (inspection.analysis.repairState === "recovery-required") {
    diagnostics.push({
      code: "repair-required",
      stage: "admission",
      level: "high",
      message: "The object-aware shell could not recover enough structure to continue safely.",
    });
    return stageResult("admission", "blocked", diagnostics, {
      ...artifactBase,
      decision: "unsupported",
    });
  }

  if (inspection.analysis.repairState === "recovered" && inspection.policy.repairMode === "never") {
    diagnostics.push({
      code: "repair-blocked-by-policy",
      stage: "admission",
      level: "high",
      message: "The document needs heuristic recovery, but the active policy forbids repair or recovery paths.",
    });
    return stageResult("admission", "blocked", diagnostics, {
      ...artifactBase,
      decision: "unsupported",
    });
  }

  const encryptionDecision = resolveEncryptionDecision(inspection, diagnostics);
  const decision = encryptionDecision ?? ("accepted" satisfies PdfAdmissionDecision);
  const status = decision === "accepted" ? (inspection.analysis.repairState === "clean" ? "completed" : "partial") : "blocked";

  return stageResult("admission", status, diagnostics, {
    ...artifactBase,
    decision,
  });
}

function resolveEncryptionDecision(
  inspection: PdfShellInspection,
  diagnostics: PdfDiagnostic[],
): PdfAdmissionDecision | undefined {
  if (!inspection.isEncrypted) {
    return undefined;
  }

  if (inspection.policy.passwordPolicy === "forbid") {
    diagnostics.push({
      code: "encrypted-document-rejected",
      stage: "admission",
      level: "high",
      message: "Encrypted documents are forbidden by the active policy.",
      feature: "encryption",
    });
    return "rejected";
  }

  if (inspection.decryptionStatus === "decrypted" || inspection.decryptionStatus === "not-needed") {
    return undefined;
  }

  if (inspection.decryptionStatus === "password-required") {
    diagnostics.push({
      code: "password-required",
      stage: "admission",
      level: "medium",
      message: "A valid password is required before the document can advance.",
      feature: "encryption",
    });
    return "password-required";
  }

  if (inspection.decryptionStatus === "invalid-password") {
    diagnostics.push({
      code: "password-invalid",
      stage: "admission",
      level: "medium",
      message: inspection.decryptionDetail ?? "The supplied password did not unlock the document.",
      feature: "encryption",
    });
    return "password-required";
  }

  diagnostics.push({
    code: "decryption-not-implemented",
    stage: "admission",
    level: "medium",
    message: inspection.decryptionDetail ??
      "The object-aware shell recognizes encrypted PDFs but does not support this encryption variant yet.",
    feature: "encryption",
  });
  return "unsupported";
}

function buildIrStage(
  inspection: PdfShellInspection,
  admission: PdfStageResult<PdfAdmissionArtifact>,
): PdfStageResult<PdfIrDocument> {
  if (!canAdvance(admission)) {
    return stageResult("ir", "blocked", admission.diagnostics);
  }

  const diagnostics = createIrDiagnostics(inspection);
  const resolutionMethod = inspection.analysis.pageTreeResolved ? "page-tree" : "recovered-page-order";
  const pages: PdfIrPageShell[] = inspection.analysis.pageEntries.map((pageEntry) => ({
    pageNumber: pageEntry.pageNumber,
    resolutionMethod,
    pageRef: pageEntry.pageRef,
    contentStreamCount: pageEntry.contentStreamRefs.length,
    contentStreamRefs: pageEntry.contentStreamRefs,
    resourceCount: pageEntry.resourceCount,
    ...(pageEntry.resourceOrigin !== undefined ? { resourceOrigin: pageEntry.resourceOrigin } : {}),
    ...(pageEntry.resourceRef !== undefined ? { resourceRef: pageEntry.resourceRef } : {}),
    annotationCount: pageEntry.annotationRefs.length,
    annotationRefs: pageEntry.annotationRefs,
  }));

  const ir: PdfIrDocument = {
    kind: "shell",
    byteLength: inspection.analysis.byteLength,
    ...(inspection.analysis.pdfVersion !== undefined ? { pdfVersion: inspection.analysis.pdfVersion } : {}),
    ...(inspection.analysis.pageCountEstimate !== undefined ? { pageCountEstimate: inspection.analysis.pageCountEstimate } : {}),
    ...(inspection.analysis.objectCountEstimate !== undefined ? { objectCountEstimate: inspection.analysis.objectCountEstimate } : {}),
    ...(inspection.analysis.startXrefOffset !== undefined ? { startXrefOffset: inspection.analysis.startXrefOffset } : {}),
    crossReferenceKind: inspection.analysis.crossReferenceKind,
    isEncrypted: inspection.isEncrypted,
    repairState: inspection.analysis.repairState,
    parseCoverage: inspection.analysis.parseCoverage,
    crossReferenceSections: inspection.analysis.crossReferenceSections,
    ...(inspection.analysis.trailer !== undefined ? { trailer: inspection.analysis.trailer } : {}),
    indirectObjects: inspection.analysis.indirectObjects,
    featureKinds: inspection.featureSignals.filter((signal) => signal.detected).map((signal) => signal.kind),
    pages,
    decodedStreams: hasDecodedStreams(inspection),
    expandedObjectStreams: inspection.analysis.expandedObjectStreams,
    decodedXrefStreamEntries: inspection.analysis.decodedXrefStreamEntries,
    resolvedInheritedPageState: inspection.analysis.inheritedPageStateResolved,
    knownLimits: collectIrKnownLimits(inspection),
  };

  return stageResult("ir", admission.status === "partial" || diagnostics.length > 0 ? "partial" : "completed", diagnostics, ir);
}

function buildObservationStage(
  inspection: PdfShellInspection,
  admission: PdfStageResult<PdfAdmissionArtifact>,
): PdfStageResult<PdfObservedDocument> {
  if (!canAdvance(admission)) {
    return stageResult("observation", "blocked", admission.diagnostics);
  }

  const diagnostics = createObservationDiagnostics(inspection);
  const observedPageResult = buildObservedPages(inspection, diagnostics);
  const pages = observedPageResult.pages;
  const extractedText = buildObservationParagraphText({
    kind: "shell",
    strategy: "decoded-text-operators",
    extractedText: "",
    pages,
    knownLimits: [],
  });

  if (extractedText.length === 0) {
    if (observedPageResult.hasFontMappingGap) {
      diagnostics.push({
        code: "font-unicode-mapping-not-implemented",
        stage: "observation",
        level: "medium",
        message: "The shell found encoded text operators that still need font or Unicode mapping support before text can be recovered honestly.",
      });
    }

    if (observedPageResult.hasLiteralFontEncodingGap) {
      diagnostics.push({
        code: "literal-font-encoding-not-implemented",
        stage: "observation",
        level: "medium",
        message:
          "The shell suppressed unreadable literal-text runs that still need font-encoding support or marked-content recovery before they can be emitted honestly.",
      });
    }

    diagnostics.push({
      code: "shell-observation-empty",
      stage: "observation",
      level: "medium",
      message: "No text runs were recovered from the current object-aware shell observation strategy.",
    });
  }

  const observation: PdfObservedDocument = {
    kind: "shell",
    strategy: "decoded-text-operators",
    extractedText,
    pages,
    knownLimits: collectObservationKnownLimits(
      inspection,
      observedPageResult.hasFontMappingGap,
      observedPageResult.hasLiteralFontEncodingGap,
      extractedText.length > 0,
    ),
  };

  return stageResult(
    "observation",
    admission.status === "partial" || diagnostics.length > 0 ? "partial" : "completed",
    diagnostics,
    observation,
  );
}

function buildLayoutStage(
  observation: PdfStageResult<PdfObservedDocument>,
): PdfStageResult<PdfLayoutDocument> {
  if (observation.value === undefined) {
    return stageResult("layout", observation.status === "failed" ? "failed" : "blocked", observation.diagnostics);
  }

  const diagnostics = createLayoutDiagnostics(observation);
  const layout = buildLayoutDocument(observation.value);

  return stageResult(
    "layout",
    observation.status === "partial" || diagnostics.length > 0 ? "partial" : "completed",
    diagnostics,
    layout,
  );
}

function buildKnowledgeStage(
  observation: PdfStageResult<PdfObservedDocument>,
  layout: PdfStageResult<PdfLayoutDocument>,
): PdfStageResult<PdfKnowledgeDocument> {
  if (layout.value === undefined) {
    return stageResult("knowledge", layout.status === "failed" ? "failed" : "blocked", layout.diagnostics);
  }

  const knowledge = buildKnowledgeDocument(layout.value, observation.value);
  const diagnostics = createKnowledgeDiagnostics(layout, knowledge);

  return stageResult(
    "knowledge",
    layout.status === "partial" || diagnostics.length > 0 ? "partial" : "completed",
    diagnostics,
    knowledge,
  );
}

function buildObservedPages(
  inspection: PdfShellInspection,
  diagnostics: PdfDiagnostic[],
): { pages: readonly PdfObservedPage[]; hasFontMappingGap: boolean; hasLiteralFontEncodingGap: boolean } {
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
    code: "shell-observation-page-fallback",
    stage: "observation",
    level: "medium",
    message: "The shell could not resolve the page tree, so observation fell back to all stream objects in source order.",
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
  inspection: PdfShellInspection,
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
  parsedRun: ReturnType<typeof parseTextOperatorRuns>[number],
  fontRefByResourceName: ReadonlyMap<string, PdfObjectRef>,
  unicodeCMapByFontKey: Map<string, ReturnType<typeof parsePdfUnicodeCMap>>,
  embeddedFontMappingByFontKey: Map<string, PdfEmbeddedFontMapping | undefined>,
  singleByteFontEncodingByFontKey: Map<string, PdfSingleByteFontEncoding | undefined>,
  inspection: PdfShellInspection,
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
  const hasHiddenTextFeature = inspection.featureSignals.some(
    (signal) => signal.kind === "hidden-text" && signal.detected,
  );
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
  parsedRun: ReturnType<typeof parseTextOperatorRuns>[number],
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

function shouldReportTextMappingGap(
  parsedRun: ReturnType<typeof parseTextOperatorRuns>[number],
): boolean {
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
  parsedRun: ReturnType<typeof parseTextOperatorRuns>[number],
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
  inspection: PdfShellInspection,
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

  // CID-like hex units without an active font produce noisy pseudo-text in the
  // audited slice and are not actionable font-mapping evidence on their own.
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
  inspection: PdfShellInspection,
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
  inspection: PdfShellInspection,
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
  inspection: PdfShellInspection,
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
  inspection: PdfShellInspection,
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
  inspection: PdfShellInspection,
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
  inspection: PdfShellInspection,
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
  inspection: PdfShellInspection,
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
  inspection: PdfShellInspection,
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
  inspection: PdfShellInspection,
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
  inspection: PdfShellInspection,
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

function canAdvance(admission: PdfStageResult<PdfAdmissionArtifact>): boolean {
  return admission.value?.decision === "accepted" && (admission.status === "completed" || admission.status === "partial");
}

function collectAdmissionKnownLimits(inspection: PdfShellInspection): readonly PdfKnownLimitCode[] {
  const knownLimits: PdfKnownLimitCode[] = [];
  if (inspection.isEncrypted && inspection.decryptionStatus === "unsupported") {
    knownLimits.push("decryption-not-implemented");
  }
  return knownLimits;
}

function collectIrKnownLimits(inspection: PdfShellInspection): readonly PdfKnownLimitCode[] {
  const knownLimits: PdfKnownLimitCode[] = [];

  if (hasUndecodedStreams(inspection)) {
    knownLimits.push("streams-not-decoded");
  }
  if (hasUnsupportedStreamFilters(inspection)) {
    knownLimits.push("unsupported-stream-filters");
  }
  if (hasFailedStreamDecodes(inspection)) {
    knownLimits.push("stream-decoding-failed");
  }
  if (
    inspection.analysis.crossReferenceKind === "xref-stream" ||
    inspection.analysis.crossReferenceKind === "hybrid"
  ) {
    if (!inspection.analysis.decodedXrefStreamEntries && !hasRecoveredStablePageStructure(inspection)) {
      knownLimits.push("xref-stream-entries-not-decoded");
    }
  }
  if (
    inspection.featureSignals.some((signal) => signal.kind === "object-streams" && signal.detected) &&
    !inspection.analysis.expandedObjectStreams
  ) {
    knownLimits.push("object-streams-not-expanded");
  }
  if (inspection.analysis.pageEntries.length > 0 && !inspection.analysis.inheritedPageStateResolved) {
    knownLimits.push("resource-inheritance-unresolved");
  }
  if (!inspection.analysis.pageTreeResolved) {
    knownLimits.push("page-order-heuristic");
  }
  if (inspection.isEncrypted && inspection.decryptionStatus === "unsupported") {
    knownLimits.push("decryption-not-implemented");
  }

  return dedupeKnownLimits(knownLimits);
}

function collectObservationKnownLimits(
  inspection: PdfShellInspection,
  hasFontMappingGap: boolean,
  hasLiteralFontEncodingGap: boolean,
  hasParagraphText: boolean,
): readonly PdfKnownLimitCode[] {
  const knownLimits: PdfKnownLimitCode[] = [...collectIrKnownLimits(inspection)];
  if (inspection.analysis.indirectObjects.some((objectShell) => typeof objectShell.streamText === "string")) {
    knownLimits.push("text-decoding-heuristic");
  }
  if (hasParagraphText) {
    knownLimits.push("paragraph-break-heuristic");
  }
  if (hasFontMappingGap) {
    knownLimits.push("font-unicode-mapping-not-implemented");
  }
  if (hasLiteralFontEncodingGap) {
    knownLimits.push("literal-font-encoding-not-implemented");
  }
  return dedupeKnownLimits(knownLimits);
}

function dedupeKnownLimits(knownLimits: readonly PdfKnownLimitCode[]): readonly PdfKnownLimitCode[] {
  return Array.from(new Set(knownLimits));
}

function hasDecodedStreams(inspection: PdfShellInspection): boolean {
  return inspection.analysis.indirectObjects.some(
    (objectShell) => objectShell.streamDecodeState === "available" || objectShell.streamDecodeState === "decoded",
  );
}

function hasUndecodedStreams(inspection: PdfShellInspection): boolean {
  return inspection.analysis.indirectObjects.some(
    (objectShell) =>
      objectShell.hasStream &&
      isParserRelevantStream(objectShell) &&
      objectShell.streamDecodeState !== "available" &&
      objectShell.streamDecodeState !== "decoded",
  );
}

function hasUnsupportedStreamFilters(inspection: PdfShellInspection): boolean {
  return inspection.analysis.indirectObjects.some(
    (objectShell) => isParserRelevantStream(objectShell) && objectShell.streamDecodeState === "unsupported-filter",
  );
}

function hasFailedStreamDecodes(inspection: PdfShellInspection): boolean {
  return inspection.analysis.indirectObjects.some(
    (objectShell) => isParserRelevantStream(objectShell) && objectShell.streamDecodeState === "failed",
  );
}

function hasRecoveredStablePageStructure(inspection: PdfShellInspection): boolean {
  return inspection.analysis.pageTreeResolved && (
    inspection.analysis.pageEntries.length === 0 ||
    inspection.analysis.inheritedPageStateResolved
  );
}

function isParserRelevantStream(
  objectShell: PdfShellInspection["analysis"]["indirectObjects"][number],
): boolean {
  if (!objectShell.hasStream) {
    return false;
  }

  if (objectShell.streamRole !== "unknown") {
    return true;
  }

  if (objectShell.dictionaryEntries.get("Subtype")?.trim() === "/Image") {
    return false;
  }

  if (objectShell.dictionaryEntries.get("Filter")?.trim() === "/DCTDecode") {
    return false;
  }

  if (objectShell.dictionaryEntries.has("FunctionType")) {
    return false;
  }

  return objectShell.typeName?.trim() !== "/XObject";
}

function createAdmissionDiagnostics(inspection: PdfShellInspection): PdfDiagnostic[] {
  const diagnostics: PdfDiagnostic[] = [];

  if (inspection.analysis.isTruncated) {
    diagnostics.push({
      code: "scan-budget-truncated",
      stage: "admission",
      level: "medium",
      message: "The shell parse hit the current scan budget and may only reflect a partial document view.",
    });
  }

  if (inspection.analysis.fileType === "pdf" && !inspection.analysis.parseCoverage.indirectObjects) {
    diagnostics.push({
      code: "object-boundaries-missing",
      stage: "admission",
      level: "high",
      message: "The shell could not recover any indirect-object boundaries from the scanned source.",
    });
  }

  if (inspection.analysis.fileType === "pdf" && !inspection.analysis.parseCoverage.startXref) {
    diagnostics.push({
      code: "xref-start-missing",
      stage: "admission",
      level: "medium",
      message: "The shell did not find a startxref marker.",
    });
  } else if (inspection.analysis.fileType === "pdf" && !inspection.analysis.startXrefResolved) {
    diagnostics.push({
      code: "xref-start-mismatch",
      stage: "admission",
      level: "medium",
      message: "The startxref marker does not point to a recovered cross-reference section.",
    });
  }

  if (inspection.analysis.fileType === "pdf" && !inspection.analysis.parseCoverage.crossReference) {
    diagnostics.push({
      code: "xref-missing",
      stage: "admission",
      level: "medium",
      message: "The shell did not recover a classic xref table or xref stream.",
    });
  }

  if (inspection.analysis.fileType === "pdf" && !inspection.analysis.parseCoverage.trailer) {
    diagnostics.push({
      code: "trailer-missing",
      stage: "admission",
      level: "medium",
      message: "The shell did not recover a trailer dictionary or trailer-like xref-stream dictionary.",
    });
  }

  if (inspection.analysis.repairState === "recovered") {
    diagnostics.push({
      code: "repair-recovered",
      stage: "admission",
      level: "medium",
      message: "The shell recovered structural facts heuristically instead of trusting a clean xref/trailer path.",
    });
  }

  return diagnostics;
}

function createIrDiagnostics(inspection: PdfShellInspection): PdfDiagnostic[] {
  const diagnostics: PdfDiagnostic[] = [];

  if (!inspection.analysis.pageTreeResolved && inspection.analysis.pageEntries.length > 0) {
    diagnostics.push({
      code: "page-tree-recovered",
      stage: "ir",
      level: "medium",
      message: "The shell recovered page objects heuristically because the page tree could not be traversed from the catalog.",
    });
  }

  if (inspection.analysis.pageEntries.length === 0) {
    diagnostics.push({
      code: "page-tree-unresolved",
      stage: "ir",
      level: "medium",
      message: "The shell could not recover any page objects from the current source.",
    });
  }

  for (const objectShell of inspection.analysis.indirectObjects) {
    if (isParserRelevantStream(objectShell) && objectShell.streamDecodeState === "unsupported-filter") {
      diagnostics.push({
        code: "stream-filter-unsupported",
        stage: "ir",
        level: "medium",
        message: "The shell found a stream filter that it does not decode yet.",
        objectRef: objectShell.ref,
      });
    }

    if (isParserRelevantStream(objectShell) && objectShell.streamDecodeState === "failed") {
      diagnostics.push({
        code: "stream-decoding-failed",
        stage: "ir",
        level: "medium",
        message: "The shell could not decode one recovered stream body.",
        objectRef: objectShell.ref,
      });
    }
  }

  return diagnostics;
}

function createObservationDiagnostics(inspection: PdfShellInspection): PdfDiagnostic[] {
  const diagnostics: PdfDiagnostic[] = [];

  if (!inspection.analysis.pageTreeResolved && inspection.analysis.pageEntries.length > 0) {
    diagnostics.push({
      code: "shell-observation-page-order-heuristic",
      stage: "observation",
      level: "medium",
      message: "Observation uses recovered page order because the page tree was not resolved from the catalog.",
    });
  }

  return diagnostics;
}

function createLayoutDiagnostics(observation: PdfStageResult<PdfObservedDocument>): PdfDiagnostic[] {
  const diagnostics: PdfDiagnostic[] = [];

  diagnostics.push({
    code: "layout-block-heuristic",
    stage: "layout",
    level: "medium",
    message: "The current layout stage groups observed runs into line-oriented blocks heuristically.",
  });
  diagnostics.push({
    code: "layout-reading-order-heuristic",
    stage: "layout",
    level: "medium",
    message: "The current layout reading order follows observed page order and recovered text anchors heuristically.",
  });
  diagnostics.push({
    code: "layout-role-heuristic",
    stage: "layout",
    level: "medium",
    message: "The current layout roles are heuristic and should not be treated as final semantic labels.",
  });

  if (observation.value?.pages.every((page) => page.runs.length === 0)) {
    diagnostics.push({
      code: "layout-empty",
      stage: "layout",
      level: "medium",
      message: "The layout stage could not build any blocks because the observation stage recovered no text runs.",
    });
  }

  return diagnostics;
}

function createKnowledgeDiagnostics(
  layout: PdfStageResult<PdfLayoutDocument>,
  knowledge: PdfKnowledgeDocument,
): PdfDiagnostic[] {
  const diagnostics: PdfDiagnostic[] = [];

  diagnostics.push({
    code: "knowledge-chunk-heuristic",
    stage: "knowledge",
    level: "medium",
    message: "The current knowledge stage groups layout blocks into extractive chunks heuristically.",
  });
  diagnostics.push(
    knowledge.tables.length === 0
      ? {
          code: "table-projection-not-implemented",
          stage: "knowledge",
          level: "medium",
          message: "The current knowledge stage does not emit tables unless stronger structural evidence is available.",
        }
      : {
          code: "table-projection-heuristic",
          stage: "knowledge",
          level: "medium",
          message: "The current knowledge stage projects tables heuristically from recovered layout and observation evidence.",
        },
  );

  if (layout.value?.pages.every((page) => page.blocks.length === 0)) {
    diagnostics.push({
      code: "knowledge-empty",
      stage: "knowledge",
      level: "medium",
      message: "The knowledge stage did not emit any chunks because the layout stage recovered no usable blocks.",
    });
  }

  return diagnostics;
}

function stageResult<T>(
  stage: PdfStageResult<T>["stage"],
  status: PdfStageResult<T>["status"],
  diagnostics: readonly PdfDiagnostic[],
): PdfStageResult<T>;
function stageResult<T>(
  stage: PdfStageResult<T>["stage"],
  status: PdfStageResult<T>["status"],
  diagnostics: readonly PdfDiagnostic[],
  value: T,
): PdfStageResult<T>;
function stageResult<T>(
  stage: PdfStageResult<T>["stage"],
  status: PdfStageResult<T>["status"],
  diagnostics: readonly PdfDiagnostic[],
  value?: T,
): PdfStageResult<T> {
  const base = {
    stage,
    status,
    diagnostics: dedupeDiagnostics(diagnostics),
  };

  return value === undefined ? base : { ...base, value };
}

function mergePolicy(
  defaults: PdfNormalizedAdmissionPolicy,
  override?: PdfAdmissionPolicy,
): PdfNormalizedAdmissionPolicy {
  return {
    javascriptActions: override?.javascriptActions ?? defaults.javascriptActions,
    launchActions: override?.launchActions ?? defaults.launchActions,
    embeddedFiles: override?.embeddedFiles ?? defaults.embeddedFiles,
    repairMode: override?.repairMode ?? defaults.repairMode,
    passwordPolicy: override?.passwordPolicy ?? defaults.passwordPolicy,
    allowEncryptedMetadata: override?.allowEncryptedMetadata ?? defaults.allowEncryptedMetadata,
    resourceBudget: {
      maxBytes: override?.resourceBudget?.maxBytes ?? defaults.resourceBudget.maxBytes,
      maxPages: override?.resourceBudget?.maxPages ?? defaults.resourceBudget.maxPages,
      maxObjects: override?.resourceBudget?.maxObjects ?? defaults.resourceBudget.maxObjects,
      maxMilliseconds: override?.resourceBudget?.maxMilliseconds ?? defaults.resourceBudget.maxMilliseconds,
      maxRecursionDepth: override?.resourceBudget?.maxRecursionDepth ?? defaults.resourceBudget.maxRecursionDepth,
      maxScanBytes: override?.resourceBudget?.maxScanBytes ?? defaults.resourceBudget.maxScanBytes,
    },
  };
}

function detectRuntime(): PdfRuntimeDescriptor {
  const value = globalThis as typeof globalThis & {
    readonly Bun?: { readonly version?: string };
    readonly Deno?: { readonly version?: { readonly deno?: string } };
    readonly process?: { readonly release?: { readonly name?: string }; readonly versions?: { readonly node?: string } };
  };

  if (typeof value.Deno?.version?.deno === "string") {
    return { kind: "deno", version: value.Deno.version.deno };
  }

  if (typeof value.Bun?.version === "string") {
    return { kind: "bun", version: value.Bun.version };
  }

  if (value.process?.release?.name === "node") {
    return createRuntimeDescriptor("node", value.process.versions?.node);
  }

  if (typeof window !== "undefined") {
    return { kind: "web" };
  }

  return { kind: "unknown" };
}

function createRuntimeDescriptor(kind: PdfRuntimeDescriptor["kind"], version?: string): PdfRuntimeDescriptor {
  return version === undefined ? { kind } : { kind, version };
}

function detectRuntimeCapabilities(runtime: PdfRuntimeDescriptor): PdfRuntimeCapabilities {
  const value = globalThis as typeof globalThis & {
    readonly Worker?: unknown;
    readonly performance?: { readonly now?: () => number };
    readonly ReadableStream?: unknown;
  };

  return {
    streams: typeof value.ReadableStream !== "undefined",
    fileSystem: runtime.kind === "node" || runtime.kind === "bun" || runtime.kind === "deno",
    webWorker: typeof value.Worker !== "undefined",
    highResolutionTime: typeof value.performance.now === "function",
  };
}

function detectFeatureSignals(
  analysis: PdfShellAnalysis,
  policy: PdfNormalizedAdmissionPolicy,
): PdfFeatureSignal[] {
  const parsedFeatureRefs = detectParsedFeatureRefs(analysis);
  const useScanFallback = shouldUseFeatureScanFallback(analysis);

  return FEATURE_PATTERNS.map((entry) => {
    const objectRef = parsedFeatureRefs.get(entry.kind);
    const usesScanEvidence = objectRef === undefined && (usesScanFeatureDetection(entry.kind) || useScanFallback);
    const detected = objectRef !== undefined || (usesScanEvidence && entry.pattern.test(analysis.scanText));
    const evidenceSource: PdfFeatureEvidenceSource = objectRef !== undefined || !usesScanEvidence ? "object" : "scan";
    const action = entry.actionKey ? policy[entry.actionKey] : "report";
    return {
      kind: entry.kind,
      action,
      detected,
      evidenceSource,
      ...(objectRef !== undefined ? { objectRef } : {}),
      message: buildFeatureSignalMessage(entry.kind, action, detected, evidenceSource, objectRef, usesScanEvidence && useScanFallback),
    };
  });
}

function isEncryptedAnalysis(
  analysis: PdfShellAnalysis,
  policy: PdfNormalizedAdmissionPolicy,
): boolean {
  return detectFeatureSignals(analysis, policy).some(
    (signal) => signal.kind === "encryption" && signal.detected,
  );
}

function detectParsedFeatureRefs(
  analysis: PdfShellAnalysis,
): ReadonlyMap<PdfFeatureKind, PdfObjectRef> {
  const featureRefs = new Map<PdfFeatureKind, PdfObjectRef>();
  const rootRef = analysis.trailer?.rootRef;
  const rootObject = rootRef ? analysis.objectIndex.get(keyOfObjectRef(rootRef)) : undefined;

  if (analysis.trailer?.encryptRef !== undefined) {
    featureRefs.set("encryption", analysis.trailer.encryptRef);
  }
  if (rootRef && rootObject?.dictionaryEntries.has("AcroForm")) {
    featureRefs.set("forms", rootRef);
  }
  if (rootRef && rootObject?.dictionaryEntries.has("Outlines")) {
    featureRefs.set("outlines", rootRef);
  }
  if (
    analysis.crossReferenceKind === "xref-stream" ||
    analysis.crossReferenceKind === "hybrid"
  ) {
    const xrefObjectRef = analysis.crossReferenceSections.find(
      (section) => section.kind === "xref-stream" && section.objectRef !== undefined,
    )?.objectRef ?? analysis.indirectObjects.find((objectShell) => objectShell.typeName === "XRef")?.ref;
    if (xrefObjectRef) {
      featureRefs.set("xref-streams", xrefObjectRef);
    }
  }

  const firstAnnotationRef = analysis.pageEntries.find((pageEntry) => pageEntry.annotationRefs.length > 0)?.annotationRefs[0];
  if (firstAnnotationRef) {
    featureRefs.set("annotations", firstAnnotationRef);
  }

  for (const objectShell of analysis.indirectObjects) {
    const subtypeName = readNameValue(objectShell.dictionaryEntries.get("Subtype"));
    const actionName = readNameValue(objectShell.dictionaryEntries.get("S"));
    const fieldTypeName = readNameValue(objectShell.dictionaryEntries.get("FT"));

    if (!featureRefs.has("object-streams") && objectShell.typeName === "ObjStm") {
      featureRefs.set("object-streams", objectShell.ref);
    }
    if (!featureRefs.has("images") && subtypeName === "Image") {
      featureRefs.set("images", objectShell.ref);
    }
    if (!featureRefs.has("fonts") && objectShell.typeName === "Font") {
      featureRefs.set("fonts", objectShell.ref);
    }
    if (
      !featureRefs.has("javascript-actions") &&
      (actionName === "JavaScript" || objectShell.dictionaryEntries.has("JS") || objectShell.dictionaryEntries.has("JavaScript"))
    ) {
      featureRefs.set("javascript-actions", objectShell.ref);
    }
    if (!featureRefs.has("launch-actions") && actionName === "Launch") {
      featureRefs.set("launch-actions", objectShell.ref);
    }
    if (
      !featureRefs.has("embedded-files") &&
      (objectShell.typeName === "EmbeddedFile" || objectShell.dictionaryEntries.has("EmbeddedFile") || objectShell.dictionaryEntries.has("EF"))
    ) {
      featureRefs.set("embedded-files", objectShell.ref);
    }
    if (!featureRefs.has("signatures") && (objectShell.typeName === "Sig" || fieldTypeName === "Sig")) {
      featureRefs.set("signatures", objectShell.ref);
    }
  }

  return featureRefs;
}

function shouldUseFeatureScanFallback(analysis: PdfShellAnalysis): boolean {
  return analysis.isTruncated ||
    !analysis.parseCoverage.indirectObjects ||
    !analysis.parseCoverage.trailer ||
    analysis.repairState !== "clean";
}

function usesScanFeatureDetection(kind: PdfFeatureKind): boolean {
  return kind === "hidden-text" || kind === "duplicate-text-layer";
}

function buildFeatureSignalMessage(
  kind: PdfFeatureKind,
  action: PdfFeatureSignal["action"],
  detected: boolean,
  evidenceSource: PdfFeatureEvidenceSource,
  objectRef?: PdfObjectRef,
  isFallbackScan = false,
): string {
  const featureLabel = kind.replaceAll("-", " ");
  if (detected) {
    if (evidenceSource === "object") {
      const objectDetail = objectRef ? ` at ${formatObjectRef(objectRef)}` : "";
      return `Detected ${featureLabel} from parsed object evidence${objectDetail}; policy action is ${action}.`;
    }
    const fallbackDetail = isFallbackScan ? " while parsed object coverage was incomplete" : "";
    return `Detected ${featureLabel} from scan fallback${fallbackDetail}; policy action is ${action}.`;
  }

  if (evidenceSource === "object") {
    return `No ${featureLabel} detected in parsed object evidence.`;
  }

  const fallbackDetail = isFallbackScan ? " while parsed object coverage was incomplete" : "";
  return `No ${featureLabel} detected in scan fallback${fallbackDetail}.`;
}

function readNameValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.startsWith("/") ? trimmedValue.slice(1) : undefined;
}

function formatObjectRef(objectRef: PdfObjectRef): string {
  return `${String(objectRef.objectNumber)} ${String(objectRef.generationNumber)} R`;
}

function dedupeDiagnostics(diagnostics: readonly PdfDiagnostic[]): PdfDiagnostic[] {
  const seen = new Set<string>();
  const unique: PdfDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.stage,
      diagnostic.code,
      diagnostic.level,
      diagnostic.message,
      diagnostic.pageNumber ?? "",
      diagnostic.feature ?? "",
      diagnostic.objectRef?.objectNumber ?? "",
      diagnostic.objectRef?.generationNumber ?? "",
      diagnostic.detail ?? "",
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(diagnostic);
  }

  return unique;
}
