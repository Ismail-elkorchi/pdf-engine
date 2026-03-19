export interface PdfStreamPredictorOptions {
  readonly predictor: number;
  readonly colors: number;
  readonly bitsPerComponent: number;
  readonly columns: number;
}

export function applyPdfStreamPredictor(
  decodedBytes: Uint8Array,
  options: PdfStreamPredictorOptions,
): Uint8Array {
  if (options.predictor <= 1) {
    return Uint8Array.from(decodedBytes);
  }

  if (options.predictor === 2) {
    return applyTiffPredictor(decodedBytes, options);
  }

  if (options.predictor >= 10 && options.predictor <= 15) {
    return applyPngPredictor(decodedBytes, options);
  }

  throw new Error(`Unsupported PDF predictor: ${String(options.predictor)}.`);
}

function applyTiffPredictor(
  decodedBytes: Uint8Array,
  options: PdfStreamPredictorOptions,
): Uint8Array {
  const rowBytes = Math.ceil((options.columns * options.colors * options.bitsPerComponent) / 8);
  if (rowBytes === 0) {
    return new Uint8Array();
  }

  if (decodedBytes.byteLength % rowBytes !== 0) {
    throw new Error("Malformed TIFF predictor byte count.");
  }

  const output = Uint8Array.from(decodedBytes);
  const rowCount = decodedBytes.byteLength / rowBytes;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const rowStart = rowIndex * rowBytes;
    applyTiffPredictorRow(output, rowStart, rowBytes, options);
  }

  return output;
}

function applyTiffPredictorRow(
  output: Uint8Array,
  rowStart: number,
  rowBytes: number,
  options: PdfStreamPredictorOptions,
): void {
  if (options.bitsPerComponent === 1 && options.colors === 1) {
    let leftCarry = 0;
    for (let index = 0; index < rowBytes; index += 1) {
      let value = output[rowStart + index] ?? 0;
      value ^= leftCarry;
      value ^= value >> 1;
      value ^= value >> 2;
      value ^= value >> 4;
      leftCarry = (value & 1) << 7;
      output[rowStart + index] = value & 0xff;
    }
    return;
  }

  if (options.bitsPerComponent === 8) {
    for (let index = options.colors; index < rowBytes; index += 1) {
      const absoluteIndex = rowStart + index;
      output[absoluteIndex] = ((output[absoluteIndex] ?? 0) + (output[absoluteIndex - options.colors] ?? 0)) & 0xff;
    }
    return;
  }

  if (options.bitsPerComponent === 16) {
    const bytesPerPixel = options.colors * 2;
    for (let index = bytesPerPixel; index < rowBytes; index += 2) {
      const absoluteIndex = rowStart + index;
      const leftIndex = absoluteIndex - bytesPerPixel;
      const sum =
        (((output[absoluteIndex] ?? 0) & 0xff) << 8) +
        ((output[absoluteIndex + 1] ?? 0) & 0xff) +
        (((output[leftIndex] ?? 0) & 0xff) << 8) +
        ((output[leftIndex + 1] ?? 0) & 0xff);
      output[absoluteIndex] = (sum >> 8) & 0xff;
      output[absoluteIndex + 1] = sum & 0xff;
    }
    return;
  }

  const bitMask = (1 << options.bitsPerComponent) - 1;
  const componentValues = new Uint8Array(options.colors + 1);
  let readBuffer = 0;
  let readBits = 0;
  let writeBuffer = 0;
  let writeBits = 0;
  let readIndex = rowStart;
  let writeIndex = rowStart;

  for (let columnIndex = 0; columnIndex < options.columns; columnIndex += 1) {
    for (let colorIndex = 0; colorIndex < options.colors; colorIndex += 1) {
      while (readBits < options.bitsPerComponent) {
        readBuffer = (readBuffer << 8) | (output[readIndex] ?? 0);
        readBits += 8;
        readIndex += 1;
      }

      const nextComponentValue =
        ((componentValues[colorIndex] ?? 0) + ((readBuffer >> (readBits - options.bitsPerComponent)) & bitMask)) & bitMask;
      componentValues[colorIndex] = nextComponentValue;
      readBits -= options.bitsPerComponent;
      writeBuffer = (writeBuffer << options.bitsPerComponent) | nextComponentValue;
      writeBits += options.bitsPerComponent;

      while (writeBits >= 8) {
        output[writeIndex] = (writeBuffer >> (writeBits - 8)) & 0xff;
        writeBits -= 8;
        writeIndex += 1;
      }
    }
  }

  if (writeBits > 0) {
    output[writeIndex] = (writeBuffer << (8 - writeBits)) + (readBuffer & ((1 << (8 - writeBits)) - 1));
  }
}

function applyPngPredictor(
  decodedBytes: Uint8Array,
  options: PdfStreamPredictorOptions,
): Uint8Array {
  const rowBytes = Math.ceil((options.columns * options.colors * options.bitsPerComponent) / 8);
  const pixelBytes = Math.ceil((options.colors * options.bitsPerComponent) / 8);
  if (rowBytes === 0) {
    return new Uint8Array();
  }

  const rows: number[] = [];
  let index = 0;
  let previousRow: Uint8Array<ArrayBufferLike> = new Uint8Array(rowBytes);

  while (index < decodedBytes.byteLength) {
    const predictorByte = decodedBytes[index];
    if (predictorByte === undefined) {
      break;
    }

    index += 1;
    const row = decodedBytes.slice(index, index + rowBytes);
    if (row.byteLength !== rowBytes) {
      throw new Error("Malformed PNG predictor row.");
    }

    index += rowBytes;
    const decodedRow = decodePngPredictorRow(row, previousRow, predictorByte, pixelBytes);
    rows.push(...decodedRow);
    previousRow = decodedRow;
  }

  if (index !== decodedBytes.byteLength) {
    throw new Error("Malformed PNG predictor stream length.");
  }

  return Uint8Array.from(rows);
}

function decodePngPredictorRow(
  row: Uint8Array,
  previousRow: Uint8Array,
  predictorByte: number,
  pixelBytes: number,
): Uint8Array {
  const decodedRow = Uint8Array.from(row);

  switch (predictorByte) {
    case 0:
      return decodedRow;
    case 1:
      for (let index = pixelBytes; index < decodedRow.byteLength; index += 1) {
        decodedRow[index] = ((decodedRow[index] ?? 0) + (decodedRow[index - pixelBytes] ?? 0)) & 0xff;
      }
      return decodedRow;
    case 2:
      for (let index = 0; index < decodedRow.byteLength; index += 1) {
        decodedRow[index] = ((decodedRow[index] ?? 0) + (previousRow[index] ?? 0)) & 0xff;
      }
      return decodedRow;
    case 3:
      for (let index = 0; index < pixelBytes && index < decodedRow.byteLength; index += 1) {
        decodedRow[index] = (((previousRow[index] ?? 0) >> 1) + (decodedRow[index] ?? 0)) & 0xff;
      }
      for (let index = pixelBytes; index < decodedRow.byteLength; index += 1) {
        decodedRow[index] =
          ((((previousRow[index] ?? 0) + (decodedRow[index - pixelBytes] ?? 0)) >> 1) + (decodedRow[index] ?? 0)) &
          0xff;
      }
      return decodedRow;
    case 4:
      for (let index = 0; index < pixelBytes && index < decodedRow.byteLength; index += 1) {
        decodedRow[index] = ((previousRow[index] ?? 0) + (decodedRow[index] ?? 0)) & 0xff;
      }
      for (let index = pixelBytes; index < decodedRow.byteLength; index += 1) {
        const up = previousRow[index] ?? 0;
        const upLeft = previousRow[index - pixelBytes] ?? 0;
        const left = decodedRow[index - pixelBytes] ?? 0;
        const prediction = left + up - upLeft;
        const leftDistance = Math.abs(prediction - left);
        const upDistance = Math.abs(prediction - up);
        const upLeftDistance = Math.abs(prediction - upLeft);
        const predictor =
          leftDistance <= upDistance && leftDistance <= upLeftDistance ? left : upDistance <= upLeftDistance ? up : upLeft;
        decodedRow[index] = (predictor + (decodedRow[index] ?? 0)) & 0xff;
      }
      return decodedRow;
    default:
      throw new Error(`Unsupported PNG predictor row type: ${String(predictorByte)}.`);
  }
}
