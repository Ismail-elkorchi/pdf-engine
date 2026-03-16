export type PdfRuntime = "node" | "deno" | "bun" | "web";

export type PdfTrustMode = "trusted" | "untrusted";

export type PdfTaskKind = "probe" | "parse" | "knowledge" | "render";

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

export type PdfObservationOrigin = "native-text" | "ocr" | "image-region" | "vector-mark" | "unknown";

export type PdfInferenceKind =
  | "reading-order"
  | "paragraph"
  | "heading"
  | "list"
  | "table"
  | "caption"
  | "footnote"
  | "ocr-fusion"
  | "chunk-boundary";

export type PdfRiskLevel = "low" | "medium" | "high" | "critical";

export interface PdfResourcePolicy {
  readonly maxPages?: number;
  readonly maxObjects?: number;
  readonly maxDecodedBytes?: number;
  readonly maxMilliseconds?: number;
  readonly maxRecursionDepth?: number;
}

export interface PdfRequestContext {
  readonly runtime: PdfRuntime;
  readonly trustMode: PdfTrustMode;
  readonly task: PdfTaskKind;
  readonly resourcePolicy?: PdfResourcePolicy;
}

export interface PdfWarning {
  readonly code: string;
  readonly message: string;
  readonly level: PdfRiskLevel;
  readonly page?: number;
  readonly objectRef?: string;
}

export interface PdfFeatureSignal {
  readonly kind: PdfFeatureKind;
  readonly level: PdfRiskLevel;
  readonly message: string;
}

export interface PdfBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfObjectRef {
  readonly objectNumber: number;
  readonly generationNumber: number;
}

export interface PdfProbeReport {
  readonly fileType: "pdf" | "unknown";
  readonly version?: string;
  readonly pageCount?: number;
  readonly encrypted: boolean;
  readonly features: readonly PdfFeatureSignal[];
  readonly warnings: readonly PdfWarning[];
}

export interface PdfIrMetadata {
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords: readonly string[];
  readonly creationDate?: string;
  readonly modificationDate?: string;
}

export interface PdfIrPage {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly contentStreamRefs: readonly PdfObjectRef[];
  readonly resourceRefs: readonly PdfObjectRef[];
  readonly annotationRefs: readonly PdfObjectRef[];
}

export interface PdfIrDocument {
  readonly pageCount: number;
  readonly metadata: PdfIrMetadata;
  readonly pages: readonly PdfIrPage[];
  readonly warnings: readonly PdfWarning[];
}

export interface PdfObservedTextSpan {
  readonly id: string;
  readonly pageNumber: number;
  readonly text: string;
  readonly bbox: PdfBoundingBox;
  readonly objectRefs: readonly PdfObjectRef[];
  readonly origin: PdfObservationOrigin;
  readonly contentOrderIndex: number;
  readonly fontName?: string;
  readonly fontSize?: number;
  readonly direction?: "ltr" | "rtl" | "ttb" | "btt" | "unknown";
  readonly hidden: boolean;
}

export interface PdfObservedRegion {
  readonly id: string;
  readonly pageNumber: number;
  readonly kind: "image" | "vector" | "clip" | "unknown";
  readonly bbox: PdfBoundingBox;
  readonly objectRefs: readonly PdfObjectRef[];
}

export interface PdfObservedPage {
  readonly pageNumber: number;
  readonly spans: readonly PdfObservedTextSpan[];
  readonly regions: readonly PdfObservedRegion[];
}

export interface PdfObservedDocument {
  readonly pages: readonly PdfObservedPage[];
  readonly warnings: readonly PdfWarning[];
}

export interface PdfInferenceRecord {
  readonly id: string;
  readonly kind: PdfInferenceKind;
  readonly pageNumber: number;
  readonly inputSpanIds: readonly string[];
  readonly confidence: number;
  readonly rationaleCodes: readonly string[];
}

export interface PdfLayoutNode {
  readonly id: string;
  readonly pageNumber: number;
  readonly kind:
    | "paragraph"
    | "heading"
    | "list"
    | "table"
    | "table-row"
    | "table-cell"
    | "caption"
    | "footnote"
    | "figure"
    | "unknown";
  readonly bbox: PdfBoundingBox;
  readonly text: string;
  readonly observedSpanIds: readonly string[];
  readonly inferenceIds: readonly string[];
  readonly confidence: number;
}

export interface PdfLayoutDocument {
  readonly pages: ReadonlyArray<{
    readonly pageNumber: number;
    readonly nodes: readonly PdfLayoutNode[];
  }>;
  readonly inferences: readonly PdfInferenceRecord[];
  readonly warnings: readonly PdfWarning[];
}

export interface PdfCitation {
  readonly pageNumber: number;
  readonly nodeIds: readonly string[];
  readonly spanIds: readonly string[];
  readonly bbox?: PdfBoundingBox;
}

export interface PdfAgentRiskSignal {
  readonly code: string;
  readonly level: PdfRiskLevel;
  readonly message: string;
}

export interface PdfKnowledgeChunk {
  readonly id: string;
  readonly text: string;
  readonly markdown: string;
  readonly citations: readonly PdfCitation[];
  readonly sourceNodeIds: readonly string[];
  readonly confidence: number;
  readonly risks: readonly PdfAgentRiskSignal[];
}

export interface PdfKnowledgeDocument {
  readonly title?: string;
  readonly chunks: readonly PdfKnowledgeChunk[];
  readonly warnings: readonly PdfWarning[];
  readonly risks: readonly PdfAgentRiskSignal[];
}

export interface PdfRenderTextIndexEntry {
  readonly text: string;
  readonly pageNumber: number;
  readonly bbox: PdfBoundingBox;
  readonly spanIds: readonly string[];
}

export interface PdfRenderPage {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly textIndex: readonly PdfRenderTextIndexEntry[];
}

export interface PdfRenderDocument {
  readonly pages: readonly PdfRenderPage[];
  readonly warnings: readonly PdfWarning[];
}

export interface PdfArtifactEnvelope {
  readonly context: PdfRequestContext;
  readonly probe: PdfProbeReport;
  readonly ir?: PdfIrDocument;
  readonly observed?: PdfObservedDocument;
  readonly layout?: PdfLayoutDocument;
  readonly knowledge?: PdfKnowledgeDocument;
  readonly render?: PdfRenderDocument;
  readonly warnings: readonly PdfWarning[];
}

export interface PdfParseRequest {
  readonly bytes: Uint8Array;
  readonly context: PdfRequestContext;
}

export interface PdfEngine {
  readonly id: string;
  readonly version: string;
  readonly runtimes: readonly PdfRuntime[];
  probe(request: PdfParseRequest): Promise<PdfProbeReport>;
  parse(request: PdfParseRequest): Promise<PdfArtifactEnvelope>;
}
