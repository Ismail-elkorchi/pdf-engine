import { buildKnowledgeDocument } from "./knowledge.ts";
import { buildObservedPages } from "./layout/observed.ts";
import { buildLayoutDocument, buildObservationParagraphText } from "./layout.ts";
import { buildPdfDocumentAnalysis } from "./pdf-analysis.ts";
import { PdfBudgetExceededError, PdfBudgetTracker } from "./pdf-budget.ts";
import { buildPdfDocumentModel, type PdfDocumentModel } from "./pdf-document-model.ts";
import { extractPdfAdmissionFindings, extractPdfFeatures } from "./pdf-features.ts";
import { extractPdfImages } from "./pdf-images.ts";
import { PdfObjectStore } from "./pdf-object-store.ts";
import { verifyPdfSignatures } from "./pdf-signatures.ts";
import { createPdfByteSource, loadPdfSource, PdfSourceLimitError, type PdfSourceData } from "./pdf-source.ts";
import { preparePdfStandardPasswordSecurity } from "./pdf-standard-security.ts";
import { PdfStreamDecodeError } from "./pdf-stream.ts";
import { PdfSyntaxError } from "./pdf-syntax.ts";
import { formatPdfValue } from "./pdf-value-format.ts";
import { pdfDictionaryGet } from "./pdf-values.ts";

import type {
  PdfDiagnostic,
  PdfKnowledgeDocument,
  PdfLayoutDocument,
  PdfObservedDocument,
  PdfPolicyAction,
  PdfRuntimeCapabilities,
  PdfRuntimeDescriptor,
} from "./contracts.ts";
import type { PdfIndirectObject, PdfReference, PdfValue } from "./pdf-values.ts";
import type {
  PdfAttachmentPayload,
  PdfContentChannel,
  PdfDocument,
  PdfDocumentFeatures,
  PdfDocumentPermissions,
  PdfEngine,
  PdfEngineIdentity,
  PdfEngineOptions,
  PdfExtractOptions,
  PdfImageOptions,
  PdfImages,
  PdfKnowledgeOptions,
  PdfLayoutOptions,
  PdfNormalizedPolicy,
  PdfOpenRequest,
  PdfOperationOptions,
  PdfPageSelection,
  PdfPolicy,
  PdfReadFragment,
  PdfReadRequest,
  PdfReadResult,
  PdfResourceBudget,
  PdfResult,
  PdfSearchMatch,
  PdfSearchRequest,
  PdfSearchResults,
  PdfSignatureVerification,
  PdfSignatureVerificationRequest,
  PdfSourceDescriptor,
  PdfStreamPayload,
  PdfStreamRequest,
  PdfStructureSummary,
  PdfFormField,
} from "./public-api.ts";

const ENGINE_IDENTITY: PdfEngineIdentity = {
  name: "@ismail-elkorchi/pdf-engine",
  version: "0.1.0",
  mode: "read",
  supportedRuntimes: ["node", "deno", "bun", "web"],
};

const DEFAULT_POLICY: PdfNormalizedPolicy = {
  javascriptActions: "deny",
  launchActions: "deny",
  embeddedFiles: "report",
  repairMode: "safe",
  passwordPolicy: "known-only",
  enforcePermissions: true,
  resourceBudget: {
    maxBytes: 64_000_000,
    maxPages: 10_000,
    maxObjects: 2_000_000,
    maxRecursionDepth: 64,
    maxDecodedBytes: 256_000_000,
    maxOperators: 10_000_000,
    maxImagePixels: 250_000_000,
    maxCacheBytes: 256_000_000,
  },
};

export function createPdfEngine(options: PdfEngineOptions = {}): PdfEngine {
  const defaultPolicy = mergePolicy(DEFAULT_POLICY, options.defaultPolicy);
  const runtime = detectRuntime();
  const capabilities = detectRuntimeCapabilities(runtime);
  const documents = new Set<PdfDocumentSession>();
  let disposed = false;

  return {
    identity: ENGINE_IDENTITY,
    runtime,
    capabilities,
    defaultPolicy,
    open,
    dispose,
  };

  async function open(request: PdfOpenRequest): Promise<PdfResult<PdfDocument>> {
    if (disposed) {
      throw new Error("The PDF engine has been disposed.");
    }
    const diagnostics: PdfDiagnostic[] = [];
    try {
      throwIfAborted(request.signal);
      const policy = mergePolicy(defaultPolicy, request.policy);
      const source = createPdfByteSource(request.source);
      const data = await loadPdfSource(source, policy.resourceBudget.maxBytes, request.signal);
      const budget = new PdfBudgetTracker(policy.resourceBudget);
      const { store } = await PdfObjectStore.open(data, budget, policy.repairMode);
      if (store.encrypt !== undefined) {
        const unlock = await unlockStore(store, request, source.descriptor, policy.passwordPolicy);
        diagnostics.push(...unlock.diagnostics);
        if (unlock.status !== "completed") {
          return { status: unlock.status, diagnostics };
        }
      }
      const model = await buildPdfDocumentModel(store, policy.repairMode);
      const document = new PdfDocumentSession(
        source.descriptor,
        data,
        store,
        model,
        policy,
        () => documents.delete(document),
      );
      const admissionFindings = await extractPdfAdmissionFindings(store, model, policy);
      const denied = admissionFindings.filter((finding) => finding.action === "deny");
      if (denied.length > 0) {
        await document.dispose();
        return {
          status: "blocked",
          diagnostics: denied.map((finding) => diagnostic(
            `policy-${finding.kind}-denied`,
            "admission",
            "high",
            finding.message,
            finding.objectRef === undefined ? {} : { objectRef: finding.objectRef },
          )),
        };
      }
      documents.add(document);
      return {
        status: document.summary.repaired ? "partial" : "completed",
        value: document,
        diagnostics: document.summary.repaired
          ? [diagnostic("structure-repaired", "ir", "medium", "The document was opened using bounded structural repair.")]
          : [],
      };
    } catch (error: unknown) {
      return failureResult(error, diagnostics);
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      return;
    }
    disposed = true;
    await Promise.all([...documents].map(async (document) => document.dispose()));
    documents.clear();
  }
}

interface PdfObservationProduct {
  readonly value: PdfObservedDocument;
  readonly diagnostics: readonly PdfDiagnostic[];
}

class PdfDocumentSession implements PdfDocument {
  readonly source: PdfSourceDescriptor;
  readonly permissions: PdfDocumentPermissions;
  readonly #data: PdfSourceData;
  readonly #store: PdfObjectStore;
  readonly #model: PdfDocumentModel;
  readonly #policy: PdfNormalizedPolicy;
  readonly #onDispose: () => void;
  #disposed = false;
  #featuresPromise: Promise<PdfDocumentFeatures> | undefined;
  readonly #observationPromises = new Map<string, Promise<PdfObservationProduct>>();
  #layoutPromise: Promise<PdfLayoutDocument> | undefined;
  #knowledgePromise: Promise<PdfKnowledgeDocument> | undefined;
  readonly #imagesPromises = new Map<string, Promise<PdfImages>>();

  constructor(
    source: PdfSourceDescriptor,
    data: PdfSourceData,
    store: PdfObjectStore,
    model: PdfDocumentModel,
    policy: PdfNormalizedPolicy,
    onDispose: () => void,
  ) {
    this.source = source;
    this.#data = data;
    this.#store = store;
    this.#model = model;
    this.#policy = policy;
    this.#onDispose = onDispose;
    this.permissions = resolveDocumentPermissions(store);
  }

  get summary(): PdfStructureSummary {
    return {
      pdfVersion: this.#store.version,
      byteLength: this.#data.byteLength,
      pageCount: this.#model.pages.length,
      objectCount: this.#store.objectCount,
      revisionCount: this.#store.sections.length,
      encrypted: this.#store.encrypt !== undefined,
      repaired: this.#store.repaired || this.#model.repaired,
      root: this.#store.root,
      trailer: this.#store.trailer,
    };
  }

  structure(options: PdfOperationOptions = {}): Promise<PdfResult<PdfStructureSummary>> {
    return this.#run(options.signal, () => this.summary);
  }

  object(request: { readonly ref: PdfReference; readonly signal?: AbortSignal }): Promise<PdfResult<PdfIndirectObject>> {
    return this.#run(request.signal, async () => {
      this.#assertCopyAllowed();
      const object = await this.#store.get(request.ref);
      if (object === undefined) {
        throw new PdfSyntaxError("Requested object does not exist", 0);
      }
      return object;
    });
  }

  stream(request: PdfStreamRequest): Promise<PdfResult<PdfStreamPayload>> {
    return this.#run(request.signal, async () => {
      this.#assertCopyAllowed();
      const object = await this.#store.require(request.ref);
      if (object.stream === undefined) {
        throw new PdfSyntaxError("Requested object has no stream", object.source.start);
      }
      const filterValue = pdfDictionaryGet(object.stream.dictionary, "Filter");
      const filters = filterValue === undefined ? [] : readFilterNames(filterValue);
      if (request.decode === false) {
        return {
          ref: request.ref,
          dictionary: object.stream.dictionary,
          bytes: Uint8Array.from(await this.#store.encodedStream(request.ref) ?? object.stream.rawBytes),
          decoded: false,
          filters,
          source: object.stream.dataSource,
        };
      }
      const decoded = await this.#store.decodeStream(request.ref);
      if (decoded === undefined) {
        throw new PdfSyntaxError("Requested stream could not be decoded", object.source.start);
      }
      return {
        ref: request.ref,
        dictionary: object.stream.dictionary,
        bytes: Uint8Array.from(decoded.bytes),
        decoded: decoded.decoded,
        filters: decoded.filters,
        source: object.stream.dataSource,
      };
    });
  }

  features(options: PdfOperationOptions = {}): Promise<PdfResult<PdfDocumentFeatures>> {
    return this.#run(options.signal, async () => {
      this.#featuresPromise ??= extractPdfFeatures(this.#store, this.#model, this.#policy);
      const features = await this.#featuresPromise;
      if (options.pages === undefined || options.pages.kind === "all") {
        return features;
      }
      const pages = selectedPageNumbers(options.pages, this.summary.pageCount);
      return {
        ...features,
        namedDestinations: features.namedDestinations.filter((item) =>
          item.destination.pageNumber === undefined || pages.has(item.destination.pageNumber)
        ),
        pageLabels: features.pageLabels.filter((label) => pages.has(label.pageNumber)),
        structureTree: filterStructureElements(features.structureTree, pages),
        annotations: features.annotations.filter((annotation) => pages.has(annotation.pageNumber)),
      };
    });
  }

  extract(options: PdfExtractOptions = {}): Promise<PdfResult<PdfObservedDocument>> {
    let diagnostics: readonly PdfDiagnostic[] = [];
    return this.#run(options.signal, async () => {
      this.#assertChannelsAllowed(options.channels);
      const observation = await this.#observation(options.pages);
      diagnostics = observation.diagnostics;
      return observation.value;
    }, () => diagnostics);
  }

  layout(options: PdfLayoutOptions = {}): Promise<PdfResult<PdfLayoutDocument>> {
    let diagnostics: readonly PdfDiagnostic[] = [];
    return this.#run(options.signal, async () => {
      this.#assertChannelsAllowed(options.channels);
      const observation = await this.#observation(options.pages);
      diagnostics = observation.diagnostics;
      if (options.pages === undefined || options.pages.kind === "all") {
        this.#layoutPromise ??= Promise.resolve(buildLayoutDocument(observation.value));
        return this.#layoutPromise;
      }
      return buildLayoutDocument(observation.value);
    }, () => diagnostics);
  }

  knowledge(options: PdfKnowledgeOptions = {}): Promise<PdfResult<PdfKnowledgeDocument>> {
    let diagnostics: readonly PdfDiagnostic[] = [];
    return this.#run(options.signal, async () => {
      this.#assertChannelsAllowed(options.channels);
      const observation = await this.#observation(options.pages);
      diagnostics = observation.diagnostics;
      if (options.pages === undefined || options.pages.kind === "all") {
        this.#layoutPromise ??= Promise.resolve(buildLayoutDocument(observation.value));
        this.#knowledgePromise ??= this.#layoutPromise.then((layout) =>
          buildKnowledgeDocument(layout, observation.value)
        );
        return this.#knowledgePromise;
      }
      return buildKnowledgeDocument(buildLayoutDocument(observation.value), observation.value);
    }, () => diagnostics);
  }

  images(options: PdfImageOptions = {}): Promise<PdfResult<PdfImages>> {
    let diagnostics: readonly PdfDiagnostic[] = [];
    return this.#run(options.signal, async () => {
      this.#assertCopyAllowed();
      const selectedPages = selectedPageNumbers(options.pages, this.summary.pageCount);
      const observation = await this.#observation(options.pages);
      diagnostics = observation.diagnostics;
      const cacheKey = `${options.includeBytes === true ? "bytes" : "metadata"}:${pageSelectionKey(options.pages, selectedPages)}`;
      let images = this.#imagesPromises.get(cacheKey);
      if (images === undefined) {
        images = extractPdfImages(this.#store, this.#model, observation.value, options);
        this.#imagesPromises.set(cacheKey, images);
      }
      return images;
    }, () => diagnostics);
  }

  search(request: PdfSearchRequest): Promise<PdfResult<PdfSearchResults>> {
    let diagnostics: readonly PdfDiagnostic[] = [];
    return this.#run(request.signal, async () => {
      this.#assertChannelsAllowed(request.channels);
      if (request.query.length === 0) {
        throw new TypeError("Search query must not be empty.");
      }
      const observation = await this.#observation(request.pages);
      diagnostics = observation.diagnostics;
      const fragments = await this.#fragments(observation.value, request.channels);
      const query = request.caseSensitive === true
        ? request.query
        : normalizeSearchText(request.query);
      const limit = normalizeLimit(request.limit, 100);
      const matches: PdfSearchMatch[] = [];
      let truncated = false;
      for (const fragment of fragments) {
        const haystack = request.caseSensitive === true
          ? identitySearchText(fragment.text)
          : normalizeSearchFragment(fragment.text);
        for (const normalizedMatch of findMatches(haystack.text, query, request.mode ?? "literal")) {
          if (matches.length >= limit) {
            truncated = true;
            break;
          }
          const match = mapSearchMatch(haystack, normalizedMatch);
          matches.push({
            id: `search-${fragment.id}-${String(match.start)}-${String(match.end)}`,
            ...(fragment.pageNumber !== undefined ? { pageNumber: fragment.pageNumber } : {}),
            channel: fragment.channel,
            text: fragment.text.slice(match.start, match.end),
            start: match.start,
            end: match.end,
            ...(fragment.bounds !== undefined ? { bounds: fragment.bounds } : {}),
            ...(fragment.objectRef !== undefined ? { objectRef: fragment.objectRef } : {}),
            ...(fragment.contentStreamRef !== undefined ? { contentStreamRef: fragment.contentStreamRef } : {}),
          });
        }
        if (truncated) {
          break;
        }
      }
      return { query: request.query, matches, truncated };
    }, () => diagnostics);
  }

  read(request: PdfReadRequest): Promise<PdfResult<PdfReadResult>> {
    let diagnostics: readonly PdfDiagnostic[] = [];
    return this.#run(request.signal, async () => {
      this.#assertChannelsAllowed(request.channels);
      if (!Number.isSafeInteger(request.maxCharacters) || request.maxCharacters <= 0) {
        throw new TypeError("maxCharacters must be a positive safe integer.");
      }
      const elementIds = request.elementIds === undefined ? undefined : new Set(request.elementIds);
      const observation = await this.#observation(request.pages);
      diagnostics = observation.diagnostics;
      const fragments = (await this.#fragments(observation.value, request.channels))
        .filter((fragment) => elementIds === undefined || elementIds.has(fragment.id));
      const selected: PdfReadFragment[] = [];
      let count = 0;
      let nextCursor: PdfReadResult["nextCursor"];
      const startIndex = request.cursor === undefined
        ? 0
        : fragments.findIndex((fragment) =>
          fragment.id === request.cursor?.fragmentId && fragment.pageNumber === request.cursor.pageNumber
        );
      if (startIndex < 0) {
        throw new TypeError("Read cursor does not identify a selected fragment.");
      }
      const initialOffset = request.cursor?.characterOffset ?? 0;
      if (
        !Number.isSafeInteger(initialOffset) ||
        initialOffset < 0 ||
        initialOffset > (fragments[startIndex]?.text.length ?? 0)
      ) {
        throw new TypeError("Read cursor characterOffset is outside its fragment.");
      }
      for (let index = startIndex; index < fragments.length; index += 1) {
        const fragment = fragments[index];
        if (fragment === undefined) {
          continue;
        }
        const offset = index === startIndex ? initialOffset : 0;
        const remaining = request.maxCharacters - count;
        if (remaining <= 0) {
          nextCursor = {
            ...(fragment.pageNumber !== undefined ? { pageNumber: fragment.pageNumber } : {}),
            fragmentId: fragment.id,
            characterOffset: offset,
          };
          break;
        }
        const text = fragment.text.slice(offset, offset + remaining);
        if (text.length > 0) {
          selected.push({ ...fragment, text });
          count += text.length;
        }
        if (offset + text.length < fragment.text.length) {
          nextCursor = {
            ...(fragment.pageNumber !== undefined ? { pageNumber: fragment.pageNumber } : {}),
            fragmentId: fragment.id,
            characterOffset: offset + text.length,
          };
          break;
        }
        const following = fragments[index + 1];
        if (count === request.maxCharacters && following !== undefined) {
          nextCursor = {
            ...(following.pageNumber !== undefined ? { pageNumber: following.pageNumber } : {}),
            fragmentId: following.id,
            characterOffset: 0,
          };
          break;
        }
      }
      return {
        fragments: selected,
        characterCount: count,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    }, () => diagnostics);
  }

  attachment(request: { readonly id: string; readonly signal?: AbortSignal }): Promise<PdfResult<PdfAttachmentPayload>> {
    return this.#run(request.signal, async () => {
      this.#assertCopyAllowed();
      if (this.#policy.embeddedFiles === "deny") {
        throw new PdfPolicyBlockedError("Embedded-file extraction is denied by policy.");
      }
      const features = await this.#featureCatalog();
      const attachment = features.attachments.find((item) => item.id === request.id);
      if (attachment === undefined) {
        throw new PdfSyntaxError("Requested attachment does not exist", 0);
      }
      const stream = await this.#store.decodeStream(attachment.objectRef);
      if (stream === undefined) {
        throw new PdfSyntaxError("Attachment stream could not be decoded", 0);
      }
      return { attachment, bytes: Uint8Array.from(stream.bytes) };
    });
  }

  verifySignatures(request: PdfSignatureVerificationRequest): Promise<PdfResult<readonly PdfSignatureVerification[]>> {
    return this.#run(request.signal, async () => {
      if (!(request.trustPolicy.validationTime instanceof Date) || Number.isNaN(request.trustPolicy.validationTime.valueOf())) {
        throw new TypeError("Signature validationTime must be a valid Date.");
      }
      const features = await this.#featureCatalog();
      const bytes = await this.#data.materialize(request.signal);
      return verifyPdfSignatures(bytes, this.#store, features.signatures, request);
    });
  }

  dispose(): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }
    this.#disposed = true;
    this.#featuresPromise = undefined;
    this.#observationPromises.clear();
    this.#layoutPromise = undefined;
    this.#knowledgePromise = undefined;
    this.#imagesPromises.clear();
    this.#onDispose();
    return Promise.resolve();
  }

  async #buildObservation(pageNumbers?: ReadonlySet<number>): Promise<PdfObservationProduct> {
    const diagnostics: PdfDiagnostic[] = [];
    const analysis = await buildPdfDocumentAnalysis(this.#store, this.#model, {
      ...(pageNumbers !== undefined ? { pageNumbers } : {}),
    });
    const observed = buildObservedPages({ analysis, featureFindings: [] }, diagnostics);
    if (observed.hasFontMappingGap) {
      diagnostics.push(diagnostic(
        "native-text-unicode-mapping-incomplete",
        "observation",
        "medium",
        "Some native text codes could not be mapped to Unicode without guessing.",
      ));
    }
    if (observed.hasLiteralFontEncodingGap) {
      diagnostics.push(diagnostic(
        "native-text-encoding-incomplete",
        "observation",
        "medium",
        "Some native literal text bytes could not be mapped through the declared font encoding.",
      ));
    }
    const base: PdfObservedDocument = {
      kind: "pdf-observation",
      strategy: "content-stream-interpreter",
      extractedText: "",
      pages: observed.pages,
      knownLimits: [
        ...(observed.hasFontMappingGap ? ["native-text-unicode-mapping-incomplete" as const] : []),
        ...(observed.hasLiteralFontEncodingGap ? ["native-text-encoding-incomplete" as const] : []),
      ],
    };
    const observation: PdfObservedDocument = {
      ...base,
      extractedText: buildObservationParagraphText(base),
    };
    return { value: observation, diagnostics };
  }

  async #observation(selection?: PdfPageSelection): Promise<PdfObservationProduct> {
    const pageNumbers = selection === undefined || selection.kind === "all"
      ? undefined
      : selectedPageNumbers(selection, this.summary.pageCount);
    const key = pageSelectionKey(selection, pageNumbers);
    let observation = this.#observationPromises.get(key);
    if (observation === undefined) {
      observation = this.#buildObservation(pageNumbers);
      this.#observationPromises.set(key, observation);
    }
    return observation;
  }

  async #featureCatalog(): Promise<PdfDocumentFeatures> {
    this.#featuresPromise ??= extractPdfFeatures(this.#store, this.#model, this.#policy);
    return this.#featuresPromise;
  }

  async #fragments(
    observation: PdfObservedDocument,
    channels: readonly PdfContentChannel[] | undefined,
  ): Promise<readonly PdfReadFragment[]> {
    const selectedChannels = new Set<PdfContentChannel>(channels ?? ["visible", "accessibility"]);
    const selectedPages = new Set(observation.pages.map((page) => page.pageNumber));
    const fragments: PdfReadFragment[] = [];
    for (const page of observation.pages) {
      if (!selectedPages.has(page.pageNumber)) {
        continue;
      }
      for (const mark of page.marks) {
        if (mark.kind !== "text") {
          continue;
        }
        const channel: PdfContentChannel = mark.visibilityState === "hidden" || mark.hiddenTextCandidate === true
          ? "hidden"
          : "visible";
        if (selectedChannels.has(channel)) {
          fragments.push({
            id: mark.id,
            pageNumber: page.pageNumber,
            channel,
            text: mark.text,
            ...(mark.bbox !== undefined ? { bounds: mark.bbox } : {}),
            ...(mark.objectRef !== undefined ? { objectRef: mark.objectRef } : {}),
            ...(mark.contentStreamRef !== undefined ? { contentStreamRef: mark.contentStreamRef } : {}),
          });
        }
        if (mark.actualText !== undefined && selectedChannels.has("accessibility")) {
          fragments.push({
            id: `${mark.id}-actual-text`,
            pageNumber: page.pageNumber,
            channel: "accessibility",
            text: mark.actualText,
            ...(mark.bbox !== undefined ? { bounds: mark.bbox } : {}),
            ...(mark.objectRef !== undefined ? { objectRef: mark.objectRef } : {}),
            ...(mark.contentStreamRef !== undefined ? { contentStreamRef: mark.contentStreamRef } : {}),
          });
        }
      }
    }
    const features = await this.#featureCatalog();
    if (selectedChannels.has("accessibility")) {
      fragments.push(...flattenStructureFragments(features.structureTree, selectedPages));
    }
    if (selectedChannels.has("annotation")) {
      fragments.push(...features.annotations.flatMap((annotation) =>
        annotation.contents === undefined || !selectedPages.has(annotation.pageNumber) ? [] : [{
          id: annotation.id,
          pageNumber: annotation.pageNumber,
          channel: "annotation" as const,
          text: annotation.contents,
          ...(annotation.bounds !== undefined ? { bounds: annotation.bounds } : {}),
          ...(annotation.objectRef !== undefined ? { objectRef: annotation.objectRef } : {}),
        }]
      ));
    }
    if (selectedChannels.has("form-value")) {
      fragments.push(...flattenFormFragments(features.formFields));
    }
    if (selectedChannels.has("metadata")) {
      fragments.push(...metadataFragments(features));
    }
    if (selectedChannels.has("attachment")) {
      fragments.push(...features.attachments.map((attachment) => ({
        id: `${attachment.id}-description`,
        channel: "attachment" as const,
        text: attachment.description === undefined ? attachment.name : `${attachment.name}: ${attachment.description}`,
        objectRef: attachment.objectRef,
      })));
    }
    if (selectedChannels.has("script")) {
      fragments.push(...features.activeContent.flatMap((item) => item.payload === undefined ? [] : [{
        id: `${item.id}-payload`,
        channel: "script" as const,
        text: new TextDecoder().decode(item.payload),
        ...(item.objectRef !== undefined ? { objectRef: item.objectRef } : {}),
      }]));
    }
    return fragments.toSorted((left, right) =>
      (left.pageNumber ?? 0) - (right.pageNumber ?? 0) || left.id.localeCompare(right.id)
    );
  }

  async #run<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T> | T,
    diagnosticsForResult: () => readonly PdfDiagnostic[] = () => [],
  ): Promise<PdfResult<T>> {
    if (this.#disposed) {
      throw new Error("The PDF document session has been disposed.");
    }
    try {
      throwIfAborted(signal);
      const value = await operation();
      throwIfAborted(signal);
      const diagnostics = diagnosticsForResult();
      return diagnostics.length === 0
        ? { status: "completed", value, diagnostics }
        : { status: "partial", value, diagnostics };
    } catch (error: unknown) {
      return failureResult(error, diagnosticsForResult());
    }
  }

  #assertChannelsAllowed(channels: readonly PdfContentChannel[] | undefined): void {
    if (!this.#policy.enforcePermissions || this.permissions.credential !== "user") {
      return;
    }
    const selected = channels ?? ["visible", "accessibility"];
    if (selected.every((channel) => channel === "accessibility") && this.permissions.accessibility) {
      return;
    }
    this.#assertCopyAllowed();
  }

  #assertCopyAllowed(): void {
    if (
      this.#policy.enforcePermissions &&
      this.permissions.credential === "user" &&
      !this.permissions.copy
    ) {
      throw new PdfPolicyBlockedError("Document permissions prohibit content extraction.");
    }
  }
}

class PdfPolicyBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfPolicyBlockedError";
  }
}

async function unlockStore(
  store: PdfObjectStore,
  request: PdfOpenRequest,
  source: PdfSourceDescriptor,
  passwordPolicy: PdfNormalizedPolicy["passwordPolicy"],
): Promise<{
  readonly status: "completed" | "blocked" | "failed";
  readonly diagnostics: readonly PdfDiagnostic[];
}> {
  const encryptRef = store.encrypt;
  if (encryptRef === undefined) {
    return { status: "completed", diagnostics: [] };
  }
  if (passwordPolicy === "forbid") {
    return {
      status: "blocked",
      diagnostics: [diagnostic(
        "encrypted-document-denied",
        "admission",
        "high",
        "Encrypted documents are denied by the password policy.",
        { objectRef: encryptRef },
      )],
    };
  }
  const encryptObject = await store.require(encryptRef);
  const documentId = store.documentId;
  if (encryptObject.value.kind !== "dictionary" || documentId === undefined) {
    return {
      status: "failed",
      diagnostics: [diagnostic(
        "encryption-dictionary-invalid",
        "ir",
        "high",
        "The encryption dictionary or document identifier is missing.",
        { objectRef: encryptRef },
      )],
    };
  }
  const entries = new Map(
    encryptObject.value.entries.map((entry) => [entry.key.value, formatPdfValue(entry.value)] as const),
  );
  const tryPassword = async (password: string) => preparePdfStandardPasswordSecurity({
    documentId,
    encryptDictionaryEntries: entries,
    encryptObjectRef: encryptRef,
    password,
  });
  const emptyPassword = await tryPassword("");
  if (emptyPassword.status === "decrypted") {
    store.configureSecurity(emptyPassword.handler);
    return { status: "completed", diagnostics: [] };
  }
  if (emptyPassword.status === "unsupported") {
    return {
      status: "failed",
      diagnostics: [diagnostic(
        "encryption-handler-unsupported",
        "ir",
        "high",
        emptyPassword.detail,
        { objectRef: encryptRef },
      )],
    };
  }
  if (request.passwordProvider === undefined) {
    return {
      status: "blocked",
      diagnostics: [diagnostic(
        "password-required",
        "admission",
        "high",
        "The document requires a password.",
        { objectRef: encryptRef },
      )],
    };
  }
  for (let attempts = 0; attempts < 3; attempts += 1) {
    throwIfAborted(request.signal);
    const password = await request.passwordProvider({
      reason: "document-encrypted",
      source,
      attempts,
    });
    if (password === null) {
      return {
        status: "blocked",
        diagnostics: [diagnostic("password-required", "admission", "high", "Password entry was cancelled.", { objectRef: encryptRef })],
      };
    }
    const preparation = await tryPassword(password);
    if (preparation.status === "decrypted") {
      store.configureSecurity(preparation.handler);
      return { status: "completed", diagnostics: [] };
    }
    if (preparation.status === "unsupported") {
      return {
        status: "failed",
        diagnostics: [diagnostic("encryption-handler-unsupported", "ir", "high", preparation.detail, { objectRef: encryptRef })],
      };
    }
  }
  return {
    status: "blocked",
    diagnostics: [diagnostic("password-invalid", "admission", "high", "The password was rejected after three attempts.", { objectRef: encryptRef })],
  };
}

function resolveDocumentPermissions(store: PdfObjectStore): PdfDocumentPermissions {
  const handler = store.securityHandler;
  if (handler === undefined) {
    return {
      credential: "none",
      copy: true,
      accessibility: true,
      annotate: true,
      fillForms: true,
      assemble: true,
      modify: true,
      print: "high-resolution",
    };
  }
  if (handler.credential === "owner") {
    return {
      credential: "owner",
      copy: true,
      accessibility: true,
      annotate: true,
      fillForms: true,
      assemble: true,
      modify: true,
      print: "high-resolution",
    };
  }
  const allowed = (bit: number): boolean => (handler.permissions & (1 << (bit - 1))) !== 0;
  return {
    credential: "user",
    copy: allowed(5),
    accessibility: allowed(10),
    annotate: allowed(6),
    fillForms: allowed(9),
    assemble: allowed(11),
    modify: allowed(4),
    print: allowed(12) ? "high-resolution" : allowed(3) ? "low-resolution" : "none",
  };
}

function mergePolicy(defaults: PdfNormalizedPolicy, override: PdfPolicy | undefined): PdfNormalizedPolicy {
  return {
    javascriptActions: policyAction(override?.javascriptActions, defaults.javascriptActions, "javascriptActions"),
    launchActions: policyAction(override?.launchActions, defaults.launchActions, "launchActions"),
    embeddedFiles: policyAction(override?.embeddedFiles, defaults.embeddedFiles, "embeddedFiles"),
    repairMode: repairMode(override?.repairMode, defaults.repairMode),
    passwordPolicy: passwordPolicy(override?.passwordPolicy, defaults.passwordPolicy),
    enforcePermissions: booleanOption(override?.enforcePermissions, defaults.enforcePermissions, "enforcePermissions"),
    resourceBudget: mergeBudget(defaults.resourceBudget, override?.resourceBudget),
  };
}

function mergeBudget(
  defaults: PdfNormalizedPolicy["resourceBudget"],
  override: PdfResourceBudget | undefined,
): PdfNormalizedPolicy["resourceBudget"] {
  return {
    maxBytes: positiveInteger(override?.maxBytes, defaults.maxBytes, "maxBytes"),
    maxPages: positiveInteger(override?.maxPages, defaults.maxPages, "maxPages"),
    maxObjects: positiveInteger(override?.maxObjects, defaults.maxObjects, "maxObjects"),
    maxRecursionDepth: positiveInteger(override?.maxRecursionDepth, defaults.maxRecursionDepth, "maxRecursionDepth"),
    maxDecodedBytes: positiveInteger(override?.maxDecodedBytes, defaults.maxDecodedBytes, "maxDecodedBytes"),
    maxOperators: positiveInteger(override?.maxOperators, defaults.maxOperators, "maxOperators"),
    maxImagePixels: positiveInteger(override?.maxImagePixels, defaults.maxImagePixels, "maxImagePixels"),
    maxCacheBytes: positiveInteger(override?.maxCacheBytes, defaults.maxCacheBytes, "maxCacheBytes"),
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Policy resourceBudget.${name} must be a positive safe integer.`);
  }
  return value;
}

function policyAction(value: PdfPolicyAction | undefined, fallback: PdfPolicyAction, name: string): PdfPolicyAction {
  if (value === undefined) {
    return fallback;
  }
  if (value !== "allow" && value !== "report" && value !== "deny") {
    throw new TypeError(`Policy ${name} must be allow, report, or deny.`);
  }
  return value;
}

function repairMode(value: PdfPolicy["repairMode"], fallback: PdfNormalizedPolicy["repairMode"]): PdfNormalizedPolicy["repairMode"] {
  if (value === undefined) {
    return fallback;
  }
  if (value !== "strict" && value !== "safe") {
    throw new TypeError("Policy repairMode must be strict or safe.");
  }
  return value;
}

function passwordPolicy(
  value: PdfPolicy["passwordPolicy"],
  fallback: PdfNormalizedPolicy["passwordPolicy"],
): PdfNormalizedPolicy["passwordPolicy"] {
  if (value === undefined) {
    return fallback;
  }
  if (value !== "forbid" && value !== "known-only" && value !== "interactive") {
    throw new TypeError("Policy passwordPolicy must be forbid, known-only, or interactive.");
  }
  return value;
}

function booleanOption(value: boolean | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`Policy ${name} must be boolean.`);
  }
  return value;
}

function filterStructureElements(
  elements: PdfDocumentFeatures["structureTree"],
  selectedPages: ReadonlySet<number>,
): PdfDocumentFeatures["structureTree"] {
  return elements.flatMap((element) => {
    const children = filterStructureElements(element.children, selectedPages);
    if (
      element.pageNumber !== undefined &&
      !selectedPages.has(element.pageNumber) &&
      children.length === 0
    ) {
      return [];
    }
    return [{ ...element, children }];
  });
}

function selectedPageNumbers(selection: PdfPageSelection | undefined, pageCount: number): ReadonlySet<number> {
  if (selection === undefined || selection.kind === "all") {
    return new Set(Array.from({ length: pageCount }, (_, index) => index + 1));
  }
  if (selection.kind === "range") {
    if (
      !Number.isSafeInteger(selection.from) ||
      !Number.isSafeInteger(selection.to) ||
      selection.from < 1 ||
      selection.to < selection.from ||
      selection.to > pageCount
    ) {
      throw new TypeError("Page range must contain positive ordered safe integers.");
    }
    return new Set(Array.from({ length: selection.to - selection.from + 1 }, (_, index) => selection.from + index));
  }
  const pages = new Set<number>();
  for (const page of selection.pages) {
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      throw new TypeError(`Page number ${String(page)} is outside the document.`);
    }
    pages.add(page);
  }
  return pages;
}

function pageSelectionKey(
  selection: PdfPageSelection | undefined,
  pages: ReadonlySet<number> | undefined,
): string {
  if (selection === undefined || selection.kind === "all") {
    return "all";
  }
  return [...(pages ?? [])].toSorted((left, right) => left - right).join(",");
}

function readFilterNames(value: PdfValue): readonly string[] {
  if (value.kind === "name") {
    return [value.value];
  }
  if (value.kind === "array") {
    return value.items.flatMap((item) => item.kind === "name" ? [item.value] : []);
  }
  return [formatPdfValue(value)];
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

interface SearchTextMapping {
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

function identitySearchText(value: string): SearchTextMapping {
  return {
    text: value,
    starts: Array.from({ length: value.length }, (_, index) => index),
    ends: Array.from({ length: value.length }, (_, index) => index + 1),
  };
}

function normalizeSearchFragment(value: string): SearchTextMapping {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const cluster of searchClusters(value)) {
    const normalized = normalizeSearchText(cluster.text);
    text += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      starts.push(cluster.start);
      ends.push(cluster.end);
    }
  }
  return { text, starts, ends };
}

function searchClusters(value: string): readonly { readonly text: string; readonly start: number; readonly end: number }[] {
  const clusters: { text: string; start: number; end: number }[] = [];
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) {
      break;
    }
    const start = offset;
    offset += codePoint > 0xffff ? 2 : 1;
    while (offset < value.length) {
      const following = value.codePointAt(offset);
      if (following === undefined) {
        break;
      }
      const character = String.fromCodePoint(following);
      if (!/\p{M}/u.test(character) && following !== 0xfe0e && following !== 0xfe0f) {
        break;
      }
      offset += following > 0xffff ? 2 : 1;
    }
    clusters.push({ text: value.slice(start, offset), start, end: offset });
  }
  return clusters;
}

function mapSearchMatch(
  mapping: SearchTextMapping,
  match: { readonly start: number; readonly end: number },
): { readonly start: number; readonly end: number } {
  return {
    start: mapping.starts[match.start] ?? match.start,
    end: mapping.ends[match.end - 1] ?? match.end,
  };
}

function findMatches(
  text: string,
  query: string,
  mode: "literal" | "word",
): readonly { readonly start: number; readonly end: number }[] {
  const matches: { start: number; end: number }[] = [];
  let cursor = 0;
  while (cursor <= text.length - query.length) {
    const index = text.indexOf(query, cursor);
    if (index < 0) {
      break;
    }
    const end = index + query.length;
    if (mode === "literal" || (isWordBoundary(text[index - 1]) && isWordBoundary(text[end]))) {
      matches.push({ start: index, end });
    }
    cursor = Math.max(end, index + 1);
  }
  return matches;
}

function isWordBoundary(character: string | undefined): boolean {
  return character === undefined || !/[\p{L}\p{N}\p{M}_]/u.test(character);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Search limit must be a positive safe integer.");
  }
  return value;
}

function flattenFormFragments(fields: readonly PdfFormField[]): readonly PdfReadFragment[] {
  return fields.flatMap((field) => {
    const value = typeof field.value === "string" ? field.value : field.value?.join("\n");
    const own = value === undefined ? [] : [{
      id: field.id,
      channel: "form-value" as const,
      text: field.name === undefined ? value : `${field.name}: ${value}`,
      ...(field.objectRef !== undefined ? { objectRef: field.objectRef } : {}),
    }];
    return [...own, ...flattenFormFragments(field.children)];
  });
}

function flattenStructureFragments(
  elements: PdfDocumentFeatures["structureTree"],
  selectedPages: ReadonlySet<number>,
): readonly PdfReadFragment[] {
  return elements.flatMap((element) => {
    const own = element.pageNumber !== undefined && !selectedPages.has(element.pageNumber)
      ? []
      : [
          ["actual-text", element.actualText],
          ["alternate-text", element.alternateText],
          ["title", element.title],
        ].flatMap(([suffix, value]) => value === undefined ? [] : [{
          id: `${element.id}-${suffix}`,
          ...(element.pageNumber !== undefined ? { pageNumber: element.pageNumber } : {}),
          channel: "accessibility" as const,
          text: value,
          ...(element.objectRef !== undefined ? { objectRef: element.objectRef } : {}),
        }]);
    return [...own, ...flattenStructureFragments(element.children, selectedPages)];
  });
}

function metadataFragments(features: PdfDocumentFeatures): readonly PdfReadFragment[] {
  const metadata = features.metadata;
  const values: readonly (readonly [string, string | undefined])[] = [
    ["title", metadata.title],
    ["author", metadata.author],
    ["subject", metadata.subject],
    ["keywords", metadata.keywords],
    ["creator", metadata.creator],
    ["producer", metadata.producer],
    ["creation-date", metadata.creationDate],
    ["modification-date", metadata.modificationDate],
    ["trapped", metadata.trapped],
    ...Object.entries(metadata.custom).map(([key, value]) => [`custom-${key}`, value] as const),
    ["xmp", metadata.xmp?.text],
  ];
  return values.flatMap(([id, value]) => value === undefined ? [] : [{
    id: `metadata-${id}`,
    channel: "metadata" as const,
    text: value,
    ...(metadata.xmp !== undefined && id === "xmp" ? { objectRef: metadata.xmp.objectRef } : {}),
  }]);
}

function failureResult<T>(error: unknown, diagnostics: readonly PdfDiagnostic[]): PdfResult<T> {
  if (isAbortError(error)) {
    return { status: "cancelled", diagnostics: [...diagnostics, diagnostic("operation-cancelled", "ir", "low", "The operation was cancelled.")] };
  }
  if (error instanceof PdfPolicyBlockedError) {
    return { status: "blocked", diagnostics: [...diagnostics, diagnostic("policy-blocked", "admission", "high", error.message)] };
  }
  if (error instanceof PdfSourceLimitError || error instanceof PdfBudgetExceededError) {
    return { status: "blocked", diagnostics: [...diagnostics, diagnostic("resource-limit", "admission", "high", error.message)] };
  }
  if (error instanceof PdfSyntaxError || error instanceof PdfStreamDecodeError) {
    return { status: "failed", diagnostics: [...diagnostics, diagnostic("document-invalid", "ir", "high", error.message)] };
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: "failed", diagnostics: [...diagnostics, diagnostic("internal-failure", "ir", "critical", message)] };
}

function diagnostic(
  code: string,
  stage: PdfDiagnostic["stage"],
  level: PdfDiagnostic["level"],
  message: string,
  detail: Pick<PdfDiagnostic, "objectRef" | "pageNumber" | "feature" | "detail"> = {},
): PdfDiagnostic {
  return { code, stage, level, message, ...detail };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function detectRuntime(): PdfRuntimeDescriptor {
  const globals = globalThis as typeof globalThis & {
    readonly Bun?: { readonly version?: string };
    readonly Deno?: { readonly version?: { readonly deno?: string } };
    readonly process?: { readonly versions?: { readonly node?: string } };
  };
  if (globals.Deno !== undefined) {
    return { kind: "deno", ...(globals.Deno.version?.deno !== undefined ? { version: globals.Deno.version.deno } : {}) };
  }
  if (globals.Bun !== undefined) {
    return { kind: "bun", ...(globals.Bun.version !== undefined ? { version: globals.Bun.version } : {}) };
  }
  if (globals.process?.versions?.node !== undefined) {
    return { kind: "node", version: globals.process.versions.node };
  }
  return typeof document === "object" ? { kind: "web" } : { kind: "unknown" };
}

function detectRuntimeCapabilities(runtime: PdfRuntimeDescriptor): PdfRuntimeCapabilities {
  return {
    streams: typeof ReadableStream === "function",
    fileSystem: runtime.kind === "node" || runtime.kind === "deno" || runtime.kind === "bun",
    webWorker: typeof Worker === "function",
    highResolutionTime: typeof performance === "object" && typeof performance.now === "function",
  };
}
