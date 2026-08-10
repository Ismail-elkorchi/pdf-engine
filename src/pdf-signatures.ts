import {
  ContentInfo,
  id_messageDigest,
  id_signedData,
  MessageDigest,
  SignedData,
  type SignerInfo,
} from "@peculiar/asn1-cms";
import { id_mgf1, id_RSASSA_PSS, RsaSaPssParams } from "@peculiar/asn1-rsa";
import { AsnParser, AsnSerializer } from "@peculiar/asn1-schema";
import { AlgorithmIdentifier } from "@peculiar/asn1-x509";

import { pdfDictionaryGet } from "./pdf-values.ts";

import type { PdfDiagnostic } from "./contracts.ts";
import type { PdfObjectStore } from "./pdf-object-store.ts";
import type {
  PdfRevocationEvidence,
  PdfSignature,
  PdfSignatureVerification,
  PdfSignatureVerificationRequest,
} from "./public-api.ts";
import type * as X509Api from "@peculiar/x509";

const RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const RSA_SIGNATURES = new Set([
  RSA_ENCRYPTION,
  "1.2.840.113549.1.1.5",
  "1.2.840.113549.1.1.11",
  "1.2.840.113549.1.1.12",
  "1.2.840.113549.1.1.13",
]);
const ECDSA_SIGNATURES = new Set([
  "1.2.840.10045.4.1",
  "1.2.840.10045.4.3.2",
  "1.2.840.10045.4.3.3",
  "1.2.840.10045.4.3.4",
]);
const ED25519 = "1.3.101.112";
interface X509Module {
  readonly AsnEcSignatureFormatter: typeof X509Api.AsnEcSignatureFormatter;
  readonly BasicConstraintsExtension: typeof X509Api.BasicConstraintsExtension;
  readonly KeyUsageFlags: typeof X509Api.KeyUsageFlags;
  readonly KeyUsagesExtension: typeof X509Api.KeyUsagesExtension;
  readonly SubjectKeyIdentifierExtension: typeof X509Api.SubjectKeyIdentifierExtension;
  readonly X509Certificate: typeof X509Api.X509Certificate;
  readonly X509ChainBuilder: typeof X509Api.X509ChainBuilder;
  readonly X509Crl: typeof X509Api.X509Crl;
}
let x509ModulePromise: Promise<X509Module> | undefined;

export async function verifyPdfSignatures(
  bytes: Uint8Array,
  store: PdfObjectStore,
  signatures: readonly PdfSignature[],
  request: PdfSignatureVerificationRequest,
): Promise<readonly PdfSignatureVerification[]> {
  if (signatures.length === 0) {
    return [];
  }
  const x509 = await loadX509Module();
  const trustAnchors = request.trustPolicy.trustAnchors.map((anchor) => {
    try {
      return new x509.X509Certificate(toArrayBuffer(anchor));
    } catch (error: unknown) {
      throw new TypeError(`Invalid signature trust anchor: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const revocation = parseRevocationEvidence(request.trustPolicy.revocationEvidence ?? [], x509);
  const results: PdfSignatureVerification[] = [];
  for (const signature of signatures) {
    throwIfAborted(request.signal);
    results.push(await verifyOneSignature(bytes, store, signature, request, trustAnchors, revocation, x509));
  }
  return results;
}

async function verifyOneSignature(
  bytes: Uint8Array,
  store: PdfObjectStore,
  signature: PdfSignature,
  request: PdfSignatureVerificationRequest,
  trustAnchors: readonly X509Api.X509Certificate[],
  revocation: ParsedRevocationEvidence,
  x509: X509Module,
): Promise<PdfSignatureVerification> {
  try {
    const signatureObject = await store.require(signature.objectRef);
    if (signatureObject.value.kind !== "dictionary") {
      return invalid(signature, "signature-dictionary-invalid", "The signature value is not a dictionary.");
    }
    const contents = pdfDictionaryGet(signatureObject.value, "Contents");
    if (contents?.kind !== "string") {
      return invalid(signature, "signature-contents-missing", "The signature dictionary has no binary Contents value.");
    }
    if (!isSupportedSubFilter(signature.subFilter)) {
      return unsupported(signature, "The signature subfilter is not supported for cryptographic verification.");
    }
    const byteRangeData = collectSignedBytes(bytes, signature.byteRange, contents.source);
    const contentData = signature.subFilter === "adbe.pkcs7.sha1"
      ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", toArrayBuffer(byteRangeData)))
      : byteRangeData;
    const contentInfo = AsnParser.parse(trimDerPadding(contents.bytes), ContentInfo, parserOptions());
    if (contentInfo.contentType !== id_signedData) {
      return invalid(signature, "signature-cms-invalid", "The signature Contents value is not CMS SignedData.");
    }
    const signedData = AsnParser.parse(contentInfo.content, SignedData, parserOptions());
    const signerInfo = signedData.signerInfos[0];
    if (signerInfo === undefined) {
      return invalid(signature, "signature-signer-missing", "CMS SignedData contains no signer information.");
    }
    const certificates = readCertificates(signedData, x509);
    const signerCertificate = await findSignerCertificate(signerInfo, certificates, x509);
    if (signerCertificate === undefined) {
      return invalid(signature, "signature-certificate-missing", "The CMS signer certificate could not be identified.");
    }
    const hashName = digestName(signerInfo.digestAlgorithm.algorithm);
    if (hashName === undefined) {
      return unsupported(signature, "The CMS digest algorithm is not supported by Web Crypto.");
    }
    const signatureInput = await validateSignedAttributes(signerInfo, contentData, hashName);
    const integrity = await verifyCmsSignature(signerInfo, signerCertificate, signatureInput, hashName, x509);
    if (!integrity) {
      return invalid(signature, "signature-integrity-invalid", "The CMS signature does not match the signed byte ranges.");
    }
    return verifyTrust(
      signature,
      signerCertificate,
      certificates,
      trustAnchors,
      request,
      revocation,
      x509,
    );
  } catch (error: unknown) {
    return invalid(
      signature,
      "signature-verification-failed",
      error instanceof Error ? error.message : "Signature verification failed.",
    );
  }
}

function readCertificates(signedData: SignedData, x509: X509Module): readonly CertificateRecord[] {
  return (signedData.certificates ?? []).flatMap((choice) => {
    if (choice.certificate === undefined) {
      return [];
    }
    return [{
      certificate: new x509.X509Certificate(choice.certificate),
      issuer: AsnSerializer.serialize(choice.certificate.tbsCertificate.issuer),
      serialNumber: choice.certificate.tbsCertificate.serialNumber,
    }];
  });
}

interface CertificateRecord {
  readonly certificate: X509Api.X509Certificate;
  readonly issuer: ArrayBuffer;
  readonly serialNumber: ArrayBuffer;
}

async function findSignerCertificate(
  signer: SignerInfo,
  certificates: readonly CertificateRecord[],
  x509: X509Module,
): Promise<X509Api.X509Certificate | undefined> {
  const issuerAndSerial = signer.sid.issuerAndSerialNumber;
  if (issuerAndSerial !== undefined) {
    const issuer = AsnSerializer.serialize(issuerAndSerial.issuer);
    return certificates.find((record) =>
      equalBytes(record.issuer, issuer) &&
      equalIntegerBytes(record.serialNumber, issuerAndSerial.serialNumber)
    )?.certificate;
  }
  const subjectKeyIdentifier = signer.sid.subjectKeyIdentifier;
  if (subjectKeyIdentifier === undefined) {
    return undefined;
  }
  for (const record of certificates) {
    const extension = record.certificate.getExtension(x509.SubjectKeyIdentifierExtension);
    const keyIdentifier = extension === null
      ? await record.certificate.publicKey.getKeyIdentifier("SHA-1")
      : hexBytes(extension.keyId);
    if (equalBytes(keyIdentifier, subjectKeyIdentifier.buffer)) {
      return record.certificate;
    }
  }
  return undefined;
}

async function validateSignedAttributes(
  signer: SignerInfo,
  content: Uint8Array,
  hashName: string,
): Promise<Uint8Array> {
  if (signer.signedAttrs === undefined) {
    return content;
  }
  const digestAttribute = signer.signedAttrs.find((attribute) => attribute.attrType === id_messageDigest);
  const digestValue = digestAttribute?.attrValues[0];
  if (digestValue === undefined) {
    throw new Error("CMS signed attributes omit messageDigest.");
  }
  const declaredDigest = AsnParser.parse(digestValue, MessageDigest, parserOptions());
  const actualDigest = await globalThis.crypto.subtle.digest(hashName, toArrayBuffer(content));
  if (!equalBytes(declaredDigest.buffer, actualDigest)) {
    throw new Error("CMS messageDigest does not match the signed byte ranges.");
  }
  if (signer.signedAttrsRaw === undefined) {
    throw new Error("CMS signed attributes have no preserved DER encoding.");
  }
  const encoded = new Uint8Array(signer.signedAttrsRaw.slice(0));
  if (encoded[0] !== 0xa0) {
    throw new Error("CMS signed attributes use an invalid context tag.");
  }
  encoded[0] = 0x31;
  return encoded;
}

async function verifyCmsSignature(
  signer: SignerInfo,
  certificate: X509Api.X509Certificate,
  data: Uint8Array,
  hashName: string,
  x509: X509Module,
): Promise<boolean> {
  const signatureOid = signer.signatureAlgorithm.algorithm;
  if (RSA_SIGNATURES.has(signatureOid)) {
    const declaredHash = signatureDigestName(signatureOid);
    if (declaredHash !== undefined && declaredHash !== hashName) {
      return false;
    }
    const algorithm: RsaHashedImportParams = { name: "RSASSA-PKCS1-v1_5", hash: hashName };
    const key = await certificate.publicKey.export(algorithm, ["verify"], globalThis.crypto);
    return globalThis.crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signer.signature.buffer,
      toArrayBuffer(data),
    );
  }
  if (signatureOid === id_RSASSA_PSS) {
    const parameters = signer.signatureAlgorithm.parameters === undefined || signer.signatureAlgorithm.parameters === null
      ? new RsaSaPssParams()
      : AsnParser.parse(signer.signatureAlgorithm.parameters, RsaSaPssParams, parserOptions());
    const pssHash = digestName(parameters.hashAlgorithm.algorithm);
    const maskParameters = parameters.maskGenAlgorithm.parameters;
    const maskHash = parameters.maskGenAlgorithm.algorithm !== id_mgf1 || maskParameters === undefined || maskParameters === null
      ? undefined
      : digestName(AsnParser.parse(maskParameters, AlgorithmIdentifier, parserOptions()).algorithm);
    if (
      pssHash !== hashName ||
      maskHash !== hashName ||
      !Number.isSafeInteger(parameters.saltLength) ||
      parameters.saltLength < 0 ||
      parameters.trailerField !== 1
    ) {
      return false;
    }
    const algorithm: RsaHashedImportParams = { name: "RSA-PSS", hash: hashName };
    const key = await certificate.publicKey.export(algorithm, ["verify"], globalThis.crypto);
    return globalThis.crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: parameters.saltLength },
      key,
      signer.signature.buffer,
      toArrayBuffer(data),
    );
  }
  if (ECDSA_SIGNATURES.has(signatureOid)) {
    if (signatureDigestName(signatureOid) !== hashName) {
      return false;
    }
    const publicAlgorithm = certificate.publicKey.algorithm;
    if (!("namedCurve" in publicAlgorithm) || typeof publicAlgorithm.namedCurve !== "string") {
      return false;
    }
    const algorithm: EcKeyImportParams = { name: "ECDSA", namedCurve: publicAlgorithm.namedCurve };
    const key = await certificate.publicKey.export(algorithm, ["verify"], globalThis.crypto);
    const signature = new x509.AsnEcSignatureFormatter().toWebSignature(algorithm, signer.signature.buffer);
    return signature !== null && globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: hashName },
      key,
      signature,
      toArrayBuffer(data),
    );
  }
  if (signatureOid === ED25519) {
    const key = await certificate.publicKey.export({ name: "Ed25519" }, ["verify"], globalThis.crypto);
    return globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signer.signature.buffer,
      toArrayBuffer(data),
    );
  }
  return false;
}

async function verifyTrust(
  signature: PdfSignature,
  signerCertificate: X509Api.X509Certificate,
  certificates: readonly CertificateRecord[],
  trustAnchors: readonly X509Api.X509Certificate[],
  request: PdfSignatureVerificationRequest,
  revocation: ParsedRevocationEvidence,
  x509: X509Module,
): Promise<PdfSignatureVerification> {
  const diagnostics: PdfDiagnostic[] = [];
  if (trustAnchors.length === 0) {
    diagnostics.push(signatureDiagnostic(
      "signature-trust-anchor-missing",
      "Integrity is valid, but no caller-supplied trust anchor is available.",
      signature,
    ));
    return { signature, integrity: "valid", trust: "indeterminate", diagnostics };
  }
  const chain = await new x509.X509ChainBuilder({
    certificates: [...certificates.map((record) => record.certificate), ...trustAnchors],
  }).build(signerCertificate, globalThis.crypto);
  const anchor = chain.at(-1);
  if (anchor === undefined || !trustAnchors.some((candidate) => candidate.equal(anchor))) {
    diagnostics.push(signatureDiagnostic("signature-chain-untrusted", "The signer chain does not terminate at a supplied trust anchor.", signature));
    return { signature, integrity: "valid", trust: "untrusted", diagnostics };
  }
  const validationTime = request.trustPolicy.validationTime;
  for (const [index, certificate] of chain.entries()) {
    if (validationTime < certificate.notBefore || validationTime > certificate.notAfter) {
      diagnostics.push(signatureDiagnostic("signature-certificate-expired", "A certificate in the signer chain is not valid at the requested time.", signature));
      return { signature, integrity: "valid", trust: "untrusted", diagnostics };
    }
    if (index > 0) {
      const constraints = certificate.getExtension(x509.BasicConstraintsExtension);
      const usages = certificate.getExtension(x509.KeyUsagesExtension);
      if (constraints?.ca !== true || (usages !== null && (usages.usages & x509.KeyUsageFlags.keyCertSign) === 0)) {
        diagnostics.push(signatureDiagnostic("signature-ca-constraints-invalid", "A chain issuer is not authorized to sign certificates.", signature));
        return { signature, integrity: "valid", trust: "untrusted", diagnostics };
      }
    }
  }
  const revocationStatus = await checkRevocation(chain, validationTime, request.trustPolicy.revocationMode ?? "if-present", revocation);
  if (revocationStatus === "revoked" || revocationStatus === "invalid") {
    diagnostics.push(signatureDiagnostic("signature-certificate-revoked", "A signer-chain certificate is revoked or has invalid revocation evidence.", signature));
    return { signature, integrity: "valid", trust: "untrusted", diagnostics };
  }
  if (revocationStatus === "missing") {
    diagnostics.push(signatureDiagnostic("signature-revocation-evidence-missing", "Required revocation evidence is unavailable for the signer chain.", signature));
    return { signature, integrity: "valid", trust: "indeterminate", diagnostics };
  }
  if (revocation.unsupportedOcspCount > 0 && request.trustPolicy.revocationMode !== "ignore") {
    diagnostics.push(signatureDiagnostic("signature-ocsp-unsupported", "Supplied OCSP evidence could not be evaluated by the offline verifier.", signature));
  }
  return { signature, integrity: "valid", trust: "trusted", diagnostics };
}

interface ParsedRevocationEvidence {
  readonly crls: readonly X509Api.X509Crl[];
  readonly invalidCount: number;
  readonly unsupportedOcspCount: number;
}

function parseRevocationEvidence(
  values: readonly PdfRevocationEvidence[],
  x509: X509Module,
): ParsedRevocationEvidence {
  const crls: X509Api.X509Crl[] = [];
  let invalidCount = 0;
  let unsupportedOcspCount = 0;
  for (const value of values) {
    if (value.kind === "ocsp") {
      unsupportedOcspCount += 1;
      continue;
    }
    try {
      crls.push(new x509.X509Crl(toArrayBuffer(value.bytes)));
    } catch {
      invalidCount += 1;
    }
  }
  return { crls, invalidCount, unsupportedOcspCount };
}

async function checkRevocation(
  chain: readonly X509Api.X509Certificate[],
  validationTime: Date,
  mode: "ignore" | "if-present" | "require",
  evidence: ParsedRevocationEvidence,
): Promise<"clear" | "missing" | "revoked" | "invalid"> {
  if (mode === "ignore") {
    return "clear";
  }
  if (evidence.invalidCount > 0) {
    return "invalid";
  }
  for (let index = 0; index + 1 < chain.length; index += 1) {
    const certificate = chain[index];
    const issuer = chain[index + 1];
    if (certificate === undefined || issuer === undefined) {
      continue;
    }
    const matching = evidence.crls.filter((crl) => crl.issuer === issuer.subject);
    if (matching.length === 0) {
      if (mode === "require") {
        return "missing";
      }
      continue;
    }
    let validEvidence = false;
    for (const crl of matching) {
      if (
        crl.thisUpdate > validationTime ||
        (crl.nextUpdate !== undefined && crl.nextUpdate < validationTime) ||
        !await crl.verify({ publicKey: issuer }, globalThis.crypto)
      ) {
        continue;
      }
      validEvidence = true;
      if (crl.findRevoked(certificate) !== null) {
        return "revoked";
      }
    }
    if (!validEvidence) {
      return mode === "require" ? "missing" : "invalid";
    }
  }
  return "clear";
}

function collectSignedBytes(
  bytes: Uint8Array,
  byteRange: readonly number[],
  contentsSource: { readonly start: number; readonly end: number },
): Uint8Array {
  if (byteRange.length !== 4) {
    throw new RangeError("Signature ByteRange must contain exactly two offset-length pairs.");
  }
  const segments: Uint8Array[] = [];
  let previousEnd = 0;
  let total = 0;
  for (let index = 0; index < byteRange.length; index += 2) {
    const offset = byteRange[index];
    const length = byteRange[index + 1];
    if (
      offset === undefined ||
      length === undefined ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < previousEnd ||
      length < 0 ||
      offset + length > bytes.byteLength
    ) {
      throw new RangeError("Signature ByteRange is invalid or outside the source.");
    }
    const segment = bytes.subarray(offset, offset + length);
    segments.push(segment);
    total += segment.byteLength;
    previousEnd = offset + length;
  }
  const firstOffset = byteRange[0];
  const firstLength = byteRange[1];
  const secondOffset = byteRange[2];
  const secondLength = byteRange[3];
  if (
    firstOffset !== 0 || firstLength === undefined || secondOffset === undefined || secondLength === undefined ||
    firstLength !== contentsSource.start || secondOffset !== contentsSource.end ||
    firstLength >= secondOffset || secondOffset + secondLength !== bytes.byteLength
  ) {
    throw new RangeError("Signature ByteRange does not cover the document around the Contents value.");
  }
  const joined = new Uint8Array(total);
  let cursor = 0;
  for (const segment of segments) {
    joined.set(segment, cursor);
    cursor += segment.byteLength;
  }
  return joined;
}

function signatureDigestName(oid: string): string | undefined {
  switch (oid) {
    case "1.2.840.113549.1.1.5":
    case "1.2.840.10045.4.1": return "SHA-1";
    case "1.2.840.113549.1.1.11":
    case "1.2.840.10045.4.3.2": return "SHA-256";
    case "1.2.840.113549.1.1.12":
    case "1.2.840.10045.4.3.3": return "SHA-384";
    case "1.2.840.113549.1.1.13":
    case "1.2.840.10045.4.3.4": return "SHA-512";
    default: return undefined;
  }
}

function trimDerPadding(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0x30) {
    return bytes;
  }
  const firstLength = bytes[1] ?? 0;
  if ((firstLength & 0x80) === 0) {
    return bytes.subarray(0, Math.min(bytes.length, 2 + firstLength));
  }
  const lengthBytes = firstLength & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 6 || 2 + lengthBytes > bytes.length) {
    return bytes;
  }
  let contentLength = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    contentLength = contentLength * 256 + (bytes[2 + index] ?? 0);
  }
  const totalLength = 2 + lengthBytes + contentLength;
  return totalLength <= bytes.length ? bytes.subarray(0, totalLength) : bytes;
}

function digestName(oid: string): string | undefined {
  switch (oid) {
    case "1.3.14.3.2.26": return "SHA-1";
    case "2.16.840.1.101.3.4.2.1": return "SHA-256";
    case "2.16.840.1.101.3.4.2.2": return "SHA-384";
    case "2.16.840.1.101.3.4.2.3": return "SHA-512";
    default: return undefined;
  }
}

function isSupportedSubFilter(subFilter: string | undefined): boolean {
  return subFilter === "adbe.pkcs7.detached" ||
    subFilter === "adbe.pkcs7.sha1" ||
    subFilter === "ETSI.CAdES.detached";
}

function invalid(signature: PdfSignature, code: string, message: string): PdfSignatureVerification {
  return {
    signature,
    integrity: "invalid",
    trust: "indeterminate",
    diagnostics: [signatureDiagnostic(code, message, signature)],
  };
}

function unsupported(signature: PdfSignature, message: string): PdfSignatureVerification {
  return {
    signature,
    integrity: "unsupported",
    trust: "indeterminate",
    diagnostics: [signatureDiagnostic("signature-algorithm-unsupported", message, signature)],
  };
}

function signatureDiagnostic(code: string, message: string, signature: PdfSignature): PdfDiagnostic {
  return { code, stage: "ir", level: "medium", message, objectRef: signature.objectRef };
}

function parserOptions(): { readonly berOptions: { readonly maxDepth: number; readonly maxNodes: number; readonly maxContentLength: number } } {
  return { berOptions: { maxDepth: 64, maxNodes: 20_000, maxContentLength: 32_000_000 } };
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function equalIntegerBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  return equalBytes(stripIntegerPadding(left), stripIntegerPadding(right));
}

function stripIntegerPadding(value: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(value);
  let start = 0;
  while (start + 1 < bytes.length && bytes[start] === 0) {
    start += 1;
  }
  return Uint8Array.from(bytes.subarray(start)).buffer;
}

function hexBytes(value: string): ArrayBuffer {
  if (value.length % 2 !== 0) {
    throw new Error("Hexadecimal key identifier has an odd length.");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isInteger(byte)) {
      throw new Error("Key identifier contains invalid hexadecimal digits.");
    }
    bytes[index] = byte;
  }
  return bytes.buffer;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
  }
}

async function loadX509Module(): Promise<X509Module> {
  x509ModulePromise ??= import("reflect-metadata").then(async () => import("@peculiar/x509"));
  return x509ModulePromise;
}
