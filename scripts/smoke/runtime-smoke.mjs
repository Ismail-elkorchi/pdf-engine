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

const startXrefOffset = syntheticPdfTemplate.indexOf("xref\n0 5");
assert(startXrefOffset >= 0, "Synthetic PDF did not contain an xref section.");
const encryptedStartXrefOffset = encryptedPdfTemplate.indexOf("xref\n0 6");
assert(encryptedStartXrefOffset >= 0, "Encrypted synthetic PDF did not contain an xref section.");
const nestedStartXrefOffset = nestedPageTreeTemplate.indexOf("xref\n0 8");
assert(nestedStartXrefOffset >= 0, "Nested page-tree PDF did not contain an xref section.");

const syntheticPdf = syntheticPdfTemplate.replace("__STARTXREF__", String(startXrefOffset));
const encryptedPdf = encryptedPdfTemplate.replace("__ENCRYPTED_STARTXREF__", String(encryptedStartXrefOffset));
const nestedPageTreePdf = nestedPageTreeTemplate.replace("__NESTED_STARTXREF__", String(nestedStartXrefOffset));
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
assert(result.admission.status === "completed", `Admission status was ${result.admission.status}.`);
assert(result.ir.status === "completed", `IR status was ${result.ir.status}.`);
assert(result.observation.status === "completed", `Observation status was ${result.observation.status}.`);
assert(result.admission.value?.repairState === "clean", `Repair state was ${result.admission.value?.repairState ?? "missing"}.`);
assert((result.admission.value?.knownLimits.length ?? 0) === 0, "Admission known limits should be empty for the clean synthetic document.");
assert(result.admission.value?.parseCoverage.startXref === true, "The shell did not recover startxref coverage.");
assert(result.admission.value?.parseCoverage.trailer === true, "The shell did not recover trailer coverage.");
assert(result.ir.value?.indirectObjects.length === 4, `Unexpected indirect-object count: ${result.ir.value?.indirectObjects.length ?? 0}.`);
assert(result.ir.value?.decodedStreams === true, "IR did not mark operator-ready streams as available.");
assert(result.ir.value?.resolvedInheritedPageState === false, "IR incorrectly claimed inherited page resolution.");
assert(result.ir.value?.trailer?.rootRef?.objectNumber === 1, "Trailer root ref was not recovered.");
assert(result.ir.value?.pages[0]?.pageRef?.objectNumber === 3, "Page object ref was not recovered.");
assert(result.ir.value?.pages[0]?.contentStreamRefs[0]?.objectNumber === 4, "Content stream ref was not recovered.");
assert(result.ir.value?.pages[0]?.resolutionMethod === "page-tree", "IR page resolution method was not preserved.");
assert(result.ir.value?.indirectObjects[3]?.streamDecodeState === "available", "Unfiltered stream was not marked as available.");
assert(result.observation.value?.pages[0]?.pageRef?.objectNumber === 3, "Observation page ref was not preserved.");
assert(result.observation.value?.pages[0]?.resolutionMethod === "page-tree", "Observation page resolution method was not preserved.");
assert(result.observation.value?.pages[0]?.runs[0]?.contentStreamRef?.objectNumber === 4, "Observation run content stream ref was not preserved.");
assert(result.observation.value?.pages[0]?.runs[0]?.objectRef?.objectNumber === 4, "Observation run object ref was not preserved.");
assert(result.observation.value?.pages[0]?.glyphs[0]?.contentStreamRef?.objectNumber === 4, "Observation glyph content stream ref was not preserved.");
assert(result.observation.value?.strategy === "heuristic-literal-scan", "Observation strategy was not preserved.");
assert(
  result.observation.value?.knownLimits.includes("text-decoding-heuristic"),
  "Observation known limits did not include text-decoding-heuristic.",
);
assert(
  result.observation.value?.extractedText === "Hello PDF Engine",
  `Unexpected extracted text: ${JSON.stringify(result.observation.value?.extractedText ?? null)}.`,
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
      text: result.observation.value?.extractedText ?? null,
    },
    null,
    2,
  ),
);
