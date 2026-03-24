const textEncoder = new TextEncoder();

export interface SyntheticPdfObject {
  readonly objectNumber: number;
  readonly body: string;
}

export interface SyntheticPdfPageSpec {
  readonly content: string;
  readonly resourcesBody?: string;
  readonly mediaBox?: readonly [number, number, number, number];
  readonly cropBox?: readonly [number, number, number, number];
}

export interface RenderResourcePayloadPdfOptions {
  readonly includeUnusedResources?: boolean;
  readonly reorderResourceEntries?: boolean;
}

export interface RenderImageryPdfOptions {
  readonly reorderResourceEntries?: boolean;
}

export interface DenseVectorRenderPdfOptions {
  readonly ruleCount?: number;
  readonly rectangleCount?: number;
}

export function buildPdfWithPageContents(
  pageContents: readonly string[],
): Uint8Array {
  return buildPdfWithPageSpecs(pageContents.map((content) => ({ content })));
}

export function buildPdfWithPageSpecs(
  pages: readonly SyntheticPdfPageSpec[],
  extraObjects: readonly SyntheticPdfObject[] = [],
): Uint8Array {
  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2);
  const objects = [
    {
      objectNumber: 1,
      body: "<< /Type /Catalog /Pages 2 0 R >>",
    },
    {
      objectNumber: 2,
      body:
        `<< /Type /Pages /Kids [${pageObjectNumbers.map((objectNumber) => `${String(objectNumber)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`,
    },
    {
      objectNumber: 3,
      body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    },
    ...extraObjects,
  ];

  for (const [index, pageSpec] of pages.entries()) {
    const pageObjectNumber = 4 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    const contentStreamText = pageSpec.content;
    const contentByteLength = textEncoder.encode(contentStreamText).byteLength;
    const resourcesBody = pageSpec.resourcesBody ?? "<< /Font << /F1 3 0 R >> >>";
    const mediaBox = formatPageBox(pageSpec.mediaBox ?? [0, 0, 612, 792]);
    const cropBox = pageSpec.cropBox ? ` /CropBox ${formatPageBox(pageSpec.cropBox)}` : "";

    objects.push(
      {
        objectNumber: pageObjectNumber,
        body:
          `<< /Type /Page /Parent 2 0 R /Resources ${resourcesBody} /MediaBox ${mediaBox}${cropBox} /Contents ${String(contentObjectNumber)} 0 R >>`,
      },
      {
        objectNumber: contentObjectNumber,
        body:
          `<< /Length ${String(contentByteLength)} >>\nstream\n${contentStreamText}\nendstream`,
      },
    );
  }

  const offsets = new Map<number, number>();
  let pdfText = "%PDF-1.4\n";
  const sortedObjects = [...objects].toSorted((left, right) => left.objectNumber - right.objectNumber);

  for (const { objectNumber, body } of sortedObjects) {
    offsets.set(objectNumber, textEncoder.encode(pdfText).byteLength);
    pdfText += `${String(objectNumber)} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = textEncoder.encode(pdfText).byteLength;
  const objectCount = Math.max(...sortedObjects.map((object) => object.objectNumber)) + 1;

  pdfText += `xref\n0 ${String(objectCount)}\n`;
  pdfText += "0000000000 65535 f \n";

  for (let objectNumber = 1; objectNumber < objectCount; objectNumber += 1) {
    const offset = offsets.get(objectNumber);
    if (offset === undefined) {
      pdfText += "0000000000 65535 f \n";
      continue;
    }
    pdfText += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }

  pdfText += `trailer\n<< /Root 1 0 R /Size ${String(objectCount)} >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return textEncoder.encode(pdfText);
}

export function appendTrailingComment(
  bytes: Uint8Array,
  commentText: string,
): Uint8Array {
  const suffix = textEncoder.encode(`\n% ${commentText}\n`);
  const combined = new Uint8Array(bytes.byteLength + suffix.byteLength);
  combined.set(bytes, 0);
  combined.set(suffix, bytes.byteLength);
  return combined;
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function buildPdfWithRenderResourcePayloads(
  options: RenderResourcePayloadPdfOptions = {},
): Uint8Array {
  const includeUnusedResources = options.includeUnusedResources === true;
  const reorderResourceEntries = options.reorderResourceEntries === true;
  const fontEntries = [
    "/F1 10 0 R",
    ...(includeUnusedResources ? ["/FUnused 3 0 R"] : []),
  ];
  const xObjectEntries = [
    "/Im1 20 0 R",
    ...(includeUnusedResources ? ["/UnusedIm 21 0 R"] : []),
  ];
  const orderedFontEntries = reorderResourceEntries ? [...fontEntries].reverse() : fontEntries;
  const orderedXObjectEntries = reorderResourceEntries ? [...xObjectEntries].reverse() : xObjectEntries;
  const resourcesBody =
    `<< /Font << ${orderedFontEntries.join(" ")} >> /XObject << ${orderedXObjectEntries.join(" ")} >> >>`;

  return buildPdfWithPageSpecs(
    [
      {
        resourcesBody,
        content: [
          "BT",
          "/F1 16 Tf",
          "1 0 0 1 72 720 Tm",
          "(Payload Render) Tj",
          "ET",
          "q",
          "1 0 0 1 144 600 cm",
          "/Im1 Do",
          "Q",
        ].join("\n"),
      },
    ],
    [
      {
        objectNumber: 10,
        body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FontDescriptor 11 0 R >>",
      },
      {
        objectNumber: 11,
        body: "<< /Type /FontDescriptor /FontName /Helvetica /FontFile 12 0 R >>",
      },
      {
        objectNumber: 12,
        body: "<< /Length 4 >>\nstream\nTEST\nendstream",
      },
      {
        objectNumber: 20,
        body:
          "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nA\nendstream",
      },
      ...(includeUnusedResources
        ? [
            {
              objectNumber: 21,
              body:
                "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nB\nendstream",
            },
          ]
        : []),
    ],
  );
}

export function buildPdfWithRenderImagery(
  options: RenderImageryPdfOptions = {},
): Uint8Array {
  const reorderResourceEntries = options.reorderResourceEntries === true;
  const fontEntries = ["/F1 10 0 R"];
  const xObjectEntries = ["/Im1 20 0 R"];
  const orderedFontEntries = reorderResourceEntries ? [...fontEntries].reverse() : fontEntries;
  const orderedXObjectEntries = reorderResourceEntries ? [...xObjectEntries].reverse() : xObjectEntries;
  const resourcesBody =
    `<< /Font << ${orderedFontEntries.join(" ")} >> /XObject << ${orderedXObjectEntries.join(" ")} >> >>`;

  return buildPdfWithPageSpecs(
    [
      {
        resourcesBody,
        mediaBox: [0, 0, 220, 220],
        cropBox: [10, 20, 210, 180],
        content: [
          "BT",
          "/F1 18 Tf",
          "1 0 0 1 40 130 Tm",
          "(Render View) Tj",
          "ET",
          "0 0 1 rg",
          "0 0 1 RG",
          "2 w",
          "30 40 70 35 re",
          "B",
          "q",
          "24 0 0 24 130 50 cm",
          "/Im1 Do",
          "Q",
        ].join("\n"),
      },
    ],
    [
      {
        objectNumber: 10,
        body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FontDescriptor 11 0 R >>",
      },
      {
        objectNumber: 11,
        body: "<< /Type /FontDescriptor /FontName /Helvetica /FontFile 12 0 R >>",
      },
      {
        objectNumber: 12,
        body: "<< /Length 4 >>\nstream\nTEXT\nendstream",
      },
      {
        objectNumber: 20,
        body:
          "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\n" +
          "ABCDEFGHIJKL" +
          "\nendstream",
      },
    ],
  );
}

export function buildPdfWithDenseVectorImagery(
  options: DenseVectorRenderPdfOptions = {},
): Uint8Array {
  const ruleCount = options.ruleCount ?? 120;
  const rectangleCount = options.rectangleCount ?? 72;
  const pageOneRules = buildDenseRulePage(ruleCount);
  const pageTwoRectangles = buildDenseRectanglePage(rectangleCount);
  const pageThreeMixed = buildMixedDensePage(Math.max(24, Math.floor(ruleCount / 2)));

  return buildPdfWithPageSpecs([
    {
      mediaBox: [0, 0, 612, 792],
      content: pageOneRules,
    },
    {
      mediaBox: [0, 0, 612, 792],
      content: pageTwoRectangles,
    },
    {
      mediaBox: [0, 0, 612, 792],
      content: pageThreeMixed,
    },
  ]);
}

export function buildPdfWithOverscaledImageImagery(): Uint8Array {
  return buildPdfWithPageSpecs(
    [
      {
        mediaBox: [0, 0, 220, 220],
        cropBox: [10, 20, 210, 180],
        resourcesBody: "<< /XObject << /Im1 20 0 R >> >>",
        content: [
          "q",
          "1800 0 0 1800 -120 -140 cm",
          "/Im1 Do",
          "Q",
        ].join("\n"),
      },
    ],
    [
      {
        objectNumber: 20,
        body:
          "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\n" +
          "ABCDEFGHIJKL" +
          "\nendstream",
      },
    ],
  );
}

function formatPageBox(box: readonly [number, number, number, number]): string {
  return `[${box.map((value) => String(value)).join(" ")}]`;
}

function buildDenseRulePage(ruleCount: number): string {
  const commands: string[] = ["0 G", "0.5 w"];
  const usableRuleCount = Math.max(12, ruleCount);

  for (let index = 0; index < usableRuleCount; index += 1) {
    const y = 760 - index * 5;
    commands.push(`${String(48)} ${String(y)} m ${String(564)} ${String(y)} l S`);
  }

  for (let index = 0; index < usableRuleCount; index += 1) {
    const x = 48 + index * 4;
    commands.push(`${String(x)} ${String(96)} m ${String(x)} ${String(760)} l S`);
  }

  return commands.join("\n");
}

function buildDenseRectanglePage(rectangleCount: number): string {
  const commands: string[] = ["0 0 0 rg", "0 0 0 RG", "0.75 w"];
  const usableRectangleCount = Math.max(24, rectangleCount);

  for (let index = 0; index < usableRectangleCount; index += 1) {
    const column = index % 8;
    const row = Math.floor(index / 8);
    const x = 48 + column * 62;
    const y = 710 - row * 48;
    const width = 44 + (index % 3) * 6;
    const height = 18 + (index % 4) * 4;
    commands.push(`${String(x)} ${String(y)} ${String(width)} ${String(height)} re B`);
  }

  return commands.join("\n");
}

function buildMixedDensePage(ruleCount: number): string {
  const commands: string[] = [
    "BT",
    "/F1 14 Tf",
    "1 0 0 1 72 744 Tm",
    "(Dense technical layout) Tj",
    "ET",
    "0 G",
    "0.5 w",
  ];

  const usableRuleCount = Math.max(24, ruleCount);
  for (let index = 0; index < usableRuleCount; index += 1) {
    const y = 708 - index * 12;
    commands.push(`${String(72)} ${String(y)} m ${String(540)} ${String(y)} l S`);
    commands.push("BT");
    commands.push("/F1 10 Tf");
    commands.push(`1 0 0 1 84 ${String(y + 3)} Tm`);
    commands.push(`(Section ${String(index + 1).padStart(2, "0")} text line) Tj`);
    commands.push("ET");
  }

  return commands.join("\n");
}
