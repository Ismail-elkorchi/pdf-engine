import { buildKnowledgeDocument } from "./knowledge.ts";
import { buildObservedPages } from "./layout/observed.ts";
import { buildLayoutDocument, buildObservationParagraphText } from "./layout.ts";
import { evaluatePdfFeatureFindings, hasDetectedFeatureFinding } from "./pdf-feature-findings.ts";
import { preparePdfStandardPasswordSecurity } from "./pdf-standard-security.ts";
import { buildRenderDocument } from "./render.ts";
import { analyzePdfShell, keyOfObjectRef, type PdfShellAnalysis } from "./shell-parse.ts";

import type {
  PdfAdmissionArtifact,
  PdfAdmissionDecision,
  PdfAdmissionPolicy,
  PdfAdmissionRequest,
  PdfDiagnostic,
  PdfEngine,
  PdfEngineIdentity,
  PdfEngineOptions,
  PdfFeatureFinding,
  PdfFeatureKind,
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
  PdfObservationRequest,
  PdfPipelineRequest,
  PdfPipelineResult,
  PdfRenderDocument,
  PdfRenderRequest,
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
  version: "0.1.0",
  mode: "core",
  supportedRuntimes: ["node", "deno", "bun", "web"],
  supportedStages: ["admission", "ir", "observation", "layout", "knowledge", "render"],
};

interface PdfShellInspection {
  readonly analysis: PdfShellAnalysis;
  readonly featureFindings: readonly PdfFeatureFinding[];
  readonly authoritativeFeatureKinds: readonly PdfFeatureKind[];
  readonly scanFallbackPolicyKinds: readonly PdfFeatureKind[];
  readonly isEncrypted: boolean;
  readonly policy: PdfNormalizedAdmissionPolicy;
  readonly decryptionStatus: "not-needed" | "decrypted" | "password-required" | "invalid-password" | "unsupported";
  readonly decryptionDetail?: string;
}

/**
 * Creates a `pdf-engine` instance with a normalized default admission policy and runtime detection.
 *
 * The current implementation is a staged parser core for admission, IR, and observation stages.
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
    toRender,
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

  async function toRender(request: PdfRenderRequest): Promise<PdfStageResult<PdfRenderDocument>> {
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
    return await buildRenderStage(inspection, observation);
  }

  async function run(request: PdfPipelineRequest): Promise<PdfPipelineResult> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const inspection = await inspectSource(request.source, policy, request.passwordProvider);
    const admission = buildAdmissionStage(request, inspection);
    const ir = buildIrStage(inspection, admission);
    const observation = buildObservationStage(inspection, admission);
    const layout = buildLayoutStage(observation);
    const knowledge = buildKnowledgeStage(observation, layout);
    const render = await buildRenderStage(inspection, observation);

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
      render,
      diagnostics: dedupeDiagnostics([
        ...admission.diagnostics,
        ...ir.diagnostics,
        ...observation.diagnostics,
        ...layout.diagnostics,
        ...knowledge.diagnostics,
        ...render.diagnostics,
      ]),
    };
  }
}

async function inspectSource(
  source: PdfAdmissionRequest["source"],
  policy: PdfNormalizedAdmissionPolicy,
  passwordProvider?: PdfAdmissionRequest["passwordProvider"],
): Promise<PdfShellInspection> {
  const analysis = await analyzePdfShell(source, policy);
  const initialFeatureEvaluation = evaluatePdfFeatureFindings(analysis, policy);

  if (!hasDetectedFeatureFinding(initialFeatureEvaluation.featureFindings, "encryption")) {
    return buildInspection(analysis, policy, "not-needed");
  }

  if (analysis.trailer?.encryptRef === undefined || analysis.documentId === undefined) {
    return buildInspection(
      analysis,
      policy,
      "unsupported",
      "The parser detected encryption markers but could not resolve the encryption dictionary and document identifier.",
    );
  }

  const encryptObject = analysis.objectIndex.get(keyOfObjectRef(analysis.trailer.encryptRef));
  if (!encryptObject) {
    return buildInspection(
      analysis,
      policy,
      "unsupported",
      "The trailer referenced an encryption dictionary that the parser could not recover.",
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
  const featureEvaluation = evaluatePdfFeatureFindings(analysis, policy);
  const featureFindings = featureEvaluation.featureFindings;
  const isEncrypted = hasDetectedFeatureFinding(featureFindings, "encryption");
  return {
    analysis,
    featureFindings,
    authoritativeFeatureKinds: featureEvaluation.authoritativeFeatureKinds,
    scanFallbackPolicyKinds: featureEvaluation.scanFallbackPolicyKinds,
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
    featureFindings: inspection.featureFindings,
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

  diagnostics.push(...buildFeatureFindingDiagnostics(inspection.featureFindings));

  if (inspection.analysis.repairState === "recovery-required") {
    diagnostics.push({
      code: "repair-required",
      stage: "admission",
      level: "high",
      message: "The current parser could not recover enough structure to continue safely.",
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

  if (inspection.scanFallbackPolicyKinds.length > 0) {
    diagnostics.push({
      code: "feature-authority-required",
      stage: "admission",
      level: "high",
      message: `The parser only found ${formatFeatureLabels(inspection.scanFallbackPolicyKinds)} through scan fallback; parsed object authority is required before the document can advance safely.`,
      detail: `Scan fallback remained necessary for: ${inspection.scanFallbackPolicyKinds.join(", ")}.`,
    });
    return stageResult("admission", "blocked", diagnostics, {
      ...artifactBase,
      decision: "unsupported",
    });
  }

  const featureDecision = resolveFeaturePolicyDecision(inspection, diagnostics);
  if (featureDecision) {
    return stageResult("admission", "blocked", diagnostics, {
      ...artifactBase,
      decision: featureDecision,
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
      "The current parser recognizes encrypted PDFs but does not support this encryption variant yet.",
    feature: "encryption",
  });
  return "unsupported";
}

function resolveFeaturePolicyDecision(
  inspection: PdfShellInspection,
  diagnostics: PdfDiagnostic[],
): PdfAdmissionDecision | undefined {
  const deniedFindings = inspection.featureFindings.filter(
    (finding) => finding.action === "deny" && finding.evidenceSource === "object",
  );
  if (deniedFindings.length === 0) {
    return undefined;
  }

  const deniedFeatureKinds = Array.from(new Set(deniedFindings.map((finding) => finding.kind)));

  diagnostics.push({
    code: "feature-denied-by-policy",
    stage: "admission",
    level: "high",
    message: `The active policy rejects ${formatFeatureLabels(deniedFeatureKinds)}.`,
    detail: `Rejected feature kinds: ${deniedFeatureKinds.join(", ")}.`,
    ...(deniedFindings[0]?.objectRef !== undefined ? { objectRef: deniedFindings[0].objectRef } : {}),
  });
  return "rejected";
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
    kind: "pdf-ir",
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
    featureFindings: inspection.featureFindings,
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
    kind: "pdf-observation",
    strategy: "content-stream-interpreter",
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
        message: "The current observation path found encoded text operators that still need font or Unicode mapping support before text can be recovered honestly.",
      });
    }

    if (observedPageResult.hasLiteralFontEncodingGap) {
      diagnostics.push({
        code: "literal-font-encoding-not-implemented",
        stage: "observation",
        level: "medium",
        message:
          "The current observation path suppressed unreadable literal-text runs that still need font-encoding support or marked-content recovery before they can be emitted honestly.",
      });
    }

    diagnostics.push({
      code: "observation-empty",
      stage: "observation",
      level: "medium",
      message: "No text runs were recovered from the current object-aware observation strategy.",
    });
  }

  const observation: PdfObservedDocument = {
    kind: "pdf-observation",
    strategy: "content-stream-interpreter",
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

async function buildRenderStage(
  inspection: PdfShellInspection,
  observation: PdfStageResult<PdfObservedDocument>,
): Promise<PdfStageResult<PdfRenderDocument>> {
  if (observation.value === undefined) {
    return stageResult("render", observation.status === "failed" ? "failed" : "blocked", observation.diagnostics);
  }

  const render = await buildRenderDocument(observation.value, inspection.analysis);
  const diagnostics = createRenderDiagnostics(render);

  return stageResult(
    "render",
    observation.status === "partial" || diagnostics.length > 0 ? "partial" : "completed",
    diagnostics,
    render,
  );
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
    inspection.authoritativeFeatureKinds.includes("object-streams") &&
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
      message: "The parser hit the current scan budget and may only reflect a partial document view.",
    });
  }

  if (inspection.analysis.fileType === "pdf" && !inspection.analysis.parseCoverage.indirectObjects) {
    diagnostics.push({
      code: "object-boundaries-missing",
      stage: "admission",
      level: "high",
      message: "The parser could not recover any indirect-object boundaries from the scanned source.",
    });
  }

  if (inspection.analysis.fileType === "pdf" && !inspection.analysis.parseCoverage.startXref) {
    diagnostics.push({
      code: "xref-start-missing",
      stage: "admission",
      level: "medium",
      message: "The parser did not find a startxref marker.",
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
      message: "The parser did not recover a classic xref table or xref stream.",
    });
  }

  if (inspection.analysis.fileType === "pdf" && !inspection.analysis.parseCoverage.trailer) {
    diagnostics.push({
      code: "trailer-missing",
      stage: "admission",
      level: "medium",
      message: "The parser did not recover a trailer dictionary or trailer-like xref-stream dictionary.",
    });
  }

  if (inspection.analysis.repairState === "recovered") {
    diagnostics.push({
      code: "repair-recovered",
      stage: "admission",
      level: "medium",
      message: "The parser recovered structural facts heuristically instead of trusting a clean xref/trailer path.",
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
      message: "The parser recovered page objects heuristically because the page tree could not be traversed from the catalog.",
    });
  }

  if (inspection.analysis.pageEntries.length === 0) {
    diagnostics.push({
      code: "page-tree-unresolved",
      stage: "ir",
      level: "medium",
      message: "The parser could not recover any page objects from the current source.",
    });
  }

  for (const objectShell of inspection.analysis.indirectObjects) {
    if (isParserRelevantStream(objectShell) && objectShell.streamDecodeState === "unsupported-filter") {
      diagnostics.push({
        code: "stream-filter-unsupported",
        stage: "ir",
        level: "medium",
        message: "The parser found a stream filter that it does not decode yet.",
        objectRef: objectShell.ref,
      });
    }

    if (isParserRelevantStream(objectShell) && objectShell.streamDecodeState === "failed") {
      diagnostics.push({
        code: "stream-decoding-failed",
        stage: "ir",
        level: "medium",
        message: "The parser could not decode one recovered stream body.",
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
      code: "observation-page-order-heuristic",
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

function createRenderDiagnostics(render: PdfRenderDocument): PdfDiagnostic[] {
  const diagnostics: PdfDiagnostic[] = [];

  if (render.knownLimits.includes("render-imagery-partial")) {
    diagnostics.push({
      code: "render-imagery-partial",
      stage: "render",
      level: "medium",
      message: "The current render stage emits deterministic imagery, but some pages still rely on approximated text styling or omit unsupported drawing details.",
    });
  }
  if (render.knownLimits.includes("render-resource-payloads-partial")) {
    diagnostics.push({
      code: "render-resource-payloads-partial",
      stage: "render",
      level: "medium",
      message: "The current render stage exposes payload references, but some font or image bytes are still unavailable for later imagery or raster work.",
    });
  }

  if (render.pages.every((page) => page.displayList.commands.length === 0)) {
    diagnostics.push({
      code: "render-empty",
      stage: "render",
      level: "medium",
      message: "The render stage emitted no display-list commands because the observation stage recovered no page marks.",
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

function buildFeatureFindingDiagnostics(
  featureFindings: readonly PdfFeatureFinding[],
): readonly PdfDiagnostic[] {
  const diagnostics: PdfDiagnostic[] = [];
  const findingsByKind = new Map<PdfFeatureKind, PdfFeatureFinding[]>();

  for (const featureFinding of featureFindings) {
    const currentFindings = findingsByKind.get(featureFinding.kind) ?? [];
    currentFindings.push(featureFinding);
    findingsByKind.set(featureFinding.kind, currentFindings);
  }

  for (const [featureKind, groupedFindings] of findingsByKind) {
    const firstFinding = groupedFindings[0] as PdfFeatureFinding;
    const isPolicyFeature = firstFinding.action === "deny" || firstFinding.action === "allow";
    const isScanOnlyAuthority = groupedFindings.every((finding) => finding.evidenceSource === "scan");
    if (isPolicyFeature && isScanOnlyAuthority) {
      continue;
    }

    const objectDetail = groupedFindings
      .map((finding) => finding.objectRef)
      .filter((objectRef): objectRef is PdfObjectRef => objectRef !== undefined)
      .slice(0, 5)
      .map((objectRef) => `${String(objectRef.objectNumber)} ${String(objectRef.generationNumber)} R`);

    diagnostics.push({
      code: `feature-${featureKind}`,
      stage: "admission",
      level: firstFinding.action === "deny" ? "high" : "medium",
      message: groupedFindings.length === 1
        ? firstFinding.message
        : `Detected ${groupedFindings.length} ${featureKind.replaceAll("-", " ")} findings from ${firstFinding.evidenceSource} evidence; policy action is ${firstFinding.action}.`,
      feature: featureKind,
      ...(firstFinding.objectRef !== undefined ? { objectRef: firstFinding.objectRef } : {}),
      ...(groupedFindings.length > 1 && objectDetail.length > 0
        ? { detail: `Representative object refs: ${objectDetail.join(", ")}.` }
        : {}),
    });
  }

  return diagnostics;
}

function formatFeatureLabels(featureKindsToFormat: readonly PdfFeatureKind[]): string {
  const labels = featureKindsToFormat.map((kind) => kind.replaceAll("-", " "));
  if (labels.length <= 1) {
    return labels[0] ?? "unknown features";
  }

  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
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
