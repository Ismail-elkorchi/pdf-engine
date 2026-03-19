import type { PdfObjectRef } from "./contracts.ts";

type PdfStandardSecurityMethod = "none" | "rc4" | "aes-128" | "aes-256";
type PdfModernSecurityRevision = 5 | 6;

interface PdfCryptFilter {
  readonly method: PdfStandardSecurityMethod;
}

interface PdfEncryptionDictionary {
  readonly algorithm: number;
  readonly revision: number;
  readonly permissions: number;
  readonly keyLengthBytes: number;
  readonly encryptMetadata: boolean;
  readonly ownerBytes: Uint8Array;
  readonly userBytes: Uint8Array;
  readonly ownerEncryptionBytes?: Uint8Array;
  readonly userEncryptionBytes?: Uint8Array;
  readonly permissionsBytes?: Uint8Array;
  readonly stringMethod: PdfStandardSecurityMethod;
  readonly streamMethod: PdfStandardSecurityMethod;
}

export interface PdfStandardPasswordSecurityHandler {
  decryptObjectValueText(
    objectRef: PdfObjectRef,
    objectValueText: string,
    options?: {
      readonly typeName?: string;
    },
  ): Promise<string>;
  decryptStreamBytes(
    objectRef: PdfObjectRef,
    rawStreamBytes: Uint8Array,
    options?: {
      readonly typeName?: string;
    },
  ): Promise<Uint8Array>;
}

export type PdfStandardPasswordSecurityPreparation =
  | {
    readonly status: "decrypted";
    readonly handler: PdfStandardPasswordSecurityHandler;
  }
  | {
    readonly status: "invalid-password";
    readonly detail: string;
  }
  | {
    readonly status: "unsupported";
    readonly detail: string;
  };

export interface PdfStandardPasswordSecurityRequest {
  readonly documentId: Uint8Array;
  readonly encryptDictionaryEntries: ReadonlyMap<string, string>;
  readonly encryptObjectRef: PdfObjectRef;
  readonly password: string;
}

const STANDARD_PASSWORD_PADDING = Uint8Array.from([
  0x28,
  0xbf,
  0x4e,
  0x5e,
  0x4e,
  0x75,
  0x8a,
  0x41,
  0x64,
  0x00,
  0x4e,
  0x56,
  0xff,
  0xfa,
  0x01,
  0x08,
  0x2e,
  0x2e,
  0x00,
  0xb6,
  0xd0,
  0x68,
  0x3e,
  0x80,
  0x2f,
  0x0c,
  0xa9,
  0xfe,
  0x64,
  0x53,
  0x69,
  0x7a,
]);

const AES_OBJECT_KEY_SALT = Uint8Array.from([0x73, 0x41, 0x6c, 0x54]);
const ZERO_AES_INITIALIZATION_VECTOR = new Uint8Array(16);

export async function preparePdfStandardPasswordSecurity(
  request: PdfStandardPasswordSecurityRequest,
): Promise<PdfStandardPasswordSecurityPreparation> {
  const encryptionDictionary = parseEncryptionDictionary(request.encryptDictionaryEntries);
  if (!encryptionDictionary) {
    return {
      status: "unsupported",
      detail: "The encryption dictionary is missing required standard-handler fields.",
    };
  }

  if (
    encryptionDictionary.algorithm !== 1 &&
    encryptionDictionary.algorithm !== 2 &&
    encryptionDictionary.algorithm !== 4 &&
    encryptionDictionary.algorithm !== 5
  ) {
    return {
      status: "unsupported",
      detail: `Unsupported standard security algorithm V=${String(encryptionDictionary.algorithm)}.`,
    };
  }

  if (
    encryptionDictionary.revision !== 2 &&
    encryptionDictionary.revision !== 3 &&
    encryptionDictionary.revision !== 4 &&
    encryptionDictionary.revision !== 5 &&
    encryptionDictionary.revision !== 6
  ) {
    return {
      status: "unsupported",
      detail: `Unsupported standard security revision R=${String(encryptionDictionary.revision)}.`,
    };
  }

  const encryptionKey = await deriveStandardEncryptionKey({
    encryptionDictionary,
    documentId: request.documentId,
    password: request.password,
  });
  if (!encryptionKey) {
    return {
      status: "invalid-password",
      detail: "The supplied password did not unlock the standard security handler.",
    };
  }

  return {
    status: "decrypted",
    handler: new StandardPasswordSecurityHandler(
      encryptionDictionary,
      request.encryptObjectRef,
      encryptionKey,
    ),
  };
}

class StandardPasswordSecurityHandler implements PdfStandardPasswordSecurityHandler {
  readonly #encryptionDictionary: PdfEncryptionDictionary;
  readonly #encryptObjectRef: PdfObjectRef;
  readonly #encryptionKey: Uint8Array;

  constructor(
    encryptionDictionary: PdfEncryptionDictionary,
    encryptObjectRef: PdfObjectRef,
    encryptionKey: Uint8Array,
  ) {
    this.#encryptionDictionary = encryptionDictionary;
    this.#encryptObjectRef = encryptObjectRef;
    this.#encryptionKey = encryptionKey;
  }

  decryptObjectValueText(
    objectRef: PdfObjectRef,
    objectValueText: string,
    options?: {
      readonly typeName?: string;
    },
  ): Promise<string> {
    if (this.#shouldBypassObject(objectRef, options?.typeName)) {
      return Promise.resolve(objectValueText);
    }

    if (this.#encryptionDictionary.stringMethod === "none") {
      return Promise.resolve(objectValueText);
    }

    let index = 0;
    let decryptedText = "";

    while (index < objectValueText.length) {
      const current = objectValueText[index] ?? "";

      if (current === "(") {
        const literalToken = readPdfLiteralToken(objectValueText, index);
        if (!literalToken) {
          decryptedText += current;
          index += 1;
          continue;
        }

        const decryptedBytes = this.#decryptBytes(
          objectRef,
          decodePdfLiteralTokenBytes(literalToken.token),
          this.#encryptionDictionary.stringMethod,
        );
        decryptedText += encodePdfHexStringToken(decryptedBytes);
        index = literalToken.nextIndex;
        continue;
      }

      if (
        current === "<" &&
        objectValueText[index - 1] !== "<" &&
        objectValueText[index + 1] !== "<"
      ) {
        const hexToken = readPdfHexStringToken(objectValueText, index);
        if (!hexToken) {
          decryptedText += current;
          index += 1;
          continue;
        }

        const decryptedBytes = this.#decryptBytes(
          objectRef,
          decodePdfHexStringTokenBytes(hexToken.token),
          this.#encryptionDictionary.stringMethod,
        );
        decryptedText += encodePdfHexStringToken(decryptedBytes);
        index = hexToken.nextIndex;
        continue;
      }

      decryptedText += current;
      index += 1;
    }

    return Promise.resolve(decryptedText);
  }

  decryptStreamBytes(
    objectRef: PdfObjectRef,
    rawStreamBytes: Uint8Array,
    options?: {
      readonly typeName?: string;
    },
  ): Promise<Uint8Array> {
    if (this.#shouldBypassObject(objectRef, options?.typeName)) {
      return Promise.resolve(Uint8Array.from(rawStreamBytes));
    }

    if (this.#encryptionDictionary.streamMethod === "none") {
      return Promise.resolve(Uint8Array.from(rawStreamBytes));
    }

    return Promise.resolve(
      this.#decryptBytes(objectRef, rawStreamBytes, this.#encryptionDictionary.streamMethod),
    );
  }

  #shouldBypassObject(
    objectRef: PdfObjectRef,
    typeName: string | undefined,
  ): boolean {
    if (
      objectRef.objectNumber === this.#encryptObjectRef.objectNumber &&
      objectRef.generationNumber === this.#encryptObjectRef.generationNumber
    ) {
      return true;
    }

    if (!this.#encryptionDictionary.encryptMetadata && typeName === "Metadata") {
      return true;
    }

    return typeName === "XRef";
  }

  #decryptBytes(
    objectRef: PdfObjectRef,
    encryptedBytes: Uint8Array,
    method: PdfStandardSecurityMethod,
  ): Uint8Array {
    switch (method) {
      case "none":
        return Uint8Array.from(encryptedBytes);
      case "rc4":
        return new PdfArcFourCipher(this.#buildObjectKey(objectRef, false)).crypt(encryptedBytes);
      case "aes-128":
        return decryptAesBytes(this.#buildObjectKey(objectRef, true), encryptedBytes);
      case "aes-256":
        return decryptAesBytes(this.#encryptionKey, encryptedBytes);
    }
  }

  #buildObjectKey(objectRef: PdfObjectRef, includeAesSalt: boolean): Uint8Array {
    const objectKeyBytes = new Uint8Array(this.#encryptionKey.length + 9);
    objectKeyBytes.set(this.#encryptionKey, 0);
    let offset = this.#encryptionKey.length;
    objectKeyBytes[offset] = objectRef.objectNumber & 0xff;
    offset += 1;
    objectKeyBytes[offset] = (objectRef.objectNumber >> 8) & 0xff;
    offset += 1;
    objectKeyBytes[offset] = (objectRef.objectNumber >> 16) & 0xff;
    offset += 1;
    objectKeyBytes[offset] = objectRef.generationNumber & 0xff;
    offset += 1;
    objectKeyBytes[offset] = (objectRef.generationNumber >> 8) & 0xff;
    offset += 1;
    if (includeAesSalt) {
      objectKeyBytes.set(AES_OBJECT_KEY_SALT, offset);
      offset += AES_OBJECT_KEY_SALT.length;
    }

    const hash = calculateMd5(objectKeyBytes.subarray(0, offset));
    return hash.subarray(0, Math.min(this.#encryptionKey.length + 5, 16));
  }
}

async function deriveStandardEncryptionKey(
  input: {
    readonly encryptionDictionary: PdfEncryptionDictionary;
    readonly documentId: Uint8Array;
    readonly password: string;
  },
): Promise<Uint8Array | undefined> {
  if (input.encryptionDictionary.revision >= 5) {
    return deriveModernEncryptionKey({
      encryptionDictionary: input.encryptionDictionary,
      password: input.password,
    });
  }

  const passwordBytes = encodePdfPassword(input.password);
  const userKeyCandidate = prepareLegacyEncryptionKey({
    passwordBytes,
    ownerBytes: input.encryptionDictionary.ownerBytes,
    userBytes: input.encryptionDictionary.userBytes,
    permissions: input.encryptionDictionary.permissions,
    revision: input.encryptionDictionary.revision,
    keyLengthBytes: input.encryptionDictionary.keyLengthBytes,
    documentId: input.documentId,
    encryptMetadata: input.encryptionDictionary.encryptMetadata,
  });
  if (userKeyCandidate) {
    return normalizeAlgorithmFourKey(input.encryptionDictionary.algorithm, userKeyCandidate);
  }

  const ownerPasswordBytes = decodeOwnerPassword({
    ownerPasswordBytes: passwordBytes,
    ownerBytes: input.encryptionDictionary.ownerBytes,
    revision: input.encryptionDictionary.revision,
    keyLengthBytes: input.encryptionDictionary.keyLengthBytes,
  });
  const ownerKeyCandidate = prepareLegacyEncryptionKey({
    passwordBytes: ownerPasswordBytes,
    ownerBytes: input.encryptionDictionary.ownerBytes,
    userBytes: input.encryptionDictionary.userBytes,
    permissions: input.encryptionDictionary.permissions,
    revision: input.encryptionDictionary.revision,
    keyLengthBytes: input.encryptionDictionary.keyLengthBytes,
    documentId: input.documentId,
    encryptMetadata: input.encryptionDictionary.encryptMetadata,
  });
  return ownerKeyCandidate
    ? normalizeAlgorithmFourKey(input.encryptionDictionary.algorithm, ownerKeyCandidate)
    : undefined;
}

async function deriveModernEncryptionKey(
  input: {
    readonly encryptionDictionary: PdfEncryptionDictionary;
    readonly password: string;
  },
): Promise<Uint8Array | undefined> {
  const ownerEncryptionBytes = input.encryptionDictionary.ownerEncryptionBytes;
  const userEncryptionBytes = input.encryptionDictionary.userEncryptionBytes;
  const permissionsBytes = input.encryptionDictionary.permissionsBytes;
  if (
    ownerEncryptionBytes === undefined ||
    userEncryptionBytes === undefined ||
    permissionsBytes === undefined
  ) {
    return undefined;
  }

  const passwordBytes = encodeModernPdfPassword(input.password);
  const revision = input.encryptionDictionary.revision as PdfModernSecurityRevision;
  const ownerBytes = input.encryptionDictionary.ownerBytes.subarray(0, 48);
  const userBytes = input.encryptionDictionary.userBytes.subarray(0, 48);

  const ownerValidationHash = await computeModernStandardPasswordHash({
    revision,
    passwordBytes,
    saltBytes: ownerBytes.subarray(32, 40),
    userBytes,
  });
  if (areBytesEqual(ownerValidationHash, ownerBytes.subarray(0, 32))) {
    const ownerIntermediateKey = await computeModernStandardPasswordHash({
      revision,
      passwordBytes,
      saltBytes: ownerBytes.subarray(40, 48),
      userBytes,
    });
    const ownerEncryptionKey = decryptAesCbcNoPadding(
      ownerIntermediateKey,
      ZERO_AES_INITIALIZATION_VECTOR,
      ownerEncryptionBytes,
    );
    if (verifyModernPermissions(ownerEncryptionKey, input.encryptionDictionary)) {
      return ownerEncryptionKey;
    }
  }

  const userValidationHash = await computeModernStandardPasswordHash({
    revision,
    passwordBytes,
    saltBytes: userBytes.subarray(32, 40),
    userBytes: new Uint8Array(),
  });
  if (!areBytesEqual(userValidationHash, userBytes.subarray(0, 32))) {
    return undefined;
  }

  const userIntermediateKey = await computeModernStandardPasswordHash({
    revision,
    passwordBytes,
    saltBytes: userBytes.subarray(40, 48),
    userBytes: new Uint8Array(),
  });
  const userEncryptionKey = decryptAesCbcNoPadding(
    userIntermediateKey,
    ZERO_AES_INITIALIZATION_VECTOR,
    userEncryptionBytes,
  );
  return verifyModernPermissions(userEncryptionKey, input.encryptionDictionary)
    ? userEncryptionKey
    : undefined;
}

async function computeModernStandardPasswordHash(
  input: {
    readonly revision: PdfModernSecurityRevision;
    readonly passwordBytes: Uint8Array;
    readonly saltBytes: Uint8Array;
    readonly userBytes: Uint8Array;
  },
): Promise<Uint8Array> {
  let keyBytes = await calculateDigestBytes(
    "SHA-256",
    joinByteArrays([input.passwordBytes, input.saltBytes, input.userBytes]),
  );
  if (input.revision < 6) {
    return keyBytes;
  }

  let roundNumber = 0;
  while (true) {
    roundNumber += 1;
    const repeatedInput = joinRepeatedByteArrays(
      [input.passwordBytes, keyBytes, input.userBytes],
      64,
    );
    const encryptedBytes = encryptAesCbcNoPadding(
      keyBytes.subarray(0, 16),
      keyBytes.subarray(16, 32),
      repeatedInput,
    );
    const hashName = selectModernHashName(encryptedBytes);
    keyBytes = await calculateDigestBytes(hashName, encryptedBytes);
    if (roundNumber >= 64) {
      const lastByte = encryptedBytes[encryptedBytes.byteLength - 1] ?? 0;
      if (lastByte <= roundNumber - 32) {
        return keyBytes.subarray(0, 32);
      }
    }
  }
}

function normalizeAlgorithmFourKey(
  algorithm: number,
  encryptionKey: Uint8Array,
): Uint8Array {
  if (algorithm === 4 && encryptionKey.byteLength < 16) {
    const normalizedKey = new Uint8Array(16);
    normalizedKey.set(encryptionKey);
    return normalizedKey;
  }

  return encryptionKey;
}

function prepareLegacyEncryptionKey(
  input: {
    readonly passwordBytes: Uint8Array;
    readonly ownerBytes: Uint8Array;
    readonly userBytes: Uint8Array;
    readonly permissions: number;
    readonly revision: number;
    readonly keyLengthBytes: number;
    readonly documentId: Uint8Array;
    readonly encryptMetadata: boolean;
  },
): Uint8Array | undefined {
  const paddedPassword = padPdfPassword(input.passwordBytes);
  const hashInput = new Uint8Array(
    paddedPassword.byteLength +
      input.ownerBytes.byteLength +
      4 +
      input.documentId.byteLength +
      (input.revision >= 4 && !input.encryptMetadata ? 4 : 0),
  );
  let offset = 0;
  hashInput.set(paddedPassword, offset);
  offset += paddedPassword.byteLength;
  hashInput.set(input.ownerBytes, offset);
  offset += input.ownerBytes.byteLength;
  writeInt32LittleEndian(hashInput, offset, input.permissions);
  offset += 4;
  hashInput.set(input.documentId, offset);
  offset += input.documentId.byteLength;
  if (input.revision >= 4 && !input.encryptMetadata) {
    hashInput.fill(0xff, offset, offset + 4);
    offset += 4;
  }

  let hash = calculateMd5(hashInput.subarray(0, offset));
  if (input.revision >= 3) {
    for (let iteration = 0; iteration < 50; iteration += 1) {
      hash = calculateMd5(hash.subarray(0, input.keyLengthBytes));
    }
  }

  const encryptionKey = hash.subarray(0, input.keyLengthBytes);
  const expectedUserBytes = buildExpectedUserValidationBytes({
    encryptionKey,
    revision: input.revision,
    documentId: input.documentId,
  });

  if (input.revision >= 3) {
    const expectedPrefix = expectedUserBytes.subarray(0, 16);
    const actualPrefix = input.userBytes.subarray(0, 16);
    return areBytesEqual(expectedPrefix, actualPrefix) ? encryptionKey : undefined;
  }

  return areBytesEqual(expectedUserBytes, input.userBytes) ? encryptionKey : undefined;
}

function decodeOwnerPassword(
  input: {
    readonly ownerPasswordBytes: Uint8Array;
    readonly ownerBytes: Uint8Array;
    readonly revision: number;
    readonly keyLengthBytes: number;
  },
): Uint8Array {
  const paddedPassword = padPdfPassword(input.ownerPasswordBytes);
  let hash = calculateMd5(paddedPassword);
  if (input.revision >= 3) {
    for (let iteration = 0; iteration < 50; iteration += 1) {
      hash = calculateMd5(hash);
    }
  }

  let decodedBytes = Uint8Array.from(input.ownerBytes);
  if (input.revision >= 3) {
    for (let iteration = 19; iteration >= 0; iteration -= 1) {
      const derivedKey = xorBytes(hash.subarray(0, input.keyLengthBytes), iteration);
      decodedBytes = Uint8Array.from(new PdfArcFourCipher(derivedKey).crypt(decodedBytes));
    }
    return decodedBytes;
  }

  return Uint8Array.from(new PdfArcFourCipher(hash.subarray(0, input.keyLengthBytes)).crypt(decodedBytes));
}

function buildExpectedUserValidationBytes(
  input: {
    readonly encryptionKey: Uint8Array;
    readonly revision: number;
    readonly documentId: Uint8Array;
  },
): Uint8Array {
  if (input.revision >= 3) {
    const validationSeed = new Uint8Array(
      STANDARD_PASSWORD_PADDING.byteLength + input.documentId.byteLength,
    );
    validationSeed.set(STANDARD_PASSWORD_PADDING, 0);
    validationSeed.set(input.documentId, STANDARD_PASSWORD_PADDING.byteLength);
    let validationBytes = new PdfArcFourCipher(input.encryptionKey).crypt(calculateMd5(validationSeed));
    for (let iteration = 1; iteration <= 19; iteration += 1) {
      validationBytes = new PdfArcFourCipher(xorBytes(input.encryptionKey, iteration)).crypt(validationBytes);
    }

    const output = new Uint8Array(32);
    output.set(validationBytes, 0);
    return output;
  }

  return new PdfArcFourCipher(input.encryptionKey).crypt(STANDARD_PASSWORD_PADDING);
}

function parseEncryptionDictionary(
  dictionaryEntries: ReadonlyMap<string, string>,
): PdfEncryptionDictionary | undefined {
  const filterName = readNameValue(dictionaryEntries.get("Filter"));
  if (filterName !== "Standard") {
    return undefined;
  }

  const algorithm = readSignedIntegerValue(dictionaryEntries.get("V"));
  const revision = readSignedIntegerValue(dictionaryEntries.get("R"));
  const permissions = readSignedIntegerValue(dictionaryEntries.get("P"));
  const ownerBytes = decodePdfStringTokenBytes(dictionaryEntries.get("O"));
  const userBytes = decodePdfStringTokenBytes(dictionaryEntries.get("U"));
  if (
    algorithm === undefined ||
    revision === undefined ||
    permissions === undefined ||
    ownerBytes === undefined ||
    userBytes === undefined
  ) {
    return undefined;
  }

  const cryptFilters = parseCryptFilters(dictionaryEntries.get("CF"));
  const defaultKeyLengthBits = cryptFilters.get("StdCF")?.keyLengthBits ??
    readSignedIntegerValue(dictionaryEntries.get("Length")) ??
    40;
  const keyLengthBits = defaultKeyLengthBits < 40 ? defaultKeyLengthBits * 8 : defaultKeyLengthBits;
  const defaultCryptFilterName = readDefaultCryptFilterName(algorithm, cryptFilters);
  const stringMethod = resolveCryptFilterMethod(
    algorithm,
    cryptFilters,
    readNameValue(dictionaryEntries.get("StrF")) ?? defaultCryptFilterName,
  );
  const streamMethod = resolveCryptFilterMethod(
    algorithm,
    cryptFilters,
    readNameValue(dictionaryEntries.get("StmF")) ?? defaultCryptFilterName,
  );
  const ownerEncryptionBytes = decodePdfStringTokenBytes(dictionaryEntries.get("OE"));
  const userEncryptionBytes = decodePdfStringTokenBytes(dictionaryEntries.get("UE"));
  const permissionsBytes = decodePdfStringTokenBytes(dictionaryEntries.get("Perms"));

  if (
    revision >= 5 &&
    (
      ownerBytes.byteLength < 48 ||
      userBytes.byteLength < 48 ||
      ownerEncryptionBytes === undefined ||
      ownerEncryptionBytes.byteLength !== 32 ||
      userEncryptionBytes === undefined ||
      userEncryptionBytes.byteLength !== 32 ||
      permissionsBytes === undefined ||
      permissionsBytes.byteLength !== 16
    )
  ) {
    return undefined;
  }

  return {
    algorithm,
    revision,
    permissions,
    keyLengthBytes: Math.max(5, Math.floor(keyLengthBits / 8)),
    encryptMetadata: readBooleanValue(dictionaryEntries.get("EncryptMetadata")) ?? true,
    ownerBytes,
    userBytes,
    ...(ownerEncryptionBytes !== undefined ? { ownerEncryptionBytes } : {}),
    ...(userEncryptionBytes !== undefined ? { userEncryptionBytes } : {}),
    ...(permissionsBytes !== undefined ? { permissionsBytes } : {}),
    stringMethod,
    streamMethod,
  };
}

function readDefaultCryptFilterName(
  algorithm: number,
  cryptFilters: ReadonlyMap<string, PdfCryptFilter>,
): string {
  if (algorithm >= 4 && cryptFilters.has("StdCF")) {
    return "StdCF";
  }

  return "Identity";
}

function parseCryptFilters(
  value: string | undefined,
): ReadonlyMap<string, PdfCryptFilter & { readonly keyLengthBits?: number }> {
  const filters = new Map<string, PdfCryptFilter & { readonly keyLengthBits?: number }>();
  if (!value) {
    return filters;
  }

  const topLevelEntries = parseDictionaryEntries(value);
  for (const [filterName, filterValue] of topLevelEntries) {
    const filterEntries = parseDictionaryEntries(filterValue);
    if (filterEntries.size === 0) {
      continue;
    }

    const keyLengthBits = readCryptFilterKeyLengthBits(filterEntries);
    filters.set(
      filterName,
      keyLengthBits !== undefined
        ? {
          method: resolveCryptFilterMethodByName(readNameValue(filterEntries.get("CFM"))),
          keyLengthBits,
        }
        : {
          method: resolveCryptFilterMethodByName(readNameValue(filterEntries.get("CFM"))),
        },
    );
  }

  return filters;
}

function readCryptFilterKeyLengthBits(
  dictionaryEntries: {
    get(key: string): string | undefined;
  } | undefined,
): number | undefined {
  if (!dictionaryEntries) {
    return undefined;
  }

  const directLength = readSignedIntegerValue(dictionaryEntries.get("Length"));
  if (directLength === undefined) {
    return undefined;
  }

  return directLength < 40 ? directLength * 8 : directLength;
}

function resolveCryptFilterMethod(
  algorithm: number,
  cryptFilters: ReadonlyMap<string, PdfCryptFilter>,
  filterName: string,
): PdfStandardSecurityMethod {
  if (algorithm < 4) {
    return "rc4";
  }

  if (filterName === "Identity") {
    return "none";
  }

  return cryptFilters.get(filterName)?.method ?? "none";
}

function resolveCryptFilterMethodByName(
  filterMethodName: string | undefined,
): PdfStandardSecurityMethod {
  switch (filterMethodName) {
    case undefined:
    case "None":
      return "none";
    case "V2":
      return "rc4";
    case "AESV2":
      return "aes-128";
    case "AESV3":
      return "aes-256";
    default:
      return "none";
  }
}

function decodePdfStringTokenBytes(
  token: string | undefined,
): Uint8Array | undefined {
  if (!token) {
    return undefined;
  }

  const trimmed = token.trim();
  if (trimmed.startsWith("(")) {
    return decodePdfLiteralTokenBytes(trimmed);
  }
  if (trimmed.startsWith("<") && !trimmed.startsWith("<<")) {
    return decodePdfHexStringTokenBytes(trimmed);
  }
  return undefined;
}

function decodePdfLiteralTokenBytes(token: string): Uint8Array {
  const source = token.startsWith("(") && token.endsWith(")") ? token.slice(1, -1) : token;
  const decodedBytes: number[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? "";
    if (current !== "\\") {
      decodedBytes.push(source.charCodeAt(index) & 0xff);
      continue;
    }

    const next = source[index + 1];
    if (next === undefined) {
      break;
    }

    if (/[0-7]/.test(next)) {
      let octal = next;
      if (/[0-7]/.test(source[index + 2] ?? "")) {
        octal += source[index + 2];
      }
      if (/[0-7]/.test(source[index + 3] ?? "")) {
        octal += source[index + 3];
      }
      decodedBytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    switch (next) {
      case "n":
        decodedBytes.push(0x0a);
        break;
      case "r":
        decodedBytes.push(0x0d);
        break;
      case "t":
        decodedBytes.push(0x09);
        break;
      case "b":
        decodedBytes.push(0x08);
        break;
      case "f":
        decodedBytes.push(0x0c);
        break;
      case "\r":
        if (source[index + 2] === "\n") {
          index += 1;
        }
        break;
      case "\n":
        break;
      default:
        decodedBytes.push(next.charCodeAt(0) & 0xff);
        break;
    }
    index += 1;
  }

  return Uint8Array.from(decodedBytes);
}

function decodePdfHexStringTokenBytes(token: string): Uint8Array {
  const hexSource = token.slice(1, -1).replace(/\s+/g, "");
  const normalizedHexSource = hexSource.length % 2 === 0 ? hexSource : `${hexSource}0`;
  const decodedBytes = new Uint8Array(normalizedHexSource.length / 2);

  for (let index = 0; index < normalizedHexSource.length; index += 2) {
    decodedBytes[index / 2] = Number.parseInt(normalizedHexSource.slice(index, index + 2), 16);
  }

  return decodedBytes;
}

function encodePdfHexStringToken(bytes: Uint8Array): string {
  return `<${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}>`;
}

function encodePdfPassword(password: string): Uint8Array {
  return Uint8Array.from(password, (character) => character.charCodeAt(0) & 0xff);
}

function encodeModernPdfPassword(password: string): Uint8Array {
  return new TextEncoder().encode(password).subarray(0, 127);
}

function padPdfPassword(passwordBytes: Uint8Array): Uint8Array {
  const paddedBytes = new Uint8Array(32);
  const copyLength = Math.min(32, passwordBytes.byteLength);
  paddedBytes.set(passwordBytes.subarray(0, copyLength), 0);
  paddedBytes.set(STANDARD_PASSWORD_PADDING.subarray(0, 32 - copyLength), copyLength);
  return paddedBytes;
}

function areBytesEqual(leftBytes: Uint8Array, rightBytes: Uint8Array): boolean {
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return false;
    }
  }

  return true;
}

function xorBytes(bytes: Uint8Array, xorValue: number): Uint8Array {
  return Uint8Array.from(bytes, (value) => value ^ xorValue);
}

function writeInt32LittleEndian(
  targetBytes: Uint8Array,
  offset: number,
  value: number,
): void {
  targetBytes[offset] = value & 0xff;
  targetBytes[offset + 1] = (value >> 8) & 0xff;
  targetBytes[offset + 2] = (value >> 16) & 0xff;
  targetBytes[offset + 3] = (value >> 24) & 0xff;
}

function decryptAes128Bytes(
  objectKey: Uint8Array,
  encryptedBytes: Uint8Array,
): Uint8Array {
  if (encryptedBytes.byteLength < 16) {
    return new Uint8Array();
  }

  const initializationVector = encryptedBytes.subarray(0, 16);
  const cipherBytes = encryptedBytes.subarray(16);
  const decryptedBytes = decryptAesCbcNoPadding(objectKey, initializationVector, cipherBytes);
  return removePkcs7Padding(decryptedBytes);
}

function decryptAesBytes(
  objectKey: Uint8Array,
  encryptedBytes: Uint8Array,
): Uint8Array {
  return decryptAes128Bytes(objectKey, encryptedBytes);
}

function removePkcs7Padding(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) {
    return bytes;
  }

  const paddingLength = bytes[bytes.byteLength - 1] ?? 0;
  if (paddingLength <= 0 || paddingLength > 16 || paddingLength > bytes.byteLength) {
    return bytes;
  }

  for (let index = bytes.byteLength - paddingLength; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== paddingLength) {
      return bytes;
    }
  }

  return bytes.subarray(0, bytes.byteLength - paddingLength);
}

class PdfArcFourCipher {
  readonly #state: Uint8Array;
  #indexA = 0;
  #indexB = 0;

  constructor(keyBytes: Uint8Array) {
    const state = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) {
      state[index] = index;
    }

    let stateIndex = 0;
    for (let index = 0; index < 256; index += 1) {
      stateIndex = (stateIndex + state[index]! + keyBytes[index % keyBytes.byteLength]!) & 0xff;
      const temporaryValue = state[index];
      state[index] = state[stateIndex]!;
      state[stateIndex] = temporaryValue!;
    }

    this.#state = state;
  }

  crypt(inputBytes: Uint8Array): Uint8Array {
    const outputBytes = new Uint8Array(inputBytes.byteLength);

    for (let index = 0; index < inputBytes.byteLength; index += 1) {
      this.#indexA = (this.#indexA + 1) & 0xff;
      const temporaryValue = this.#state[this.#indexA]!;
      this.#indexB = (this.#indexB + temporaryValue) & 0xff;
      const swapValue = this.#state[this.#indexB]!;
      this.#state[this.#indexA] = swapValue;
      this.#state[this.#indexB] = temporaryValue;
      outputBytes[index] = inputBytes[index]! ^ this.#state[(temporaryValue + swapValue) & 0xff]!;
    }

    return outputBytes;
  }
}

function encryptAesCbcNoPadding(
  keyBytes: Uint8Array,
  initializationVector: Uint8Array,
  plainBytes: Uint8Array,
): Uint8Array {
  return new PdfAesCipher(keyBytes).encryptCbcNoPadding(initializationVector, plainBytes);
}

function decryptAesCbcNoPadding(
  keyBytes: Uint8Array,
  initializationVector: Uint8Array,
  cipherBytes: Uint8Array,
): Uint8Array {
  return new PdfAesCipher(keyBytes).decryptCbcNoPadding(initializationVector, cipherBytes);
}

function decryptAesEcbNoPadding(
  keyBytes: Uint8Array,
  cipherBytes: Uint8Array,
): Uint8Array {
  return new PdfAesCipher(keyBytes).decryptEcbNoPadding(cipherBytes);
}

function verifyModernPermissions(
  encryptionKey: Uint8Array,
  encryptionDictionary: PdfEncryptionDictionary,
): boolean {
  const permissionsBytes = encryptionDictionary.permissionsBytes;
  if (permissionsBytes === undefined) {
    return false;
  }

  const decryptedPermissions = decryptAesEcbNoPadding(encryptionKey, permissionsBytes);
  if (decryptedPermissions.byteLength !== 16) {
    return false;
  }

  const normalizedPermissions = normalizeUnsignedInt32(encryptionDictionary.permissions);
  const permissionValue =
    (decryptedPermissions[0] ?? 0) |
    ((decryptedPermissions[1] ?? 0) << 8) |
    ((decryptedPermissions[2] ?? 0) << 16) |
    ((decryptedPermissions[3] ?? 0) << 24);
  if ((permissionValue >>> 0) !== normalizedPermissions) {
    return false;
  }

  const expectedMetadataByte = encryptionDictionary.encryptMetadata ? 0x54 : 0x46;
  return (
    decryptedPermissions[8] === expectedMetadataByte &&
    decryptedPermissions[9] === 0x61 &&
    decryptedPermissions[10] === 0x64 &&
    decryptedPermissions[11] === 0x62
  );
}

function normalizeUnsignedInt32(value: number): number {
  return value >>> 0;
}

async function calculateDigestBytes(
  algorithmName: "SHA-256" | "SHA-384" | "SHA-512",
  inputBytes: Uint8Array,
): Promise<Uint8Array> {
  const cryptoApi = globalThis.crypto?.subtle;
  if (!cryptoApi) {
    throw new Error("SubtleCrypto is required for modern standard security password hashing.");
  }

  const digestBuffer = await cryptoApi.digest(algorithmName, toPlainUint8Array(inputBytes));
  return new Uint8Array(digestBuffer);
}

function toPlainUint8Array(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const plainBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  plainBytes.set(bytes, 0);
  return plainBytes;
}

function joinByteArrays(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joinedBytes = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    joinedBytes.set(part, offset);
    offset += part.byteLength;
  }

  return joinedBytes;
}

function joinRepeatedByteArrays(
  parts: readonly Uint8Array[],
  repetitionCount: number,
): Uint8Array {
  const cycleBytes = joinByteArrays(parts);
  const repeatedBytes = new Uint8Array(cycleBytes.byteLength * repetitionCount);

  for (let index = 0; index < repetitionCount; index += 1) {
    repeatedBytes.set(cycleBytes, index * cycleBytes.byteLength);
  }

  return repeatedBytes;
}

function selectModernHashName(
  encryptedBytes: Uint8Array,
): "SHA-256" | "SHA-384" | "SHA-512" {
  let hashSelector = 0;
  for (let index = 0; index < 16 && index < encryptedBytes.byteLength; index += 1) {
    hashSelector += encryptedBytes[index] ?? 0;
  }

  switch (hashSelector % 3) {
    case 1:
      return "SHA-384";
    case 2:
      return "SHA-512";
    default:
      return "SHA-256";
  }
}

class PdfAesCipher {
  readonly #roundCount: number;
  readonly #roundKeyBytes: Uint8Array;

  constructor(keyBytes: Uint8Array) {
    if (keyBytes.byteLength !== 16 && keyBytes.byteLength !== 32) {
      throw new Error(`Unsupported AES key length: ${String(keyBytes.byteLength)}.`);
    }

    this.#roundCount = keyBytes.byteLength === 16 ? 10 : 14;
    this.#roundKeyBytes = expandAesRoundKeys(keyBytes, this.#roundCount);
  }

  encryptCbcNoPadding(
    initializationVector: Uint8Array,
    plainBytes: Uint8Array,
  ): Uint8Array {
    if (plainBytes.byteLength % 16 !== 0) {
      throw new Error("AES-CBC encryption without padding requires 16-byte-aligned input.");
    }

    let previousBlock = Uint8Array.from(initializationVector);
    const encryptedBytes = new Uint8Array(plainBytes.byteLength);
    for (let offset = 0; offset < plainBytes.byteLength; offset += 16) {
      const blockBytes = Uint8Array.from(plainBytes.subarray(offset, offset + 16));
      xorInto(blockBytes, previousBlock);
      const encryptedBlock = this.encryptBlock(blockBytes);
      encryptedBytes.set(encryptedBlock, offset);
      previousBlock = Uint8Array.from(encryptedBlock);
    }

    return encryptedBytes;
  }

  decryptCbcNoPadding(
    initializationVector: Uint8Array,
    cipherBytes: Uint8Array,
  ): Uint8Array {
    if (cipherBytes.byteLength % 16 !== 0) {
      throw new Error("AES-CBC decryption without padding requires 16-byte-aligned input.");
    }

    let previousBlock = Uint8Array.from(initializationVector);
    const decryptedBytes = new Uint8Array(cipherBytes.byteLength);
    for (let offset = 0; offset < cipherBytes.byteLength; offset += 16) {
      const cipherBlock = Uint8Array.from(cipherBytes.subarray(offset, offset + 16));
      const plainBlock = this.decryptBlock(cipherBlock);
      xorInto(plainBlock, previousBlock);
      decryptedBytes.set(plainBlock, offset);
      previousBlock = cipherBlock;
    }

    return decryptedBytes;
  }

  decryptEcbNoPadding(cipherBytes: Uint8Array): Uint8Array {
    if (cipherBytes.byteLength % 16 !== 0) {
      throw new Error("AES-ECB decryption without padding requires 16-byte-aligned input.");
    }

    const decryptedBytes = new Uint8Array(cipherBytes.byteLength);
    for (let offset = 0; offset < cipherBytes.byteLength; offset += 16) {
      decryptedBytes.set(this.decryptBlock(cipherBytes.subarray(offset, offset + 16)), offset);
    }

    return decryptedBytes;
  }

  private encryptBlock(inputBytes: Uint8Array): Uint8Array {
    const state = Uint8Array.from(inputBytes);
    addRoundKey(state, this.#roundKeyBytes, 0);
    for (let round = 1; round < this.#roundCount; round += 1) {
      applyAesSBox(state, AES_S_BOX);
      shiftAesRows(state);
      mixAesColumns(state);
      addRoundKey(state, this.#roundKeyBytes, round);
    }
    applyAesSBox(state, AES_S_BOX);
    shiftAesRows(state);
    addRoundKey(state, this.#roundKeyBytes, this.#roundCount);
    return state;
  }

  private decryptBlock(inputBytes: Uint8Array): Uint8Array {
    const state = Uint8Array.from(inputBytes);
    addRoundKey(state, this.#roundKeyBytes, this.#roundCount);
    for (let round = this.#roundCount - 1; round >= 1; round -= 1) {
      inverseShiftAesRows(state);
      applyAesSBox(state, AES_INVERSE_S_BOX);
      addRoundKey(state, this.#roundKeyBytes, round);
      inverseMixAesColumns(state);
    }
    inverseShiftAesRows(state);
    applyAesSBox(state, AES_INVERSE_S_BOX);
    addRoundKey(state, this.#roundKeyBytes, 0);
    return state;
  }
}

function expandAesRoundKeys(
  keyBytes: Uint8Array,
  roundCount: number,
): Uint8Array {
  const expandedBytes = new Uint8Array(16 * (roundCount + 1));
  expandedBytes.set(keyBytes, 0);

  const keyLengthBytes = keyBytes.byteLength;
  const temporaryWord = new Uint8Array(4);
  let bytesGenerated = keyLengthBytes;
  let roundConstant = 1;

  while (bytesGenerated < expandedBytes.byteLength) {
    temporaryWord.set(expandedBytes.subarray(bytesGenerated - 4, bytesGenerated), 0);
    if (bytesGenerated % keyLengthBytes === 0) {
      rotateWordLeft(temporaryWord);
      applyAesSBox(temporaryWord, AES_S_BOX);
      temporaryWord[0] = (temporaryWord[0] ?? 0) ^ roundConstant;
      roundConstant = xtime(roundConstant);
    } else if (keyLengthBytes === 32 && bytesGenerated % keyLengthBytes === 16) {
      applyAesSBox(temporaryWord, AES_S_BOX);
    }

    for (let index = 0; index < 4 && bytesGenerated < expandedBytes.byteLength; index += 1) {
      expandedBytes[bytesGenerated] =
        (expandedBytes[bytesGenerated - keyLengthBytes] ?? 0) ^ (temporaryWord[index] ?? 0);
      bytesGenerated += 1;
    }
  }

  return expandedBytes;
}

function addRoundKey(
  stateBytes: Uint8Array,
  roundKeyBytes: Uint8Array,
  roundIndex: number,
): void {
  const keyOffset = roundIndex * 16;
  for (let index = 0; index < 16; index += 1) {
    stateBytes[index] = (stateBytes[index] ?? 0) ^ (roundKeyBytes[keyOffset + index] ?? 0);
  }
}

function applyAesSBox(
  stateBytes: Uint8Array,
  boxBytes: Uint8Array,
): void {
  for (let index = 0; index < stateBytes.byteLength; index += 1) {
    stateBytes[index] = boxBytes[stateBytes[index] ?? 0] ?? 0;
  }
}

function shiftAesRows(stateBytes: Uint8Array): void {
  const shifted = Uint8Array.from(stateBytes);
  shifted[1] = stateBytes[5] ?? 0;
  shifted[5] = stateBytes[9] ?? 0;
  shifted[9] = stateBytes[13] ?? 0;
  shifted[13] = stateBytes[1] ?? 0;

  shifted[2] = stateBytes[10] ?? 0;
  shifted[6] = stateBytes[14] ?? 0;
  shifted[10] = stateBytes[2] ?? 0;
  shifted[14] = stateBytes[6] ?? 0;

  shifted[3] = stateBytes[15] ?? 0;
  shifted[7] = stateBytes[3] ?? 0;
  shifted[11] = stateBytes[7] ?? 0;
  shifted[15] = stateBytes[11] ?? 0;

  stateBytes.set(shifted, 0);
}

function inverseShiftAesRows(stateBytes: Uint8Array): void {
  const shifted = Uint8Array.from(stateBytes);
  shifted[1] = stateBytes[13] ?? 0;
  shifted[5] = stateBytes[1] ?? 0;
  shifted[9] = stateBytes[5] ?? 0;
  shifted[13] = stateBytes[9] ?? 0;

  shifted[2] = stateBytes[10] ?? 0;
  shifted[6] = stateBytes[14] ?? 0;
  shifted[10] = stateBytes[2] ?? 0;
  shifted[14] = stateBytes[6] ?? 0;

  shifted[3] = stateBytes[7] ?? 0;
  shifted[7] = stateBytes[11] ?? 0;
  shifted[11] = stateBytes[15] ?? 0;
  shifted[15] = stateBytes[3] ?? 0;

  stateBytes.set(shifted, 0);
}

function mixAesColumns(stateBytes: Uint8Array): void {
  for (let offset = 0; offset < 16; offset += 4) {
    const column0 = stateBytes[offset] ?? 0;
    const column1 = stateBytes[offset + 1] ?? 0;
    const column2 = stateBytes[offset + 2] ?? 0;
    const column3 = stateBytes[offset + 3] ?? 0;

    stateBytes[offset] = multiplyInAesField(column0, 2) ^ multiplyInAesField(column1, 3) ^ column2 ^ column3;
    stateBytes[offset + 1] = column0 ^ multiplyInAesField(column1, 2) ^ multiplyInAesField(column2, 3) ^ column3;
    stateBytes[offset + 2] = column0 ^ column1 ^ multiplyInAesField(column2, 2) ^ multiplyInAesField(column3, 3);
    stateBytes[offset + 3] = multiplyInAesField(column0, 3) ^ column1 ^ column2 ^ multiplyInAesField(column3, 2);
  }
}

function inverseMixAesColumns(stateBytes: Uint8Array): void {
  for (let offset = 0; offset < 16; offset += 4) {
    const column0 = stateBytes[offset] ?? 0;
    const column1 = stateBytes[offset + 1] ?? 0;
    const column2 = stateBytes[offset + 2] ?? 0;
    const column3 = stateBytes[offset + 3] ?? 0;

    stateBytes[offset] =
      multiplyInAesField(column0, 14) ^
      multiplyInAesField(column1, 11) ^
      multiplyInAesField(column2, 13) ^
      multiplyInAesField(column3, 9);
    stateBytes[offset + 1] =
      multiplyInAesField(column0, 9) ^
      multiplyInAesField(column1, 14) ^
      multiplyInAesField(column2, 11) ^
      multiplyInAesField(column3, 13);
    stateBytes[offset + 2] =
      multiplyInAesField(column0, 13) ^
      multiplyInAesField(column1, 9) ^
      multiplyInAesField(column2, 14) ^
      multiplyInAesField(column3, 11);
    stateBytes[offset + 3] =
      multiplyInAesField(column0, 11) ^
      multiplyInAesField(column1, 13) ^
      multiplyInAesField(column2, 9) ^
      multiplyInAesField(column3, 14);
  }
}

function xorInto(
  targetBytes: Uint8Array,
  inputBytes: Uint8Array,
): void {
  for (let index = 0; index < targetBytes.byteLength; index += 1) {
    targetBytes[index] = (targetBytes[index] ?? 0) ^ (inputBytes[index] ?? 0);
  }
}

function rotateWordLeft(wordBytes: Uint8Array): void {
  const firstByte = wordBytes[0] ?? 0;
  wordBytes[0] = wordBytes[1] ?? 0;
  wordBytes[1] = wordBytes[2] ?? 0;
  wordBytes[2] = wordBytes[3] ?? 0;
  wordBytes[3] = firstByte;
}

function xtime(value: number): number {
  return ((value << 1) ^ (value & 0x80 ? 0x1b : 0x00)) & 0xff;
}

function multiplyInAesField(
  value: number,
  factor: number,
): number {
  let multiplicand = value;
  let multiplier = factor;
  let product = 0;
  while (multiplier > 0) {
    if ((multiplier & 1) !== 0) {
      product ^= multiplicand;
    }
    multiplicand = xtime(multiplicand);
    multiplier >>= 1;
  }
  return product;
}

const AES_S_BOX = Uint8Array.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const AES_INVERSE_S_BOX = Uint8Array.from([
  0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb,
  0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87, 0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb,
  0x54, 0x7b, 0x94, 0x32, 0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
  0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49, 0x6d, 0x8b, 0xd1, 0x25,
  0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92,
  0x6c, 0x70, 0x48, 0x50, 0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
  0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05, 0xb8, 0xb3, 0x45, 0x06,
  0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02, 0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b,
  0x3a, 0x91, 0x11, 0x41, 0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
  0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8, 0x1c, 0x75, 0xdf, 0x6e,
  0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89, 0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b,
  0xfc, 0x56, 0x3e, 0x4b, 0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
  0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xec, 0x5f,
  0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d, 0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef,
  0xa0, 0xe0, 0x3b, 0x4d, 0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
  0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0c, 0x7d,
]);

function calculateMd5(inputBytes: Uint8Array): Uint8Array {
  const paddedBytes = padMd5Bytes(inputBytes);
  let hashA = 0x67452301;
  let hashB = 0xefcdab89;
  let hashC = 0x98badcfe;
  let hashD = 0x10325476;

  const words = new Uint32Array(16);
  for (let offset = 0; offset < paddedBytes.byteLength; offset += 64) {
    for (let wordIndex = 0; wordIndex < 16; wordIndex += 1) {
      const wordOffset = offset + wordIndex * 4;
      words[wordIndex] =
        (paddedBytes[wordOffset] ?? 0) |
        ((paddedBytes[wordOffset + 1] ?? 0) << 8) |
        ((paddedBytes[wordOffset + 2] ?? 0) << 16) |
        ((paddedBytes[wordOffset + 3] ?? 0) << 24);
    }

    let roundA = hashA;
    let roundB = hashB;
    let roundC = hashC;
    let roundD = hashD;

    for (let iteration = 0; iteration < 64; iteration += 1) {
      let roundFunction: number;
      let wordIndex: number;

      if (iteration < 16) {
        roundFunction = (roundB & roundC) | (~roundB & roundD);
        wordIndex = iteration;
      } else if (iteration < 32) {
        roundFunction = (roundD & roundB) | (~roundD & roundC);
        wordIndex = (5 * iteration + 1) % 16;
      } else if (iteration < 48) {
        roundFunction = roundB ^ roundC ^ roundD;
        wordIndex = (3 * iteration + 5) % 16;
      } else {
        roundFunction = roundC ^ (roundB | ~roundD);
        wordIndex = (7 * iteration) % 16;
      }

      const nextValue = roundD;
      roundD = roundC;
      roundC = roundB;
      roundB = addUint32(
        roundB,
        rotateLeftUint32(
          addUint32(
            roundA,
            roundFunction,
            MD5_ROUND_CONSTANTS[iteration]!,
            words[wordIndex]!,
          ),
          MD5_SHIFT_AMOUNTS[iteration]!,
        ),
      );
      roundA = nextValue;
    }

    hashA = addUint32(hashA, roundA);
    hashB = addUint32(hashB, roundB);
    hashC = addUint32(hashC, roundC);
    hashD = addUint32(hashD, roundD);
  }

  const outputBytes = new Uint8Array(16);
  writeUint32LittleEndian(outputBytes, 0, hashA);
  writeUint32LittleEndian(outputBytes, 4, hashB);
  writeUint32LittleEndian(outputBytes, 8, hashC);
  writeUint32LittleEndian(outputBytes, 12, hashD);
  return outputBytes;
}

function padMd5Bytes(inputBytes: Uint8Array): Uint8Array {
  const paddedLength = ((((inputBytes.byteLength + 8) >> 6) + 1) << 6);
  const paddedBytes = new Uint8Array(paddedLength);
  paddedBytes.set(inputBytes, 0);
  paddedBytes[inputBytes.byteLength] = 0x80;

  const bitLength = BigInt(inputBytes.byteLength) * 8n;
  for (let index = 0; index < 8; index += 1) {
    paddedBytes[paddedBytes.byteLength - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  }

  return paddedBytes;
}

function writeUint32LittleEndian(
  targetBytes: Uint8Array,
  offset: number,
  value: number,
): void {
  targetBytes[offset] = value & 0xff;
  targetBytes[offset + 1] = (value >>> 8) & 0xff;
  targetBytes[offset + 2] = (value >>> 16) & 0xff;
  targetBytes[offset + 3] = (value >>> 24) & 0xff;
}

function addUint32(...values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum = (sum + value) >>> 0;
  }
  return sum;
}

function rotateLeftUint32(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function parseDictionaryEntries(value: string | undefined): Map<string, string> {
  const entries = new Map<string, string>();
  if (!value) {
    return entries;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("<<") || !trimmed.endsWith(">>")) {
    return entries;
  }

  const innerText = trimmed.slice(2, -2);
  let index = 0;

  while (index < innerText.length) {
    index = skipPdfWhitespaceAndComments(innerText, index);
    const keyToken = readPdfNameToken(innerText, index);
    if (!keyToken) {
      index += 1;
      continue;
    }

    const valueStart = skipPdfWhitespaceAndComments(innerText, keyToken.nextIndex);
    const valueToken = readPdfValueToken(innerText, valueStart);
    if (!valueToken) {
      entries.set(keyToken.name, "");
      index = keyToken.nextIndex;
      continue;
    }

    entries.set(keyToken.name, valueToken.token.trim());
    index = valueToken.nextIndex;
  }

  return entries;
}

function readPdfValueToken(
  text: string,
  startIndex: number,
): { readonly token: string; readonly nextIndex: number } | undefined {
  const current = text[startIndex];
  if (current === undefined) {
    return undefined;
  }

  if (current === "<" && text[startIndex + 1] === "<") {
    return readPdfDictionaryToken(text, startIndex);
  }
  if (current === "[") {
    return readPdfArrayToken(text, startIndex);
  }
  if (current === "(") {
    return readPdfLiteralToken(text, startIndex);
  }
  if (current === "<") {
    return readPdfHexStringToken(text, startIndex);
  }
  if (current === "/") {
    return readPdfNameToken(text, startIndex);
  }

  const endIndex = readUntilDelimiter(text, startIndex);
  if (endIndex <= startIndex) {
    return undefined;
  }

  return {
    token: text.slice(startIndex, endIndex),
    nextIndex: endIndex,
  };
}

function readPdfDictionaryToken(
  text: string,
  startIndex: number,
): { readonly token: string; readonly nextIndex: number } | undefined {
  if (text[startIndex] !== "<" || text[startIndex + 1] !== "<") {
    return undefined;
  }

  let depth = 1;
  for (let index = startIndex + 2; index < text.length; index += 1) {
    const current = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (current === "%") {
      index = skipPdfComment(text, index);
      continue;
    }
    if (current === "(") {
      const literalToken = readPdfLiteralToken(text, index);
      if (!literalToken) {
        return undefined;
      }
      index = literalToken.nextIndex - 1;
      continue;
    }
    if (current === "<" && next === "<") {
      depth += 1;
      index += 1;
      continue;
    }
    if (current === ">" && next === ">") {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        return {
          token: text.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return undefined;
}

function readPdfArrayToken(
  text: string,
  startIndex: number,
): { readonly token: string; readonly nextIndex: number } | undefined {
  if (text[startIndex] !== "[") {
    return undefined;
  }

  let depth = 1;
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const current = text[index] ?? "";

    if (current === "%") {
      index = skipPdfComment(text, index);
      continue;
    }
    if (current === "(") {
      const literalToken = readPdfLiteralToken(text, index);
      if (!literalToken) {
        return undefined;
      }
      index = literalToken.nextIndex - 1;
      continue;
    }
    if (current === "<" && text[index + 1] === "<") {
      const dictionaryToken = readPdfDictionaryToken(text, index);
      if (!dictionaryToken) {
        return undefined;
      }
      index = dictionaryToken.nextIndex - 1;
      continue;
    }
    if (current === "[") {
      depth += 1;
      continue;
    }
    if (current === "]") {
      depth -= 1;
      if (depth === 0) {
        return {
          token: text.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return undefined;
}

function readPdfHexStringToken(
  text: string,
  startIndex: number,
): { readonly token: string; readonly nextIndex: number } | undefined {
  if (text[startIndex] !== "<" || text[startIndex + 1] === "<") {
    return undefined;
  }

  for (let index = startIndex + 1; index < text.length; index += 1) {
    if (text[index] === ">") {
      return {
        token: text.slice(startIndex, index + 1),
        nextIndex: index + 1,
      };
    }
  }

  return undefined;
}

function readPdfLiteralToken(
  text: string,
  startIndex: number,
): { readonly token: string; readonly nextIndex: number } | undefined {
  if (text[startIndex] !== "(") {
    return undefined;
  }

  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const current = text[index] ?? "";

    if (current === "\\") {
      index += 1;
      continue;
    }
    if (current === "(") {
      depth += 1;
      continue;
    }
    if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          token: text.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return undefined;
}

function readPdfNameToken(
  text: string,
  startIndex: number,
): { readonly token: string; readonly name: string; readonly nextIndex: number } | undefined {
  if (text[startIndex] !== "/") {
    return undefined;
  }

  let endIndex = startIndex + 1;
  while (endIndex < text.length && !isPdfDelimiter(text[endIndex] ?? "")) {
    endIndex += 1;
  }

  if (endIndex <= startIndex + 1) {
    return undefined;
  }

  const token = text.slice(startIndex, endIndex);
  return {
    token,
    name: token.slice(1),
    nextIndex: endIndex,
  };
}

function readNameValue(value: string | undefined): string | undefined {
  return value ? readPdfNameToken(value.trim(), 0)?.name : undefined;
}

function readSignedIntegerValue(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return undefined;
  }

  return Number.parseInt(trimmed, 10);
}

function readBooleanValue(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return undefined;
}

function skipPdfWhitespaceAndComments(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length) {
    const current = text[index] ?? "";
    if (current === "%") {
      index = skipPdfComment(text, index);
      continue;
    }
    if (!isPdfWhitespace(current)) {
      break;
    }
    index += 1;
  }
  return index;
}

function skipPdfComment(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length) {
    const current = text[index] ?? "";
    index += 1;
    if (current === "\n") {
      break;
    }
    if (current === "\r") {
      if (text[index] === "\n") {
        index += 1;
      }
      break;
    }
  }
  return index;
}

function readUntilDelimiter(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length && !isPdfDelimiter(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function isPdfDelimiter(character: string): boolean {
  return isPdfWhitespace(character) || character === "(" || character === ")" || character === "<" || character === ">" ||
    character === "[" || character === "]" || character === "{" || character === "}" || character === "/" || character === "%";
}

function isPdfWhitespace(character: string): boolean {
  return character === "\x00" || character === "\t" || character === "\n" || character === "\f" || character === "\r" || character === " ";
}

const MD5_SHIFT_AMOUNTS = Uint8Array.from([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const MD5_ROUND_CONSTANTS = Uint32Array.from([
  0xd76aa478,
  0xe8c7b756,
  0x242070db,
  0xc1bdceee,
  0xf57c0faf,
  0x4787c62a,
  0xa8304613,
  0xfd469501,
  0x698098d8,
  0x8b44f7af,
  0xffff5bb1,
  0x895cd7be,
  0x6b901122,
  0xfd987193,
  0xa679438e,
  0x49b40821,
  0xf61e2562,
  0xc040b340,
  0x265e5a51,
  0xe9b6c7aa,
  0xd62f105d,
  0x02441453,
  0xd8a1e681,
  0xe7d3fbc8,
  0x21e1cde6,
  0xc33707d6,
  0xf4d50d87,
  0x455a14ed,
  0xa9e3e905,
  0xfcefa3f8,
  0x676f02d9,
  0x8d2a4c8a,
  0xfffa3942,
  0x8771f681,
  0x6d9d6122,
  0xfde5380c,
  0xa4beea44,
  0x4bdecfa9,
  0xf6bb4b60,
  0xbebfbc70,
  0x289b7ec6,
  0xeaa127fa,
  0xd4ef3085,
  0x04881d05,
  0xd9d4d039,
  0xe6db99e5,
  0x1fa27cf8,
  0xc4ac5665,
  0xf4292244,
  0x432aff97,
  0xab9423a7,
  0xfc93a039,
  0x655b59c3,
  0x8f0ccc92,
  0xffeff47d,
  0x85845dd1,
  0x6fa87e4f,
  0xfe2ce6e0,
  0xa3014314,
  0x4e0811a1,
  0xf7537e82,
  0xbd3af235,
  0x2ad7d2bb,
  0xeb86d391,
]);
