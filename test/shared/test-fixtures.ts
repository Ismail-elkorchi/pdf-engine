export interface PdfTestFixtureDefinition {
  readonly id: "simple-text" | "multi-page-navigation" | "javascript-action" | "observed-path-geometry" | "render-text-selection";
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
  readonly observedPathGeometry: PdfTestFixtureDefinition;
  readonly renderTextSelection: PdfTestFixtureDefinition;
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
  observedPathGeometry: {
    id: "observed-path-geometry",
    fileName: "observed-path-geometry.pdf",
    relativePath: "../fixtures/observed-path-geometry.pdf",
    expectedPageCount: 1,
  },
  renderTextSelection: {
    id: "render-text-selection",
    fileName: "render-text-selection.pdf",
    relativePath: "../fixtures/render-text-selection.pdf",
    expectedText: "Heading Layer\nSelection Detail",
    expectedPageCount: 1,
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
