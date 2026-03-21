import { pdfTestFixtures, type PdfTestFixtureDefinition } from "./test-fixtures.ts";

export async function readPdfTestFixtureBytes(
  fixture: PdfTestFixtureDefinition,
): Promise<Uint8Array> {
  const fixtureUrl = new URL(fixture.relativePath, import.meta.url);

  if (typeof Deno !== "undefined") {
    return await Deno.readFile(fixtureUrl);
  }

  if (typeof Bun !== "undefined") {
    return new Uint8Array(await Bun.file(fixtureUrl).arrayBuffer());
  }

  if (typeof process !== "undefined") {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(fixtureUrl));
  }

  throw new Error("PDF test fixtures are not readable in the current runtime.");
}

export async function loadNamedPdfFixture(
  fixtureName: keyof typeof pdfTestFixtures,
): Promise<{
  readonly fixture: PdfTestFixtureDefinition;
  readonly bytes: Uint8Array;
}> {
  const fixture = pdfTestFixtures[fixtureName];
  return {
    fixture,
    bytes: await readPdfTestFixtureBytes(fixture),
  };
}
