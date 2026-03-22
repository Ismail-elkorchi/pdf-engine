const textEncoder = new TextEncoder();

export interface SyntheticPdfObject {
  readonly objectNumber: number;
  readonly body: string;
}

export interface SyntheticPdfPageSpec {
  readonly content: string;
  readonly resourcesBody?: string;
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
