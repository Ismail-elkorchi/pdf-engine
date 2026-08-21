/**
 * Runtime kinds that `pdf-engine` can identify when an engine instance is created.
 */
export type PdfRuntimeKind = "node" | "deno" | "bun" | "web" | "unknown";

/**
 * Processing stages used by public diagnostics and semantic products.
 */
export type PdfStageKind = "admission" | "ir" | "observation" | "layout" | "knowledge";

/**
 * Severity levels used by structured diagnostics.
 */
export type PdfRiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Policy action applied when a risky or sensitive PDF feature is detected.
 */
export type PdfPolicyAction = "allow" | "report" | "deny";

/**
 * Feature kinds that the engine can surface during admission and later parsing stages.
 */
export type PdfFeatureKind =
  | "javascript-actions"
  | "embedded-files"
  | "launch-actions"
  | "forms"
  | "annotations"
  | "links"
  | "outlines"
  | "signatures"
  | "optional-content"
  | "encryption"
  | "object-streams"
  | "xref-streams"
  | "images"
  | "fonts"
  | "hidden-text"
  | "duplicate-text-layer";

/**
 * Evidence path used to evaluate one feature finding.
 */
export type PdfFeatureEvidenceSource = "object";

/**
 * Source of an observed text item.
 */
export type PdfObservationOrigin = "native-text";

/**
 * Encoding form used by the text operand that produced an observed run or glyph.
 */
export type PdfTextEncodingKind = "literal" | "hex" | "cid";

/**
 * Unicode mapping path used to recover text from an observed operand.
 */
export type PdfUnicodeMappingSource =
  | "literal"
  | "actual-text"
  | "font-encoding"
  | "tounicode-cmap"
  | "cid-collection-ucs2"
  | "embedded-font-cmap";

/**
 * Writing mode recovered for observed or grouped text when the current implementation can identify it.
 */
export type PdfWritingMode = "horizontal" | "vertical";

/**
 * Cross-reference organization detected for a PDF file.
 */
export type PdfCrossReferenceKind = "classic" | "xref-stream" | "hybrid" | "unknown";

/**
 * Structural recovery state for the current parser pass.
 */
export type PdfRepairState = "clean" | "recovered";

/**
 * Stable implementation-limit codes that the current engine can expose without hiding known gaps.
 */
export type PdfKnownLimitCode =
  | "native-text-unicode-mapping-incomplete"
  | "native-text-encoding-incomplete"
  | "layout-block-heuristic"
  | "layout-role-heuristic"
  | "layout-reading-order-heuristic"
  | "layout-region-heuristic"
  | "knowledge-chunk-heuristic"
  | "knowledge-markdown-heuristic"
  | "table-projection-heuristic"
  | "table-projection-not-implemented";

/**
 * Decode state for one recovered stream object.
 */
export type PdfStreamDecodeState = "available" | "decoded" | "unsupported-filter" | "failed";

/**
 * Observation strategy used to produce the current text and page-mark evidence.
 */
export type PdfObservationStrategy = "content-stream-interpreter";

/**
 * Visibility state recovered for marked content or other observed page evidence.
 */
export type PdfVisibilityState = "visible" | "hidden" | "unknown";

/**
 * Broad marked-content classification recovered from content-stream operators.
 */
export type PdfMarkedContentKind = "artifact" | "span" | "other";

/**
 * Structural role for one recovered stream object.
 */
export type PdfStreamRole = "content" | "tounicode" | "cmap" | "xref" | "object-stream" | "unknown";

/**
 * How page ordering for the current page summary or observation page was resolved.
 */
export type PdfPageResolutionMethod = "page-tree" | "recovered-page-order" | "stream-fallback";

/**
 * Where a page-level value came from after page-tree inheritance was resolved.
 */
export type PdfPageValueOrigin = "direct" | "inherited";

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
 * PDF affine transform matrix in `[a b c d e f]` form.
 */
export interface PdfTransformMatrix {
  /** Horizontal scaling. */
  readonly a: number;
  /** Vertical skewing. */
  readonly b: number;
  /** Horizontal skewing. */
  readonly c: number;
  /** Vertical scaling. */
  readonly d: number;
  /** Horizontal translation. */
  readonly e: number;
  /** Vertical translation. */
  readonly f: number;
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
 * Structural coverage reached by the current parser pass.
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
 * One cross-reference section recovered by the current parser pass.
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
 * Trailer summary recovered from the current parser pass.
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
 * One indirect object boundary recovered by the current parser pass.
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
  /** `/Type` name when the current implementation can recover it. */
  readonly typeName?: string;
  /** Top-level dictionary keys recovered from the object. */
  readonly dictionaryKeys: readonly string[];
  /** Stream byte length within the scanned input when known. */
  readonly streamByteLength?: number;
  /** Declared stream filters in decode order when present. */
  readonly streamFilterNames?: readonly string[];
  /** Stream decode state for the current implementation. */
  readonly streamDecodeState?: PdfStreamDecodeState;
  /** Decoded stream byte length when operator-ready bytes are available. */
  readonly decodedStreamByteLength?: number;
  /** Structural role inferred for the stream when the current implementation can classify it. */
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
 * Shared fields for one typed feature finding.
 */
export interface PdfFeatureFindingBase {
  /** Feature kind that was evaluated. */
  readonly kind: PdfFeatureKind;
  /** Policy action that applies to this feature kind. */
  readonly action: PdfPolicyAction;
  /** Evidence path used to evaluate this feature finding. */
  readonly evidenceSource: PdfFeatureEvidenceSource;
  /** Related object reference when parsed object evidence identified a concrete source object. */
  readonly objectRef?: PdfObjectRef;
  /** Human-readable summary of the detection result. */
  readonly message: string;
}

/**
 * Typed finding for JavaScript or launch actions.
 */
export interface PdfActionFinding extends PdfFeatureFindingBase {
  /** Action finding kind. */
  readonly kind: "javascript-actions" | "launch-actions";
  /** Resolved action name when known. */
  readonly actionName: "JavaScript" | "Launch";
  /** Action object reference when known. */
  readonly actionRef?: PdfObjectRef;
  /** Trigger object reference when the action was found through another object. */
  readonly triggerRef?: PdfObjectRef;
}

/**
 * Typed finding for embedded files or file specifications.
 */
export interface PdfAttachmentFinding extends PdfFeatureFindingBase {
  /** Attachment finding kind. */
  readonly kind: "embedded-files";
  /** File specification reference when known. */
  readonly fileSpecRef?: PdfObjectRef;
  /** Embedded file stream reference when known. */
  readonly embeddedFileRef?: PdfObjectRef;
}

/**
 * Typed finding for annotations attached to one page.
 */
export interface PdfAnnotationFinding extends PdfFeatureFindingBase {
  /** Annotation finding kind. */
  readonly kind: "annotations";
  /** Annotation object reference when known. */
  readonly annotationRef?: PdfObjectRef;
  /** Page reference that owns the annotation when known. */
  readonly pageRef?: PdfObjectRef;
  /** Annotation subtype when the parser can resolve it. */
  readonly annotationSubtype?: string;
}

/**
 * Typed finding for link annotations or destinations.
 */
export interface PdfLinkFinding extends PdfFeatureFindingBase {
  /** Link finding kind. */
  readonly kind: "links";
  /** Annotation reference that produced the link when known. */
  readonly annotationRef?: PdfObjectRef;
  /** Page reference that owns the link when known. */
  readonly pageRef?: PdfObjectRef;
  /** Annotation subtype when the parser can resolve it. */
  readonly annotationSubtype?: string;
  /** Destination reference when the link points to an indirect object. */
  readonly destinationRef?: PdfObjectRef;
  /** Action reference when the link points through an action dictionary. */
  readonly actionRef?: PdfObjectRef;
}

/**
 * Typed finding for an AcroForm root and its field references.
 */
export interface PdfFormFinding extends PdfFeatureFindingBase {
  /** Form finding kind. */
  readonly kind: "forms";
  /** Form dictionary reference when known. */
  readonly formRef?: PdfObjectRef;
  /** Field references attached to the form root when known. */
  readonly fieldRefs: readonly PdfObjectRef[];
}

/**
 * Typed finding for an outline root and its first recovered items.
 */
export interface PdfOutlineFinding extends PdfFeatureFindingBase {
  /** Outline finding kind. */
  readonly kind: "outlines";
  /** Outline root reference when known. */
  readonly outlineRef?: PdfObjectRef;
  /** Outline item references recovered from the outline tree. */
  readonly itemRefs: readonly PdfObjectRef[];
}

/**
 * Typed finding for signature dictionaries or signature fields.
 */
export interface PdfSignatureFinding extends PdfFeatureFindingBase {
  /** Signature finding kind. */
  readonly kind: "signatures";
  /** Signature field reference when known. */
  readonly fieldRef?: PdfObjectRef;
  /** Signature value reference when known. */
  readonly signatureRef?: PdfObjectRef;
}

/**
 * Typed finding for optional-content configuration and membership.
 */
export interface PdfOptionalContentFinding extends PdfFeatureFindingBase {
  /** Optional-content finding kind. */
  readonly kind: "optional-content";
  /** Optional-content configuration reference when known. */
  readonly configRef?: PdfObjectRef;
  /** Optional-content group references when known. */
  readonly groupRefs: readonly PdfObjectRef[];
  /** Object references that declare optional-content membership when known. */
  readonly memberObjectRefs: readonly PdfObjectRef[];
}

/**
 * Typed finding for structural or text-layer features summarized from object evidence.
 */
export interface PdfObjectFeatureFinding extends PdfFeatureFindingBase {
  /** Object-backed feature kind. */
  readonly kind:
    | "encryption"
    | "object-streams"
    | "xref-streams"
    | "images"
    | "fonts"
    | "hidden-text"
    | "duplicate-text-layer";
  /** Object references that support the current finding. */
  readonly objectRefs: readonly PdfObjectRef[];
}

/**
 * Typed finding for one detected feature.
 */
export type PdfFeatureFinding =
  | PdfActionFinding
  | PdfAttachmentFinding
  | PdfAnnotationFinding
  | PdfLinkFinding
  | PdfFormFinding
  | PdfOutlineFinding
  | PdfSignatureFinding
  | PdfOptionalContentFinding
  | PdfObjectFeatureFinding;

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
  /** Unicode mapping path used to recover this glyph when known. */
  readonly unicodeMappingSource?: PdfUnicodeMappingSource;
  /** Writing mode active for this glyph when the current implementation can recover it. */
  readonly writingMode?: PdfWritingMode;
  /** Optional originating object reference. */
  readonly objectRef?: PdfObjectRef;
  /** Approximate text anchor when the current implementation can recover one. */
  readonly anchor?: PdfPoint;
  /** Active font size when the current implementation can recover it. */
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
  /** Unicode mapping path used to recover this run when known. */
  readonly unicodeMappingSource?: PdfUnicodeMappingSource;
  /** Writing mode active for this run when the current implementation can recover it. */
  readonly writingMode?: PdfWritingMode;
  /** Optional originating object reference. */
  readonly objectRef?: PdfObjectRef;
  /** Approximate text anchor when the current implementation can recover one. */
  readonly anchor?: PdfPoint;
  /** Active font size when the current implementation can recover it. */
  readonly fontSize?: number;
  /** Whether this run started on a new text line. */
  readonly startsNewLine?: boolean;
  /** Optional run bounding box. */
  readonly bbox?: PdfBoundingBox;
}

/**
 * Painting operator applied to one observed path.
 */
export type PdfObservedPathPaintOperator = "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n";

/**
 * Clip operator applied to one observed clipping path.
 */
export type PdfObservedClipOperator = "W" | "W*";

/**
 * Normalized line-cap style active for one observed path.
 */
export type PdfObservedLineCapStyle = "butt" | "round" | "projecting-square";

/**
 * Normalized line-join style active for one observed path.
 */
export type PdfObservedLineJoinStyle = "miter" | "round" | "bevel";

/**
 * Normalized dash pattern active for one observed path.
 */
export interface PdfObservedDashPattern {
  /** Dash and gap lengths in user-space units. */
  readonly segments: readonly number[];
  /** Dash phase in user-space units. */
  readonly phase: number;
}

/**
 * Normalized paint-state facts active for one observed path.
 */
export interface PdfObservedPaintState {
  /** Active line width in user-space units. */
  readonly lineWidth: number;
  /** Active line-cap style. */
  readonly lineCapStyle: PdfObservedLineCapStyle;
  /** Active line-join style. */
  readonly lineJoinStyle: PdfObservedLineJoinStyle;
  /** Active miter limit. */
  readonly miterLimit: number;
  /** Active dash pattern. */
  readonly dashPattern: PdfObservedDashPattern;
}

/**
 * Normalized color-space families that the current observation stage can expose.
 */
export type PdfObservedColorSpaceKind =
  | "device-gray"
  | "device-rgb"
  | "device-cmyk"
  | "cal-gray"
  | "cal-rgb"
  | "lab"
  | "icc-based"
  | "indexed"
  | "pattern"
  | "separation"
  | "device-n"
  | "unknown";

/**
 * Normalized color-space evidence active for one observed drawing operation.
 */
export interface PdfObservedColorSpace {
  /** Normalized color-space family. */
  readonly kind: PdfObservedColorSpaceKind;
  /** Resource name when this color space came from page resources. */
  readonly resourceName?: string;
  /** Indirect object reference for the color-space definition when known. */
  readonly objectRef?: PdfObjectRef;
}

/**
 * Normalized fill or stroke color active for one observed drawing operation.
 */
export interface PdfObservedColor {
  /** Active color-space evidence for this color value. */
  readonly colorSpace: PdfObservedColorSpace;
  /** Numeric components in PDF operand order. */
  readonly components: readonly number[];
  /** Pattern resource name when a pattern color was explicitly selected. */
  readonly patternName?: string;
}

/**
 * Normalized stroke and fill color facts active for one observed path.
 */
export interface PdfObservedColorState {
  /** Active stroke color space. */
  readonly strokeColorSpace: PdfObservedColorSpace;
  /** Active fill color space. */
  readonly fillColorSpace: PdfObservedColorSpace;
  /** Active stroke color when the current implementation can recover one. */
  readonly strokeColor?: PdfObservedColor;
  /** Active fill color when the current implementation can recover one. */
  readonly fillColor?: PdfObservedColor;
}

/**
 * Normalized blend-mode families that the current observation stage can expose.
 */
export type PdfObservedBlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "compatible"
  | "unknown";

/**
 * Normalized soft-mask state active for one observed drawing operation.
 */
export type PdfObservedSoftMaskState = "none" | "present" | "unknown";

/**
 * Normalized transparency facts active for one observed drawing operation.
 */
export interface PdfObservedTransparencyState {
  /** Active stroke alpha constant. */
  readonly strokeAlpha: number;
  /** Active fill alpha constant. */
  readonly fillAlpha: number;
  /** Active blend mode. */
  readonly blendMode: PdfObservedBlendMode;
  /** Active soft-mask state. */
  readonly softMask: PdfObservedSoftMaskState;
}

/**
 * Transparency-group evidence recovered from a form XObject when known.
 */
export interface PdfObservedTransparencyGroup {
  /** Whether the transparency group is isolated. */
  readonly isolated: boolean;
  /** Whether the transparency group is knockout. */
  readonly knockout: boolean;
  /** Group color space when the current implementation can recover it. */
  readonly colorSpace?: PdfObservedColorSpace;
}

/**
 * One normalized move-to segment recovered from a PDF path.
 */
export interface PdfObservedPathMoveToSegment {
  /** Segment discriminator. */
  readonly kind: "move-to";
  /** Destination point in local path space. */
  readonly to: PdfPoint;
}

/**
 * One normalized line-to segment recovered from a PDF path.
 */
export interface PdfObservedPathLineToSegment {
  /** Segment discriminator. */
  readonly kind: "line-to";
  /** Destination point in local path space. */
  readonly to: PdfPoint;
}

/**
 * One normalized cubic-curve segment recovered from a PDF path.
 */
export interface PdfObservedPathCurveToSegment {
  /** Segment discriminator. */
  readonly kind: "curve-to";
  /** First control point in local path space. */
  readonly control1: PdfPoint;
  /** Second control point in local path space. */
  readonly control2: PdfPoint;
  /** Destination point in local path space. */
  readonly to: PdfPoint;
}

/**
 * One normalized close-path segment recovered from a PDF path.
 */
export interface PdfObservedPathClosePathSegment {
  /** Segment discriminator. */
  readonly kind: "close-path";
}

/**
 * One normalized rectangle segment recovered from a PDF path.
 */
export interface PdfObservedPathRectangleSegment {
  /** Segment discriminator. */
  readonly kind: "rectangle";
  /** Rectangle left coordinate in local path space. */
  readonly x: number;
  /** Rectangle top or origin-relative vertical coordinate in local path space. */
  readonly y: number;
  /** Rectangle width in local path space. */
  readonly width: number;
  /** Rectangle height in local path space. */
  readonly height: number;
}

/**
 * One normalized path segment recovered from a PDF path.
 */
export type PdfObservedPathSegment =
  | PdfObservedPathMoveToSegment
  | PdfObservedPathLineToSegment
  | PdfObservedPathCurveToSegment
  | PdfObservedPathClosePathSegment
  | PdfObservedPathRectangleSegment;

/**
 * Base fields shared by every observed page mark.
 */
export interface PdfObservedMarkBase {
  /** Stable mark identifier within the observation result. */
  readonly id: string;
  /** One-based page number. */
  readonly pageNumber: number;
  /** Zero-based content-order position for this mark. */
  readonly contentOrder: number;
  /** Content stream reference that produced this mark when known. */
  readonly contentStreamRef?: PdfObjectRef;
  /** Optional originating object reference. */
  readonly objectRef?: PdfObjectRef;
  /** Enclosing marked-content identifier when this mark belongs to one. */
  readonly markedContentId?: string;
  /** Bounding box when the current implementation can recover one. */
  readonly bbox?: PdfBoundingBox;
  /** Active transform when the current implementation can recover one. */
  readonly transform?: PdfTransformMatrix;
  /** Visibility state when the current implementation can recover one. */
  readonly visibilityState?: PdfVisibilityState;
}

/**
 * Observed text mark derived from one decoded text run.
 */
export interface PdfObservedTextMark extends PdfObservedMarkBase {
  /** Discriminator for observed text marks. */
  readonly kind: "text";
  /** Source text run identifier. */
  readonly runId: string;
  /** Source glyph identifiers. */
  readonly glyphIds: readonly string[];
  /** Combined run text. */
  readonly text: string;
  /** Origin of the text observation. */
  readonly origin: PdfObservationOrigin;
  /** Font object reference active when this mark was decoded when known. */
  readonly fontRef?: PdfObjectRef;
  /** Text operand encoding form used to decode this mark when known. */
  readonly textEncodingKind?: PdfTextEncodingKind;
  /** Unicode mapping path used to recover this mark when known. */
  readonly unicodeMappingSource?: PdfUnicodeMappingSource;
  /** Writing mode active for this mark when the current implementation can recover it. */
  readonly writingMode?: PdfWritingMode;
  /** Marked-content classification active for this mark when known. */
  readonly markedContentKind?: PdfMarkedContentKind;
  /** Preferred ActualText payload attached to the enclosing marked-content sequence when known. */
  readonly actualText?: string;
  /** Approximate text anchor when the current implementation can recover one. */
  readonly anchor?: PdfPoint;
  /** Active font size when the current implementation can recover it. */
  readonly fontSize?: number;
  /** Whether this mark started on a new text line. */
  readonly startsNewLine?: boolean;
  /** Whether this mark is a hidden-text candidate under the current evidence model. */
  readonly hiddenTextCandidate?: boolean;
  /** Whether this mark is a duplicate-layer candidate under the current evidence model. */
  readonly duplicateLayerCandidate?: boolean;
}

/**
 * Observed path mark emitted from path-construction and paint operators.
 */
export interface PdfObservedPathMark extends PdfObservedMarkBase {
  /** Discriminator for observed path marks. */
  readonly kind: "path";
  /** Painting operator that finalized this path. */
  readonly paintOperator: PdfObservedPathPaintOperator;
  /** Normalized paint-state facts active when this path was painted. */
  readonly paintState: PdfObservedPaintState;
  /** Normalized fill and stroke color facts active when this path was painted. */
  readonly colorState: PdfObservedColorState;
  /** Normalized transparency facts active when this path was painted. */
  readonly transparencyState: PdfObservedTransparencyState;
  /** Normalized path segments in local path space. */
  readonly segments: readonly PdfObservedPathSegment[];
  /** Number of path points considered when recovering the bounding box. */
  readonly pointCount: number;
  /** Whether the recovered path was explicitly closed. */
  readonly closed: boolean;
}

/**
 * Observed XObject mark emitted from a `Do` operator.
 */
export interface PdfObservedXObjectMark extends PdfObservedMarkBase {
  /** Discriminator for observed XObject marks. */
  readonly kind: "xobject";
  /** Resource name used by the `Do` operator. */
  readonly resourceName: string;
  /** XObject reference when the page resources resolve it. */
  readonly xObjectRef?: PdfObjectRef;
  /** XObject subtype name when the current implementation can recover it. */
  readonly subtypeName?: string;
  /** Transparency-group evidence when the XObject declares one. */
  readonly transparencyGroup?: PdfObservedTransparencyGroup;
}

/**
 * Observed image mark emitted from an image XObject.
 */
export interface PdfObservedImageMark extends PdfObservedMarkBase {
  /** Discriminator for observed image marks. */
  readonly kind: "image";
  /** Resource name used by the `Do` operator. */
  readonly resourceName: string;
  /** Image XObject reference when the page resources resolve it. */
  readonly xObjectRef?: PdfObjectRef;
  /** XObject width when the current implementation can recover it. */
  readonly width?: number;
  /** XObject height when the current implementation can recover it. */
  readonly height?: number;
  /** Active color state at the image invocation site. Required for image-mask stencils. */
  readonly colorState?: PdfObservedColorState;
  /** Active transparency state at the image invocation site. Required for image-mask stencils. */
  readonly transparencyState?: PdfObservedTransparencyState;
}

/**
 * Observed clip mark emitted from a clipping-path operator.
 */
export interface PdfObservedClipMark extends PdfObservedMarkBase {
  /** Discriminator for observed clip marks. */
  readonly kind: "clip";
  /** Clip operator that established this clipping path. */
  readonly clipOperator: PdfObservedClipOperator;
}

/**
 * Observed marked-content boundary recovered from `BMC`, `BDC`, and `EMC`.
 */
export interface PdfObservedMarkedContentMark extends PdfObservedMarkBase {
  /** Discriminator for marked-content marks. */
  readonly kind: "marked-content";
  /** Original tag name without the leading slash. */
  readonly tagName: string;
  /** Broad marked-content classification. */
  readonly markedContentKind: PdfMarkedContentKind;
  /** Nesting depth when this marked-content sequence started. */
  readonly depth: number;
  /** Properties resource name used by `BDC` when known. */
  readonly propertyName?: string;
  /** Optional-content object reference when the current implementation can resolve one. */
  readonly optionalContentRef?: PdfObjectRef;
  /** Marked-content identifier when provided by the property dictionary. */
  readonly mcid?: number;
  /** Preferred ActualText payload when attached to the property dictionary. */
  readonly actualText?: string;
  /** Content-order position where this marked-content sequence closed when known. */
  readonly closedContentOrder?: number;
}

/**
 * Canonical observed page-mark union.
 */
export type PdfObservedMark =
  | PdfObservedTextMark
  | PdfObservedPathMark
  | PdfObservedXObjectMark
  | PdfObservedImageMark
  | PdfObservedClipMark
  | PdfObservedMarkedContentMark;

/**
 * One observed page in the current observation result.
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
  /** Canonical observed page marks in content order. */
  readonly marks: readonly PdfObservedMark[];
}

/**
 * Current observation result for a document.
 */
export interface PdfObservedDocument {
  /** Observation implementation kind. */
  readonly kind: "pdf-observation";
  /** Observation strategy used to recover the current text evidence. */
  readonly strategy: PdfObservationStrategy;
  /** Flattened extracted text emitted by the current observation stage. */
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
 * Layout inference made by the current geometry-aware heuristics.
 */
export type PdfLayoutInferenceKind = "reading-order" | "paragraph-flow" | "structural-role" | "region";

/**
 * Whether a layout inference was made or deliberately withheld.
 */
export type PdfLayoutInferenceStatus = "inferred" | "abstained";

/**
 * One explainable layout inference attached to a public layout block.
 */
export interface PdfLayoutInferenceRecord {
  /** Inference family this record explains. */
  readonly kind: PdfLayoutInferenceKind;
  /** Whether the implementation made the inference or abstained. */
  readonly status: PdfLayoutInferenceStatus;
  /** Stable heuristic method identifier. */
  readonly method: string;
  /** Confidence assigned to the inference, when made. */
  readonly confidence: number;
  /** Short explanation of the evidence and any uncertainty. */
  readonly reason: string;
  /** Observation run identifiers used as evidence for this inference. */
  readonly evidenceRunIds: readonly string[];
  /** Related layout block identifiers used as context for this inference. */
  readonly evidenceBlockIds?: readonly string[];
}

/**
 * First-layout strategy used by the current implementation.
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
  /** Whether the current block starts a new paragraph according to the current layout heuristics. */
  readonly startsParagraph: boolean;
  /** Observation run identifiers grouped into this block. */
  readonly runIds: readonly string[];
  /** Observation glyph identifiers grouped into this block. */
  readonly glyphIds: readonly string[];
  /** Writing mode assigned to the block when the current implementation can recover it. */
  readonly writingMode?: PdfWritingMode;
  /** How page ordering for this layout block was resolved. */
  readonly resolutionMethod: PdfPageResolutionMethod;
  /** Page object reference when known. */
  readonly pageRef?: PdfObjectRef;
  /** Approximate block anchor when the current implementation can recover one. */
  readonly anchor?: PdfPoint;
  /** Approximate block bounding box when the current implementation can recover one. */
  readonly bbox?: PdfBoundingBox;
  /** Dominant font size for the first run in this block when the current implementation can recover it. */
  readonly fontSize?: number;
  /** Explainable inference records for ordering, paragraph flow, and structural role heuristics. */
  readonly inferences?: readonly PdfLayoutInferenceRecord[];
}

/**
 * Interpreted region kind recovered from geometry and block evidence.
 */
export type PdfLayoutRegionKind = "table" | "form-like";

/**
 * One interpreted layout region spanning related layout blocks.
 */
export interface PdfLayoutRegion {
  /** Stable region identifier within the layout result. */
  readonly id: string;
  /** One-based page number. */
  readonly pageNumber: number;
  /** Region kind inferred from the current layout evidence. */
  readonly kind: PdfLayoutRegionKind;
  /** Source layout block identifiers covered by the region. */
  readonly blockIds: readonly string[];
  /** Confidence attached to the current region inference. */
  readonly confidence: number;
  /** Approximate region bounding box when the source blocks expose geometry. */
  readonly bbox?: PdfBoundingBox;
  /** Explainable inference records for the region heuristic. */
  readonly inferences?: readonly PdfLayoutInferenceRecord[];
}

/**
 * One layout page in the current layout result.
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
  /** Interpreted layout regions recovered from related blocks. */
  readonly regions?: readonly PdfLayoutRegion[];
}

/**
 * Current layout result for a document.
 */
export interface PdfLayoutDocument {
  /** Layout implementation kind. */
  readonly kind: "pdf-layout";
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
 * First knowledge-projection strategy used by the current implementation.
 */
export type PdfKnowledgeStrategy = "layout-chunks" | "layout-chunks-and-heuristic-tables";

/**
 * Heuristic used to project one knowledge table.
 */
export type PdfKnowledgeTableHeuristic =
  | "layout-grid"
  | "layout-region-table"
  | "row-sequence"
  | "stacked-header-sequence"
  | "field-value-form"
  | "field-label-form";

/**
 * One provenance record attached to a knowledge chunk or table cell.
 */
export interface PdfKnowledgeTextRange {
  /** Zero-based inclusive start offset in the source text. */
  readonly start: number;
  /** Zero-based exclusive end offset in the source text. */
  readonly end: number;
}

/**
 * Source span recovered from one observed text run when the current evidence can isolate it.
 */
export interface PdfKnowledgeRunSpan {
  /** Source observation run identifier. */
  readonly runId: string;
  /** Text range covered inside the source layout block. */
  readonly range: PdfKnowledgeTextRange;
  /** Text covered by this run span. */
  readonly text: string;
  /** Approximate source span bounds when known. */
  readonly bbox?: PdfBoundingBox;
}

/**
 * Exact source slice attached to one knowledge citation when the current evidence can isolate it.
 */
export interface PdfKnowledgeSourceSpan {
  /** Text slice covered by the citation. */
  readonly text: string;
  /** Text range covered inside the source layout block. */
  readonly blockRange: PdfKnowledgeTextRange;
  /** Source run spans that contributed to this citation. */
  readonly runSpans: readonly PdfKnowledgeRunSpan[];
  /** Approximate source span bounds when known. */
  readonly bbox?: PdfBoundingBox;
  /** Page object reference when known. */
  readonly pageRef?: PdfObjectRef;
}

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
  /** Exact source slice when the current projection can isolate one. */
  readonly sourceSpan?: PdfKnowledgeSourceSpan;
  /** Page object reference when known. */
  readonly pageRef?: PdfObjectRef;
}

/**
 * One chunk projected from layout for downstream retrieval use.
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
  /** Header row recovered for the current table when the current implementation can isolate one. */
  readonly headers?: readonly string[];
  /** Heuristic used to project the current table. */
  readonly heuristic?: PdfKnowledgeTableHeuristic;
  /** Source layout block identifiers that fed this table. */
  readonly blockIds: readonly string[];
  /** Confidence attached to the current table projection. */
  readonly confidence: number;
  /** Projected cells in row-major order. */
  readonly cells: readonly PdfKnowledgeTableCell[];
}

/**
 * Heuristic used to project one knowledge form.
 */
export type PdfKnowledgeFormHeuristic = "field-value-form" | "field-label-form" | "layout-region-form";

/**
 * Whether a projected form field has direct value evidence.
 */
export type PdfKnowledgeFormFieldValueState = "value-present" | "not-observed";

/**
 * One field emitted in a projected knowledge form.
 */
export interface PdfKnowledgeFormField {
  /** Stable field identifier within the knowledge result. */
  readonly id: string;
  /** One-based page number. */
  readonly pageNumber: number;
  /** Field label recovered from direct layout or observation evidence. */
  readonly name: string;
  /** Field value when direct evidence can isolate it. */
  readonly value?: string;
  /** Whether a direct field value was observed. */
  readonly valueState: PdfKnowledgeFormFieldValueState;
  /** Source layout block identifiers that fed this field. */
  readonly blockIds: readonly string[];
  /** Source observation run identifiers that fed this field. */
  readonly runIds: readonly string[];
  /** Confidence attached to the current field projection. */
  readonly confidence: number;
  /** Provenance records for the field label and value evidence. */
  readonly citations: readonly PdfKnowledgeCitation[];
}

/**
 * One projected knowledge form.
 */
export interface PdfKnowledgeForm {
  /** Stable form identifier within the knowledge result. */
  readonly id: string;
  /** One-based page number. */
  readonly pageNumber: number;
  /** Form title when direct evidence can isolate one. */
  readonly title?: string;
  /** Heuristic used to project the current form. */
  readonly heuristic?: PdfKnowledgeFormHeuristic;
  /** Source layout block identifiers that fed this form. */
  readonly blockIds: readonly string[];
  /** Confidence attached to the current form projection. */
  readonly confidence: number;
  /** Projected fields in source order. */
  readonly fields: readonly PdfKnowledgeFormField[];
}

/**
 * Current knowledge-stage result for a document.
 */
export interface PdfKnowledgeDocument {
  /** Knowledge implementation kind. */
  readonly kind: "pdf-knowledge";
  /** Knowledge strategy used by the current implementation. */
  readonly strategy: PdfKnowledgeStrategy;
  /** Chunk projections for downstream retrieval use. */
  readonly chunks: readonly PdfKnowledgeChunk[];
  /** Table projections when the current evidence is sufficient. */
  readonly tables: readonly PdfKnowledgeTable[];
  /** Form projections when the current evidence is sufficient. */
  readonly forms: readonly PdfKnowledgeForm[];
  /** Markdown projection in knowledge-chunk order. */
  readonly markdown: string;
  /** Flattened text in knowledge-chunk order. */
  readonly extractedText: string;
  /** Known implementation limits that materially affect this knowledge result. */
  readonly knownLimits: readonly PdfKnownLimitCode[];
}
