import { decodeFixturePdfBytes, publicSmokeFixtures } from "./fixture-data.mjs";

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

function findBlockRole(blocks, text) {
  return blocks.find((block) => block.text === text)?.role;
}

function hasUnreadableControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint >= 0x00 && codePoint <= 0x08) || (codePoint >= 0x0b && codePoint <= 0x1f)) {
      return true;
    }
  }

  return false;
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

function decodeHex(value) {
  assert(value.length % 2 === 0, "Hex fixture text must contain an even number of digits.");
  const decoded = new Uint8Array(value.length / 2);

  for (let index = 0; index < value.length; index += 2) {
    const byteText = value.slice(index, index + 2);
    const byteValue = Number.parseInt(byteText, 16);
    assert(Number.isInteger(byteValue), `Invalid hex fixture byte: ${byteText}.`);
    decoded[index / 2] = byteValue;
  }

  return decoded;
}

async function readSmokeAssetText(assetUrl) {
  if (typeof Deno !== "undefined") {
    return await Deno.readTextFile(assetUrl);
  }

  if (typeof Bun !== "undefined") {
    return await Bun.file(assetUrl).text();
  }

  if (typeof process !== "undefined") {
    const { readFile } = await import("node:fs/promises");
    return await readFile(assetUrl, "utf8");
  }

  throw new Error("Unable to read smoke assets in the current runtime.");
}

async function readSmokeAssetBytes(assetUrl) {
  if (typeof Deno !== "undefined") {
    return await Deno.readFile(assetUrl);
  }

  if (typeof Bun !== "undefined") {
    return new Uint8Array(await Bun.file(assetUrl).arrayBuffer());
  }

  if (typeof process !== "undefined") {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(assetUrl));
  }

  throw new Error("Unable to read smoke assets in the current runtime.");
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

function buildImageXObjectPdf() {
  const contentStreamText = [
    "q",
    "64 0 0 32 72 680 cm",
    "/Im1 Do",
    "Q",
  ].join("\n");
  const imageStreamText = "AA";
  const template = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    "endobj",
    "4 0 obj",
    `<< /Length ${String(encodeText(contentStreamText).byteLength)} >>`,
    "stream",
    contentStreamText,
    "endstream",
    "endobj",
    "5 0 obj",
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${String(encodeText(imageStreamText).byteLength)} >>`,
    "stream",
    imageStreamText,
    "endstream",
    "endobj",
    "xref",
    "0 6",
    "0000000000 65535 f",
    "trailer",
    "<< /Root 1 0 R /Size 6 >>",
    "startxref",
    "__IMAGE_XOBJECT_STARTXREF__",
    "%%EOF",
    "",
  ].join("\n");
  const startXrefOffset = template.indexOf("\nxref\n0 6") + 1;
  assert(startXrefOffset > 0, "Image XObject synthetic PDF did not contain an xref section.");
  return encodeText(template.replace("__IMAGE_XOBJECT_STARTXREF__", String(startXrefOffset)));
}

function buildHiddenOptionalContentPdf() {
  const contentStreamText = [
    "BT",
    "/OC /MC1 BDC",
    "(Hidden Layer) Tj",
    "EMC",
    "ET",
  ].join("\n");
  const template = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] /D << /BaseState /ON /OFF [5 0 R] >> >> >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /Resources << /Properties << /MC1 5 0 R >> >> /Contents 4 0 R >>",
    "endobj",
    "4 0 obj",
    `<< /Length ${String(encodeText(contentStreamText).byteLength)} >>`,
    "stream",
    contentStreamText,
    "endstream",
    "endobj",
    "5 0 obj",
    "<< /Type /OCG /Name (Hidden Layer) >>",
    "endobj",
    "xref",
    "0 6",
    "0000000000 65535 f",
    "trailer",
    "<< /Root 1 0 R /Size 6 >>",
    "startxref",
    "__HIDDEN_OC_STARTXREF__",
    "%%EOF",
    "",
  ].join("\n");
  const startXrefOffset = template.indexOf("\nxref\n0 6") + 1;
  assert(startXrefOffset > 0, "Hidden optional-content synthetic PDF did not contain an xref section.");
  return encodeText(template.replace("__HIDDEN_OC_STARTXREF__", String(startXrefOffset)));
}

function buildFilteredContentStreamPdfBytes({ streamBytes, filterValue, decodeParamsValue }) {
  const prefix = [
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
    `<< /Length ${String(streamBytes.byteLength)} /Filter ${filterValue}${typeof decodeParamsValue === "string" ? ` /DecodeParms ${decodeParamsValue}` : ""} >>`,
    "stream",
  ].join("\n") + "\n";
  const middle = "\nendstream\nendobj\n";
  const xrefOffset = encodeText(prefix).byteLength + streamBytes.byteLength + encodeText(middle).byteLength;
  const suffix = [
    "xref",
    "0 5",
    "0000000000 65535 f",
    "trailer",
    "<< /Root 1 0 R /Size 5 >>",
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");

  return joinBytes([encodeText(prefix), streamBytes, encodeText(middle), encodeText(suffix)]);
}

function buildVerticalWordColumnsPdf() {
  return buildPdfWithPageContents([
    [
      "BT",
      "1 0 0 1 90.264 697.18 Tm",
      "(Test) Tj",
      "1 0 0 1 117.74 681.82 Tm",
      "(Vertical) Tj",
      "1 0 0 1 145.34 685.9 Tm",
      "(Layout) Tj",
      "ET",
    ].join("\n"),
  ]);
}

function buildDelayedContentPdf() {
  const delayedContentStreamText = [
    "BT",
    "(Delayed Content) Tj",
    "ET",
  ].join("\n");
  const fillerText = "% filler block to force full structure recovery\n".repeat(34_000);
  const template = [
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
    fillerText,
    "4 0 obj",
    `<< /Length ${String(encodeText(delayedContentStreamText).byteLength)} >>`,
    "stream",
    delayedContentStreamText,
    "endstream",
    "endobj",
    "xref",
    "0 5",
    "0000000000 65535 f",
    "trailer",
    "<< /Root 1 0 R /Size 5 >>",
    "startxref",
    "__DELAYED_STARTXREF__",
    "%%EOF",
    "",
  ].join("\n");
  const startXrefOffset = template.indexOf("\nxref\n0 5") + 1;
  assert(startXrefOffset > 0, "Delayed-content synthetic PDF did not contain an xref section.");
  return encodeText(template.replace("__DELAYED_STARTXREF__", String(startXrefOffset)));
}

function buildJavascriptActionPdf() {
  const contentStreamText = [
    "BT",
    "(Policy Check) Tj",
    "ET",
  ].join("\n");
  const template = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    "endobj",
    "4 0 obj",
    `<< /Length ${String(encodeText(contentStreamText).byteLength)} >>`,
    "stream",
    contentStreamText,
    "endstream",
    "endobj",
    "5 0 obj",
    "<< /S /JavaScript /JS (app.alert('blocked')) >>",
    "endobj",
    "xref",
    "0 6",
    "0000000000 65535 f",
    "trailer",
    "<< /Root 1 0 R /Size 6 >>",
    "startxref",
    "__JAVASCRIPT_STARTXREF__",
    "%%EOF",
    "",
  ].join("\n");
  const startXrefOffset = template.indexOf("\nxref\n0 6") + 1;
  assert(startXrefOffset > 0, "JavaScript-policy synthetic PDF did not contain an xref section.");
  return encodeText(template.replace("__JAVASCRIPT_STARTXREF__", String(startXrefOffset)));
}

function buildLargeBenignJavascriptCommentPdf() {
  const delayedContentStreamText = [
    "BT",
    "(Large comment safe) Tj",
    "ET",
  ].join("\n");
  const fillerText = "% filler /JS comment to test parser authority without an action object\n".repeat(36_000);
  const header = "%PDF-1.4\n";
  const objectTexts = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${String(encodeText(delayedContentStreamText).byteLength)} >>\nstream\n${delayedContentStreamText}\nendstream\nendobj\n`,
  ];
  let offset = encodeText(header).byteLength;
  const xrefEntries = ["0000000000 65535 f "];
  for (const [objectIndex, objectText] of objectTexts.entries()) {
    if (objectIndex === objectTexts.length - 1) {
      offset += encodeText(fillerText).byteLength;
    }
    xrefEntries.push(`${String(offset).padStart(10, "0")} 00000 n `);
    offset += encodeText(objectText).byteLength;
  }

  const xref = [
    "xref",
    "0 5",
    ...xrefEntries,
    "trailer",
    "<< /Root 1 0 R /Size 5 >>",
    "startxref",
    String(offset),
    "%%EOF",
    "",
  ].join("\n");

  return encodeText(`${header}${objectTexts.slice(0, -1).join("")}${fillerText}${objectTexts[objectTexts.length - 1]}${xref}`);
}

function buildStreamBoundaryPdf() {
  const contentStreamText = [
    "BT",
    "(endobj inside stream) Tj",
    "ET",
  ].join("\n");
  const template = [
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
    `<< /Length ${String(encodeText(contentStreamText).byteLength)} >>`,
    "stream",
    contentStreamText,
    "endstream",
    "endobj",
    "xref",
    "0 5",
    "0000000000 65535 f",
    "trailer",
    "<< /Root 1 0 R /Size 5 >>",
    "startxref",
    "__STREAM_BOUNDARY_STARTXREF__",
    "%%EOF",
    "",
  ].join("\n");
  const startXrefOffset = template.indexOf("\nxref\n0 5") + 1;
  assert(startXrefOffset > 0, "Stream-boundary synthetic PDF did not contain an xref section.");
  return encodeText(template.replace("__STREAM_BOUNDARY_STARTXREF__", String(startXrefOffset)));
}

function buildIncrementalUpdatePdf() {
  const contentStreamText = [
    "BT",
    "(First Revision) Tj",
    "ET",
  ].join("\n");
  const baseRevisionTemplate = [
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
    `<< /Length ${String(encodeText(contentStreamText).byteLength)} >>`,
    "stream",
    contentStreamText,
    "endstream",
    "endobj",
    "xref",
    "0 5",
    "0000000000 65535 f",
    "0000000000 00000 n",
    "0000000000 00000 n",
    "0000000000 00000 n",
    "0000000000 00000 n",
    "trailer",
    "<< /Root 1 0 R /Size 5 >>",
    "startxref",
    "__BASE_STARTXREF__",
    "%%EOF",
    "",
  ].join("\n");
  const baseXrefOffset = baseRevisionTemplate.indexOf("\nxref\n0 5") + 1;
  assert(baseXrefOffset > 0, "Incremental-update base revision did not contain an xref section.");
  const baseRevision = baseRevisionTemplate.replace("__BASE_STARTXREF__", String(baseXrefOffset));
  const incrementalRevisionTemplate = [
    "5 0 obj",
    "<< /Producer (Incremental Chain) >>",
    "endobj",
    "xref",
    "5 1",
    "0000000000 00000 n",
    "trailer",
    `<< /Root 1 0 R /Size 6 /Info 5 0 R /Prev ${String(baseXrefOffset)} >>`,
    "startxref",
    "__UPDATED_STARTXREF__",
    "%%EOF",
    "",
  ].join("\n");
  const incrementalXrefOffset = encodeText(baseRevision).byteLength + incrementalRevisionTemplate.indexOf("\nxref\n5 1") + 1;
  assert(incrementalXrefOffset > 0, "Incremental-update revision did not contain a second xref section.");
  const incrementalRevision = incrementalRevisionTemplate.replace(
    "__UPDATED_STARTXREF__",
    String(incrementalXrefOffset),
  );

  return {
    bytes: encodeText(`${baseRevision}${incrementalRevision}`),
    baseXrefOffset,
    incrementalXrefOffset,
  };
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
const viewerModuleSpecifier = resolveViewerModuleSpecifier(moduleSpecifier);
assert(typeof viewerModuleSpecifier === "string", "Module path does not support resolving the viewer entrypoint.");
const viewerModuleNamespace = await import(viewerModuleSpecifier);
assert(typeof viewerModuleNamespace.renderPdfViewer === "function", "Viewer module does not export renderPdfViewer().");
const streamDecodeModuleSpecifier = resolveSiblingModuleSpecifier(moduleSpecifier, "stream-decode");
assert(typeof streamDecodeModuleSpecifier === "string", "Module path does not support resolving the stream decoder entrypoint.");
const streamDecodeModuleNamespace = await import(streamDecodeModuleSpecifier);
assert(typeof streamDecodeModuleNamespace.decodePdfStreamBytes === "function", "Stream decoder module does not export decodePdfStreamBytes().");
const stackedHeaderTableFixtureBytes = decodeBase64(
  await readSmokeAssetText(new URL("./fixtures/stacked-header-table.base64.txt", import.meta.url)),
);
const fieldValueFormFixtureBytes = decodeBase64(
  await readSmokeAssetText(new URL("./fixtures/field-value-form.base64.txt", import.meta.url)),
);
const encryptedStandardTextFixture = publicSmokeFixtures.encryptedStandardText;
const encryptedStandardTextFixtureBytes = decodeFixturePdfBytes(encryptedStandardTextFixture.bytesBase64);
const encryptedStandardTextAes256Fixture = publicSmokeFixtures.encryptedStandardTextAes256;
const encryptedStandardTextAes256FixtureBytes = decodeFixturePdfBytes(
  encryptedStandardTextAes256Fixture.bytesBase64,
);

function resolveViewerModuleSpecifier(specifier) {
  return resolveSiblingModuleSpecifier(specifier, "viewer");
}

function resolveSiblingModuleSpecifier(specifier, fileStem) {
  if (specifier.endsWith("/index.js")) {
    return specifier.replace(/\/index\.js$/u, `/${fileStem}.js`);
  }
  if (specifier.endsWith("/jsr/mod.ts") && fileStem === "stream-decode") {
    return specifier.replace(/\/jsr\/mod\.ts$/u, "/src/stream-decode.ts");
  }
  if (specifier.endsWith("/mod.ts")) {
    return specifier.replace(/\/mod\.ts$/u, `/${fileStem}.ts`);
  }
  return undefined;
}

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

const verticalWordColumnsPdf = buildVerticalWordColumnsPdf();
const observedMarksPdf = buildPdfWithPageContents([
  [
    "0 0 50 20 re S",
    "BT",
    "(Marked Hello) Tj",
    "ET",
  ].join("\n"),
]);
const markedContentActualTextPdf = buildPdfWithPageContents([
  [
    "BT",
    "/Span << /ActualText (Tagged Hello) /MCID 7 >> BDC",
    "(Hello) Tj",
    "EMC",
    "ET",
  ].join("\n"),
]);
const delayedContentPdfBytes = buildDelayedContentPdf();
const imageXObjectPdfBytes = buildImageXObjectPdf();
const hiddenOptionalContentPdfBytes = buildHiddenOptionalContentPdf();
const javascriptActionPdfBytes = buildJavascriptActionPdf();
const largeBenignJavascriptCommentPdfBytes = buildLargeBenignJavascriptCommentPdf();
const streamBoundaryPdfBytes = buildStreamBoundaryPdf();
const incrementalUpdatePdf = buildIncrementalUpdatePdf();

const flateStreamBytes = decodeBase64("eJxzCuHS8EjNyclXcMtJLEnVVAjJ4nIN4QIAUIcGfQ==");
const asciiHexStreamBytes = encodeText("42540A2841534349494845582048656C6C6F2920546A0A4554>");
const ascii85StreamBytes = encodeText("6<\":?5uU-B8N8RM87cURD^cf.C'mC/~>");
const runLengthStreamBytes = decodeHex("1942540A2852756E4C656E6774682048656C6C6F2920546A0A455480");
const chainedFilterStreamBytes = encodeText("Garg^iR2\\j8Bf:N9i:CNc,n)Z<!^V*EX`$L=nDqT~>");
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
const paragraphPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    "(First paragraph line one) Tj",
    "0 -14 Td",
    "(line two) Tj",
    "0 -26 Td",
    "(Second paragraph starts here) Tj",
    "0 -14 Td",
    "(line four) Tj",
    "ET",
  ].join("\n"),
]);
const headingParagraphPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "72 720 Td",
    "(ABSTRACT) Tj",
    "0 -18 Td",
    "/F1 12 Tf",
    "(Dense retrieval starts here.) Tj",
    "ET",
  ].join("\n"),
]);
const numberedHeadingParagraphPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "72 720 Td",
    "(Introduction) Tj",
    "0 -18 Td",
    "/F1 12 Tf",
    "(1. This paragraph starts here.) Tj",
    "0 -14 Td",
    "(It continues onto the next line.) Tj",
    "ET",
  ].join("\n"),
]);
const compactLabelClusterPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Source:) Tj",
    "1 0 0 1 72 706 Tm",
    "(Person Of Impact) Tj",
    "1 0 0 1 72 692 Tm",
    "(Page 1 of 1) Tj",
    "1 0 0 1 72 660 Tm",
    "(First Name:) Tj",
    "1 0 0 1 72 646 Tm",
    "(Last Name:) Tj",
    "1 0 0 1 72 632 Tm",
    "(Country:) Tj",
    "1 0 0 1 220 660 Tm",
    "(Planet:) Tj",
    "1 0 0 1 220 646 Tm",
    "(Occupation:) Tj",
    "1 0 0 1 220 632 Tm",
    "(Date Of Birth:) Tj",
    "ET",
  ].join("\n"),
]);
const repeatedFormBoundaryPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Source:) Tj",
    "/F1 18 Tf",
    "1 0 0 1 72 700 Tm",
    "(Demo Form) Tj",
    "/F1 9 Tf",
    "1 0 0 1 72 684 Tm",
    "(Page 1 of 2) Tj",
    "1 0 0 1 72 668 Tm",
    "(pdfcpu: v0.4.0 dev Created: 2023-02-28 20:49 Optimized for A.Reader) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 638 Tm",
    "(City: Favorite city:) Tj",
    "1 0 0 1 72 620 Tm",
    "(First Name:) Tj",
    "1 0 0 1 220 620 Tm",
    "(Last Name:) Tj",
    "1 0 0 1 72 592 Tm",
    "(1) Please tell us about yourself:) Tj",
    "1 0 0 1 72 574 Tm",
    "(2) How did you hear about pdfcpu:) Tj",
    "1 0 0 1 72 96 Tm",
    "(female male non-binary Gender:) Tj",
    "ET",
  ].join("\n"),
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Source:) Tj",
    "/F1 18 Tf",
    "1 0 0 1 72 700 Tm",
    "(Demo Form) Tj",
    "/F1 9 Tf",
    "1 0 0 1 72 684 Tm",
    "(Page 2 of 2) Tj",
    "1 0 0 1 72 668 Tm",
    "(pdfcpu: v0.4.0 dev Created: 2023-02-28 20:49 Optimized for A.Reader) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 638 Tm",
    "(City: Favorite city:) Tj",
    "1 0 0 1 72 620 Tm",
    "(First Name:) Tj",
    "1 0 0 1 220 620 Tm",
    "(Last Name:) Tj",
    "1 0 0 1 72 592 Tm",
    "(1) Please tell us about yourself:) Tj",
    "1 0 0 1 72 574 Tm",
    "(2) How did you hear about pdfcpu:) Tj",
    "1 0 0 1 72 96 Tm",
    "(female male non-binary Gender:) Tj",
    "ET",
  ].join("\n"),
]);
const fieldLabelFormPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 24 Tf",
    "1 0 0 1 72 720 Tm",
    "(Person Of Impact) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 704 Tm",
    "(Gender:) Tj",
    "1 0 0 1 72 684 Tm",
    "(First Name:) Tj",
    "1 0 0 1 220 684 Tm",
    "(Last Name:) Tj",
    "1 0 0 1 72 660 Tm",
    "(Birthday:) Tj",
    "1 0 0 1 72 636 Tm",
    "(Agree to privacy policy) Tj",
    "1 0 0 1 72 612 Tm",
    "(Other) Tj",
    "ET",
  ].join("\n"),
]);
const numberedPromptRolePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "1 0 0 1 72 720 Tm",
    "(Example Form) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 688 Tm",
    "(1\\) Please tell us about yourself:) Tj",
    "1 0 0 1 72 660 Tm",
    "(2\\) How did you hear about pdfcpu:) Tj",
    "ET",
  ].join("\n"),
]);
const inlineNarrativeHeadingPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Body paragraph starts here with enough text to anchor the context.) Tj",
    "1 0 0 1 72 692 Tm",
    "(The Yankee Lookout.) Tj",
    "1 0 0 1 72 664 Tm",
    "(Another body paragraph follows with enough text to keep the line in narrative flow.) Tj",
    "ET",
  ].join("\n"),
]);
const fieldValueRowPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Title:) Tj",
    "1 0 0 1 180 720 Tm",
    "(MBL-SF424Family-AllForms) Tj",
    "1 0 0 1 72 692 Tm",
    "(Competition Identification Number:) Tj",
    "1 0 0 1 260 692 Tm",
    "(ABC-123) Tj",
    "ET",
  ].join("\n"),
]);
const contractAwardTablePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 742 Tm",
    "(2) Tj",
    "1 0 0 1 72 726 Tm",
    "(Serial) Tj",
    "1 0 0 1 72 712 Tm",
    "(No.) Tj",
    "1 0 0 1 140 726 Tm",
    "(Contract) Tj",
    "1 0 0 1 140 712 Tm",
    "(Description) Tj",
    "1 0 0 1 320 726 Tm",
    "(Contractor) Tj",
    "1 0 0 1 320 712 Tm",
    "(/Consultant) Tj",
    "1 0 0 1 460 726 Tm",
    "(Contract) Tj",
    "1 0 0 1 460 712 Tm",
    "(Amount) Tj",
    "1 0 0 1 540 726 Tm",
    "(Remarks) Tj",
    "1 0 0 1 72 676 Tm",
    "(24 Procurement of Traffic Engineering) Tj",
    "1 0 0 1 72 662 Tm",
    "(MRH/IDA/TSP/ICB/G-14/LOT2) Tj",
    "1 0 0 1 72 648 Tm",
    "(ICB Comicel Limited 44 Pangbourine Drive Stanmore) Tj",
    "1 0 0 1 72 634 Tm",
    "(98,439.82 GHS 18-Jun-13 9-Jul-13 Completed) Tj",
    "1 0 0 1 72 606 Tm",
    "(23 Procurement of Software) Tj",
    "1 0 0 1 72 592 Tm",
    "(MRH/IDA/TSP/SHP/G-10) Tj",
    "1 0 0 1 72 578 Tm",
    "(Shopping Harley Reed Ghana Ltd Box KIA 18128, Airport - Accra) Tj",
    "1 0 0 1 72 564 Tm",
    "(227,115.00 GHS 11-Dec-13 15-Jan-14 Completed) Tj",
    "1 0 0 1 72 536 Tm",
    "(22 Production of Road Safety Posters) Tj",
    "1 0 0 1 72 522 Tm",
    "(MRH/IDA/TSP/SHP/G-20) Tj",
    "1 0 0 1 72 508 Tm",
    "(Shopping Samster Ltd Box CO 2803 Tema) Tj",
    "1 0 0 1 72 494 Tm",
    "(244,950.00 GHS 23-Dec-13 17-Feb-14 Completed) Tj",
    "ET",
  ].join("\n"),
]);
const scientificTextFlowPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    "[(Dense)-225(retrieval,)-250(which)-220(describes)-180(the)] TJ",
    "0 -14 Td",
    "[(use)-250(of)-220(contextualised)-180(language)] TJ",
    "0 -14 Td",
    "[(models)-250(such)-180(as)-220(BERT,)-180(is)-220(rep-)] TJ",
    "0 -14 Td",
    "[(resented)-220(here.)] TJ",
    "0 -28 Td",
    "[(Second)-220(paragraph)-220(starts)-220(here.)] TJ",
    "ET",
  ].join("\n"),
]);
const sectionHeadingPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "1 0 0 1 72 720 Tm",
    "(1 INTRODUCTION) Tj",
    "1 0 0 1 72 700 Tm",
    "(Retrieval Architecture) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 670 Tm",
    "(Search engine architectures often follow a) Tj",
    "1 0 0 1 278 670 Tm",
    "(cascading architecture.) Tj",
    "1 0 0 1 72 642 Tm",
    "(Second paragraph starts here.) Tj",
    "ET",
  ].join("\n"),
]);
const coverMatterPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "1 0 0 1 72 720 Tm",
    "(The Crazy Ones) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 700 Tm",
    "(October 14, 1998) Tj",
    "1 0 0 1 72 666 Tm",
    "(Heres to the crazy ones.) Tj",
    "ET",
  ].join("\n"),
]);
const numberedBodyPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "1 0 0 1 72 720 Tm",
    "(Introduction) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 686 Tm",
    "(1. This is a numbered body paragraph that should stay in the body flow.) Tj",
    "1 0 0 1 72 658 Tm",
    "(2. Another numbered body paragraph follows without becoming a heading.) Tj",
    "ET",
  ].join("\n"),
]);
const continuedNumberedBodyPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "1 0 0 1 72 720 Tm",
    "(Introduction) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 686 Tm",
    "(1. This is a numbered body paragraph that should stay in the body flow even when it wraps) Tj",
    "1 0 0 1 108 672 Tm",
    "(onto a second line without becoming a new paragraph.) Tj",
    "1 0 0 1 72 644 Tm",
    "(2. Another numbered body paragraph follows as a separate paragraph.) Tj",
    "ET",
  ].join("\n"),
]);
const contentsNoisePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "1 0 0 1 72 720 Tm",
    "(Contents) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 688 Tm",
    "(Introduction) Tj",
    "1 0 0 1 72 650 Tm",
    "(..............) Tj",
    "1 0 0 1 72 612 Tm",
    "(1) Tj",
    "1 0 0 1 72 570 Tm",
    "(Installation) Tj",
    "1 0 0 1 72 532 Tm",
    "(..............) Tj",
    "1 0 0 1 72 494 Tm",
    "(2) Tj",
    "ET",
  ].join("\n"),
]);
const standaloneBulletPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Read this first.) Tj",
    "1 0 0 1 72 692 Tm",
    "(•) Tj",
    "1 0 0 1 72 664 Tm",
    "(If you have questions, ask your doctor.) Tj",
    "ET",
  ].join("\n"),
]);
const buildTraceParagraphPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "1 0 0 1 72 720 Tm",
    "(Demo Form) Tj",
    "/F1 9 Tf",
    "1 0 0 1 72 700 Tm",
    "(Page 1 of 1) Tj",
    "1 0 0 1 72 684 Tm",
    "(pdfcpu: v0.4.1 dev) Tj",
    "1 0 0 1 72 670 Tm",
    "(Created: 2023-05-06 21:15) Tj",
    "1 0 0 1 72 656 Tm",
    "(Optimized for A.Reader) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 628 Tm",
    "(First Name: Last Name: Date Of Birth:) Tj",
    "ET",
  ].join("\n"),
]);
const tableRowRolePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 16 Tf",
    "1 0 0 1 72 720 Tm",
    "(Qty) Tj",
    "1 0 0 1 180 720 Tm",
    "(Description) Tj",
    "1 0 0 1 320 720 Tm",
    "(Amount) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 692 Tm",
    "(1) Tj",
    "1 0 0 1 180 692 Tm",
    "(Mouse) Tj",
    "1 0 0 1 320 692 Tm",
    "($115.00) Tj",
    "1 0 0 1 72 670 Tm",
    "(3) Tj",
    "1 0 0 1 180 670 Tm",
    "(Unicorn) Tj",
    "1 0 0 1 320 670 Tm",
    "($750,000.00) Tj",
    "ET",
  ].join("\n"),
]);
const contentsEntryRolePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 18 Tf",
    "1 0 0 1 72 720 Tm",
    "(Contents) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 688 Tm",
    "(Introduction) Tj",
    "1 0 0 1 300 688 Tm",
    "(1) Tj",
    "1 0 0 1 72 664 Tm",
    "(Installation) Tj",
    "1 0 0 1 300 664 Tm",
    "(2) Tj",
    "ET",
  ].join("\n"),
]);
const legalMetadataRolePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Neutral Citation Number: [2017] EWHC 3175 (IPEC)) Tj",
    "1 0 0 1 72 690 Tm",
    "(IN THE HIGH COURT OF JUSTICE) Tj",
    "1 0 0 1 72 660 Tm",
    "(Background paragraph starts here.) Tj",
    "ET",
  ].join("\n"),
]);
const spacedLegalMetadataRolePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Neut ral Cit at ion Number: [2017] EWHC 3175 (IPEC)) Tj",
    "1 0 0 1 72 690 Tm",
    "(IN THE HIGH COURT OF JUSTICE) Tj",
    "1 0 0 1 72 660 Tm",
    "(Body paragraph starts here.) Tj",
    "ET",
  ].join("\n"),
]);
const metricHeadingRolePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(January 2024) Tj",
    "1 0 0 1 72 696 Tm",
    "(37,725 MW) Tj",
    "1 0 0 1 72 664 Tm",
    "(2024 Generating Capacity) Tj",
    "1 0 0 1 72 636 Tm",
    "(Natural Gas 44.3% Wind 25.2%) Tj",
    "ET",
  ].join("\n"),
]);
const smallTableHeaderRolePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 7 Tf",
    "1 0 0 1 48 720 Tm",
    "(Rub) Tj",
    "1 0 0 1 110 720 Tm",
    "(Libelle) Tj",
    "1 0 0 1 220 720 Tm",
    "(Base ou Nombre) Tj",
    "1 0 0 1 360 720 Tm",
    "(Taux) Tj",
    "1 0 0 1 48 700 Tm",
    "(100040) Tj",
    "1 0 0 1 110 700 Tm",
    "(SALAIRE DE BASE) Tj",
    "1 0 0 1 220 700 Tm",
    "(151,67) Tj",
    "1 0 0 1 360 700 Tm",
    "(12,00000) Tj",
    "ET",
  ].join("\n"),
]);
const repeatedFieldGroupHeadingPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(9. Type of Applicant 1: Select Applicant Type:) Tj",
    "1 0 0 1 72 692 Tm",
    "(Type of Applicant 2: Select Applicant Type:) Tj",
    "1 0 0 1 72 664 Tm",
    "(Type of Applicant 3: Select Applicant Type:) Tj",
    "1 0 0 1 72 636 Tm",
    "(* Other (specify):) Tj",
    "ET",
  ].join("\n"),
]);
const leafletTitleRolePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 9 Tf",
    "1 0 0 1 72 736 Tm",
    "(1 13.03.2017 124X640 GI-375-1216-02-P 400406041/0318467 /V1) Tj",
    "1 0 0 1 72 722 Tm",
    "(Pr. Name: Example Product 6 mg/ml) Tj",
    "1 0 0 1 72 708 Tm",
    "(ACTAVIS NERVIANO PIL EXAMPLE) Tj",
    "1 0 0 1 72 690 Tm",
    "(GEBRAUCHSINFORMATION: INFORMATION FÜR ANWENDER Example Product 6 mg/ml) Tj",
    "1 0 0 1 72 672 Tm",
    "(1. What is Example?) Tj",
    "ET",
  ].join("\n"),
]);
const fieldValueFalsePositivePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Judge Hacon :) Tj",
    "1 0 0 1 72 692 Tm",
    "(Introduction) Tj",
    "1 0 0 1 72 664 Tm",
    "(ht t p://www.example.com) Tj",
    "1 0 0 1 72 636 Tm",
    "(Body paragraph starts here.) Tj",
    "ET",
  ].join("\n"),
]);
const regulatoryTextRecoveryPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "/Artifact <</O /Layout>> BDC",
    "72 720 Td",
    "(\\001\\002\\003\\004) Tj",
    "EMC",
    "/Span <</ActualText (Introduction)>> BDC",
    "0 -14 Td",
    "(\\001\\002\\003) Tj",
    "EMC",
    "0 -14 Td",
    "(Readable text) Tj",
    "0 -14 Td",
    "(\\001\\002) Tj",
    "ET",
  ].join("\n"),
]);
const regulatoryLayoutFlowPdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 700 Tm",
    "(Body text appears first in stream order.) Tj",
    "1 0 0 1 72 680 Tm",
    "(1. What is Example? Body paragraph starts here.) Tj",
    "1 0 0 1 72 740 Tm",
    "(REGULATORY COVER TITLE) Tj",
    "ET",
  ].join("\n"),
]);
const gridTablePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 16 Tf",
    "1 0 0 1 72 720 Tm",
    "(Quarter) Tj",
    "1 0 0 1 220 720 Tm",
    "(Revenue) Tj",
    "1 0 0 1 360 720 Tm",
    "(Profit) Tj",
    "/F1 12 Tf",
    "1 0 0 1 72 690 Tm",
    "(Q1) Tj",
    "1 0 0 1 220 690 Tm",
    "($10) Tj",
    "1 0 0 1 360 690 Tm",
    "($2) Tj",
    "1 0 0 1 72 670 Tm",
    "(Q2) Tj",
    "1 0 0 1 220 670 Tm",
    "($12) Tj",
    "1 0 0 1 360 670 Tm",
    "($3) Tj",
    "ET",
  ].join("\n"),
]);
const denseGridTablePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Code) Tj",
    "1 0 0 1 180 720 Tm",
    "(Label) Tj",
    "1 0 0 1 320 720 Tm",
    "(Amount) Tj",
    "1 0 0 1 72 711 Tm",
    "(100040) Tj",
    "1 0 0 1 180 711 Tm",
    "(Base Salary) Tj",
    "1 0 0 1 320 711 Tm",
    "(1820.04) Tj",
    "1 0 0 1 72 702 Tm",
    "(109510) Tj",
    "1 0 0 1 180 702 Tm",
    "(Hours 25%) Tj",
    "1 0 0 1 320 702 Tm",
    "(259.95) Tj",
    "ET",
  ].join("\n"),
]);
const rowSequenceTablePdf = buildPdfWithPageContents([
  [
    "BT",
    "/F1 12 Tf",
    "1 0 0 1 72 720 Tm",
    "(Q1) Tj",
    "1 0 0 1 72 720 Tm",
    "(Alpha) Tj",
    "1 0 0 1 72 720 Tm",
    "($10) Tj",
    "1 0 0 1 72 720 Tm",
    "($2) Tj",
    "1 0 0 1 72 720 Tm",
    "(Q2) Tj",
    "1 0 0 1 72 720 Tm",
    "(Beta) Tj",
    "1 0 0 1 72 720 Tm",
    "($12) Tj",
    "1 0 0 1 72 720 Tm",
    "($3) Tj",
    "1 0 0 1 72 720 Tm",
    "(Q3) Tj",
    "1 0 0 1 72 720 Tm",
    "(Gamma) Tj",
    "1 0 0 1 72 720 Tm",
    "($20) Tj",
    "/F1 16 Tf",
    "1 0 0 1 72 690 Tm",
    "(Quarter) Tj",
    "1 0 0 1 72 690 Tm",
    "(Item) Tj",
    "1 0 0 1 72 690 Tm",
    "(Revenue) Tj",
    "1 0 0 1 72 690 Tm",
    "(Profit) Tj",
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
const noFontCidLikeHexContentStreamText = [
  "BT",
  "<0013009400910085> Tj",
  "ET",
].join("\n");
const noFontCidLikeHexPdfTemplate = [
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
  `<< /Length ${String(encodeText(noFontCidLikeHexContentStreamText).byteLength)} >>`,
  "stream",
  noFontCidLikeHexContentStreamText,
  "endstream",
  "endobj",
  "xref",
  "0 5",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 5 >>",
  "startxref",
  "__NO_FONT_CID_LIKE_HEX_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const noFontControlHexContentStreamText = [
  "BT",
  "<1C181A1C05> Tj",
  "ET",
].join("\n");
const noFontControlHexPdfTemplate = [
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
  `<< /Length ${String(encodeText(noFontControlHexContentStreamText).byteLength)} >>`,
  "stream",
  noFontControlHexContentStreamText,
  "endstream",
  "endobj",
  "xref",
  "0 5",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 5 >>",
  "startxref",
  "__NO_FONT_CONTROL_HEX_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const singleByteEncodedTextContentStreamText = [
  "BT",
  "/F1 12 Tf",
  "<01020304050605070806090A> Tj",
  "ET",
].join("\n");
const singleByteEncodedTextPdfTemplate = [
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
  `<< /Length ${String(encodeText(singleByteEncodedTextContentStreamText).byteLength)} >>`,
  "stream",
  singleByteEncodedTextContentStreamText,
  "endstream",
  "endobj",
  "5 0 obj",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 6 0 R >>",
  "endobj",
  "6 0 obj",
  "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /E /n /c /o /d /e 7 /space /T 9 /x /t] >>",
  "endobj",
  "xref",
  "0 7",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 7 >>",
  "startxref",
  "__SINGLE_BYTE_ENCODED_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const ligatureEncodedTextContentStreamText = [
  "BT",
  "/F1 12 Tf",
  "<01020304050607> Tj",
  "ET",
].join("\n");
const ligatureEncodedTextPdfTemplate = [
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
  `<< /Length ${String(encodeText(ligatureEncodedTextContentStreamText).byteLength)} >>`,
  "stream",
  ligatureEncodedTextContentStreamText,
  "endstream",
  "endobj",
  "5 0 obj",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 6 0 R >>",
  "endobj",
  "6 0 obj",
  "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /f_f 2 /space 3 /f_f_i 4 /space 5 /f_i 6 /space 7 /f_l] >>",
  "endobj",
  "xref",
  "0 7",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 7 >>",
  "startxref",
  "__LIGATURE_ENCODED_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const extendedNamedGlyphContentStreamText = [
  "BT",
  "/F1 12 Tf",
  "<0102030405> Tj",
  "ET",
].join("\n");
const extendedNamedGlyphPdfTemplate = [
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
  `<< /Length ${String(encodeText(extendedNamedGlyphContentStreamText).byteLength)} >>`,
  "stream",
  extendedNamedGlyphContentStreamText,
  "endstream",
  "endobj",
  "5 0 obj",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 6 0 R >>",
  "endobj",
  "6 0 obj",
  "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /Abreve 2 /space 3 /Ccaron 4 /space 5 /Gbreve] >>",
  "endobj",
  "xref",
  "0 7",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 7 >>",
  "startxref",
  "__EXTENDED_NAMED_GLYPH_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const commonSymbolGlyphContentStreamText = [
  "BT",
  "/F1 12 Tf",
  "<0102030405060708090A0B> Tj",
  "ET",
].join("\n");
const commonSymbolGlyphPdfTemplate = [
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
  `<< /Length ${String(encodeText(commonSymbolGlyphContentStreamText).byteLength)} >>`,
  "stream",
  commonSymbolGlyphContentStreamText,
  "endstream",
  "endobj",
  "5 0 obj",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 6 0 R >>",
  "endobj",
  "6 0 obj",
  "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /pi 2 /nonbreakingspace 3 /Omega 4 /space 5 /greaterequal 6 /space 7 /integral 8 /space 9 /approxequal 10 /space 11 /arrowright] >>",
  "endobj",
  "xref",
  "0 7",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 7 >>",
  "startxref",
  "__COMMON_SYMBOL_GLYPH_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const partialSingleByteEncodedTextContentStreamText = [
  "BT",
  "/F1 12 Tf",
  "<0102030405060708090A0B0C> Tj",
  "ET",
].join("\n");
const partialSingleByteEncodedTextPdfTemplate = [
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
  `<< /Length ${String(encodeText(partialSingleByteEncodedTextContentStreamText).byteLength)} >>`,
  "stream",
  partialSingleByteEncodedTextContentStreamText,
  "endstream",
  "endobj",
  "5 0 obj",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 6 0 R >>",
  "endobj",
  "6 0 obj",
  "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /A /l /m /o /s /t /space /d /o /n /e /.notdef] >>",
  "endobj",
  "xref",
  "0 7",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 7 >>",
  "startxref",
  "__PARTIAL_SINGLE_BYTE_ENCODED_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const compactSpacingEncodedTextContentStreamText = [
  "BT",
  "/F1 12 Tf",
  "[<010203> -20 <0405> -120 <060708090A>] TJ",
  "ET",
].join("\n");
const compactSpacingEncodedTextPdfTemplate = [
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
  `<< /Length ${String(encodeText(compactSpacingEncodedTextContentStreamText).byteLength)} >>`,
  "stream",
  compactSpacingEncodedTextContentStreamText,
  "endstream",
  "endobj",
  "5 0 obj",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 6 0 R >>",
  "endobj",
  "6 0 obj",
  "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /H 2 /e 3 /l 4 /l 5 /o 6 /W 7 /o 8 /r 9 /l 10 /d] >>",
  "endobj",
  "xref",
  "0 7",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 7 >>",
  "startxref",
  "__COMPACT_SPACING_ENCODED_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const toUnicodeCMapFlateBytes = decodeBase64(
  "eJxdkM1qxCAQx+8+xRy3h0UT2qUHCZSUQA79oGkfwOgkFRoVYw55+0502UIPOr9h5j9fvO2fe2cT8Pfo9YAJJutMxNVvUSOMOFvHqhqM1enq5V8vKjBO4mFfEy69mzxICfyDgmuKO5yejB/xDvhbNBitm+H01Q7kD1sIP7igSyCgacDgRIVeVHhVCwLPsnNvKG7TfibNX8bnHhDq7FdlGO0NrkFpjMrNyKQQDciuaxg68y92KYpx0t8qMnn/SJlCkGHy8pCZDHFbuD24K0z1ZC0ykyGuCle5z7Xi0fE4ym0VvcVIW+TL5fGPwa3D23GDD4cqv18KDXoH",
);
const predictorContentFlateBytes = decodeBase64("eJxjdBLaJqeh9Pk/6y/B38zrNGTZGZh3fTcRW2DNDwCEaAlW");
const predictorChainAscii85Bytes = decodeBase64("R2FyOGMnJiJcMVUlSi5GbFMkKjNiai4pcmZicDAkSTVfYUJAKksyXktQMVptfj4=");
const toUnicodeCMapLzwBytes = decodeBase64(
  "gAvIZJIhJNxpOggF5QORvMZTMsJMxpNxkORlOZvOpyMZlEBiMpnigKGIyEBkNJjhMgkRuBUsihjNphOAKgUEKZ5OZ0MptgxmN4gHg8hRSkJpnZyPIgFBBMhvkAphRPORkMpyihnphVIZTqQvKZ1OBwNk9MpuhIwEA+H0nMpmmxDJs0JxhNseF9OqBlFpJq1ohB5FtcKduuECuZwKh5OEek1WuAxj9HNxjN9WOZwMMdORhNxnMoKHgwGFtHhmMw+BVnMmWzGazme0AKk0wNxiMxjNBhOWiGQx02k3+qHg0HHBGHG1Ws3G63kkyct3Gdz+hHg2GumG2poWk7HLivT2Wh1kymgKuV0u0eMcbi9olEqhXpOGGilXjEajkeOBvmrWNWiqAg==",
);
const cidToUnicodeCMapFlateBytes = decodeBase64(
  "SIlU0U1PhDAQBuA7v2KOGg+lwK6SEBLtQsLBj7joHdoBSaQ0BQ7776UdXOMByNNh+vGWiepU6WEB9mYnecYFukEri/O0WonQYj9o4BGoQS67/FuOjQG2NZ8v84JjpbsJsixg71txXuwFbuqa34W3wF6tQjvofhtJoo/PbeS8GvONI+oFQshzUNgFTDw35qUZEZhv/BusLwYh8ub72pPC2TQSbaN7hCwMwyR3HxnngFr9rwc8pra2k1+NDX5/L4uU50489jqVpINXce8VPTgJ8eQVR74mEhLNIgRJeZVUS2iWlHSgvsfC60gqSC13Wz9GtJ4kxbtiUpoH27H2/bsDuvCvgcnV2i1Lf0M+MZfVoPF6iWYyLhb3BD8CDAAT945ACg==",
);
const malformedToUnicodeBytes = encodeText("not-deflate");
const unsupportedToUnicodeBytes = encodeText("JPXDecode is still unsupported.");
const ccittGroup4Bytes = decodeBase64("JqiOiOglABAB");
const toUnicodeFlateStreamObject = joinBytes([
  encodeText(`<< /Length ${String(toUnicodeCMapFlateBytes.byteLength)} /Filter /FlateDecode >>\nstream\n`),
  toUnicodeCMapFlateBytes,
  encodeText("\nendstream\nendobj\n"),
]);
const toUnicodeLzwStreamObject = joinBytes([
  encodeText(`<< /Length ${String(toUnicodeCMapLzwBytes.byteLength)} /Filter /LZWDecode >>\nstream\n`),
  toUnicodeCMapLzwBytes,
  encodeText("\nendstream\nendobj\n"),
]);
const toUnicodeUnsupportedStreamObject = joinBytes([
  encodeText(`<< /Length ${String(unsupportedToUnicodeBytes.byteLength)} /Filter /JPXDecode >>\nstream\n`),
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
const nestedStartXrefOffset = nestedPageTreeTemplate.indexOf("xref\n0 8");
assert(nestedStartXrefOffset >= 0, "Nested page-tree PDF did not contain an xref section.");
const encodedTextStartXrefOffset = encodedTextPdfTemplate.indexOf("xref\n0 5");
assert(encodedTextStartXrefOffset >= 0, "Encoded-text PDF did not contain an xref section.");
const noFontCidLikeHexStartXrefOffset = noFontCidLikeHexPdfTemplate.indexOf("xref\n0 5");
assert(noFontCidLikeHexStartXrefOffset >= 0, "No-font CID-like hex PDF did not contain an xref section.");
const noFontControlHexStartXrefOffset = noFontControlHexPdfTemplate.indexOf("xref\n0 5");
assert(noFontControlHexStartXrefOffset >= 0, "No-font control hex PDF did not contain an xref section.");
const singleByteEncodedTextStartXrefOffset = singleByteEncodedTextPdfTemplate.indexOf("xref\n0 7");
assert(singleByteEncodedTextStartXrefOffset >= 0, "Single-byte encoded-text PDF did not contain an xref section.");
const ligatureEncodedTextStartXrefOffset = ligatureEncodedTextPdfTemplate.indexOf("xref\n0 7");
assert(ligatureEncodedTextStartXrefOffset >= 0, "Ligature encoded-text PDF did not contain an xref section.");
const extendedNamedGlyphStartXrefOffset = extendedNamedGlyphPdfTemplate.indexOf("xref\n0 7");
assert(extendedNamedGlyphStartXrefOffset >= 0, "Extended named-glyph PDF did not contain an xref section.");
const commonSymbolGlyphStartXrefOffset = commonSymbolGlyphPdfTemplate.indexOf("xref\n0 7");
assert(commonSymbolGlyphStartXrefOffset >= 0, "Common symbol glyph PDF did not contain an xref section.");
const partialSingleByteEncodedTextStartXrefOffset = partialSingleByteEncodedTextPdfTemplate.indexOf("xref\n0 7");
assert(partialSingleByteEncodedTextStartXrefOffset >= 0, "Partial single-byte encoded-text PDF did not contain an xref section.");
const compactSpacingEncodedTextStartXrefOffset = compactSpacingEncodedTextPdfTemplate.indexOf("xref\n0 7");
assert(compactSpacingEncodedTextStartXrefOffset >= 0, "Compact-spacing encoded-text PDF did not contain an xref section.");

const syntheticPdf = syntheticPdfTemplate.replace("__STARTXREF__", String(startXrefOffset));
const nestedPageTreePdf = nestedPageTreeTemplate.replace("__NESTED_STARTXREF__", String(nestedStartXrefOffset));
const encodedTextPdf = encodedTextPdfTemplate.replace("__ENCODED_TEXT_STARTXREF__", String(encodedTextStartXrefOffset));
const noFontCidLikeHexPdf = noFontCidLikeHexPdfTemplate.replace(
  "__NO_FONT_CID_LIKE_HEX_STARTXREF__",
  String(noFontCidLikeHexStartXrefOffset),
);
const noFontControlHexPdf = noFontControlHexPdfTemplate.replace(
  "__NO_FONT_CONTROL_HEX_STARTXREF__",
  String(noFontControlHexStartXrefOffset),
);
const singleByteEncodedTextPdf = singleByteEncodedTextPdfTemplate.replace(
  "__SINGLE_BYTE_ENCODED_STARTXREF__",
  String(singleByteEncodedTextStartXrefOffset),
);
const ligatureEncodedTextPdf = ligatureEncodedTextPdfTemplate.replace(
  "__LIGATURE_ENCODED_STARTXREF__",
  String(ligatureEncodedTextStartXrefOffset),
);
const extendedNamedGlyphPdf = extendedNamedGlyphPdfTemplate.replace(
  "__EXTENDED_NAMED_GLYPH_STARTXREF__",
  String(extendedNamedGlyphStartXrefOffset),
);
const commonSymbolGlyphPdf = commonSymbolGlyphPdfTemplate.replace(
  "__COMMON_SYMBOL_GLYPH_STARTXREF__",
  String(commonSymbolGlyphStartXrefOffset),
);
const partialSingleByteEncodedTextPdf = partialSingleByteEncodedTextPdfTemplate.replace(
  "__PARTIAL_SINGLE_BYTE_ENCODED_STARTXREF__",
  String(partialSingleByteEncodedTextStartXrefOffset),
);
const compactSpacingEncodedTextPdf = compactSpacingEncodedTextPdfTemplate.replace(
  "__COMPACT_SPACING_ENCODED_STARTXREF__",
  String(compactSpacingEncodedTextStartXrefOffset),
);
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
const asciiHexPdfBytes = buildFilteredContentStreamPdfBytes({
  streamBytes: asciiHexStreamBytes,
  filterValue: "/ASCIIHexDecode",
});
const ascii85PdfBytes = buildFilteredContentStreamPdfBytes({
  streamBytes: ascii85StreamBytes,
  filterValue: "/ASCII85Decode",
});
const runLengthPdfBytes = buildFilteredContentStreamPdfBytes({
  streamBytes: runLengthStreamBytes,
  filterValue: "/RunLengthDecode",
});
const chainedFilterPdfBytes = buildFilteredContentStreamPdfBytes({
  streamBytes: chainedFilterStreamBytes,
  filterValue: "[/ASCII85Decode /FlateDecode]",
});
const predictorPdfBytes = buildFilteredContentStreamPdfBytes({
  streamBytes: predictorContentFlateBytes,
  filterValue: "/FlateDecode",
  decodeParamsValue: "<< /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 26 >>",
});
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
const toUnicodeLzwPdfBytes = buildPdfWithFontResourceStream({
  contentStreamText: "BT\n/F1 12 Tf\n<48656C6C6F21> Tj\nET",
  fontDictionaryLines: [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>",
  ],
  resourceStreamObject: toUnicodeLzwStreamObject,
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
const ignoredFunctionStreamBody = "not-deflate";
const ignoredFunctionStreamText = "BT\n(Parser Safe) Tj\nET";
const ignoredFunctionStreamPdfTemplate = [
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
  `<< /Length ${String(encodeText(ignoredFunctionStreamText).byteLength)} >>`,
  "stream",
  ignoredFunctionStreamText,
  "endstream",
  "endobj",
  "5 0 obj",
  `<< /FunctionType 0 /Domain [0 1] /Range [0 1] /Size [2] /BitsPerSample 8 /Filter /FlateDecode /Length ${String(encodeText(ignoredFunctionStreamBody).byteLength)} >>`,
  "stream",
  ignoredFunctionStreamBody,
  "endstream",
  "endobj",
  "xref",
  "0 6",
  "0000000000 65535 f",
  "trailer",
  "<< /Root 1 0 R /Size 6 >>",
  "startxref",
  "__IGNORED_FUNCTION_STREAM_STARTXREF__",
  "%%EOF",
  "",
].join("\n");
const ignoredFunctionStreamStartXrefOffset = ignoredFunctionStreamPdfTemplate.indexOf("xref\n0 6");
assert(
  ignoredFunctionStreamStartXrefOffset >= 0,
  "Ignored function-stream PDF did not contain an xref section.",
);
const ignoredFunctionStreamPdfBytes = encodeText(
  ignoredFunctionStreamPdfTemplate.replace(
    "__IGNORED_FUNCTION_STREAM_STARTXREF__",
    String(ignoredFunctionStreamStartXrefOffset),
  ),
);
const cidToUnicodePdfBytes = buildPdfWithFontResourceStream({
  contentStreamText: "BT\n/F1 12 Tf\n<0045003D000400520034001300B1> Tj\nET",
  fontDictionaryLines: [
    "<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticCID /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>",
  ],
  resourceStreamObject: joinBytes([
    encodeText(`<< /Length ${String(cidToUnicodeCMapFlateBytes.byteLength)} /Filter /FlateDecode >>\nstream\n`),
    cidToUnicodeCMapFlateBytes,
    encodeText("\nendstream\nendobj\n"),
  ]),
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
const chainedPredictorDecodeResult = await streamDecodeModuleNamespace.decodePdfStreamBytes(
  predictorChainAscii85Bytes,
  "[/ASCII85Decode /FlateDecode]",
  "[null << /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 26 >>]",
);
const ccittDecodeResult = await streamDecodeModuleNamespace.decodePdfStreamBytes(
  ccittGroup4Bytes,
  "/CCITTFaxDecode",
  "<< /K -1 /Columns 8 /Rows 1 /EndOfBlock false /BlackIs1 true >>",
);
const lzwDecodeResult = await streamDecodeModuleNamespace.decodePdfStreamBytes(
  toUnicodeCMapLzwBytes,
  "/LZWDecode",
);
const renderImageryFixtureBytes = await readSmokeAssetBytes(
  new URL("../../test/fixtures/render-imagery-raster.pdf", import.meta.url),
);
const result = await engine.run({
  source: {
    bytes: encodeText(syntheticPdf),
    fileName: "synthetic.pdf",
    mediaType: "application/pdf",
  },
});
const renderImageryResult = await engine.run({
  source: {
    bytes: renderImageryFixtureBytes,
    fileName: "render-imagery-raster.pdf",
    mediaType: "application/pdf",
  },
});
const observedMarksResult = await engine.run({
  source: {
    bytes: encodeText(observedMarksPdf),
    fileName: "observed-marks.pdf",
    mediaType: "application/pdf",
  },
});
const markedContentActualTextResult = await engine.run({
  source: {
    bytes: encodeText(markedContentActualTextPdf),
    fileName: "marked-content-actual-text.pdf",
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
const asciiHexResult = await engine.run({
  source: {
    bytes: asciiHexPdfBytes,
    fileName: "asciihex.pdf",
    mediaType: "application/pdf",
  },
});
const ascii85Result = await engine.run({
  source: {
    bytes: ascii85PdfBytes,
    fileName: "ascii85.pdf",
    mediaType: "application/pdf",
  },
});
const runLengthResult = await engine.run({
  source: {
    bytes: runLengthPdfBytes,
    fileName: "runlength.pdf",
    mediaType: "application/pdf",
  },
});
const chainedFilterResult = await engine.run({
  source: {
    bytes: chainedFilterPdfBytes,
    fileName: "ascii85-flate.pdf",
    mediaType: "application/pdf",
  },
});
const predictorResult = await engine.run({
  source: {
    bytes: predictorPdfBytes,
    fileName: "flate-predictor.pdf",
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
const imageXObjectResult = await engine.run({
  source: {
    bytes: imageXObjectPdfBytes,
    fileName: "image-xobject.pdf",
    mediaType: "application/pdf",
  },
});
const hiddenOptionalContentResult = await engine.run({
  source: {
    bytes: hiddenOptionalContentPdfBytes,
    fileName: "hidden-optional-content.pdf",
    mediaType: "application/pdf",
  },
});
const delayedContentResult = await engine.run({
  source: {
    bytes: delayedContentPdfBytes,
    fileName: "delayed-content.pdf",
    mediaType: "application/pdf",
  },
});
const streamBoundaryResult = await engine.run({
  source: {
    bytes: streamBoundaryPdfBytes,
    fileName: "stream-boundary.pdf",
    mediaType: "application/pdf",
  },
});
const incrementalUpdateResult = await engine.run({
  source: {
    bytes: incrementalUpdatePdf.bytes,
    fileName: "incremental-update.pdf",
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
const noFontCidLikeHexResult = await engine.run({
  source: {
    bytes: encodeText(noFontCidLikeHexPdf),
    fileName: "no-font-cid-like-hex.pdf",
    mediaType: "application/pdf",
  },
});
const noFontControlHexResult = await engine.run({
  source: {
    bytes: encodeText(noFontControlHexPdf),
    fileName: "no-font-control-hex.pdf",
    mediaType: "application/pdf",
  },
});
const singleByteEncodedTextResult = await engine.run({
  source: {
    bytes: encodeText(singleByteEncodedTextPdf),
    fileName: "single-byte-encoded-text.pdf",
    mediaType: "application/pdf",
  },
});
const ligatureEncodedTextResult = await engine.run({
  source: {
    bytes: encodeText(ligatureEncodedTextPdf),
    fileName: "ligature-encoded-text.pdf",
    mediaType: "application/pdf",
  },
});
const extendedNamedGlyphResult = await engine.run({
  source: {
    bytes: encodeText(extendedNamedGlyphPdf),
    fileName: "extended-named-glyphs.pdf",
    mediaType: "application/pdf",
  },
});
const commonSymbolGlyphResult = await engine.run({
  source: {
    bytes: encodeText(commonSymbolGlyphPdf),
    fileName: "common-symbol-glyphs.pdf",
    mediaType: "application/pdf",
  },
});
const partialSingleByteEncodedTextResult = await engine.run({
  source: {
    bytes: encodeText(partialSingleByteEncodedTextPdf),
    fileName: "partial-single-byte-encoded-text.pdf",
    mediaType: "application/pdf",
  },
});
const compactSpacingEncodedTextResult = await engine.run({
  source: {
    bytes: encodeText(compactSpacingEncodedTextPdf),
    fileName: "compact-spacing-encoded-text.pdf",
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
const toUnicodeLzwResult = await engine.run({
  source: {
    bytes: toUnicodeLzwPdfBytes,
    fileName: "tounicode-lzw.pdf",
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
const ignoredFunctionStreamResult = await engine.run({
  source: {
    bytes: ignoredFunctionStreamPdfBytes,
    fileName: "ignored-function-stream.pdf",
    mediaType: "application/pdf",
  },
});
const cidToUnicodeResult = await engine.run({
  source: {
    bytes: cidToUnicodePdfBytes,
    fileName: "cid-tounicode.pdf",
    mediaType: "application/pdf",
  },
});
const identityHCidFontResult = await engine.run({
  source: {
    bytes: decodeFixturePdfBytes(publicSmokeFixtures.identityHCidFont.bytesBase64),
    fileName: publicSmokeFixtures.identityHCidFont.fileName,
    mediaType: "application/pdf",
  },
});
const identityVCidFontResult = await engine.run({
  source: {
    bytes: decodeFixturePdfBytes(publicSmokeFixtures.identityVCidFont.bytesBase64),
    fileName: publicSmokeFixtures.identityVCidFont.fileName,
    mediaType: "application/pdf",
  },
});
const verticalWordColumnsResult = await engine.run({
  source: {
    bytes: encodeText(verticalWordColumnsPdf),
    fileName: "vertical-word-columns.pdf",
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
const javascriptActionAdmission = await engine.admit({
  source: {
    bytes: javascriptActionPdfBytes,
    fileName: "javascript-action.pdf",
    mediaType: "application/pdf",
  },
});
const javascriptActionAllowedAdmission = await engine.admit({
  source: {
    bytes: javascriptActionPdfBytes,
    fileName: "javascript-action.pdf",
    mediaType: "application/pdf",
  },
  policy: {
    javascriptActions: "allow",
  },
});
const javascriptActionFinding = javascriptActionAdmission.value?.featureFindings.find(
  (finding) => finding.kind === "javascript-actions",
);
const javascriptActionAllowedFinding = javascriptActionAllowedAdmission.value?.featureFindings.find(
  (finding) => finding.kind === "javascript-actions",
);
const largeBenignJavascriptCommentAdmission = await engine.admit({
  source: {
    bytes: largeBenignJavascriptCommentPdfBytes,
    fileName: "large-benign-comment.pdf",
    mediaType: "application/pdf",
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
const paragraphResult = await engine.run({
  source: {
    bytes: encodeText(paragraphPdf),
    fileName: "paragraphs.pdf",
    mediaType: "application/pdf",
  },
});
const headingParagraphResult = await engine.run({
  source: {
    bytes: encodeText(headingParagraphPdf),
    fileName: "heading-paragraph.pdf",
    mediaType: "application/pdf",
  },
});
const numberedHeadingParagraphResult = await engine.run({
  source: {
    bytes: encodeText(numberedHeadingParagraphPdf),
    fileName: "numbered-heading-paragraph.pdf",
    mediaType: "application/pdf",
  },
});
const compactLabelClusterResult = await engine.run({
  source: {
    bytes: encodeText(compactLabelClusterPdf),
    fileName: "compact-label-clusters.pdf",
    mediaType: "application/pdf",
  },
});
const repeatedFormBoundaryResult = await engine.run({
  source: {
    bytes: encodeText(repeatedFormBoundaryPdf),
    fileName: "repeated-form-boundaries.pdf",
    mediaType: "application/pdf",
  },
});
const fieldLabelFormResult = await engine.run({
  source: {
    bytes: encodeText(fieldLabelFormPdf),
    fileName: "field-label-form.pdf",
    mediaType: "application/pdf",
  },
});
const numberedPromptRoleResult = await engine.run({
  source: {
    bytes: encodeText(numberedPromptRolePdf),
    fileName: "numbered-prompt-role.pdf",
    mediaType: "application/pdf",
  },
});
const inlineNarrativeHeadingResult = await engine.run({
  source: {
    bytes: encodeText(inlineNarrativeHeadingPdf),
    fileName: "inline-narrative-heading.pdf",
    mediaType: "application/pdf",
  },
});
const fieldValueRowResult = await engine.run({
  source: {
    bytes: encodeText(fieldValueRowPdf),
    fileName: "field-value-row.pdf",
    mediaType: "application/pdf",
  },
});
const contractAwardTableResult = await engine.run({
  source: {
    bytes: encodeText(contractAwardTablePdf),
    fileName: "contract-award-table.pdf",
    mediaType: "application/pdf",
  },
});
const scientificTextFlowResult = await engine.run({
  source: {
    bytes: encodeText(scientificTextFlowPdf),
    fileName: "scientific-text-flow.pdf",
    mediaType: "application/pdf",
  },
});
const sectionHeadingResult = await engine.run({
  source: {
    bytes: encodeText(sectionHeadingPdf),
    fileName: "section-heading.pdf",
    mediaType: "application/pdf",
  },
});
const coverMatterResult = await engine.run({
  source: {
    bytes: encodeText(coverMatterPdf),
    fileName: "cover-matter.pdf",
    mediaType: "application/pdf",
  },
});
const numberedBodyResult = await engine.run({
  source: {
    bytes: encodeText(numberedBodyPdf),
    fileName: "numbered-body.pdf",
    mediaType: "application/pdf",
  },
});
const continuedNumberedBodyResult = await engine.run({
  source: {
    bytes: encodeText(continuedNumberedBodyPdf),
    fileName: "continued-numbered-body.pdf",
    mediaType: "application/pdf",
  },
});
const contentsNoiseResult = await engine.run({
  source: {
    bytes: encodeText(contentsNoisePdf),
    fileName: "contents-noise.pdf",
    mediaType: "application/pdf",
  },
});
const standaloneBulletResult = await engine.run({
  source: {
    bytes: encodeText(standaloneBulletPdf),
    fileName: "standalone-bullet.pdf",
    mediaType: "application/pdf",
  },
});
const buildTraceParagraphResult = await engine.run({
  source: {
    bytes: encodeText(buildTraceParagraphPdf),
    fileName: "build-trace-paragraph.pdf",
    mediaType: "application/pdf",
  },
});
const tableRowRoleResult = await engine.run({
  source: {
    bytes: encodeText(tableRowRolePdf),
    fileName: "table-row-role.pdf",
    mediaType: "application/pdf",
  },
});
const contentsEntryRoleResult = await engine.run({
  source: {
    bytes: encodeText(contentsEntryRolePdf),
    fileName: "contents-entry-role.pdf",
    mediaType: "application/pdf",
  },
});
const legalMetadataRoleResult = await engine.run({
  source: {
    bytes: encodeText(legalMetadataRolePdf),
    fileName: "legal-metadata-role.pdf",
    mediaType: "application/pdf",
  },
});
const spacedLegalMetadataRoleResult = await engine.run({
  source: {
    bytes: encodeText(spacedLegalMetadataRolePdf),
    fileName: "spaced-legal-metadata-role.pdf",
    mediaType: "application/pdf",
  },
});
const metricHeadingRoleResult = await engine.run({
  source: {
    bytes: encodeText(metricHeadingRolePdf),
    fileName: "metric-heading-role.pdf",
    mediaType: "application/pdf",
  },
});
const smallTableHeaderRoleResult = await engine.run({
  source: {
    bytes: encodeText(smallTableHeaderRolePdf),
    fileName: "small-table-header-role.pdf",
    mediaType: "application/pdf",
  },
});
const repeatedFieldGroupHeadingResult = await engine.run({
  source: {
    bytes: encodeText(repeatedFieldGroupHeadingPdf),
    fileName: "repeated-field-group-heading.pdf",
    mediaType: "application/pdf",
  },
});
const leafletTitleRoleResult = await engine.run({
  source: {
    bytes: encodeText(leafletTitleRolePdf),
    fileName: "leaflet-title-role.pdf",
    mediaType: "application/pdf",
  },
});
const fieldValueFalsePositiveResult = await engine.run({
  source: {
    bytes: encodeText(fieldValueFalsePositivePdf),
    fileName: "field-value-false-positive.pdf",
    mediaType: "application/pdf",
  },
});
const regulatoryTextRecoveryResult = await engine.run({
  source: {
    bytes: encodeText(regulatoryTextRecoveryPdf),
    fileName: "regulatory-text-recovery.pdf",
    mediaType: "application/pdf",
  },
});
const regulatoryLayoutFlowResult = await engine.run({
  source: {
    bytes: encodeText(regulatoryLayoutFlowPdf),
    fileName: "regulatory-layout-flow.pdf",
    mediaType: "application/pdf",
  },
});
const gridTableResult = await engine.run({
  source: {
    bytes: encodeText(gridTablePdf),
    fileName: "grid-table.pdf",
    mediaType: "application/pdf",
  },
});
const denseGridTableResult = await engine.run({
  source: {
    bytes: encodeText(denseGridTablePdf),
    fileName: "dense-grid-table.pdf",
    mediaType: "application/pdf",
  },
});
const rowSequenceTableResult = await engine.run({
  source: {
    bytes: encodeText(rowSequenceTablePdf),
    fileName: "row-sequence-table.pdf",
    mediaType: "application/pdf",
  },
});
const stackedHeaderTableResult = await engine.run({
  source: {
    bytes: stackedHeaderTableFixtureBytes,
    fileName: "stacked-header-table.pdf",
    mediaType: "application/pdf",
  },
});
const fieldValueFormResult = await engine.run({
  source: {
    bytes: fieldValueFormFixtureBytes,
    fileName: "field-value-form.pdf",
    mediaType: "application/pdf",
  },
  policy: {
    javascriptActions: "allow",
    launchActions: "allow",
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
const repeatedBoundaryRenderResult = await engine.toRender({
  source: {
    bytes: encodeText(repeatedBoundaryPdf),
    fileName: "repeated-boundary.pdf",
    mediaType: "application/pdf",
  },
});
const repeatedBoundaryRenderRepeatResult = await engine.toRender({
  source: {
    bytes: encodeText(repeatedBoundaryPdf),
    fileName: "repeated-boundary.pdf",
    mediaType: "application/pdf",
  },
});
const observationWithoutPassword = await engine.observe({
  source: {
    bytes: encryptedStandardTextFixtureBytes,
    fileName: encryptedStandardTextFixture.fileName,
    mediaType: "application/pdf",
  },
});
const observationWithWrongPassword = await engine.observe({
  source: {
    bytes: encryptedStandardTextFixtureBytes,
    fileName: encryptedStandardTextFixture.fileName,
    mediaType: "application/pdf",
  },
  passwordProvider: () => "wrong-password",
});
const observationWithPassword = await engine.observe({
  source: {
    bytes: encryptedStandardTextFixtureBytes,
    fileName: encryptedStandardTextFixture.fileName,
    mediaType: "application/pdf",
  },
  passwordProvider: () => encryptedStandardTextFixture.userPassword,
});
const admissionWithPassword = await engine.admit({
  source: {
    bytes: encryptedStandardTextFixtureBytes,
    fileName: encryptedStandardTextFixture.fileName,
    mediaType: "application/pdf",
  },
  passwordProvider: () => encryptedStandardTextFixture.userPassword,
});
const observationAes256WithoutPassword = await engine.observe({
  source: {
    bytes: encryptedStandardTextAes256FixtureBytes,
    fileName: encryptedStandardTextAes256Fixture.fileName,
    mediaType: "application/pdf",
  },
});
const observationAes256WithWrongPassword = await engine.observe({
  source: {
    bytes: encryptedStandardTextAes256FixtureBytes,
    fileName: encryptedStandardTextAes256Fixture.fileName,
    mediaType: "application/pdf",
  },
  passwordProvider: () => "wrong-password",
});
const observationAes256WithPassword = await engine.observe({
  source: {
    bytes: encryptedStandardTextAes256FixtureBytes,
    fileName: encryptedStandardTextAes256Fixture.fileName,
    mediaType: "application/pdf",
  },
  passwordProvider: () => encryptedStandardTextAes256Fixture.userPassword,
});
const admissionAes256WithPassword = await engine.admit({
  source: {
    bytes: encryptedStandardTextAes256FixtureBytes,
    fileName: encryptedStandardTextAes256Fixture.fileName,
    mediaType: "application/pdf",
  },
  passwordProvider: () => encryptedStandardTextAes256Fixture.userPassword,
});

assert(result.runtime.kind === expectedRuntime, `Expected runtime ${expectedRuntime} but received ${result.runtime.kind}.`);
assert(engine.identity.mode === "core", `Engine identity mode was ${engine.identity.mode}.`);
assert(engine.identity.supportedRuntimes.includes(expectedRuntime), `Engine identity does not claim support for runtime ${expectedRuntime}.`);
assert(engine.identity.supportedStages.includes("admission"), "Engine identity does not claim admission support.");
assert(engine.identity.supportedStages.includes("ir"), "Engine identity does not claim IR support.");
assert(engine.identity.supportedStages.includes("observation"), "Engine identity does not claim observation support.");
assert(engine.identity.supportedStages.includes("layout"), "Engine identity does not claim layout support.");
assert(engine.identity.supportedStages.includes("knowledge"), "Engine identity does not claim knowledge support.");
assert(engine.identity.supportedStages.includes("render"), "Engine identity does not claim render support.");
assert(result.admission.status === "completed", `Admission status was ${result.admission.status}.`);
assert(result.ir.status === "completed", `IR status was ${result.ir.status}.`);
assert(result.observation.status === "completed", `Observation status was ${result.observation.status}.`);
assert(result.render.status === "partial", `Render status was ${result.render.status}.`);
assert(result.ir.value?.kind === "pdf-ir", `IR kind was ${result.ir.value?.kind ?? "missing"}.`);
assert(result.observation.value?.kind === "pdf-observation", `Observation kind was ${result.observation.value?.kind ?? "missing"}.`);
assert(result.render.value?.kind === "pdf-render", `Render kind was ${result.render.value?.kind ?? "missing"}.`);
assert(result.render.value?.strategy === "observed-display-list", `Render strategy was ${result.render.value?.strategy ?? "missing"}.`);
assert(result.render.value?.renderHash.algorithm === "sha-256", `Render document hash algorithm was ${result.render.value?.renderHash.algorithm ?? "missing"}.`);
assert((result.render.value?.renderHash.hex.length ?? 0) === 64, `Render document hash length was ${result.render.value?.renderHash.hex.length ?? 0}.`);
assert(result.admission.value?.repairState === "clean", `Repair state was ${result.admission.value?.repairState ?? "missing"}.`);
assert((result.admission.value?.knownLimits.length ?? 0) === 0, "Admission known limits should be empty for the clean synthetic document.");
assert(result.admission.value?.parseCoverage.startXref === true, "The parser did not recover startxref coverage.");
assert(result.admission.value?.parseCoverage.trailer === true, "The parser did not recover trailer coverage.");
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
assert(result.observation.value?.strategy === "content-stream-interpreter", "Observation strategy was not updated.");
assert(result.observation.value?.pages[0]?.marks[0]?.kind === "text", "Observation text marks were not emitted for the synthetic document.");
assert(result.render.value?.pages[0]?.displayList.commands[0]?.kind === "text", "Render display list did not emit a text command for the synthetic document.");
assert(result.render.value?.pages[0]?.renderHash.algorithm === "sha-256", `Render page hash algorithm was ${result.render.value?.pages[0]?.renderHash.algorithm ?? "missing"}.`);
assert((result.render.value?.pages[0]?.renderHash.hex.length ?? 0) === 64, `Render page hash length was ${result.render.value?.pages[0]?.renderHash.hex.length ?? 0}.`);
assert(
  result.render.value?.knownLimits.includes("render-imagery-partial"),
  "Render known limits did not include render-imagery-partial.",
);
assert(
  renderImageryResult.render.value?.pages[0]?.imagery?.svg?.mimeType === "image/svg+xml",
  "Render page imagery did not expose SVG output.",
);
assert(
  renderImageryResult.render.value?.pages[0]?.imagery?.raster?.mimeType === "image/png",
  "Render page imagery did not expose PNG raster output.",
);
assert(
  result.render.diagnostics.some((diagnostic) => diagnostic.code === "render-imagery-partial"),
  "Render diagnostics did not include render-imagery-partial.",
);
assert(repeatedBoundaryRenderResult.status === "partial", `Direct render status was ${repeatedBoundaryRenderResult.status}.`);
assert(repeatedBoundaryRenderResult.value?.kind === "pdf-render", `Direct render kind was ${repeatedBoundaryRenderResult.value?.kind ?? "missing"}.`);
assert(
  (repeatedBoundaryRenderResult.value?.renderHash.hex.length ?? 0) === 64,
  `Direct render hash length was ${repeatedBoundaryRenderResult.value?.renderHash.hex.length ?? 0}.`,
);
assert(
  repeatedBoundaryRenderResult.value?.renderHash.hex === repeatedBoundaryRenderRepeatResult.value?.renderHash.hex,
  "Direct render document hashes were not stable across repeated runs.",
);
assert(
  repeatedBoundaryRenderResult.value?.pages[0]?.renderHash.hex === repeatedBoundaryRenderRepeatResult.value?.pages[0]?.renderHash.hex,
  "Direct render page hashes were not stable across repeated runs.",
);
assert(
  result.observation.value?.knownLimits.includes("text-decoding-heuristic"),
  "Observation known limits did not include text-decoding-heuristic.",
);
assert(
  observedMarksResult.observation.value?.pages[0]?.marks.map((mark) => mark.kind).join(",") === "path,text",
  `Observed mark kinds were ${JSON.stringify(observedMarksResult.observation.value?.pages[0]?.marks.map((mark) => mark.kind) ?? null)}.`,
);
assert(
  observedMarksResult.observation.value?.pages[0]?.marks[0]?.kind === "path" &&
    observedMarksResult.observation.value.pages[0]?.marks[0]?.bbox?.width === 50 &&
    observedMarksResult.observation.value.pages[0]?.marks[0]?.bbox?.height === 20,
  `Observed path mark bbox was ${JSON.stringify(observedMarksResult.observation.value?.pages[0]?.marks[0] ?? null)}.`,
);
assert(
  imageXObjectResult.observation.value?.pages[0]?.marks[0]?.kind === "image" &&
    imageXObjectResult.observation.value.pages[0]?.marks[0]?.resourceName === "Im1" &&
    imageXObjectResult.observation.value.pages[0]?.marks[0]?.width === 2 &&
    imageXObjectResult.observation.value.pages[0]?.marks[0]?.height === 1,
  `Observed image mark was ${JSON.stringify(imageXObjectResult.observation.value?.pages[0]?.marks[0] ?? null)}.`,
);
assert(
  markedContentActualTextResult.observation.value?.pages[0]?.marks[0]?.kind === "marked-content" &&
    markedContentActualTextResult.observation.value.pages[0]?.marks[0]?.tagName === "Span" &&
    markedContentActualTextResult.observation.value.pages[0]?.marks[0]?.actualText === "Tagged Hello" &&
    markedContentActualTextResult.observation.value.pages[0]?.marks[0]?.mcid === 7,
  `Observed marked-content mark was ${JSON.stringify(markedContentActualTextResult.observation.value?.pages[0]?.marks[0] ?? null)}.`,
);
assert(
  markedContentActualTextResult.observation.value?.pages[0]?.marks[1]?.kind === "text" &&
    markedContentActualTextResult.observation.value.pages[0]?.marks[1]?.markedContentKind === "span" &&
    markedContentActualTextResult.observation.value.pages[0]?.marks[1]?.actualText === "Tagged Hello" &&
    markedContentActualTextResult.observation.value.pages[0]?.marks[1]?.markedContentId ===
      markedContentActualTextResult.observation.value.pages[0]?.marks[0]?.id,
  `Observed marked-content text mark was ${JSON.stringify(markedContentActualTextResult.observation.value?.pages[0]?.marks[1] ?? null)}.`,
);
assert(
  hiddenOptionalContentResult.observation.value?.pages[0]?.marks[0]?.kind === "marked-content" &&
    hiddenOptionalContentResult.observation.value.pages[0]?.marks[0]?.visibilityState === "hidden" &&
    hiddenOptionalContentResult.observation.value.pages[0]?.marks[0]?.propertyName === "MC1",
  `Observed hidden optional-content mark was ${JSON.stringify(hiddenOptionalContentResult.observation.value?.pages[0]?.marks[0] ?? null)}.`,
);
assert(
  hiddenOptionalContentResult.observation.value?.pages[0]?.marks[1]?.kind === "text" &&
    hiddenOptionalContentResult.observation.value.pages[0]?.marks[1]?.visibilityState === "hidden" &&
    hiddenOptionalContentResult.observation.value.pages[0]?.marks[1]?.hiddenTextCandidate === true,
  `Observed hidden text mark was ${JSON.stringify(hiddenOptionalContentResult.observation.value?.pages[0]?.marks[1] ?? null)}.`,
);
assert(
  result.observation.value?.extractedText === "Hello PDF Engine",
  `Unexpected extracted text: ${JSON.stringify(result.observation.value?.extractedText ?? null)}.`,
);
assert(layoutResult.layout.status === "partial", `Layout status was ${layoutResult.layout.status}.`);
assert(layoutResult.layout.value?.kind === "pdf-layout", `Layout kind was ${layoutResult.layout.value?.kind ?? "missing"}.`);
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
assert(
  paragraphResult.observation.value?.knownLimits.includes("paragraph-break-heuristic"),
  "Observation known limits did not include paragraph-break-heuristic for the paragraph fixture.",
);
assert(
  paragraphResult.observation.value?.extractedText === "First paragraph line one line two\n\nSecond paragraph starts here line four",
  `Paragraph-aware observation text was ${JSON.stringify(paragraphResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  paragraphResult.layout.value?.pages[0]?.blocks[1]?.startsParagraph === true,
  "The second paragraph block was not marked as a paragraph start.",
);
assert(
  paragraphResult.layout.value?.extractedText === "First paragraph line one line two\n\nSecond paragraph starts here line four",
  `Paragraph-aware layout text was ${JSON.stringify(paragraphResult.layout.value?.extractedText ?? null)}.`,
);
assert(layoutResult.knowledge.status === "partial", `Knowledge status was ${layoutResult.knowledge.status}.`);
assert(layoutResult.knowledge.value?.kind === "pdf-knowledge", `Knowledge kind was ${layoutResult.knowledge.value?.kind ?? "missing"}.`);
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
assert(
  paragraphResult.knowledge.value?.chunks[0]?.text === "First paragraph line one line two\n\nSecond paragraph starts here line four",
  `Paragraph-aware knowledge text was ${JSON.stringify(paragraphResult.knowledge.value?.chunks[0]?.text ?? null)}.`,
);
assert(
  headingParagraphResult.observation.value?.extractedText === "ABSTRACT\n\nDense retrieval starts here.",
  `Heading-paragraph observation text was ${JSON.stringify(headingParagraphResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  numberedHeadingParagraphResult.observation.value?.extractedText ===
    "Introduction\n\n1.\n\nThis paragraph starts here.\n\nIt continues onto the next line.",
  `Numbered heading-paragraph observation text was ${JSON.stringify(numberedHeadingParagraphResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  compactLabelClusterResult.observation.value?.extractedText ===
    "Source: Person Of Impact Page 1 of 1\n\nFirst Name: Last Name: Country: Planet: Occupation: Date Of Birth:",
  `Compact label-cluster observation text was ${JSON.stringify(compactLabelClusterResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  compactLabelClusterResult.layout.value?.extractedText ===
    "Source: Person Of Impact Page 1 of 1\n\nFirst Name: Last Name: Country: Planet: Occupation: Date Of Birth:",
  `Compact label-cluster layout text was ${JSON.stringify(compactLabelClusterResult.layout.value?.extractedText ?? null)}.`,
);
assert(
  compactLabelClusterResult.knowledge.value?.extractedText ===
    "Source: Person Of Impact Page 1 of 1\n\nFirst Name: Last Name: Country: Planet: Occupation: Date Of Birth:",
  `Compact label-cluster knowledge text was ${JSON.stringify(compactLabelClusterResult.knowledge.value?.extractedText ?? null)}.`,
);
assert(
  scientificTextFlowResult.observation.value?.extractedText ===
    "Dense retrieval, which describes the use of contextualised language models such as BERT, is represented here.\n\nSecond paragraph starts here.",
  `Scientific text-flow observation text was ${JSON.stringify(scientificTextFlowResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  scientificTextFlowResult.layout.value?.extractedText ===
    "Dense retrieval, which describes the use of contextualised language models such as BERT, is represented here.\n\nSecond paragraph starts here.",
  `Scientific text-flow layout text was ${JSON.stringify(scientificTextFlowResult.layout.value?.extractedText ?? null)}.`,
);
assert(
  scientificTextFlowResult.knowledge.value?.chunks[0]?.text ===
    "Dense retrieval, which describes the use of contextualised language models such as BERT, is represented here.\n\nSecond paragraph starts here.",
  `Scientific text-flow knowledge text was ${JSON.stringify(scientificTextFlowResult.knowledge.value?.chunks[0]?.text ?? null)}.`,
);
assert(
  sectionHeadingResult.layout.value?.pages[0]?.blocks[0]?.text === "1 INTRODUCTION Retrieval Architecture",
  `Section-heading layout text was ${JSON.stringify(sectionHeadingResult.layout.value?.pages[0]?.blocks[0]?.text ?? null)}.`,
);
assert(
  sectionHeadingResult.layout.value?.pages[0]?.blocks[0]?.role === "heading",
  `Section-heading layout role was ${sectionHeadingResult.layout.value?.pages[0]?.blocks[0]?.role ?? "missing"}.`,
);
assert(
  sectionHeadingResult.layout.value?.pages[0]?.blocks[1]?.text ===
    "Search engine architectures often follow a cascading architecture.",
  `Section-heading first body block was ${JSON.stringify(sectionHeadingResult.layout.value?.pages[0]?.blocks[1]?.text ?? null)}.`,
);
assert(
  sectionHeadingResult.layout.value?.pages[0]?.blocks[2]?.startsParagraph === true,
  "Section-heading second body block was not marked as a paragraph start.",
);
assert(
  coverMatterResult.layout.value?.pages[0]?.blocks[0]?.role === "heading",
  `Cover-matter title role was ${coverMatterResult.layout.value?.pages[0]?.blocks[0]?.role ?? "missing"}.`,
);
assert(
  coverMatterResult.layout.value?.pages[0]?.blocks[1]?.role === "heading",
  `Cover-matter date role was ${coverMatterResult.layout.value?.pages[0]?.blocks[1]?.role ?? "missing"}.`,
);
assert(
  coverMatterResult.layout.value?.pages[0]?.blocks[2]?.role === "body",
  `Cover-matter body role was ${coverMatterResult.layout.value?.pages[0]?.blocks[2]?.role ?? "missing"}.`,
);
assert(
  numberedBodyResult.layout.value?.pages[0]?.blocks[0]?.role === "heading",
  `Numbered-body title role was ${numberedBodyResult.layout.value?.pages[0]?.blocks[0]?.role ?? "missing"}.`,
);
assert(
  numberedBodyResult.layout.value?.pages[0]?.blocks[1]?.role === "body",
  `Numbered-body first paragraph role was ${numberedBodyResult.layout.value?.pages[0]?.blocks[1]?.role ?? "missing"}.`,
);
assert(
  numberedBodyResult.layout.value?.pages[0]?.blocks[2]?.role === "body",
  `Numbered-body second paragraph role was ${numberedBodyResult.layout.value?.pages[0]?.blocks[2]?.role ?? "missing"}.`,
);
assert(
  continuedNumberedBodyResult.observation.value?.extractedText ===
    "Introduction\n\n1.\n\nThis is a numbered body paragraph that should stay in the body flow even when it wraps onto a second line without becoming a new paragraph.\n\n2. Another numbered body paragraph follows as a separate paragraph.",
  `Continued numbered-body observation text was ${JSON.stringify(continuedNumberedBodyResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  continuedNumberedBodyResult.layout.value?.pages[0]?.blocks[1]?.startsParagraph === true &&
    continuedNumberedBodyResult.layout.value?.pages[0]?.blocks[2]?.startsParagraph === false &&
    continuedNumberedBodyResult.layout.value?.pages[0]?.blocks[3]?.startsParagraph === true,
  "Continued numbered-body paragraph boundaries were not preserved across the wrapped body lines.",
);
assert(
  continuedNumberedBodyResult.layout.value?.extractedText ===
    "Introduction\n\n1. This is a numbered body paragraph that should stay in the body flow even when it wraps onto a second line without becoming a new paragraph.\n\n2. Another numbered body paragraph follows as a separate paragraph.",
  `Continued numbered-body layout text was ${JSON.stringify(continuedNumberedBodyResult.layout.value?.extractedText ?? null)}.`,
);
assert(
  contentsNoiseResult.layout.value?.extractedText === "Contents\n\nIntroduction\n\nInstallation",
  `Contents-noise layout text was ${JSON.stringify(contentsNoiseResult.layout.value?.extractedText ?? null)}.`,
);
assert(
  standaloneBulletResult.layout.value?.extractedText ===
    "Read this first.\n\nIf you have questions, ask your doctor.",
  `Standalone-bullet layout text was ${JSON.stringify(standaloneBulletResult.layout.value?.extractedText ?? null)}.`,
);
assert(
  buildTraceParagraphResult.layout.value?.extractedText.includes("Page 1 of 1\n\npdfcpu: v0.4.1 dev"),
  `Build-trace paragraph layout text was ${JSON.stringify(buildTraceParagraphResult.layout.value?.extractedText ?? null)}.`,
);
assert(
  (buildTraceParagraphResult.layout.value?.pages[0]?.blocks ?? []).some(
    (block) => block.text.includes("pdfcpu: v0.4.1 dev") && block.startsParagraph === true,
  ),
  `Build-trace paragraph blocks were ${JSON.stringify(buildTraceParagraphResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, startsParagraph: block.startsParagraph })) ?? null)}.`,
);
assert(
  compactLabelClusterResult.layout.value?.pages[0]?.blocks[1]?.role === "body",
  `Compact label-cluster body role was ${compactLabelClusterResult.layout.value?.pages[0]?.blocks[1]?.role ?? "missing"}.`,
);
assert(
  repeatedFormBoundaryResult.layout.value?.pages[0]?.blocks[0]?.role === "body",
  `Repeated form boundary header role was ${repeatedFormBoundaryResult.layout.value?.pages[0]?.blocks[0]?.role ?? "missing"}.`,
);
assert(
  repeatedFormBoundaryResult.layout.value?.pages[0]?.blocks.at(-1)?.role === "body",
  `Repeated form boundary footer role was ${repeatedFormBoundaryResult.layout.value?.pages[0]?.blocks.at(-1)?.role ?? "missing"}.`,
);
assert(
  repeatedFormBoundaryResult.knowledge.value?.extractedText.includes("Source:"),
  `Repeated form boundary knowledge text was ${JSON.stringify(repeatedFormBoundaryResult.knowledge.value?.extractedText ?? null)}.`,
);
assert(
  repeatedFormBoundaryResult.knowledge.value?.extractedText.includes("female male non-binary Gender:"),
  `Repeated form boundary knowledge text was ${JSON.stringify(repeatedFormBoundaryResult.knowledge.value?.extractedText ?? null)}.`,
);
assert(
  (fieldLabelFormResult.layout.value?.pages[0]?.blocks ?? []).some(
    (block) => block.role === "body" && block.text.includes("First Name:") && block.text.includes("Last Name:"),
  ),
  `Field-label form rows were ${JSON.stringify(fieldLabelFormResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  (fieldLabelFormResult.layout.value?.pages[0]?.blocks ?? []).some(
    (block) => block.role === "body" && block.text.includes("Gender:"),
  ),
  `Field-label gender role was ${JSON.stringify(fieldLabelFormResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  findBlockRole(numberedPromptRoleResult.layout.value?.pages[0]?.blocks ?? [], "1) Please tell us about yourself:") === "list" &&
    findBlockRole(numberedPromptRoleResult.layout.value?.pages[0]?.blocks ?? [], "2) How did you hear about pdfcpu:") === "list",
  `Numbered prompt roles were ${JSON.stringify(numberedPromptRoleResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  findBlockRole(inlineNarrativeHeadingResult.layout.value?.pages[0]?.blocks ?? [], "The Yankee Lookout.") === "heading",
  `Inline narrative heading role was ${JSON.stringify(inlineNarrativeHeadingResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  findBlockRole(fieldValueRowResult.layout.value?.pages[0]?.blocks ?? [], "MBL-SF424Family-AllForms") === "body" &&
    findBlockRole(fieldValueRowResult.layout.value?.pages[0]?.blocks ?? [], "ABC-123") === "body",
  `Field-value row roles were ${JSON.stringify(fieldValueRowResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  fieldLabelFormResult.knowledge.value?.tables.length === 1,
  `Field-label form projection emitted ${String(fieldLabelFormResult.knowledge.value?.tables.length ?? "missing")} tables.`,
);
assert(
  fieldLabelFormResult.knowledge.value?.tables[0]?.heuristic === "field-label-form",
  `Field-label form heuristic was ${fieldLabelFormResult.knowledge.value?.tables[0]?.heuristic ?? "missing"}.`,
);
assert(
  fieldLabelFormResult.knowledge.value?.tables[0]?.headers?.join(",") === "Person Of Impact",
  `Field-label form headers were ${JSON.stringify(fieldLabelFormResult.knowledge.value?.tables[0]?.headers ?? null)}.`,
);
assert(
  fieldLabelFormResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.columnIndex === 0 && cell.text === "First Name:",
  ),
  "Field-label form projection did not recover the first field label.",
);
assert(
  fieldLabelFormResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.columnIndex === 0 && cell.text === "Agree to privacy policy",
  ),
  "Field-label form projection did not recover the privacy field label.",
);
assert(
  fieldLabelFormResult.knowledge.value?.tables[0]?.cells.every((cell) => cell.citations.length > 0),
  "Field-label form projection emitted a cell without citations.",
);
assert(
  contractAwardTableResult.knowledge.value?.tables.length === 1,
  `Contract-award projection emitted ${String(contractAwardTableResult.knowledge.value?.tables.length ?? "missing")} tables.`,
);
assert(
  contractAwardTableResult.knowledge.value?.tables[0]?.heuristic === "contract-award-sequence",
  `Contract-award heuristic was ${contractAwardTableResult.knowledge.value?.tables[0]?.heuristic ?? "missing"}.`,
);
assert(
  contractAwardTableResult.knowledge.value?.tables[0]?.headers?.join(",") ===
    "Serial No.,Contract Description,Contractor,Amount,Remarks",
  `Contract-award headers were ${JSON.stringify(contractAwardTableResult.knowledge.value?.tables[0]?.headers ?? null)}.`,
);
assert(
  contractAwardTableResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.rowIndex === 1 && cell.columnIndex === 2 && cell.text === "ICB Comicel Limited",
  ),
  "Contract-award projection did not recover the first contractor cell.",
);
assert(
  contractAwardTableResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.rowIndex === 3 && cell.columnIndex === 3 && cell.text === "244,950.00 GHS",
  ),
  "Contract-award projection did not recover the final amount cell.",
);
assert(
  !contractAwardTableResult.knowledge.value?.tables.some((table) => table.heuristic === "field-label-form"),
  "Contract-award projection still emitted a field-label form false positive.",
);
assert(
  contractAwardTableResult.knowledge.value?.tables[0]?.cells.every((cell) => cell.citations.length > 0),
  "Contract-award projection emitted a cell without citations.",
);
assert(
  contractAwardTableResult.knowledge.value?.extractedText.includes(
    "Serial No. | Contract Description | Contractor | Amount | Remarks",
  ),
  `Contract-award knowledge text was ${JSON.stringify(contractAwardTableResult.knowledge.value?.extractedText ?? null)}.`,
);
assert(
  (contractAwardTableResult.knowledge.value?.extractedText.indexOf("Procurement of Traffic Engineering") ?? -1) <
    (contractAwardTableResult.knowledge.value?.extractedText.indexOf("Procurement of Software") ?? -1) &&
    (contractAwardTableResult.knowledge.value?.extractedText.indexOf("Procurement of Software") ?? -1) <
      (contractAwardTableResult.knowledge.value?.extractedText.indexOf("Production of Road Safety Posters") ?? -1),
  `Contract-award knowledge ordering was ${JSON.stringify(contractAwardTableResult.knowledge.value?.extractedText ?? null)}.`,
);
assert(
  regulatoryTextRecoveryResult.observation.value?.extractedText === "Introduction Readable text",
  `Regulatory observation text was ${JSON.stringify(regulatoryTextRecoveryResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  regulatoryTextRecoveryResult.layout.value?.extractedText === "Introduction Readable text",
  `Regulatory layout text was ${JSON.stringify(regulatoryTextRecoveryResult.layout.value?.extractedText ?? null)}.`,
);
assert(
  regulatoryTextRecoveryResult.knowledge.value?.chunks[0]?.text === "Introduction Readable text",
  `Regulatory knowledge text was ${JSON.stringify(regulatoryTextRecoveryResult.knowledge.value?.chunks[0]?.text ?? null)}.`,
);
assert(
  regulatoryTextRecoveryResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource === "actual-text",
  `Regulatory actual-text mapping source was ${regulatoryTextRecoveryResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource ?? "missing"}.`,
);
assert(
  regulatoryTextRecoveryResult.observation.value?.knownLimits.includes("literal-font-encoding-not-implemented"),
  "Regulatory observation known limits did not include literal-font-encoding-not-implemented.",
);
assert(
  !hasUnreadableControlCharacters(regulatoryTextRecoveryResult.observation.value?.extractedText ?? ""),
  `Regulatory observation text still contained unreadable control characters: ${JSON.stringify(regulatoryTextRecoveryResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  regulatoryLayoutFlowResult.observation.value?.extractedText ===
    "REGULATORY COVER TITLE\n\nBody text appears first in stream order.\n\n1. What is Example?\n\nBody paragraph starts here.",
  `Regulatory layout-flow observation text was ${JSON.stringify(regulatoryLayoutFlowResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  regulatoryLayoutFlowResult.layout.value?.pages[0]?.blocks[0]?.text === "REGULATORY COVER TITLE",
  `Regulatory layout-flow first block was ${JSON.stringify(regulatoryLayoutFlowResult.layout.value?.pages[0]?.blocks[0]?.text ?? null)}.`,
);
assert(
  regulatoryLayoutFlowResult.layout.value?.pages[0]?.blocks[2]?.text === "1. What is Example?",
  `Regulatory layout-flow heading block was ${JSON.stringify(regulatoryLayoutFlowResult.layout.value?.pages[0]?.blocks[2]?.text ?? null)}.`,
);
assert(
  regulatoryLayoutFlowResult.layout.value?.pages[0]?.blocks[2]?.role === "heading",
  `Regulatory layout-flow heading role was ${JSON.stringify(regulatoryLayoutFlowResult.layout.value?.pages[0]?.blocks[2]?.role ?? null)}.`,
);
assert(
  regulatoryLayoutFlowResult.layout.value?.pages[0]?.blocks[3]?.text === "Body paragraph starts here.",
  `Regulatory layout-flow body block was ${JSON.stringify(regulatoryLayoutFlowResult.layout.value?.pages[0]?.blocks[3]?.text ?? null)}.`,
);
assert(
  regulatoryLayoutFlowResult.layout.value?.pages[0]?.blocks[3]?.startsParagraph === true,
  "Regulatory layout-flow body block was not marked as a paragraph start after the heading block.",
);
assert(
  gridTableResult.knowledge.value?.tables.length === 1,
  `Grid table projection emitted ${String(gridTableResult.knowledge.value?.tables.length ?? "missing")} tables.`,
);
assert(
  gridTableResult.knowledge.value?.tables[0]?.heuristic === "layout-grid",
  `Grid table heuristic was ${gridTableResult.knowledge.value?.tables[0]?.heuristic ?? "missing"}.`,
);
assert(
  gridTableResult.knowledge.value?.tables[0]?.headers?.join(",") === "Quarter,Revenue,Profit",
  `Grid table headers were ${JSON.stringify(gridTableResult.knowledge.value?.tables[0]?.headers ?? null)}.`,
);
assert(
  gridTableResult.knowledge.value?.tables[0]?.cells.some((cell) => cell.rowIndex === 1 && cell.columnIndex === 1 && cell.text === "$10"),
  "Grid table projection did not preserve the Q1 revenue cell.",
);
assert(
  gridTableResult.knowledge.value?.tables[0]?.cells.every((cell) => cell.citations.length > 0),
  "Grid table projection emitted a cell without citations.",
);
assert(
  denseGridTableResult.knowledge.value?.tables.length === 1,
  `Dense grid table projection emitted ${String(denseGridTableResult.knowledge.value?.tables.length ?? "missing")} tables.`,
);
assert(
  denseGridTableResult.knowledge.value?.tables[0]?.headers?.join(",") === "Code,Label,Amount",
  `Dense grid table headers were ${JSON.stringify(denseGridTableResult.knowledge.value?.tables[0]?.headers ?? null)}.`,
);
assert(
  denseGridTableResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.rowIndex === 1 && cell.columnIndex === 1 && cell.text === "Base Salary",
  ),
  "Dense grid table projection did not preserve the Base Salary row.",
);
assert(
  denseGridTableResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.rowIndex === 2 && cell.columnIndex === 1 && cell.text === "Hours 25%",
  ),
  "Dense grid table projection did not preserve the Hours 25% row.",
);
assert(
  gridTableResult.knowledge.value?.knownLimits.includes("table-projection-heuristic"),
  "Grid table knowledge known limits did not include table-projection-heuristic.",
);
assert(
  !gridTableResult.knowledge.value?.knownLimits.includes("table-projection-not-implemented"),
  "Grid table knowledge known limits still included table-projection-not-implemented.",
);
assert(
  rowSequenceTableResult.knowledge.value?.tables.length === 1,
  `Row-sequence table projection emitted ${String(rowSequenceTableResult.knowledge.value?.tables.length ?? "missing")} tables.`,
);
assert(
  rowSequenceTableResult.knowledge.value?.tables[0]?.heuristic === "row-sequence",
  `Row-sequence table heuristic was ${rowSequenceTableResult.knowledge.value?.tables[0]?.heuristic ?? "missing"}.`,
);
assert(
  rowSequenceTableResult.knowledge.value?.tables[0]?.headers?.join(",") === "Quarter,Item,Revenue,Profit",
  `Row-sequence table headers were ${JSON.stringify(rowSequenceTableResult.knowledge.value?.tables[0]?.headers ?? null)}.`,
);
assert(
  rowSequenceTableResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.rowIndex === 2 && cell.columnIndex === 1 && cell.text === "Beta",
  ),
  "Row-sequence table projection did not preserve the Beta row.",
);
assert(
  rowSequenceTableResult.knowledge.value?.tables[0]?.cells.every((cell) => cell.citations.length > 0),
  "Row-sequence table projection emitted a cell without citations.",
);
assert(
  stackedHeaderTableResult.knowledge.value?.tables.length === 1,
  `Stacked-header table projection emitted ${String(stackedHeaderTableResult.knowledge.value?.tables.length ?? "missing")} tables.`,
);
assert(
  stackedHeaderTableResult.knowledge.value?.tables[0]?.heuristic === "stacked-header-sequence",
  `Stacked-header table heuristic was ${stackedHeaderTableResult.knowledge.value?.tables[0]?.heuristic ?? "missing"}.`,
);
assert(
  stackedHeaderTableResult.knowledge.value?.tables[0]?.headers?.join(",") === "Qty,Description with linebreak,Price,Amount",
  `Stacked-header table headers were ${JSON.stringify(stackedHeaderTableResult.knowledge.value?.tables[0]?.headers ?? null)}.`,
);
assert(
  stackedHeaderTableResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.rowIndex === 2 && cell.columnIndex === 1 && cell.text === "Unicorn",
  ),
  "Stacked-header table projection did not preserve the Unicorn row.",
);
assert(
  stackedHeaderTableResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.rowIndex === 3 && cell.columnIndex === 2 && cell.text === "(priceless)",
  ),
  "Stacked-header table projection did not preserve the final price cell.",
);
assert(
  fieldValueFormResult.knowledge.value?.tables.length === 1,
  `Field-value form projection emitted ${String(fieldValueFormResult.knowledge.value?.tables.length ?? "missing")} tables.`,
);
assert(
  fieldValueFormResult.knowledge.value?.tables[0]?.heuristic === "field-value-form",
  `Field-value form heuristic was ${fieldValueFormResult.knowledge.value?.tables[0]?.heuristic ?? "missing"}.`,
);
assert(
  fieldValueFormResult.knowledge.value?.tables[0]?.headers?.join(",") === "Field,Value",
  `Field-value form headers were ${JSON.stringify(fieldValueFormResult.knowledge.value?.tables[0]?.headers ?? null)}.`,
);
assert(
  fieldValueFormResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.rowIndex === 1 && cell.columnIndex === 0 && cell.text === "10. Name of Federal Agency",
  ),
  "Field-value form projection did not recover the agency field label.",
);
assert(
  fieldValueFormResult.knowledge.value?.tables[0]?.cells.some(
    (cell) => cell.rowIndex === 3 && cell.columnIndex === 1 && cell.text === "MBL-SF424Family-AllForms",
  ),
  "Field-value form projection did not recover the final field value.",
);
assert(
  fieldValueFalsePositiveResult.knowledge.value?.tables.length === 0,
  `Field-value false-positive projection emitted ${String(fieldValueFalsePositiveResult.knowledge.value?.tables.length ?? "missing")} tables.`,
);
assert(
  tableRowRoleResult.layout.value?.pages[0]?.blocks.find((block) => block.text === "Qty")?.role === "heading",
  `Table-row header role was ${tableRowRoleResult.layout.value?.pages[0]?.blocks.find((block) => block.text === "Qty")?.role ?? "missing"}.`,
);
assert(
  tableRowRoleResult.layout.value?.pages[0]?.blocks.find((block) => block.text === "Mouse")?.role === "body",
  `Table-row first descriptor role was ${tableRowRoleResult.layout.value?.pages[0]?.blocks.find((block) => block.text === "Mouse")?.role ?? "missing"}.`,
);
assert(
  tableRowRoleResult.layout.value?.pages[0]?.blocks.find((block) => block.text === "Unicorn")?.role === "body",
  `Table-row second descriptor role was ${tableRowRoleResult.layout.value?.pages[0]?.blocks.find((block) => block.text === "Unicorn")?.role ?? "missing"}.`,
);
assert(
  findBlockRole(contentsEntryRoleResult.layout.value?.pages[0]?.blocks ?? [], "Introduction") === "heading" &&
    findBlockRole(contentsEntryRoleResult.layout.value?.pages[0]?.blocks ?? [], "Installation") === "heading",
  `Contents-entry roles were ${JSON.stringify(contentsEntryRoleResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  legalMetadataRoleResult.layout.value?.pages[0]?.blocks[0]?.role === "heading" &&
    legalMetadataRoleResult.layout.value?.pages[0]?.blocks[0]?.text.includes("Neutral Citation Number: [2017] EWHC 3175 (IPEC)"),
  `Legal-metadata roles were ${JSON.stringify(legalMetadataRoleResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  spacedLegalMetadataRoleResult.layout.value?.pages[0]?.blocks[0]?.role === "heading" &&
    spacedLegalMetadataRoleResult.layout.value?.pages[0]?.blocks[0]?.text.includes("Neut ral Cit at ion Number"),
  `Spaced legal-metadata roles were ${JSON.stringify(spacedLegalMetadataRoleResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  (metricHeadingRoleResult.layout.value?.pages[0]?.blocks ?? []).some(
    (block) => block.role === "heading" && block.text.includes("2024 Generating Capacity"),
  ),
  `Metric-heading roles were ${JSON.stringify(metricHeadingRoleResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  findBlockRole(smallTableHeaderRoleResult.layout.value?.pages[0]?.blocks ?? [], "Rub") === "heading" &&
    findBlockRole(smallTableHeaderRoleResult.layout.value?.pages[0]?.blocks ?? [], "Libelle") === "heading" &&
    findBlockRole(smallTableHeaderRoleResult.layout.value?.pages[0]?.blocks ?? [], "Base ou Nombre") === "heading" &&
    findBlockRole(smallTableHeaderRoleResult.layout.value?.pages[0]?.blocks ?? [], "Taux") === "heading",
  `Small-table header roles were ${JSON.stringify(smallTableHeaderRoleResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  (repeatedFieldGroupHeadingResult.layout.value?.pages[0]?.blocks ?? []).some(
    (block) => block.role === "heading" && block.text.includes("Type of Applicant 2: Select Applicant Type:"),
  ) &&
    findBlockRole(repeatedFieldGroupHeadingResult.layout.value?.pages[0]?.blocks ?? [], "Type of Applicant 3: Select Applicant Type:") === "heading" &&
    findBlockRole(repeatedFieldGroupHeadingResult.layout.value?.pages[0]?.blocks ?? [], "* Other (specify):") === "heading",
  `Repeated field-group roles were ${JSON.stringify(repeatedFieldGroupHeadingResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
);
assert(
  (leafletTitleRoleResult.layout.value?.pages[0]?.blocks ?? []).some(
    (block) => block.role === "heading" &&
      block.text.includes("GEBRAUCHSINFORMATION: INFORMATION") &&
      block.text.includes("Example Product 6 mg/ml"),
  ),
  `Leaflet-title roles were ${JSON.stringify(leafletTitleRoleResult.layout.value?.pages[0]?.blocks?.map((block) => ({ text: block.text, role: block.role })) ?? null)}.`,
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
  asciiHexResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamDecodeState === "decoded",
  "ASCIIHex stream was not marked as decoded.",
);
assert(
  asciiHexResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamFilterNames?.join(",") ===
    "ASCIIHexDecode",
  `Unexpected ASCIIHex stream filters: ${asciiHexResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamFilterNames?.join(",") ?? "missing"}.`,
);
assert(
  asciiHexResult.observation.value?.extractedText === "ASCIIHEX Hello",
  `Unexpected ASCIIHex extracted text: ${JSON.stringify(asciiHexResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  ascii85Result.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamDecodeState === "decoded",
  "ASCII85 stream was not marked as decoded.",
);
assert(
  ascii85Result.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamFilterNames?.join(",") ===
    "ASCII85Decode",
  `Unexpected ASCII85 stream filters: ${ascii85Result.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamFilterNames?.join(",") ?? "missing"}.`,
);
assert(
  ascii85Result.observation.value?.extractedText === "ASCII85 Hello",
  `Unexpected ASCII85 extracted text: ${JSON.stringify(ascii85Result.observation.value?.extractedText ?? null)}.`,
);
assert(
  runLengthResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamDecodeState === "decoded",
  "RunLength stream was not marked as decoded.",
);
assert(
  runLengthResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamFilterNames?.join(",") ===
    "RunLengthDecode",
  `Unexpected RunLength stream filters: ${runLengthResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamFilterNames?.join(",") ?? "missing"}.`,
);
assert(
  runLengthResult.observation.value?.extractedText === "RunLength Hello",
  `Unexpected RunLength extracted text: ${JSON.stringify(runLengthResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  chainedFilterResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamDecodeState === "decoded",
  "Chained-filter stream was not marked as decoded.",
);
assert(
  chainedFilterResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamFilterNames?.join(",") ===
    "ASCII85Decode,FlateDecode",
  `Unexpected chained stream filters: ${chainedFilterResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamFilterNames?.join(",") ?? "missing"}.`,
);
assert(
  chainedFilterResult.observation.value?.extractedText === "Chained Hello",
  `Unexpected chained-filter extracted text: ${JSON.stringify(chainedFilterResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  predictorResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 4)?.streamDecodeState === "decoded",
  "Predictor stream was not marked as decoded.",
);
assert(
  predictorResult.observation.value?.extractedText === "Predictor Hello",
  `Unexpected predictor extracted text: ${JSON.stringify(predictorResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  chainedPredictorDecodeResult.state === "decoded",
  `Chained predictor decoder state was ${chainedPredictorDecodeResult.state}.`,
);
assert(
  new TextDecoder().decode(chainedPredictorDecodeResult.decodedBytes ?? new Uint8Array()) === "BT\n(Predictor Hello) Tj\nET",
  "Chained predictor decoder did not reconstruct the original content stream bytes.",
);
assert(
  ccittDecodeResult.state === "decoded",
  `CCITT decoder state was ${ccittDecodeResult.state}.`,
);
assert(
  Array.from(ccittDecodeResult.decodedBytes ?? []).map((byte) => byte.toString(16).padStart(2, "0")).join("") === "aa",
  "CCITT decoder did not recover the expected packed bitmap byte.",
);
assert(
  lzwDecodeResult.state === "decoded",
  `LZW decoder state was ${lzwDecodeResult.state}.`,
);
assert(
  new TextDecoder().decode(lzwDecodeResult.decodedBytes ?? new Uint8Array()).includes("beginbfchar"),
  "LZW decoder did not recover the expected ToUnicode CMap text.",
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
  toUnicodeLzwResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamRole === "tounicode",
  "LZW ToUnicode stream role was not classified as tounicode.",
);
assert(
  toUnicodeLzwResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamDecodeState === "decoded",
  `LZW ToUnicode stream decode state was ${toUnicodeLzwResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamDecodeState ?? "missing"}.`,
);
assert(
  toUnicodeLzwResult.observation.value?.extractedText === "Hello!",
  `Unexpected LZW ToUnicode extracted text: ${JSON.stringify(toUnicodeLzwResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  !toUnicodeLzwResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
  "LZW ToUnicode observation still reported font-unicode-mapping-not-implemented.",
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
assert(
  ignoredFunctionStreamResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 5)
    ?.streamDecodeState === "failed",
  `Ignored function stream decode state was ${ignoredFunctionStreamResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 5)?.streamDecodeState ?? "missing"}.`,
);
assert(
  ignoredFunctionStreamResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 5)
    ?.streamRole === "unknown",
  `Ignored function stream role was ${ignoredFunctionStreamResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 5)?.streamRole ?? "missing"}.`,
);
assert(
  !ignoredFunctionStreamResult.ir.value?.knownLimits.includes("streams-not-decoded"),
  "Ignored function stream still reported streams-not-decoded.",
);
assert(
  !ignoredFunctionStreamResult.ir.value?.knownLimits.includes("stream-decoding-failed"),
  "Ignored function stream still reported stream-decoding-failed.",
);
assert(
  ignoredFunctionStreamResult.observation.value?.extractedText === "Parser Safe",
  `Unexpected ignored function-stream extraction: ${JSON.stringify(ignoredFunctionStreamResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  !ignoredFunctionStreamResult.observation.value?.knownLimits.includes("streams-not-decoded"),
  "Ignored function stream observation still reported streams-not-decoded.",
);
assert(
  !ignoredFunctionStreamResult.observation.value?.knownLimits.includes("stream-decoding-failed"),
  "Ignored function stream observation still reported stream-decoding-failed.",
);
assert(
  cidToUnicodeResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamRole === "tounicode",
  "CID ToUnicode stream role was not classified as tounicode.",
);
assert(
  cidToUnicodeResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamDecodeState === "decoded",
  `CID ToUnicode stream decode state was ${cidToUnicodeResult.ir.value?.indirectObjects.find((objectShell) => objectShell.ref.objectNumber === 6)?.streamDecodeState ?? "missing"}.`,
);
assert(
  cidToUnicodeResult.observation.status === "completed",
  `CID ToUnicode observation status was ${cidToUnicodeResult.observation.status}.`,
);
assert(
  cidToUnicodeResult.observation.value?.extractedText === "ﺔﻴﺑﺮﻌﻟا",
  `Unexpected CID ToUnicode extracted text: ${JSON.stringify(cidToUnicodeResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  !cidToUnicodeResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
  "CID ToUnicode observation still reported font-unicode-mapping-not-implemented.",
);
assert(
  cidToUnicodeResult.observation.value?.pages[0]?.runs[0]?.textEncodingKind === "cid",
  `CID ToUnicode text encoding kind was ${cidToUnicodeResult.observation.value?.pages[0]?.runs[0]?.textEncodingKind ?? "missing"}.`,
);
for (const marker of publicSmokeFixtures.identityHCidFont.expectedMarkers) {
  assert(
    identityHCidFontResult.observation.value?.extractedText.includes(marker),
    `Identity-H fixture did not include marker ${JSON.stringify(marker)}.`,
  );
}
assert(
  identityHCidFontResult.observation.value?.pages.some((page) =>
    page.runs.some((run) => run.unicodeMappingSource === "cid-collection-ucs2"),
  ),
  "Identity-H fixture did not preserve cid-collection-ucs2 provenance on observed runs.",
);
assert(
  !identityHCidFontResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
  "Identity-H fixture still reported font-unicode-mapping-not-implemented.",
);
assert(
  identityHCidFontResult.observation.value?.pages.some((page) =>
    page.runs.some((run) => run.textEncodingKind === "cid"),
  ),
  "Identity-H fixture did not preserve cid text encoding on observed runs.",
);
for (const marker of publicSmokeFixtures.identityVCidFont.expectedMarkers) {
  assert(
    identityVCidFontResult.observation.value?.extractedText.includes(marker),
    `Identity-V fixture did not include marker ${JSON.stringify(marker)}.`,
  );
}
assert(
  identityVCidFontResult.observation.value?.pages.some((page) =>
    page.runs.some((run) => run.unicodeMappingSource === "cid-collection-ucs2"),
  ),
  "Identity-V fixture did not preserve cid-collection-ucs2 provenance on observed runs.",
);
assert(
  !identityVCidFontResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
  "Identity-V fixture still reported font-unicode-mapping-not-implemented.",
);
assert(
  identityVCidFontResult.observation.value?.pages.some((page) =>
    page.runs.some((run) => run.textEncodingKind === "cid"),
  ),
  "Identity-V fixture did not preserve cid text encoding on observed runs.",
);
assert(
  verticalWordColumnsResult.observation.value?.pages[0]?.runs.every((run) => run.writingMode === "vertical"),
  "Vertical word columns fixture did not mark observed runs as vertical.",
);
assert(
  verticalWordColumnsResult.layout.value?.pages[0]?.blocks.every((block) => block.writingMode === "vertical"),
  "Vertical word columns fixture did not mark layout blocks as vertical.",
);
assert(
  verticalWordColumnsResult.layout.value?.pages[0]?.blocks.map((block) => block.text).join(" ") === "Layout Vertical Test",
  `Unexpected vertical word column order: ${JSON.stringify(verticalWordColumnsResult.layout.value?.pages[0]?.blocks.map((block) => block.text) ?? null)}.`,
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
assert(
  !noFontCidLikeHexResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
  "No-font CID-like hex observation still reported font-unicode-mapping-not-implemented.",
);
assert(
  !noFontCidLikeHexResult.observation.diagnostics.some((diagnostic) => diagnostic.code === "font-unicode-mapping-not-implemented"),
  "No-font CID-like hex observation still surfaced font-unicode-mapping-not-implemented.",
);
assert(
  !noFontControlHexResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
  "No-font control hex observation still reported font-unicode-mapping-not-implemented.",
);
assert(
  !noFontControlHexResult.observation.diagnostics.some((diagnostic) => diagnostic.code === "font-unicode-mapping-not-implemented"),
  "No-font control hex observation still surfaced font-unicode-mapping-not-implemented.",
);
assert(
  singleByteEncodedTextResult.observation.status === "completed",
  `Single-byte encoded-text observation status was ${singleByteEncodedTextResult.observation.status}.`,
);
assert(
  singleByteEncodedTextResult.observation.value?.extractedText === "Encoded Text",
  `Unexpected single-byte encoded-text extraction: ${JSON.stringify(singleByteEncodedTextResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  singleByteEncodedTextResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource === "font-encoding",
  `Unexpected single-byte unicode mapping source: ${JSON.stringify(singleByteEncodedTextResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource ?? null)}.`,
);
assert(
  !singleByteEncodedTextResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
  "Single-byte encoded-text observation still reported font-unicode-mapping-not-implemented.",
);
assert(
  ligatureEncodedTextResult.observation.status === "completed",
  `Ligature encoded-text observation status was ${ligatureEncodedTextResult.observation.status}.`,
);
assert(
  ligatureEncodedTextResult.observation.value?.extractedText === "ff ffi fi fl",
  `Unexpected ligature encoded-text extraction: ${JSON.stringify(ligatureEncodedTextResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  ligatureEncodedTextResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource === "font-encoding",
  `Unexpected ligature unicode mapping source: ${JSON.stringify(ligatureEncodedTextResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource ?? null)}.`,
);
assert(
  !ligatureEncodedTextResult.observation.value?.knownLimits.includes("literal-font-encoding-not-implemented"),
  "Ligature encoded-text observation still reported literal-font-encoding-not-implemented.",
);
assert(
  extendedNamedGlyphResult.observation.status === "completed",
  `Extended named-glyph observation status was ${extendedNamedGlyphResult.observation.status}.`,
);
assert(
  extendedNamedGlyphResult.observation.value?.extractedText === "Ă Č Ğ",
  `Unexpected extended named-glyph extraction: ${JSON.stringify(extendedNamedGlyphResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  extendedNamedGlyphResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource === "font-encoding",
  `Unexpected extended named-glyph unicode mapping source: ${JSON.stringify(extendedNamedGlyphResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource ?? null)}.`,
);
assert(
  !extendedNamedGlyphResult.observation.value?.knownLimits.includes("literal-font-encoding-not-implemented"),
  "Extended named-glyph observation still reported literal-font-encoding-not-implemented.",
);
assert(
  commonSymbolGlyphResult.observation.status === "completed",
  `Common symbol-glyph observation status was ${commonSymbolGlyphResult.observation.status}.`,
);
assert(
  commonSymbolGlyphResult.observation.value?.extractedText === "π Ω ≥ ∫ ≈ →",
  `Unexpected common symbol-glyph extraction: ${JSON.stringify(commonSymbolGlyphResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  commonSymbolGlyphResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource === "font-encoding",
  `Unexpected common symbol-glyph unicode mapping source: ${JSON.stringify(commonSymbolGlyphResult.observation.value?.pages[0]?.runs[0]?.unicodeMappingSource ?? null)}.`,
);
assert(
  !commonSymbolGlyphResult.observation.value?.knownLimits.includes("literal-font-encoding-not-implemented"),
  "Common symbol-glyph observation still reported literal-font-encoding-not-implemented.",
);
assert(
  partialSingleByteEncodedTextResult.observation.status === "completed",
  `Partial single-byte encoded-text observation status was ${partialSingleByteEncodedTextResult.observation.status}.`,
);
assert(
  partialSingleByteEncodedTextResult.observation.value?.extractedText === "Almost done",
  `Unexpected partial single-byte encoded-text extraction: ${JSON.stringify(partialSingleByteEncodedTextResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  !partialSingleByteEncodedTextResult.observation.value?.knownLimits.includes("font-unicode-mapping-not-implemented"),
  "Partial single-byte encoded-text observation still reported font-unicode-mapping-not-implemented.",
);
assert(
  compactSpacingEncodedTextResult.observation.status === "completed",
  `Compact-spacing encoded-text observation status was ${compactSpacingEncodedTextResult.observation.status}.`,
);
assert(
  compactSpacingEncodedTextResult.observation.value?.extractedText === "Hello World",
  `Unexpected compact-spacing encoded-text extraction: ${JSON.stringify(compactSpacingEncodedTextResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  !compactSpacingEncodedTextResult.observation.value?.knownLimits.includes("literal-font-encoding-not-implemented"),
  "Compact-spacing encoded-text observation still reported literal-font-encoding-not-implemented.",
);
assert(
  delayedContentResult.ir.value?.pages[0]?.contentStreamRefs[0]?.objectNumber === 4,
  `Delayed-content IR did not recover the content stream ref: ${JSON.stringify(delayedContentResult.ir.value?.pages[0]?.contentStreamRefs ?? null)}.`,
);
assert(
  delayedContentResult.observation.value?.pages[0]?.resolutionMethod === "page-tree",
  "Delayed-content observation did not preserve page-tree ordering.",
);
assert(
  delayedContentResult.observation.value?.extractedText === "Delayed Content",
  `Unexpected delayed-content extraction: ${JSON.stringify(delayedContentResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  streamBoundaryResult.ir.value?.pages[0]?.contentStreamRefs[0]?.objectNumber === 4,
  `Stream-boundary IR did not preserve the content stream ref: ${JSON.stringify(streamBoundaryResult.ir.value?.pages[0]?.contentStreamRefs ?? null)}.`,
);
assert(
  streamBoundaryResult.observation.value?.extractedText === "endobj inside stream",
  `Unexpected stream-boundary extraction: ${JSON.stringify(streamBoundaryResult.observation.value?.extractedText ?? null)}.`,
);
assert(
  incrementalUpdateResult.ir.value?.crossReferenceSections.map((section) => section.offset).join(",") ===
    `${String(incrementalUpdatePdf.incrementalXrefOffset)},${String(incrementalUpdatePdf.baseXrefOffset)}`,
  `Unexpected incremental-update xref order: ${incrementalUpdateResult.ir.value?.crossReferenceSections.map((section) => section.offset).join(",") ?? "missing"}.`,
);
assert(
  incrementalUpdateResult.ir.value?.trailer?.prevOffset === incrementalUpdatePdf.baseXrefOffset,
  `Unexpected incremental-update trailer Prev offset: ${incrementalUpdateResult.ir.value?.trailer?.prevOffset ?? "missing"}.`,
);
assert(
  incrementalUpdateResult.ir.value?.trailer?.infoRef?.objectNumber === 5,
  `Unexpected incremental-update trailer Info ref: ${incrementalUpdateResult.ir.value?.trailer?.infoRef?.objectNumber ?? "missing"}.`,
);
assert(recoveredResult.admission.status === "partial", `Recovered admission status was ${recoveredResult.admission.status}.`);
assert(recoveredResult.admission.value?.decision === "accepted", `Recovered decision was ${recoveredResult.admission.value?.decision ?? "missing"}.`);
assert(recoveredResult.admission.value?.repairState === "recovered", `Recovered repair state was ${recoveredResult.admission.value?.repairState ?? "missing"}.`);
assert(recoveredResult.ir.value?.pages[0]?.resolutionMethod === "page-tree", "Recovered IR page resolution method was not preserved.");
assert(recoveredResult.observation.value?.pages[0]?.resolutionMethod === "page-tree", "Recovered observation page resolution method was not preserved.");
assert(
  !recoveredResult.observation.value?.knownLimits.includes("page-order-heuristic"),
  "Recovered observation still reported page-order heuristics after page-tree recovery.",
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
assert(
  javascriptActionAdmission.status === "blocked",
  `JavaScript-action admission status was ${javascriptActionAdmission.status}.`,
);
assert(
  javascriptActionAdmission.value?.decision === "rejected",
  `JavaScript-action decision was ${javascriptActionAdmission.value?.decision ?? "missing"}.`,
);
assert(
  javascriptActionAdmission.diagnostics.some((diagnostic) => diagnostic.code === "feature-denied-by-policy"),
  "JavaScript-action admission did not reject through the active policy.",
);
assert(
  javascriptActionFinding?.actionName === "JavaScript",
  `JavaScript-action finding action name was ${javascriptActionFinding && "actionName" in javascriptActionFinding ? javascriptActionFinding.actionName : "missing"}.`,
);
assert(
  javascriptActionFinding?.actionRef?.objectNumber === 5,
  `JavaScript-action finding action ref was ${javascriptActionFinding?.actionRef?.objectNumber ?? "missing"}.`,
);
assert(
  javascriptActionFinding?.evidenceSource === "object",
  "JavaScript-action finding did not preserve parsed object evidence.",
);
assert(
  javascriptActionAllowedAdmission.status === "completed",
  `Allowed JavaScript-action admission status was ${javascriptActionAllowedAdmission.status}.`,
);
assert(
  javascriptActionAllowedAdmission.value?.decision === "accepted",
  `Allowed JavaScript-action decision was ${javascriptActionAllowedAdmission.value?.decision ?? "missing"}.`,
);
assert(
  javascriptActionAllowedFinding?.action === "allow",
  `Allowed JavaScript-action finding action was ${javascriptActionAllowedFinding?.action ?? "missing"}.`,
);
assert(
  largeBenignJavascriptCommentAdmission.status === "completed",
  `Large benign-comment admission status was ${largeBenignJavascriptCommentAdmission.status}.`,
);
assert(
  !largeBenignJavascriptCommentAdmission.value?.featureFindings.some(
    (finding) => finding.kind === "javascript-actions",
  ),
  "Large benign comment still produced a JavaScript feature detection after full-structure parsing.",
);
assert(observationWithoutPassword.status === "blocked", `Encrypted observe status without password was ${observationWithoutPassword.status}.`);
assert(
  observationWithoutPassword.diagnostics.some((diagnostic) => diagnostic.code === "password-required"),
  "Encrypted observe without password did not surface password-required.",
);
assert(
  observationWithWrongPassword.status === "blocked",
  `Encrypted observe status with wrong password was ${observationWithWrongPassword.status}.`,
);
assert(
  observationWithWrongPassword.diagnostics.some((diagnostic) => diagnostic.code === "password-invalid"),
  "Encrypted observe with wrong password did not surface password-invalid.",
);
assert(
  observationWithPassword.status === "partial" || observationWithPassword.status === "completed",
  `Encrypted observe status with password was ${observationWithPassword.status}.`,
);
assert(
  observationWithPassword.value?.extractedText === "Encrypted Shell",
  `Encrypted observe text with password was ${JSON.stringify(observationWithPassword.value?.extractedText ?? null)}.`,
);
assert(
  !observationWithPassword.diagnostics.some((diagnostic) => diagnostic.code === "decryption-not-implemented"),
  "Encrypted observe with password still surfaced decryption-not-implemented.",
);
const encryptedFeatureFindings = admissionWithPassword.value?.featureFindings ?? [];
const encryptionFinding = encryptedFeatureFindings.find((finding) => finding.kind === "encryption");
const objectStreamFinding = encryptedFeatureFindings.find((finding) => finding.kind === "object-streams");
const xrefStreamFinding = encryptedFeatureFindings.find((finding) => finding.kind === "xref-streams");
assert(
  admissionWithPassword.status === "completed",
  `Encrypted admission status with password was ${admissionWithPassword.status}.`,
);
assert(
  encryptionFinding?.evidenceSource === "object",
  "Encrypted admission did not use parsed object evidence for encryption.",
);
assert(
  encryptionFinding?.objectRef?.objectNumber === 12,
  `Encrypted admission encryption object ref was ${encryptionFinding?.objectRef?.objectNumber ?? "missing"}.`,
);
assert(
  objectStreamFinding?.evidenceSource === "object",
  "Encrypted admission did not use parsed object evidence for object streams.",
);
assert(
  objectStreamFinding?.objectRef?.objectNumber === 8,
  `Encrypted admission object-stream ref was ${objectStreamFinding?.objectRef?.objectNumber ?? "missing"}.`,
);
assert(
  xrefStreamFinding?.evidenceSource === "object",
  "Encrypted admission did not use parsed object evidence for xref streams.",
);
assert(
  xrefStreamFinding?.objectRef?.objectNumber === 13,
  `Encrypted admission xref-stream ref was ${xrefStreamFinding?.objectRef?.objectNumber ?? "missing"}.`,
);
assert(
  observationAes256WithoutPassword.status === "blocked",
  `AES-256 encrypted observe status without password was ${observationAes256WithoutPassword.status}.`,
);
assert(
  observationAes256WithoutPassword.diagnostics.some((diagnostic) => diagnostic.code === "password-required"),
  "AES-256 encrypted observe without password did not surface password-required.",
);
assert(
  observationAes256WithWrongPassword.status === "blocked",
  `AES-256 encrypted observe status with wrong password was ${observationAes256WithWrongPassword.status}.`,
);
assert(
  observationAes256WithWrongPassword.diagnostics.some((diagnostic) => diagnostic.code === "password-invalid"),
  "AES-256 encrypted observe with wrong password did not surface password-invalid.",
);
assert(
  observationAes256WithPassword.status === "partial" || observationAes256WithPassword.status === "completed",
  `AES-256 encrypted observe status with password was ${observationAes256WithPassword.status}.`,
);
assert(
  encryptedStandardTextAes256Fixture.expectedMarkers.every((marker) =>
    observationAes256WithPassword.value?.extractedText.includes(marker),
  ),
  `AES-256 encrypted observe text with password was ${JSON.stringify(observationAes256WithPassword.value?.extractedText ?? null)}.`,
);
assert(
  !observationAes256WithPassword.diagnostics.some((diagnostic) => diagnostic.code === "decryption-not-implemented"),
  "AES-256 encrypted observe with password still surfaced decryption-not-implemented.",
);
const encryptedAes256FeatureFindings = admissionAes256WithPassword.value?.featureFindings ?? [];
const aes256EncryptionFinding = encryptedAes256FeatureFindings.find((finding) => finding.kind === "encryption");
const aes256ObjectStreamFinding = encryptedAes256FeatureFindings.find((finding) => finding.kind === "object-streams");
const aes256XrefStreamFinding = encryptedAes256FeatureFindings.find((finding) => finding.kind === "xref-streams");
assert(
  admissionAes256WithPassword.status === "completed",
  `AES-256 encrypted admission status with password was ${admissionAes256WithPassword.status}.`,
);
assert(
  aes256EncryptionFinding?.evidenceSource === "object",
  "AES-256 encrypted admission did not use parsed object evidence for encryption.",
);
assert(
  aes256EncryptionFinding?.objectRef?.objectNumber === 22,
  `AES-256 encrypted admission encryption object ref was ${aes256EncryptionFinding?.objectRef?.objectNumber ?? "missing"}.`,
);
assert(
  aes256ObjectStreamFinding?.evidenceSource === "object",
  "AES-256 encrypted admission did not use parsed object evidence for object streams.",
);
assert(
  aes256ObjectStreamFinding?.objectRef?.objectNumber === 2,
  `AES-256 encrypted admission object-stream ref was ${aes256ObjectStreamFinding?.objectRef?.objectNumber ?? "missing"}.`,
);
assert(
  aes256XrefStreamFinding?.evidenceSource === "object",
  "AES-256 encrypted admission did not use parsed object evidence for xref streams.",
);
assert(
  aes256XrefStreamFinding?.objectRef?.objectNumber === 23,
  `AES-256 encrypted admission xref-stream ref was ${aes256XrefStreamFinding?.objectRef?.objectNumber ?? "missing"}.`,
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
      ascii85Text: ascii85Result.observation.value?.extractedText ?? null,
      chainedText: chainedFilterResult.observation.value?.extractedText ?? null,
      recoveredAdmission: recoveredResult.admission.status,
      recoveredRepairState: recoveredResult.admission.value?.repairState ?? null,
      streamBoundaryText: streamBoundaryResult.observation.value?.extractedText ?? null,
      incrementalXrefOrder: incrementalUpdateResult.ir.value?.crossReferenceSections.map((section) => section.offset) ?? null,
      ir: result.ir.status,
      observation: result.observation.status,
      observationStrategy: result.observation.value?.strategy ?? null,
      layout: result.layout.status,
      layoutStrategy: result.layout.value?.strategy ?? null,
      knowledge: result.knowledge.status,
      knowledgeStrategy: result.knowledge.value?.strategy ?? null,
      knowledgeChunkCount: result.knowledge.value?.chunks.length ?? null,
      render: result.render.status,
      renderStrategy: result.render.value?.strategy ?? null,
      renderCommandCount: result.render.value?.pages[0]?.displayList.commands.length ?? null,
      renderHash: result.render.value?.renderHash.hex ?? null,
      renderPageHash: result.render.value?.pages[0]?.renderHash.hex ?? null,
      text: result.observation.value?.extractedText ?? null,
    },
    null,
    2,
  ),
);
