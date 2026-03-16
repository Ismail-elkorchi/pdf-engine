import { analyzePdfShell, extractTextOperatorRuns, keyOfObjectRef, type PdfShellAnalysis } from "./shell-parse.ts";

import type {
  PdfAdmissionArtifact,
  PdfAdmissionDecision,
  PdfAdmissionPolicy,
  PdfAdmissionRequest,
  PdfDiagnostic,
  PdfEngine,
  PdfEngineIdentity,
  PdfEngineOptions,
  PdfFeatureKind,
  PdfFeatureSignal,
  PdfIrDocument,
  PdfIrPageShell,
  PdfIrRequest,
  PdfKnownLimitCode,
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
  supportedStages: ["admission", "ir", "observation"],
};

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
  { kind: "hidden-text", pattern: /\/(?:OC|ActualText)\b/, actionKey: null },
  { kind: "duplicate-text-layer", pattern: /\/Subtype\s*\/Image\b[\s\S]{0,500}\/Font\b/, actionKey: null },
] as const;

interface PdfShellInspection {
  readonly analysis: PdfShellAnalysis;
  readonly featureSignals: readonly PdfFeatureSignal[];
  readonly isEncrypted: boolean;
  readonly policy: PdfNormalizedAdmissionPolicy;
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
    run,
  };

  async function dispose(): Promise<void> {}

  async function admit(request: PdfAdmissionRequest): Promise<PdfStageResult<PdfAdmissionArtifact>> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const inspection = await inspectSource(request.source, policy);
    return buildAdmissionStage(request, inspection);
  }

  async function toIr(request: PdfIrRequest): Promise<PdfStageResult<PdfIrDocument>> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const inspection = await inspectSource(request.source, policy);
    const admission = await buildAdmissionStage(
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
    const inspection = await inspectSource(request.source, policy);
    const admission = await buildAdmissionStage(
      {
        source: request.source,
        ...(request.policy !== undefined ? { policy: request.policy } : {}),
        ...(request.passwordProvider !== undefined ? { passwordProvider: request.passwordProvider } : {}),
      },
      inspection,
    );
    return buildObservationStage(inspection, admission);
  }

  async function run(request: PdfPipelineRequest): Promise<PdfPipelineResult> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const inspection = await inspectSource(request.source, policy);
    const admission = await buildAdmissionStage(request, inspection);
    const ir = buildIrStage(inspection, admission);
    const observation = buildObservationStage(inspection, admission);

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
      diagnostics: dedupeDiagnostics([...admission.diagnostics, ...ir.diagnostics, ...observation.diagnostics]),
    };
  }
}

async function inspectSource(
  source: PdfAdmissionRequest["source"],
  policy: PdfNormalizedAdmissionPolicy,
): Promise<PdfShellInspection> {
  const analysis = await analyzePdfShell(source, policy);
  const featureSignals = detectFeatureSignals(analysis.scanText, policy);
  const isEncrypted = featureSignals.some((signal) => signal.kind === "encryption" && signal.detected);

  return {
    analysis,
    featureSignals,
    isEncrypted,
    policy,
  };
}

async function buildAdmissionStage(
  request: Pick<PdfAdmissionRequest, "source" | "policy" | "passwordProvider">,
  inspection: PdfShellInspection,
): Promise<PdfStageResult<PdfAdmissionArtifact>> {
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

  const encryptionDecision = await resolveEncryptionDecision(request, inspection, diagnostics);
  const decision = encryptionDecision ?? ("accepted" satisfies PdfAdmissionDecision);
  const status = decision === "accepted" ? (inspection.analysis.repairState === "clean" ? "completed" : "partial") : "blocked";

  return stageResult("admission", status, diagnostics, {
    ...artifactBase,
    decision,
  });
}

async function resolveEncryptionDecision(
  request: Pick<PdfAdmissionRequest, "source" | "passwordProvider">,
  inspection: PdfShellInspection,
  diagnostics: PdfDiagnostic[],
): Promise<PdfAdmissionDecision | undefined> {
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

  if (!request.passwordProvider) {
    diagnostics.push({
      code: "password-required",
      stage: "admission",
      level: "medium",
      message: "A password provider is required before the document can advance.",
      feature: "encryption",
    });
    return "password-required";
  }

  const password = await request.passwordProvider({
    reason: "document-encrypted",
    attempts: 0,
    ...(request.source.fileName !== undefined ? { fileName: request.source.fileName } : {}),
  });

  if (!password) {
    diagnostics.push({
      code: "password-not-provided",
      stage: "admission",
      level: "medium",
      message: "The password provider declined to provide a password.",
      feature: "encryption",
    });
    return "password-required";
  }

  diagnostics.push({
    code: "decryption-not-implemented",
    stage: "admission",
    level: "medium",
    message: "The object-aware shell recognizes encrypted PDFs but does not implement decryption yet.",
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
    expandedObjectStreams: false,
    decodedXrefStreamEntries: false,
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
  const pages = buildObservedPages(inspection, diagnostics);
  const extractedText = pages.flatMap((page) => page.runs.map((run) => run.text)).join("\n");

  if (extractedText.length === 0) {
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
    knownLimits: collectObservationKnownLimits(inspection),
  };

  return stageResult(
    "observation",
    admission.status === "partial" || diagnostics.length > 0 ? "partial" : "completed",
    diagnostics,
    observation,
  );
}

function buildObservedPages(
  inspection: PdfShellInspection,
  diagnostics: PdfDiagnostic[],
): PdfObservedPage[] {
  const resolutionMethod = inspection.analysis.pageTreeResolved ? "page-tree" : "recovered-page-order";
  const observedPages = inspection.analysis.pageEntries.map((pageEntry) =>
    buildObservedPage(pageEntry.pageNumber, pageEntry.pageRef, pageEntry.contentStreamRefs, resolutionMethod, inspection),
  );

  const hasTextRuns = observedPages.some((page) => page.runs.length > 0);
  if (hasTextRuns || inspection.analysis.pageEntries.length > 0) {
    return observedPages;
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

  return [buildObservedPage(1, undefined, fallbackStreamRefs, "stream-fallback", inspection)];
}

function buildObservedPage(
  pageNumber: number,
  pageRef: PdfObjectRef | undefined,
  contentStreamRefs: readonly PdfObjectRef[],
  resolutionMethod: "page-tree" | "recovered-page-order" | "stream-fallback",
  inspection: PdfShellInspection,
): PdfObservedPage {
  const glyphs: PdfObservedGlyph[] = [];
  const runs: PdfObservedTextRun[] = [];
  let contentOrder = 0;

  for (const contentStreamRef of contentStreamRefs) {
    const contentStream = inspection.analysis.objectIndex.get(keyOfObjectRef(contentStreamRef));
    if (!contentStream?.streamText) {
      continue;
    }

    const extractedRuns = extractTextOperatorRuns(contentStream.streamText);
    for (const runText of extractedRuns) {
      const glyphIds: string[] = [];
      const codePoints = Array.from(runText);

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
          objectRef: contentStreamRef,
        });
      }

      runs.push({
        id: `run-${pageNumber}-${contentOrder + 1}`,
        pageNumber,
        contentOrder,
        text: runText,
        glyphIds,
        origin: "native-text",
        contentStreamRef,
        objectRef: contentStreamRef,
      });

      contentOrder += 1;
    }
  }

  return {
    pageNumber,
    resolutionMethod,
    ...(pageRef !== undefined ? { pageRef } : {}),
    glyphs,
    runs,
  };
}

function canAdvance(admission: PdfStageResult<PdfAdmissionArtifact>): boolean {
  return admission.value?.decision === "accepted" && (admission.status === "completed" || admission.status === "partial");
}

function collectAdmissionKnownLimits(inspection: PdfShellInspection): readonly PdfKnownLimitCode[] {
  const knownLimits: PdfKnownLimitCode[] = [];
  if (inspection.isEncrypted) {
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
    knownLimits.push("xref-stream-entries-not-decoded");
  }
  if (inspection.featureSignals.some((signal) => signal.kind === "object-streams" && signal.detected)) {
    knownLimits.push("object-streams-not-expanded");
  }
  if (inspection.analysis.pageEntries.length > 0 && !inspection.analysis.inheritedPageStateResolved) {
    knownLimits.push("resource-inheritance-unresolved");
  }
  if (!inspection.analysis.pageTreeResolved) {
    knownLimits.push("page-order-heuristic");
  }
  if (inspection.isEncrypted) {
    knownLimits.push("decryption-not-implemented");
  }

  return dedupeKnownLimits(knownLimits);
}

function collectObservationKnownLimits(inspection: PdfShellInspection): readonly PdfKnownLimitCode[] {
  const knownLimits: PdfKnownLimitCode[] = [...collectIrKnownLimits(inspection)];
  if (inspection.analysis.indirectObjects.some((objectShell) => typeof objectShell.streamText === "string")) {
    knownLimits.push("text-decoding-heuristic");
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
    (objectShell) => objectShell.hasStream && objectShell.streamDecodeState !== "available" && objectShell.streamDecodeState !== "decoded",
  );
}

function hasUnsupportedStreamFilters(inspection: PdfShellInspection): boolean {
  return inspection.analysis.indirectObjects.some((objectShell) => objectShell.streamDecodeState === "unsupported-filter");
}

function hasFailedStreamDecodes(inspection: PdfShellInspection): boolean {
  return inspection.analysis.indirectObjects.some((objectShell) => objectShell.streamDecodeState === "failed");
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
    if (objectShell.streamDecodeState === "unsupported-filter") {
      diagnostics.push({
        code: "stream-filter-unsupported",
        stage: "ir",
        level: "medium",
        message: "The shell found a stream filter that it does not decode yet.",
        objectRef: objectShell.ref,
      });
    }

    if (objectShell.streamDecodeState === "failed") {
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

function detectFeatureSignals(text: string, policy: PdfNormalizedAdmissionPolicy): PdfFeatureSignal[] {
  return FEATURE_PATTERNS.map((entry) => {
    const detected = entry.pattern.test(text);
    const action = entry.actionKey ? policy[entry.actionKey] : "report";
    return {
      kind: entry.kind,
      action,
      detected,
      message: detected
        ? `Detected ${entry.kind.replaceAll("-", " ")}; policy action is ${action}.`
        : `No ${entry.kind.replaceAll("-", " ")} detected in the scanned shell input.`,
    };
  });
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
