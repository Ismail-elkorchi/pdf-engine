import type { PdfLayoutBlock } from "../contracts.ts";

const STABLE_ID_SLUG_MAX_LENGTH = 56;

export function createStableId(
  prefix: string,
  fingerprintParts: readonly unknown[],
  labelParts: readonly unknown[] = fingerprintParts,
): string {
  const fingerprint = fingerprintParts.map(canonicalizeStableIdPart).join("\u001f");
  const label = labelParts
    .map(canonicalizeStableIdPart)
    .map(slugifyStableIdPart)
    .filter((part) => part.length > 0)
    .join("-");
  const slug = truncateStableIdPart(label.length === 0 ? "source" : label, STABLE_ID_SLUG_MAX_LENGTH);
  return `${prefix}-${slug}-${hashStableIdFingerprint(fingerprint)}`;
}

export function createBlockFingerprint(block: PdfLayoutBlock): string {
  return [
    block.pageNumber,
    block.pageRef === undefined ? "" : `${block.pageRef.objectNumber}:${block.pageRef.generationNumber}`,
    block.id,
    block.role,
    block.runIds.join(","),
    normalizeStableText(block.text),
    block.anchor === undefined ? "" : `${formatStableNumber(block.anchor.x)},${formatStableNumber(block.anchor.y)}`,
    block.bbox === undefined
      ? ""
      : [
          formatStableNumber(block.bbox.x),
          formatStableNumber(block.bbox.y),
          formatStableNumber(block.bbox.width),
          formatStableNumber(block.bbox.height),
        ].join(","),
  ].join("\u001e");
}

export function normalizeStableText(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function canonicalizeStableIdPart(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number") {
    return formatStableNumber(value);
  }
  if (typeof value === "string") {
    return normalizeStableText(value);
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeStableIdPart).join("\u001d");
  }
  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return normalizeStableText(JSON.stringify(value) ?? "");
}

function formatStableNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

function slugifyStableIdPart(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

function truncateStableIdPart(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength).replaceAll(/-+$/gu, "");
}

function hashStableIdFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(36).padStart(13, "0");
}
