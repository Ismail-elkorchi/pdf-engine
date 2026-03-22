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
          command.paintState.dashPattern.segments.length > 0 ||
          command.transparencyState.softMask !== "none" ||
          !isSupportedBlendMode(command.transparencyState.blendMode)
        ) {
          hasPartialImagery = true;
        }
        break;
      }
      case "image": {
        const primitive = buildImagePrimitive(command, pageBox, resourcePayloadById);
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

  const orderedPrimitives = primitives.toSorted((left, right) => left.contentOrder - right.contentOrder);
  const svgWidth = toPixelDimension(pageBox.width);
  const svgHeight = toPixelDimension(pageBox.height);
  const svg = buildSvgImagery(orderedPrimitives, svgWidth, svgHeight);
  const raster = buildRasterImagery(orderedPrimitives, svgWidth, svgHeight);

  return {
    pageBox,
    imagery: {
      svg,
      raster,
    },
    knownLimits: hasPartialImagery ? ["render-imagery-partial"] : [],
  };
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

  const image = decodeImagePayload(payload);
  if (image === undefined) {
    return undefined;
  }

  return {
    kind: "image",
    contentOrder: command.contentOrder,
    bbox,
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
        currentPoints = currentPoints.length > 0 ? [...currentPoints, point] : [point];
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
        currentPoints = currentPoints.length > 0 ? [...currentPoints, ...curvePoints] : [...curvePoints];
        currentPoint = point;
        break;
      }
      case "close-path": {
        pathParts.push("Z");
        currentClosed = true;
        if (subpathStart !== undefined && currentPoints.length > 0) {
          currentPoints = [...currentPoints, subpathStart];
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
        rasterSubpaths.push({
          points: [...points, points[0]!],
          closed: true,
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
): PdfRenderPageImageSvg {
  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}">`,
    `<rect x="0" y="0" width="${String(width)}" height="${String(height)}" fill="#ffffff"/>`,
  ];

  for (const primitive of primitives) {
    switch (primitive.kind) {
      case "path":
        elements.push(buildSvgPathElement(primitive));
        break;
      case "text":
        elements.push(buildSvgTextElement(primitive));
        break;
      case "image":
        elements.push(
          `<image x="${formatNumber(primitive.bbox.x)}" y="${formatNumber(primitive.bbox.y)}" width="${formatNumber(primitive.bbox.width)}" height="${formatNumber(primitive.bbox.height)}" href="${primitive.dataUri}"/>`,
        );
        break;
    }
  }

  elements.push("</svg>");

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
): PdfRenderPageImageRaster {
  const rgbaBytes = new Uint8Array(width * height * 4);
  for (let index = 0; index < rgbaBytes.length; index += 4) {
    rgbaBytes[index] = WHITE_PIXEL[0];
    rgbaBytes[index + 1] = WHITE_PIXEL[1];
    rgbaBytes[index + 2] = WHITE_PIXEL[2];
    rgbaBytes[index + 3] = WHITE_PIXEL[3];
  }

  for (const primitive of primitives) {
    switch (primitive.kind) {
      case "path":
        rasterizePathPrimitive(rgbaBytes, width, height, primitive);
        break;
      case "text":
        rasterizeTextPrimitive(rgbaBytes, width, height, primitive);
        break;
      case "image":
        rasterizeImagePrimitive(rgbaBytes, width, height, primitive);
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
): void {
  if (primitive.fillColor !== undefined) {
    for (const subpath of primitive.rasterSubpaths) {
      if (subpath.closed && subpath.points.length >= 3) {
        fillPolygon(rgbaBytes, width, height, subpath.points, primitive.fillColor, primitive.blendMode);
      }
    }
  }

  if (primitive.strokeColor !== undefined) {
    const dashedStroke = primitive.dashPattern.length > 0
      ? applyDashPattern(primitive.rasterSubpaths, primitive.dashPattern, primitive.dashPhase)
      : primitive.rasterSubpaths;
    for (const subpath of dashedStroke) {
      strokePolyline(
        rgbaBytes,
        width,
        height,
        subpath.points,
        primitive.strokeWidth,
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
): void {
  const glyphCount = Math.max(primitive.text.length, 1);
  const glyphWidth = primitive.bbox.width / glyphCount;
  const glyphHeight = primitive.bbox.height;
  const pixelWidth = glyphWidth / 6;
  const pixelHeight = glyphHeight / 8;

  for (const [glyphIndex, character] of Array.from(primitive.text).entries()) {
    const rows = BITMAP_FONT.get(character.toUpperCase()) ?? BITMAP_FONT.get("?") ?? [];
    const glyphX = primitive.bbox.x + glyphIndex * glyphWidth;
    const glyphY = primitive.bbox.y;

    for (const [rowIndex, row] of rows.entries()) {
      for (const [columnIndex, value] of Array.from(row).entries()) {
        if (value !== "1") {
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
  }
}

function rasterizeImagePrimitive(
  rgbaBytes: Uint8Array,
  width: number,
  height: number,
  primitive: ImagePrimitive,
): void {
  const targetWidth = Math.max(1, Math.round(primitive.bbox.width));
  const targetHeight = Math.max(1, Math.round(primitive.bbox.height));
  const startX = Math.round(primitive.bbox.x);
  const startY = Math.round(primitive.bbox.y);

  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(
        primitive.image.width - 1,
        Math.max(0, Math.floor((x / targetWidth) * primitive.image.width)),
      );
      const sourceY = Math.min(
        primitive.image.height - 1,
        Math.max(0, Math.floor((y / targetHeight) * primitive.image.height)),
      );
      const sourceIndex = (sourceY * primitive.image.width + sourceX) * 4;
      const destinationX = startX + x;
      const destinationY = startY + y;
      if (destinationX < 0 || destinationY < 0 || destinationX >= width || destinationY >= height) {
        continue;
      }
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
    for (let x = startX; x < endX; x += 1) {
      blendPixel(rgbaBytes, width, x, y, color, blendMode);
    }
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
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point.y))));

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
      for (let x = startX; x <= endX; x += 1) {
        blendPixel(rgbaBytes, width, x, y, color, blendMode);
      }
    }
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

    const minX = Math.max(0, Math.floor(Math.min(start.x, end.x) - strokeWidth));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(start.x, end.x) + strokeWidth));
    const minY = Math.max(0, Math.floor(Math.min(start.y, end.y) - strokeWidth));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(start.y, end.y) + strokeWidth));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const distance = distanceToSegment(x + 0.5, y + 0.5, start, end);
        if (distance <= strokeWidth / 2) {
          blendPixel(rgbaBytes, width, x, y, color, blendMode);
        }
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
          activePoints = [...activePoints, splitPoint];
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

function distanceToSegment(
  x: number,
  y: number,
  start: NormalizedPoint,
  end: NormalizedPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(x - start.x, y - start.y);
  }

  const projection = ((x - start.x) * dx + (y - start.y) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, projection));
  const closestX = start.x + clamped * dx;
  const closestY = start.y + clamped * dy;
  return Math.hypot(x - closestX, y - closestY);
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
  const rawBytes = new Uint8Array(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (width * 4 + 1);
    rawBytes[rawOffset] = 0;
    rawBytes.set(rgbaBytes.subarray(row * width * 4, (row + 1) * width * 4), rawOffset + 1);
  }

  const compressed = encodeZlibStoredBlocks(rawBytes);
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

function encodeZlibStoredBlocks(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([0x78, 0x01])];
  let offset = 0;

  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    const blockLength = Math.min(remaining, 0xffff);
    const isFinalBlock = offset + blockLength >= bytes.length;
    const block = new Uint8Array(5 + blockLength);
    block[0] = isFinalBlock ? 1 : 0;
    block[1] = blockLength & 0xff;
    block[2] = (blockLength >> 8) & 0xff;
    const complement = (~blockLength) & 0xffff;
    block[3] = complement & 0xff;
    block[4] = (complement >> 8) & 0xff;
    block.set(bytes.subarray(offset, offset + blockLength), 5);
    parts.push(block);
    offset += blockLength;
  }

  const adler = adler32(bytes);
  parts.push(Uint8Array.from([
    (adler >>> 24) & 0xff,
    (adler >>> 16) & 0xff,
    (adler >>> 8) & 0xff,
    adler & 0xff,
  ]));
  return concatUint8Arrays(parts);
}

function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const lengthBytes = Uint8Array.from(toBigEndianBytes(data.length));
  const crc = crc32(concatUint8Arrays([typeBytes, data]));
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

function adler32(bytes: Uint8Array): number {
  let s1 = 1;
  let s2 = 0;
  for (const value of bytes) {
    s1 = (s1 + value) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return (s2 << 16) | s1;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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

function isAxisAlignedTransform(transform: PdfTransformMatrix): boolean {
  return transform.b === 0 && transform.c === 0;
}

function isSupportedBlendMode(blendMode: PdfObservedBlendMode): boolean {
  return blendMode === "normal" || blendMode === "multiply" || blendMode === "screen" || blendMode === "darken" || blendMode === "lighten" || blendMode === "compatible" || blendMode === "unknown";
}
