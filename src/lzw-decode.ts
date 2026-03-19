export interface PdfLzwDecodeOptions {
  readonly earlyChange: number;
}

export function decodeLzwBytes(rawBytes: Uint8Array, options: PdfLzwDecodeOptions): Uint8Array {
  const maxDictionarySize = 4096;
  const dictionaryValues = new Uint8Array(maxDictionarySize);
  const dictionaryLengths = new Uint16Array(maxDictionarySize);
  const dictionaryPrevCodes = new Uint16Array(maxDictionarySize);
  const currentSequence = new Uint8Array(maxDictionarySize);

  for (let index = 0; index < 256; index += 1) {
    dictionaryValues[index] = index;
    dictionaryLengths[index] = 1;
  }

  let byteIndex = 0;
  let cachedData = 0;
  let bitsCached = 0;
  let codeLength = 9;
  let nextCode = 258;
  let previousCode: number | undefined;
  let currentSequenceLength = 0;
  const decodedBytes: number[] = [];

  while (true) {
    const code = readLzwBits(rawBytes, codeLength, {
      get byteIndex() {
        return byteIndex;
      },
      set byteIndex(value: number) {
        byteIndex = value;
      },
      get cachedData() {
        return cachedData;
      },
      set cachedData(value: number) {
        cachedData = value;
      },
      get bitsCached() {
        return bitsCached;
      },
      set bitsCached(value: number) {
        bitsCached = value;
      },
    });

    if (code === undefined) {
      break;
    }

    if (code < 256) {
      currentSequence[0] = code;
      currentSequenceLength = 1;
    } else if (code >= 258) {
      if (code < nextCode) {
        currentSequenceLength = dictionaryLengths[code] ?? 0;
        for (let currentIndex = currentSequenceLength - 1, sequenceCode = code; currentIndex >= 0; currentIndex -= 1) {
          currentSequence[currentIndex] = dictionaryValues[sequenceCode] ?? 0;
          sequenceCode = dictionaryPrevCodes[sequenceCode] ?? 0;
        }
      } else if (code === nextCode && currentSequenceLength > 0) {
        currentSequence[currentSequenceLength] = currentSequence[0] ?? 0;
        currentSequenceLength += 1;
      } else {
        throw new Error("Malformed LZW code stream.");
      }
    } else if (code === 256) {
      codeLength = 9;
      nextCode = 258;
      previousCode = undefined;
      currentSequenceLength = 0;
      continue;
    } else {
      break;
    }

    if (previousCode !== undefined && nextCode < maxDictionarySize) {
      dictionaryPrevCodes[nextCode] = previousCode;
      dictionaryLengths[nextCode] = (dictionaryLengths[previousCode] ?? 0) + 1;
      dictionaryValues[nextCode] = currentSequence[0] ?? 0;
      nextCode += 1;

      if (shouldGrowLzwCodeLength(nextCode, options.earlyChange, codeLength)) {
        codeLength += 1;
      }
    }

    previousCode = code;
    for (let index = 0; index < currentSequenceLength; index += 1) {
      decodedBytes.push(currentSequence[index] ?? 0);
    }
  }

  return Uint8Array.from(decodedBytes);
}

function readLzwBits(
  rawBytes: Uint8Array,
  count: number,
  state: {
    byteIndex: number;
    cachedData: number;
    bitsCached: number;
  },
): number | undefined {
  let { byteIndex, cachedData, bitsCached } = state;

  while (bitsCached < count) {
    const nextByte = rawBytes[byteIndex];
    if (nextByte === undefined) {
      if (bitsCached === 0) {
        return undefined;
      }

      cachedData <<= count - bitsCached;
      bitsCached = count;
      break;
    }

    cachedData = (cachedData << 8) | nextByte;
    bitsCached += 8;
    byteIndex += 1;
  }

  bitsCached -= count;
  state.byteIndex = byteIndex;
  state.cachedData = cachedData;
  state.bitsCached = bitsCached;
  return (cachedData >>> bitsCached) & ((1 << count) - 1);
}

function shouldGrowLzwCodeLength(nextCode: number, earlyChange: number, codeLength: number): boolean {
  if (codeLength >= 12) {
    return false;
  }

  const threshold = 1 << codeLength;
  return nextCode + earlyChange >= threshold;
}
