import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";

import { createPdfEngine } from "../../src/engine-core.ts";
import { preparePdfStandardPasswordSecurity } from "../../src/pdf-standard-security.ts";
import { analyzePdfShell, keyOfObjectRef, parseDictionaryEntries } from "../../src/shell-parse.ts";

interface PublicSmokeFixtureDefinition {
  readonly id: string;
  readonly fileName: string;
  readonly bytesBase64: string;
  readonly expectedMarkers?: readonly string[];
  readonly userPassword?: string;
}

interface PublicEncryptedSmokeFixtureDefinition extends PublicSmokeFixtureDefinition {
  readonly userPassword: string;
  readonly expectedMarkers: readonly string[];
}

const require = createRequire(import.meta.url);

function loadSmokeFixtures(): {
  readonly decodeFixturePdfBytes: (base64: string) => Uint8Array;
  readonly publicSmokeFixtures: {
    readonly encryptedStandardText: PublicEncryptedSmokeFixtureDefinition;
    readonly encryptedStandardTextAes256: PublicEncryptedSmokeFixtureDefinition;
  };
} {
  return require("../../scripts/smoke/fixture-data.mjs") as {
    readonly decodeFixturePdfBytes: (base64: string) => Uint8Array;
    readonly publicSmokeFixtures: {
      readonly encryptedStandardText: PublicEncryptedSmokeFixtureDefinition;
      readonly encryptedStandardTextAes256: PublicEncryptedSmokeFixtureDefinition;
    };
  };
}

async function prepareSecurityHandler(
  fixture: PublicEncryptedSmokeFixtureDefinition,
  password: string,
) {
  const { decodeFixturePdfBytes } = await loadSmokeFixtures();
  const engine = createPdfEngine();
  const bytes = decodeFixturePdfBytes(fixture.bytesBase64);
  const analysis = await analyzePdfShell(
    {
      bytes,
      fileName: fixture.fileName,
    },
    engine.defaultPolicy,
  );
  const encryptRef = analysis.trailer?.encryptRef;
  assert.ok(encryptRef, "encrypted smoke fixtures must resolve an /Encrypt reference");
  assert.ok(analysis.documentId, "encrypted smoke fixtures must resolve a document identifier");

  const encryptObject = analysis.objectIndex.get(keyOfObjectRef(encryptRef));
  assert.ok(encryptObject, "encrypted smoke fixtures must retain the /Encrypt object in the index");
  if (!analysis.documentId || !encryptObject || typeof encryptObject.objectValueText !== "string") {
    throw new Error("Encrypted smoke fixture analysis did not resolve the required encryption inputs.");
  }

  return preparePdfStandardPasswordSecurity({
    documentId: analysis.documentId,
    encryptDictionaryEntries: parseDictionaryEntries(encryptObject.objectValueText),
    encryptObjectRef: encryptRef,
    password,
  });
}

test("preparePdfStandardPasswordSecurity rejects dictionaries that are missing required fields", async () => {
  const preparation = await preparePdfStandardPasswordSecurity({
    documentId: new Uint8Array([1, 2, 3]),
    encryptDictionaryEntries: new Map(),
    encryptObjectRef: {
      objectNumber: 1,
      generationNumber: 0,
    },
    password: "not-used",
  });

  assert.deepEqual(preparation, {
    status: "unsupported",
    detail: "The encryption dictionary is missing required standard-handler fields.",
  });
});

test("preparePdfStandardPasswordSecurity decrypts the standard encrypted smoke fixture with the correct password", async () => {
  const { publicSmokeFixtures } = loadSmokeFixtures();
  const fixture = publicSmokeFixtures.encryptedStandardText;
  const preparation = await prepareSecurityHandler(fixture, fixture.userPassword);

  assert.equal(preparation.status, "decrypted");
});

test("preparePdfStandardPasswordSecurity rejects the standard encrypted smoke fixture with the wrong password", async () => {
  const { publicSmokeFixtures } = loadSmokeFixtures();
  const preparation = await prepareSecurityHandler(
    publicSmokeFixtures.encryptedStandardText,
    "definitely-wrong",
  );

  assert.deepEqual(preparation, {
    status: "invalid-password",
    detail: "The supplied password did not unlock the standard security handler.",
  });
});

test("preparePdfStandardPasswordSecurity decrypts the AES-256 smoke fixture and bypasses Encrypt and XRef objects", async () => {
  const { publicSmokeFixtures } = loadSmokeFixtures();
  const fixture = publicSmokeFixtures.encryptedStandardTextAes256;
  const preparation = await prepareSecurityHandler(fixture, fixture.userPassword);

  assert.equal(preparation.status, "decrypted");
  if (preparation.status !== "decrypted") {
    return;
  }

  const encryptObjectValue = await preparation.handler.decryptObjectValueText(
    {
      objectNumber: 22,
      generationNumber: 0,
    },
    "<< /Type /Encrypt >>",
    { typeName: "Encrypt" },
  );
  const xrefValue = await preparation.handler.decryptObjectValueText(
    {
      objectNumber: 999,
      generationNumber: 0,
    },
    "<4142>",
    { typeName: "XRef" },
  );

  assert.equal(encryptObjectValue, "<< /Type /Encrypt >>");
  assert.equal(xrefValue, "<4142>");
});
