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
 * Encoding form used by the text operand that produced an observed run or glyph.
 */
export type PdfTextEncodingKind = "literal" | "hex" | "cid";

/**
 * Cross-reference organization detected for a PDF file.
 */
export type PdfCrossReferenceKind = "classic" | "xref-stream" | "hybrid" | "unknown";

/**
 * Structural recovery state for the current shell parse.
 */
export type PdfRepairState = "clean" | "recovered" | "recovery-required";

/**
 * Stable implementation-limit codes that the current shell engine can expose without hiding known gaps.
 */
export type PdfKnownLimitCode =
  | "decryption-not-implemented"
  | "font-unicode-mapping-not-implemented"
  | "streams-not-decoded"
  | "unsupported-stream-filters"
  | "stream-decoding-failed"
  | "xref-stream-entries-not-decoded"
  | "object-streams-not-expanded"
  | "resource-inheritance-unresolved"
  | "text-decoding-heuristic"
  | "paragraph-break-heuristic"
  | "page-order-heuristic"
  | "layout-block-heuristic"
  | "layout-role-heuristic"
  | "layout-reading-order-heuristic"
  | "knowledge-chunk-heuristic"
  | "table-projection-not-implemented";

/**
 * Decode state for one recovered stream object.
 */
export type PdfStreamDecodeState = "available" | "decoded" | "unsupported-filter" | "failed";

/**
 * Observation strategy used to produce the current text evidence.
 */
export type PdfObservationStrategy = "decoded-text-operators" | "heuristic-literal-scan";

/**
 * Structural role for one recovered stream object.
 */
export type PdfStreamRole = "content" | "tounicode" | "cmap" | "xref" | "object-stream" | "unknown";

/**
 * How page ordering for the current page shell or observation page was resolved.
 */
export type PdfPageResolutionMethod = "page-tree" | "recovered-page-order" | "stream-fallback";

/**
 * Where a page-level value came from after page-tree inheritance was resolved.
 */
export type PdfPageValueOrigin = "direct" | "inherited";

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
 * One anchor point in page-space units.
 */
export interface PdfPoint {
  /** Horizontal coordinate. */
  readonly x: number;
  /** Vertical coordinate. */
  readonly y: number;
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
 * Structural coverage reached by the current shell parse.
 */
export interface PdfParseCoverage {
  /** Whether a `%PDF-` header was found. */
  readonly header: boolean;
  /** Whether at least one indirect object boundary was recovered. */
  readonly indirectObjects: boolean;
  /** Whether a classic xref table or xref stream was found. */
  readonly crossReference: boolean;
  /** Whether a trailer dictionary or trailer-like xref-stream dictionary was found. */
  readonly trailer: boolean;
  /** Whether a `startxref` marker was found. */
  readonly startXref: boolean;
  /** Whether the page tree was traversed from the catalog. */
  readonly pageTree: boolean;
}

/**
 * One cross-reference section recovered by the shell parse.
 */
export interface PdfCrossReferenceSection {
  /** Cross-reference section kind. */
  readonly kind: "classic" | "xref-stream";
  /** Byte offset where the section starts in the scanned source. */
  readonly offset: number;
  /** Number of entries declared or implied by the section when known. */
  readonly entryCount?: number;
  /** Number of xref entries successfully decoded from the section when known. */
  readonly decodedEntryCount?: number;
  /** Object reference for an xref stream section when one exists. */
  readonly objectRef?: PdfObjectRef;
}

/**
 * Trailer summary recovered from the shell parse.
 */
export interface PdfTrailerShell {
  /** Declared `/Size` value when present. */
  readonly size?: number;
  /** `/Root` reference when present. */
  readonly rootRef?: PdfObjectRef;
  /** `/Info` reference when present. */
  readonly infoRef?: PdfObjectRef;
  /** `/Encrypt` reference when present. */
  readonly encryptRef?: PdfObjectRef;
  /** `/Prev` offset when present. */
  readonly prevOffset?: number;
  /** Whether an `/ID` entry is present. */
  readonly hasDocumentId: boolean;
}

/**
 * One indirect object boundary recovered by the shell parse.
 */
export interface PdfIndirectObjectShell {
  /** Indirect object reference. */
  readonly ref: PdfObjectRef;
  /** Byte offset where the `obj` header starts. */
  readonly offset: number;
  /** Byte offset immediately after the matching `endobj`. */
  readonly endOffset: number;
  /** Whether the object contains a stream. */
  readonly hasStream: boolean;
  /** `/Type` name when the shell can recover it. */
  readonly typeName?: string;
  /** Top-level dictionary keys recovered from the object. */
  readonly dictionaryKeys: readonly string[];
  /** Stream byte length within the scanned shell input when known. */
  readonly streamByteLength?: number;
  /** Declared stream filters in decode order when present. */
  readonly streamFilterNames?: readonly string[];
  /** Stream decode state for the current shell implementation. */
  readonly streamDecodeState?: PdfStreamDecodeState;
  /** Decoded stream byte length when operator-ready bytes are available. */
  readonly decodedStreamByteLength?: number;
  /** Structural role inferred for the stream when the shell can classify it. */
  readonly streamRole?: PdfStreamRole;
  /** Containing object stream reference when this object was expanded from an object stream. */
  readonly containerObjectRef?: PdfObjectRef;
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
  /** Runtimes that the public package currently claims to support. */
  readonly supportedRuntimes: readonly PdfRuntimeKind[];
  /** Stages that the current implementation actually exposes. */
  readonly supportedStages: readonly PdfStageKind[];
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
  /** `startxref` offset when the shell can recover it. */
  readonly startXrefOffset?: number;
  /** Whether the document appears to be encrypted. */
  readonly isEncrypted: boolean;
  /** Structural recovery state for the current shell parse. */
  readonly repairState: PdfRepairState;
  /** Structural coverage reached by the current shell parse. */
  readonly parseCoverage: PdfParseCoverage;
  /** Feature detection results captured during admission. */
  readonly featureSignals: readonly PdfFeatureSignal[];
  /** Fully normalized policy used for the request. */
  readonly policy: PdfNormalizedAdmissionPolicy;
  /** Known implementation limits that materially affect this admission result. */
  readonly knownLimits: readonly PdfKnownLimitCode[];
}

/**
 * Per-page shell summary in the current IR implementation.
 */
export interface PdfIrPageShell {
  /** One-based page number. */
  readonly pageNumber: number;
  /** How page ordering for this shell page was resolved. */
  readonly resolutionMethod: PdfPageResolutionMethod;
  /** Page object reference when the page tree could be traversed. */
  readonly pageRef?: PdfObjectRef;
  /** Number of content streams mapped to this page shell. */
  readonly contentStreamCount: number;
  /** Content stream references mapped to this page shell. */
  readonly contentStreamRefs: readonly PdfObjectRef[];
  /** Number of `/Resources` hits mapped to this page shell. */
  readonly resourceCount: number;
  /** Whether the current resource mapping came from the page or an inherited ancestor. */
  readonly resourceOrigin?: PdfPageValueOrigin;
  /** Resource dictionary reference when present and indirect. */
  readonly resourceRef?: PdfObjectRef;
  /** Number of annotations mapped to this page shell. */
  readonly annotationCount: number;
  /** Annotation references mapped to this page shell. */
  readonly annotationRefs: readonly PdfObjectRef[];
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
  /** `startxref` offset when the shell can recover it. */
  readonly startXrefOffset?: number;
  /** Cross-reference organization detected by the shell. */
  readonly crossReferenceKind: PdfCrossReferenceKind;
  /** Whether the document appears to be encrypted. */
  readonly isEncrypted: boolean;
  /** Structural recovery state for the current shell parse. */
  readonly repairState: PdfRepairState;
  /** Structural coverage reached by the current shell parse. */
  readonly parseCoverage: PdfParseCoverage;
  /** Cross-reference sections recovered by the shell parse. */
  readonly crossReferenceSections: readonly PdfCrossReferenceSection[];
  /** Trailer summary recovered by the shell parse. */
  readonly trailer?: PdfTrailerShell;
  /** Indirect object shells recovered by the shell parse. */
  readonly indirectObjects: readonly PdfIndirectObjectShell[];
  /** Feature kinds detected during admission. */
  readonly featureKinds: readonly PdfFeatureKind[];
  /** Per-page shell summaries. */
  readonly pages: readonly PdfIrPageShell[];
  /** Whether the shell recovered at least one operator-ready stream body. */
  readonly decodedStreams: boolean;
  /** Whether object streams were expanded into member objects. */
  readonly expandedObjectStreams: boolean;
  /** Whether xref stream entries were decoded into a full index. */
  readonly decodedXrefStreamEntries: boolean;
  /** Whether inherited page resources and defaults were resolved. */
  readonly resolvedInheritedPageState: boolean;
  /** Known implementation limits that materially affect this IR. */
  readonly knownLimits: readonly PdfKnownLimitCode[];
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
  /** Content stream reference that produced this glyph when known. */
  readonly contentStreamRef?: PdfObjectRef;
  /** Font object reference active when this glyph was decoded when known. */
  readonly fontRef?: PdfObjectRef;
  /** Text operand encoding form used to decode this glyph when known. */
  readonly textEncodingKind?: PdfTextEncodingKind;
  /** Optional originating object reference. */
  readonly objectRef?: PdfObjectRef;
  /** Approximate text anchor when the shell can recover one. */
  readonly anchor?: PdfPoint;
  /** Active font size when the shell can recover it. */
  readonly fontSize?: number;
  /** Whether the glyph run started on a new text line. */
  readonly startsNewLine?: boolean;
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
  /** Content stream reference that produced this run when known. */
  readonly contentStreamRef?: PdfObjectRef;
  /** Font object reference active when this run was decoded when known. */
  readonly fontRef?: PdfObjectRef;
  /** Text operand encoding form used to decode this run when known. */
  readonly textEncodingKind?: PdfTextEncodingKind;
  /** Optional originating object reference. */
  readonly objectRef?: PdfObjectRef;
  /** Approximate text anchor when the shell can recover one. */
  readonly anchor?: PdfPoint;
  /** Active font size when the shell can recover it. */
  readonly fontSize?: number;
  /** Whether this run started on a new text line. */
  readonly startsNewLine?: boolean;
  /** Optional run bounding box. */
  readonly bbox?: PdfBoundingBox;
}

/**
 * One observed page in the shell-stage observation result.
 */
export interface PdfObservedPage {
  /** One-based page number. */
  readonly pageNumber: number;
  /** How page ordering for this observation page was resolved. */
  readonly resolutionMethod: PdfPageResolutionMethod;
  /** Page object reference when known. */
  readonly pageRef?: PdfObjectRef;
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
  /** Observation strategy used to recover the current text evidence. */
  readonly strategy: PdfObservationStrategy;
  /** Flattened extracted text emitted by the shell. */
  readonly extractedText: string;
  /** Observed pages in source order. */
  readonly pages: readonly PdfObservedPage[];
  /** Known implementation limits that materially affect this observation result. */
  readonly knownLimits: readonly PdfKnownLimitCode[];
}

/**
 * Structural role inferred for one layout block.
 */
export type PdfLayoutRole = "body" | "heading" | "list" | "header" | "footer" | "unknown";

/**
 * First-layout strategy used by the shell implementation.
 */
export type PdfLayoutStrategy = "line-blocks";

/**
 * One layout block recovered from the observed text stage.
 */
export interface PdfLayoutBlock {
  /** Stable block identifier within the layout result. */
  readonly id: string;
  /** One-based page number. */
  readonly pageNumber: number;
  /** Reading-order position within the page layout result. */
  readonly readingOrder: number;
  /** Combined block text. */
  readonly text: string;
  /** Role inferred for the block. */
  readonly role: PdfLayoutRole;
  /** Confidence attached to the current role assignment. */
  readonly roleConfidence: number;
  /** Whether the current block starts a new paragraph according to the shell layout heuristics. */
  readonly startsParagraph: boolean;
  /** Observation run identifiers grouped into this block. */
  readonly runIds: readonly string[];
  /** Observation glyph identifiers grouped into this block. */
  readonly glyphIds: readonly string[];
  /** How page ordering for this layout block was resolved. */
  readonly resolutionMethod: PdfPageResolutionMethod;
  /** Page object reference when known. */
  readonly pageRef?: PdfObjectRef;
  /** Approximate block anchor when the shell can recover one. */
  readonly anchor?: PdfPoint;
  /** Dominant font size for the first run in this block when the shell can recover it. */
  readonly fontSize?: number;
}

/**
 * One layout page in the shell-stage layout result.
 */
export interface PdfLayoutPage {
  /** One-based page number. */
  readonly pageNumber: number;
  /** How page ordering for this layout page was resolved. */
  readonly resolutionMethod: PdfPageResolutionMethod;
  /** Page object reference when known. */
  readonly pageRef?: PdfObjectRef;
  /** Layout blocks in reading order. */
  readonly blocks: readonly PdfLayoutBlock[];
}

/**
 * First-layout result for a document.
 */
export interface PdfLayoutDocument {
  /** Layout implementation kind. */
  readonly kind: "shell-layout";
  /** Layout strategy used by the current implementation. */
  readonly strategy: PdfLayoutStrategy;
  /** Layout pages in reading order. */
  readonly pages: readonly PdfLayoutPage[];
  /** Flattened text in layout reading order. */
  readonly extractedText: string;
  /** Known implementation limits that materially affect this layout result. */
  readonly knownLimits: readonly PdfKnownLimitCode[];
}

/**
 * Role assigned to one knowledge chunk.
 */
export type PdfKnowledgeChunkRole = PdfLayoutRole | "mixed";

/**
 * First knowledge-projection strategy used by the shell implementation.
 */
export type PdfKnowledgeStrategy = "layout-chunks";

/**
 * One provenance record attached to a knowledge chunk or table cell.
 */
export interface PdfKnowledgeCitation {
  /** Stable citation identifier within the knowledge result. */
  readonly id: string;
  /** One-based page number. */
  readonly pageNumber: number;
  /** Source layout block identifier. */
  readonly blockId: string;
  /** Source observation run identifiers. */
  readonly runIds: readonly string[];
  /** Source block text excerpt. */
  readonly text: string;
  /** Page object reference when known. */
  readonly pageRef?: PdfObjectRef;
}

/**
 * One chunk projected from the layout stage for downstream agent use.
 */
export interface PdfKnowledgeChunk {
  /** Stable chunk identifier within the knowledge result. */
  readonly id: string;
  /** Chunk text emitted for downstream consumption. */
  readonly text: string;
  /** Role attached to the current chunk. */
  readonly role: PdfKnowledgeChunkRole;
  /** Page numbers covered by the chunk. */
  readonly pageNumbers: readonly number[];
  /** Source layout block identifiers covered by the chunk. */
  readonly blockIds: readonly string[];
  /** Source observation run identifiers covered by the chunk. */
  readonly runIds: readonly string[];
  /** Provenance records for the chunk. */
  readonly citations: readonly PdfKnowledgeCitation[];
}

/**
 * One cell emitted in a projected knowledge table.
 */
export interface PdfKnowledgeTableCell {
  /** Zero-based row index. */
  readonly rowIndex: number;
  /** Zero-based column index. */
  readonly columnIndex: number;
  /** Cell text. */
  readonly text: string;
  /** Provenance records for the cell. */
  readonly citations: readonly PdfKnowledgeCitation[];
}

/**
 * One projected knowledge table.
 */
export interface PdfKnowledgeTable {
  /** Stable table identifier within the knowledge result. */
  readonly id: string;
  /** One-based page number. */
  readonly pageNumber: number;
  /** Source layout block identifiers that fed this table. */
  readonly blockIds: readonly string[];
  /** Confidence attached to the current table projection. */
  readonly confidence: number;
  /** Projected cells in row-major order. */
  readonly cells: readonly PdfKnowledgeTableCell[];
}

/**
 * First knowledge-stage result for a document.
 */
export interface PdfKnowledgeDocument {
  /** Knowledge implementation kind. */
  readonly kind: "shell-knowledge";
  /** Knowledge strategy used by the current implementation. */
  readonly strategy: PdfKnowledgeStrategy;
  /** Chunk projections for downstream agent use. */
  readonly chunks: readonly PdfKnowledgeChunk[];
  /** Table projections when the current evidence is sufficient. */
  readonly tables: readonly PdfKnowledgeTable[];
  /** Flattened text in knowledge-chunk order. */
  readonly extractedText: string;
  /** Known implementation limits that materially affect this knowledge result. */
  readonly knownLimits: readonly PdfKnownLimitCode[];
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
  /** Optional password provider for encrypted documents. */
  readonly passwordProvider?: PdfPasswordProvider;
}

/**
 * Request accepted by the observation stage.
 */
export interface PdfObservationRequest {
  /** Source document. */
  readonly source: PdfDocumentSource;
  /** Optional request-specific policy overrides. */
  readonly policy?: PdfAdmissionPolicy;
  /** Optional password provider for encrypted documents. */
  readonly passwordProvider?: PdfPasswordProvider;
}

/**
 * Request accepted by the layout stage.
 */
export interface PdfLayoutRequest {
  /** Source document. */
  readonly source: PdfDocumentSource;
  /** Optional request-specific policy overrides. */
  readonly policy?: PdfAdmissionPolicy;
  /** Optional password provider for encrypted documents. */
  readonly passwordProvider?: PdfPasswordProvider;
}

/**
 * Request accepted by the knowledge stage.
 */
export interface PdfKnowledgeRequest {
  /** Source document. */
  readonly source: PdfDocumentSource;
  /** Optional request-specific policy overrides. */
  readonly policy?: PdfAdmissionPolicy;
  /** Optional password provider for encrypted documents. */
  readonly passwordProvider?: PdfPasswordProvider;
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
  /** Layout stage result. */
  readonly layout: PdfStageResult<PdfLayoutDocument>;
  /** Knowledge stage result. */
  readonly knowledge: PdfStageResult<PdfKnowledgeDocument>;
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
   * Releases engine-owned resources.
   *
   * The current shell implementation is a no-op, but future backends may own workers,
   * WASM instances, caches, or native bridges that require explicit cleanup.
   */
  dispose(): Promise<void>;
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
   * Produces the shell-stage layout result for one document.
   *
   * @param request Layout request.
   * @returns Layout stage result.
   */
  toLayout(request: PdfLayoutRequest): Promise<PdfStageResult<PdfLayoutDocument>>;
  /**
   * Produces the shell-stage knowledge result for one document.
   *
   * @param request Knowledge request.
   * @returns Knowledge stage result.
   */
  toKnowledge(request: PdfKnowledgeRequest): Promise<PdfStageResult<PdfKnowledgeDocument>>;
  /**
   * Runs the staged shell pipeline for one document.
   *
   * @param request Pipeline request.
   * @returns Combined staged result.
   */
  run(request: PdfPipelineRequest): Promise<PdfPipelineResult>;
}
