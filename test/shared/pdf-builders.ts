const textEncoder = new TextEncoder();

export interface SyntheticPdfObject {
  readonly objectNumber: number;
  readonly body: string;
}

export interface SyntheticPdfPageSpec {
  readonly content: string;
  readonly resourcesBody?: string;
}

export interface RenderResourcePayloadPdfOptions {
  readonly includeUnusedResources?: boolean;
  readonly reorderResourceEntries?: boolean;
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

    objects.push(
      {
        objectNumber: pageObjectNumber,
        body:
          `<< /Type /Page /Parent 2 0 R /Resources ${resourcesBody} /MediaBox [0 0 612 792] /Contents ${String(contentObjectNumber)} 0 R >>`,
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
