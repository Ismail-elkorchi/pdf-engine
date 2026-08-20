import type {
  PdfBoundingBox,
  PdfDiagnostic,
  PdfFeatureFinding,
  PdfKnowledgeDocument,
  PdfLayoutDocument,
  PdfObservedDocument,
  PdfPolicyAction,
  PdfRuntimeCapabilities,
  PdfRuntimeDescriptor,
} from "./contracts.ts";
import type {
  PdfByteRange,
  PdfDictionaryValue,
  PdfIndirectObject,
  PdfReference,
} from "./pdf-values.ts";

export type PdfResult<T> =
  | {
      readonly status: "completed";
      readonly value: T;
      readonly diagnostics: readonly PdfDiagnostic[];
    }
  | {
      readonly status: "partial";
      readonly value: T;
      readonly diagnostics: readonly PdfDiagnostic[];
    }
  | {
      readonly status: "blocked";
      readonly diagnostics: readonly PdfDiagnostic[];
    }
  | {
      readonly status: "failed";
      readonly diagnostics: readonly PdfDiagnostic[];
    }
  | {
      readonly status: "cancelled";
      readonly diagnostics: readonly PdfDiagnostic[];
    };

export interface PdfSourceMetadata {
  readonly fileName?: string;
  readonly mediaType?: string;
  readonly sha256?: string;
}

export interface PdfBytesSource extends PdfSourceMetadata {
  readonly kind: "bytes";
  readonly bytes: Uint8Array;
}

export interface PdfBlobSource extends PdfSourceMetadata {
  readonly kind: "blob";
  readonly blob: Blob;
}

export interface PdfRandomAccessReadRequest {
  readonly offset: number;
  readonly length: number;
  readonly signal?: AbortSignal;
}

export interface PdfRandomAccessSource extends PdfSourceMetadata {
  readonly kind: "random-access";
  readonly byteLength: number;
  read(request: PdfRandomAccessReadRequest): Promise<Uint8Array>;
}

export type PdfSource = PdfBytesSource | PdfBlobSource | PdfRandomAccessSource;

export interface PdfSourceDescriptor extends PdfSourceMetadata {
  readonly kind: PdfSource["kind"];
}

export type PdfRepairMode = "strict" | "safe";
export type PdfPasswordPolicy = "forbid" | "known-only" | "interactive";

export interface PdfResourceBudget {
  readonly maxBytes?: number;
  readonly maxPages?: number;
  readonly maxObjects?: number;
  readonly maxRecursionDepth?: number;
  readonly maxDecodedBytes?: number;
  readonly maxOperators?: number;
  readonly maxImagePixels?: number;
  readonly maxCacheBytes?: number;
}

export interface PdfNormalizedResourceBudget {
  readonly maxBytes: number;
  readonly maxPages: number;
  readonly maxObjects: number;
  readonly maxRecursionDepth: number;
  readonly maxDecodedBytes: number;
  readonly maxOperators: number;
  readonly maxImagePixels: number;
  readonly maxCacheBytes: number;
}

export interface PdfPolicy {
  readonly javascriptActions?: PdfPolicyAction;
  readonly launchActions?: PdfPolicyAction;
  readonly embeddedFiles?: PdfPolicyAction;
  readonly repairMode?: PdfRepairMode;
  readonly passwordPolicy?: PdfPasswordPolicy;
  readonly enforcePermissions?: boolean;
  readonly resourceBudget?: PdfResourceBudget;
}

export interface PdfNormalizedPolicy {
  readonly javascriptActions: PdfPolicyAction;
  readonly launchActions: PdfPolicyAction;
  readonly embeddedFiles: PdfPolicyAction;
  readonly repairMode: PdfRepairMode;
  readonly passwordPolicy: PdfPasswordPolicy;
  readonly enforcePermissions: boolean;
  readonly resourceBudget: PdfNormalizedResourceBudget;
}

export interface PdfPasswordChallenge {
  readonly reason: "document-encrypted";
  readonly source: PdfSourceDescriptor;
  readonly attempts: number;
}

export type PdfPasswordProvider = (challenge: PdfPasswordChallenge) => Promise<string | null> | string | null;

export interface PdfEngineIdentity {
  readonly name: "@ismail-elkorchi/pdf-engine";
  readonly version: "0.1.0";
  readonly mode: "read";
  readonly supportedRuntimes: readonly ["node", "deno", "bun", "web"];
}

export interface PdfEngineOptions {
  readonly defaultPolicy?: PdfPolicy;
}

export interface PdfOpenRequest {
  readonly source: PdfSource;
  readonly policy?: PdfPolicy;
  readonly passwordProvider?: PdfPasswordProvider;
  readonly signal?: AbortSignal;
}

export interface PdfPageRange {
  readonly kind: "range";
  readonly from: number;
  readonly to: number;
}

export interface PdfPageNumbers {
  readonly kind: "numbers";
  readonly pages: readonly number[];
}

export type PdfPageSelection = { readonly kind: "all" } | PdfPageRange | PdfPageNumbers;

export type PdfContentChannel =
  | "visible"
  | "accessibility"
  | "annotation"
  | "form-value"
  | "hidden"
  | "attachment"
  | "script"
  | "metadata";

export interface PdfOperationOptions {
  readonly pages?: PdfPageSelection;
  readonly signal?: AbortSignal;
}

export interface PdfStructureSummary {
  readonly pdfVersion: string;
  readonly byteLength: number;
  readonly pageCount: number;
  readonly objectCount: number;
  readonly revisionCount: number;
  readonly encrypted: boolean;
  readonly repaired: boolean;
  readonly root: PdfReference;
  readonly trailer: PdfDictionaryValue;
}

export interface PdfDocumentPermissions {
  readonly credential: "none" | "user" | "owner";
  readonly copy: boolean;
  readonly accessibility: boolean;
  readonly annotate: boolean;
  readonly fillForms: boolean;
  readonly assemble: boolean;
  readonly modify: boolean;
  readonly print: "none" | "low-resolution" | "high-resolution";
}

export interface PdfObjectRequest {
  readonly ref: PdfReference;
  readonly signal?: AbortSignal;
}

export interface PdfStreamRequest extends PdfObjectRequest {
  readonly decode?: boolean;
}

export interface PdfStreamPayload {
  readonly ref: PdfReference;
  readonly dictionary: PdfDictionaryValue;
  readonly bytes: Uint8Array;
  readonly decoded: boolean;
  readonly filters: readonly string[];
  readonly source: PdfByteRange;
}

export interface PdfDocumentFeatures {
  readonly findings: readonly PdfFeatureFinding[];
  readonly metadata: PdfMetadata;
  readonly namedDestinations: readonly PdfNamedDestination[];
  readonly pageLabels: readonly PdfPageLabel[];
  readonly structureTree: readonly PdfStructureElement[];
  readonly outlines: readonly PdfOutlineItem[];
  readonly annotations: readonly PdfAnnotation[];
  readonly formFields: readonly PdfFormField[];
  readonly attachments: readonly PdfAttachment[];
  readonly signatures: readonly PdfSignature[];
  readonly optionalContentGroups: readonly PdfOptionalContentGroup[];
  readonly activeContent: readonly PdfActiveContent[];
}

export interface PdfMetadata {
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords?: string;
  readonly creator?: string;
  readonly producer?: string;
  readonly creationDate?: string;
  readonly modificationDate?: string;
  readonly trapped?: string;
  readonly custom: Readonly<Record<string, string>>;
  readonly xmp?: PdfMetadataStream;
}

export interface PdfMetadataStream {
  readonly objectRef: PdfReference;
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly mediaType: "application/rdf+xml";
}

export interface PdfNamedDestination {
  readonly name: string;
  readonly destination: PdfDestination;
}

export interface PdfPageLabel {
  readonly pageNumber: number;
  readonly label: string;
  readonly prefix?: string;
  readonly style?: "decimal" | "roman-upper" | "roman-lower" | "letters-upper" | "letters-lower";
  readonly sequenceNumber: number;
}

export interface PdfStructureElement {
  readonly id: string;
  readonly role: string;
  readonly objectRef?: PdfReference;
  readonly pageNumber?: number;
  readonly markedContentId?: number;
  readonly title?: string;
  readonly language?: string;
  readonly alternateText?: string;
  readonly actualText?: string;
  readonly children: readonly PdfStructureElement[];
}

export interface PdfOutlineItem {
  readonly id: string;
  readonly title: string;
  readonly objectRef?: PdfReference;
  readonly destination?: PdfDestination;
  readonly children: readonly PdfOutlineItem[];
}

export interface PdfDestination {
  readonly pageRef?: PdfReference;
  readonly pageNumber?: number;
  readonly mode?: string;
  readonly parameters: readonly (number | null)[];
}

export interface PdfAnnotation {
  readonly id: string;
  readonly subtype: string;
  readonly pageNumber: number;
  readonly objectRef?: PdfReference;
  readonly bounds?: PdfBoundingBox;
  readonly contents?: string;
  readonly destination?: PdfDestination;
  readonly uri?: string;
}

export interface PdfFormField {
  readonly id: string;
  readonly fieldType?: string;
  readonly name?: string;
  readonly alternateName?: string;
  readonly value?: string | readonly string[];
  readonly objectRef?: PdfReference;
  readonly children: readonly PdfFormField[];
}

export interface PdfAttachment {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly mediaType?: string;
  readonly size?: number;
  readonly objectRef: PdfReference;
}

export interface PdfSignature {
  readonly id: string;
  readonly objectRef: PdfReference;
  readonly fieldName?: string;
  readonly subFilter?: string;
  readonly byteRange: readonly number[];
  readonly signedAt?: string;
  readonly signerName?: string;
}

export interface PdfOptionalContentGroup {
  readonly id: string;
  readonly name?: string;
  readonly objectRef: PdfReference;
  readonly defaultState: "on" | "off" | "unknown";
}

export interface PdfActiveContent {
  readonly id: string;
  readonly kind: "javascript" | "launch" | "rich-media" | "multimedia" | "three-dimensional" | "other";
  readonly objectRef?: PdfReference;
  readonly payload?: Uint8Array;
}

export interface PdfExtractOptions extends PdfOperationOptions {
  readonly channels?: readonly PdfContentChannel[];
}

export type PdfLayoutOptions = PdfExtractOptions;
export type PdfKnowledgeOptions = PdfLayoutOptions;

export interface PdfSearchRequest extends PdfOperationOptions {
  readonly query: string;
  readonly mode?: "literal" | "word";
  readonly caseSensitive?: boolean;
  readonly channels?: readonly PdfContentChannel[];
  readonly limit?: number;
}

export interface PdfSearchMatch {
  readonly id: string;
  readonly pageNumber?: number;
  readonly channel: PdfContentChannel;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly bounds?: PdfBoundingBox;
  readonly objectRef?: PdfReference;
  readonly contentStreamRef?: PdfReference;
}

export interface PdfSearchResults {
  readonly query: string;
  readonly matches: readonly PdfSearchMatch[];
  readonly truncated: boolean;
}

export interface PdfReadRequest extends PdfOperationOptions {
  readonly channels?: readonly PdfContentChannel[];
  readonly elementIds?: readonly string[];
  readonly maxCharacters: number;
  readonly cursor?: PdfReadCursor;
}

export interface PdfReadCursor {
  readonly pageNumber?: number;
  readonly fragmentId: string;
  readonly characterOffset: number;
}

export interface PdfReadFragment {
  readonly id: string;
  readonly pageNumber?: number;
  readonly channel: PdfContentChannel;
  readonly text: string;
  readonly bounds?: PdfBoundingBox;
  readonly objectRef?: PdfReference;
  readonly contentStreamRef?: PdfReference;
}

export interface PdfReadResult {
  readonly fragments: readonly PdfReadFragment[];
  readonly characterCount: number;
  readonly nextCursor?: PdfReadCursor;
}

export interface PdfAttachmentRequest {
  readonly id: string;
  readonly signal?: AbortSignal;
}

export interface PdfAttachmentPayload {
  readonly attachment: PdfAttachment;
  readonly bytes: Uint8Array;
}

export interface PdfImageOptions extends PdfOperationOptions {
  readonly includeBytes?: boolean;
}

export interface PdfImageResource {
  readonly id: string;
  readonly objectRef?: PdfReference;
  readonly width?: number;
  readonly height?: number;
  readonly bitsPerComponent?: number;
  readonly colorSpace?: string;
  readonly decode?: readonly number[];
  readonly imageMask: boolean;
  readonly interpolate: boolean;
  readonly renderingIntent?: string;
  readonly maskRef?: PdfReference;
  readonly softMaskRef?: PdfReference;
  readonly filters: readonly string[];
  readonly mediaType?: string;
  readonly bytes?: Uint8Array;
  readonly decoded: boolean;
}

export interface PdfImagePlacement {
  readonly id: string;
  readonly resourceId: string;
  readonly pageNumber: number;
  readonly resourceName: string;
  readonly bounds?: PdfBoundingBox;
  readonly transform?: readonly [number, number, number, number, number, number];
  readonly contentStreamRef?: PdfReference;
}

export interface PdfImages {
  readonly resources: readonly PdfImageResource[];
  readonly placements: readonly PdfImagePlacement[];
}

export interface PdfTrustPolicy {
  readonly trustAnchors: readonly Uint8Array[];
  readonly validationTime: Date;
  readonly revocationMode?: "ignore" | "if-present" | "require";
  readonly revocationEvidence?: readonly PdfRevocationEvidence[];
}

export type PdfRevocationEvidence =
  | { readonly kind: "crl"; readonly bytes: Uint8Array }
  | { readonly kind: "ocsp"; readonly bytes: Uint8Array };

export interface PdfSignatureVerificationRequest {
  readonly trustPolicy: PdfTrustPolicy;
  readonly signal?: AbortSignal;
}

export interface PdfSignatureVerification {
  readonly signature: PdfSignature;
  readonly integrity: "valid" | "invalid" | "unsupported";
  readonly trust: "trusted" | "untrusted" | "indeterminate";
  readonly diagnostics: readonly PdfDiagnostic[];
}

export interface PdfDocument {
  readonly source: PdfSourceDescriptor;
  readonly summary: PdfStructureSummary;
  readonly permissions: PdfDocumentPermissions;
  structure(options?: PdfOperationOptions): Promise<PdfResult<PdfStructureSummary>>;
  object(request: PdfObjectRequest): Promise<PdfResult<PdfIndirectObject>>;
  stream(request: PdfStreamRequest): Promise<PdfResult<PdfStreamPayload>>;
  features(options?: PdfOperationOptions): Promise<PdfResult<PdfDocumentFeatures>>;
  extract(options?: PdfExtractOptions): Promise<PdfResult<PdfObservedDocument>>;
  layout(options?: PdfLayoutOptions): Promise<PdfResult<PdfLayoutDocument>>;
  knowledge(options?: PdfKnowledgeOptions): Promise<PdfResult<PdfKnowledgeDocument>>;
  images(options?: PdfImageOptions): Promise<PdfResult<PdfImages>>;
  search(request: PdfSearchRequest): Promise<PdfResult<PdfSearchResults>>;
  read(request: PdfReadRequest): Promise<PdfResult<PdfReadResult>>;
  attachment(request: PdfAttachmentRequest): Promise<PdfResult<PdfAttachmentPayload>>;
  verifySignatures(request: PdfSignatureVerificationRequest): Promise<PdfResult<readonly PdfSignatureVerification[]>>;
  dispose(): Promise<void>;
}

export interface PdfEngine {
  readonly identity: PdfEngineIdentity;
  readonly runtime: PdfRuntimeDescriptor;
  readonly capabilities: PdfRuntimeCapabilities;
  readonly defaultPolicy: PdfNormalizedPolicy;
  open(request: PdfOpenRequest): Promise<PdfResult<PdfDocument>>;
  dispose(): Promise<void>;
}

export type * from "./contracts.ts";
export type * from "./pdf-values.ts";
