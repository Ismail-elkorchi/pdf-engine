import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPdfEngine } from "../../src/index.ts";
import { loadNamedPdfFixture } from "../shared/load-fixture.ts";

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
