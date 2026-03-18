export interface PdfSingleByteFontEncoding {
  readonly unicodeByCharCode: ReadonlyArray<string | undefined>;
}

export interface PdfSingleByteDecodeResult {
  readonly text: string;
  readonly complete: boolean;
  readonly sourceUnitCount: number;
  readonly mappedUnitCount: number;
}

const DIGIT_NAMES = new Map([
  ["zero", "0"],
  ["one", "1"],
  ["two", "2"],
  ["three", "3"],
  ["four", "4"],
  ["five", "5"],
  ["six", "6"],
  ["seven", "7"],
  ["eight", "8"],
  ["nine", "9"],
]);

const GLYPH_NAME_TO_UNICODE = new Map<string, string>([
  ["space", " "],
  ["nonbreakingspace", " "],
  ["exclam", "!"],
  ["exclamdown", "¡"],
  ["quotedbl", "\""],
  ["numbersign", "#"],
  ["dollar", "$"],
  ["percent", "%"],
  ["ampersand", "&"],
  ["quotesingle", "'"],
  ["parenleft", "("],
  ["parenright", ")"],
  ["asterisk", "*"],
  ["plus", "+"],
  ["comma", ","],
  ["hyphen", "-"],
  ["period", "."],
  ["slash", "/"],
  ["colon", ":"],
  ["semicolon", ";"],
  ["less", "<"],
  ["equal", "="],
  ["greater", ">"],
  ["question", "?"],
  ["questiondown", "¿"],
  ["at", "@"],
  ["bracketleft", "["],
  ["backslash", "\\"],
  ["bracketright", "]"],
  ["asciicircum", "^"],
  ["underscore", "_"],
  ["grave", "`"],
  ["braceleft", "{"],
  ["bar", "|"],
  ["braceright", "}"],
  ["asciitilde", "~"],
  ["bullet", "•"],
  ["dagger", "†"],
  ["daggerdbl", "‡"],
  ["ellipsis", "…"],
  ["emdash", "—"],
  ["endash", "–"],
  ["florin", "ƒ"],
  ["fraction", "⁄"],
  ["guillemotleft", "«"],
  ["guillemotright", "»"],
  ["guilsinglleft", "‹"],
  ["guilsinglright", "›"],
  ["minus", "−"],
  ["perthousand", "‰"],
  ["quotedblbase", "„"],
  ["quotedblleft", "“"],
  ["quotedblright", "”"],
  ["quoteleft", "‘"],
  ["quoteright", "’"],
  ["quotesinglbase", "‚"],
  ["trademark", "™"],
  ["fi", "fi"],
  ["fl", "fl"],
  ["Lslash", "Ł"],
  ["lslash", "ł"],
  ["OE", "Œ"],
  ["oe", "œ"],
  ["Scaron", "Š"],
  ["scaron", "š"],
  ["Ydieresis", "Ÿ"],
  ["Zcaron", "Ž"],
  ["zcaron", "ž"],
  ["dotlessi", "ı"],
  ["Euro", "€"],
  ["cent", "¢"],
  ["currency", "¤"],
  ["brokenbar", "¦"],
  ["dieresis", "¨"],
  ["copyright", "©"],
  ["ordfeminine", "ª"],
  ["logicalnot", "¬"],
  ["registered", "®"],
  ["macron", "¯"],
  ["degree", "°"],
  ["plusminus", "±"],
  ["twosuperior", "²"],
  ["threesuperior", "³"],
  ["acute", "´"],
  ["mu", "µ"],
  ["periodcentered", "·"],
  ["cedilla", "¸"],
  ["onesuperior", "¹"],
  ["ordmasculine", "º"],
  ["onequarter", "¼"],
  ["onehalf", "½"],
  ["threequarters", "¾"],
  ["Agrave", "À"],
  ["Aacute", "Á"],
  ["Acircumflex", "Â"],
  ["Atilde", "Ã"],
  ["Adieresis", "Ä"],
  ["Aring", "Å"],
  ["AE", "Æ"],
  ["Ccedilla", "Ç"],
  ["Egrave", "È"],
  ["Eacute", "É"],
  ["Ecircumflex", "Ê"],
  ["Edieresis", "Ë"],
  ["Igrave", "Ì"],
  ["Iacute", "Í"],
  ["Icircumflex", "Î"],
  ["Idieresis", "Ï"],
  ["Eth", "Ð"],
  ["Ntilde", "Ñ"],
  ["Ograve", "Ò"],
  ["Oacute", "Ó"],
  ["Ocircumflex", "Ô"],
  ["Otilde", "Õ"],
  ["Odieresis", "Ö"],
  ["multiply", "×"],
  ["Oslash", "Ø"],
  ["Ugrave", "Ù"],
  ["Uacute", "Ú"],
  ["Ucircumflex", "Û"],
  ["Udieresis", "Ü"],
  ["Yacute", "Ý"],
  ["Thorn", "Þ"],
  ["germandbls", "ß"],
  ["agrave", "à"],
  ["aacute", "á"],
  ["acircumflex", "â"],
  ["atilde", "ã"],
  ["adieresis", "ä"],
  ["aring", "å"],
  ["ae", "æ"],
  ["ccedilla", "ç"],
  ["egrave", "è"],
  ["eacute", "é"],
  ["ecircumflex", "ê"],
  ["edieresis", "ë"],
  ["igrave", "ì"],
  ["iacute", "í"],
  ["icircumflex", "î"],
  ["idieresis", "ï"],
  ["eth", "ð"],
  ["ntilde", "ñ"],
  ["ograve", "ò"],
  ["oacute", "ó"],
  ["ocircumflex", "ô"],
  ["otilde", "õ"],
  ["odieresis", "ö"],
  ["divide", "÷"],
  ["oslash", "ø"],
  ["ugrave", "ù"],
  ["uacute", "ú"],
  ["ucircumflex", "û"],
  ["udieresis", "ü"],
  ["yacute", "ý"],
  ["thorn", "þ"],
  ["ydieresis", "ÿ"],
  ["breve", "˘"],
  ["caron", "ˇ"],
  ["circumflex", "ˆ"],
  ["dotaccent", "˙"],
  ["hungarumlaut", "˝"],
  ["ogonek", "˛"],
  ["ring", "˚"],
  ["tilde", "˜"],
  ["section", "§"],
  ["paragraph", "¶"],
  ["sterling", "£"],
  ["yen", "¥"],
  ["ff", "ff"],
  ["ffi", "ffi"],
  ["ffl", "ffl"],
  ["f_f", "ff"],
  ["f_f_i", "ffi"],
  ["f_f_l", "ffl"],
  ["f_i", "fi"],
  ["f_l", "fl"],
  ["Omega", "Ω"],
  ["phi", "φ"],
  ["pi", "π"],
  ["summation", "∑"],
  ["product", "∏"],
  ["integral", "∫"],
  ["infinity", "∞"],
  ["approxequal", "≈"],
  ["arrowright", "→"],
  ["lessequal", "≤"],
  ["greaterequal", "≥"],
  ["notequal", "≠"],
  ["partialdiff", "∂"],
  ["radical", "√"],
  ["lozenge", "◊"],
  ["apple", ""],
  ["Abreve", "Ă"],
  ["abreve", "ă"],
  ["Aogonek", "Ą"],
  ["aogonek", "ą"],
  ["Amacron", "Ā"],
  ["amacron", "ā"],
  ["AEacute", "Ǽ"],
  ["aeacute", "ǽ"],
  ["Cacute", "Ć"],
  ["cacute", "ć"],
  ["Ccaron", "Č"],
  ["ccaron", "č"],
  ["Ccircumflex", "Ĉ"],
  ["ccircumflex", "ĉ"],
  ["Cdotaccent", "Ċ"],
  ["cdotaccent", "ċ"],
  ["Dcaron", "Ď"],
  ["dcaron", "ď"],
  ["Dcroat", "Đ"],
  ["dcroat", "đ"],
  ["Ebreve", "Ĕ"],
  ["ebreve", "ĕ"],
  ["Ecaron", "Ě"],
  ["ecaron", "ě"],
  ["Edotaccent", "Ė"],
  ["edotaccent", "ė"],
  ["Emacron", "Ē"],
  ["emacron", "ē"],
  ["Eng", "Ŋ"],
  ["eng", "ŋ"],
  ["Eogonek", "Ę"],
  ["eogonek", "ę"],
  ["Gbreve", "Ğ"],
  ["gbreve", "ğ"],
  ["Gcircumflex", "Ĝ"],
  ["gcircumflex", "ĝ"],
  ["Gcommaaccent", "Ģ"],
  ["gcommaaccent", "ģ"],
  ["Gdotaccent", "Ġ"],
  ["gdotaccent", "ġ"],
  ["Hbar", "Ħ"],
  ["hbar", "ħ"],
  ["Hcircumflex", "Ĥ"],
  ["hcircumflex", "ĥ"],
  ["Alpha", "Α"],
  ["Alphatonos", "Ά"],
  ["Beta", "Β"],
  ["Gamma", "Γ"],
  ["Delta", "Δ"],
  ["Epsilon", "Ε"],
  ["Epsilontonos", "Έ"],
  ["Eta", "Η"],
  ["Etatonos", "Ή"],
  ["Chi", "Χ"],
  ["Acute", "´"],
  ["Grave", "`"],
  ["Caron", "ˇ"],
  ["DieresisAcute", "΅"],
  ["DieresisGrave", "῭"],
  ["Hungarumlaut", "˝"],
]);

export function buildPdfSingleByteFontEncoding(input: {
  readonly baseEncodingName?: string;
  readonly differencesText?: string;
}): PdfSingleByteFontEncoding | undefined {
  const unicodeByCharCode = buildBaseUnicodeByCharCode(input.baseEncodingName);
  if (!unicodeByCharCode) {
    return undefined;
  }

  if (input.differencesText) {
    applyDifferences(unicodeByCharCode, input.differencesText);
  }

  return { unicodeByCharCode };
}

export function decodePdfSingleByteHexText(
  hexToken: string,
  encoding: PdfSingleByteFontEncoding,
): PdfSingleByteDecodeResult {
  const normalizedHex = normalizePdfHexToken(hexToken);
  if (normalizedHex.length === 0) {
    return { text: "", complete: true, sourceUnitCount: 0, mappedUnitCount: 0 };
  }

  let text = "";
  let complete = true;
  let sourceUnitCount = 0;
  let mappedUnitCount = 0;

  for (let offset = 0; offset < normalizedHex.length; offset += 2) {
    sourceUnitCount += 1;
    const byteValue = Number.parseInt(normalizedHex.slice(offset, offset + 2), 16);
    const decodedCharacter = encoding.unicodeByCharCode[byteValue];
    if (decodedCharacter === undefined) {
      complete = false;
      continue;
    }
    text += decodedCharacter;
    mappedUnitCount += 1;
  }

  return { text, complete, sourceUnitCount, mappedUnitCount };
}

export function decodePdfSingleByteLiteralText(
  text: string,
  encoding: PdfSingleByteFontEncoding,
): PdfSingleByteDecodeResult {
  if (text.length === 0) {
    return { text: "", complete: true, sourceUnitCount: 0, mappedUnitCount: 0 };
  }

  let decodedText = "";
  let complete = true;
  let sourceUnitCount = 0;
  let mappedUnitCount = 0;

  for (const character of text) {
    const byteValue = character.codePointAt(0);
    sourceUnitCount += 1;
    if (byteValue === undefined || byteValue > 0xff) {
      complete = false;
      continue;
    }

    const decodedCharacter = encoding.unicodeByCharCode[byteValue];
    if (decodedCharacter === undefined) {
      complete = false;
      continue;
    }

    decodedText += decodedCharacter;
    mappedUnitCount += 1;
  }

  return { text: decodedText, complete, sourceUnitCount, mappedUnitCount };
}

function buildBaseUnicodeByCharCode(
  baseEncodingName: string | undefined,
): (string | undefined)[] | undefined {
  if (baseEncodingName === undefined || baseEncodingName === "StandardEncoding") {
    return buildAsciiBaseEncoding();
  }

  if (baseEncodingName === "WinAnsiEncoding") {
    return buildDecoderEncoding("windows-1252");
  }

  if (baseEncodingName === "MacRomanEncoding") {
    return buildDecoderEncoding("macintosh");
  }

  return undefined;
}

function buildAsciiBaseEncoding(): (string | undefined)[] {
  const unicodeByCharCode = Array<string | undefined>(256).fill(undefined);
  for (let codePoint = 32; codePoint <= 126; codePoint += 1) {
    unicodeByCharCode[codePoint] = String.fromCharCode(codePoint);
  }
  return unicodeByCharCode;
}

function buildDecoderEncoding(label: string): (string | undefined)[] {
  const unicodeByCharCode = Array<string | undefined>(256).fill(undefined);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    return buildAsciiBaseEncoding();
  }

  for (let codePoint = 32; codePoint <= 255; codePoint += 1) {
    const decodedCharacter = decoder.decode(Uint8Array.of(codePoint));
    if (looksControlOnly(decodedCharacter)) {
      continue;
    }
    unicodeByCharCode[codePoint] = decodedCharacter;
  }

  return unicodeByCharCode;
}

function applyDifferences(
  unicodeByCharCode: (string | undefined)[],
  differencesText: string,
): void {
  const tokens = tokenizeDifferencesArray(differencesText);
  let nextCodePoint: number | undefined;

  for (const token of tokens) {
    if (token.kind === "code") {
      nextCodePoint = token.value;
      continue;
    }

    if (nextCodePoint === undefined || nextCodePoint < 0 || nextCodePoint > 255) {
      continue;
    }

    unicodeByCharCode[nextCodePoint] = token.name === ".notdef"
      ? undefined
      : mapGlyphNameToUnicode(token.name);
    nextCodePoint += 1;
  }
}

function tokenizeDifferencesArray(
  differencesText: string,
): ReadonlyArray<
  | { readonly kind: "code"; readonly value: number }
  | { readonly kind: "name"; readonly name: string }
> {
  const trimmedText = differencesText.trim();
  const innerText = trimmedText.startsWith("[") && trimmedText.endsWith("]")
    ? trimmedText.slice(1, -1)
    : trimmedText;
  const tokens: Array<
    | { readonly kind: "code"; readonly value: number }
    | { readonly kind: "name"; readonly name: string }
  > = [];

  for (let index = 0; index < innerText.length; ) {
    const currentCharacter = innerText[index];
    if (currentCharacter === undefined) {
      break;
    }

    if (/\s/u.test(currentCharacter)) {
      index += 1;
      continue;
    }

    if (currentCharacter === "/") {
      let endIndex = index + 1;
      while (endIndex < innerText.length && !/[\s<>\[\]()/%]/u.test(innerText[endIndex] ?? "")) {
        endIndex += 1;
      }
      tokens.push({
        kind: "name",
        name: innerText.slice(index + 1, endIndex),
      });
      index = endIndex;
      continue;
    }

    if (/[+\-\d]/u.test(currentCharacter)) {
      let endIndex = index + 1;
      while (endIndex < innerText.length && /[\d]/u.test(innerText[endIndex] ?? "")) {
        endIndex += 1;
      }
      const value = Number.parseInt(innerText.slice(index, endIndex), 10);
      if (Number.isFinite(value)) {
        tokens.push({ kind: "code", value });
      }
      index = endIndex;
      continue;
    }

    index += 1;
  }

  return tokens;
}

function mapGlyphNameToUnicode(glyphName: string): string | undefined {
  if (glyphName.length === 1) {
    return glyphName;
  }

  const normalizedName = normalizeGlyphName(glyphName);
  if (normalizedName.length === 1) {
    return normalizedName;
  }

  const compositeGlyphText = mapCompositeGlyphNameToUnicode(normalizedName);
  if (compositeGlyphText) {
    return compositeGlyphText;
  }

  const digit = DIGIT_NAMES.get(normalizedName);
  if (digit) {
    return digit;
  }

  const glyphText = GLYPH_NAME_TO_UNICODE.get(normalizedName);
  if (glyphText) {
    return glyphText;
  }

  const unicodeSequence = normalizedName.match(/^uni([0-9A-Fa-f]{4})+$/u);
  if (unicodeSequence) {
    return normalizedName
      .slice(3)
      .match(/.{4}/gu)
      ?.map((part) => String.fromCodePoint(Number.parseInt(part, 16)))
      .join("");
  }

  const unicodeCodePoint = normalizedName.match(/^u([0-9A-Fa-f]{4,6})$/u);
  const unicodeValue = unicodeCodePoint?.[1];
  if (unicodeValue) {
    return String.fromCodePoint(Number.parseInt(unicodeValue, 16));
  }

  return undefined;
}

function mapCompositeGlyphNameToUnicode(glyphName: string): string | undefined {
  if (!glyphName.includes("_")) {
    return undefined;
  }

  const parts = glyphName.split("_").filter((part) => part.length > 0);
  if (parts.length < 2) {
    return undefined;
  }

  const decodedParts: string[] = [];
  for (const part of parts) {
    const decodedPart = mapGlyphNameToUnicode(part);
    if (!decodedPart) {
      return undefined;
    }
    decodedParts.push(decodedPart);
  }

  return decodedParts.join("");
}

function normalizeGlyphName(glyphName: string): string {
  if (glyphName.includes(".")) {
    return glyphName.slice(0, glyphName.indexOf("."));
  }

  return glyphName;
}

function normalizePdfHexToken(value: string): string {
  const trimmedValue = value.trim();
  const bracketlessValue = trimmedValue.startsWith("<") && trimmedValue.endsWith(">")
    ? trimmedValue.slice(1, -1)
    : trimmedValue;
  const normalizedHex = bracketlessValue.replaceAll(/\s+/gu, "");
  return normalizedHex.length % 2 === 0 ? normalizedHex : `${normalizedHex}0`;
}

function looksControlOnly(value: string): boolean {
  return /^[\u0000-\u001f\u007f-\u009f]+$/u.test(value);
}
