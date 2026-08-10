import type { PdfValue } from "./pdf-values.ts";

export function formatPdfValue(value: PdfValue): string {
  switch (value.kind) {
    case "null":
      return "null";
    case "boolean":
      return value.value ? "true" : "false";
    case "integer":
    case "real":
      return String(value.value);
    case "name":
      return `/${encodeName(value.bytes)}`;
    case "string":
      return value.form === "literal" ? `(${encodeLiteral(value.bytes)})` : `<${toHex(value.bytes)}>`;
    case "reference":
      return `${String(value.value.objectNumber)} ${String(value.value.generationNumber)} R`;
    case "array":
      return `[${value.items.map(formatPdfValue).join(" ")}]`;
    case "dictionary":
      return `<<${value.entries.map((entry) => `/${encodeName(entry.key.bytes)} ${formatPdfValue(entry.value)}`).join(" ")}>>`;
  }
}

function encodeName(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    if (byte >= 0x21 && byte <= 0x7e && !isDelimiter(byte) && byte !== 0x23) {
      result += String.fromCharCode(byte);
    } else {
      result += `#${byte.toString(16).padStart(2, "0").toUpperCase()}`;
    }
  }
  return result;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function encodeLiteral(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    switch (byte) {
      case 0x08:
        result += "\\b";
        break;
      case 0x09:
        result += "\\t";
        break;
      case 0x0a:
        result += "\\n";
        break;
      case 0x0c:
        result += "\\f";
        break;
      case 0x0d:
        result += "\\r";
        break;
      case 0x28:
        result += "\\(";
        break;
      case 0x29:
        result += "\\)";
        break;
      case 0x5c:
        result += "\\\\";
        break;
      default:
        result += String.fromCharCode(byte);
    }
  }
  return result;
}

function isDelimiter(byte: number): boolean {
  return byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x7b ||
    byte === 0x7d ||
    byte === 0x2f ||
    byte === 0x25;
}
