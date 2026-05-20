import type {
  PdfBoundingBox,
  PdfDisplayCommand,
  PdfDisplayImageCommand,
  PdfDisplayList,
  PdfDisplayPathCommand,
  PdfDisplayTextCommand,
  PdfKnownLimitCode,
  PdfObservedBlendMode,
  PdfObservedColor,
  PdfObservedPathSegment,
  PdfPoint,
  PdfRenderPageImageRaster,
  PdfRenderPageImagery,
  PdfRenderPageImageSvg,
  PdfRenderResourcePayload,
  PdfTransformMatrix,
} from "./contracts.ts";

interface RenderPageImageryBuildInput {
  readonly displayList: PdfDisplayList;
  readonly pageBox?: PdfBoundingBox;
  readonly resourcePayloads: readonly PdfRenderResourcePayload[];
  readonly cachedImageDataByPayloadId?: Map<string, CachedImageData>;
  readonly rasterBudgetBytes?: number;
  readonly svgBudgetCharacters?: number;
}

export interface RenderPageImageryBuildResult {
  readonly pageBox?: PdfBoundingBox;
  readonly imagery?: PdfRenderPageImagery;
  readonly knownLimits: readonly PdfKnownLimitCode[];
}

interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

interface DecodedImagePixels {
  readonly width: number;
  readonly height: number;
  readonly rgbaBytes: Uint8Array;
}

export interface CachedImageData {
  readonly image: DecodedImagePixels;
  readonly dataUri: string;
}

interface TextPrimitive {
  readonly kind: "text";
  readonly contentOrder: number;
  readonly text: string;
  readonly bbox: PdfBoundingBox;
  readonly fontFamily: string;
  readonly fontSize: number;
}

interface PathPrimitive {
  readonly kind: "path";
  readonly contentOrder: number;
  readonly svgPathData: string;
  readonly rasterSubpaths: readonly RasterSubpath[];
  readonly fillRule: "nonzero" | "evenodd";
  readonly strokeColor?: RgbaColor;
  readonly fillColor?: RgbaColor;
  readonly strokeWidth: number;
  readonly dashPattern: readonly number[];
  readonly dashPhase: number;
  readonly lineCapStyle: PdfDisplayPathCommand["paintState"]["lineCapStyle"];
  readonly lineJoinStyle: PdfDisplayPathCommand["paintState"]["lineJoinStyle"];
  readonly miterLimit: number;
  readonly blendMode: PdfObservedBlendMode;
}

interface ImagePrimitive {
  readonly kind: "image";
  readonly contentOrder: number;
  readonly bbox: PdfBoundingBox;
  readonly image: DecodedImagePixels;
  readonly dataUri: string;
}

type RenderPrimitive = TextPrimitive | PathPrimitive | ImagePrimitive;

interface RasterSubpath {
  readonly points: readonly NormalizedPoint[];
  readonly closed: boolean;
  readonly axisAlignedRectangle?: PdfBoundingBox;
}

interface ByteSource {
  readonly length: number;
  byteAt(index: number): number;
}

interface DeflateMatch {
  readonly length: number;
  readonly distance: number;
}

interface DeflateLengthCode {
  readonly code: number;
  readonly baseLength: number;
  readonly extraBits: number;
  readonly maxLength: number;
}

interface DeflateDistanceCode {
  readonly code: number;
  readonly baseDistance: number;
  readonly extraBits: number;
}

const IDENTITY_TRANSFORM: PdfTransformMatrix = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
};

const WHITE_PIXEL = [255, 255, 255, 255] as const;
const BLACK_PIXEL: RgbaColor = { r: 0, g: 0, b: 0, a: 1 };
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ADLER32_CHUNK_SIZE = 5_552;
const DEFLATE_HASH_SIZE = 1 << 15;
const DEFLATE_MIN_MATCH_LENGTH = 3;
const DEFLATE_MAX_MATCH_LENGTH = 258;
const DEFLATE_MAX_DISTANCE = 32_768;
const CRC32_TABLE = buildCrc32Table();
const DEFLATE_LENGTH_CODES: readonly DeflateLengthCode[] = [
  { code: 257, baseLength: 3, extraBits: 0, maxLength: 3 },
  { code: 258, baseLength: 4, extraBits: 0, maxLength: 4 },
  { code: 259, baseLength: 5, extraBits: 0, maxLength: 5 },
  { code: 260, baseLength: 6, extraBits: 0, maxLength: 6 },
  { code: 261, baseLength: 7, extraBits: 0, maxLength: 7 },
  { code: 262, baseLength: 8, extraBits: 0, maxLength: 8 },
  { code: 263, baseLength: 9, extraBits: 0, maxLength: 9 },
  { code: 264, baseLength: 10, extraBits: 0, maxLength: 10 },
  { code: 265, baseLength: 11, extraBits: 1, maxLength: 12 },
  { code: 266, baseLength: 13, extraBits: 1, maxLength: 14 },
  { code: 267, baseLength: 15, extraBits: 1, maxLength: 16 },
  { code: 268, baseLength: 17, extraBits: 1, maxLength: 18 },
  { code: 269, baseLength: 19, extraBits: 2, maxLength: 22 },
  { code: 270, baseLength: 23, extraBits: 2, maxLength: 26 },
  { code: 271, baseLength: 27, extraBits: 2, maxLength: 30 },
  { code: 272, baseLength: 31, extraBits: 2, maxLength: 34 },
  { code: 273, baseLength: 35, extraBits: 3, maxLength: 42 },
  { code: 274, baseLength: 43, extraBits: 3, maxLength: 50 },
  { code: 275, baseLength: 51, extraBits: 3, maxLength: 58 },
  { code: 276, baseLength: 59, extraBits: 3, maxLength: 66 },
  { code: 277, baseLength: 67, extraBits: 4, maxLength: 82 },
  { code: 278, baseLength: 83, extraBits: 4, maxLength: 98 },
  { code: 279, baseLength: 99, extraBits: 4, maxLength: 114 },
  { code: 280, baseLength: 115, extraBits: 4, maxLength: 130 },
  { code: 281, baseLength: 131, extraBits: 5, maxLength: 162 },
  { code: 282, baseLength: 163, extraBits: 5, maxLength: 194 },
  { code: 283, baseLength: 195, extraBits: 5, maxLength: 226 },
  { code: 284, baseLength: 227, extraBits: 5, maxLength: 257 },
  { code: 285, baseLength: 258, extraBits: 0, maxLength: 258 },
];
const DEFLATE_DISTANCE_CODES: readonly DeflateDistanceCode[] = [
  { code: 0, baseDistance: 1, extraBits: 0 },
  { code: 1, baseDistance: 2, extraBits: 0 },
  { code: 2, baseDistance: 3, extraBits: 0 },
  { code: 3, baseDistance: 4, extraBits: 0 },
  { code: 4, baseDistance: 5, extraBits: 1 },
  { code: 5, baseDistance: 7, extraBits: 1 },
  { code: 6, baseDistance: 9, extraBits: 2 },
  { code: 7, baseDistance: 13, extraBits: 2 },
  { code: 8, baseDistance: 17, extraBits: 3 },
  { code: 9, baseDistance: 25, extraBits: 3 },
  { code: 10, baseDistance: 33, extraBits: 4 },
  { code: 11, baseDistance: 49, extraBits: 4 },
  { code: 12, baseDistance: 65, extraBits: 5 },
  { code: 13, baseDistance: 97, extraBits: 5 },
  { code: 14, baseDistance: 129, extraBits: 6 },
  { code: 15, baseDistance: 193, extraBits: 6 },
  { code: 16, baseDistance: 257, extraBits: 7 },
  { code: 17, baseDistance: 385, extraBits: 7 },
  { code: 18, baseDistance: 513, extraBits: 8 },
  { code: 19, baseDistance: 769, extraBits: 8 },
  { code: 20, baseDistance: 1_025, extraBits: 9 },
  { code: 21, baseDistance: 1_537, extraBits: 9 },
  { code: 22, baseDistance: 2_049, extraBits: 10 },
  { code: 23, baseDistance: 3_073, extraBits: 10 },
  { code: 24, baseDistance: 4_097, extraBits: 11 },
  { code: 25, baseDistance: 6_145, extraBits: 11 },
  { code: 26, baseDistance: 8_193, extraBits: 12 },
  { code: 27, baseDistance: 12_289, extraBits: 12 },
  { code: 28, baseDistance: 16_385, extraBits: 13 },
  { code: 29, baseDistance: 24_577, extraBits: 13 },
];
const BITMAP_FONT = new Map<string, readonly string[]>([
  [" ", ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]],
  ["-", ["00000", "00000", "00000", "11111", "00000", "00000", "00000"]],
  [".", ["00000", "00000", "00000", "00000", "00000", "01100", "01100"]],
  [":", ["00000", "01100", "01100", "00000", "01100", "01100", "00000"]],
  ["/", ["00001", "00010", "00100", "01000", "10000", "00000", "00000"]],
  ["0", ["01110", "10001", "10011", "10101", "11001", "10001", "01110"]],
  ["1", ["00100", "01100", "00100", "00100", "00100", "00100", "01110"]],
  ["2", ["01110", "10001", "00001", "00010", "00100", "01000", "11111"]],
  ["3", ["11110", "00001", "00001", "01110", "00001", "00001", "11110"]],
  ["4", ["00010", "00110", "01010", "10010", "11111", "00010", "00010"]],
  ["5", ["11111", "10000", "11110", "00001", "00001", "10001", "01110"]],
  ["6", ["00110", "01000", "10000", "11110", "10001", "10001", "01110"]],
  ["7", ["11111", "00001", "00010", "00100", "01000", "01000", "01000"]],
  ["8", ["01110", "10001", "10001", "01110", "10001", "10001", "01110"]],
  ["9", ["01110", "10001", "10001", "01111", "00001", "00010", "11100"]],
  ["A", ["01110", "10001", "10001", "11111", "10001", "10001", "10001"]],
  ["B", ["11110", "10001", "10001", "11110", "10001", "10001", "11110"]],
  ["C", ["01110", "10001", "10000", "10000", "10000", "10001", "01110"]],
  ["D", ["11110", "10001", "10001", "10001", "10001", "10001", "11110"]],
  ["E", ["11111", "10000", "10000", "11110", "10000", "10000", "11111"]],
  ["F", ["11111", "10000", "10000", "11110", "10000", "10000", "10000"]],
  ["G", ["01110", "10001", "10000", "10111", "10001", "10001", "01110"]],
  ["H", ["10001", "10001", "10001", "11111", "10001", "10001", "10001"]],
  ["I", ["01110", "00100", "00100", "00100", "00100", "00100", "01110"]],
  ["J", ["00111", "00010", "00010", "00010", "00010", "10010", "01100"]],
  ["K", ["10001", "10010", "10100", "11000", "10100", "10010", "10001"]],
  ["L", ["10000", "10000", "10000", "10000", "10000", "10000", "11111"]],
  ["M", ["10001", "11011", "10101", "10101", "10001", "10001", "10001"]],
  ["N", ["10001", "11001", "10101", "10011", "10001", "10001", "10001"]],
  ["O", ["01110", "10001", "10001", "10001", "10001", "10001", "01110"]],
  ["P", ["11110", "10001", "10001", "11110", "10000", "10000", "10000"]],
  ["Q", ["01110", "10001", "10001", "10001", "10101", "10010", "01101"]],
  ["R", ["11110", "10001", "10001", "11110", "10100", "10010", "10001"]],
  ["S", ["01111", "10000", "10000", "01110", "00001", "00001", "11110"]],
  ["T", ["11111", "00100", "00100", "00100", "00100", "00100", "00100"]],
  ["U", ["10001", "10001", "10001", "10001", "10001", "10001", "01110"]],
  ["V", ["10001", "10001", "10001", "10001", "10001", "01010", "00100"]],
  ["W", ["10001", "10001", "10001", "10101", "10101", "10101", "01010"]],
  ["X", ["10001", "10001", "01010", "00100", "01010", "10001", "10001"]],
  ["Y", ["10001", "10001", "01010", "00100", "00100", "00100", "00100"]],
  ["Z", ["11111", "00001", "00010", "00100", "01000", "10000", "11111"]],
  ["?", ["01110", "10001", "00001", "00010", "00100", "00000", "00100"]],
]);

export function buildRenderPageImagery(input: RenderPageImageryBuildInput): RenderPageImageryBuildResult {
  const pageBox = resolvePageBox(input.pageBox, input.displayList.commands);
  if (pageBox === undefined) {
    return {
      knownLimits: ["render-imagery-partial"],
    };
  }

  const resourcePayloadById = new Map(input.resourcePayloads.map((payload) => [payload.id, payload] as const));
  const primitives: RenderPrimitive[] = [];
  let hasPartialImagery = input.pageBox === undefined;

  for (const command of input.displayList.commands) {
    switch (command.kind) {
      case "text": {
        const primitive = buildTextPrimitive(command, pageBox, resourcePayloadById);
        if (primitive !== undefined) {
          primitives.push(primitive);
        }
        hasPartialImagery = true;
        break;
      }
      case "path": {
        const primitive = buildPathPrimitive(command, pageBox);
        if (primitive !== undefined) {
          primitives.push(primitive);
        }
        if (
          command.transparencyState.softMask !== "none" ||
          !isSupportedBlendMode(command.transparencyState.blendMode)
        ) {
          hasPartialImagery = true;
        }
        break;
      }
      case "image": {
        const primitive = buildImagePrimitive(
          command,
          pageBox,
          resourcePayloadById,
          input.cachedImageDataByPayloadId,
        );
        if (primitive !== undefined) {
          primitives.push(primitive);
        } else {
          hasPartialImagery = true;
        }
        if (command.transform !== undefined && !isAxisAlignedTransform(command.transform)) {
          hasPartialImagery = true;
        }
        break;
      }
      case "xobject":
      case "clip":
      case "marked-content":
        hasPartialImagery = true;
        break;
    }
  }

  const orderedPrimitives = primitivesAreInContentOrder(primitives)
    ? primitives
    : primitives.toSorted((left, right) => left.contentOrder - right.contentOrder);
  const svgWidth = toPixelDimension(pageBox.width);
  const svgHeight = toPixelDimension(pageBox.height);
  const svg = buildSvgImagery(orderedPrimitives, svgWidth, svgHeight, input.svgBudgetCharacters);
  const rasterDimensions = resolveRasterDimensions(svgWidth, svgHeight, input.rasterBudgetBytes);
  const raster = buildRasterImagery(
    orderedPrimitives,
    rasterDimensions.width,
    rasterDimensions.height,
    rasterDimensions.scale,
  );

  return {
    pageBox,
    imagery: {
      ...(svg !== undefined ? { svg } : {}),
      raster,
    },
    knownLimits: hasPartialImagery || svg === undefined || rasterDimensions.scale !== 1
      ? ["render-imagery-partial"]
      : [],
  };
}

function primitivesAreInContentOrder(primitives: readonly RenderPrimitive[]): boolean {
  for (let index = 1; index < primitives.length; index += 1) {
    if ((primitives[index - 1]?.contentOrder ?? 0) > (primitives[index]?.contentOrder ?? 0)) {
      return false;
    }
  }

  return true;
}

function buildTextPrimitive(
  command: PdfDisplayTextCommand,
  pageBox: PdfBoundingBox,
  resourcePayloadById: ReadonlyMap<string, PdfRenderResourcePayload>,
): TextPrimitive | undefined {
  if (command.text.length === 0) {
    return undefined;
  }

  const bbox = command.bbox
    ? normalizeBoundingBox(pageBox, command.bbox)
    : command.anchor
      ? estimateTextBoundingBox(pageBox, command.anchor, command.text, command.fontSize)
      : undefined;
  if (bbox === undefined) {
    return undefined;
  }

  const fontPayload = command.fontPayloadId !== undefined
    ? resourcePayloadById.get(command.fontPayloadId)
    : undefined;
  const fontFamily = fontPayload?.kind === "font" && fontPayload.baseFontName
    ? fontPayload.baseFontName.replaceAll("/", "")
    : "monospace";
  const fontSize = command.fontSize ?? Math.max(8, bbox.height * 0.8);

  return {
    kind: "text",
    contentOrder: command.contentOrder,
    text: command.text,
    bbox,
    fontFamily,
    fontSize,
  };
}

function buildPathPrimitive(
  command: PdfDisplayPathCommand,
  pageBox: PdfBoundingBox,
): PathPrimitive | undefined {
  if (command.paintOperator === "n") {
    return undefined;
  }

  const normalizedPath = normalizePathSegments(command.segments, command.transform, pageBox);
  if (normalizedPath.svgPathData.length === 0) {
    return undefined;
  }

  const strokeColor = shouldStrokePath(command.paintOperator)
    ? toRgbaColor(command.colorState.strokeColor, command.transparencyState.strokeAlpha)
    : undefined;
  const fillColor = shouldFillPath(command.paintOperator)
    ? toRgbaColor(command.colorState.fillColor, command.transparencyState.fillAlpha)
    : undefined;

  return {
    kind: "path",
    contentOrder: command.contentOrder,
    svgPathData: normalizedPath.svgPathData,
    rasterSubpaths: normalizedPath.rasterSubpaths,
    fillRule: usesEvenOddFill(command.paintOperator) ? "evenodd" : "nonzero",
    ...(strokeColor !== undefined ? { strokeColor } : {}),
    ...(fillColor !== undefined ? { fillColor } : {}),
    strokeWidth: Math.max(command.paintState.lineWidth, 0.5),
    dashPattern: command.paintState.dashPattern.segments,
    dashPhase: command.paintState.dashPattern.phase,
    lineCapStyle: command.paintState.lineCapStyle,
    lineJoinStyle: command.paintState.lineJoinStyle,
    miterLimit: command.paintState.miterLimit,
    blendMode: command.transparencyState.blendMode,
  };
}

function buildImagePrimitive(
  command: PdfDisplayImageCommand,
  pageBox: PdfBoundingBox,
  resourcePayloadById: ReadonlyMap<string, PdfRenderResourcePayload>,
  cachedImageDataByPayloadId: Map<string, CachedImageData> | undefined,
): ImagePrimitive | undefined {
  if (command.imagePayloadId === undefined) {
    return undefined;
  }

  const payload = resourcePayloadById.get(command.imagePayloadId);
  if (payload?.kind !== "image" || payload.availability !== "available" || payload.bytes === undefined) {
    return undefined;
  }

  const bbox = command.bbox ? normalizeBoundingBox(pageBox, command.bbox) : undefined;
  if (bbox === undefined) {
    return undefined;
  }

  const cachedImageData = cachedImageDataByPayloadId?.get(command.imagePayloadId);
  const imageData = cachedImageData ?? buildCachedImageData(payload);
  if (imageData === undefined) {
    return undefined;
  }
  cachedImageDataByPayloadId?.set(command.imagePayloadId, imageData);

  return {
    kind: "image",
    contentOrder: command.contentOrder,
    bbox,
    image: imageData.image,
    dataUri: imageData.dataUri,
  };
}

function buildCachedImageData(
  payload: Extract<PdfRenderResourcePayload, { readonly kind: "image" }>,
): CachedImageData | undefined {
  const image = decodeImagePayload(payload);
  if (image === undefined) {
    return undefined;
  }

  return {
    image,
    dataUri: `data:image/png;base64,${encodeBase64(encodePngRgba(image.width, image.height, image.rgbaBytes))}`,
  };
}

function resolvePageBox(
  pageBox: PdfBoundingBox | undefined,
  commands: readonly PdfDisplayCommand[],
): PdfBoundingBox | undefined {
  if (pageBox !== undefined) {
    return pageBox;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const command of commands) {
    if (command.bbox === undefined) {
      continue;
    }
    minX = Math.min(minX, command.bbox.x);
    minY = Math.min(minY, command.bbox.y);
    maxX = Math.max(maxX, command.bbox.x + command.bbox.width);
    maxY = Math.max(maxY, command.bbox.y + command.bbox.height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return undefined;
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function normalizeBoundingBox(pageBox: PdfBoundingBox, bbox: PdfBoundingBox): PdfBoundingBox {
  return {
    x: bbox.x - pageBox.x,
    y: pageBox.height - (bbox.y - pageBox.y) - bbox.height,
    width: bbox.width,
    height: bbox.height,
  };
}

function estimateTextBoundingBox(
  pageBox: PdfBoundingBox,
  anchor: PdfPoint,
  text: string,
  fontSize: number | undefined,
): PdfBoundingBox {
  const resolvedFontSize = fontSize ?? 12;
  const width = Math.max(resolvedFontSize * Math.max(text.length, 1) * 0.6, resolvedFontSize * 0.6);
  const height = resolvedFontSize * 1.2;

  return {
    x: anchor.x - pageBox.x,
    y: pageBox.height - (anchor.y - pageBox.y) - height,
    width,
    height,
  };
}

function normalizePathSegments(
  segments: readonly PdfObservedPathSegment[],
  transform: PdfTransformMatrix | undefined,
  pageBox: PdfBoundingBox,
): {
  readonly svgPathData: string;
  readonly rasterSubpaths: readonly RasterSubpath[];
} {
  const activeTransform = transform ?? IDENTITY_TRANSFORM;
  const pathParts: string[] = [];
  const rasterSubpaths: RasterSubpath[] = [];
  let currentPoints: NormalizedPoint[] = [];
  let currentPoint: NormalizedPoint | undefined;
  let subpathStart: NormalizedPoint | undefined;
  let currentClosed = false;

  const flushCurrentSubpath = () => {
    if (currentPoints.length > 0) {
      rasterSubpaths.push({
        points: currentPoints,
        closed: currentClosed,
      });
    }
    currentPoints = [];
    currentClosed = false;
  };

  for (const segment of segments) {
    switch (segment.kind) {
      case "move-to": {
        flushCurrentSubpath();
        const point = normalizePoint(pageBox, transformPoint(activeTransform, segment.to));
        pathParts.push(`M${formatNumber(point.x)} ${formatNumber(point.y)}`);
        currentPoints = [point];
        currentPoint = point;
        subpathStart = point;
        break;
      }
      case "line-to": {
        const point = normalizePoint(pageBox, transformPoint(activeTransform, segment.to));
        pathParts.push(`L${formatNumber(point.x)} ${formatNumber(point.y)}`);
        currentPoints.push(point);
        currentPoint = point;
        break;
      }
      case "curve-to": {
        const control1 = normalizePoint(pageBox, transformPoint(activeTransform, segment.control1));
        const control2 = normalizePoint(pageBox, transformPoint(activeTransform, segment.control2));
        const point = normalizePoint(pageBox, transformPoint(activeTransform, segment.to));
        pathParts.push(
          `C${formatNumber(control1.x)} ${formatNumber(control1.y)} ${formatNumber(control2.x)} ${formatNumber(control2.y)} ${formatNumber(point.x)} ${formatNumber(point.y)}`,
        );
        const curvePoints = flattenCubicCurve(currentPoint ?? control1, control1, control2, point);
        currentPoints.push(...curvePoints);
        currentPoint = point;
        break;
      }
      case "close-path": {
        pathParts.push("Z");
        currentClosed = true;
        if (subpathStart !== undefined && currentPoints.length > 0) {
          currentPoints.push(subpathStart);
          currentPoint = subpathStart;
        }
        break;
      }
      case "rectangle": {
        flushCurrentSubpath();
        const points = rectanglePoints(segment, activeTransform, pageBox);
        if (points.length === 0) {
          break;
        }
        pathParts.push(
          `M${formatNumber(points[0]!.x)} ${formatNumber(points[0]!.y)} ` +
            points.slice(1).map((point) => `L${formatNumber(point.x)} ${formatNumber(point.y)}`).join(" ") +
            " Z",
        );
        const axisAlignedRectangle = detectAxisAlignedRectangle(points);
        rasterSubpaths.push({
          points: [...points, points[0]!],
          closed: true,
          ...(axisAlignedRectangle !== undefined ? { axisAlignedRectangle } : {}),
        });
        currentPoints = [];
        currentPoint = undefined;
        subpathStart = undefined;
        currentClosed = false;
        break;
      }
    }
  }

  flushCurrentSubpath();

  return {
    svgPathData: pathParts.join(" ").trim(),
    rasterSubpaths,
  };
}

function rectanglePoints(
  segment: Extract<PdfObservedPathSegment, { readonly kind: "rectangle" }>,
  transform: PdfTransformMatrix,
  pageBox: PdfBoundingBox,
): readonly NormalizedPoint[] {
  const corners = [
    { x: segment.x, y: segment.y },
    { x: segment.x + segment.width, y: segment.y },
    { x: segment.x + segment.width, y: segment.y + segment.height },
    { x: segment.x, y: segment.y + segment.height },
  ] as const;

  return corners.map((point) => normalizePoint(pageBox, transformPoint(transform, point)));
}

function detectAxisAlignedRectangle(points: readonly NormalizedPoint[]): PdfBoundingBox | undefined {
  if (points.length !== 4) {
    return undefined;
  }

  const xs = new Set<string>();
  const ys = new Set<string>();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    xs.add(formatNumber(point.x));
    ys.add(formatNumber(point.y));
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  if (xs.size !== 2 || ys.size !== 2) {
    return undefined;
  }

  if (maxX <= minX || maxY <= minY) {
    return undefined;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function normalizePoint(pageBox: PdfBoundingBox, point: PdfPoint): NormalizedPoint {
  return {
    x: point.x - pageBox.x,
    y: pageBox.height - (point.y - pageBox.y),
  };
}

function transformPoint(transform: PdfTransformMatrix, point: PdfPoint): PdfPoint {
  return {
    x: point.x * transform.a + point.y * transform.c + transform.e,
    y: point.x * transform.b + point.y * transform.d + transform.f,
  };
}

function flattenCubicCurve(
  start: NormalizedPoint,
  control1: NormalizedPoint,
  control2: NormalizedPoint,
  end: NormalizedPoint,
): readonly NormalizedPoint[] {
  const points: NormalizedPoint[] = [];
  const stepCount = 12;

  for (let index = 1; index <= stepCount; index += 1) {
    const t = index / stepCount;
    const mt = 1 - t;
    points.push({
      x:
        mt * mt * mt * start.x +
        3 * mt * mt * t * control1.x +
        3 * mt * t * t * control2.x +
        t * t * t * end.x,
      y:
        mt * mt * mt * start.y +
        3 * mt * mt * t * control1.y +
        3 * mt * t * t * control2.y +
        t * t * t * end.y,
    });
  }

  return points;
}

function buildSvgImagery(
  primitives: readonly RenderPrimitive[],
  width: number,
  height: number,
  characterBudget: number | undefined,
): PdfRenderPageImageSvg | undefined {
  const closingElement = "</svg>";
  const elements: string[] = [];
  let characterCount = 0;
  const appendElement = (element: string): boolean => {
    if (
      characterBudget !== undefined &&
      characterCount + element.length + closingElement.length > characterBudget
    ) {
      return false;
    }
    elements.push(element);
    characterCount += element.length;
    return true;
  };

  if (
    !appendElement(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}">`,
    ) ||
    !appendElement(`<rect x="0" y="0" width="${String(width)}" height="${String(height)}" fill="#ffffff"/>`)
  ) {
    return undefined;
  }

  for (const primitive of primitives) {
    switch (primitive.kind) {
      case "path":
        if (!appendElement(buildSvgPathElement(primitive))) {
          return undefined;
        }
        break;
      case "text":
        if (!appendElement(buildSvgTextElement(primitive))) {
          return undefined;
        }
        break;
      case "image":
        if (
          !appendElement(
            `<image x="${formatNumber(primitive.bbox.x)}" y="${formatNumber(primitive.bbox.y)}" width="${formatNumber(primitive.bbox.width)}" height="${formatNumber(primitive.bbox.height)}" href="${primitive.dataUri}"/>`,
          )
        ) {
          return undefined;
        }
        break;
    }
  }

  elements.push(closingElement);

  return {
    mimeType: "image/svg+xml",
    markup: elements.join(""),
    width,
    height,
  };
}

function buildSvgPathElement(primitive: PathPrimitive): string {
  const attributes = [
    `d="${primitive.svgPathData}"`,
    `fill="${primitive.fillColor ? toSvgColor(primitive.fillColor) : "none"}"`,
    `stroke="${primitive.strokeColor ? toSvgColor(primitive.strokeColor) : "none"}"`,
    `stroke-width="${formatNumber(primitive.strokeWidth)}"`,
    `stroke-linecap="${primitive.lineCapStyle}"`,
    `stroke-linejoin="${primitive.lineJoinStyle}"`,
    `stroke-miterlimit="${formatNumber(primitive.miterLimit)}"`,
  ];

  if (primitive.fillColor && primitive.fillColor.a < 1) {
    attributes.push(`fill-opacity="${formatNumber(primitive.fillColor.a)}"`);
  }
  if (primitive.strokeColor && primitive.strokeColor.a < 1) {
    attributes.push(`stroke-opacity="${formatNumber(primitive.strokeColor.a)}"`);
  }
  if (primitive.fillRule === "evenodd") {
    attributes.push('fill-rule="evenodd"');
  }
  if (primitive.dashPattern.length > 0) {
    attributes.push(`stroke-dasharray="${primitive.dashPattern.map((value) => formatNumber(value)).join(" ")}"`);
    attributes.push(`stroke-dashoffset="${formatNumber(primitive.dashPhase)}"`);
  }
  if (primitive.blendMode !== "normal") {
    attributes.push(`style="mix-blend-mode:${primitive.blendMode}"`);
  }

  return `<path ${attributes.join(" ")}/>`;
}

function buildSvgTextElement(primitive: TextPrimitive): string {
  const baselineY = primitive.bbox.y + primitive.bbox.height * 0.82;
  return `<text x="${formatNumber(primitive.bbox.x)}" y="${formatNumber(baselineY)}" font-family="${escapeXml(primitive.fontFamily)}" font-size="${formatNumber(primitive.fontSize)}" fill="#000000" xml:space="preserve">${escapeXml(primitive.text)}</text>`;
}

function buildRasterImagery(
  primitives: readonly RenderPrimitive[],
  width: number,
  height: number,
  scale: number,
): PdfRenderPageImageRaster {
  const rgbaBytes = new Uint8Array(width * height * 4);
  rgbaBytes.fill(WHITE_PIXEL[0]);

  for (const primitive of primitives) {
    switch (primitive.kind) {
      case "path":
        rasterizePathPrimitive(rgbaBytes, width, height, primitive, scale);
        break;
      case "text":
        rasterizeTextPrimitive(rgbaBytes, width, height, primitive, scale);
        break;
      case "image":
        rasterizeImagePrimitive(rgbaBytes, width, height, primitive, scale);
        break;
    }
  }

  return {
    mimeType: "image/png",
    bytes: encodePngRgba(width, height, rgbaBytes),
    width,
    height,
  };
}

function rasterizePathPrimitive(
  rgbaBytes: Uint8Array,
  width: number,
  height: number,
  primitive: PathPrimitive,
  scale: number,
): void {
  const rasterSubpaths = scale === 1
    ? primitive.rasterSubpaths
    : primitive.rasterSubpaths.map((subpath) => scaleRasterSubpath(subpath, scale));
  const strokeWidth = scale === 1 ? primitive.strokeWidth : Math.max(0.5, primitive.strokeWidth * scale);
  const dashPattern = scale === 1 ? primitive.dashPattern : primitive.dashPattern.map((value) => value * scale);
  const dashPhase = scale === 1 ? primitive.dashPhase : primitive.dashPhase * scale;

  if (primitive.fillColor !== undefined) {
    for (const subpath of rasterSubpaths) {
      if (subpath.axisAlignedRectangle !== undefined) {
        fillRectangle(
          rgbaBytes,
          width,
          height,
          subpath.axisAlignedRectangle,
          primitive.fillColor,
          primitive.blendMode,
        );
        continue;
      }
      if (subpath.closed && subpath.points.length >= 3) {
        fillPolygon(rgbaBytes, width, height, subpath.points, primitive.fillColor, primitive.blendMode);
      }
    }
  }

  if (primitive.strokeColor !== undefined) {
    const dashedStroke = dashPattern.length > 0
      ? applyDashPattern(rasterSubpaths, dashPattern, dashPhase)
      : rasterSubpaths;
    for (const subpath of dashedStroke) {
      if (subpath.axisAlignedRectangle !== undefined && dashPattern.length === 0) {
        strokeRectangle(
          rgbaBytes,
          width,
          height,
          subpath.axisAlignedRectangle,
          strokeWidth,
          primitive.strokeColor,
          primitive.blendMode,
        );
        continue;
      }
      strokePolyline(
        rgbaBytes,
        width,
        height,
        subpath.points,
        strokeWidth,
        primitive.strokeColor,
        primitive.blendMode,
      );
    }
  }
}

function rasterizeTextPrimitive(
  rgbaBytes: Uint8Array,
  width: number,
  height: number,
  primitive: TextPrimitive,
  scale: number,
): void {
  const bbox = scale === 1 ? primitive.bbox : scaleBoundingBox(primitive.bbox, scale);
  const glyphCount = Math.max(primitive.text.length, 1);
  const glyphWidth = bbox.width / glyphCount;
  const glyphHeight = bbox.height;
  const pixelWidth = glyphWidth / 6;
  const pixelHeight = glyphHeight / 8;

  let glyphIndex = 0;
  for (const character of primitive.text) {
    const rows = BITMAP_FONT.get(character.toUpperCase()) ?? BITMAP_FONT.get("?") ?? [];
    const glyphX = bbox.x + glyphIndex * glyphWidth;
    const glyphY = bbox.y;

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] ?? "";
      for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
        if (row.charCodeAt(columnIndex) !== 49) {
          continue;
        }

        fillRectangle(
          rgbaBytes,
          width,
          height,
          {
            x: glyphX + columnIndex * pixelWidth,
            y: glyphY + rowIndex * pixelHeight,
            width: pixelWidth,
            height: pixelHeight,
          },
          BLACK_PIXEL,
          "normal",
        );
      }
    }
    glyphIndex += 1;
  }
}

function rasterizeImagePrimitive(
  rgbaBytes: Uint8Array,
  width: number,
  height: number,
  primitive: ImagePrimitive,
  scale: number,
): void {
  const bbox = scale === 1 ? primitive.bbox : scaleBoundingBox(primitive.bbox, scale);
  const targetWidth = Math.max(1, Math.round(bbox.width));
  const targetHeight = Math.max(1, Math.round(bbox.height));
  const startX = Math.round(bbox.x);
  const startY = Math.round(bbox.y);
  const visibleStartX = Math.max(0, startX);
  const visibleStartY = Math.max(0, startY);
  const visibleEndX = Math.min(width, startX + targetWidth);
  const visibleEndY = Math.min(height, startY + targetHeight);

  if (visibleStartX >= visibleEndX || visibleStartY >= visibleEndY) {
    return;
  }

  for (let destinationY = visibleStartY; destinationY < visibleEndY; destinationY += 1) {
    const localY = destinationY - startY;
    for (let destinationX = visibleStartX; destinationX < visibleEndX; destinationX += 1) {
      const localX = destinationX - startX;
      const sourceX = Math.min(
        primitive.image.width - 1,
        Math.max(0, Math.floor((localX / targetWidth) * primitive.image.width)),
      );
      const sourceY = Math.min(
        primitive.image.height - 1,
        Math.max(0, Math.floor((localY / targetHeight) * primitive.image.height)),
      );
      const sourceIndex = (sourceY * primitive.image.width + sourceX) * 4;
      const color: RgbaColor = {
        r: primitive.image.rgbaBytes[sourceIndex] ?? 0,
        g: primitive.image.rgbaBytes[sourceIndex + 1] ?? 0,
        b: primitive.image.rgbaBytes[sourceIndex + 2] ?? 0,
        a: (primitive.image.rgbaBytes[sourceIndex + 3] ?? 255) / 255,
      };
      blendPixel(rgbaBytes, width, destinationX, destinationY, color, "normal");
    }
  }
}

function fillRectangle(
  rgbaBytes: Uint8Array,
  width: number,
  height: number,
  rectangle: PdfBoundingBox,
  color: RgbaColor,
  blendMode: PdfObservedBlendMode,
): void {
  const startX = Math.max(0, Math.floor(rectangle.x));
  const endX = Math.min(width, Math.ceil(rectangle.x + rectangle.width));
  const startY = Math.max(0, Math.floor(rectangle.y));
  const endY = Math.min(height, Math.ceil(rectangle.y + rectangle.height));

  for (let y = startY; y < endY; y += 1) {
    fillHorizontalSpan(rgbaBytes, width, y, startX, endX - 1, color, blendMode);
  }
}

function fillPolygon(
  rgbaBytes: Uint8Array,
  width: number,
  height: number,
  points: readonly NormalizedPoint[],
  color: RgbaColor,
  blendMode: PdfObservedBlendMode,
): void {
  let pointMinY = Number.POSITIVE_INFINITY;
  let pointMaxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    pointMinY = Math.min(pointMinY, point.y);
    pointMaxY = Math.max(pointMaxY, point.y);
  }
  const minY = Math.max(0, Math.floor(pointMinY));
  const maxY = Math.min(height - 1, Math.ceil(pointMaxY));

  for (let y = minY; y <= maxY; y += 1) {
    const scanY = y + 0.5;
    const intersections: number[] = [];

    for (let index = 0; index < points.length; index += 1) {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      if (start === undefined || end === undefined) {
        continue;
      }
      if ((start.y <= scanY && end.y > scanY) || (end.y <= scanY && start.y > scanY)) {
        const ratio = (scanY - start.y) / (end.y - start.y);
        intersections.push(start.x + ratio * (end.x - start.x));
      }
    }

    intersections.sort((left, right) => left - right);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const startX = Math.max(0, Math.floor(intersections[index] ?? 0));
      const endX = Math.min(width - 1, Math.ceil(intersections[index + 1] ?? 0));
      fillHorizontalSpan(rgbaBytes, width, y, startX, endX, color, blendMode);
    }
  }
}

function fillHorizontalSpan(
  rgbaBytes: Uint8Array,
  width: number,
  y: number,
  startX: number,
  endX: number,
  color: RgbaColor,
  blendMode: PdfObservedBlendMode,
): void {
  if (endX < startX) {
    return;
  }

  if (blendMode === "normal" && color.a >= 0.999) {
    const alphaByte = clampByte(color.a * 255);
    let offset = (y * width + startX) * 4;
    for (let x = startX; x <= endX; x += 1) {
      rgbaBytes[offset] = color.r;
      rgbaBytes[offset + 1] = color.g;
      rgbaBytes[offset + 2] = color.b;
      rgbaBytes[offset + 3] = alphaByte;
      offset += 4;
    }
    return;
  }

  for (let x = startX; x <= endX; x += 1) {
    blendPixel(rgbaBytes, width, x, y, color, blendMode);
  }
}

function strokePolyline(
  rgbaBytes: Uint8Array,
  width: number,
  height: number,
  points: readonly NormalizedPoint[],
  strokeWidth: number,
  color: RgbaColor,
  blendMode: PdfObservedBlendMode,
): void {
  if (points.length < 2) {
    return;
  }

  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start === undefined || end === undefined) {
      continue;
    }
    strokeSegment(rgbaBytes, width, height, start, end, strokeWidth, color, blendMode);
  }
}

function strokeRectangle(
  rgbaBytes: Uint8Array,
  width: number,
  height: number,
  rectangle: PdfBoundingBox,
  strokeWidth: number,
  color: RgbaColor,
  blendMode: PdfObservedBlendMode,
): void {
  const topLeft = { x: rectangle.x, y: rectangle.y };
  const topRight = { x: rectangle.x + rectangle.width, y: rectangle.y };
  const bottomRight = { x: rectangle.x + rectangle.width, y: rectangle.y + rectangle.height };
  const bottomLeft = { x: rectangle.x, y: rectangle.y + rectangle.height };

  strokeSegment(rgbaBytes, width, height, topLeft, topRight, strokeWidth, color, blendMode);
  strokeSegment(rgbaBytes, width, height, topRight, bottomRight, strokeWidth, color, blendMode);
  strokeSegment(rgbaBytes, width, height, bottomRight, bottomLeft, strokeWidth, color, blendMode);
  strokeSegment(rgbaBytes, width, height, bottomLeft, topLeft, strokeWidth, color, blendMode);
}

function strokeSegment(
  rgbaBytes: Uint8Array,
  width: number,
  height: number,
  start: NormalizedPoint,
  end: NormalizedPoint,
  strokeWidth: number,
  color: RgbaColor,
  blendMode: PdfObservedBlendMode,
): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dominantAxisLength = Math.max(Math.abs(dx), Math.abs(dy));
  const radius = Math.max(strokeWidth / 2, 0.5);

  if (dominantAxisLength <= 0.0001) {
    blendStrokeKernel(rgbaBytes, width, height, start.x, start.y, radius, color, blendMode);
    return;
  }

  const visitedPixels = new Set<number>();
  const steps = Math.max(1, Math.ceil(dominantAxisLength * 2));

  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    const x = start.x + dx * ratio;
    const y = start.y + dy * ratio;
    collectStrokeKernelPixels(visitedPixels, width, height, x, y, radius);
  }

  for (const pixelIndex of visitedPixels) {
    const pixelX = pixelIndex % width;
    const pixelY = Math.floor(pixelIndex / width);
    blendPixel(rgbaBytes, width, pixelX, pixelY, color, blendMode);
  }
}

function blendStrokeKernel(
  rgbaBytes: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
  color: RgbaColor,
  blendMode: PdfObservedBlendMode,
): void {
  const pixels = new Set<number>();
  collectStrokeKernelPixels(pixels, width, height, x, y, radius);
  for (const pixelIndex of pixels) {
    const pixelX = pixelIndex % width;
    const pixelY = Math.floor(pixelIndex / width);
    blendPixel(rgbaBytes, width, pixelX, pixelY, color, blendMode);
  }
}

function collectStrokeKernelPixels(
  pixels: Set<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): void {
  if (radius <= 0.75) {
    const pixelX = Math.round(x);
    const pixelY = Math.round(y);
    if (pixelX >= 0 && pixelY >= 0 && pixelX < width && pixelY < height) {
      pixels.add(pixelY * width + pixelX);
    }
    return;
  }

  const minX = Math.max(0, Math.floor(x - radius));
  const maxX = Math.min(width - 1, Math.ceil(x + radius));
  const minY = Math.max(0, Math.floor(y - radius));
  const maxY = Math.min(height - 1, Math.ceil(y + radius));
  const squaredRadius = radius * radius;

  for (let pixelY = minY; pixelY <= maxY; pixelY += 1) {
    for (let pixelX = minX; pixelX <= maxX; pixelX += 1) {
      const centerX = pixelX + 0.5;
      const centerY = pixelY + 0.5;
      const distanceX = centerX - x;
      const distanceY = centerY - y;
      if ((distanceX * distanceX) + (distanceY * distanceY) <= squaredRadius) {
        pixels.add(pixelY * width + pixelX);
      }
    }
  }
}

function applyDashPattern(
  subpaths: readonly RasterSubpath[],
  dashPattern: readonly number[],
  dashPhase: number,
): readonly RasterSubpath[] {
  if (dashPattern.length === 0) {
    return subpaths;
  }

  const normalizedPattern = dashPattern.some((segment) => segment > 0)
    ? dashPattern
    : [1];
  const result: RasterSubpath[] = [];

  for (const subpath of subpaths) {
    if (subpath.points.length < 2) {
      continue;
    }

    let patternIndex = 0;
    let patternOffset = dashPhase;
    let isDrawing = true;
    let activePoints: NormalizedPoint[] = [];

    for (let index = 0; index + 1 < subpath.points.length; index += 1) {
      let start = subpath.points[index];
      const end = subpath.points[index + 1];
      if (start === undefined || end === undefined) {
        continue;
      }

      let remaining = distanceBetween(start, end);
      while (remaining > 0) {
        const patternLength = normalizedPattern[patternIndex % normalizedPattern.length] ?? 1;
        const available = Math.max(patternLength - patternOffset, 0.0001);
        const segmentLength = Math.min(remaining, available);
        const ratio = segmentLength / remaining;
        const splitPoint = interpolatePoint(start, end, ratio);

        if (isDrawing) {
          if (activePoints.length === 0) {
            activePoints = [start];
          }
          activePoints.push(splitPoint);
        } else if (activePoints.length > 1) {
          result.push({ points: activePoints, closed: false });
          activePoints = [];
        } else {
          activePoints = [];
        }

        start = splitPoint;
        remaining -= segmentLength;
        patternOffset += segmentLength;

        if (patternOffset >= patternLength - 0.0001) {
          patternIndex += 1;
          patternOffset = 0;
          isDrawing = !isDrawing;
        }
      }
    }

    if (activePoints.length > 1) {
      result.push({ points: activePoints, closed: false });
    }
  }

  return result;
}

function distanceBetween(left: NormalizedPoint, right: NormalizedPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function interpolatePoint(
  start: NormalizedPoint,
  end: NormalizedPoint,
  ratio: number,
): NormalizedPoint {
  return {
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio,
  };
}

function decodeImagePayload(payload: Extract<PdfRenderResourcePayload, { readonly kind: "image" }>): DecodedImagePixels | undefined {
  const width = payload.width;
  const height = payload.height;
  const bytes = payload.bytes;
  if (
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0 ||
    payload.bitsPerComponent !== 8 ||
    bytes === undefined
  ) {
    return undefined;
  }

  const pixelCount = width * height;
  const rgbaBytes = new Uint8Array(pixelCount * 4);

  switch (payload.colorSpaceValue) {
    case undefined:
      return undefined;
    case "/DeviceGray":
      if (bytes.length < pixelCount) {
        return undefined;
      }
      for (let index = 0; index < pixelCount; index += 1) {
        const value = bytes[index] ?? 0;
        rgbaBytes[index * 4] = value;
        rgbaBytes[index * 4 + 1] = value;
        rgbaBytes[index * 4 + 2] = value;
        rgbaBytes[index * 4 + 3] = 255;
      }
      return { width, height, rgbaBytes };
    case "/DeviceRGB":
      if (bytes.length < pixelCount * 3) {
        return undefined;
      }
      for (let index = 0; index < pixelCount; index += 1) {
        rgbaBytes[index * 4] = bytes[index * 3] ?? 0;
        rgbaBytes[index * 4 + 1] = bytes[index * 3 + 1] ?? 0;
        rgbaBytes[index * 4 + 2] = bytes[index * 3 + 2] ?? 0;
        rgbaBytes[index * 4 + 3] = 255;
      }
      return { width, height, rgbaBytes };
    case "/DeviceCMYK":
      if (bytes.length < pixelCount * 4) {
        return undefined;
      }
      for (let index = 0; index < pixelCount; index += 1) {
        const cyan = (bytes[index * 4] ?? 0) / 255;
        const magenta = (bytes[index * 4 + 1] ?? 0) / 255;
        const yellow = (bytes[index * 4 + 2] ?? 0) / 255;
        const black = (bytes[index * 4 + 3] ?? 0) / 255;
        rgbaBytes[index * 4] = Math.round(255 * (1 - cyan) * (1 - black));
        rgbaBytes[index * 4 + 1] = Math.round(255 * (1 - magenta) * (1 - black));
        rgbaBytes[index * 4 + 2] = Math.round(255 * (1 - yellow) * (1 - black));
        rgbaBytes[index * 4 + 3] = 255;
      }
      return { width, height, rgbaBytes };
    default:
      return undefined;
  }
}

function encodePngRgba(width: number, height: number, rgbaBytes: Uint8Array): Uint8Array {
  const scanlines = createPngScanlineSource(width, height, rgbaBytes);
  const compressed = encodeZlibDeflate(scanlines);
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = createPngChunk(
    "IHDR",
    Uint8Array.from([
      ...toBigEndianBytes(width),
      ...toBigEndianBytes(height),
      8,
      6,
      0,
      0,
      0,
    ]),
  );
  const idat = createPngChunk("IDAT", compressed);
  const iend = createPngChunk("IEND", new Uint8Array(0));

  return concatUint8Arrays([signature, ihdr, idat, iend]);
}

function createPngScanlineSource(width: number, height: number, rgbaBytes: Uint8Array): ByteSource {
  const rowByteLength = width * 4;
  const scanlineByteLength = rowByteLength + 1;
  return {
    length: height * scanlineByteLength,
    byteAt(index: number): number {
      const column = index % scanlineByteLength;
      if (column === 0) {
        return 0;
      }
      const row = Math.floor(index / scanlineByteLength);
      return rgbaBytes[(row * rowByteLength) + column - 1] ?? 0;
    },
  };
}

function encodeZlibDeflate(source: ByteSource): Uint8Array {
  const compressed = encodeZlibFixedHuffman(source);
  const storedLength = estimateZlibStoredBlockLength(source.length);
  return compressed.byteLength <= storedLength ? compressed : encodeZlibStoredBlocks(source);
}

function encodeZlibFixedHuffman(source: ByteSource): Uint8Array {
  const hashTable = new Int32Array(DEFLATE_HASH_SIZE);
  hashTable.fill(-1);

  const writer = new DeflateBitWriter();
  const adler = new Adler32State();
  writer.writeBits(1, 1);
  writer.writeBits(0b01, 2);

  let position = 0;
  while (position < source.length) {
    const match = findDeflateMatch(source, hashTable, position);
    if (match.length >= DEFLATE_MIN_MATCH_LENGTH) {
      writeDeflateLengthDistance(writer, match);
      for (let offset = 0; offset < match.length; offset += 1) {
        const sourcePosition = position + offset;
        adler.update(source.byteAt(sourcePosition));
        rememberDeflatePosition(source, hashTable, sourcePosition);
      }
      position += match.length;
      continue;
    }

    const value = source.byteAt(position);
    writeFixedHuffmanSymbol(writer, value);
    adler.update(value);
    rememberDeflatePosition(source, hashTable, position);
    position += 1;
  }

  writeFixedHuffmanSymbol(writer, 256);
  return writer.finish(adler.digest());
}

function findDeflateMatch(
  source: ByteSource,
  hashTable: Int32Array,
  position: number,
): DeflateMatch {
  if (position + DEFLATE_MIN_MATCH_LENGTH > source.length) {
    return { length: 0, distance: 0 };
  }

  const previousPosition = hashTable[hashDeflateTriple(source, position)] ?? -1;
  if (previousPosition < 0) {
    return { length: 0, distance: 0 };
  }

  const distance = position - previousPosition;
  if (distance <= 0 || distance > DEFLATE_MAX_DISTANCE) {
    return { length: 0, distance: 0 };
  }

  const maximumLength = Math.min(DEFLATE_MAX_MATCH_LENGTH, source.length - position);
  let length = 0;
  while (
    length < maximumLength &&
    source.byteAt(previousPosition + length) === source.byteAt(position + length)
  ) {
    length += 1;
  }

  return length >= DEFLATE_MIN_MATCH_LENGTH ? { length, distance } : { length: 0, distance: 0 };
}

function rememberDeflatePosition(source: ByteSource, hashTable: Int32Array, position: number): void {
  if (position + DEFLATE_MIN_MATCH_LENGTH > source.length) {
    return;
  }
  hashTable[hashDeflateTriple(source, position)] = position;
}

function hashDeflateTriple(source: ByteSource, position: number): number {
  return (
    ((source.byteAt(position) * 257) ^
      (source.byteAt(position + 1) * 17) ^
      source.byteAt(position + 2)) &
    (DEFLATE_HASH_SIZE - 1)
  );
}

function writeDeflateLengthDistance(writer: DeflateBitWriter, match: DeflateMatch): void {
  const lengthCode = resolveDeflateLengthCode(match.length);
  writeFixedHuffmanSymbol(writer, lengthCode.code);
  writer.writeBits(match.length - lengthCode.baseLength, lengthCode.extraBits);

  const distanceCode = resolveDeflateDistanceCode(match.distance);
  writer.writeBits(reverseBits(distanceCode.code, 5), 5);
  writer.writeBits(match.distance - distanceCode.baseDistance, distanceCode.extraBits);
}

function resolveDeflateLengthCode(length: number): DeflateLengthCode {
  for (const lengthCode of DEFLATE_LENGTH_CODES) {
    if (length >= lengthCode.baseLength && length <= lengthCode.maxLength) {
      return lengthCode;
    }
  }
  throw new Error(`Unsupported deflate length: ${String(length)}.`);
}

function resolveDeflateDistanceCode(distance: number): DeflateDistanceCode {
  for (const distanceCode of DEFLATE_DISTANCE_CODES) {
    const maximumDistance = distanceCode.baseDistance + (1 << distanceCode.extraBits) - 1;
    if (distance >= distanceCode.baseDistance && distance <= maximumDistance) {
      return distanceCode;
    }
  }
  throw new Error(`Unsupported deflate distance: ${String(distance)}.`);
}

function writeFixedHuffmanSymbol(writer: DeflateBitWriter, symbol: number): void {
  if (symbol >= 0 && symbol <= 143) {
    writer.writeBits(reverseBits(0x30 + symbol, 8), 8);
    return;
  }
  if (symbol <= 255) {
    writer.writeBits(reverseBits(0x190 + symbol - 144, 9), 9);
    return;
  }
  if (symbol <= 279) {
    writer.writeBits(reverseBits(symbol - 256, 7), 7);
    return;
  }
  writer.writeBits(reverseBits(0xc0 + symbol - 280, 8), 8);
}

function reverseBits(value: number, bitCount: number): number {
  let reversed = 0;
  for (let bit = 0; bit < bitCount; bit += 1) {
    reversed = (reversed << 1) | ((value >> bit) & 1);
  }
  return reversed;
}

function encodeZlibStoredBlocks(source: ByteSource): Uint8Array {
  const blockCount = Math.ceil(source.length / 0xffff);
  const output = new Uint8Array(2 + (blockCount * 5) + source.length + 4);
  const adler = new Adler32State();
  output[0] = 0x78;
  output[1] = 0x01;

  let sourceOffset = 0;
  let outputOffset = 2;
  while (sourceOffset < source.length) {
    const remaining = source.length - sourceOffset;
    const blockLength = Math.min(remaining, 0xffff);
    const isFinalBlock = sourceOffset + blockLength >= source.length;
    output[outputOffset] = isFinalBlock ? 1 : 0;
    output[outputOffset + 1] = blockLength & 0xff;
    output[outputOffset + 2] = (blockLength >> 8) & 0xff;
    const complement = (~blockLength) & 0xffff;
    output[outputOffset + 3] = complement & 0xff;
    output[outputOffset + 4] = (complement >> 8) & 0xff;
    for (let blockOffset = 0; blockOffset < blockLength; blockOffset += 1) {
      const value = source.byteAt(sourceOffset + blockOffset);
      output[outputOffset + 5 + blockOffset] = value;
      adler.update(value);
    }
    sourceOffset += blockLength;
    outputOffset += 5 + blockLength;
  }

  const checksum = adler.digest();
  output[outputOffset] = (checksum >>> 24) & 0xff;
  output[outputOffset + 1] = (checksum >>> 16) & 0xff;
  output[outputOffset + 2] = (checksum >>> 8) & 0xff;
  output[outputOffset + 3] = checksum & 0xff;
  return output;
}

function estimateZlibStoredBlockLength(byteLength: number): number {
  const blockCount = Math.ceil(byteLength / 0xffff);
  return 2 + (blockCount * 5) + byteLength + 4;
}

class DeflateBitWriter {
  readonly #bytes = new ByteAccumulator();
  #bitBuffer = 0;
  #bitCount = 0;

  constructor() {
    this.#bytes.pushByte(0x78);
    this.#bytes.pushByte(0x01);
  }

  writeBits(value: number, bitCount: number): void {
    if (bitCount === 0) {
      return;
    }

    this.#bitBuffer |= value << this.#bitCount;
    this.#bitCount += bitCount;
    while (this.#bitCount >= 8) {
      this.#bytes.pushByte(this.#bitBuffer & 0xff);
      this.#bitBuffer >>>= 8;
      this.#bitCount -= 8;
    }
  }

  finish(adler: number): Uint8Array {
    if (this.#bitCount > 0) {
      this.#bytes.pushByte(this.#bitBuffer & 0xff);
      this.#bitBuffer = 0;
      this.#bitCount = 0;
    }

    return this.#bytes.toUint8Array([
      (adler >>> 24) & 0xff,
      (adler >>> 16) & 0xff,
      (adler >>> 8) & 0xff,
      adler & 0xff,
    ]);
  }
}

class ByteAccumulator {
  static readonly #chunkSize = 65_536;
  readonly #chunks: Uint8Array[] = [];
  #current = new Uint8Array(ByteAccumulator.#chunkSize);
  #currentOffset = 0;
  #length = 0;

  pushByte(value: number): void {
    if (this.#currentOffset >= this.#current.byteLength) {
      this.#chunks.push(this.#current);
      this.#current = new Uint8Array(ByteAccumulator.#chunkSize);
      this.#currentOffset = 0;
    }

    this.#current[this.#currentOffset] = value;
    this.#currentOffset += 1;
    this.#length += 1;
  }

  toUint8Array(tail: readonly number[]): Uint8Array {
    const output = new Uint8Array(this.#length + tail.length);
    let outputOffset = 0;
    for (const chunk of this.#chunks) {
      output.set(chunk, outputOffset);
      outputOffset += chunk.byteLength;
    }
    output.set(this.#current.subarray(0, this.#currentOffset), outputOffset);
    outputOffset += this.#currentOffset;
    output.set(tail, outputOffset);
    return output;
  }
}

class Adler32State {
  #s1 = 1;
  #s2 = 0;
  #byteCount = 0;

  update(value: number): void {
    this.#s1 += value;
    this.#s2 += this.#s1;
    this.#byteCount += 1;
    if (this.#byteCount % ADLER32_CHUNK_SIZE === 0) {
      this.#s1 %= 65521;
      this.#s2 %= 65521;
    }
  }

  digest(): number {
    this.#s1 %= 65521;
    this.#s2 %= 65521;
    return ((this.#s2 << 16) | this.#s1) >>> 0;
  }
}

function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const lengthBytes = Uint8Array.from(toBigEndianBytes(data.length));
  const crc = crc32ForParts(typeBytes, data);
  const crcBytes = Uint8Array.from([
    (crc >>> 24) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 8) & 0xff,
    crc & 0xff,
  ]);

  return concatUint8Arrays([lengthBytes, typeBytes, data, crcBytes]);
}

function toBigEndianBytes(value: number): readonly number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

function crc32ForParts(...parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const bytes of parts) {
    for (let index = 0; index < bytes.length; index += 1) {
      crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ (bytes[index] ?? 0)) & 0xff] ?? 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrc32Table(): readonly number[] {
  const table: number[] = [];
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    table.push(crc >>> 0);
  }
  return table;
}

function encodeBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;
    encoded += BASE64_ALPHABET[(chunk >>> 18) & 63] ?? "A";
    encoded += BASE64_ALPHABET[(chunk >>> 12) & 63] ?? "A";
    encoded += index + 1 < bytes.length ? BASE64_ALPHABET[(chunk >>> 6) & 63] ?? "A" : "=";
    encoded += index + 2 < bytes.length ? BASE64_ALPHABET[chunk & 63] ?? "A" : "=";
  }
  return encoded;
}

function blendPixel(
  rgbaBytes: Uint8Array,
  width: number,
  x: number,
  y: number,
  source: RgbaColor,
  blendMode: PdfObservedBlendMode,
): void {
  const offset = (y * width + x) * 4;
  const destination = {
    r: rgbaBytes[offset] ?? 255,
    g: rgbaBytes[offset + 1] ?? 255,
    b: rgbaBytes[offset + 2] ?? 255,
    a: (rgbaBytes[offset + 3] ?? 255) / 255,
  };
  const sourceAlpha = Math.max(0, Math.min(1, source.a));
  const destinationAlpha = destination.a;

  const blended = applyBlendMode(blendMode, source, destination);
  const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  const mixChannel = (sourceChannel: number, destinationChannel: number) => {
    if (outAlpha <= 0) {
      return 0;
    }
    return Math.round(
      ((sourceChannel * sourceAlpha) + (destinationChannel * destinationAlpha * (1 - sourceAlpha))) / outAlpha,
    );
  };

  rgbaBytes[offset] = mixChannel(blended.r, destination.r);
  rgbaBytes[offset + 1] = mixChannel(blended.g, destination.g);
  rgbaBytes[offset + 2] = mixChannel(blended.b, destination.b);
  rgbaBytes[offset + 3] = Math.round(outAlpha * 255);
}

function applyBlendMode(
  blendMode: PdfObservedBlendMode,
  source: RgbaColor,
  destination: RgbaColor,
): Pick<RgbaColor, "r" | "g" | "b"> {
  switch (blendMode) {
    case "normal":
    case "compatible":
    case "unknown":
    case "overlay":
    case "color-dodge":
    case "color-burn":
    case "hard-light":
    case "soft-light":
    case "difference":
    case "exclusion":
    case "hue":
    case "saturation":
    case "color":
    case "luminosity":
      return source;
    case "multiply":
      return {
        r: Math.round((source.r * destination.r) / 255),
        g: Math.round((source.g * destination.g) / 255),
        b: Math.round((source.b * destination.b) / 255),
      };
    case "screen":
      return {
        r: 255 - Math.round(((255 - source.r) * (255 - destination.r)) / 255),
        g: 255 - Math.round(((255 - source.g) * (255 - destination.g)) / 255),
        b: 255 - Math.round(((255 - source.b) * (255 - destination.b)) / 255),
      };
    case "darken":
      return {
        r: Math.min(source.r, destination.r),
        g: Math.min(source.g, destination.g),
        b: Math.min(source.b, destination.b),
      };
    case "lighten":
      return {
        r: Math.max(source.r, destination.r),
        g: Math.max(source.g, destination.g),
        b: Math.max(source.b, destination.b),
      };
  }
}

function shouldStrokePath(operator: PdfDisplayPathCommand["paintOperator"]): boolean {
  return operator === "S" || operator === "s" || operator === "B" || operator === "B*" || operator === "b" || operator === "b*";
}

function shouldFillPath(operator: PdfDisplayPathCommand["paintOperator"]): boolean {
  return operator === "f" || operator === "F" || operator === "f*" || operator === "B" || operator === "B*" || operator === "b" || operator === "b*";
}

function usesEvenOddFill(operator: PdfDisplayPathCommand["paintOperator"]): boolean {
  return operator === "f*" || operator === "B*" || operator === "b*";
}

function toRgbaColor(color: PdfObservedColor | undefined, alpha: number): RgbaColor | undefined {
  if (color === undefined) {
    return undefined;
  }

  switch (color.colorSpace.kind) {
    case "device-gray":
    case "cal-gray": {
      const value = clampByte((color.components[0] ?? 0) * 255);
      return { r: value, g: value, b: value, a: alpha };
    }
    case "device-rgb":
    case "cal-rgb":
      return {
        r: clampByte((color.components[0] ?? 0) * 255),
        g: clampByte((color.components[1] ?? 0) * 255),
        b: clampByte((color.components[2] ?? 0) * 255),
        a: alpha,
      };
    case "device-cmyk": {
      const cyan = color.components[0] ?? 0;
      const magenta = color.components[1] ?? 0;
      const yellow = color.components[2] ?? 0;
      const black = color.components[3] ?? 0;
      return {
        r: clampByte(255 * (1 - cyan) * (1 - black)),
        g: clampByte(255 * (1 - magenta) * (1 - black)),
        b: clampByte(255 * (1 - yellow) * (1 - black)),
        a: alpha,
      };
    }
    case "lab":
    case "icc-based":
    case "indexed":
    case "pattern":
    case "separation":
    case "device-n":
    case "unknown":
      return {
        r: 0,
        g: 0,
        b: 0,
        a: alpha,
      };
  }
}

function toSvgColor(color: RgbaColor): string {
  return `rgb(${String(color.r)} ${String(color.g)} ${String(color.b)})`;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toPixelDimension(value: number): number {
  return Math.max(1, Math.round(value));
}

export function estimateRenderRasterWorkBytes(width: number, height: number): number {
  const rawByteLength = height * ((width * 4) + 1);
  const storedBlockCount = Math.ceil(rawByteLength / 0xffff);
  return rawByteLength + (storedBlockCount * 5) + 63;
}

function resolveRasterDimensions(
  width: number,
  height: number,
  rasterBudgetBytes: number | undefined,
): { readonly width: number; readonly height: number; readonly scale: number } {
  if (rasterBudgetBytes === undefined || estimateRenderRasterWorkBytes(width, height) <= rasterBudgetBytes) {
    return { width, height, scale: 1 };
  }

  const maximumPixels = Math.max(1, Math.floor((rasterBudgetBytes - 1024) / 4));
  const scale = Math.min(1, Math.sqrt(maximumPixels / Math.max(1, width * height)));
  let rasterWidth = Math.max(1, Math.floor(width * scale));
  let rasterHeight = Math.max(1, Math.floor(height * scale));
  while (rasterWidth > 1 && estimateRenderRasterWorkBytes(rasterWidth, rasterHeight) > rasterBudgetBytes) {
    rasterWidth -= 1;
  }
  while (rasterHeight > 1 && estimateRenderRasterWorkBytes(rasterWidth, rasterHeight) > rasterBudgetBytes) {
    rasterHeight -= 1;
  }

  return {
    width: rasterWidth,
    height: rasterHeight,
    scale: Math.min(rasterWidth / width, rasterHeight / height),
  };
}

function scaleRasterSubpath(subpath: RasterSubpath, scale: number): RasterSubpath {
  return {
    points: subpath.points.map((point) => scalePoint(point, scale)),
    closed: subpath.closed,
    ...(subpath.axisAlignedRectangle !== undefined
      ? { axisAlignedRectangle: scaleBoundingBox(subpath.axisAlignedRectangle, scale) }
      : {}),
  };
}

function scaleBoundingBox(bbox: PdfBoundingBox, scale: number): PdfBoundingBox {
  return {
    x: bbox.x * scale,
    y: bbox.y * scale,
    width: bbox.width * scale,
    height: bbox.height * scale,
  };
}

function scalePoint(point: NormalizedPoint, scale: number): NormalizedPoint {
  return {
    x: point.x * scale,
    y: point.y * scale,
  };
}

function isAxisAlignedTransform(transform: PdfTransformMatrix): boolean {
  return transform.b === 0 && transform.c === 0;
}

function isSupportedBlendMode(blendMode: PdfObservedBlendMode): boolean {
  return blendMode === "normal" || blendMode === "multiply" || blendMode === "screen" || blendMode === "darken" || blendMode === "lighten" || blendMode === "compatible" || blendMode === "unknown";
}
