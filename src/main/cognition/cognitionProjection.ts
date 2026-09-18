import { randomUUID } from "node:crypto";
import { estimatedCognitionContextTokens } from "../agent/cognitionContext";
import type { RecallPlan } from "../../shared/contracts/memoryRecall";
import { CHARACTER_LIFE_PAUSED_BLOCKER } from "./cognitionTypes";
import { INCOMPLETE_RECEIPT } from "./cognitionSnapshotReader";

import type {
  CognitionAnalysis,
  CognitionAnalysisCoverage,
  CognitionConversationProjectionRead,
  CognitionAnalysisInput,
  CognitionChoice,
  CognitionDecision,
  CognitionDecisionAttempt,
  CognitionEvidence,
  CognitionIntent,
  CognitionPreparedContext,
  CognitionRuntimeAvailability,
  CognitionSelectedBasis,
  CognitionSituation,
  CognitionSnapshot,
} from "./cognitionTypes";

export class CognitionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CognitionConflictError";
  }
}

export interface ResolvedCognitionAnalysis {
  readonly situations: CognitionSituation[];
  readonly intents: CognitionIntent[];
  readonly decision: CognitionDecision;
  readonly recallPlan?: RecallPlan;
  readonly currentSituationId?: string;
  readonly committedIntentId?: string;
}

/** Structural qualification of host-owned evidence. The model must judge
 * whether the actually visible content covers the visible goal and criteria. */
export function isIntentCompletionEvidence(
  basis: string,
  item: CognitionEvidence,
): boolean {
  if (basis === "performed_effect")
    return item.kind === "effect" && item.effect?.outcome === "performed";
  if (basis === "user_report")
    return item.kind === "utterance" && item.actor === "user";
  return (
    basis === "completed_reply" &&
    item.kind === "utterance" &&
    item.actor === "agent" &&
    item.source.kind === "run" &&
    item.source.revision === "completed" &&
    Boolean(item.source.fragment) &&
    Boolean(item.chatId)
  );
}

function requireEvidence(
  ids: readonly string[],
  evidence: ReadonlyMap<string, CognitionEvidence>,
): CognitionEvidence[] {
  return ids.map((id) => {
    const item = evidence.get(id);
    if (!item) throw new CognitionConflictError(`Unknown evidence: ${id}`);
    return item;
  });
}

export interface CognitionEvidenceReferenceIssue {
  readonly kind: "reference_not_supplied";
  /** Path in the decoded proposal, not an index into its child upsert array. */
  readonly field: string;
  readonly evidenceId: string;
  readonly scope: "actual_evidence" | "visible_provenance" | "partial_intent";
  readonly parentId?: string;
  readonly childId?: string;
  readonly suppliedPaths: readonly string[];
  readonly message: string;
}

export interface CognitionStateReferenceIssue {
  readonly kind: "state_reference_not_supplied";
  readonly field: string;
  readonly referenceId: string;
  readonly entityKind: "situation" | "intent";
  readonly parentId?: string;
  readonly suppliedPaths: readonly string[];
  readonly message: string;
}

export type CognitionReferenceIssue =
  CognitionEvidenceReferenceIssue | CognitionStateReferenceIssue;

export class CognitionReferenceError extends CognitionConflictError {
  constructor(readonly issues: readonly CognitionReferenceIssue[]) {
    super(
      issues
        .map(
          (issue) =>
            `Reference not supplied at ${issue.field}: ${"evidenceId" in issue ? issue.evidenceId : issue.referenceId}. ${issue.message}`,
        )
        .join("\n"),
    );
    this.name = "CognitionReferenceError";
  }
}

/** Input membership only. Visible provenance is not supplied source content;
 * canonical existence, semantic use, partial-state merge and CAS remain owned
 * by the committing Repository. Never use its expanded metadata snapshot here. */
export function validateCognitionEvidenceReferences(
  analysis: CognitionAnalysis,
  input: CognitionAnalysisInput,
): void {
  const actual = new Set(input.snapshot.evidence.map(({ id }) => id));
  const visible = new Set(actual);
  for (const situation of input.snapshot.situations) {
    for (const episode of situation.episodes)
      episode.evidenceIds.forEach((id) => visible.add(id));
    for (const claim of situation.claims)
      [
        ...claim.evidenceIds,
        ...claim.contradictingEvidenceIds,
        ...(claim.historyEvidenceIds ?? []),
      ].forEach((id) => visible.add(id));
  }
  for (const intent of input.snapshot.intents)
    [...intent.evidenceIds, ...intent.effectEvidenceIds].forEach((id) =>
      visible.add(id),
    );
  const issues: CognitionReferenceIssue[] = [];
  const actualPaths = ["snapshot.evidence[].id"];
  const visiblePaths = [
    ...actualPaths,
    "snapshot.situations",
    "snapshot.intents",
  ];
  const check = (
    evidenceId: string,
    field: string,
    allowed: ReadonlySet<string>,
    scope: CognitionEvidenceReferenceIssue["scope"],
    suppliedPaths: readonly string[],
    owner: Pick<CognitionEvidenceReferenceIssue, "parentId" | "childId"> = {},
  ): void => {
    if (allowed.has(evidenceId)) return;
    issues.push({
      kind: "reference_not_supplied",
      field,
      evidenceId,
      scope,
      ...owner,
      suppliedPaths,
      message:
        scope === "actual_evidence"
          ? "This use requires an actual snapshot.evidence entry. An existing state reference does not supply its source content or authorize a new completion."
          : scope === "partial_intent"
            ? "A partial Intent may reference actual supplied evidence or its own visible provenance. Other state references do not expand that allocation."
            : "This ID is absent from the actual evidence and visible state provenance. Check the original supplied references exactly; this is not a statement about all stored sources. Retained references do not supply their source content.",
    });
  };
  const situationReferences = (
    value: Pick<CognitionSituation, "episodes" | "claims">,
    field: string,
    parentId: string,
  ): void => {
    const oldIndex = input.snapshot.situations.findIndex(
      ({ id }) => id === parentId,
    );
    for (const childField of ["episodes", "claims"] as const) {
      const oldChildren = new Map<string, number>(
        input.snapshot.situations[oldIndex]?.[childField].map(
          (child, index) => [child.id, index] as const,
        ),
      );
      value[childField].forEach((child, index) => {
        const oldChildIndex = oldChildren.get(child.id);
        const fields =
          childField === "episodes"
            ? (["evidenceIds"] as const)
            : (["evidenceIds", "contradictingEvidenceIds"] as const);
        for (const sourceField of fields) {
          const paths = [...visiblePaths];
          if (oldChildIndex !== undefined)
            paths.push(
              `snapshot.situations[${oldIndex}].${childField}[${oldChildIndex}].${sourceField}`,
            );
          // Both child types have evidenceIds; only Claims have contradictions.
          const ids =
            sourceField === "evidenceIds"
              ? child.evidenceIds
              : value.claims[index]!.contradictingEvidenceIds;
          ids.forEach((id, sourceIndex) =>
            check(
              id,
              `${field}.${childField}[${index}].${sourceField}[${sourceIndex}]`,
              visible,
              "visible_provenance",
              paths,
              { parentId, childId: child.id },
            ),
          );
        }
      });
    }
  };
  for (const operation of ["createSituations", "updateSituations"] as const)
    analysis.delta[operation].forEach((entry, index) =>
      situationReferences(
        entry.value,
        `delta.${operation}[${index}].value`,
        "localId" in entry ? entry.localId : entry.id,
      ),
    );
  for (const operation of ["createIntents", "updateIntents"] as const)
    analysis.delta[operation].forEach((entry, index) => {
      const parentId = "localId" in entry ? entry.localId : entry.id;
      const oldIndex = input.snapshot.intents.findIndex(
        ({ id }) => id === parentId,
      );
      const old = input.snapshot.intents[oldIndex];
      const partial = input.attempt.allocation?.intents?.some(
        ({ id }) => id === parentId,
      );
      const allowed = partial
        ? new Set([
            ...actual,
            ...(old?.evidenceIds ?? []),
            ...(old?.effectEvidenceIds ?? []),
          ])
        : visible;
      const paths = partial
        ? [
            ...actualPaths,
            `snapshot.intents[${oldIndex}].evidenceIds`,
            `snapshot.intents[${oldIndex}].effectEvidenceIds`,
          ]
        : visiblePaths;
      const field = `delta.${operation}[${index}].value`;
      for (const sourceField of ["evidenceIds", "effectEvidenceIds"] as const)
        entry.value[sourceField].forEach((id, sourceIndex) =>
          check(
            id,
            `${field}.${sourceField}[${sourceIndex}]`,
            allowed,
            partial ? "partial_intent" : "visible_provenance",
            paths,
            { parentId },
          ),
        );
      if (
        "localId" in entry ||
        ("completionOperation" in entry && entry.completionOperation === "set")
      )
        entry.value.completion?.evidenceUses.forEach((use, sourceIndex) =>
          check(
            use.evidenceId,
            `${field}.completion.evidenceUses[${sourceIndex}].evidenceId`,
            actual,
            "actual_evidence",
            actualPaths,
            { parentId },
          ),
        );
    });
  analysis.decision.choices.forEach((choice, index) => {
    const selected = choice.id === analysis.decision.selectedChoiceId;
    choice.evidenceIds.forEach((id, sourceIndex) =>
      check(
        id,
        `decision.choices[${index}].evidenceIds[${sourceIndex}]`,
        selected ? actual : visible,
        selected ? "actual_evidence" : "visible_provenance",
        selected ? actualPaths : visiblePaths,
      ),
    );
  });
  analysis.decision.selectedBasis.evidenceUses.forEach((use, index) =>
    check(
      use.evidenceId,
      `decision.selectedBasis.evidenceUses[${index}].evidenceId`,
      actual,
      "actual_evidence",
      actualPaths,
    ),
  );
  const continuation = analysis.decision.selectedBasis.requestedContinuation;
  if (continuation)
    check(
      continuation.requestEvidenceId,
      "decision.selectedBasis.requestedContinuation.requestEvidenceId",
      actual,
      "actual_evidence",
      actualPaths,
    );
  const waiting = analysis.decision.selectedBasis.waitingInputContinuation;
  if (waiting)
    check(
      waiting.requestEvidenceId,
      "decision.selectedBasis.waitingInputContinuation.requestEvidenceId",
      actual,
      "actual_evidence",
      actualPaths,
    );
  if (issues.length) throw new CognitionReferenceError(issues);
}

/** Match the committing projection's state membership rules using only this
 * actual input. A retained relation grants no access to its omitted target. */
export function validateCognitionStateReferences(
  analysis: CognitionAnalysis,
  input: CognitionAnalysisInput,
): void {
  const situations = new Set([
    ...input.snapshot.situations.map(({ id }) => id),
    ...analysis.delta.createSituations.map(({ localId }) => localId),
  ]);
  const intents = new Set([
    ...input.snapshot.intents.map(({ id }) => id),
    ...analysis.delta.createIntents.map(({ localId }) => localId),
  ]);
  const issues: CognitionStateReferenceIssue[] = [];
  const check = (
    referenceId: string | undefined | null,
    entityKind: CognitionStateReferenceIssue["entityKind"],
    field: string,
    parentId?: string,
    retained: readonly string[] = [],
    retainedPath?: string,
  ): void => {
    if (
      !referenceId ||
      (entityKind === "situation" ? situations : intents).has(referenceId) ||
      retained.includes(referenceId)
    )
      return;
    issues.push({
      kind: "state_reference_not_supplied",
      field,
      referenceId,
      entityKind,
      ...(parentId ? { parentId } : {}),
      suppliedPaths: [
        entityKind === "situation"
          ? "snapshot.situations[].id"
          : "snapshot.intents[].id",
        entityKind === "situation"
          ? "delta.createSituations[].localId"
          : "delta.createIntents[].localId",
        ...(retainedPath ? [retainedPath] : []),
      ],
      message:
        "This target was not supplied as a state entity of this kind or declared in this proposal's new entities. An existing relation may remain only on its original entity and field; its ID alone does not supply the target for a new relation, choice, current claim or attention selection. This does not mean the stored target is absent or should be deleted.",
    });
  };
  for (const operation of ["createSituations", "updateSituations"] as const)
    analysis.delta[operation].forEach((entry, index) => {
      const parentId = "localId" in entry ? entry.localId : entry.id;
      const oldIndex =
        "id" in entry
          ? input.snapshot.situations.findIndex(({ id }) => id === entry.id)
          : -1;
      const old = input.snapshot.situations[oldIndex];
      const preserved =
        "id" in entry
          ? input.attempt.allocation?.situations.find(
              ({ id }) => id === entry.id,
            )?.preservedFields
          : undefined;
      const field = `delta.${operation}[${index}].value`;
      // The Repository ignores preserved fields rather than treating their
      // projected placeholders as writable canonical relationships.
      if (!preserved?.includes("relatedSituationIds"))
        entry.value.relatedSituationIds.forEach((id, relationIndex) =>
          check(
            id,
            "situation",
            `${field}.relatedSituationIds[${relationIndex}]`,
            parentId,
            old?.relatedSituationIds,
            old
              ? `snapshot.situations[${oldIndex}].relatedSituationIds`
              : undefined,
          ),
        );
      if (!preserved?.includes("supersededBy"))
        check(
          entry.value.supersededBy,
          "situation",
          `${field}.supersededBy`,
          parentId,
          old?.supersededBy ? [old.supersededBy] : [],
          old ? `snapshot.situations[${oldIndex}].supersededBy` : undefined,
        );
    });
  for (const operation of ["createIntents", "updateIntents"] as const)
    analysis.delta[operation].forEach((entry, index) => {
      const parentId = "localId" in entry ? entry.localId : entry.id;
      const oldIndex =
        "id" in entry
          ? input.snapshot.intents.findIndex(({ id }) => id === entry.id)
          : -1;
      const old = input.snapshot.intents[oldIndex];
      check(
        entry.value.situationId,
        "situation",
        `delta.${operation}[${index}].value.situationId`,
        parentId,
        old?.situationId ? [old.situationId] : [],
        old ? `snapshot.intents[${oldIndex}].situationId` : undefined,
      );
    });
  analysis.decision.choices.forEach((choice, index) => {
    check(
      choice.situationId,
      "situation",
      `decision.choices[${index}].situationId`,
    );
    check(choice.intentId, "intent", `decision.choices[${index}].intentId`);
  });
  analysis.decision.selectedBasis.currentClaimRefs.forEach((ref, index) =>
    check(
      ref.situationId,
      "situation",
      `decision.selectedBasis.currentClaimRefs[${index}].situationId`,
    ),
  );
  analysis.decision.selectedBasis.requestedContinuation?.conditionClaimRefs.forEach(
    (ref, index) =>
      check(
        ref.situationId,
        "situation",
        `decision.selectedBasis.requestedContinuation.conditionClaimRefs[${index}].situationId`,
      ),
  );
  check(
    analysis.delta.attention.currentSituationId,
    "situation",
    "delta.attention.currentSituationId",
  );
  check(
    analysis.delta.attention.committedIntentId,
    "intent",
    "delta.attention.committedIntentId",
  );
  if (issues.length) throw new CognitionReferenceError(issues);
}

export interface CognitionSourceUseIssue {
  readonly field: string;
  readonly evidenceId: string;
  readonly requestedUse: CognitionSelectedBasis["evidenceUses"][number]["use"];
  readonly actualKind: CognitionEvidence["kind"];
  readonly hasObject: boolean;
  readonly currentRecollection: boolean;
  readonly typeEligibleUses: CognitionSelectedBasis["evidenceUses"][number]["use"][];
  readonly message: string;
}

export class CognitionSourceUseError extends CognitionConflictError {
  constructor(readonly issues: readonly CognitionSourceUseIssue[]) {
    super(
      issues
        .map(
          ({ evidenceId, requestedUse, actualKind, hasObject, message }) =>
            `${message} Evidence ${evidenceId}: use=${requestedUse}, kind=${actualKind}, object=${hasObject ? "present" : "absent"}.`,
        )
        .join("\n"),
    );
    this.name = "CognitionSourceUseError";
  }
}

// Only type eligibility over the supplied sources. Canonical partial-state merge,
// claim dependencies and execution freshness remain the committing owner's work.
export function validateCognitionSourceUses(
  evidenceUses: CognitionSelectedBasis["evidenceUses"],
  evidence: ReadonlyMap<string, CognitionEvidence>,
): void {
  const issues: CognitionSourceUseIssue[] = [];
  evidenceUses.forEach(({ evidenceId, use }, index) => {
    const source = requireEvidence([evidenceId], evidence)[0]!;
    const hasObject = Boolean(source.object);
    const currentRecollection =
      source.kind === "recollection" && source.recollection?.current === true;
    const typeEligibleUses: CognitionSourceUseIssue["typeEligibleUses"] = [
      "history",
    ];
    if (source.kind === "observation" && hasObject)
      typeEligibleUses.push("current_object", "current_foreground");
    if (currentRecollection) typeEligibleUses.push("current_recollection");
    if (typeEligibleUses.includes(use)) return;
    issues.push({
      field: `decision.selectedBasis.evidenceUses[${index}].use`,
      evidenceId,
      requestedUse: use,
      actualKind: source.kind,
      hasObject,
      currentRecollection,
      typeEligibleUses,
      message:
        use === "current_recollection"
          ? "Current recollection basis requires a current memory reading (kind=recollection and recollection.current=true). A historical reading does not establish that its revision remains current."
          : "Current object basis requires an observed object (kind=observation and a top-level object). A Tool read remains an effect even when its text says observe. History can describe that read; preserve currentClaimRefs and the selected Intent for any current facts or goal the action depends on. Execution still checks actual domain revisions and capabilities.",
    });
  });
  if (issues.length) throw new CognitionSourceUseError(issues);
}

function validateSituation(
  situation: CognitionSituation,
  evidence: ReadonlyMap<string, CognitionEvidence>,
): void {
  for (const episode of situation.episodes) {
    requireEvidence(episode.evidenceIds, evidence);
    if (episode.endedAt && episode.endedAt < episode.startedAt) {
      throw new CognitionConflictError("Episode ends before it begins");
    }
  }
  for (const claim of situation.claims) {
    const supports = requireEvidence(claim.evidenceIds, evidence);
    requireEvidence(claim.contradictingEvidenceIds, evidence);
    requireEvidence(claim.historyEvidenceIds ?? [], evidence);
    if (supports.length === 0 && claim.state === "supported") {
      throw new CognitionConflictError("Supported claim has no evidence");
    }
    if (
      claim.basis === "observed" &&
      supports.some(
        (item) =>
          item.kind !== "observation" &&
          item.kind !== "effect" &&
          !(
            item.kind === "recollection" &&
            item.recollection?.basis === "direct_observation" &&
            (item.recollection.historyStatus === "current" ||
              item.recollection.historyStatus === "retained_history")
          ),
      )
    ) {
      throw new CognitionConflictError(
        "Observed claim contains non-observation evidence",
      );
    }
    if (
      claim.basis === "reported" &&
      (supports.some(
        (item) =>
          item.kind === "recollection" &&
          item.recollection?.basis !== "explicit_user_statement",
      ) ||
        !supports.some(
          (item) =>
            item.kind === "utterance" ||
            (item.kind === "recollection" &&
              item.recollection?.basis === "explicit_user_statement"),
        ))
    ) {
      throw new CognitionConflictError(
        "Reported claim requires an actual utterance or explicitly reported memory",
      );
    }
  }
}

function validateIntent(
  intent: CognitionIntent,
  previous: CognitionIntent | undefined,
  evidence: ReadonlyMap<string, CognitionEvidence>,
  retainedUserGrounding?: CognitionEvidence,
  inputReference = intent.id,
  completionOperation: "keep" | "set" | "clear" = "keep",
  completionInput?: Pick<
    CognitionDecisionAttempt,
    "dependencies" | "allocation"
  >,
  actualEvidence: ReadonlyMap<string, CognitionEvidence> = evidence,
): void {
  if (
    previous?.blockers.includes(CHARACTER_LIFE_PAUSED_BLOCKER) &&
    (!intent.blockers.includes(CHARACTER_LIFE_PAUSED_BLOCKER) ||
      intent.status !== "suspended")
  ) {
    throw new CognitionConflictError(
      "Analysis cannot override a paused autonomous life; resume through its product Tool",
    );
  }
  const supports = requireEvidence(intent.evidenceIds, evidence);
  const effects = requireEvidence(intent.effectEvidenceIds, evidence);
  if (intent.owner === "character" && intent.basis !== "character") {
    throw new CognitionConflictError(
      "Character intent cannot claim user ownership",
    );
  }
  if (intent.owner === "user" && intent.basis === "character") {
    throw new CognitionConflictError(
      "User intent cannot be invented as a character goal",
    );
  }
  // Retained support only preserves an existing request's qualification. It is
  // not a newly supplied source, an action dependency or a completion receipt.
  const retainsUserRequest =
    previous?.owner === "user" &&
    previous.basis === "explicit_user" &&
    intent.owner === previous.owner &&
    intent.basis === previous.basis &&
    retainedUserGrounding?.personaId === intent.personaId &&
    retainedUserGrounding.kind === "utterance" &&
    retainedUserGrounding.actor === "user";
  if (
    intent.basis === "explicit_user" &&
    !supports.some(
      (item) => item.kind === "utterance" && item.actor === "user",
    ) &&
    !retainsUserRequest
  ) {
    throw new CognitionConflictError(
      "Explicit user intent requires a user utterance",
    );
  }
  if (intent.basis === "inferred_user" && intent.status === "active") {
    throw new CognitionConflictError(
      "Inferred user goal cannot become an adopted action intent",
    );
  }
  const rejectCompletion = (reason: string): never => {
    throw new CognitionConflictError(
      "Intent completion requires a performed effect, user report or completed reply. " +
        `Intent ${JSON.stringify(inputReference)}: ${previous?.status ?? "new"} -> ${intent.status}. ` +
        `${reason} Referenced effect evidence: ${JSON.stringify(
          effects.map((item) => ({
            evidenceId: item.id,
            kind: item.kind,
            outcome: item.effect?.outcome ?? null,
          })),
        )}. ` +
        "kind=effect does not mean outcome=performed; success wording in text or description cannot upgrade unknown, partial, not_performed, or a missing outcome to performed. " +
        "Keep completion unverified until supported by relevant evidence; unknown does not mean failure. " +
        "A user request or question is not a report that the requested action was completed.",
    );
  };
  const preserved =
    completionInput?.allocation?.intents?.find(({ id }) => id === intent.id)
      ?.preservedFields ?? [];
  if (intent.status !== "fulfilled") {
    if (intent.completion)
      rejectCompletion(
        "A non-fulfilled intent cannot retain current completion.",
      );
    if (previous?.status === "fulfilled" && completionOperation !== "clear")
      rejectCompletion(
        "Leaving fulfilled requires explicit completion clear; execution history remains separate.",
      );
    return;
  }
  if (completionOperation === "clear")
    rejectCompletion("Clearing completion cannot preserve fulfilled.");
  const changedMeaning =
    previous &&
    ["owner", "basis", "goal", "successCriteria"].some(
      (field) =>
        JSON.stringify(intent[field as keyof CognitionIntent]) !==
        JSON.stringify(previous[field as keyof CognitionIntent]),
    );
  const changedCompletion =
    !preserved.includes("completion") &&
    JSON.stringify(intent.completion) !== JSON.stringify(previous?.completion);
  const newAssertion =
    previous?.status !== "fulfilled" ||
    changedMeaning ||
    changedCompletion ||
    completionOperation === "set";
  if (!newAssertion) return; // Preserve the canonical declaration, including old absent values, without inventing a receipt.
  if (previous && completionOperation !== "set")
    rejectCompletion(
      "A new or changed fulfilled assertion requires explicit completion set.",
    );
  if (preserved.includes("goal") || preserved.includes("successCriteria"))
    rejectCompletion(
      "The goal and success criteria must be visible for a new completed assertion.",
    );
  if (!intent.completion?.evidenceUses.length)
    rejectCompletion(
      "Select independent completion.evidenceUses; general request/progress references are not completion evidence.",
    );
  const supplied = new Set(
    completionInput?.dependencies.evidenceIds ?? evidence.keys(),
  );
  const used = new Set<string>();
  for (const use of intent.completion!.evidenceUses) {
    const item = evidence.get(use.evidenceId);
    if (
      !supplied.has(use.evidenceId) ||
      !item ||
      item.personaId !== intent.personaId
    )
      rejectCompletion(
        `Completion evidence ${JSON.stringify(use.evidenceId)} was not supplied for this Persona.`,
      );
    if (used.has(use.evidenceId))
      rejectCompletion("Completion evidence IDs must be unique.");
    used.add(use.evidenceId);
    if (!isIntentCompletionEvidence(use.basis, item!))
      rejectCompletion(
        `Invalid completion use ${JSON.stringify({ ...use, kind: item!.kind, outcome: item!.effect?.outcome ?? null })}.`,
      );
    if (use.basis === "completed_reply") {
      const visible = actualEvidence.get(use.evidenceId);
      const text = visible?.text?.trim();
      if (
        !visible ||
        visible.personaId !== intent.personaId ||
        !isIntentCompletionEvidence(use.basis, visible) ||
        visible.bodyReleasedAt ||
        !text ||
        text === INCOMPLETE_RECEIPT
      )
        rejectCompletion(
          "A new completed_reply requires actual visible reply text; metadata, released bodies and empty excerpts do not supply it.",
        );
    }
  }
}

/** Resolves local references and validates evidence before a single database commit. */
export function resolveCognitionAnalysis(
  snapshot: CognitionSnapshot,
  analysis: CognitionAnalysis,
  now: string,
  createId: () => string = randomUUID,
  retainedUserIntentGroundings: ReadonlyMap<
    string,
    CognitionEvidence
  > = new Map(),
  completionInput?: Pick<
    CognitionDecisionAttempt,
    "dependencies" | "allocation"
  >,
  actualSuppliedEvidence: readonly CognitionEvidence[] = snapshot.evidence,
): ResolvedCognitionAnalysis {
  const evidence = new Map(snapshot.evidence.map((value) => [value.id, value]));
  const actualEvidence = new Map(
    actualSuppliedEvidence.map((value) => [value.id, value]),
  );
  const previousSituations = new Map(
    snapshot.situations.map((value) => [value.id, value]),
  );
  const previousIntents = new Map(
    snapshot.intents.map((value) => [value.id, value]),
  );
  const localIds = new Map<string, string>();
  const inputReferences = new Map<string, string>();
  for (const item of [
    ...analysis.delta.createSituations,
    ...analysis.delta.createIntents,
  ]) {
    if (!item.localId.startsWith("new:") || localIds.has(item.localId)) {
      throw new CognitionConflictError(
        "New entities require distinct new: local references",
      );
    }
    const id = createId();
    localIds.set(item.localId, id);
    inputReferences.set(id, item.localId);
  }
  const resolve = (id: string): string => localIds.get(id) ?? id;
  const remapSituation = (value: CognitionSituation): CognitionSituation => ({
    ...value,
    relatedSituationIds: value.relatedSituationIds.map(resolve),
    ...(value.supersededBy
      ? { supersededBy: resolve(value.supersededBy) }
      : {}),
  });
  const remapIntent = (value: CognitionIntent): CognitionIntent => ({
    ...value,
    ...(value.situationId ? { situationId: resolve(value.situationId) } : {}),
  });
  const situations = analysis.delta.createSituations.map(({ localId, value }) =>
    remapSituation({
      ...value,
      id: resolve(localId),
      personaId: snapshot.attention.personaId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }),
  );
  for (const update of analysis.delta.updateSituations) {
    const previous = previousSituations.get(update.id);
    if (!previous || previous.revision !== update.expectedRevision) {
      throw new CognitionConflictError(`Situation changed: ${update.id}`);
    }
    situations.push(
      remapSituation({
        ...update.value,
        id: previous.id,
        personaId: previous.personaId,
        revision: previous.revision + 1,
        createdAt: previous.createdAt,
        updatedAt: now,
      }),
    );
  }
  const intents = analysis.delta.createIntents.map(({ localId, value }) =>
    remapIntent({
      ...value,
      id: resolve(localId),
      personaId: snapshot.attention.personaId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }),
  );
  for (const update of analysis.delta.updateIntents) {
    const previous = previousIntents.get(update.id);
    if (!previous || previous.revision !== update.expectedRevision) {
      throw new CognitionConflictError(`Intent changed: ${update.id}`);
    }
    intents.push(
      remapIntent({
        ...update.value,
        id: previous.id,
        personaId: previous.personaId,
        revision: previous.revision + 1,
        createdAt: previous.createdAt,
        updatedAt: now,
      }),
    );
  }
  const situationIds = new Set([
    ...previousSituations.keys(),
    ...situations.map(({ id }) => id),
  ]);
  const intentIds = new Set([
    ...previousIntents.keys(),
    ...intents.map(({ id }) => id),
  ]);
  for (const situation of situations) {
    validateSituation(situation, evidence);
    const previous = previousSituations.get(situation.id);
    // A bounded view can carry an existing link without expanding its historical target.
    // Preserving that exact relation does not grant edit/focus/action access to the target.
    for (const id of situation.relatedSituationIds) {
      if (!situationIds.has(id) && !previous?.relatedSituationIds.includes(id))
        throw new CognitionConflictError(`Unknown related situation: ${id}`);
    }
    if (
      situation.supersededBy &&
      !situationIds.has(situation.supersededBy) &&
      previous?.supersededBy !== situation.supersededBy
    )
      throw new CognitionConflictError(
        `Unknown related situation: ${situation.supersededBy}`,
      );
  }
  for (const intent of intents) {
    validateIntent(
      intent,
      previousIntents.get(intent.id),
      evidence,
      retainedUserIntentGroundings.get(intent.id),
      inputReferences.get(intent.id) ?? intent.id,
      analysis.delta.updateIntents.find(({ id }) => id === intent.id)
        ?.completionOperation ?? "keep",
      completionInput,
      actualEvidence,
    );
    // Completed effects remain execution history after the current completion is cleared.
    intent.effectEvidenceIds = [
      ...new Set([
        ...(previousIntents.get(intent.id)?.status === "fulfilled"
          ? previousIntents.get(intent.id)!.effectEvidenceIds
          : []),
        ...intent.effectEvidenceIds,
        ...(intent.completion?.evidenceUses
          .filter(({ basis }) => basis === "performed_effect")
          .map(({ evidenceId }) => evidenceId) ?? []),
      ]),
    ];
    if (
      intent.situationId &&
      !situationIds.has(intent.situationId) &&
      previousIntents.get(intent.id)?.situationId !== intent.situationId
    ) {
      throw new CognitionConflictError(
        `Unknown intent situation: ${intent.situationId}`,
      );
    }
  }
  const choices = analysis.decision.choices.map((choice) => ({
    ...choice,
    ...(choice.situationId ? { situationId: resolve(choice.situationId) } : {}),
    ...(choice.intentId ? { intentId: resolve(choice.intentId) } : {}),
  }));
  if (!choices.some(({ id }) => id === analysis.decision.selectedChoiceId)) {
    throw new CognitionConflictError("Selected choice is absent");
  }
  if (new Set(choices.map(({ id }) => id)).size !== choices.length) {
    throw new CognitionConflictError("Decision choices must have distinct IDs");
  }
  for (const choice of choices) {
    const referenced = requireEvidence(choice.evidenceIds, evidence);
    const targetChatIds = new Set(
      referenced.flatMap((item) => (item.chatId ? [item.chatId] : [])),
    );
    const associatedCues = choiceOpportunityEvidence(choice, {
      ...snapshot,
      situations: [
        ...situations,
        ...snapshot.situations.filter(
          (item) => !situations.some(({ id }) => id === item.id),
        ),
      ],
      intents: [
        ...intents,
        ...snapshot.intents.filter(
          (item) => !intents.some(({ id }) => id === item.id),
        ),
      ],
    });
    const cueChats = new Set(
      [...referenced, ...associatedCues].flatMap((item) =>
        item.opportunity ? [item.opportunity.targetChatId] : [],
      ),
    );
    if (
      choice.kind !== "remain_quiet" &&
      (referenced.some((item) => item.opportunity?.status === "cancelled") ||
        associatedCues.some((item) => !choice.evidenceIds.includes(item.id)))
    )
      throw new CognitionConflictError(
        "Important-moment action must cite its current due evidence",
      );
    if (
      choice.chatId &&
      !targetChatIds.has(choice.chatId) &&
      !cueChats.has(choice.chatId)
    )
      throw new CognitionConflictError(
        "Choice Chat is not linked to its supplied evidence",
      );
    if (
      choice.kind !== "remain_quiet" &&
      cueChats.size &&
      (cueChats.size !== 1 || !choice.chatId || !cueChats.has(choice.chatId))
    )
      throw new CognitionConflictError(
        "Important-moment choice must use its source Chat",
      );
    if (choice.situationId && !situationIds.has(choice.situationId)) {
      throw new CognitionConflictError("Choice refers to an unknown situation");
    }
    if (choice.intentId && !intentIds.has(choice.intentId)) {
      throw new CognitionConflictError("Choice refers to an unknown intent");
    }
  }
  const selected = choices.find(
    ({ id }) => id === analysis.decision.selectedChoiceId,
  )!;
  const basis = analysis.decision.selectedBasis;
  if (basis.choiceId !== selected.id)
    throw new CognitionConflictError(
      "Selected basis must match selected choice",
    );
  const uses = new Set(basis.evidenceUses.map(({ evidenceId }) => evidenceId));
  if (
    uses.size !== basis.evidenceUses.length ||
    new Set(selected.evidenceIds).size !== selected.evidenceIds.length ||
    uses.size !== selected.evidenceIds.length ||
    selected.evidenceIds.some((id) => !uses.has(id))
  )
    throw new CognitionConflictError(
      "Selected basis must cover exactly the selected evidence once",
    );
  validateCognitionSourceUses(basis.evidenceUses, evidence);
  const currentClaimRefs = basis.currentClaimRefs.map((ref) => ({
    ...ref,
    situationId: resolve(ref.situationId),
  }));
  if (
    new Set(
      currentClaimRefs.map(({ situationId, claimId }) =>
        JSON.stringify([situationId, claimId]),
      ),
    ).size !== currentClaimRefs.length
  )
    throw new CognitionConflictError(
      "Selected claim references must be unique",
    );
  for (const { situationId, claimId } of currentClaimRefs) {
    const situation =
      situations.find(({ id }) => id === situationId) ??
      previousSituations.get(situationId);
    const claim = situation?.claims.find(({ id }) => id === claimId);
    if (!claim)
      throw new CognitionConflictError(
        "Selected claim was not supplied or created",
      );
    if (
      [...claim.evidenceIds, ...claim.contradictingEvidenceIds].some(
        (id) => !uses.has(id),
      )
    )
      throw new CognitionConflictError(
        "Selected current claim requires all support and contradiction sources to be declared",
      );
  }
  const requestedContinuation = basis.requestedContinuation
    ? {
        ...basis.requestedContinuation,
        conditionClaimRefs: basis.requestedContinuation.conditionClaimRefs.map(
          (ref) => ({ ...ref, situationId: resolve(ref.situationId) }),
        ),
      }
    : undefined;
  if (requestedContinuation) {
    const request = requireEvidence(
      [requestedContinuation.requestEvidenceId],
      evidence,
    )[0]!;
    const intent =
      intents.find(({ id }) => id === selected.intentId) ??
      previousIntents.get(selected.intentId ?? "");
    if (
      selected.kind !== "continue_shared" ||
      selected.executionScope !== "conversation" ||
      selected.timing !== "now" ||
      intent?.status !== "active" ||
      intent.owner !== "user" ||
      intent.basis !== "explicit_user" ||
      !intent.evidenceIds.includes(request.id) ||
      !uses.has(request.id) ||
      request.actor !== "user" ||
      request.kind !== "utterance" ||
      request.source.kind !== "run" ||
      !request.source.fragment ||
      request.source.revision !== "completed" ||
      !request.chatId ||
      selected.chatId !== request.chatId
    )
      throw new CognitionConflictError(
        "Requested continuation requires its supplied actual user request, active explicit intent and original Chat",
      );
    const current = new Set(
      currentClaimRefs.map(({ situationId, claimId }) =>
        JSON.stringify([situationId, claimId]),
      ),
    );
    for (const ref of requestedContinuation.conditionClaimRefs) {
      const situation =
        situations.find(({ id }) => id === ref.situationId) ??
        previousSituations.get(ref.situationId);
      const claim = situation?.claims.find(({ id }) => id === ref.claimId);
      if (
        !current.has(JSON.stringify([ref.situationId, ref.claimId])) ||
        !claim ||
        claim.state !== "supported" ||
        claim.basis === "inferred" ||
        claim.contradictingEvidenceIds.length > 0 ||
        !claim.evidenceIds.some((id) => {
          const source = evidence.get(id);
          return (
            source &&
            source.receiptSequence > request.receiptSequence &&
            (source.kind === "observation" ||
              source.kind === "effect" ||
              (source.kind === "utterance" && source.actor === "user"))
          );
        })
      )
        throw new CognitionConflictError(
          "Requested continuation conditions require current supported claims and actual evidence received after the request",
        );
    }
  }
  const waiting = basis.waitingInputContinuation;
  if (waiting) {
    const request = requireEvidence([waiting.requestEvidenceId], evidence)[0]!;
    const intent =
      intents.find(({ id }) => id === selected.intentId) ??
      previousIntents.get(selected.intentId ?? "");
    const newMaterial = basis.evidenceUses.some(({ evidenceId: id, use }) => {
      const source = evidence.get(id);
      return (
        (use === "current_object" || use === "current_foreground") &&
        source?.kind === "observation" &&
        source.source.kind === "activity" &&
        (source.actor === "user" || source.actor === "unknown") &&
        source.receiptSequence > request.receiptSequence
      );
    });
    if (
      requestedContinuation ||
      selected.kind !== "continue_shared" ||
      selected.executionScope !== "conversation" ||
      selected.reversibility !== "read_only" ||
      selected.timing !== "now" ||
      intent?.status !== "active" ||
      intent.owner !== "user" ||
      intent.basis !== "explicit_user" ||
      !intent.evidenceIds.includes(request.id) ||
      !uses.has(request.id) ||
      request.actor !== "user" ||
      request.kind !== "utterance" ||
      request.source.kind !== "run" ||
      request.source.id !== waiting.runId ||
      !request.source.fragment ||
      request.source.revision !== "completed" ||
      !request.chatId ||
      selected.chatId !== request.chatId ||
      !newMaterial
    )
      throw new CognitionConflictError(
        "Waiting input continuation requires its original user Run, active explicit intent and selected new current environment material",
      );
  }
  const currentSituationId = analysis.delta.attention.currentSituationId
    ? resolve(analysis.delta.attention.currentSituationId)
    : undefined;
  const committedIntentId = analysis.delta.attention.committedIntentId
    ? resolve(analysis.delta.attention.committedIntentId)
    : undefined;
  if (currentSituationId && !situationIds.has(currentSituationId)) {
    throw new CognitionConflictError(
      "Attention refers to an unknown situation",
    );
  }
  if (committedIntentId && !intentIds.has(committedIntentId)) {
    throw new CognitionConflictError("Attention refers to an unknown intent");
  }
  return {
    situations,
    intents,
    decision: {
      ...analysis.decision,
      choices,
      selectedBasis: {
        ...basis,
        currentClaimRefs,
        ...(requestedContinuation ? { requestedContinuation } : {}),
      },
    },
    ...(analysis.recallPlan
      ? {
          recallPlan: {
            ...analysis.recallPlan,
            ...(analysis.recallPlan.situationId
              ? { situationId: resolve(analysis.recallPlan.situationId) }
              : {}),
          },
        }
      : {}),
    ...(currentSituationId ? { currentSituationId } : {}),
    ...(committedIntentId ? { committedIntentId } : {}),
  };
}

/** Follow the actual choice/intent/situation provenance, never an unrelated scheduled cue. */
export function choiceOpportunityEvidence(
  choice: CognitionChoice,
  snapshot: CognitionSnapshot,
): CognitionEvidence[] {
  const ids = new Set(choice.evidenceIds);
  const intent = snapshot.intents.find(({ id }) => id === choice.intentId);
  intent?.evidenceIds.forEach((id) => ids.add(id));
  const situation = snapshot.situations.find(
    ({ id }) => id === (choice.situationId ?? intent?.situationId),
  );
  situation?.episodes.forEach((episode) =>
    episode.evidenceIds.forEach((id) => ids.add(id)),
  );
  return snapshot.evidence.filter(
    (item) => ids.has(item.id) && item.opportunity?.status === "due",
  );
}

export function opportunityIsCurrent(
  item: CognitionEvidence,
  snapshot: CognitionSnapshot,
  now: string,
): boolean {
  const cue = item.opportunity;
  if (
    !cue ||
    cue.status !== "due" ||
    cue.evaluateAt > now ||
    cue.occursAt <= now
  )
    return false;
  return !snapshot.evidence.some(
    (newer) =>
      newer.receiptSequence > item.receiptSequence &&
      (newer.opportunity?.id === cue.id ||
        (newer.source.kind === "memory" &&
          newer.source.id === item.source.id &&
          newer.opportunity &&
          newer.source.revision !== item.source.revision)),
  );
}

export function entityDependenciesAreCurrent(
  attempt: CognitionDecisionAttempt,
  snapshot: CognitionSnapshot,
): boolean {
  return (
    attempt.dependencies.situations.every(({ id, revision }) =>
      snapshot.situations.some(
        (value) => value.id === id && value.revision === revision,
      ),
    ) &&
    attempt.dependencies.intents.every(({ id, revision }) =>
      snapshot.intents.some(
        (value) => value.id === id && value.revision === revision,
      ),
    )
  );
}

export function choiceBlockReason(
  choice: CognitionChoice,
  snapshot: {
    readonly intents: readonly Pick<
      CognitionIntent,
      "id" | "status" | "basis" | "owner"
    >[];
  },
  availability: CognitionRuntimeAvailability,
): string | undefined {
  if (choice.kind === "remain_quiet") return undefined;
  if (availability.sleeping) return "sleeping";
  if (choice.timing !== "now") return "deferred_by_decision";
  if (
    availability.userEngaged ||
    availability.activeVoice ||
    availability.activeUserRunIds.length > 0
  ) {
    return "user_has_attention";
  }
  if (
    availability.activeCharacterRunId &&
    availability.activeCharacterRunId !== availability.continuableInput?.runId
  )
    return "character_run_active";
  if (
    availability.waitingIntentRunIds?.length &&
    !availability.waitingIntentRunIds.includes(
      availability.continuableInput?.runId ?? "",
    )
  )
    return "waiting_input_requires_original_run";
  const selectedChatId = availability.selectedChatId ?? choice.chatId;
  const chatRun = availability.chatRuns.find(
    ({ chatId }) => chatId === selectedChatId,
  );
  if (
    chatRun &&
    (chatRun.status !== "needs_input" ||
      chatRun.runId !== availability.continuableInput?.runId ||
      chatRun.waitingInput?.itemId !== availability.continuableInput.itemId)
  )
    return "chat_has_active_turn";

  const intent = choice.intentId
    ? snapshot.intents.find(({ id }) => id === choice.intentId)
    : undefined;
  if (choice.intentId && (!intent || intent.status !== "active"))
    return "intent_not_active";
  if (
    intent?.basis === "inferred_user" &&
    choice.executionScope !== "conversation"
  ) {
    return "inferred_goal_is_not_authorization";
  }
  if (
    choice.executionScope === "external" &&
    intent?.basis !== "explicit_user"
  ) {
    return "external_action_requires_explicit_intent";
  }
  if (choice.executionScope === "territory" && !availability.mayActInTerritory)
    return "territory_unavailable";
  if (choice.kind === "continue_character" && intent?.owner !== "character")
    return "not_character_intent";
  if (
    choice.executionScope === "conversation" &&
    (!availability.mayInitiateConversation || availability.hasOutstandingBubble)
  ) {
    return "conversation_delivery_unavailable";
  }
  return undefined;
}

/** A prior selection grants readability only; its instruction and old body are not reused. */
export function latestSelectedContextIntent(
  snapshot: CognitionSnapshot,
): string | undefined {
  const attempt = snapshot.recentAttempts[0];
  if (attempt?.projection !== "complete") return undefined;
  const decision = attempt?.decision;
  const binding = attempt?.actionReadSet;
  const choice = decision?.choices.find(
    ({ id }) => id === decision.selectedChoiceId,
  );
  const selected = binding?.selectedIntent;
  if (
    !attempt ||
    !decision ||
    !binding ||
    !selected ||
    !choice ||
    !["ready", "dispatched", "settled"].includes(attempt.status) ||
    attempt.personaId !== snapshot.attention.personaId ||
    attempt.dependencies.personaId !== attempt.personaId ||
    decision.selectedBasis.choiceId !== choice.id ||
    binding.choiceId !== choice.id ||
    choice.intentId !== selected.id ||
    !attempt.dependencies.intents.some(
      ({ id, revision }) =>
        id === selected.id && revision === selected.revision,
    )
  )
    return undefined;
  return selected.id;
}

/** Budget is allocated by ContextCompiler. Without readCoverage the caller
 * explicitly supplies a complete in-memory view; production preparation always
 * passes actual database coverage. No second production read path lives here. */
export function projectCognitionContext(
  snapshot: CognitionSnapshot,
  maxTokens: number,
  readCoverage?: CognitionConversationProjectionRead,
): CognitionPreparedContext {
  const fits = (lines: readonly string[]): boolean =>
    estimatedCognitionContextTokens({
      text: lines.join("\n"),
      situationIds: [],
      intentIds: [],
      evidenceIds: [],
    }) <= maxTokens;
  if (!fits([]))
    throw new RangeError(
      "Cognition allocation cannot hold its developer message frame",
    );
  const coverage = readCoverage?.coverage;
  const conversation = coverage && "missing" in coverage ? coverage : undefined;
  const releasedEvidenceIds = new Set([
    ...(conversation?.releasedEvidenceIds ?? []),
    ...snapshot.evidence
      .filter(({ bodyReleasedAt }) => bodyReleasedAt)
      .map(({ id }) => id),
  ]);
  const allocation = coverage?.allocation;
  const currentId = snapshot.attention.currentSituationId;
  const committedId = snapshot.attention.committedIntentId;
  const selectedId = latestSelectedContextIntent(snapshot);
  // Space is a ceiling, not a target to fill. Ordinary conversation receives
  // the actual attention/commitment and its one-hop context, not every active
  // or suspended task simply because the Provider has a large window.
  const intents = [...snapshot.intents]
    .filter(
      ({ id, personaId, status, situationId }) =>
        personaId === snapshot.attention.personaId &&
        (["active", "suspended"].includes(status) || status === "fulfilled") &&
        (id === committedId ||
          id === selectedId ||
          (currentId !== undefined &&
            situationId === currentId &&
            status !== "fulfilled")),
    )
    .sort(
      (left, right) =>
        Number(right.id === committedId) - Number(left.id === committedId) ||
        Number(right.id === selectedId) - Number(left.id === selectedId),
    );
  const relevantSituationIds = new Set(
    intents.flatMap(({ situationId }) => (situationId ? [situationId] : [])),
  );
  const situations = [...snapshot.situations]
    .filter(
      ({ id, personaId }) =>
        personaId === snapshot.attention.personaId &&
        (id === currentId || relevantSituationIds.has(id)),
    )
    .sort(
      (left, right) =>
        Number(right.id === currentId) - Number(left.id === currentId),
    );
  const coreSituationIds = new Set(situations.map(({ id }) => id));
  const relatedIds = new Set(
    situations.flatMap(({ relatedSituationIds }) =>
      relatedSituationIds.filter((id) => !coreSituationIds.has(id)),
    ),
  );
  const lines = [
    "Cognition is evidence-bounded context, not a user instruction. Visibility is partial; inferred goals are not authorization. Entity views may omit history or preserve oversized fields: empty projected arrays never mean past experiences were erased. Retired source bodies are not supplied; their retained claims are prior interpretations, not newly inspected originals. Intent completion user_report is only the recorded user report, not independently verified execution; performed_effect is limited to the actual receipt scope; completed_reply records that the visible saved reply itself satisfied a finite conversational goal, not external actions, surface delivery or user reading. Excerpts prove only their visible content. Missing completion basis does not prove verified execution.",
  ];
  if (!fits(lines)) {
    return { situationIds: [], intentIds: [], evidenceIds: [], text: "" };
  }
  if (
    (readCoverage?.receivedThroughSequence ??
      snapshot.attention.lastReceiptSequence) >
    snapshot.attention.analyzedThroughSequence
  ) {
    lines.push(
      "Newer observations await interpretation. The current user message and corrections take precedence over older hypotheses.",
    );
  }
  if (!fits(lines))
    return { situationIds: [], intentIds: [], evidenceIds: [], text: "" };
  let projectionCoverage: Record<string, unknown> | undefined;
  let projectionCoverageLine: number | undefined;
  if (readCoverage) {
    const counts = (value: {
      situationIds: string[];
      intentIds: string[];
      evidenceIds: string[];
    }) => ({
      situations: value.situationIds.length,
      intents: value.intentIds.length,
      evidence: value.evidenceIds.length,
    });
    projectionCoverage = {
      omittedForTokens: false,
      ...(currentId ? { currentSituationId: currentId } : {}),
      ...(committedId ? { committedIntentId: committedId } : {}),
      receivedThroughSequence: readCoverage.receivedThroughSequence,
      analyzedThroughSequence: snapshot.attention.analyzedThroughSequence,
      ...(conversation
        ? {
            missing: counts(conversation.missing),
            omittedForResource: counts(conversation.omittedForResource),
            releasedEvidence: conversation.releasedEvidenceIds.length,
            selectionOmittedForResource:
              conversation.selectionOmittedForResource,
          }
        : { boundedAnalysisView: true }),
      partialSituations: allocation?.situations.length ?? 0,
      partialIntents: allocation?.intents?.length ?? 0,
      excerptedEvidence: coverage?.excerptedEvidenceIds.length ?? 0,
    };
    const line = JSON.stringify({ conversationRead: projectionCoverage });
    if (!fits([...lines, line]))
      return { situationIds: [], intentIds: [], evidenceIds: [], text: "" };
    projectionCoverageLine = lines.length;
    lines.push(line);
  }
  // Reserve the longest coverage representation before allocating content.
  // Direct related state can explain the current thread without reviving its goals.
  const relatedCoverage = {
    missing: false,
    omittedForBudget: false,
    unloaded: false,
    released: false,
  };
  const relatedCoverageLine = relatedIds.size ? lines.length : undefined;
  if (relatedCoverageLine !== undefined) {
    const line = JSON.stringify({ relatedContext: relatedCoverage });
    if (!fits([...lines, line]))
      return { situationIds: [], intentIds: [], evidenceIds: [], text: "" };
    lines.push(line);
  }
  const selectedIntents: string[] = [];
  const selectedSituations: string[] = [];
  const evidenceIds = new Set<string>();
  const append = (value: unknown): boolean => {
    const line = JSON.stringify(value);
    // Account for the actual message serialization, including JSON escaping.
    if (!fits([...lines, line])) {
      if (projectionCoverage) projectionCoverage["omittedForTokens"] = true;
      return false;
    }
    lines.push(line);
    return true;
  };
  for (const intent of intents) {
    const partial = allocation?.intents?.find(({ id }) => id === intent.id);
    const preserved = partial?.preservedFields ?? [];
    if (
      !append({
        intent: {
          id: intent.id,
          revision: intent.revision,
          owner: intent.owner,
          basis: intent.basis,
          status: intent.status,
          ...(!preserved.includes("goal") ? { goal: intent.goal } : {}),
          ...(!preserved.includes("progress")
            ? { progress: intent.progress }
            : {}),
          ...(!preserved.includes("completion") && intent.completion
            ? { completion: intent.completion }
            : {}),
          ...(!preserved.includes("blockers")
            ? { blockers: intent.blockers }
            : {}),
          evidenceIds: intent.evidenceIds,
        },
        ...(partial
          ? {
              visibility: {
                unloadedFields: preserved,
                sourceIdsComplete: conversation
                  ? !conversation.incompleteIntentSources.includes(intent.id)
                  : false,
              },
            }
          : {}),
      })
    )
      continue;
    selectedIntents.push(intent.id);
    intent.evidenceIds.forEach((id) => evidenceIds.add(id));
    intent.effectEvidenceIds.forEach((id) => evidenceIds.add(id));
    intent.completion?.evidenceUses.forEach(({ evidenceId }) =>
      evidenceIds.add(evidenceId),
    );
  }
  const appendSituation = (situation: CognitionSituation): boolean => {
    const partial = allocation?.situations.find(
      ({ id }) => id === situation.id,
    );
    const preserved = partial?.preservedFields ?? [];
    const claimsComplete = conversation
      ? !conversation.incompleteSituationClaims.includes(situation.id)
      : !partial;
    if (
      !append({
        situation: {
          id: situation.id,
          revision: situation.revision,
          ...(!preserved.includes("title") ? { title: situation.title } : {}),
          ...(!preserved.includes("summary")
            ? { summary: situation.summary }
            : {}),
          status: situation.status,
          ...(claimsComplete || situation.claims.length
            ? { claims: situation.claims }
            : {}),
          ...(!preserved.includes("unresolved")
            ? { unresolved: situation.unresolved }
            : {}),
        },
        ...(partial
          ? { visibility: { unloadedFields: preserved, claimsComplete } }
          : {}),
      })
    )
      return false;
    selectedSituations.push(situation.id);
    situation.claims.forEach((claim) =>
      [...claim.evidenceIds, ...claim.contradictingEvidenceIds].forEach((id) =>
        evidenceIds.add(id),
      ),
    );
    return true;
  };
  for (const situation of situations) {
    appendSituation(situation);
  }
  const selectedEvidence: string[] = [];
  for (const item of snapshot.evidence.filter(
    ({ id }) => evidenceIds.has(id) && !releasedEvidenceIds.has(id),
  )) {
    if (append({ evidence: item })) selectedEvidence.push(item.id);
  }
  for (const id of evidenceIds) {
    const missing = conversation?.missing.evidenceIds.includes(id);
    const unread = conversation?.omittedForResource.evidenceIds.includes(id);
    if (releasedEvidenceIds.has(id))
      append({ evidenceGap: { id, reason: "released" } });
    else if (missing || unread)
      append({
        evidenceGap: {
          id,
          reason: missing ? "missing" : "unloaded_for_resource",
        },
      });
  }
  // Preserve core bodies AND their original evidence before adding historical
  // context. Appending all related bodies first would crowd out current sources.
  const selectedCoreIds = new Set(selectedSituations);
  const coreEvidenceIds = new Set(evidenceIds);
  const availableById = new Map(
    snapshot.situations.map((value) => [value.id, value]),
  );
  const relatedEvidenceIds = new Set<string>();
  for (const id of relatedIds) {
    if (
      !situations.some(
        (value) =>
          selectedCoreIds.has(value.id) &&
          value.relatedSituationIds.includes(id),
      )
    ) {
      relatedCoverage.omittedForBudget = true;
      continue;
    }
    const related = availableById.get(id);
    if (!related || related.personaId !== snapshot.attention.personaId) {
      if (!readCoverage || conversation?.missing.situationIds.includes(id))
        relatedCoverage.missing = true;
      else relatedCoverage.unloaded = true;
      continue;
    }
    if (!appendSituation(related)) {
      relatedCoverage.omittedForBudget = true;
      continue;
    }
    for (const claim of related.claims) {
      for (const evidenceId of [
        ...claim.evidenceIds,
        ...claim.contradictingEvidenceIds,
      ])
        relatedEvidenceIds.add(evidenceId);
    }
  }
  const latest = snapshot.recentAttempts[0];
  const preferredEvidence =
    latest?.projection === "complete"
      ? (latest.decision?.selectedBasis.evidenceUses.map(
          ({ evidenceId }) => evidenceId,
        ) ?? [])
      : [];
  const evidenceById = new Map(
    snapshot.evidence.map((value) => [value.id, value]),
  );
  // Within the related context, actual selected support precedes older support.
  // This does not carry the prior action's instruction into an ordinary user turn.
  for (const id of new Set([...preferredEvidence, ...relatedEvidenceIds])) {
    if (!relatedEvidenceIds.has(id) || selectedEvidence.includes(id)) continue;
    const evidence = evidenceById.get(id);
    if (releasedEvidenceIds.has(id)) {
      relatedCoverage.released = true;
      if (!coreEvidenceIds.has(id))
        append({ evidenceGap: { id, reason: "released" } });
    } else if (!evidence) {
      if (!readCoverage || conversation?.missing.evidenceIds.includes(id))
        relatedCoverage.missing = true;
      else relatedCoverage.unloaded = true;
    } else if (append({ evidence })) selectedEvidence.push(id);
    else relatedCoverage.omittedForBudget = true;
  }
  if (relatedCoverageLine !== undefined)
    lines[relatedCoverageLine] = JSON.stringify({
      relatedContext: relatedCoverage,
    });
  if (projectionCoverageLine !== undefined)
    lines[projectionCoverageLine] = JSON.stringify({
      conversationRead: projectionCoverage,
    });
  return {
    situationIds: selectedSituations,
    intentIds: selectedIntents,
    evidenceIds: selectedEvidence,
    text: lines.join("\n"),
  };
}

export interface CognitionAnalysisSelection {
  snapshot: CognitionSnapshot;
  coverage: CognitionAnalysisCoverage;
}

/** Feedback only: omitted decision/dependencies never grant selected-state use. */
function attemptLifecycle(
  attempt: CognitionSnapshot["recentAttempts"][number],
): Extract<
  CognitionSnapshot["recentAttempts"][number],
  { projection: "lifecycle" }
> {
  return {
    projection: "lifecycle",
    id: attempt.id,
    personaId: attempt.personaId,
    status: attempt.status,
    trigger: attempt.trigger,
    throughSequence: attempt.throughSequence,
    ...(attempt.runId ? { runId: attempt.runId } : {}),
    ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
    ...(attempt.error ? { error: attempt.error } : {}),
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

/**
 * Stable commitments and the oldest unread receipt share the allocation. Large
 * receipts are projected as marked excerpts; persistence keeps their complete
 * original values. Omitted state is not writable by this attempt.
 */
export function selectAnalysisSnapshot(
  snapshot: CognitionSnapshot,
  maxBytes: number,
  sourceCoverage?: CognitionAnalysisCoverage,
  retainedFeedback: ReadonlyArray<
    CognitionSnapshot["recentAttempts"][number]
  > = [],
): CognitionAnalysisSelection {
  // Only the caller's actual first-pass feedback survives a Recall re-read.
  // It remains lifecycle-only, and the new current Attempt keeps first place.
  const attempts = [...snapshot.recentAttempts];
  const feedbackIds = new Set<string>();
  for (const attempt of retainedFeedback) {
    if (
      !attempt.error ||
      (attempt.status !== "failed" && attempt.status !== "superseded")
    )
      continue;
    feedbackIds.add(attempt.id);
    if (!attempts.some(({ id }) => id === attempt.id))
      attempts.push(attemptLifecycle(attempt));
  }
  const coverage: CognitionAnalysisCoverage = {
    ...(sourceCoverage?.sourceCoverage
      ? { sourceCoverage: structuredClone(sourceCoverage.sourceCoverage) }
      : {}),
    ...(sourceCoverage?.stateReferences
      ? { stateReferences: { ...sourceCoverage.stateReferences } }
      : {}),
    excerptedEvidenceIds: [],
    ...(sourceCoverage?.currentViewEvidenceId
      ? { currentViewEvidenceId: sourceCoverage.currentViewEvidenceId }
      : {}),
    ...(sourceCoverage?.currentUserSource
      ? { currentUserSource: structuredClone(sourceCoverage.currentUserSource) }
      : {}),
    ...(sourceCoverage?.passiveSpans
      ? { passiveSpans: sourceCoverage.passiveSpans }
      : {}),
    omittedSituationCount:
      snapshot.situations.length + (sourceCoverage?.omittedSituationCount ?? 0),
    omittedIntentCount:
      snapshot.intents.length + (sourceCoverage?.omittedIntentCount ?? 0),
    omittedAttemptCount:
      attempts.length + (sourceCoverage?.omittedAttemptCount ?? 0),
    ...(sourceCoverage?.allocation
      ? { allocation: structuredClone(sourceCoverage.allocation) }
      : {}),
    ...(sourceCoverage?.moreEvidencePending !== undefined
      ? { moreEvidencePending: sourceCoverage.moreEvidencePending }
      : {}),
    note:
      sourceCoverage?.note ??
      "Only supplied complete situations/intents may be updated. Omitted state remains unchanged. Evidence excerpts are incomplete; source references locate the full persisted receipt. Do not infer unseen details or treat absence from this projection as abandonment. A lifecycle Attempt view supplies execution feedback only; its omitted decision and dependencies grant no selected-state or source-use authority.",
  };
  const selected: CognitionSnapshot = {
    ...snapshot,
    attention: { ...snapshot.attention },
    situations: [],
    intents: [],
    recentAttempts: [],
    evidence: [],
  };
  const sourceSupplied = structuredClone(
    sourceCoverage?.sourceCoverage?.supplied ?? [],
  );
  const originalResults = structuredClone(
    sourceCoverage?.sourceCoverage?.readResults,
  );
  // The second allocation may shorten either the oldest source or the reserved
  // current user. Ranges remain Unicode offsets into that exact supplied slice.
  const projectedCharacters = new Map<string, number>();
  const fits = (): boolean => {
    const selectedIds = new Set(selected.evidence.map((item) => item.id));
    coverage.excerptedEvidenceIds = [
      ...new Set([
        ...coverage.excerptedEvidenceIds.filter((id) => selectedIds.has(id)),
        ...(sourceCoverage?.excerptedEvidenceIds ?? []).filter((id) =>
          selectedIds.has(id),
        ),
      ]),
    ];
    if (coverage.sourceCoverage) {
      coverage.sourceCoverage.supplied = sourceSupplied
        .filter((item) => selectedIds.has(item.evidenceId))
        .map((item) => ({
          ...item,
          ...(item.textRange
            ? {
                textRange: {
                  ...item.textRange,
                  endCharacter: Math.min(
                    item.textRange.endCharacter,
                    item.textRange.startCharacter +
                      (projectedCharacters.get(item.evidenceId) ??
                        item.textRange.endCharacter -
                          item.textRange.startCharacter),
                  ),
                },
              }
            : {}),
          status: coverage.excerptedEvidenceIds.includes(item.evidenceId)
            ? "excerpted"
            : "complete",
        }));
      if (originalResults)
        coverage.sourceCoverage.readResults = originalResults.map((item) => {
          const supplied = coverage.sourceCoverage!.supplied.find(
            (value) => value.evidenceId === item.evidenceId,
          );
          return {
            evidenceId: item.evidenceId,
            ...(supplied?.textRange
              ? { textRange: { ...supplied.textRange } }
              : {}),
            status:
              supplied?.status ??
              (item.status === "missing" || item.status === "released"
                ? item.status
                : "omitted"),
          };
        });
      coverage.sourceCoverage.unopenedCount = Math.max(
        0,
        coverage.sourceCoverage.eventCount -
          coverage.sourceCoverage.supplied.filter(
            (item) =>
              item.receiptSequence > coverage.sourceCoverage!.fromSequence &&
              item.receiptSequence <= coverage.sourceCoverage!.throughSequence,
          ).length,
      );
    }
    if (coverage.currentUserSource) {
      const current = coverage.currentUserSource;
      current.status = !selectedIds.has(current.evidenceId)
        ? "omitted"
        : coverage.excerptedEvidenceIds.includes(current.evidenceId)
          ? "excerpted"
          : "complete";
      if (current.runResponse)
        current.runResponse.omittedForBudget =
          Boolean(
            sourceCoverage?.currentUserSource?.runResponse?.omittedForBudget,
          ) ||
          current.runResponse.evidenceIds.some((id) => !selectedIds.has(id));
    }
    return (
      Buffer.byteLength(
        JSON.stringify({ snapshot: selected, coverage }),
        "utf8",
      ) < maxBytes
    );
  };
  if (!fits())
    throw new CognitionConflictError(
      "Analysis allocation cannot hold its minimal identity and coverage metadata",
    );
  const latestAttempt = attempts[0];
  for (const attempt of attempts) {
    if (attempt.id !== latestAttempt?.id && !feedbackIds.has(attempt.id))
      continue;
    selected.recentAttempts.push(attemptLifecycle(attempt));
    coverage.omittedAttemptCount -= 1;
    if (!fits())
      throw new CognitionConflictError(
        "Analysis allocation cannot hold the supplied attempt lifecycle feedback",
      );
  }
  const baseline = snapshot.attention.analyzedThroughSequence;
  const unread = snapshot.evidence
    .filter(({ receiptSequence }) => receiptSequence > baseline)
    .sort((left, right) => left.receiptSequence - right.receiptSequence);
  const first = unread[0];
  const currentUser = snapshot.evidence.find(
    ({ id }) => id === coverage.currentUserSource?.evidenceId,
  );
  const sourceExcerpts = new Set(sourceCoverage?.excerptedEvidenceIds);
  const markExcerpt = (id: string, excerpted: boolean): void => {
    coverage.excerptedEvidenceIds = coverage.excerptedEvidenceIds.filter(
      (value) => value !== id,
    );
    if (excerpted || sourceExcerpts.has(id))
      coverage.excerptedEvidenceIds.push(id);
    if (coverage.currentUserSource?.evidenceId === id)
      coverage.currentUserSource.status =
        excerpted || sourceExcerpts.has(id) ? "excerpted" : "complete";
  };
  for (const evidence of [first, currentUser]) {
    if (!evidence || selected.evidence.some(({ id }) => id === evidence.id))
      continue;
    selected.evidence.push(excerptEvidence(evidence, 0));
    projectedCharacters.set(evidence.id, 0);
    markExcerpt(evidence.id, true);
    if (!fits())
      throw new CognitionConflictError(
        "Analysis allocation cannot hold the oldest receipt and current user source identities",
      );
  }
  const expandEvidence = (evidence: CognitionEvidence): number => {
    const index = selected.evidence.findIndex(({ id }) => id === evidence.id);
    selected.evidence[index] = evidence;
    projectedCharacters.delete(evidence.id);
    markExcerpt(evidence.id, false);
    if (fits()) return Array.from(evidence.text ?? "").length;
    markExcerpt(evidence.id, true);
    let lower = 0;
    let upper = JSON.stringify(evidence).length;
    while (lower < upper) {
      const candidate = Math.ceil((lower + upper) / 2);
      selected.evidence[index] = excerptEvidence(evidence, candidate);
      projectedCharacters.set(evidence.id, candidate);
      if (fits()) lower = candidate;
      else upper = candidate - 1;
    }
    selected.evidence[index] = excerptEvidence(evidence, lower);
    projectedCharacters.set(evidence.id, lower);
    return lower;
  };
  // As in the database reader, reserve both identities before expanding the
  // current user. An older large receipt must not displace their actual words.
  if (currentUser) {
    const length = expandEvidence(currentUser);
    if (
      currentUser.text?.trim() &&
      !Array.from(currentUser.text).slice(0, length).join("").trim()
    )
      throw new CognitionConflictError(
        "Analysis allocation cannot hold a readable current user excerpt",
      );
  }
  const addSituation = (value: CognitionSituation): void => {
    if (selected.situations.some(({ id }) => id === value.id)) return;
    selected.situations.push(value);
    coverage.omittedSituationCount -= 1;
    if (!fits()) {
      selected.situations.pop();
      coverage.omittedSituationCount += 1;
    }
  };
  const addIntent = (value: CognitionIntent): void => {
    if (selected.intents.some(({ id }) => id === value.id)) return;
    selected.intents.push(value);
    coverage.omittedIntentCount -= 1;
    if (!fits()) {
      selected.intents.pop();
      coverage.omittedIntentCount += 1;
    }
  };
  const focused = snapshot.situations.find(
    ({ id }) => id === snapshot.attention.currentSituationId,
  );
  const committed = snapshot.intents.find(
    ({ id }) => id === snapshot.attention.committedIntentId,
  );
  if (focused) addSituation(focused);
  if (committed) addIntent(committed);
  if (first && first.id !== currentUser?.id) expandEvidence(first);
  let through = first?.receiptSequence ?? baseline;
  for (const evidence of unread.slice(1)) {
    // A preselected current user source advances the prefix only if every
    // preceding receipt in this page was also supplied by this FIFO pass.
    if (selected.evidence.some(({ id }) => id === evidence.id)) {
      through = evidence.receiptSequence;
      continue;
    }
    selected.evidence.push(evidence);
    markExcerpt(evidence.id, false);
    if (!fits()) {
      selected.evidence.pop();
      coverage.excerptedEvidenceIds = coverage.excerptedEvidenceIds.filter(
        (id) => id !== evidence.id,
      );
      break;
    }
    through = evidence.receiptSequence;
  }
  // This page may also contain a newer user source beyond its represented
  // prefix. Reallocation cannot certify receipts absent from the source page.
  selected.attention.lastReceiptSequence = Math.min(
    through,
    snapshot.attention.lastReceiptSequence,
  );
  for (const intent of snapshot.intents) addIntent(intent);
  for (const situation of snapshot.situations) addSituation(situation);
  for (const evidence of snapshot.evidence.filter(
    ({ receiptSequence }) => receiptSequence <= baseline,
  )) {
    if (selected.evidence.some(({ id }) => id === evidence.id)) continue;
    selected.evidence.push(evidence);
    markExcerpt(evidence.id, false);
    if (!fits()) {
      selected.evidence.pop();
      coverage.excerptedEvidenceIds = coverage.excerptedEvidenceIds.filter(
        (id) => id !== evidence.id,
      );
    }
  }
  for (const attempt of attempts) {
    const previous = selected.recentAttempts.findIndex(
      ({ id }) => id === attempt.id,
    );
    const old = selected.recentAttempts[previous];
    if (old) selected.recentAttempts[previous] = attempt;
    else {
      selected.recentAttempts.push(attempt);
      coverage.omittedAttemptCount -= 1;
    }
    if (!fits()) {
      if (old) selected.recentAttempts[previous] = old;
      else {
        selected.recentAttempts.pop();
        coverage.omittedAttemptCount += 1;
      }
    }
  }
  selected.evidence.sort(
    (left, right) => left.receiptSequence - right.receiptSequence,
  );
  if (sourceCoverage) {
    if (
      coverage.stateReferences &&
      (selected.situations.length < snapshot.situations.length ||
        selected.intents.length < snapshot.intents.length)
    )
      coverage.stateReferences.omittedForBudget = true;
    if (coverage.allocation) {
      coverage.allocation.situations = coverage.allocation.situations.filter(
        (entry) => selected.situations.some((value) => value.id === entry.id),
      );
      coverage.allocation.intents = (coverage.allocation.intents ?? []).filter(
        (entry) => selected.intents.some((value) => value.id === entry.id),
      );
    }
  }
  if (!fits())
    throw new CognitionConflictError(
      "Analysis projection metadata exceeds its complete allocation",
    );
  return { snapshot: selected, coverage };
}

function excerptEvidence(
  value: CognitionEvidence,
  length: number,
): CognitionEvidence {
  const marker =
    "[INCOMPLETE EXCERPT: full persisted receipt is available by source reference; omitted content cannot support a claim.]";
  return {
    ...value,
    text: `${Array.from(value.text ?? "")
      .slice(0, length)
      .join("")}\n${marker}`,
    ...(value.object
      ? {
          object: {
            ...value.object,
            ...(value.object.title
              ? { title: value.object.title.slice(0, length) }
              : {}),
            ...(value.object.url
              ? { url: value.object.url.slice(0, length) }
              : {}),
          },
        }
      : {}),
    ...(value.effect
      ? {
          effect: {
            ...value.effect,
            description: `${value.effect.description.slice(0, length)} ${marker}`,
            sourceRefs: value.effect.sourceRefs.slice(0, length),
          },
        }
      : {}),
  };
}
