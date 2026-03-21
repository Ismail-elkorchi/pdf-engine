const textEncoder = new TextEncoder();

export function buildPdfWithPageContents(
  pageContents: readonly string[],
): Uint8Array {
  const pageObjectNumbers = pageContents.map((_, index) => 4 + index * 2);
  const objects = [
    {
      objectNumber: 1,
      body: "<< /Type /Catalog /Pages 2 0 R >>",
    },
    {
      objectNumber: 2,
      body:
        `<< /Type /Pages /Kids [${pageObjectNumbers.map((objectNumber) => `${String(objectNumber)} 0 R`).join(" ")}] /Count ${String(pageContents.length)} >>`,
    },
    {
      objectNumber: 3,
      body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    },
  ];

  for (const [index, contentStreamText] of pageContents.entries()) {
    const pageObjectNumber = 4 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    const contentByteLength = textEncoder.encode(contentStreamText).byteLength;

    objects.push(
      {
        objectNumber: pageObjectNumber,
        body:
          `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 612 792] /Contents ${String(contentObjectNumber)} 0 R >>`,
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

  for (const { objectNumber, body } of objects) {
    offsets.set(objectNumber, textEncoder.encode(pdfText).byteLength);
    pdfText += `${String(objectNumber)} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = textEncoder.encode(pdfText).byteLength;
  const objectCount = objects.length + 1;

  pdfText += `xref\n0 ${String(objectCount)}\n`;
  pdfText += "0000000000 65535 f \n";

  for (let objectNumber = 1; objectNumber < objectCount; objectNumber += 1) {
    const offset = offsets.get(objectNumber);
    if (offset === undefined) {
      throw new Error(
        `Synthetic PDF is missing an xref entry for object ${String(objectNumber)}.`,
      );
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
