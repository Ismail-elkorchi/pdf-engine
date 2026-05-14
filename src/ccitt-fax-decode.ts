/*
 * This decoder is adapted from the public-domain/Apache lineage used by XPDF and PDF.js
 * for /CCITTFaxDecode handling, but reshaped for pdf-engine's raw Uint8Array decoder surface.
 */

const CCITT_EOL = -2;
const CCITT_EOF = -1;
const TWO_DIM_PASS = 0;
const TWO_DIM_HORIZ = 1;
const TWO_DIM_VERT_0 = 2;
const TWO_DIM_VERT_R1 = 3;
const TWO_DIM_VERT_L1 = 4;
const TWO_DIM_VERT_R2 = 5;
const TWO_DIM_VERT_L2 = 6;
const TWO_DIM_VERT_R3 = 7;
const TWO_DIM_VERT_L3 = 8;

const TWO_DIM_CODES = new Map<string, number>([
  ["1", TWO_DIM_VERT_0],
  ["001", TWO_DIM_HORIZ],
  ["010", TWO_DIM_VERT_L1],
  ["011", TWO_DIM_VERT_R1],
  ["0001", TWO_DIM_PASS],
  ["000010", TWO_DIM_VERT_L2],
  ["000011", TWO_DIM_VERT_R2],
  ["0000010", TWO_DIM_VERT_L3],
  ["0000011", TWO_DIM_VERT_R3],
]);

const WHITE_RUN_CODES = new Map<string, number>([
  ["0111", 2],
  ["1000", 3],
  ["1011", 4],
  ["1100", 5],
  ["1110", 6],
  ["1111", 7],
  ["00111", 10],
  ["01000", 11],
  ["10010", 128],
  ["10011", 8],
  ["10100", 9],
  ["11011", 64],
  ["000011", 13],
  ["000111", 1],
  ["001000", 12],
  ["010111", 192],
  ["011000", 1664],
  ["101010", 16],
  ["101011", 17],
  ["110100", 14],
  ["110101", 15],
  ["0000011", 22],
  ["0000100", 23],
  ["0001000", 20],
  ["0001100", 19],
  ["0010011", 26],
  ["0010111", 21],
  ["0011000", 28],
  ["0100100", 27],
  ["0100111", 18],
  ["0101000", 24],
  ["0101011", 25],
  ["0110111", 256],
  ["00000010", 29],
  ["00000011", 30],
  ["00000100", 45],
  ["00000101", 46],
  ["00001010", 47],
  ["00001011", 48],
  ["00010010", 33],
  ["00010011", 34],
  ["00010100", 35],
  ["00010101", 36],
  ["00010110", 37],
  ["00010111", 38],
  ["00011010", 31],
  ["00011011", 32],
  ["00100100", 53],
  ["00100101", 54],
  ["00101000", 39],
  ["00101001", 40],
  ["00101010", 41],
  ["00101011", 42],
  ["00101100", 43],
  ["00101101", 44],
  ["00110010", 61],
  ["00110011", 62],
  ["00110100", 63],
  ["00110101", 0],
  ["00110110", 320],
  ["00110111", 384],
  ["01001010", 59],
  ["01001011", 60],
  ["01010010", 49],
  ["01010011", 50],
  ["01010100", 51],
  ["01010101", 52],
  ["01011000", 55],
  ["01011001", 56],
  ["01011010", 57],
  ["01011011", 58],
  ["01100100", 448],
  ["01100101", 512],
  ["01100111", 640],
  ["01101000", 576],
  ["010011000", 1472],
  ["010011001", 1536],
  ["010011010", 1600],
  ["010011011", 1728],
  ["011001100", 704],
  ["011001101", 768],
  ["011010010", 832],
  ["011010011", 896],
  ["011010100", 960],
  ["011010101", 1024],
  ["011010110", 1088],
  ["011010111", 1152],
  ["011011000", 1216],
  ["011011001", 1280],
  ["011011010", 1344],
  ["011011011", 1408],
  ["00000001000", 1792],
  ["00000001100", 1856],
  ["00000001101", 1920],
  ["000000000001", CCITT_EOL],
  ["000000010010", 1984],
  ["000000010011", 2048],
  ["000000010100", 2112],
  ["000000010101", 2176],
  ["000000010110", 2240],
  ["000000010111", 2304],
  ["000000011100", 2368],
  ["000000011101", 2432],
  ["000000011110", 2496],
  ["000000011111", 2560],
]);

const BLACK_RUN_CODES = new Map<string, number>([
  ["10", 3],
  ["11", 2],
  ["010", 1],
  ["011", 4],
  ["0010", 6],
  ["0011", 5],
  ["00011", 7],
  ["000100", 9],
  ["000101", 8],
  ["0000100", 10],
  ["0000101", 11],
  ["0000111", 12],
  ["00000100", 13],
  ["00000111", 14],
  ["000011000", 15],
  ["0000001000", 18],
  ["0000001111", 64],
  ["0000010111", 16],
  ["0000011000", 17],
  ["0000110111", 0],
  ["00000001000", 1792],
  ["00000001100", 1856],
  ["00000001101", 1920],
  ["00000010111", 24],
  ["00000011000", 25],
  ["00000101000", 23],
  ["00000110111", 22],
  ["00001100111", 19],
  ["00001101000", 20],
  ["00001101100", 21],
  ["000000000001", CCITT_EOL],
  ["000000010010", 1984],
  ["000000010011", 2048],
  ["000000010100", 2112],
  ["000000010101", 2176],
  ["000000010110", 2240],
  ["000000010111", 2304],
  ["000000011100", 2368],
  ["000000011101", 2432],
  ["000000011110", 2496],
  ["000000011111", 2560],
  ["000000100100", 52],
  ["000000100111", 55],
  ["000000101000", 56],
  ["000000101011", 59],
  ["000000101100", 60],
  ["000000110011", 320],
  ["000000110100", 384],
  ["000000110101", 448],
  ["000000110111", 53],
  ["000000111000", 54],
  ["000001010010", 50],
  ["000001010011", 51],
  ["000001010100", 44],
  ["000001010101", 45],
  ["000001010110", 46],
  ["000001010111", 47],
  ["000001011000", 57],
  ["000001011001", 58],
  ["000001011010", 61],
  ["000001011011", 256],
  ["000001100100", 48],
  ["000001100101", 49],
  ["000001100110", 62],
  ["000001100111", 63],
  ["000001101000", 30],
  ["000001101001", 31],
  ["000001101010", 32],
  ["000001101011", 33],
  ["000001101100", 40],
  ["000001101101", 41],
  ["000011001000", 128],
  ["000011001001", 192],
  ["000011001010", 26],
  ["000011001011", 27],
  ["000011001100", 28],
  ["000011001101", 29],
  ["000011010010", 34],
  ["000011010011", 35],
  ["000011010100", 36],
  ["000011010101", 37],
  ["000011010110", 38],
  ["000011010111", 39],
  ["000011011010", 42],
  ["000011011011", 43],
  ["0000001001010", 640],
  ["0000001001011", 704],
  ["0000001001100", 768],
  ["0000001001101", 832],
  ["0000001010010", 1280],
  ["0000001010011", 1344],
  ["0000001010100", 1408],
  ["0000001010101", 1472],
  ["0000001011010", 1536],
  ["0000001011011", 1600],
  ["0000001100100", 1664],
  ["0000001100101", 1728],
  ["0000001101100", 512],
  ["0000001101101", 576],
  ["0000001110010", 896],
  ["0000001110011", 960],
  ["0000001110100", 1024],
  ["0000001110101", 1088],
  ["0000001110110", 1152],
  ["0000001110111", 1216],
]);

const MAX_TWO_DIM_BITS = 7;
const MAX_WHITE_BITS = 12;
const MAX_BLACK_BITS = 13;

export interface PdfCcittFaxDecodeOptions {
  readonly k: number;
  readonly endOfLine: boolean;
  readonly encodedByteAlign: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly endOfBlock: boolean;
  readonly blackIs1: boolean;
}

export function decodeCcittFaxBytes(
  rawBytes: Uint8Array,
  options: PdfCcittFaxDecodeOptions,
): Uint8Array {
  const decoder = new PdfCcittFaxDecoder(rawBytes, options);
  const decodedBytes: number[] = [];

  while (true) {
    const decodedByte = decoder.readNextByte();
    if (decodedByte < 0) {
      if (decoder.didEncounterError()) {
        throw new Error("Malformed CCITT fax stream.");
      }
      return Uint8Array.from(decodedBytes);
    }

    decodedBytes.push(decodedByte);
  }
}

class PdfCcittFaxDecoder {
  private readonly columns: number;
  private readonly rows: number;
  private readonly endOfLine: boolean;
  private readonly encodedByteAlign: boolean;
  private readonly endOfBlock: boolean;
  private readonly blackIs1: boolean;
  private readonly encoding: number;
  private readonly rawBytes: Uint8Array;
  private readonly codingLine: Uint32Array;
  private readonly referenceLine: Uint32Array;

  private rawIndex = 0;
  private inputBuffer = 0;
  private inputBits = 0;
  private eof = false;
  private row = 0;
  private rowsDone = false;
  private nextLine2D: boolean;
  private outputBits = 0;
  private codingPosition = 0;
  private hasError = false;
  private encounteredError = false;

  constructor(rawBytes: Uint8Array, options: PdfCcittFaxDecodeOptions) {
    this.rawBytes = rawBytes;
    this.encoding = options.k;
    this.endOfLine = options.endOfLine;
    this.encodedByteAlign = options.encodedByteAlign;
    this.columns = options.columns;
    this.rows = options.rows;
    this.endOfBlock = options.endOfBlock;
    this.blackIs1 = options.blackIs1;
    this.codingLine = new Uint32Array(this.columns + 1);
    this.referenceLine = new Uint32Array(this.columns + 2);
    this.codingLine[0] = this.columns;
    this.nextLine2D = this.encoding < 0;

    let code = this.lookBits(12);
    while (code === 0) {
      this.eatBits(1);
      code = this.lookBits(12);
    }

    if (code === 1) {
      this.eatBits(12);
    }

    if (this.encoding > 0) {
      this.nextLine2D = this.lookBits(1) === 0;
      this.eatBits(1);
    }
  }

  readNextByte(): number {
    if (this.eof) {
      return -1;
    }

    if (this.outputBits === 0) {
      if (this.rowsDone) {
        this.eof = true;
      }
      if (this.eof) {
        return -1;
      }

      this.hasError = false;
      if (this.nextLine2D) {
        this.decodeTwoDimensionalLine();
      } else {
        this.decodeOneDimensionalLine();
      }
      if (this.hasError) {
        this.encounteredError = true;
      }

      this.finishDecodedLine();
      this.outputBits = (this.codingLine[0] ?? 0) > 0
        ? (this.codingLine[(this.codingPosition = 0)] ?? 0)
        : (this.codingLine[(this.codingPosition = 1)] ?? 0);
      this.row += 1;
    }

    let decodedByte: number;
    if (this.outputBits >= 8) {
      decodedByte = this.codingPosition & 1 ? 0x00 : 0xff;
      this.outputBits -= 8;
      if (this.outputBits === 0 && (this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
        this.codingPosition += 1;
        this.outputBits = (this.codingLine[this.codingPosition] ?? this.columns) - (this.codingLine[this.codingPosition - 1] ?? 0);
      }
    } else {
      let bitsRemaining = 8;
      decodedByte = 0;

      while (bitsRemaining > 0) {
        if (this.outputBits > bitsRemaining) {
          decodedByte <<= bitsRemaining;
          if ((this.codingPosition & 1) === 0) {
            decodedByte |= 0xff >> (8 - bitsRemaining);
          }
          this.outputBits -= bitsRemaining;
          bitsRemaining = 0;
          continue;
        }

        decodedByte <<= this.outputBits;
        if ((this.codingPosition & 1) === 0) {
          decodedByte |= 0xff >> (8 - this.outputBits);
        }
        bitsRemaining -= this.outputBits;
        this.outputBits = 0;

        if ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
          this.codingPosition += 1;
          this.outputBits = (this.codingLine[this.codingPosition] ?? this.columns) - (this.codingLine[this.codingPosition - 1] ?? 0);
        } else if (bitsRemaining > 0) {
          decodedByte <<= bitsRemaining;
          bitsRemaining = 0;
        }
      }
    }

    if (this.blackIs1) {
      decodedByte ^= 0xff;
    }

    return decodedByte;
  }

  didEncounterError(): boolean {
    return this.encounteredError;
  }

  private decodeTwoDimensionalLine(): void {
    for (let index = 0; (this.codingLine[index] ?? this.columns) < this.columns; index += 1) {
      this.referenceLine[index] = this.codingLine[index] ?? this.columns;
    }
    let referenceTail = 0;
    while ((this.referenceLine[referenceTail] ?? this.columns) < this.columns) {
      referenceTail += 1;
    }
    this.referenceLine[referenceTail] = this.columns;
    this.referenceLine[referenceTail + 1] = this.columns;
    this.codingLine[0] = 0;
    this.codingPosition = 0;
    let referencePosition = 0;
    let blackPixels = 0;

    while ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
      const code = this.getTwoDimensionalCode();
      switch (code) {
        case TWO_DIM_PASS:
          this.addPixels(this.referenceLine[referencePosition + 1] ?? this.columns, blackPixels);
          if ((this.referenceLine[referencePosition + 1] ?? this.columns) < this.columns) {
            referencePosition += 2;
          }
          break;
        case TWO_DIM_HORIZ: {
          let firstRun = 0;
          let secondRun = 0;
          let runPart = 0;
          if (blackPixels) {
            do {
              runPart = this.getBlackRunCode();
              firstRun += runPart;
            } while (runPart >= 64);
            do {
              runPart = this.getWhiteRunCode();
              secondRun += runPart;
            } while (runPart >= 64);
          } else {
            do {
              runPart = this.getWhiteRunCode();
              firstRun += runPart;
            } while (runPart >= 64);
            do {
              runPart = this.getBlackRunCode();
              secondRun += runPart;
            } while (runPart >= 64);
          }
          this.addPixels((this.codingLine[this.codingPosition] ?? 0) + firstRun, blackPixels);
          if ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
            this.addPixels((this.codingLine[this.codingPosition] ?? 0) + secondRun, blackPixels ^ 1);
          }
          while (
            (this.referenceLine[referencePosition] ?? this.columns) <= (this.codingLine[this.codingPosition] ?? this.columns) &&
            (this.referenceLine[referencePosition] ?? this.columns) < this.columns
          ) {
            referencePosition += 2;
          }
          break;
        }
        case TWO_DIM_VERT_R3:
          this.addPixels((this.referenceLine[referencePosition] ?? this.columns) + 3, blackPixels);
          blackPixels ^= 1;
          if ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
            referencePosition += 1;
            while (
              (this.referenceLine[referencePosition] ?? this.columns) <= (this.codingLine[this.codingPosition] ?? this.columns) &&
              (this.referenceLine[referencePosition] ?? this.columns) < this.columns
            ) {
              referencePosition += 2;
            }
          }
          break;
        case TWO_DIM_VERT_R2:
          this.addPixels((this.referenceLine[referencePosition] ?? this.columns) + 2, blackPixels);
          blackPixels ^= 1;
          if ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
            referencePosition += 1;
            while (
              (this.referenceLine[referencePosition] ?? this.columns) <= (this.codingLine[this.codingPosition] ?? this.columns) &&
              (this.referenceLine[referencePosition] ?? this.columns) < this.columns
            ) {
              referencePosition += 2;
            }
          }
          break;
        case TWO_DIM_VERT_R1:
          this.addPixels((this.referenceLine[referencePosition] ?? this.columns) + 1, blackPixels);
          blackPixels ^= 1;
          if ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
            referencePosition += 1;
            while (
              (this.referenceLine[referencePosition] ?? this.columns) <= (this.codingLine[this.codingPosition] ?? this.columns) &&
              (this.referenceLine[referencePosition] ?? this.columns) < this.columns
            ) {
              referencePosition += 2;
            }
          }
          break;
        case TWO_DIM_VERT_0:
          this.addPixels(this.referenceLine[referencePosition] ?? this.columns, blackPixels);
          blackPixels ^= 1;
          if ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
            referencePosition += 1;
            while (
              (this.referenceLine[referencePosition] ?? this.columns) <= (this.codingLine[this.codingPosition] ?? this.columns) &&
              (this.referenceLine[referencePosition] ?? this.columns) < this.columns
            ) {
              referencePosition += 2;
            }
          }
          break;
        case TWO_DIM_VERT_L3:
          this.addPixelsNegative((this.referenceLine[referencePosition] ?? this.columns) - 3, blackPixels);
          blackPixels ^= 1;
          if ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
            referencePosition = referencePosition > 0 ? referencePosition - 1 : referencePosition + 1;
            while (
              (this.referenceLine[referencePosition] ?? this.columns) <= (this.codingLine[this.codingPosition] ?? this.columns) &&
              (this.referenceLine[referencePosition] ?? this.columns) < this.columns
            ) {
              referencePosition += 2;
            }
          }
          break;
        case TWO_DIM_VERT_L2:
          this.addPixelsNegative((this.referenceLine[referencePosition] ?? this.columns) - 2, blackPixels);
          blackPixels ^= 1;
          if ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
            referencePosition = referencePosition > 0 ? referencePosition - 1 : referencePosition + 1;
            while (
              (this.referenceLine[referencePosition] ?? this.columns) <= (this.codingLine[this.codingPosition] ?? this.columns) &&
              (this.referenceLine[referencePosition] ?? this.columns) < this.columns
            ) {
              referencePosition += 2;
            }
          }
          break;
        case TWO_DIM_VERT_L1:
          this.addPixelsNegative((this.referenceLine[referencePosition] ?? this.columns) - 1, blackPixels);
          blackPixels ^= 1;
          if ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
            referencePosition = referencePosition > 0 ? referencePosition - 1 : referencePosition + 1;
            while (
              (this.referenceLine[referencePosition] ?? this.columns) <= (this.codingLine[this.codingPosition] ?? this.columns) &&
              (this.referenceLine[referencePosition] ?? this.columns) < this.columns
            ) {
              referencePosition += 2;
            }
          }
          break;
        case CCITT_EOF:
          this.addPixels(this.columns, 0);
          this.eof = true;
          break;
        default:
          this.hasError = true;
          this.addPixels(this.columns, 0);
          break;
      }
    }
  }

  private decodeOneDimensionalLine(): void {
    this.codingLine[0] = 0;
    this.codingPosition = 0;
    let blackPixels = 0;

    while ((this.codingLine[this.codingPosition] ?? this.columns) < this.columns) {
      let runLength = 0;
      let runPart = 0;
      if (blackPixels) {
        do {
          runPart = this.getBlackRunCode();
          runLength += runPart;
        } while (runPart >= 64);
      } else {
        do {
          runPart = this.getWhiteRunCode();
          runLength += runPart;
        } while (runPart >= 64);
      }
      this.addPixels((this.codingLine[this.codingPosition] ?? 0) + runLength, blackPixels);
      blackPixels ^= 1;
    }
  }

  private finishDecodedLine(): void {
    let gotEol = false;
    if (this.encodedByteAlign) {
      this.inputBits &= ~7;
    }

    if (!this.endOfBlock && this.row === this.rows - 1) {
      this.rowsDone = true;
    } else {
      let code = this.lookBits(12);
      if (this.endOfLine) {
        while (code !== CCITT_EOF && code !== 1) {
          this.eatBits(1);
          code = this.lookBits(12);
        }
      } else {
        while (code === 0) {
          this.eatBits(1);
          code = this.lookBits(12);
        }
      }

      if (code === 1) {
        this.eatBits(12);
        gotEol = true;
      } else if (code === CCITT_EOF) {
        this.eof = true;
      }
    }

    if (!this.eof && this.encoding > 0 && !this.rowsDone) {
      this.nextLine2D = this.lookBits(1) === 0;
      this.eatBits(1);
    }

    if (this.endOfBlock && gotEol && this.encodedByteAlign) {
      let code = this.lookBits(12);
      if (code === 1) {
        this.eatBits(12);
        if (this.encoding > 0) {
          this.lookBits(1);
          this.eatBits(1);
        }
        if (this.encoding >= 0) {
          for (let index = 0; index < 4; index += 1) {
            code = this.lookBits(12);
            this.eatBits(12);
            if (this.encoding > 0) {
              this.lookBits(1);
              this.eatBits(1);
            }
          }
        }
        this.eof = true;
      }
      return;
    }

    if (this.hasError && this.endOfLine) {
      while (true) {
        const code = this.lookBits(13);
        if (code === CCITT_EOF) {
          this.eof = true;
          return;
        }
        if ((code >> 1) === 1) {
          this.eatBits(12);
          if (this.encoding > 0) {
            this.eatBits(1);
            this.nextLine2D = (code & 1) === 0;
          }
          return;
        }
        this.eatBits(1);
      }
    }
  }

  private addPixels(position: number, blackPixels: number): void {
    let nextPosition = position;
    if (nextPosition > (this.codingLine[this.codingPosition] ?? 0)) {
      if (nextPosition > this.columns) {
        nextPosition = this.columns;
        this.hasError = true;
      }
      if (((this.codingPosition & 1) ^ blackPixels) !== 0) {
        this.codingPosition += 1;
      }
      this.codingLine[this.codingPosition] = nextPosition;
    }
  }

  private addPixelsNegative(position: number, blackPixels: number): void {
    let nextPosition = position;
    if (nextPosition > (this.codingLine[this.codingPosition] ?? 0)) {
      if (nextPosition > this.columns) {
        nextPosition = this.columns;
        this.hasError = true;
      }
      if (((this.codingPosition & 1) ^ blackPixels) !== 0) {
        this.codingPosition += 1;
      }
      this.codingLine[this.codingPosition] = nextPosition;
      return;
    }

    if (nextPosition < (this.codingLine[this.codingPosition] ?? 0)) {
      if (nextPosition < 0) {
        nextPosition = 0;
        this.hasError = true;
      }
      while (this.codingPosition > 0 && nextPosition < (this.codingLine[this.codingPosition - 1] ?? 0)) {
        this.codingPosition -= 1;
      }
      this.codingLine[this.codingPosition] = nextPosition;
    }
  }

  private getTwoDimensionalCode(): number {
    const code = this.readMappedCode(TWO_DIM_CODES, MAX_TWO_DIM_BITS);
    if (code !== undefined) {
      return code;
    }

    this.hasError = true;
    return CCITT_EOF;
  }

  private getWhiteRunCode(): number {
    const code = this.readMappedCode(WHITE_RUN_CODES, MAX_WHITE_BITS);
    if (code !== undefined) {
      return code;
    }

    if (this.lookBits(1) !== CCITT_EOF) {
      this.eatBits(1);
    }
    this.hasError = true;
    return 1;
  }

  private getBlackRunCode(): number {
    const code = this.readMappedCode(BLACK_RUN_CODES, MAX_BLACK_BITS);
    if (code !== undefined) {
      return code;
    }

    if (this.lookBits(1) !== CCITT_EOF) {
      this.eatBits(1);
    }
    this.hasError = true;
    return 1;
  }

  private readMappedCode(table: ReadonlyMap<string, number>, maxBits: number): number | undefined {
    for (let length = 1; length <= maxBits; length += 1) {
      const bits = this.lookBits(length);
      if (bits === CCITT_EOF) {
        return undefined;
      }

      const bitText = bits.toString(2).padStart(length, "0");
      const code = table.get(bitText);
      if (code !== undefined) {
        this.eatBits(length);
        return code;
      }
    }

    return undefined;
  }

  private lookBits(bitCount: number): number {
    while (this.inputBits < bitCount) {
      const nextByte = this.rawBytes[this.rawIndex];
      if (nextByte === undefined) {
        if (this.inputBits === 0) {
          return CCITT_EOF;
        }

        return (this.inputBuffer << (bitCount - this.inputBits)) & (0xffff >> (16 - bitCount));
      }

      this.inputBuffer = (this.inputBuffer << 8) | nextByte;
      this.inputBits += 8;
      this.rawIndex += 1;
    }

    return (this.inputBuffer >> (this.inputBits - bitCount)) & (0xffff >> (16 - bitCount));
  }

  private eatBits(bitCount: number): void {
    this.inputBits -= bitCount;
    if (this.inputBits < 0) {
      this.inputBits = 0;
    }
  }
}
