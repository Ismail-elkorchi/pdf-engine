import type {
  PdfAdmissionArtifact,
  PdfAdmissionDecision,
  PdfAdmissionPolicy,
  PdfAdmissionRequest,
  PdfDiagnostic,
  PdfDocumentSource,
  PdfEngine,
  PdfEngineIdentity,
  PdfEngineOptions,
  PdfFeatureKind,
  PdfFeatureSignal,
  PdfIrDocument,
  PdfIrPageShell,
  PdfIrRequest,
  PdfNormalizedAdmissionPolicy,
  PdfObservedDocument,
  PdfObservedGlyph,
  PdfObservedPage,
  PdfObservedTextRun,
  PdfObservationRequest,
  PdfPipelineRequest,
  PdfPipelineResult,
  PdfPolicyAction,
  PdfRuntimeCapabilities,
  PdfRuntimeDescriptor,
  PdfStageResult,
} from "./contracts.ts";

const DEFAULT_POLICY: PdfNormalizedAdmissionPolicy = {
  javascriptActions: "deny",
  launchActions: "deny",
  embeddedFiles: "report",
  repairMode: "safe",
  passwordPolicy: "known-only",
  allowEncryptedMetadata: false,
  resourceBudget: {
    maxBytes: 64_000_000,
    maxPages: 10_000,
    maxObjects: 2_000_000,
    maxMilliseconds: 5_000,
    maxRecursionDepth: 64,
    maxScanBytes: 1_500_000,
  },
};

const ENGINE_IDENTITY: PdfEngineIdentity = {
  name: "@ismail-elkorchi/pdf-engine",
  version: "0.1.0-shell",
  mode: "shell",
};

const FEATURE_PATTERNS: ReadonlyArray<{
  kind: PdfFeatureKind;
  pattern: RegExp;
  actionKey: "javascriptActions" | "launchActions" | "embeddedFiles" | null;
}> = [
  { kind: "javascript-actions", pattern: /\/(?:JS|JavaScript)\b/, actionKey: "javascriptActions" },
  { kind: "embedded-files", pattern: /\/EmbeddedFile\b/, actionKey: "embeddedFiles" },
  { kind: "launch-actions", pattern: /\/Launch\b/, actionKey: "launchActions" },
  { kind: "forms", pattern: /\/AcroForm\b/, actionKey: null },
  { kind: "annotations", pattern: /\/Annots\b/, actionKey: null },
  { kind: "outlines", pattern: /\/Outlines\b/, actionKey: null },
  { kind: "signatures", pattern: /\/Sig\b/, actionKey: null },
  { kind: "encryption", pattern: /\/Encrypt\b/, actionKey: null },
  { kind: "object-streams", pattern: /\/ObjStm\b/, actionKey: null },
  { kind: "xref-streams", pattern: /\/Type\s*\/XRef\b/, actionKey: null },
  { kind: "images", pattern: /\/Subtype\s*\/Image\b/, actionKey: null },
  { kind: "fonts", pattern: /\/Font\b/, actionKey: null },
  { kind: "hidden-text", pattern: /\/(?:OC|ActualText)\b/, actionKey: null },
  { kind: "duplicate-text-layer", pattern: /\/Subtype\s*\/Image\b[\s\S]{0,500}\/Font\b/, actionKey: null },
] as const;

/**
 * Creates a `pdf-engine` instance with a normalized default admission policy and runtime detection.
 *
 * The current implementation is a shell engine for admission, IR, and observation stages.
 * It is suitable for smoke checks, contract shaping, and early integration work, but it is not
 * yet a full PDF parser, layout engine, or renderer.
 *
 * @param options Optional default policy overrides applied to every request unless a request provides its own policy.
 * @returns A runtime-aware engine instance exposing staged admission, IR, observation, and pipeline operations.
 */
export function createPdfEngine(options: PdfEngineOptions = {}): PdfEngine {
  const defaultPolicy = mergePolicy(DEFAULT_POLICY, options.defaultPolicy);
  const runtime = detectRuntime();
  const capabilities = detectRuntimeCapabilities(runtime);

  return {
    identity: ENGINE_IDENTITY,
    runtime,
    capabilities,
    defaultPolicy,
    admit,
    toIr,
    observe,
    run,
  };

  async function admit(request: PdfAdmissionRequest): Promise<PdfStageResult<PdfAdmissionArtifact>> {
    const policy = mergePolicy(defaultPolicy, request.policy);
    const source = request.source;
    const diagnostics: PdfDiagnostic[] = [];
    const byteLength = source.bytes.byteLength;

    if (byteLength > policy.resourceBudget.maxBytes) {
      diagnostics.push({
        code: "resource-budget-bytes-exceeded",
        stage: "admission",
        level: "critical",
        message: `Document exceeds the configured byte budget of ${policy.resourceBudget.maxBytes} bytes.`,
      });

      const artifact: PdfAdmissionArtifact = {
        decision: "rejected",
        fileType: "unknown",
        byteLength,
        isEncrypted: false,
        featureSignals: [],
        policy,
        ...(source.fileName !== undefined ? { fileName: source.fileName } : {}),
      };
      return stageResult("admission", "blocked", diagnostics, artifact);
    }

    const scanText = decodeLatin1(source.bytes, policy.resourceBudget.maxScanBytes);
    const fileType = /%PDF-\d\.\d/.test(scanText) ? "pdf" : "unknown";
    const pdfVersion = readPdfVersion(scanText);
    const featureSignals = detectFeatureSignals(scanText, policy);
    const pageCountEstimate = countMatches(scanText, /\/Type\s*\/Page\b/g) || undefined;
    const objectCountEstimate = countMatches(scanText, /\b\d+\s+\d+\s+obj\b/g) || undefined;
    const isEncrypted = featureSignals.some((signal) => signal.kind === "encryption" && signal.detected);

    if (fileType !== "pdf") {
      diagnostics.push({
        code: "unsupported-file-type",
        stage: "admission",
        level: "high",
        message: "The source does not look like a PDF file.",
      });

      const artifact: PdfAdmissionArtifact = {
        decision: "rejected",
        fileType,
        byteLength,
        isEncrypted: false,
        featureSignals,
        policy,
        ...(source.fileName !== undefined ? { fileName: source.fileName } : {}),
      };
      return stageResult("admission", "blocked", diagnostics, artifact);
    }

    if (pageCountEstimate !== undefined && pageCountEstimate > policy.resourceBudget.maxPages) {
      diagnostics.push({
        code: "resource-budget-pages-exceeded",
        stage: "admission",
        level: "critical",
        message: `Document page estimate exceeds the configured page budget of ${policy.resourceBudget.maxPages}.`,
      });

      const artifact: PdfAdmissionArtifact = {
        decision: "rejected",
        fileType,
        byteLength,
        isEncrypted,
        featureSignals,
        policy,
        ...(source.fileName !== undefined ? { fileName: source.fileName } : {}),
        ...(pdfVersion !== undefined ? { pdfVersion } : {}),
        ...(pageCountEstimate !== undefined ? { pageCountEstimate } : {}),
        ...(objectCountEstimate !== undefined ? { objectCountEstimate } : {}),
      };
      return stageResult("admission", "blocked", diagnostics, artifact);
    }

    if (objectCountEstimate !== undefined && objectCountEstimate > policy.resourceBudget.maxObjects) {
      diagnostics.push({
        code: "resource-budget-objects-exceeded",
        stage: "admission",
        level: "critical",
        message: `Document object estimate exceeds the configured object budget of ${policy.resourceBudget.maxObjects}.`,
      });

      const artifact: PdfAdmissionArtifact = {
        decision: "rejected",
        fileType,
        byteLength,
        isEncrypted,
        featureSignals,
        policy,
        ...(source.fileName !== undefined ? { fileName: source.fileName } : {}),
        ...(pdfVersion !== undefined ? { pdfVersion } : {}),
        ...(pageCountEstimate !== undefined ? { pageCountEstimate } : {}),
        ...(objectCountEstimate !== undefined ? { objectCountEstimate } : {}),
      };
      return stageResult("admission", "blocked", diagnostics, artifact);
    }

    for (const signal of featureSignals) {
      if (!signal.detected) {
        continue;
      }

      diagnostics.push({
        code: `feature-${signal.kind}`,
        stage: "admission",
        level: signal.action === "deny" ? "high" : "medium",
        message: signal.message,
        feature: signal.kind,
      });
    }

    let decision: PdfAdmissionDecision = "accepted";

    if (isEncrypted) {
      if (policy.passwordPolicy === "forbid") {
        decision = "rejected";
        diagnostics.push({
          code: "encrypted-document-rejected",
          stage: "admission",
          level: "high",
          message: "Encrypted documents are forbidden by the active policy.",
          feature: "encryption",
        });
      } else if (!request.passwordProvider) {
        decision = "password-required";
        diagnostics.push({
          code: "password-required",
          stage: "admission",
          level: "medium",
          message: "A password provider is required before the document can advance.",
          feature: "encryption",
        });
      } else {
        const challenge = {
          reason: "document-encrypted",
          attempts: 0,
          ...(source.fileName !== undefined ? { fileName: source.fileName } : {}),
        } as const;
        const password = await request.passwordProvider(challenge);

        if (!password) {
          decision = "password-required";
          diagnostics.push({
            code: "password-not-provided",
            stage: "admission",
            level: "medium",
            message: "The password provider declined to provide a password.",
            feature: "encryption",
          });
        } else {
          decision = "unsupported";
          diagnostics.push({
            code: "decryption-not-implemented",
            stage: "admission",
            level: "medium",
            message: "The shell engine recognizes encrypted PDFs but does not implement decryption yet.",
            feature: "encryption",
          });
        }
      }
    }

    const status = decision === "accepted" ? "completed" : "blocked";

    const artifact: PdfAdmissionArtifact = {
      decision,
      fileType,
      byteLength,
      isEncrypted,
      featureSignals,
      policy,
      ...(source.fileName !== undefined ? { fileName: source.fileName } : {}),
      ...(pdfVersion !== undefined ? { pdfVersion } : {}),
      ...(pageCountEstimate !== undefined ? { pageCountEstimate } : {}),
      ...(objectCountEstimate !== undefined ? { objectCountEstimate } : {}),
    };

    return stageResult("admission", status, diagnostics, artifact);
  }

  async function toIr(request: PdfIrRequest): Promise<PdfStageResult<PdfIrDocument>> {
    const admissionRequest: PdfAdmissionRequest = {
      source: request.source,
      intent: "layout",
      ...(request.policy !== undefined ? { policy: request.policy } : {}),
    };
    const admission = await admit(admissionRequest);

    if (admission.status !== "completed" || !admission.value || admission.value.decision !== "accepted") {
      return stageResult("ir", "blocked", admission.diagnostics);
    }

    const scanText = decodeLatin1(request.source.bytes, admission.value.policy.resourceBudget.maxScanBytes);
    const pageCountEstimate = admission.value.pageCountEstimate ?? 1;
    const streamCount = countMatches(scanText, /\bstream\b/g);
    const resourceCount = countMatches(scanText, /\/Resources\b/g);
    const annotationCount = countMatches(scanText, /\/Annots\b/g);
    const pages: PdfIrPageShell[] = Array.from({ length: pageCountEstimate }, (_, index) => ({
      pageNumber: index + 1,
      contentStreamCount: index === 0 ? streamCount : 0,
      resourceCount: index === 0 ? resourceCount : 0,
      annotationCount: index === 0 ? annotationCount : 0,
    }));

    const diagnostics: PdfDiagnostic[] = [];

    if (pageCountEstimate > 1) {
      diagnostics.push({
        code: "shell-page-distribution",
        stage: "ir",
        level: "medium",
        message: "The shell IR exposes per-page placeholders but does not yet map content streams to exact pages.",
      });
    }

    const irBase = {
      kind: "shell",
      byteLength: admission.value.byteLength,
      crossReferenceKind: detectCrossReferenceKind(scanText),
      isEncrypted: admission.value.isEncrypted,
      featureKinds: admission.value.featureSignals.filter((signal) => signal.detected).map((signal) => signal.kind),
      pages,
    } as const;
    const ir: PdfIrDocument = {
      ...irBase,
      ...(admission.value.pdfVersion !== undefined ? { pdfVersion: admission.value.pdfVersion } : {}),
      ...(admission.value.pageCountEstimate !== undefined ? { pageCountEstimate: admission.value.pageCountEstimate } : {}),
      ...(admission.value.objectCountEstimate !== undefined ? { objectCountEstimate: admission.value.objectCountEstimate } : {}),
    };

    return stageResult("ir", diagnostics.length > 0 ? "partial" : "completed", diagnostics, ir);
  }

  async function observe(request: PdfObservationRequest): Promise<PdfStageResult<PdfObservedDocument>> {
    const admissionRequest: PdfAdmissionRequest = {
      source: request.source,
      intent: "text",
      ...(request.policy !== undefined ? { policy: request.policy } : {}),
    };
    const admission = await admit(admissionRequest);

    if (admission.status !== "completed" || !admission.value || admission.value.decision !== "accepted") {
      return stageResult("observation", "blocked", admission.diagnostics);
    }

    const scanText = decodeLatin1(request.source.bytes, admission.value.policy.resourceBudget.maxScanBytes);
    const extractedRuns = extractTextRuns(scanText);
    const diagnostics: PdfDiagnostic[] = [];

    if (admission.value.pageCountEstimate && admission.value.pageCountEstimate > 1) {
      diagnostics.push({
        code: "shell-observation-page-mapping",
        stage: "observation",
        level: "medium",
        message: "The shell observation stage does not yet assign extracted text to exact source pages.",
      });
    }

    if (extractedRuns.length === 0) {
      diagnostics.push({
        code: "shell-observation-empty",
        stage: "observation",
        level: "medium",
        message: "No heuristic text runs were recovered from the current shell observation strategy.",
      });
    }

    const glyphs: PdfObservedGlyph[] = [];
    const runs: PdfObservedTextRun[] = [];
    let contentOrder = 0;

    for (const runText of extractedRuns) {
      const glyphIds: string[] = [];
      const codePoints = Array.from(runText);

      for (const [glyphIndex, text] of codePoints.entries()) {
        const glyphId = `glyph-${runs.length + 1}-${glyphIndex + 1}`;
        glyphIds.push(glyphId);
        glyphs.push({
          id: glyphId,
          pageNumber: 1,
          glyphIndex,
          contentOrder,
          text,
          unicodeCodePoint: text.codePointAt(0) ?? 0,
          hidden: false,
          origin: "heuristic-text",
        });
      }

      runs.push({
        id: `run-${runs.length + 1}`,
        pageNumber: 1,
        contentOrder,
        text: runText,
        glyphIds,
        origin: "heuristic-text",
      });

      contentOrder += 1;
    }

    const page: PdfObservedPage = {
      pageNumber: 1,
      glyphs,
      runs,
    };

    const observation: PdfObservedDocument = {
      kind: "shell",
      extractedText: runs.map((run) => run.text).join("\n"),
      pages: [page],
    };

    return stageResult("observation", diagnostics.length > 0 ? "partial" : "completed", diagnostics, observation);
  }

  async function run(request: PdfPipelineRequest): Promise<PdfPipelineResult> {
    const admission = await admit(request);
    const irRequest: PdfIrRequest = {
      source: request.source,
      ...(request.policy !== undefined ? { policy: request.policy } : {}),
    };
    const observationRequest: PdfObservationRequest = {
      source: request.source,
      ...(request.policy !== undefined ? { policy: request.policy } : {}),
    };
    const ir = await toIr(irRequest);
    const observation = await observe(observationRequest);

    return {
      engine: ENGINE_IDENTITY,
      runtime,
      source: {
        byteLength: request.source.bytes.byteLength,
        ...(request.source.fileName !== undefined ? { fileName: request.source.fileName } : {}),
        ...(request.source.mediaType !== undefined ? { mediaType: request.source.mediaType } : {}),
        ...(request.source.sha256 !== undefined ? { sha256: request.source.sha256 } : {}),
      },
      admission,
      ir,
      observation,
      diagnostics: dedupeDiagnostics([...admission.diagnostics, ...ir.diagnostics, ...observation.diagnostics]),
    };
  }
}

function stageResult<T>(
  stage: PdfStageResult<T>["stage"],
  status: PdfStageResult<T>["status"],
  diagnostics: readonly PdfDiagnostic[],
): PdfStageResult<T>;
function stageResult<T>(
  stage: PdfStageResult<T>["stage"],
  status: PdfStageResult<T>["status"],
  diagnostics: readonly PdfDiagnostic[],
  value: T,
): PdfStageResult<T>;
function stageResult<T>(
  stage: PdfStageResult<T>["stage"],
  status: PdfStageResult<T>["status"],
  diagnostics: readonly PdfDiagnostic[],
  value?: T,
): PdfStageResult<T> {
  const base = {
    stage,
    status,
    diagnostics: dedupeDiagnostics(diagnostics),
  };

  return value === undefined ? base : { ...base, value };
}

function mergePolicy(
  defaults: PdfNormalizedAdmissionPolicy,
  override?: PdfAdmissionPolicy,
): PdfNormalizedAdmissionPolicy {
  return {
    javascriptActions: override?.javascriptActions ?? defaults.javascriptActions,
    launchActions: override?.launchActions ?? defaults.launchActions,
    embeddedFiles: override?.embeddedFiles ?? defaults.embeddedFiles,
    repairMode: override?.repairMode ?? defaults.repairMode,
    passwordPolicy: override?.passwordPolicy ?? defaults.passwordPolicy,
    allowEncryptedMetadata: override?.allowEncryptedMetadata ?? defaults.allowEncryptedMetadata,
    resourceBudget: {
      maxBytes: override?.resourceBudget?.maxBytes ?? defaults.resourceBudget.maxBytes,
      maxPages: override?.resourceBudget?.maxPages ?? defaults.resourceBudget.maxPages,
      maxObjects: override?.resourceBudget?.maxObjects ?? defaults.resourceBudget.maxObjects,
      maxMilliseconds: override?.resourceBudget?.maxMilliseconds ?? defaults.resourceBudget.maxMilliseconds,
      maxRecursionDepth: override?.resourceBudget?.maxRecursionDepth ?? defaults.resourceBudget.maxRecursionDepth,
      maxScanBytes: override?.resourceBudget?.maxScanBytes ?? defaults.resourceBudget.maxScanBytes,
    },
  };
}

function detectRuntime(): PdfRuntimeDescriptor {
  const value = globalThis as typeof globalThis & {
    readonly Bun?: { readonly version?: string };
    readonly Deno?: { readonly version?: { readonly deno?: string } };
    readonly process?: { readonly release?: { readonly name?: string }; readonly versions?: { readonly node?: string } };
  };

  if (typeof value.Deno?.version?.deno === "string") {
    return { kind: "deno", version: value.Deno.version.deno };
  }

  if (typeof value.Bun?.version === "string") {
    return { kind: "bun", version: value.Bun.version };
  }

  if (value.process?.release?.name === "node") {
    return createRuntimeDescriptor("node", value.process.versions?.node);
  }

  if (typeof window !== "undefined") {
    return { kind: "web" };
  }

  return { kind: "unknown" };
}

function createRuntimeDescriptor(kind: PdfRuntimeDescriptor["kind"], version?: string): PdfRuntimeDescriptor {
  return version === undefined ? { kind } : { kind, version };
}

function detectRuntimeCapabilities(runtime: PdfRuntimeDescriptor): PdfRuntimeCapabilities {
  const value = globalThis as typeof globalThis & {
    readonly Deno?: unknown;
    readonly process?: unknown;
    readonly Worker?: unknown;
    readonly performance?: { readonly now?: () => number };
    readonly ReadableStream?: unknown;
  };

  return {
    streams: typeof value.ReadableStream !== "undefined",
    fileSystem: runtime.kind === "node" || runtime.kind === "bun" || runtime.kind === "deno",
    webWorker: typeof value.Worker !== "undefined",
    highResolutionTime: typeof value.performance?.now === "function",
  };
}

function decodeLatin1(bytes: Uint8Array, limit = bytes.byteLength): string {
  return new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(limit, bytes.byteLength)));
}

function readPdfVersion(text: string): string | undefined {
  const match = text.match(/%PDF-(\d\.\d)/);
  return match?.[1];
}

function detectFeatureSignals(text: string, policy: Required<PdfAdmissionPolicy>): PdfFeatureSignal[] {
  return FEATURE_PATTERNS.map((entry) => {
    const detected = entry.pattern.test(text);
    const action = entry.actionKey ? policy[entry.actionKey] : "report";
    return {
      kind: entry.kind,
      action,
      detected,
      message: detected
        ? `Detected ${entry.kind.replaceAll("-", " ")}; policy action is ${action}.`
        : `No ${entry.kind.replaceAll("-", " ")} detected in the scanned shell input.`,
    };
  });
}

function detectCrossReferenceKind(text: string): PdfIrDocument["crossReferenceKind"] {
  const hasClassic = /\nxref[\r\n]/.test(text);
  const hasStream = /\/Type\s*\/XRef\b/.test(text);

  if (hasClassic && hasStream) {
    return "hybrid";
  }
  if (hasStream) {
    return "xref-stream";
  }
  if (hasClassic) {
    return "classic";
  }
  return "unknown";
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _match of text.matchAll(pattern)) {
    count += 1;
  }
  return count;
}

function extractTextRuns(text: string): string[] {
  const directRuns = Array.from(text.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj/g), (match) =>
    decodePdfLiteral(match[0].replace(/\s*Tj$/, "")),
  );

  const arrayRuns = Array.from(text.matchAll(/\[(?:[\s\S]*?)\]\s*TJ/g), (match) => {
    const strings = Array.from(match[0].matchAll(/\((?:\\.|[^\\()])*\)/g), (stringMatch) =>
      decodePdfLiteral(stringMatch[0]),
    );
    return strings.join("");
  });

  return [...directRuns, ...arrayRuns].map((value) => value.trim()).filter((value) => value.length > 0);
}

function decodePdfLiteral(token: string): string {
  const source = token.startsWith("(") && token.endsWith(")") ? token.slice(1, -1) : token;
  let result = "";

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];

    if (current !== "\\") {
      result += current;
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
      result += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    switch (next) {
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "b":
        result += "\b";
        break;
      case "f":
        result += "\f";
        break;
      case "(":
      case ")":
      case "\\":
        result += next;
        break;
      case "\n":
        break;
      case "\r":
        if (source[index + 2] === "\n") {
          index += 1;
        }
        break;
      default:
        result += next;
        break;
    }

    index += 1;
  }

  return result;
}

function dedupeDiagnostics(diagnostics: readonly PdfDiagnostic[]): PdfDiagnostic[] {
  const seen = new Set<string>();
  const unique: PdfDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.stage,
      diagnostic.code,
      diagnostic.level,
      diagnostic.message,
      diagnostic.pageNumber ?? "",
      diagnostic.feature ?? "",
      diagnostic.objectRef?.objectNumber ?? "",
      diagnostic.objectRef?.generationNumber ?? "",
      diagnostic.detail ?? "",
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(diagnostic);
  }

  return unique;
}
