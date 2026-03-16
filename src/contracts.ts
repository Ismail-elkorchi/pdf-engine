/**
 * Runtime kinds that `pdf-engine` can identify when an engine instance is created.
 */
export type PdfRuntimeKind = "node" | "deno" | "bun" | "web" | "unknown";

/**
 * Pipeline stages that the public engine surface exposes today or plans to expose later.
 */
export type PdfStageKind = "admission" | "ir" | "observation" | "layout" | "knowledge" | "render";

/**
 * Execution status for one pipeline stage.
 */
export type PdfStageStatus = "completed" | "blocked" | "failed" | "partial" | "skipped";

/**
 * Severity levels used by structured diagnostics.
 */
export type PdfRiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Caller intent used to tune admission and downstream work.
 */
export type PdfExecutionIntent = "admission" | "text" | "layout" | "knowledge" | "render";

/**
 * Policy action applied when a risky or sensitive PDF feature is detected.
 */
export type PdfPolicyAction = "allow" | "report" | "deny";

/**
 * Repair strategy requested for malformed input.
 */
export type PdfRepairMode = "never" | "safe" | "aggressive";

/**
 * Password handling policy for encrypted documents.
 */
export type PdfPasswordPolicy = "forbid" | "known-only" | "interactive";

/**
 * High-level admission decision for an input document.
 */
export type PdfAdmissionDecision = "accepted" | "rejected" | "password-required" | "unsupported";

/**
 * Feature kinds that the engine can surface during admission and later parsing stages.
 */
export type PdfFeatureKind =
  | "javascript-actions"
  | "embedded-files"
  | "launch-actions"
  | "forms"
  | "annotations"
  | "outlines"
  | "signatures"
  | "encryption"
  | "object-streams"
  | "xref-streams"
  | "images"
  | "fonts"
  | "hidden-text"
  | "duplicate-text-layer";

/**
 * Source of an observed text item.
 */
export type PdfObservationOrigin = "native-text" | "heuristic-text" | "ocr" | "unknown";

/**
 * Cross-reference organization detected for a PDF file.
 */
export type PdfCrossReferenceKind = "classic" | "xref-stream" | "hybrid" | "unknown";

/**
 * Caller-provided resource limits for one request.
 */
export interface PdfResourceBudget {
  /** Maximum accepted input size in bytes. */
  readonly maxBytes?: number;
  /** Maximum accepted page count estimate. */
  readonly maxPages?: number;
  /** Maximum accepted indirect-object count estimate. */
  readonly maxObjects?: number;
  /** Maximum intended wall-clock budget in milliseconds. */
  readonly maxMilliseconds?: number;
  /** Maximum recursion depth allowed for recursive parsing work. */
  readonly maxRecursionDepth?: number;
  /** Maximum byte count scanned for shell-stage heuristics. */
  readonly maxScanBytes?: number;
}

/**
 * Fully normalized resource limits after defaults and overrides are merged.
 */
export interface PdfNormalizedResourceBudget {
  /** Maximum accepted input size in bytes. */
  readonly maxBytes: number;
  /** Maximum accepted page count estimate. */
  readonly maxPages: number;
  /** Maximum accepted indirect-object count estimate. */
  readonly maxObjects: number;
  /** Maximum intended wall-clock budget in milliseconds. */
  readonly maxMilliseconds: number;
  /** Maximum recursion depth allowed for recursive parsing work. */
  readonly maxRecursionDepth: number;
  /** Maximum byte count scanned for shell-stage heuristics. */
  readonly maxScanBytes: number;
}

/**
 * Admission policy controls for risky features, repair behavior, passwords, and resource budgets.
 */
export interface PdfAdmissionPolicy {
  /** Action to take when JavaScript actions are detected. */
  readonly javascriptActions?: PdfPolicyAction;
  /** Action to take when launch actions are detected. */
  readonly launchActions?: PdfPolicyAction;
  /** Action to take when embedded files are detected. */
  readonly embeddedFiles?: PdfPolicyAction;
  /** Repair strategy for malformed input. */
  readonly repairMode?: PdfRepairMode;
  /** Password handling policy for encrypted documents. */
  readonly passwordPolicy?: PdfPasswordPolicy;
  /** Whether encrypted metadata may still be inspected when allowed by the file. */
  readonly allowEncryptedMetadata?: boolean;
  /** Optional resource limits for this request. */
  readonly resourceBudget?: PdfResourceBudget;
}

/**
 * Admission policy after defaults and overrides are merged into concrete values.
 */
export interface PdfNormalizedAdmissionPolicy {
  /** Action to take when JavaScript actions are detected. */
  readonly javascriptActions: PdfPolicyAction;
  /** Action to take when launch actions are detected. */
  readonly launchActions: PdfPolicyAction;
  /** Action to take when embedded files are detected. */
  readonly embeddedFiles: PdfPolicyAction;
  /** Repair strategy for malformed input. */
  readonly repairMode: PdfRepairMode;
  /** Password handling policy for encrypted documents. */
  readonly passwordPolicy: PdfPasswordPolicy;
  /** Whether encrypted metadata may still be inspected when allowed by the file. */
  readonly allowEncryptedMetadata: boolean;
  /** Concrete resource limits used for the request. */
  readonly resourceBudget: PdfNormalizedResourceBudget;
}

/**
 * Raw document input accepted by the engine.
 */
export interface PdfDocumentSource {
  /** Document bytes. */
  readonly bytes: Uint8Array;
  /** Optional source file name for diagnostics and logs. */
  readonly fileName?: string;
  /** Optional caller-supplied media type hint. */
  readonly mediaType?: string;
  /** Optional caller-supplied SHA-256 digest of the source bytes. */
  readonly sha256?: string;
}

/**
 * Axis-aligned rectangle in page-space units.
 */
export interface PdfBoundingBox {
  /** Left coordinate. */
  readonly x: number;
  /** Top or origin-relative vertical coordinate. */
  readonly y: number;
  /** Rectangle width. */
  readonly width: number;
  /** Rectangle height. */
  readonly height: number;
}

/**
 * Indirect object reference inside a PDF file.
 */
export interface PdfObjectRef {
  /** Indirect object number. */
  readonly objectNumber: number;
  /** Generation number for the indirect object. */
  readonly generationNumber: number;
}

/**
 * Runtime detected for an engine instance.
 */
export interface PdfRuntimeDescriptor {
  /** Runtime kind. */
  readonly kind: PdfRuntimeKind;
  /** Optional runtime version string when the engine can discover it. */
  readonly version?: string;
}

/**
 * Capabilities detected for the current runtime.
 */
export interface PdfRuntimeCapabilities {
  /** Whether stream primitives are available. */
  readonly streams: boolean;
  /** Whether a local filesystem is expected to be available. */
  readonly fileSystem: boolean;
  /** Whether web worker style concurrency is available. */
  readonly webWorker: boolean;
  /** Whether a high-resolution timer is available. */
  readonly highResolutionTime: boolean;
}

/**
 * Identity metadata for the engine implementation that produced a result.
 */
export interface PdfEngineIdentity {
  /** Public package name or engine identifier. */
  readonly name: string;
  /** Public engine version string. */
  readonly version: string;
  /** Implementation mode for the current engine. */
  readonly mode: "shell";
}

/**
 * Structured diagnostic emitted by a stage.
 */
export interface PdfDiagnostic {
  /** Stable machine-readable diagnostic code. */
  readonly code: string;
  /** Stage that emitted the diagnostic. */
  readonly stage: PdfStageKind;
  /** Severity level. */
  readonly level: PdfRiskLevel;
  /** Human-readable diagnostic summary. */
  readonly message: string;
  /** Related feature kind when the diagnostic is feature-specific. */
  readonly feature?: PdfFeatureKind;
  /** Related page number when known. */
  readonly pageNumber?: number;
  /** Related object reference when known. */
  readonly objectRef?: PdfObjectRef;
  /** Optional extra detail for logs or support tooling. */
  readonly detail?: string;
}

/**
 * Detection result for one feature kind during admission.
 */
export interface PdfFeatureSignal {
  /** Feature kind that was evaluated. */
  readonly kind: PdfFeatureKind;
  /** Policy action that applies to this feature kind. */
  readonly action: PdfPolicyAction;
  /** Whether the feature was detected in the current source. */
  readonly detected: boolean;
  /** Human-readable summary of the detection result. */
  readonly message: string;
}

/**
 * Password request metadata passed to a caller-supplied password provider.
 */
export interface PdfPasswordChallenge {
  /** Reason the engine is asking for a password. */
  readonly reason: "document-encrypted";
  /** Optional source file name. */
  readonly fileName?: string;
  /** Number of password attempts already made for this request. */
  readonly attempts: number;
}

/**
 * Callback used to supply a password for an encrypted document.
 */
export type PdfPasswordProvider = (challenge: PdfPasswordChallenge) => Promise<string | null> | string | null;

/**
 * Result of the admission stage.
 */
export interface PdfAdmissionArtifact {
  /** Final admission decision. */
  readonly decision: PdfAdmissionDecision;
  /** File type classification produced by admission. */
  readonly fileType: "pdf" | "unknown";
  /** Optional source file name. */
  readonly fileName?: string;
  /** Source length in bytes. */
  readonly byteLength: number;
  /** Parsed or inferred PDF version when known. */
  readonly pdfVersion?: string;
  /** Estimated page count when the shell can infer it. */
  readonly pageCountEstimate?: number;
  /** Estimated indirect-object count when the shell can infer it. */
  readonly objectCountEstimate?: number;
  /** Whether the document appears to be encrypted. */
  readonly isEncrypted: boolean;
  /** Feature detection results captured during admission. */
  readonly featureSignals: readonly PdfFeatureSignal[];
  /** Fully normalized policy used for the request. */
  readonly policy: PdfNormalizedAdmissionPolicy;
}

/**
 * Per-page shell summary in the current IR implementation.
 */
export interface PdfIrPageShell {
  /** One-based page number. */
  readonly pageNumber: number;
  /** Number of content streams mapped to this page shell. */
  readonly contentStreamCount: number;
  /** Number of `/Resources` hits mapped to this page shell. */
  readonly resourceCount: number;
  /** Number of annotations mapped to this page shell. */
  readonly annotationCount: number;
}

/**
 * Shell-stage intermediate representation for a document.
 */
export interface PdfIrDocument {
  /** IR implementation kind. */
  readonly kind: "shell";
  /** Parsed or inferred PDF version when known. */
  readonly pdfVersion?: string;
  /** Source length in bytes. */
  readonly byteLength: number;
  /** Estimated page count when known. */
  readonly pageCountEstimate?: number;
  /** Estimated indirect-object count when known. */
  readonly objectCountEstimate?: number;
  /** Cross-reference organization detected by the shell. */
  readonly crossReferenceKind: PdfCrossReferenceKind;
  /** Whether the document appears to be encrypted. */
  readonly isEncrypted: boolean;
  /** Feature kinds detected during admission. */
  readonly featureKinds: readonly PdfFeatureKind[];
  /** Per-page shell summaries. */
  readonly pages: readonly PdfIrPageShell[];
}

/**
 * Observed glyph-level text evidence.
 */
export interface PdfObservedGlyph {
  /** Stable glyph identifier within the observation result. */
  readonly id: string;
  /** One-based page number. */
  readonly pageNumber: number;
  /** Zero-based glyph index within its run. */
  readonly glyphIndex: number;
  /** Content-order position for the run that produced this glyph. */
  readonly contentOrder: number;
  /** Glyph text payload. */
  readonly text: string;
  /** Unicode code point for the glyph text. */
  readonly unicodeCodePoint: number;
  /** Whether the glyph is considered hidden by the observation stage. */
  readonly hidden: boolean;
  /** Origin of the glyph observation. */
  readonly origin: PdfObservationOrigin;
  /** Optional originating object reference. */
  readonly objectRef?: PdfObjectRef;
  /** Optional glyph bounding box. */
  readonly bbox?: PdfBoundingBox;
}

/**
 * Observed text run emitted by the observation stage.
 */
export interface PdfObservedTextRun {
  /** Stable run identifier within the observation result. */
  readonly id: string;
  /** One-based page number. */
  readonly pageNumber: number;
  /** Zero-based content-order position for the run. */
  readonly contentOrder: number;
  /** Combined run text. */
  readonly text: string;
  /** Glyph identifiers that compose the run. */
  readonly glyphIds: readonly string[];
  /** Origin of the run observation. */
  readonly origin: PdfObservationOrigin;
  /** Optional run bounding box. */
  readonly bbox?: PdfBoundingBox;
}

/**
 * One observed page in the shell-stage observation result.
 */
export interface PdfObservedPage {
  /** One-based page number. */
  readonly pageNumber: number;
  /** Observed glyphs for the page. */
  readonly glyphs: readonly PdfObservedGlyph[];
  /** Observed text runs for the page. */
  readonly runs: readonly PdfObservedTextRun[];
}

/**
 * Shell-stage observation result for a document.
 */
export interface PdfObservedDocument {
  /** Observation implementation kind. */
  readonly kind: "shell";
  /** Flattened extracted text emitted by the shell. */
  readonly extractedText: string;
  /** Observed pages in source order. */
  readonly pages: readonly PdfObservedPage[];
}

/**
 * Generic result wrapper for one pipeline stage.
 *
 * @typeParam T Value emitted by the stage when available.
 */
export interface PdfStageResult<T> {
  /** Stage that produced the result. */
  readonly stage: PdfStageKind;
  /** Stage execution status. */
  readonly status: PdfStageStatus;
  /** Diagnostics emitted by the stage. */
  readonly diagnostics: readonly PdfDiagnostic[];
  /** Stage value when the stage completed or produced a partial result. */
  readonly value?: T;
}

/**
 * Request accepted by the admission stage.
 */
export interface PdfAdmissionRequest {
  /** Source document. */
  readonly source: PdfDocumentSource;
  /** Optional caller intent. */
  readonly intent?: PdfExecutionIntent;
  /** Optional request-specific policy overrides. */
  readonly policy?: PdfAdmissionPolicy;
  /** Optional password provider for encrypted documents. */
  readonly passwordProvider?: PdfPasswordProvider;
}

/**
 * Request accepted by the IR stage.
 */
export interface PdfIrRequest {
  /** Source document. */
  readonly source: PdfDocumentSource;
  /** Optional request-specific policy overrides. */
  readonly policy?: PdfAdmissionPolicy;
}

/**
 * Request accepted by the observation stage.
 */
export interface PdfObservationRequest {
  /** Source document. */
  readonly source: PdfDocumentSource;
  /** Optional request-specific policy overrides. */
  readonly policy?: PdfAdmissionPolicy;
}

/**
 * Request accepted by the full staged pipeline.
 */
export interface PdfPipelineRequest {
  /** Source document. */
  readonly source: PdfDocumentSource;
  /** Optional caller intent. */
  readonly intent?: PdfExecutionIntent;
  /** Optional request-specific policy overrides. */
  readonly policy?: PdfAdmissionPolicy;
  /** Optional password provider for encrypted documents. */
  readonly passwordProvider?: PdfPasswordProvider;
}

/**
 * Source summary copied into a pipeline result.
 */
export interface PdfPipelineSourceSummary {
  /** Optional source file name. */
  readonly fileName?: string;
  /** Optional caller-supplied media type hint. */
  readonly mediaType?: string;
  /** Optional caller-supplied SHA-256 digest of the source bytes. */
  readonly sha256?: string;
  /** Source length in bytes. */
  readonly byteLength: number;
}

/**
 * Result returned by the full staged pipeline.
 */
export interface PdfPipelineResult {
  /** Engine identity that produced the result. */
  readonly engine: PdfEngineIdentity;
  /** Runtime detected for the engine instance. */
  readonly runtime: PdfRuntimeDescriptor;
  /** Source summary for the processed document. */
  readonly source: PdfPipelineSourceSummary;
  /** Admission stage result. */
  readonly admission: PdfStageResult<PdfAdmissionArtifact>;
  /** IR stage result. */
  readonly ir: PdfStageResult<PdfIrDocument>;
  /** Observation stage result. */
  readonly observation: PdfStageResult<PdfObservedDocument>;
  /** De-duplicated diagnostics across the completed stages. */
  readonly diagnostics: readonly PdfDiagnostic[];
}

/**
 * Options accepted when creating an engine instance.
 */
export interface PdfEngineOptions {
  /** Default policy overrides applied to every request unless a request supplies its own overrides. */
  readonly defaultPolicy?: PdfAdmissionPolicy;
}

/**
 * Public engine surface exposed by `pdf-engine`.
 */
export interface PdfEngine {
  /** Engine identity metadata. */
  readonly identity: PdfEngineIdentity;
  /** Runtime detected for the engine instance. */
  readonly runtime: PdfRuntimeDescriptor;
  /** Capabilities detected for the current runtime. */
  readonly capabilities: PdfRuntimeCapabilities;
  /** Normalized default policy used by the engine instance. */
  readonly defaultPolicy: PdfNormalizedAdmissionPolicy;
  /**
   * Runs the admission stage for one document.
   *
   * @param request Admission request.
   * @returns Admission result.
   */
  admit(request: PdfAdmissionRequest): Promise<PdfStageResult<PdfAdmissionArtifact>>;
  /**
   * Produces the shell-stage intermediate representation for one document.
   *
   * @param request IR request.
   * @returns IR stage result.
   */
  toIr(request: PdfIrRequest): Promise<PdfStageResult<PdfIrDocument>>;
  /**
   * Produces observed text evidence for one document.
   *
   * @param request Observation request.
   * @returns Observation stage result.
   */
  observe(request: PdfObservationRequest): Promise<PdfStageResult<PdfObservedDocument>>;
  /**
   * Runs the staged shell pipeline for one document.
   *
   * @param request Pipeline request.
   * @returns Combined staged result.
   */
  run(request: PdfPipelineRequest): Promise<PdfPipelineResult>;
}
