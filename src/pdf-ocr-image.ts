import { extractPdfImages } from "./pdf-images.ts";

import type { PdfObservedDocument, PdfOcrPageImage } from "./contracts.ts";
import type { PdfDocumentModel } from "./pdf-document-model.ts";
import type { PdfObjectStore } from "./pdf-object-store.ts";
import type { PdfImagePlacement, PdfImageResource } from "./public-api.ts";

export async function buildPdfOcrPageImages(
  store: PdfObjectStore,
  model: PdfDocumentModel,
  observation: PdfObservedDocument,
): Promise<ReadonlyMap<number, PdfOcrPageImage>> {
  const images = await extractPdfImages(store, model, observation, { includeBytes: true });
  const resources = new Map(images.resources.map((resource) => [resource.id, resource] as const));
  const pageImages = new Map<number, PdfOcrPageImage>();
  const placementsByPage = new Map<number, PdfImagePlacement[]>();
  for (const placement of images.placements) {
    const placements = placementsByPage.get(placement.pageNumber) ?? [];
    placements.push(placement);
    placementsByPage.set(placement.pageNumber, placements);
  }
  for (const [pageNumber, placements] of placementsByPage) {
    const candidates = placements
      .map((placement) => ({ placement, resource: resources.get(placement.resourceId) }))
      .filter((candidate): candidate is { placement: PdfImagePlacement; resource: PdfImageResource } =>
        candidate.resource !== undefined && candidate.resource.bytes !== undefined
      )
      .toSorted((left, right) => placementArea(right.placement) - placementArea(left.placement));
    for (const candidate of candidates) {
      if (!supportsOcrImage(candidate.resource)) {
        continue;
      }
      store.budget.ocrPixels(
        candidate.resource.width * candidate.resource.height,
        `${String(pageNumber)}:${candidate.resource.id}`,
      );
      const image = toOcrPageImage(candidate.resource, candidate.placement);
      if (image === undefined) {
        continue;
      }
      pageImages.set(pageNumber, image);
      break;
    }
  }
  return pageImages;
}

function supportsOcrImage(resource: PdfImageResource): resource is PdfImageResource & {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
} {
  const { bytes, width, height } = resource;
  if (
    bytes === undefined || width === undefined || height === undefined ||
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
  ) {
    return false;
  }
  if (resource.mediaType !== undefined) {
    return true;
  }
  const bitsPerComponent = resource.bitsPerComponent;
  if (bitsPerComponent === undefined || ![1, 2, 4, 8].includes(bitsPerComponent)) {
    return false;
  }
  const componentCount = imageComponentCount(resource);
  if (componentCount === undefined) {
    return false;
  }
  const rowBytes = Math.ceil(width * componentCount * bitsPerComponent / 8);
  return Number.isSafeInteger(rowBytes) && rowBytes > 0 && bytes.byteLength >= rowBytes * height;
}

function placementArea(placement: PdfImagePlacement): number {
  return placement.bounds === undefined ? 0 : Math.abs(placement.bounds.width * placement.bounds.height);
}

function toOcrPageImage(
  resource: PdfImageResource,
  placement: PdfImagePlacement,
): PdfOcrPageImage | undefined {
  if (resource.bytes === undefined) {
    return undefined;
  }
  if (resource.width === undefined || resource.height === undefined) {
    return undefined;
  }
  if (resource.mediaType !== undefined) {
    return {
      bytes: Uint8Array.from(resource.bytes),
      mimeType: resource.mediaType,
      width: resource.width,
      height: resource.height,
      ...(placement.bounds !== undefined ? { contentBounds: placement.bounds } : {}),
    };
  }
  const pixels = decodeImageSamples(resource);
  if (pixels === undefined) {
    return undefined;
  }
  return {
    bytes: encodePngRgb(pixels.width, pixels.height, pixels.bytes),
    mimeType: "image/png",
    width: pixels.width,
    height: pixels.height,
    ...(placement.bounds !== undefined ? { contentBounds: placement.bounds } : {}),
  };
}

function decodeImageSamples(
  resource: PdfImageResource,
): { readonly width: number; readonly height: number; readonly bytes: Uint8Array } | undefined {
  const { width, height, bitsPerComponent, bytes } = resource;
  if (
    width === undefined || height === undefined || bitsPerComponent === undefined || bytes === undefined ||
    ![1, 2, 4, 8].includes(bitsPerComponent)
  ) {
    return undefined;
  }
  const componentCount = imageComponentCount(resource);
  if (componentCount === undefined) {
    return undefined;
  }
  const rowBytes = Math.ceil(width * componentCount * bitsPerComponent / 8);
  if (bytes.byteLength < rowBytes * height) {
    return undefined;
  }
  const rgb = new Uint8Array(width * height * 3);
  const maximumSample = (1 << bitsPerComponent) - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const components = Array.from({ length: componentCount }, (_, component) => {
        const bitOffset = y * rowBytes * 8 + (x * componentCount + component) * bitsPerComponent;
        const byte = bytes[Math.floor(bitOffset / 8)] ?? 0;
        const shift = 8 - bitsPerComponent - bitOffset % 8;
        const sample = (byte >>> shift) & maximumSample;
        const low = resource.decode?.[component * 2] ?? 0;
        const high = resource.decode?.[component * 2 + 1] ?? 1;
        return clampUnit(low + sample / maximumSample * (high - low));
      });
      const [red, green, blue] = componentCount === 1
        ? [components[0] ?? 0, components[0] ?? 0, components[0] ?? 0]
        : componentCount === 3
          ? [components[0] ?? 0, components[1] ?? 0, components[2] ?? 0]
          : cmykToRgb(components);
      const output = (y * width + x) * 3;
      rgb[output] = Math.round(red * 255);
      rgb[output + 1] = Math.round(green * 255);
      rgb[output + 2] = Math.round(blue * 255);
    }
  }
  return { width, height, bytes: rgb };
}

function imageComponentCount(resource: PdfImageResource): 1 | 3 | 4 | undefined {
  return resource.imageMask || isColorSpace(resource.colorSpace, "DeviceGray", "G")
    ? 1
    : isColorSpace(resource.colorSpace, "DeviceRGB", "RGB")
      ? 3
      : isColorSpace(resource.colorSpace, "DeviceCMYK", "CMYK")
        ? 4
        : undefined;
}

function isColorSpace(value: string | undefined, fullName: string, abbreviation: string): boolean {
  return value === `/${fullName}` || value === `/${abbreviation}`;
}

function cmykToRgb(components: readonly number[]): readonly [number, number, number] {
  const cyan = components[0] ?? 0;
  const secondComponent = components[1] ?? 0;
  const yellow = components[2] ?? 0;
  const black = components[3] ?? 0;
  return [
    1 - Math.min(1, cyan + black),
    1 - Math.min(1, secondComponent + black),
    1 - Math.min(1, yellow + black),
  ];
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function encodePngRgb(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const rowLength = width * 3;
  const scanlines = new Uint8Array((rowLength + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const output = row * (rowLength + 1);
    scanlines[output] = 0;
    scanlines.set(rgb.subarray(row * rowLength, (row + 1) * rowLength), output + 1);
  }
  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header.set([8, 2, 0, 0, 0], 8);
  return concatenate([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlibStored(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function zlibStored(bytes: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(bytes.byteLength / 65_535));
  const output = new Uint8Array(2 + bytes.byteLength + blockCount * 5 + 4);
  output.set([0x78, 0x01]);
  let inputOffset = 0;
  let outputOffset = 2;
  for (let block = 0; block < blockCount; block += 1) {
    const length = Math.min(65_535, bytes.byteLength - inputOffset);
    output[outputOffset] = block === blockCount - 1 ? 1 : 0;
    output[outputOffset + 1] = length & 0xff;
    output[outputOffset + 2] = length >>> 8;
    output[outputOffset + 3] = (~length) & 0xff;
    output[outputOffset + 4] = ((~length) >>> 8) & 0xff;
    output.set(bytes.subarray(inputOffset, inputOffset + length), outputOffset + 5);
    inputOffset += length;
    outputOffset += length + 5;
  }
  writeUint32(output, outputOffset, adler32(bytes));
  return output;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(data.byteLength + 12);
  writeUint32(output, 0, data.byteLength);
  output.set(typeBytes, 4);
  output.set(data, 8);
  writeUint32(output, output.byteLength - 4, crc32(concatenate([typeBytes, data])));
  return output;
}

function adler32(bytes: Uint8Array): number {
  let first = 1;
  let second = 0;
  for (const byte of bytes) {
    first = (first + byte) % 65_521;
    second = (second + first) % 65_521;
  }
  return ((second << 16) | first) >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32(output: Uint8Array, offset: number, value: number): void {
  output[offset] = value >>> 24;
  output[offset + 1] = value >>> 16;
  output[offset + 2] = value >>> 8;
  output[offset + 3] = value;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
