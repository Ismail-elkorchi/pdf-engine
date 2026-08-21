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
  readonly rotate?: 0 | 90 | 180 | 270;
}

export function buildPdfWithPageContents(pageContents: readonly string[]): Uint8Array {
  return buildPdfWithPageSpecs(pageContents.map((content) => ({ content })));
}

export function buildPdfWithSplitContentInstruction(): Uint8Array {
  const first = "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n[(Split Stream)] ";
  const second = "TJ\nET";
  return buildPdfObjects([
    { objectNumber: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { objectNumber: 2, body: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>" },
    { objectNumber: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    {
      objectNumber: 4,
      body: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 612 792] /Contents [5 0 R 6 0 R] >>",
    },
    {
      objectNumber: 5,
      body: `<< /Length ${String(textEncoder.encode(first).byteLength)} >>\nstream\n${first}\nendstream`,
    },
    {
      objectNumber: 6,
      body: `<< /Length ${String(textEncoder.encode(second).byteLength)} >>\nstream\n${second}\nendstream`,
    },
  ]);
}

export function buildPdfWithCyclicPageBranch(): Uint8Array {
  const content = "BT\n/F1 12 Tf\n(Cycle Recovered) Tj\nET";
  return buildPdfObjects([
    { objectNumber: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { objectNumber: 2, body: "<< /Type /Pages /Kids [4 0 R 7 0 R] /Count 1 >>" },
    { objectNumber: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    {
      objectNumber: 4,
      body: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>",
    },
    {
      objectNumber: 5,
      body: `<< /Length ${String(textEncoder.encode(content).byteLength)} >>\nstream\n${content}\nendstream`,
    },
    { objectNumber: 7, body: "<< /Type /Pages /Kids [8 0 R] /Count 0 >>" },
    { objectNumber: 8, body: "<< /Type /Pages /Kids [7 0 R] /Count 0 >>" },
  ]);
}

export function buildPdfWithPageSpecs(
  pages: readonly SyntheticPdfPageSpec[],
  extraObjects: readonly SyntheticPdfObject[] = [],
): Uint8Array {
  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2);
  const objects: SyntheticPdfObject[] = [
    { objectNumber: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    {
      objectNumber: 2,
      body: `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${String(number)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`,
    },
    { objectNumber: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    ...extraObjects,
  ];
  for (const [index, page] of pages.entries()) {
    const pageObjectNumber = 4 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    const resources = page.resourcesBody ?? "<< /Font << /F1 3 0 R >> >>";
    const mediaBox = formatPageBox(page.mediaBox ?? [0, 0, 612, 792]);
    const cropBox = page.cropBox === undefined ? "" : ` /CropBox ${formatPageBox(page.cropBox)}`;
    const rotate = page.rotate === undefined ? "" : ` /Rotate ${String(page.rotate)}`;
    objects.push(
      {
        objectNumber: pageObjectNumber,
        body: `<< /Type /Page /Parent 2 0 R /Resources ${resources} /MediaBox ${mediaBox}${cropBox}${rotate} /Contents ${String(contentObjectNumber)} 0 R >>`,
      },
      {
        objectNumber: contentObjectNumber,
        body: `<< /Length ${String(textEncoder.encode(page.content).byteLength)} >>\nstream\n${page.content}\nendstream`,
      },
    );
  }
  return buildPdfObjects(objects);
}

export function buildPdfWithImageResource(): Uint8Array {
  return buildPdfWithPageSpecs(
    [{
      resourcesBody: "<< /Font << /F1 10 0 R >> /XObject << /Im1 20 0 R >> >>",
      content: [
        "BT",
        "/F1 16 Tf",
        "1 0 0 1 72 720 Tm",
        "(Image Resource) Tj",
        "ET",
        "q",
        "12 0 0 12 144 600 cm",
        "/Im1 Do",
        "Q",
      ].join("\n"),
    }],
    [
      { objectNumber: 10, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
      {
        objectNumber: 20,
        body: "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Interpolate true /Length 1 >>\nstream\nA\nendstream",
      },
    ],
  );
}

export function buildPdfWithNativeFeatures(): Uint8Array {
  const content = "BT\n/F1 12 Tf\n1 0 0 1 72 720 Tm\n(Native Features) Tj\nET";
  const xmp = "<x:xmpmeta xmlns:x='adobe:ns:meta/'><title>Catalog XMP</title></x:xmpmeta>";
  return buildPdfObjects([
    {
      objectNumber: 1,
      body: "<< /Type /Catalog /Pages 2 0 R /Metadata 30 0 R /Names << /Dests 31 0 R >> /PageLabels 32 0 R /StructTreeRoot 33 0 R >>",
    },
    { objectNumber: 2, body: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>" },
    { objectNumber: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    {
      objectNumber: 4,
      body: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R /StructParents 0 >>",
    },
    {
      objectNumber: 5,
      body: `<< /Length ${String(textEncoder.encode(content).byteLength)} >>\nstream\n${content}\nendstream`,
    },
    {
      objectNumber: 30,
      body: `<< /Type /Metadata /Subtype /XML /Length ${String(textEncoder.encode(xmp).byteLength)} >>\nstream\n${xmp}\nendstream`,
    },
    { objectNumber: 31, body: "<< /Names [(intro) [4 0 R /Fit]] >>" },
    { objectNumber: 32, body: "<< /Nums [0 << /S /r /P (A-) /St 3 >>] >>" },
    { objectNumber: 33, body: "<< /Type /StructTreeRoot /K 34 0 R >>" },
    {
      objectNumber: 34,
      body: "<< /Type /StructElem /S /P /Pg 4 0 R /T (Paragraph title) /Lang (en) /Alt (Accessible alternative) /ActualText (Accessible actual text) /K 0 >>",
    },
    {
      objectNumber: 40,
      body: "<< /Title (Feature Catalog) /Author (PDF Engine) /Department (Research) >>",
    },
  ], "/Info 40 0 R");
}

export function buildPdfWithMultipleDirectActions(): Uint8Array {
  const content = "BT\n/F1 12 Tf\n(Action Inventory) Tj\nET";
  return buildPdfObjects([
    {
      objectNumber: 1,
      body: "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (first) /Next [<< /S /JavaScript /JS (second) >> << /S /Launch /F (manual.txt) >>] >> >>",
    },
    { objectNumber: 2, body: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>" },
    { objectNumber: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    {
      objectNumber: 4,
      body: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>",
    },
    {
      objectNumber: 5,
      body: `<< /Length ${String(textEncoder.encode(content).byteLength)} >>\nstream\n${content}\nendstream`,
    },
  ]);
}

export function buildPdfWithInvalidSignature(): Uint8Array {
  const content = "BT\n/F1 12 Tf\n(Unsigned content) Tj\nET";
  return buildPdfObjects([
    { objectNumber: 1, body: "<< /Type /Catalog /Pages 2 0 R /AcroForm 50 0 R >>" },
    { objectNumber: 2, body: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>" },
    { objectNumber: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    {
      objectNumber: 4,
      body: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>",
    },
    {
      objectNumber: 5,
      body: `<< /Length ${String(textEncoder.encode(content).byteLength)} >>\nstream\n${content}\nendstream`,
    },
    { objectNumber: 50, body: "<< /Fields [51 0 R] >>" },
    { objectNumber: 51, body: "<< /FT /Sig /T (Approval) /V 52 0 R >>" },
    {
      objectNumber: 52,
      body: "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 1 2 1] /Contents <3000> >>",
    },
  ]);
}

export function appendTrailingComment(bytes: Uint8Array, commentText: string): Uint8Array {
  const suffix = textEncoder.encode(`\n% ${commentText}\n`);
  const combined = new Uint8Array(bytes.byteLength + suffix.byteLength);
  combined.set(bytes);
  combined.set(suffix, bytes.byteLength);
  return combined;
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function buildPdfObjects(objects: readonly SyntheticPdfObject[], trailerEntries: string = ""): Uint8Array {
  const offsets = new Map<number, number>();
  const sorted = [...objects].toSorted((left, right) => left.objectNumber - right.objectNumber);
  let pdf = "%PDF-1.4\n";
  for (const object of sorted) {
    offsets.set(object.objectNumber, textEncoder.encode(pdf).byteLength);
    pdf += `${String(object.objectNumber)} 0 obj\n${object.body}\nendobj\n`;
  }
  const xrefOffset = textEncoder.encode(pdf).byteLength;
  const objectCount = Math.max(...sorted.map((object) => object.objectNumber)) + 1;
  pdf += `xref\n0 ${String(objectCount)}\n0000000000 65535 f \n`;
  for (let objectNumber = 1; objectNumber < objectCount; objectNumber += 1) {
    const offset = offsets.get(objectNumber);
    pdf += offset === undefined
      ? "0000000000 65535 f \n"
      : `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size ${String(objectCount)}${trailerEntries.length === 0 ? "" : ` ${trailerEntries}`} >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return textEncoder.encode(pdf);
}

function formatPageBox(box: readonly [number, number, number, number]): string {
  return `[${box.map(String).join(" ")}]`;
}
