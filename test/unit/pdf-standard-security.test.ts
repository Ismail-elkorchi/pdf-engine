import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";

import { createPdfEngine, type PdfResult } from "../../src/index.ts";
import { preparePdfStandardPasswordSecurity } from "../../src/pdf-standard-security.ts";

interface EncryptedFixture {
  readonly fileName: string;
  readonly bytesBase64: string;
  readonly userPassword: string;
  readonly expectedMarkers?: readonly string[];
  readonly expectedText?: string;
}

const require = createRequire(import.meta.url);

function fixtures(): {
  readonly decodeFixturePdfBytes: (base64: string) => Uint8Array;
  readonly publicSmokeFixtures: {
    readonly encryptedStandardText: EncryptedFixture;
    readonly encryptedStandardTextAes256: EncryptedFixture;
  };
} {
  return require("../../scripts/smoke/fixture-data.mjs");
}

function valueOf<T>(result: PdfResult<T>): T {
  if (result.status !== "completed" && result.status !== "partial") {
    assert.fail(`Expected a value result, received ${result.status}.`);
  }
  return result.value;
}

test("missing standard-security fields are rejected", async () => {
  assert.deepEqual(await preparePdfStandardPasswordSecurity({
    documentId: new Uint8Array([1, 2, 3]),
    encryptDictionaryEntries: new Map(),
    encryptObjectRef: { objectNumber: 1, generationNumber: 0 },
    password: "unused",
  }), {
    status: "unsupported",
    detail: "The encryption dictionary is missing required standard-handler fields.",
  });
});

for (const fixtureName of ["encryptedStandardText", "encryptedStandardTextAes256"] as const) {
  test(`the document session decrypts ${fixtureName}`, async () => {
    const data = fixtures();
    const fixture = data.publicSmokeFixtures[fixtureName];
    const engine = createPdfEngine();
    const opened = await engine.open({
      source: { kind: "bytes", bytes: data.decodeFixturePdfBytes(fixture.bytesBase64), fileName: fixture.fileName },
      passwordProvider: () => fixture.userPassword,
      policy: { enforcePermissions: false },
    });
    const document = valueOf(opened);
    const text = valueOf(await document.extract()).extractedText;
    const markers = fixture.expectedMarkers ?? (fixture.expectedText === undefined ? [] : [fixture.expectedText]);
    for (const marker of markers) {
      assert.match(text, new RegExp(marker, "u"));
    }
    await engine.dispose();
  });
}

test("an invalid password is a blocked document result", async () => {
  const data = fixtures();
  const fixture = data.publicSmokeFixtures.encryptedStandardText;
  const engine = createPdfEngine();
  const opened = await engine.open({
    source: { kind: "bytes", bytes: data.decodeFixturePdfBytes(fixture.bytesBase64) },
    passwordProvider: () => "wrong-password",
  });
  assert.equal(opened.status, "blocked");
  await engine.dispose();
});
