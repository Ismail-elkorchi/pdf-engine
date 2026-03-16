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

const startXrefOffset = syntheticPdfTemplate.indexOf("xref\n0 5");
assert(startXrefOffset >= 0, "Synthetic PDF did not contain an xref section.");

const syntheticPdf = syntheticPdfTemplate.replace("__STARTXREF__", String(startXrefOffset));
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
const result = await engine.run({
  source: {
    bytes: new TextEncoder().encode(syntheticPdf),
    fileName: "synthetic.pdf",
    mediaType: "application/pdf",
  },
});
const recoveredResult = await engine.run({
  source: {
    bytes: new TextEncoder().encode(malformedPdf),
    fileName: "recovered.pdf",
    mediaType: "application/pdf",
  },
});
const blockedRecoveryResult = await engine.run({
  source: {
    bytes: new TextEncoder().encode(malformedPdf),
    fileName: "recovered.pdf",
    mediaType: "application/pdf",
  },
  policy: {
    repairMode: "never",
  },
});

assert(result.runtime.kind === expectedRuntime, `Expected runtime ${expectedRuntime} but received ${result.runtime.kind}.`);
assert(result.admission.status === "completed", `Admission status was ${result.admission.status}.`);
assert(result.ir.status === "completed", `IR status was ${result.ir.status}.`);
assert(result.observation.status === "completed", `Observation status was ${result.observation.status}.`);
assert(result.admission.value?.repairState === "clean", `Repair state was ${result.admission.value?.repairState ?? "missing"}.`);
assert(result.admission.value?.parseCoverage.startXref === true, "The shell did not recover startxref coverage.");
assert(result.admission.value?.parseCoverage.trailer === true, "The shell did not recover trailer coverage.");
assert(result.ir.value?.indirectObjects.length === 4, `Unexpected indirect-object count: ${result.ir.value?.indirectObjects.length ?? 0}.`);
assert(result.ir.value?.trailer?.rootRef?.objectNumber === 1, "Trailer root ref was not recovered.");
assert(result.ir.value?.pages[0]?.pageRef?.objectNumber === 3, "Page object ref was not recovered.");
assert(result.ir.value?.pages[0]?.contentStreamRefs[0]?.objectNumber === 4, "Content stream ref was not recovered.");
assert(result.observation.value?.pages[0]?.pageRef?.objectNumber === 3, "Observation page ref was not preserved.");
assert(result.observation.value?.pages[0]?.runs[0]?.objectRef?.objectNumber === 4, "Observation run object ref was not preserved.");
assert(
  result.observation.value?.extractedText === "Hello PDF Engine",
  `Unexpected extracted text: ${JSON.stringify(result.observation.value?.extractedText ?? null)}.`,
);
assert(recoveredResult.admission.status === "partial", `Recovered admission status was ${recoveredResult.admission.status}.`);
assert(recoveredResult.admission.value?.decision === "accepted", `Recovered decision was ${recoveredResult.admission.value?.decision ?? "missing"}.`);
assert(recoveredResult.admission.value?.repairState === "recovered", `Recovered repair state was ${recoveredResult.admission.value?.repairState ?? "missing"}.`);
assert(recoveredResult.observation.value?.extractedText === "Recovered", "Recovered observation text was not preserved.");
assert(
  blockedRecoveryResult.admission.status === "blocked",
  `Repair-blocked admission status was ${blockedRecoveryResult.admission.status}.`,
);
assert(
  blockedRecoveryResult.admission.value?.decision === "unsupported",
  `Repair-blocked decision was ${blockedRecoveryResult.admission.value?.decision ?? "missing"}.`,
);

console.log(
  JSON.stringify(
    {
      runtime: result.runtime.kind,
      admission: result.admission.status,
      repairState: result.admission.value?.repairState ?? null,
      recoveredAdmission: recoveredResult.admission.status,
      recoveredRepairState: recoveredResult.admission.value?.repairState ?? null,
      ir: result.ir.status,
      observation: result.observation.status,
      text: result.observation.value?.extractedText ?? null,
    },
    null,
    2,
  ),
);
