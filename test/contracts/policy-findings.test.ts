import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine } from "../../src/index.ts";
import { loadNamedPdfFixture } from "../shared/load-fixture.ts";
import { buildPdfWithPageSpecs } from "../shared/pdf-builders.ts";

const textEncoder = new TextEncoder();

test("typed feature findings drive JavaScript-action denial", async () => {
  const engine = createPdfEngine();
  const { fixture, bytes } = await loadNamedPdfFixture("javascriptAction");

  const admission = await engine.admit({
    source: {
      bytes,
      fileName: fixture.fileName,
    },
    policy: {
      javascriptActions: "deny",
    },
  });

  assert.equal(admission.value?.decision, "rejected");
  const javascriptFinding = admission.value?.featureFindings.find((finding) =>
    finding.kind === "javascript-actions"
  );
  assert.ok(javascriptFinding);
  assert.equal(javascriptFinding?.action, "deny");
  assert.equal(javascriptFinding?.evidenceSource, "object");
});

test("admission policy evaluates JavaScript actions expanded from object streams", async () => {
  const engine = createPdfEngine();
  const objectStreamText = "9 0 << /S /JavaScript /JS (app.alert) >>";
  const bytes = buildPdfWithPageSpecs(
    [
      {
        content: "BT /F1 12 Tf 72 720 Td (Object stream action) Tj ET",
      },
    ],
    [
      {
        objectNumber: 20,
        body:
          `<< /Type /ObjStm /N 1 /First 4 /Length ${String(textEncoder.encode(objectStreamText).byteLength)} >>\nstream\n${objectStreamText}\nendstream`,
      },
    ],
  );

  const admission = await engine.admit({
    source: {
      bytes,
      fileName: "policy-object-stream-action.pdf",
    },
    policy: {
      javascriptActions: "deny",
    },
  });

  assert.equal(admission.value?.decision, "rejected");
  const javascriptFinding = admission.value?.featureFindings.find((finding) =>
    finding.kind === "javascript-actions"
  );
  assert.equal(javascriptFinding?.evidenceSource, "object");
  assert.deepEqual(javascriptFinding?.objectRef, {
    objectNumber: 9,
    generationNumber: 0,
  });
});
