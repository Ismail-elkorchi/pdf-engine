function getArgs() {
  if (typeof Deno !== "undefined") {
    return Deno.args;
  }

  if (typeof Bun !== "undefined") {
    return Bun.argv.slice(2);
  }

  if (typeof process !== "undefined") {
    return process.argv.slice(2);
  }

  return [];
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function encodeText(value) {
  return new TextEncoder().encode(value);
}

function decodeBase64(value) {
  if (typeof Uint8Array.fromBase64 === "function") {
    return Uint8Array.fromBase64(value);
  }

  return Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
}

function joinBytes(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }

  return joined;
}

function fromByteValues(values) {
  return Uint8Array.from(values);
}

function buildPdfWithFontResourceStream({
  contentStreamText,
  fontDictionaryLines,
  resourceStreamObject,
}) {
  const contentLength = encodeText(contentStreamText).byteLength;
  const prefix = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "endobj",
    "4 0 obj",
    `<< /Length ${String(contentLength)} >>`,
    "stream",
    contentStreamText,
    "endstream",
    "endobj",
    "5 0 obj",
    ...fontDictionaryLines,
    "endobj",
    "6 0 obj",
  ].join("\n") + "\n";
  const xrefOffset = encodeText(prefix).byteLength + resourceStreamObject.byteLength;
  const suffix = [
    "xref",
    "0 7",
    "0000000000 65535 f",
    "trailer",
    "<< /Root 1 0 R /Size 7 >>",
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");

  return joinBytes([encodeText(prefix), resourceStreamObject, encodeText(suffix)]);
}

function buildPdfWithPageContents(pageContents) {
  const lines = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    `<< /Type /Pages /Kids [${pageContents.map((_, index) => `${String(3 + index * 2)} 0 R`).join(" ")}] /Count ${String(pageContents.length)} >>`,
    "endobj",
  ];

  for (const [index, contentStreamText] of pageContents.entries()) {
    const pageObjectNumber = 3 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    lines.push(
      `${String(pageObjectNumber)} 0 obj`,
      `<< /Type /Page /Parent 2 0 R /Contents ${String(contentObjectNumber)} 0 R >>`,
      "endobj",
      `${String(contentObjectNumber)} 0 obj`,
      `<< /Length ${String(encodeText(contentStreamText).byteLength)} >>`,
      "stream",
      contentStreamText,
      "endstream",
      "endobj",
    );
  }

  lines.push(
    "xref",
    `0 ${String(3 + pageContents.length * 2)}`,
    "0000000000 65535 f",
    "trailer",
    `<< /Root 1 0 R /Size ${String(3 + pageContents.length * 2)} >>`,
    "startxref",
    "__STARTXREF__",
    "%%EOF",
    "",
  );

  const template = lines.join("\n");
  const xrefOffset = template.indexOf("\nxref\n") + 1;
  assert(xrefOffset > 0, "Multi-page synthetic PDF did not contain an xref section.");
  return template.replace("__STARTXREF__", String(xrefOffset));
}

function buildObjectStreamMembers(memberTexts) {
  const headerParts = [];
  let bodyOffset = 0;

  for (const memberText of memberTexts) {
    headerParts.push(String(memberText.objectNumber), String(bodyOffset));
    bodyOffset += encodeText(memberText.text).byteLength;
  }

  const headerText = `${headerParts.join(" ")} `;
  const bodyText = memberTexts.map((memberText) => memberText.text).join("");

  return {
    firstOffset: encodeText(headerText).byteLength,
    bytes: encodeText(`${headerText}${bodyText}`),
  };
}

const [moduleSpecifier, expectedRuntime] = getArgs();

assert(typeof moduleSpecifier === "string" && moduleSpecifier.length > 0, "Missing module specifier.");
assert(typeof expectedRuntime === "string" && expectedRuntime.length > 0, "Missing expected runtime.");

const moduleNamespace = await import(moduleSpecifier);
assert(typeof moduleNamespace.createPdfEngine === "function", "Module does not export createPdfEngine().");

const syntheticPdfTemplate = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
  "endobj",
  "4 0 obj",
  "<< /Length 29 >>",
  "stream",
  "BT",
  "(Hello PDF Engine) Tj",
  "ET",
  "endstream",
  "endobj",
  "xref",
  "0 5",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 5 >>",
  "startxref",
  "__STARTXREF__",
  "%%EOF",
  "",
].join("\n");

const encryptedPdfTemplate = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
  "endobj",
  "4 0 obj",
  "<< /Length 22 >>",
  "stream",
  "BT",
  "(Encrypted Shell) Tj",
  "ET",
  "endstream",
  "endobj",
  "5 0 obj",
  "<< /Filter /Standard /V 4 >>",
  "endobj",
  "xref",
  "0 6",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 6 /Encrypt 5 0 R >>",
  "startxref",
  "__ENCRYPTED_STARTXREF__",
  "%%EOF",
  "",
].join("\n");

const flateStreamBytes = decodeBase64("eJxzCuHS8EjNyclXcMtJLEnVVAjJ4nIN4QIAUIcGfQ==");
const flatePdfPrefix = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
  "endobj",
  "4 0 obj",
  `<< /Length ${String(flateStreamBytes.byteLength)} /Filter /FlateDecode >>`,
  "stream",
].join("\n") + "\n";
const flatePdfMiddle = "\nendstream\nendobj\n";
const indirectLengthFlatePdfPrefix = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
  "endobj",
  "4 0 obj",
  "<< /Length 5 0 R /Filter /FlateDecode >>",
  "stream",
].join("\n") + "\n";
const indirectLengthFlatePdfMiddle = "\nendstream\nendobj\n";
const indirectLengthFlatePdfLengthObject = [
  "5 0 obj",
  String(flateStreamBytes.byteLength),
  "endobj",
  "",
].join("\n");

const nestedPageTreeTemplate = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Pages /Kids [4 0 R] /Count 1 /Parent 2 0 R >>",
  "endobj",
  "4 0 obj",
  "<< /Type /Page /Parent 3 0 R /Contents 6 0 R >>",
  "endobj",
  "5 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>",
  "endobj",
  "6 0 obj",
  "<< /Length 10 >>",
  "stream",
  "(First) Tj",
  "endstream",
  "endobj",
  "7 0 obj",
  "<< /Length 11 >>",
  "stream",
  "(Second) Tj",
  "endstream",
  "endobj",
  "xref",
  "0 8",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 8 >>",
  "startxref",
  "__NESTED_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const layoutPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "72 720 Td",
    "(Quarterly Report) Tj",
    "0 -24 Td",
    "/F1 12 Tf",
    "(Revenue increased across regions) Tj",
    "0 -14 Td",
    "(- North America) Tj",
    "0 -14 Td",
    "(- Europe) Tj",
    "ET",
  ].join("\n"),
]);
const repeatedBoundaryPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 14 Tf",
    "72 720 Td",
    "(Quarterly Report) Tj",
    "0 -28 Td",
    "/F1 12 Tf",
    "(Page One Body) Tj",
    "0 -620 Td",
    "(Confidential) Tj",
    "ET",
  ].join("\n"),
  [
    "BT",
    "/F1 14 Tf",
    "72 720 Td",
    "(Quarterly Report) Tj",
    "0 -28 Td",
    "/F1 12 Tf",
    "(Page Two Body) Tj",
    "0 -620 Td",
    "(Confidential) Tj",
    "ET",
  ].join("\n"),
]);
const encodedTextPdfTemplate = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
  "endobj",
  "4 0 obj",
  "<< /Length 22 >>",
  "stream",
  "BT",
  "<48656C6C6F> Tj",
  "ET",
  "endstream",
  "endobj",
  "xref",
  "0 5",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 5 >>",
  "startxref",
  "__ENCODED_TEXT_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const toUnicodeCMapFlateBytes = decodeBase64(
  "eJxdkM1qxCAQx+8+xRy3h0UT2qUHCZSUQA79oGkfwOgkFRoVYw55+0502UIPOr9h5j9fvO2fe2cT8Pfo9YAJJutMxNVvUSOMOFvHqhqM1enq5V8vKjBO4mFfEy69mzxICfyDgmuKO5yejB/xDvhbNBitm+H01Q7kD1sIP7igSyCgacDgRIVeVHhVCwLPsnNvKG7TfibNX8bnHhDq7FdlGO0NrkFpjMrNyKQQDciuaxg68y92KYpx0t8qMnn/SJlCkGHy8pCZDHFbuD24K0z1ZC0ykyGuCle5z7Xi0fE4ym0VvcVIW+TL5fGPwa3D23GDD4cqv18KDXoH",
);
const malformedToUnicodeBytes = encodeText("not-deflate");
const unsupportedToUnicodeBytes = encodeText("BT /F1 12 Tf <48656C6C6F21> Tj ET");
const toUnicodeFlateStreamObject = joinBytes([
  encodeText(`<< /Length ${String(toUnicodeCMapFlateBytes.byteLength)} /Filter /FlateDecode >>\nstream\n`),
  toUnicodeCMapFlateBytes,
  encodeText("\nendstream\nendobj\n"),
]);
const toUnicodeUnsupportedStreamObject = joinBytes([
  encodeText(`<< /Length ${String(unsupportedToUnicodeBytes.byteLength)} /Filter /ASCII85Decode >>\nstream\n`),
  unsupportedToUnicodeBytes,
  encodeText("\nendstream\nendobj\n"),
]);
const toUnicodeMalformedStreamObject = joinBytes([
  encodeText(`<< /Length ${String(malformedToUnicodeBytes.byteLength)} /Filter /FlateDecode >>\nstream\n`),
  malformedToUnicodeBytes,
  encodeText("\nendstream\nendobj\n"),
]);
const objectStreamMembers = buildObjectStreamMembers([
  {
    objectNumber: 3,
    text: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>\n",
  },
  {
    objectNumber: 4,
    text: "<< /Type /Page /Parent 3 0 R /Contents 5 0 R >>\n",
  },
]);
const xrefStreamEntries = fromByteValues([
  0x00, 0x00, 0x00, 0xff,
  0x01, 0x00, 0x09, 0x00,
  0x01, 0x00, 0x2a, 0x00,
  0x01, 0x00, 0x4d, 0x00,
  0x01, 0x00, 0x70, 0x00,
]);

const startXrefOffset = syntheticPdfTemplate.indexOf("xref\n0 5");
assert(startXrefOffset >= 0, "Synthetic PDF did not contain an xref section.");
const encryptedStartXrefOffset = encryptedPdfTemplate.indexOf("xref\n0 6");
assert(encryptedStartXrefOffset >= 0, "Encrypted synthetic PDF did not contain an xref section.");
const nestedStartXrefOffset = nestedPageTreeTemplate.indexOf("xref\n0 8");
assert(nestedStartXrefOffset >= 0, "Nested page-tree PDF did not contain an xref section.");
const encodedTextStartXrefOffset = encodedTextPdfTemplate.indexOf("xref\n0 5");
assert(encodedTextStartXrefOffset >= 0, "Encoded-text PDF did not contain an xref section.");

const syntheticPdf = syntheticPdfTemplate.replace("__STARTXREF__", String(startXrefOffset));
const encryptedPdf = encryptedPdfTemplate.replace("__ENCRYPTED_STARTXREF__", String(encryptedStartXrefOffset));
const nestedPageTreePdf = nestedPageTreeTemplate.replace("__NESTED_STARTXREF__", String(nestedStartXrefOffset));
const encodedTextPdf = encodedTextPdfTemplate.replace("__ENCODED_TEXT_STARTXREF__", String(encodedTextStartXrefOffset));
const flateXrefOffset = encodeText(flatePdfPrefix).byteLength + flateStreamBytes.byteLength + encodeText(flatePdfMiddle).byteLength;
const flatePdfSuffix = [
  "xref",
  "0 5",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 5 >>",
  "startxref",
  String(flateXrefOffset),
  "%%EOF",
  "",
].join("\n");
const flatePdfBytes = joinBytes([
  encodeText(flatePdfPrefix),
  flateStreamBytes,
  encodeText(flatePdfMiddle),
  encodeText(flatePdfSuffix),
]);
const indirectLengthFlateXrefOffset =
  encodeText(indirectLengthFlatePdfPrefix).byteLength +
  flateStreamBytes.byteLength +
  encodeText(indirectLengthFlatePdfMiddle).byteLength +
  encodeText(indirectLengthFlatePdfLengthObject).byteLength;
const indirectLengthFlatePdfSuffix = [
  "xref",
  "0 6",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 6 >>",
  "startxref",
  String(indirectLengthFlateXrefOffset),
  "%%EOF",
  "",
].join("\n");
const indirectLengthFlatePdfBytes = joinBytes([
  encodeText(indirectLengthFlatePdfPrefix),
  flateStreamBytes,
  encodeText(indirectLengthFlatePdfMiddle),
  encodeText(indirectLengthFlatePdfLengthObject),
  encodeText(indirectLengthFlatePdfSuffix),
]);
const inheritedResourceStreamText = "BT\n(Inherited Resources) Tj\nET";
const inheritedResourcePdfPrefix = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources 5 0 R >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
  "endobj",
  "4 0 obj",
  `<< /Length ${String(encodeText(inheritedResourceStreamText).byteLength)} >>`,
  "stream",
].join("\n") + "\n";
const inheritedResourcePdfMiddle = `\n${inheritedResourceStreamText}\nendstream\nendobj\n`;
const inheritedResourcePdfResourcesObject = [
  "5 0 obj",
  "<< /ProcSet [/PDF /Text] >>",
  "endobj",
  "",
].join("\n");
const inheritedResourceXrefOffset =
  encodeText(inheritedResourcePdfPrefix).byteLength +
  encodeText(inheritedResourcePdfMiddle).byteLength +
  encodeText(inheritedResourcePdfResourcesObject).byteLength;
const inheritedResourcePdfSuffix = [
  "xref",
  "0 6",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 6 >>",
  "startxref",
  String(inheritedResourceXrefOffset),
  "%%EOF",
  "",
].join("\n");
const inheritedResourcePdfBytes = joinBytes([
  encodeText(inheritedResourcePdfPrefix),
  encodeText(inheritedResourcePdfMiddle),
  encodeText(inheritedResourcePdfResourcesObject),
  encodeText(inheritedResourcePdfSuffix),
]);
const toUnicodeFlatePdfBytes = buildPdfWithFontResourceStream({
  contentStreamText: "BT\n/F1 12 Tf\n<48656C6C6F21> Tj\nET",
  fontDictionaryLines: [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>",
  ],
  resourceStreamObject: toUnicodeFlateStreamObject,
});
const toUnicodeUnsupportedPdfBytes = buildPdfWithFontResourceStream({
  contentStreamText: "BT\n/F1 12 Tf\n<48656C6C6F21> Tj\nET",
  fontDictionaryLines: [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>",
  ],
  resourceStreamObject: toUnicodeUnsupportedStreamObject,
});
const toUnicodeMalformedPdfBytes = buildPdfWithFontResourceStream({
  contentStreamText: "BT\n/F1 12 Tf\n<48656C6C6F21> Tj\nET",
  fontDictionaryLines: [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>",
  ],
  resourceStreamObject: toUnicodeMalformedStreamObject,
});
const objectStreamContentText = "BT\n(Object Stream) Tj\nET";
const objectStreamPdfPrefix = [
  "%PDF-1.5",
  "1 0 obj",
  "<< /Type /Catalog /Pages 3 0 R >>",
  "endobj",
  "2 0 obj",
  `<< /Type /ObjStm /N 2 /First ${String(objectStreamMembers.firstOffset)} /Length ${String(objectStreamMembers.bytes.byteLength)} >>`,
  "stream",
].join("\n") + "\n";
const objectStreamPdfMiddle = "\nendstream\nendobj\n";
const objectStreamContentsObject = [
  "5 0 obj",
  `<< /Length ${String(encodeText(objectStreamContentText).byteLength)} >>`,
  "stream",
  objectStreamContentText,
  "endstream",
  "endobj",
  "",
].join("\n");
const objectStreamXrefOffset =
  encodeText(objectStreamPdfPrefix).byteLength +
  objectStreamMembers.bytes.byteLength +
  encodeText(objectStreamPdfMiddle).byteLength +
  encodeText(objectStreamContentsObject).byteLength;
const objectStreamPdfSuffix = [
  "xref",
  "0 6",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 6 >>",
  "startxref",
  String(objectStreamXrefOffset),
  "%%EOF",
  "",
].join("\n");
const objectStreamPdfBytes = joinBytes([
  encodeText(objectStreamPdfPrefix),
  objectStreamMembers.bytes,
  encodeText(objectStreamPdfMiddle),
  encodeText(objectStreamContentsObject),
  encodeText(objectStreamPdfSuffix),
]);
const xrefStreamContentText = "BT\n(XRef Stream) Tj\nET";
const xrefStreamPdfPrefix = [
  "%PDF-1.5",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
  "endobj",
  "4 0 obj",
  `<< /Length ${String(encodeText(xrefStreamContentText).byteLength)} >>`,
  "stream",
  xrefStreamContentText,
  "endstream",
  "endobj",
  "5 0 obj",
  `<< /Type /XRef /Root 1 0 R /Size 5 /W [1 2 1] /Index [0 5] /Length ${String(xrefStreamEntries.byteLength)} >>`,
  "stream",
].join("\n") + "\n";
const xrefStreamXrefOffset = encodeText(xrefStreamPdfPrefix).byteLength;
const xrefStreamPdfSuffix = [
  "endstream",
  "endobj",
  "startxref",
  String(xrefStreamXrefOffset),
  "%%EOF",
  "",
].join("\n");
const xrefStreamPdfBytes = joinBytes([
  encodeText(xrefStreamPdfPrefix),
  xrefStreamEntries,
  encodeText(`\n${xrefStreamPdfSuffix}`),
]);
const malformedPdf = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "endobj",
  "3 0 obj",
  "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
  "endobj",
  "4 0 obj",
  "<< /Length 15 >>",
  "stream",
  "(Recovered) Tj",
  "endstream",
  "endobj",
  "",
].join("\n");

const engine = moduleNamespace.createPdfEngine();
assert(typeof engine.dispose === "function", "Engine does not expose dispose().");
const result = await engine.run({
  source: {
    bytes: encodeText(syntheticPdf),
    fileName: "synthetic.pdf",
    mediaType: "application/pdf",
  },
});
const flateResult = await engine.run({
  source: {
    bytes: flatePdfBytes,
    fileName: "flate.pdf",
    mediaType: "application/pdf",
  },
});
const indirectLengthFlateResult = await engine.run({
  source: {
    bytes: indirectLengthFlatePdfBytes,
    fileName: "flate-indirect-length.pdf",
    mediaType: "application/pdf",
  },
});
const inheritedResourceResult = await engine.run({
  source: {
    bytes: inheritedResourcePdfBytes,
    fileName: "inherited-resources.pdf",
    mediaType: "application/pdf",
  },
});
const encodedTextResult = await engine.run({
  source: {
    bytes: encodeText(encodedTextPdf),
    fileName: "encoded-text.pdf",
    mediaType: "application/pdf",
  },
});
const toUnicodeFlateResult = await engine.run({
  source: {
    bytes: toUnicodeFlatePdfBytes,
    fileName: "tounicode-flate.pdf",
    mediaType: "application/pdf",
  },
});
const toUnicodeUnsupportedResult = await engine.run({
  source: {
    bytes: toUnicodeUnsupportedPdfBytes,
    fileName: "tounicode-unsupported.pdf",
    mediaType: "application/pdf",
  },
});
const toUnicodeMalformedResult = await engine.run({
  source: {
    bytes: toUnicodeMalformedPdfBytes,
    fileName: "tounicode-malformed.pdf",
    mediaType: "application/pdf",
  },
});
const objectStreamResult = await engine.run({
  source: {
    bytes: objectStreamPdfBytes,
    fileName: "object-stream.pdf",
    mediaType: "application/pdf",
  },
});
const xrefStreamResult = await engine.run({
  source: {
    bytes: xrefStreamPdfBytes,
    fileName: "xref-stream.pdf",
    mediaType: "application/pdf",
  },
});
const recoveredResult = await engine.run({
  source: {
    bytes: encodeText(malformedPdf),
    fileName: "recovered.pdf",
    mediaType: "application/pdf",
  },
});
const blockedRecoveryResult = await engine.run({
  source: {
    bytes: encodeText(malformedPdf),
    fileName: "recovered.pdf",
    mediaType: "application/pdf",
  },
  policy: {
    repairMode: "never",
  },
});
const nestedPageTreeResult = await engine.run({
  source: {
    bytes: encodeText(nestedPageTreePdf),
    fileName: "nested-page-tree.pdf",
    mediaType: "application/pdf",
  },
});
const layoutResult = await engine.run({
  source: {
    bytes: encodeText(layoutPdf),
    fileName: "layout.pdf",
    mediaType: "application/pdf",
  },
});
const repeatedBoundaryResult = await engine.toLayout({
  source: {
    bytes: encodeText(repeatedBoundaryPdf),
    fileName: "repeated-boundary.pdf",
    mediaType: "application/pdf",
  },
});
const repeatedBoundaryKnowledgeResult = await engine.toKnowledge({
  source: {
    bytes: encodeText(repeatedBoundaryPdf),
    fileName: "repeated-boundary.pdf",
    mediaType: "application/pdf",
  },
});
const observationWithoutPassword = await engine.observe({
  source: {
    bytes: encodeText(encryptedPdf),
    fileName: "encrypted.pdf",
    mediaType: "application/pdf",
  },
});
const observationWithPassword = await engine.observe({
  source: {
    bytes: encodeText(encryptedPdf),
    fileName: "encrypted.pdf",
    mediaType: "application/pdf",
  },
  passwordProvider: () => "secret",
});

assert(result.runtime.kind === expectedRuntime, `Expected runtime ${expectedRuntime} but received ${result.runtime.kind}.`);
assert(engine.identity.supportedRuntimes.includes(expectedRuntime), `Engine identity does not claim support for runtime ${expectedRuntime}.`);
assert(engine.identity.supportedStages.includes("admission"), "Engine identity does not claim admission support.");
assert(engine.identity.supportedStages.includes("ir"), "Engine identity does not claim IR support.");
assert(engine.identity.supportedStages.includes("observation"), "Engine identity does not claim observation support.");
assert(engine.identity.supportedStages.includes("layout"), "Engine identity does not claim layout support.");
assert(engine.identity.supportedStages.includes("knowledge"), "Engine identity does not claim knowledge support.");
assert(result.admission.status === "completed", `Admission status was ${result.admission.status}.`);
assert(result.ir.status === "completed", `IR status was ${result.ir.status}.`);
assert(result.observation.status === "completed", `Observation status was ${result.observation.status}.`);
assert(result.admission.value?.repairState === "clean", `Repair state was ${result.admission.value?.repairState ?? "missing"}.`);
assert((result.admission.value?.knownLimits.length ?? 0) === 0, "Admission known limits should be empty for the clean synthetic document.");
assert(result.admission.value?.parseCoverage.startXref === true, "The shell did not recover startxref coverage.");
assert(result.admission.value?.parseCoverage.trailer === true, "The shell did not recover trailer coverage.");
assert(result.ir.value?.indirectObjects.length === 4, `Unexpected indirect-object count: ${result.ir.value?.indirectObjects.length ?? 0}.`);
assert(result.ir.value?.decodedStreams === true, "IR did not mark operator-ready streams as available.");
assert(result.ir.value?.resolvedInheritedPageState === true, "IR did not preserve inherited page resolution.");
assert(result.ir.value?.trailer?.rootRef?.objectNumber === 1, "Trailer root ref was not recovered.");
assert(result.ir.value?.pages[0]?.pageRef?.objectNumber === 3, "Page object ref was not recovered.");
assert(result.ir.value?.pages[0]?.contentStreamRefs[0]?.objectNumber === 4, "Content stream ref was not recovered.");
assert(result.ir.value?.pages[0]?.resolutionMethod === "page-tree", "IR page resolution method was not preserved.");
assert(result.ir.value?.indirectObjects[3]?.streamDecodeState === "available", "Unfiltered stream was not marked as available.");
assert(result.observation.value?.pages[0]?.pageRef?.objectNumber === 3, "Observation page ref was not preserved.");
assert(result.observation.value?.pages[0]?.resolutionMethod === "page-tree", "Observation page resolution method was not preserved.");
assert(result.observation.value?.pages[0]?.runs[0]?.contentStreamRef?.objectNumber === 4, "Observation run content stream ref was not preserved.");
assert(result.observation.value?.pages[0]?.runs[0]?.objectRef?.objectNumber === 4, "Observation run object ref was not preserved.");
assert(result.observation.value?.pages[0]?.runs[0]?.origin === "native-text", "Observation run origin was not updated.");
assert(result.observation.value?.pages[0]?.glyphs[0]?.contentStreamRef?.objectNumber === 4, "Observation glyph content stream ref was not preserved.");
assert(result.observation.value?.pages[0]?.glyphs[0]?.origin === "native-text", "Observation glyph origin was not updated.");
assert(result.observation.value?.strategy === "decoded-text-operators", "Observation strategy was not updated.");
assert(
  result.observation.value?.knownLimits.includes("text-decoding-heuristic"),
  "Observation known limits did not include text-decoding-heuristic.",
);
assert(
  result.observation.value?.extractedText === "Hello PDF Engine",
  `Unexpected extracted text: ${JSON.stringify(result.observation.value?.extractedText ?? null)}.`,
);
assert(layoutResult.layout.status === "partial", `Layout status was ${layoutResult.layout.status}.`);
assert(layoutResult.layout.value?.strategy === "line-blocks", "Layout strategy was not preserved.");
assert(
  layoutResult.observation.value?.pages[0]?.runs[0]?.anchor?.x === 72 && layoutResult.observation.value?.pages[0]?.runs[0]?.anchor?.y === 720,
  `Layout observation anchor was ${JSON.stringify(layoutResult.observation.value?.pages[0]?.runs[0]?.anchor ?? null)}.`,
);
assert(
  layoutResult.observation.value?.pages[0]?.runs[0]?.fontSize === 18,
  `Layout observation font size was ${String(layoutResult.observation.value?.pages[0]?.runs[0]?.fontSize ?? "missing")}.`,
);
assert(
  layoutResult.layout.value?.pages[0]?.blocks[0]?.role === "heading",
  `Layout heading role was ${layoutResult.layout.value?.pages[0]?.blocks[0]?.role ?? "missing"}.`,
);
assert(
  layoutResult.layout.value?.pages[0]?.blocks[1]?.role === "body",
  `Layout body role was ${layoutResult.layout.value?.pages[0]?.blocks[1]?.role ?? "missing"}.`,
);
assert(
  layoutResult.layout.value?.pages[0]?.blocks[2]?.role === "list",
  `Layout list role was ${layoutResult.layout.value?.pages[0]?.blocks[2]?.role ?? "missing"}.`,
);
assert(
  layoutResult.layout.value?.knownLimits.includes("layout-reading-order-heuristic"),
  "Layout known limits did not include layout-reading-order-heuristic.",
);
assert(layoutResult.knowledge.status === "partial", `Knowledge status was ${layoutResult.knowledge.status}.`);
assert(layoutResult.knowledge.value?.strategy === "layout-chunks", "Knowledge strategy was not preserved.");
assert(
  layoutResult.knowledge.value?.chunks[0]?.citations[0]?.blockId === layoutResult.layout.value?.pages[0]?.blocks[0]?.id,
  "Knowledge citations did not preserve the source block id.",
);
assert(
  layoutResult.knowledge.value?.tables.length === 0,
  `Knowledge stage emitted ${String(layoutResult.knowledge.value?.tables.length ?? "missing")} tables for the synthetic layout case.`,
);
assert(
  layoutResult.knowledge.value?.knownLimits.includes("table-projection-not-implemented"),
  "Knowledge known limits did not include table-projection-not-implemented.",
);
assert(repeatedBoundaryResult.status === "partial", `Repeated-boundary layout status was ${repeatedBoundaryResult.status}.`);
assert(
  repeatedBoundaryResult.value?.pages[0]?.blocks[0]?.role === "header" &&
    repeatedBoundaryResult.value?.pages[1]?.blocks[0]?.role === "header",
  "Repeated header text was not classified as header on both pages.",
);
assert(
  repeatedBoundaryResult.value?.pages[0]?.blocks.at(-1)?.role === "footer" &&
    repeatedBoundaryResult.value?.pages[1]?.blocks.at(-1)?.role === "footer",
  "Repeated footer text was not classified as footer on both pages.",
);
assert(repeatedBoundaryKnowledgeResult.status === "partial", `Repeated-boundary knowledge status was ${repeatedBoundaryKnowledgeResult.status}.`);
assert(
  !repeatedBoundaryKnowledgeResult.value?.extractedText.includes("Quarterly Report"),
  "Repeated-boundary knowledge output still included the repeated header text.",
);
assert(
  !repeatedBoundaryKnowledgeResult.value?.extractedText.includes("Confidential"),
  "Repeated-boundary knowledge output still included the repeated footer text.",
);
assert(flateResult.ir.value?.decodedStreams === true, "Flate stream did not mark decodedStreams.");
assert(flateResult.ir.value?.indirectObjects[3]?.streamDecodeState === "decoded", "Flate stream was not marked as decoded.");
assert(
  flateResult.ir.value?.indirectObjects[3]?.streamFilterNames?.join(",") === "FlateDecode",
  `Unexpected flate stream filters: ${flateResult.ir.value?.indirectObjects[3]?.streamFilterNames?.join(",") ?? "missing"}.`,
);
assert(
  !flateResult.ir.value?.knownLimits.includes("streams-not-decoded"),
  "Flate IR still reported streams-not-decoded.",
);
assert(
  flateResult.observation.value?.extractedText === "Hello Flate",
  `Unexpected flate extracted text: ${JSON.stringify(flateResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  indirectLengthFlateResult.ir.value?.indirectObjects[3]?.streamDecodeState === "decoded",
  "Indirect-length flate stream was not marked as decoded.",
);
assert(
  !indirectLengthFlateResult.ir.value?.knownLimits.includes("stream-decoding-failed"),
  "Indirect-length flate stream still reported stream-decoding-failed.",
);
assert(
  indirectLengthFlateResult.observation.value?.extractedText === "Hello Flate",
  `Unexpected indirect-length flate extracted text: ${JSON.stringify(indirectLengthFlateResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  inheritedResourceResult.ir.value?.resolvedInheritedPageState === true,
  "Inherited page state was not marked as resolved.",
);
assert(
  inheritedResourceResult.ir.value?.pages[0]?.resourceOrigin === "inherited",
  `Unexpected inherited resource origin: ${inheritedResourceResult.ir.value?.pages[0]?.resourceOrigin ?? "missing"}.`,
);
assert(
  inheritedResourceResult.ir.value?.pages[0]?.resourceRef?.objectNumber === 5,
  "Inherited resource reference was not preserved.",
);
assert(
  !inheritedResourceResult.ir.value?.knownLimits.includes("resource-inheritance-unresolved"),
  "Inherited resource resolution still reported resource-inheritance-unresolved.",
);
assert(
  inheritedResourceResult.observation.value?.extractedText === "Inherited Resources",
  `Unexpected inherited resource extracted text: ${JSON.stringify(inheritedResourceResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  toUnicodeFlateResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamRole === "tounicode",
  `ToUnicode flate stream role was ${toUnicodeFlateResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamRole ?? "missing"}.`,
);
assert(
  toUnicodeFlateResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamDecodeState === "decoded",
  `ToUnicode flate stream decode state was ${toUnicodeFlateResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamDecodeState ?? "missing"}.`,
);
assert(
  !toUnicodeFlateResult.ir.value?.knownLimits.includes("stream-decoding-failed"),
  "ToUnicode flate stream still reported stream-decoding-failed.",
);
assert(
  toUnicodeFlateResult.observation.status === "completed",
  `ToUnicode flate observation status was ${toUnicodeFlateResult.observation.status}.`,
);
assert(
  toUnicodeFlateResult.observation.value?.extractedText === "Hello!",
  `Unexpected ToUnicode flate extracted text: ${JSON.stringify(toUnicodeFlateResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  !toUnicodeFlateResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
  "ToUnicode flate observation still reported font-unicode-mapping-not-implemented.",
);
assert(
  toUnicodeFlateResult.observation.value?.pages[0]?.runs[0]?.fontRef?.objectNumber === 5,
  "ToUnicode flate observation did not preserve the active font reference.",
);
assert(
  toUnicodeFlateResult.observation.value?.pages[0]?.runs[0]?.textEncodingKind === "hex",
  `ToUnicode flate observation text encoding kind was ${toUnicodeFlateResult.observation.value?.pages[0]?.runs[0]?.textEncodingKind ?? "missing"}.`,
);
assert(
  toUnicodeUnsupportedResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamRole === "tounicode",
  "Unsupported ToUnicode stream role was not classified as tounicode.",
);
assert(
  toUnicodeUnsupportedResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamDecodeState === "unsupported-filter",
  `Unsupported ToUnicode stream decode state was ${toUnicodeUnsupportedResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamDecodeState ?? "missing"}.`,
);
assert(
  toUnicodeUnsupportedResult.ir.diagnostics.some((diagnostic) => diagnostic.code === "stream-filter-unsupported"),
  "Unsupported ToUnicode stream did not surface stream-filter-unsupported.",
);
assert(
  toUnicodeMalformedResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamRole === "tounicode",
  "Malformed ToUnicode stream role was not classified as tounicode.",
);
assert(
  toUnicodeMalformedResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamDecodeState === "failed",
  `Malformed ToUnicode stream decode state was ${toUnicodeMalformedResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamDecodeState ?? "missing"}.`,
);
assert(
  toUnicodeMalformedResult.ir.diagnostics.some((diagnostic) => diagnostic.code === "stream-decoding-failed"),
  "Malformed ToUnicode stream did not surface stream-decoding-failed.",
);
assert(objectStreamResult.ir.value?.expandedObjectStreams === true, "Object stream expansion was not marked as enabled.");
assert(
  !objectStreamResult.ir.value?.knownLimits.includes("object-streams-not-expanded"),
  "Object stream IR still reported object-streams-not-expanded.",
);
assert(
  objectStreamResult.ir.value?.indirectObjects.some((objectShell) => objectShell.ref.objectNumber === 4 && objectShell.containerObjectRef?.objectNumber === 2),
  "Object stream member object was not expanded with container provenance.",
);
assert(
  objectStreamResult.observation.value?.extractedText === "Object Stream",
  `Unexpected object-stream extracted text: ${JSON.stringify(objectStreamResult.observation.value?.extractedText ?? null)}.`,
);
assert(xrefStreamResult.ir.value?.decodedXrefStreamEntries === true, "XRef stream entries were not marked as decoded.");
assert(
  !xrefStreamResult.ir.value?.knownLimits.includes("xref-stream-entries-not-decoded"),
  "XRef stream IR still reported xref-stream-entries-not-decoded.",
);
assert(
  xrefStreamResult.ir.value?.crossReferenceSections.find((section) => section.kind === "xref-stream")?.decodedEntryCount === 5,
  `Unexpected decoded xref entry count: ${xrefStreamResult.ir.value?.crossReferenceSections.find((section) => section.kind === "xref-stream")?.decodedEntryCount ?? "missing"}.`,
);
assert(
  xrefStreamResult.observation.value?.extractedText === "XRef Stream",
  `Unexpected xref-stream extracted text: ${JSON.stringify(xrefStreamResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  encodedTextResult.observation.status === "partial",
  `Encoded-text observation status was ${encodedTextResult.observation.status}.`,
);
assert(
  encodedTextResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
  "Encoded-text observation did not report font-unicode-mapping-not-implemented.",
);
assert(
  encodedTextResult.observation.diagnostics.some((diagnostic) => diagnostic.code === "font-unicode-mapping-not-implemented"),
  "Encoded-text observation did not surface font-unicode-mapping-not-implemented.",
);
assert(recoveredResult.admission.status === "partial", `Recovered admission status was ${recoveredResult.admission.status}.`);
assert(recoveredResult.admission.value?.decision === "accepted", `Recovered decision was ${recoveredResult.admission.value?.decision ?? "missing"}.`);
assert(recoveredResult.admission.value?.repairState === "recovered", `Recovered repair state was ${recoveredResult.admission.value?.repairState ?? "missing"}.`);
assert(recoveredResult.ir.value?.pages[0]?.resolutionMethod === "recovered-page-order", "Recovered IR page resolution method was not preserved.");
assert(recoveredResult.observation.value?.pages[0]?.resolutionMethod === "recovered-page-order", "Recovered observation page resolution method was not preserved.");
assert(
  recoveredResult.observation.value?.knownLimits.includes("page-order-heuristic"),
  "Recovered observation known limits did not include page-order-heuristic.",
);
assert(recoveredResult.observation.value?.extractedText === "Recovered", "Recovered observation text was not preserved.");
assert(
  nestedPageTreeResult.ir.value?.pages.map((page) => page.pageRef?.objectNumber).join(",") === "4,5",
  `Nested page-tree IR order was ${nestedPageTreeResult.ir.value?.pages.map((page) => page.pageRef?.objectNumber).join(",") ?? "missing"}.`,
);
assert(
  nestedPageTreeResult.observation.value?.pages.flatMap((page) => page.runs.map((run) => run.text)).join(",") === "First,Second",
  `Nested page-tree observation order was ${nestedPageTreeResult.observation.value?.pages.flatMap((page) => page.runs.map((run) => run.text)).join(",") ?? "missing"}.`,
);
assert(
  blockedRecoveryResult.admission.status === "blocked",
  `Repair-blocked admission status was ${blockedRecoveryResult.admission.status}.`,
);
assert(
  blockedRecoveryResult.admission.value?.decision === "unsupported",
  `Repair-blocked decision was ${blockedRecoveryResult.admission.value?.decision ?? "missing"}.`,
);
assert(observationWithoutPassword.status === "blocked", `Encrypted observe status without password was ${observationWithoutPassword.status}.`);
assert(
  observationWithoutPassword.diagnostics.some((diagnostic) => diagnostic.code === "password-required"),
  "Encrypted observe without password did not surface password-required.",
);
assert(observationWithPassword.status === "blocked", `Encrypted observe status with password was ${observationWithPassword.status}.`);
assert(
  observationWithPassword.diagnostics.some((diagnostic) => diagnostic.code === "decryption-not-implemented"),
  "Encrypted observe with password did not surface decryption-not-implemented.",
);
await engine.dispose();

console.log(
  JSON.stringify(
    {
      runtime: result.runtime.kind,
      admission: result.admission.status,
      supportedRuntimes: engine.identity.supportedRuntimes,
      repairState: result.admission.value?.repairState ?? null,
      flateDecodedStreams: flateResult.ir.value?.decodedStreams ?? null,
      recoveredAdmission: recoveredResult.admission.status,
      recoveredRepairState: recoveredResult.admission.value?.repairState ?? null,
      ir: result.ir.status,
      observation: result.observation.status,
      observationStrategy: result.observation.value?.strategy ?? null,
      layout: result.layout.status,
      layoutStrategy: result.layout.value?.strategy ?? null,
      knowledge: result.knowledge.status,
      knowledgeStrategy: result.knowledge.value?.strategy ?? null,
      knowledgeChunkCount: result.knowledge.value?.chunks.length ?? null,
      text: result.observation.value?.extractedText ?? null,
    },
    null,
    2,
  ),
);
