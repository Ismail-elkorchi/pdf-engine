export interface PdfTestFixtureDefinition {
  readonly id:
    | "simple-text"
    | "multi-page-navigation"
    | "javascript-action"
    | "observed-path-geometry"
    | "render-text-selection"
    | "render-resource-payloads"
    | "render-imagery-raster";
  readonly fileName: string;
  readonly relativePath: string;
  readonly expectedText?: string;
  readonly expectedPageCount?: number;
  readonly expectedRenderResourcePayloadCount?: number;
  readonly expectedPageBox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly expectedPolicyDecision?: "rejected";
  readonly expectedFeatureKinds?: readonly string[];
}

export const pdfTestFixtures: {
  readonly simpleText: PdfTestFixtureDefinition;
  readonly multiPageNavigation: PdfTestFixtureDefinition;
  readonly javascriptAction: PdfTestFixtureDefinition;
  readonly observedPathGeometry: PdfTestFixtureDefinition;
  readonly renderTextSelection: PdfTestFixtureDefinition;
  readonly renderResourcePayloads: PdfTestFixtureDefinition;
  readonly renderImageryRaster: PdfTestFixtureDefinition;
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
  renderResourcePayloads: {
    id: "render-resource-payloads",
    fileName: "render-resource-payloads.pdf",
    relativePath: "../fixtures/render-resource-payloads.pdf",
    expectedText: "Payload Render",
    expectedPageCount: 1,
    expectedRenderResourcePayloadCount: 2,
  },
  renderImageryRaster: {
    id: "render-imagery-raster",
    fileName: "render-imagery-raster.pdf",
    relativePath: "../fixtures/render-imagery-raster.pdf",
    expectedText: "Render View",
    expectedPageCount: 1,
    expectedPageBox: {
      x: 10,
      y: 20,
      width: 200,
      height: 160,
    },
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
