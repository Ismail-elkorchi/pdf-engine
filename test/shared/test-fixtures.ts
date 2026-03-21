export interface PdfTestFixtureDefinition {
  readonly id: "simple-text" | "multi-page-navigation" | "javascript-action";
  readonly fileName: string;
  readonly relativePath: string;
  readonly expectedText?: string;
  readonly expectedPageCount?: number;
  readonly expectedPolicyDecision?: "rejected";
  readonly expectedFeatureKinds?: readonly string[];
}

export const pdfTestFixtures: {
  readonly simpleText: PdfTestFixtureDefinition;
  readonly multiPageNavigation: PdfTestFixtureDefinition;
  readonly javascriptAction: PdfTestFixtureDefinition;
} = {
  simpleText: {
    id: "simple-text",
    fileName: "simple-text.pdf",
    relativePath: "../fixtures/simple-text.pdf",
    expectedText: "Hello Test Layer",
    expectedPageCount: 1,
  },
  multiPageNavigation: {
    id: "multi-page-navigation",
    fileName: "multi-page-navigation.pdf",
    relativePath: "../fixtures/multi-page-navigation.pdf",
    expectedText: "First Page Summary\nSecond Page Detail",
    expectedPageCount: 2,
  },
  javascriptAction: {
    id: "javascript-action",
    fileName: "javascript-action.pdf",
    relativePath: "../fixtures/javascript-action.pdf",
    expectedPolicyDecision: "rejected",
    expectedFeatureKinds: ["javascript-actions"],
  },
} as const;

export function listPdfTestFixtures(): readonly PdfTestFixtureDefinition[] {
  return Object.values(pdfTestFixtures);
}

export function getPdfTestFixture(
  id: PdfTestFixtureDefinition["id"],
): PdfTestFixtureDefinition {
  const fixture = listPdfTestFixtures().find((entry) => entry.id === id);
  if (!fixture) {
    throw new Error(`Unknown PDF test fixture: ${id}`);
  }

  return fixture;
}
