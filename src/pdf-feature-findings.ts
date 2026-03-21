import {
  findFirstDictionaryToken,
  keyOfObjectRef,
  type ParsedIndirectObject,
  type PdfShellAnalysis,
  readNameValue,
  readObjectRefValue,
  readObjectRefsValue,
} from "./shell-parse.ts";

import type {
  PdfActionFinding,
  PdfAnnotationFinding,
  PdfAttachmentFinding,
  PdfFeatureEvidenceSource,
  PdfFeatureFinding,
  PdfFeatureKind,
  PdfFormFinding,
  PdfLinkFinding,
  PdfNormalizedAdmissionPolicy,
  PdfObjectFeatureFinding,
  PdfObjectRef,
  PdfOptionalContentFinding,
  PdfOutlineFinding,
  PdfPolicyAction,
  PdfSignatureFinding,
} from "./contracts.ts";

const HIDDEN_TEXT_PATTERN = /\/(?:OC|ActualText)\b/;

const FEATURE_PATTERNS: ReadonlyArray<{
  readonly kind: Exclude<PdfFeatureKind, "links" | "optional-content">;
  readonly pattern: RegExp;
  readonly actionKey: "javascriptActions" | "launchActions" | "embeddedFiles" | null;
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
  { kind: "hidden-text", pattern: HIDDEN_TEXT_PATTERN, actionKey: null },
  { kind: "duplicate-text-layer", pattern: /\/Subtype\s*\/Image\b[\s\S]{0,500}\/Font\b/, actionKey: null },
] as const;

export interface PdfFeatureEvaluation {
  readonly featureFindings: readonly PdfFeatureFinding[];
  readonly authoritativeFeatureKinds: readonly PdfFeatureKind[];
  readonly scanFallbackPolicyKinds: readonly PdfFeatureKind[];
}

export function evaluatePdfFeatureFindings(
  analysis: PdfShellAnalysis,
  policy: PdfNormalizedAdmissionPolicy,
): PdfFeatureEvaluation {
  const parsedFindings = collectParsedFeatureFindings(analysis, policy);
  const findings = appendScanFallbackFindings(parsedFindings, analysis, policy);

  return {
    featureFindings: findings,
    authoritativeFeatureKinds: Array.from(
      new Set(findings.filter((finding) => finding.evidenceSource === "object").map((finding) => finding.kind)),
    ),
    scanFallbackPolicyKinds: Array.from(
      new Set(
        findings
          .filter((finding) => finding.evidenceSource === "scan" && requiresParsedPolicyAuthority(finding.kind))
          .map((finding) => finding.kind),
      ),
    ),
  };
}

export function hasDetectedFeatureFinding(
  featureFindings: readonly PdfFeatureFinding[],
  kind: PdfFeatureKind,
): boolean {
  return featureFindings.some((finding) => finding.kind === kind);
}

function collectParsedFeatureFindings(
  analysis: PdfShellAnalysis,
  policy: PdfNormalizedAdmissionPolicy,
): readonly PdfFeatureFinding[] {
  const featureFindings: PdfFeatureFinding[] = [];
  const rootRef = analysis.trailer?.rootRef;
  const rootObject = rootRef ? analysis.objectIndex.get(keyOfObjectRef(rootRef)) : undefined;

  if (analysis.trailer?.encryptRef !== undefined) {
    featureFindings.push({
      kind: "encryption",
      action: "report",
      evidenceSource: "object",
      objectRef: analysis.trailer.encryptRef,
      objectRefs: [analysis.trailer.encryptRef],
      message: buildFeatureMessage("encryption", "report", "object", analysis.trailer.encryptRef),
    } satisfies PdfObjectFeatureFinding);
  }

  if (rootObject?.dictionaryEntries.has("AcroForm")) {
    const formRef = readObjectRefValue(rootObject.dictionaryEntries.get("AcroForm"));
    const formObject = formRef ? analysis.objectIndex.get(keyOfObjectRef(formRef)) : undefined;
    featureFindings.push({
      kind: "forms",
      action: "report",
      evidenceSource: "object",
      ...(formRef !== undefined ? { objectRef: formRef, formRef } : rootRef !== undefined ? { objectRef: rootRef } : {}),
      fieldRefs: readObjectRefsValue(formObject?.dictionaryEntries.get("Fields")),
      message: buildFeatureMessage("forms", "report", "object", formRef ?? rootRef),
    } satisfies PdfFormFinding);
  }

  if (rootObject?.dictionaryEntries.has("Outlines")) {
    const outlineRef = readObjectRefValue(rootObject.dictionaryEntries.get("Outlines"));
    featureFindings.push({
      kind: "outlines",
      action: "report",
      evidenceSource: "object",
      ...(outlineRef !== undefined ? { objectRef: outlineRef, outlineRef } : rootRef !== undefined ? { objectRef: rootRef } : {}),
      itemRefs: outlineRef ? collectOutlineItemRefs(outlineRef, analysis.objectIndex) : [],
      message: buildFeatureMessage("outlines", "report", "object", outlineRef ?? rootRef),
    } satisfies PdfOutlineFinding);
  }

  const optionalContentFinding = buildOptionalContentFinding(rootObject, rootRef, analysis.objectIndex);
  if (optionalContentFinding) {
    featureFindings.push(optionalContentFinding);
  }

  const annotationFindings = buildAnnotationFindings(analysis);
  featureFindings.push(...annotationFindings.annotations, ...annotationFindings.links);

  const objectStreamRefs: PdfObjectRef[] = [];
  const imageRefs: PdfObjectRef[] = [];
  const fontRefs: PdfObjectRef[] = [];
  const embeddedFileRefs = new Map<string, PdfAttachmentFinding>();
  const signatureKeys = new Set<string>();
  const signatureFindings: PdfSignatureFinding[] = [];
  const actionKeys = new Set<string>();
  const actionFindings: PdfActionFinding[] = [];
  const optionalContentMemberRefs: PdfObjectRef[] = optionalContentFinding?.memberObjectRefs.slice() ?? [];

  for (const objectShell of analysis.indirectObjects) {
    const subtypeName = readNameValue(objectShell.dictionaryEntries.get("Subtype"));
    const typeName = objectShell.typeName;
    const actionName = readNameValue(objectShell.dictionaryEntries.get("S"));
    const fieldTypeName = readNameValue(objectShell.dictionaryEntries.get("FT"));

    if (typeName === "ObjStm") {
      objectStreamRefs.push(objectShell.ref);
    }
    if (subtypeName === "Image") {
      imageRefs.push(objectShell.ref);
    }
    if (typeName === "Font") {
      fontRefs.push(objectShell.ref);
    }
    if (actionName === "JavaScript" || objectShell.dictionaryEntries.has("JS") || objectShell.dictionaryEntries.has("JavaScript")) {
      pushUniqueFinding(
        actionFindings,
        actionKeys,
        `${objectShell.ref.objectNumber}:${objectShell.ref.generationNumber}:javascript-actions`,
        {
          kind: "javascript-actions",
          action: policy.javascriptActions,
          actionName: "JavaScript",
          evidenceSource: "object",
          objectRef: objectShell.ref,
          actionRef: objectShell.ref,
          message: buildFeatureMessage("javascript-actions", policy.javascriptActions, "object", objectShell.ref),
        } satisfies PdfActionFinding,
      );
    }
    if (actionName === "Launch") {
      pushUniqueFinding(
        actionFindings,
        actionKeys,
        `${objectShell.ref.objectNumber}:${objectShell.ref.generationNumber}:launch-actions`,
        {
          kind: "launch-actions",
          action: policy.launchActions,
          actionName: "Launch",
          evidenceSource: "object",
          objectRef: objectShell.ref,
          actionRef: objectShell.ref,
          message: buildFeatureMessage("launch-actions", policy.launchActions, "object", objectShell.ref),
        } satisfies PdfActionFinding,
      );
    }
    if (objectShell.typeName === "EmbeddedFile" || objectShell.dictionaryEntries.has("EmbeddedFile") || objectShell.dictionaryEntries.has("EF")) {
      const embeddedFileRef = objectShell.typeName === "EmbeddedFile" ? objectShell.ref : resolveEmbeddedFileRef(objectShell, analysis.objectIndex);
      const fileSpecRef = objectShell.dictionaryEntries.has("EF") ? objectShell.ref : undefined;
      const key = `${(fileSpecRef ?? embeddedFileRef ?? objectShell.ref).objectNumber}:${(fileSpecRef ?? embeddedFileRef ?? objectShell.ref).generationNumber}`;
      embeddedFileRefs.set(
        key,
        {
          kind: "embedded-files",
          action: policy.embeddedFiles,
          evidenceSource: "object",
          objectRef: fileSpecRef ?? embeddedFileRef ?? objectShell.ref,
          ...(fileSpecRef !== undefined ? { fileSpecRef } : {}),
          ...(embeddedFileRef !== undefined ? { embeddedFileRef } : {}),
          message: buildFeatureMessage("embedded-files", policy.embeddedFiles, "object", fileSpecRef ?? embeddedFileRef ?? objectShell.ref),
        } satisfies PdfAttachmentFinding,
      );
    }
    if (typeName === "Sig" || fieldTypeName === "Sig") {
      const signatureRef = typeName === "Sig" ? objectShell.ref : readObjectRefValue(objectShell.dictionaryEntries.get("V"));
      const signatureFinding = {
        kind: "signatures",
        action: "report",
        evidenceSource: "object",
        objectRef: objectShell.ref,
        ...(fieldTypeName === "Sig" ? { fieldRef: objectShell.ref } : {}),
        ...(signatureRef !== undefined ? { signatureRef } : {}),
        message: buildFeatureMessage("signatures", "report", "object", objectShell.ref),
      } satisfies PdfSignatureFinding;
      const key = `${signatureFinding.fieldRef?.objectNumber ?? "none"}:${signatureFinding.signatureRef?.objectNumber ?? "none"}:${objectShell.ref.objectNumber}`;
      pushUniqueFinding(signatureFindings, signatureKeys, key, signatureFinding);
    }
    if (typeName === "OCG" || typeName === "OCMD" || objectShell.dictionaryEntries.has("OC")) {
      optionalContentMemberRefs.push(objectShell.ref);
    }
  }

  featureFindings.push(...actionFindings);
  featureFindings.push(...embeddedFileRefs.values());
  featureFindings.push(...signatureFindings);

  if (objectStreamRefs.length > 0) {
    const firstObjectStreamRef = objectStreamRefs[0]!;
    featureFindings.push({
      kind: "object-streams",
      action: "report",
      evidenceSource: "object",
      objectRef: firstObjectStreamRef,
      objectRefs: objectStreamRefs,
      message: buildFeatureMessage("object-streams", "report", "object", firstObjectStreamRef),
    } satisfies PdfObjectFeatureFinding);
  }

  if (
    analysis.crossReferenceKind === "xref-stream" ||
    analysis.crossReferenceKind === "hybrid"
  ) {
    const xrefStreamRefs = analysis.crossReferenceSections
      .filter((section) => section.kind === "xref-stream" && section.objectRef !== undefined)
      .map((section) => section.objectRef as PdfObjectRef);
    if (xrefStreamRefs.length > 0) {
      const firstXrefStreamRef = xrefStreamRefs[0]!;
      featureFindings.push({
        kind: "xref-streams",
        action: "report",
        evidenceSource: "object",
        objectRef: firstXrefStreamRef,
        objectRefs: xrefStreamRefs,
        message: buildFeatureMessage("xref-streams", "report", "object", firstXrefStreamRef),
      } satisfies PdfObjectFeatureFinding);
    }
  }

  if (imageRefs.length > 0) {
    const firstImageRef = imageRefs[0]!;
    featureFindings.push({
      kind: "images",
      action: "report",
      evidenceSource: "object",
      objectRef: firstImageRef,
      objectRefs: imageRefs,
      message: buildFeatureMessage("images", "report", "object", firstImageRef),
    } satisfies PdfObjectFeatureFinding);
  }

  if (fontRefs.length > 0) {
    const firstFontRef = fontRefs[0]!;
    featureFindings.push({
      kind: "fonts",
      action: "report",
      evidenceSource: "object",
      objectRef: firstFontRef,
      objectRefs: fontRefs,
      message: buildFeatureMessage("fonts", "report", "object", firstFontRef),
    } satisfies PdfObjectFeatureFinding);
  }

  if (optionalContentFinding && optionalContentMemberRefs.length > optionalContentFinding.memberObjectRefs.length) {
    featureFindings.splice(
      featureFindings.indexOf(optionalContentFinding),
      1,
      {
        ...optionalContentFinding,
        memberObjectRefs: dedupeObjectRefs(optionalContentMemberRefs),
      } satisfies PdfOptionalContentFinding,
    );
  }

  return dedupeFeatureFindings(featureFindings);
}

function appendScanFallbackFindings(
  parsedFindings: readonly PdfFeatureFinding[],
  analysis: PdfShellAnalysis,
  policy: PdfNormalizedAdmissionPolicy,
): readonly PdfFeatureFinding[] {
  const findings = [...parsedFindings];
  const useScanFallback = shouldUseFeatureScanFallback(analysis);
  const detectedKinds = new Set(parsedFindings.map((finding) => finding.kind));

  for (const entry of FEATURE_PATTERNS) {
    if (detectedKinds.has(entry.kind)) {
      continue;
    }
    if (!useScanFallback && !usesScanFeatureDetection(entry.kind)) {
      continue;
    }
    if (!entry.pattern.test(analysis.scanText)) {
      continue;
    }

    const action = resolveFeatureAction(entry.kind, policy, entry.actionKey);
    findings.push(buildScanFeatureFinding(entry.kind, action, useScanFallback));
  }

  return dedupeFeatureFindings(findings);
}

function buildAnnotationFindings(
  analysis: PdfShellAnalysis,
): {
  readonly annotations: readonly PdfAnnotationFinding[];
  readonly links: readonly PdfLinkFinding[];
} {
  const annotations: PdfAnnotationFinding[] = [];
  const links: PdfLinkFinding[] = [];
  const annotationKeys = new Set<string>();
  const linkKeys = new Set<string>();

  for (const pageEntry of analysis.pageEntries) {
    for (const annotationRef of pageEntry.annotationRefs) {
      const annotationObject = analysis.objectIndex.get(keyOfObjectRef(annotationRef));
      const annotationSubtype = readNameValue(annotationObject?.dictionaryEntries.get("Subtype"));
      pushUniqueFinding(
        annotations,
        annotationKeys,
        `${annotationRef.objectNumber}:${annotationRef.generationNumber}`,
        {
          kind: "annotations",
          action: "report",
          evidenceSource: "object",
          objectRef: annotationRef,
          annotationRef,
          pageRef: pageEntry.pageRef,
          ...(annotationSubtype !== undefined ? { annotationSubtype } : {}),
          message: buildFeatureMessage("annotations", "report", "object", annotationRef),
        } satisfies PdfAnnotationFinding,
      );

      const destinationRef = readObjectRefValue(annotationObject?.dictionaryEntries.get("Dest"));
      const actionRef = readObjectRefValue(annotationObject?.dictionaryEntries.get("A"));
      const isLinkAnnotation = annotationSubtype === "Link" || destinationRef !== undefined || actionRef !== undefined;
      if (!isLinkAnnotation) {
        continue;
      }

      pushUniqueFinding(
        links,
        linkKeys,
        `${annotationRef.objectNumber}:${annotationRef.generationNumber}`,
        {
          kind: "links",
          action: "report",
          evidenceSource: "object",
          objectRef: annotationRef,
          annotationRef,
          pageRef: pageEntry.pageRef,
          ...(annotationSubtype !== undefined ? { annotationSubtype } : {}),
          ...(destinationRef !== undefined ? { destinationRef } : {}),
          ...(actionRef !== undefined ? { actionRef } : {}),
          message: buildFeatureMessage("links", "report", "object", annotationRef),
        } satisfies PdfLinkFinding,
      );
    }
  }

  return { annotations, links };
}

function buildOptionalContentFinding(
  rootObject: ParsedIndirectObject | undefined,
  rootRef: PdfObjectRef | undefined,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): PdfOptionalContentFinding | undefined {
  if (!rootObject?.dictionaryEntries.has("OCProperties")) {
    const groupRefs = collectOptionalContentGroupRefs(objectIndex);
    const memberObjectRefs = collectOptionalContentMemberRefs(objectIndex);
    if (groupRefs.length === 0 && memberObjectRefs.length === 0) {
      return undefined;
    }

    return {
      kind: "optional-content",
      action: "report",
      evidenceSource: "object",
      ...(groupRefs[0] !== undefined ? { objectRef: groupRefs[0] } : memberObjectRefs[0] !== undefined ? { objectRef: memberObjectRefs[0] } : {}),
      groupRefs,
      memberObjectRefs,
      message: buildFeatureMessage("optional-content", "report", "object", groupRefs[0] ?? memberObjectRefs[0]),
    };
  }

  const configRef = readObjectRefValue(rootObject.dictionaryEntries.get("OCProperties"));
  const configObject = configRef ? objectIndex.get(keyOfObjectRef(configRef)) : undefined;
  const configDictionaryText = configObject
    ? findFirstDictionaryToken(configObject.objectValueText ?? "")
    : rootObject.dictionaryEntries.get("OCProperties");
  const groupRefs = dedupeObjectRefs([
    ...(configDictionaryText ? readObjectRefsValue(configDictionaryText) : []),
    ...collectOptionalContentGroupRefs(objectIndex),
  ]);
  const memberObjectRefs = collectOptionalContentMemberRefs(objectIndex);

  return {
    kind: "optional-content",
    action: "report",
    evidenceSource: "object",
    ...(configRef !== undefined ? { objectRef: configRef, configRef } : rootRef !== undefined ? { objectRef: rootRef } : {}),
    groupRefs,
    memberObjectRefs,
    message: buildFeatureMessage("optional-content", "report", "object", configRef ?? rootRef),
  };
}

function collectOutlineItemRefs(
  outlineRef: PdfObjectRef,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): readonly PdfObjectRef[] {
  const itemRefs: PdfObjectRef[] = [];
  const queue: PdfObjectRef[] = [];
  const outlineObject = objectIndex.get(keyOfObjectRef(outlineRef));
  const firstRef = readObjectRefValue(outlineObject?.dictionaryEntries.get("First"));
  if (firstRef) {
    queue.push(firstRef);
  }
  const seen = new Set<string>();

  while (queue.length > 0) {
    const currentRef = queue.shift() as PdfObjectRef;
    const key = keyOfObjectRef(currentRef);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    itemRefs.push(currentRef);
    const currentObject = objectIndex.get(key);
    const firstChildRef = readObjectRefValue(currentObject?.dictionaryEntries.get("First"));
    const nextRef = readObjectRefValue(currentObject?.dictionaryEntries.get("Next"));
    if (firstChildRef) {
      queue.push(firstChildRef);
    }
    if (nextRef) {
      queue.push(nextRef);
    }
  }

  return itemRefs;
}

function collectOptionalContentGroupRefs(
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): readonly PdfObjectRef[] {
  return Array.from(objectIndex.values())
    .filter((objectShell) => objectShell.typeName === "OCG" || objectShell.typeName === "OCMD")
    .map((objectShell) => objectShell.ref);
}

function collectOptionalContentMemberRefs(
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): readonly PdfObjectRef[] {
  return Array.from(objectIndex.values())
    .filter((objectShell) => objectShell.dictionaryEntries.has("OC"))
    .map((objectShell) => objectShell.ref);
}

function resolveEmbeddedFileRef(
  objectShell: ParsedIndirectObject,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): PdfObjectRef | undefined {
  if (!objectShell.dictionaryEntries.has("EF")) {
    return undefined;
  }

  const embeddedValue = objectShell.dictionaryEntries.get("EF");
  const directRef = readObjectRefValue(embeddedValue);
  if (directRef !== undefined) {
    return directRef;
  }

  const dictionaryText = embeddedValue ? findFirstDictionaryToken(embeddedValue) ?? embeddedValue : undefined;
  const resolvedDictionaryText = dictionaryText?.startsWith("<<") ? dictionaryText : resolveDictionaryText(dictionaryText, objectIndex);
  const refs = readObjectRefsValue(resolvedDictionaryText);
  return refs[0];
}

function resolveDictionaryText(
  rawValue: string | undefined,
  objectIndex: ReadonlyMap<string, ParsedIndirectObject>,
): string | undefined {
  if (!rawValue) {
    return undefined;
  }
  if (rawValue.startsWith("<<") && rawValue.endsWith(">>")) {
    return rawValue;
  }

  const objectRef = readObjectRefValue(rawValue);
  if (!objectRef) {
    return undefined;
  }

  return findFirstDictionaryToken(objectIndex.get(keyOfObjectRef(objectRef))?.objectValueText ?? "");
}

function buildScanFeatureFinding(
  kind: Exclude<PdfFeatureKind, "links" | "optional-content">,
  action: PdfPolicyAction,
  useScanFallback: boolean,
): PdfFeatureFinding {
  const message = buildFeatureMessage(kind, action, "scan", undefined, useScanFallback);
  switch (kind) {
    case "javascript-actions":
      return {
        kind,
        action,
        actionName: "JavaScript",
        evidenceSource: "scan",
        message,
      } satisfies PdfActionFinding;
    case "launch-actions":
      return {
        kind,
        action,
        actionName: "Launch",
        evidenceSource: "scan",
        message,
      } satisfies PdfActionFinding;
    case "embedded-files":
      return {
        kind,
        action,
        evidenceSource: "scan",
        message,
      } satisfies PdfAttachmentFinding;
    case "forms":
      return {
        kind,
        action,
        evidenceSource: "scan",
        fieldRefs: [],
        message,
      } satisfies PdfFormFinding;
    case "annotations":
      return {
        kind,
        action,
        evidenceSource: "scan",
        message,
      } satisfies PdfAnnotationFinding;
    case "outlines":
      return {
        kind,
        action,
        evidenceSource: "scan",
        itemRefs: [],
        message,
      } satisfies PdfOutlineFinding;
    case "signatures":
      return {
        kind,
        action,
        evidenceSource: "scan",
        message,
      } satisfies PdfSignatureFinding;
    case "duplicate-text-layer":
    case "encryption":
    case "fonts":
    case "hidden-text":
    case "images":
    case "object-streams":
    case "xref-streams":
      return {
        kind,
        action,
        evidenceSource: "scan",
        objectRefs: [],
        message,
      } satisfies PdfObjectFeatureFinding;
  }
}

function shouldUseFeatureScanFallback(analysis: PdfShellAnalysis): boolean {
  return (analysis.isTruncated && !analysis.usedFullStructureScan) ||
    !analysis.parseCoverage.indirectObjects ||
    !analysis.parseCoverage.trailer ||
    analysis.repairState !== "clean";
}

function usesScanFeatureDetection(kind: PdfFeatureKind): boolean {
  return kind === "hidden-text" || kind === "duplicate-text-layer";
}

function requiresParsedPolicyAuthority(kind: PdfFeatureKind): boolean {
  return kind === "javascript-actions" ||
    kind === "launch-actions" ||
    kind === "encryption";
}

function resolveFeatureAction(
  kind: PdfFeatureKind,
  policy: PdfNormalizedAdmissionPolicy,
  actionKey: "javascriptActions" | "launchActions" | "embeddedFiles" | null,
): PdfPolicyAction {
  if (actionKey) {
    return policy[actionKey];
  }

  switch (kind) {
    case "embedded-files":
      return policy.embeddedFiles;
    case "javascript-actions":
    case "launch-actions":
      return actionKey ? policy[actionKey] : "report";
    case "annotations":
    case "duplicate-text-layer":
    case "encryption":
    case "fonts":
    case "forms":
    case "hidden-text":
    case "images":
    case "links":
    case "object-streams":
    case "optional-content":
    case "outlines":
    case "signatures":
    case "xref-streams":
      return "report";
  }
}

function buildFeatureMessage(
  kind: PdfFeatureKind,
  action: PdfPolicyAction,
  evidenceSource: PdfFeatureEvidenceSource,
  objectRef?: PdfObjectRef,
  usedFallbackScan = false,
): string {
  const featureLabel = kind.replaceAll("-", " ");
  if (evidenceSource === "object") {
    const objectDetail = objectRef ? ` at ${formatObjectRef(objectRef)}` : "";
    return `Detected ${featureLabel} from parsed object evidence${objectDetail}; policy action is ${action}.`;
  }

  const fallbackDetail = usedFallbackScan ? " while parsed object coverage was incomplete" : "";
  return `Detected ${featureLabel} from scan fallback${fallbackDetail}; policy action is ${action}.`;
}

function formatObjectRef(objectRef: PdfObjectRef): string {
  return `${String(objectRef.objectNumber)} ${String(objectRef.generationNumber)} R`;
}

function dedupeFeatureFindings(featureFindings: readonly PdfFeatureFinding[]): readonly PdfFeatureFinding[] {
  const uniqueFeatureFindings: PdfFeatureFinding[] = [];
  const seen = new Set<string>();

  for (const featureFinding of featureFindings) {
    const key = JSON.stringify({
      kind: featureFinding.kind,
      evidenceSource: featureFinding.evidenceSource,
      objectRef: featureFinding.objectRef,
      actionRef: "actionRef" in featureFinding ? featureFinding.actionRef : undefined,
      annotationRef: "annotationRef" in featureFinding ? featureFinding.annotationRef : undefined,
      formRef: "formRef" in featureFinding ? featureFinding.formRef : undefined,
      outlineRef: "outlineRef" in featureFinding ? featureFinding.outlineRef : undefined,
      configRef: "configRef" in featureFinding ? featureFinding.configRef : undefined,
      signatureRef: "signatureRef" in featureFinding ? featureFinding.signatureRef : undefined,
      fileSpecRef: "fileSpecRef" in featureFinding ? featureFinding.fileSpecRef : undefined,
      embeddedFileRef: "embeddedFileRef" in featureFinding ? featureFinding.embeddedFileRef : undefined,
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueFeatureFindings.push(featureFinding);
  }

  return uniqueFeatureFindings;
}

function dedupeObjectRefs(objectRefs: readonly PdfObjectRef[]): readonly PdfObjectRef[] {
  const uniqueRefs: PdfObjectRef[] = [];
  const seen = new Set<string>();

  for (const objectRef of objectRefs) {
    const key = keyOfObjectRef(objectRef);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueRefs.push(objectRef);
  }

  return uniqueRefs;
}

function pushUniqueFinding<T>(
  findings: T[],
  seen: Set<string>,
  key: string,
  finding: T,
): void {
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  findings.push(finding);
}
