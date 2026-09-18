import { Type } from "@sinclair/typebox";

import {
  EvidencePackSchema,
  MemoryEvidenceItemSchema,
  RecallPlanSchema,
} from "./memoryRecall";
import { ActivityVisualReferenceSchema } from "./activity";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";

const closed = { additionalProperties: false } as const;
const strings = Type.Array(NonBlankStringSchema);
const ids = Type.Array(EntityIdSchema);
const localRef = Type.Union([
  EntityIdSchema,
  Type.String({ pattern: "^new:.+" }),
]);
const revision = Type.Integer({ minimum: 1 });
const cursor = Type.Integer({ minimum: 0 });

export const CognitionActorSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("agent"),
  Type.Literal("system"),
  Type.Literal("unknown"),
]);
export const CognitionSourceKindSchema = Type.Union([
  Type.Literal("activity"),
  Type.Literal("message"),
  Type.Literal("run"),
  Type.Literal("memory"),
  Type.Literal("journey"),
  Type.Literal("territory"),
  Type.Literal("system"),
]);
export const CognitionSourceRefSchema = Type.Object(
  {
    kind: CognitionSourceKindSchema,
    id: NonBlankStringSchema,
    revision: Type.Optional(NonBlankStringSchema),
    fragment: Type.Optional(NonBlankStringSchema),
  },
  closed,
);
export const CognitionObjectRefSchema = Type.Object(
  {
    key: NonBlankStringSchema,
    identity: Type.Union([
      Type.Literal("adapter"),
      Type.Literal("provisional"),
    ]),
    appId: Type.Optional(Type.String()),
    appName: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
  },
  closed,
);
export const CognitionEffectSchema = Type.Object(
  {
    runId: EntityIdSchema,
    itemId: Type.Optional(EntityIdSchema),
    callId: Type.Optional(NonBlankStringSchema),
    outcome: Type.Union([
      Type.Literal("performed"),
      Type.Literal("not_performed"),
      Type.Literal("partial"),
      Type.Literal("unknown"),
    ]),
    description: NonBlankStringSchema,
    sourceRefs: Type.Array(CognitionSourceRefSchema),
    worldChange: Type.Optional(
      Type.Union([
        Type.Literal("planned"),
        Type.Literal("generated"),
        Type.Literal("collected"),
        Type.Literal("placed"),
        Type.Literal("modified"),
        Type.Literal("unchanged"),
      ]),
    ),
  },
  closed,
);
// A retrieved statement preserves its original basis and time. It is not a
// new utterance, observation, authorization, or action receipt.
export const CognitionRecollectionMetadataSchema = Type.Pick(
  MemoryEvidenceItemSchema,
  [
    "type",
    "basis",
    "owner",
    "personaId",
    "current",
    "historyStatus",
    "historyStatusRevisionId",
    "recordedAt",
    "occurredFrom",
    "occurredTo",
    "validFrom",
    "validTo",
  ],
);
export const CognitionEvidenceInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    personaId: EntityIdSchema,
    actor: CognitionActorSchema,
    source: CognitionSourceRefSchema,
    observedAt: TimestampSchema,
    chatId: Type.Optional(EntityIdSchema),
    kind: Type.Union([
      Type.Literal("observation"),
      Type.Literal("utterance"),
      Type.Literal("effect"),
      Type.Literal("control"),
      Type.Literal("recollection"),
    ]),
    text: Type.Optional(Type.String()),
    recollection: Type.Optional(CognitionRecollectionMetadataSchema),
    visual: Type.Optional(ActivityVisualReferenceSchema),
    object: Type.Optional(CognitionObjectRefSchema),
    boundary: Type.Optional(
      Type.Union([
        Type.Literal("application"),
        Type.Literal("window"),
        Type.Literal("content"),
        Type.Literal("interaction"),
        Type.Literal("idle"),
      ]),
    ),
    visibility: Type.Optional(
      Type.Object(
        {
          status: Type.Union([
            Type.Literal("available"),
            Type.Literal("unavailable"),
            Type.Literal("protected"),
          ]),
          source: Type.Optional(
            Type.Union([Type.Literal("accessibility"), Type.Literal("dom")]),
          ),
          truncated: Type.Optional(Type.Literal(true)),
          scope: Type.Optional(
            Type.Union([
              Type.Literal("focused_element"),
              Type.Literal("viewport"),
            ]),
          ),
        },
        closed,
      ),
    ),
    interaction: Type.Optional(
      Type.Object(
        { clicks: cursor, keystrokes: cursor, scrolls: cursor },
        closed,
      ),
    ),
    sourceEpoch: Type.Optional(NonBlankStringSchema),
    sourceSequence: Type.Optional(cursor),
    control: Type.Optional(
      Type.Union([
        Type.Literal("user_engaged"),
        Type.Literal("user_stop"),
        Type.Literal("user_correction"),
        Type.Literal("sleep"),
        Type.Literal("wake"),
        Type.Literal("persona_changed"),
      ]),
    ),
    effect: Type.Optional(CognitionEffectSchema),
    opportunity: Type.Optional(
      Type.Object(
        {
          id: EntityIdSchema,
          targetChatId: EntityIdSchema,
          occursAt: TimestampSchema,
          evaluateAt: TimestampSchema,
          status: Type.Union([Type.Literal("due"), Type.Literal("cancelled")]),
        },
        closed,
      ),
    ),
  },
  closed,
);
export const CognitionEvidenceSchema = Type.Object(
  {
    ...CognitionEvidenceInputSchema.properties,
    // Host-owned lifecycle marker: input producers cannot declare a body retired.
    bodyReleasedAt: Type.Optional(TimestampSchema),
    receiptSequence: Type.Integer({ minimum: 1 }),
    receivedAt: TimestampSchema,
  },
  closed,
);
export const CognitionClaimSchema = Type.Object(
  {
    id: NonBlankStringSchema,
    text: NonBlankStringSchema,
    basis: Type.Union([
      Type.Literal("observed"),
      Type.Literal("reported"),
      Type.Literal("inferred"),
    ]),
    state: Type.Union([
      Type.Literal("supported"),
      Type.Literal("uncertain"),
      Type.Literal("disputed"),
      Type.Literal("superseded"),
    ]),
    evidenceIds: ids,
    contradictingEvidenceIds: ids,
    historyEvidenceIds: Type.Optional(ids),
    alternative: Type.Optional(NonBlankStringSchema),
  },
  closed,
);
export const CognitionEpisodeSchema = Type.Object(
  {
    id: NonBlankStringSchema,
    label: NonBlankStringSchema,
    state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
    startedAt: TimestampSchema,
    endedAt: Type.Optional(TimestampSchema),
    evidenceIds: ids,
    objectKeys: strings,
    boundaryReason: NonBlankStringSchema,
  },
  closed,
);
export const CognitionSituationSchema = Type.Object(
  {
    id: EntityIdSchema,
    personaId: EntityIdSchema,
    revision,
    status: Type.Union([
      Type.Literal("current"),
      Type.Literal("background"),
      Type.Literal("suspended"),
      Type.Literal("closed"),
    ]),
    title: NonBlankStringSchema,
    summary: Type.String(),
    objectRefs: Type.Array(CognitionObjectRefSchema),
    episodes: Type.Array(CognitionEpisodeSchema),
    claims: Type.Array(CognitionClaimSchema),
    unresolved: strings,
    relatedSituationIds: ids,
    journeyId: Type.Optional(EntityIdSchema),
    togetherSessionId: Type.Optional(EntityIdSchema),
    supersededBy: Type.Optional(EntityIdSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  closed,
);
export const CognitionConditionSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("user_engagement"),
      Type.Literal("new_evidence"),
      Type.Literal("run_terminal"),
      Type.Literal("time"),
      Type.Literal("world_change"),
    ]),
    description: NonBlankStringSchema,
    referenceId: Type.Optional(NonBlankStringSchema),
    after: Type.Optional(TimestampSchema),
  },
  closed,
);
export const CognitionIntentCompletionSchema = Type.Object(
  {
    evidenceUses: Type.Array(
      Type.Object(
        {
          evidenceId: EntityIdSchema,
          basis: Type.Union([
            Type.Literal("performed_effect"),
            Type.Literal("user_report"),
            Type.Literal("completed_reply"),
          ]),
        },
        closed,
      ),
      { minItems: 1, uniqueItems: true },
    ),
  },
  closed,
);
export const CognitionIntentSchema = Type.Object(
  {
    id: EntityIdSchema,
    personaId: EntityIdSchema,
    revision,
    situationId: Type.Optional(EntityIdSchema),
    journeyId: Type.Optional(EntityIdSchema),
    owner: Type.Union([Type.Literal("user"), Type.Literal("character")]),
    basis: Type.Union([
      Type.Literal("explicit_user"),
      Type.Literal("inferred_user"),
      Type.Literal("character"),
    ]),
    status: Type.Union([
      Type.Literal("candidate"),
      Type.Literal("active"),
      Type.Literal("suspended"),
      Type.Literal("fulfilled"),
      Type.Literal("abandoned"),
    ]),
    goal: NonBlankStringSchema,
    successCriteria: strings,
    evidenceIds: ids,
    blockers: strings,
    resumeConditions: Type.Array(CognitionConditionSchema),
    progress: Type.String(),
    effectEvidenceIds: ids,
    completion: Type.Optional(CognitionIntentCompletionSchema),
    nextWakeAt: Type.Optional(TimestampSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  closed,
);
export const CognitionAttentionStateSchema = Type.Object(
  {
    personaId: EntityIdSchema,
    revision: cursor,
    userGeneration: cursor,
    focusRevision: cursor,
    lastReceiptSequence: cursor,
    analyzedThroughSequence: cursor,
    catalogueReviewedThroughSequence: Type.Optional(cursor),
    foregroundObject: Type.Optional(CognitionObjectRefSchema),
    foregroundObservationClock: Type.Optional(
      Type.Object(
        {
          observedAt: TimestampSchema,
          sourceKind: CognitionSourceKindSchema,
          sourceEpoch: Type.Optional(NonBlankStringSchema),
          sourceSequence: Type.Optional(cursor),
        },
        closed,
      ),
    ),
    currentSituationId: Type.Optional(EntityIdSchema),
    committedIntentId: Type.Optional(EntityIdSchema),
    nextWakeAt: Type.Optional(TimestampSchema),
    updatedAt: TimestampSchema,
  },
  closed,
);
export const CognitionDependenciesSchema = Type.Object(
  {
    personaId: EntityIdSchema,
    userGeneration: cursor,
    receivedThroughSequence: cursor,
    focusRevision: cursor,
    situations: Type.Array(
      Type.Object({ id: EntityIdSchema, revision }, closed),
    ),
    intents: Type.Array(Type.Object({ id: EntityIdSchema, revision }, closed)),
    evidenceIds: ids,
  },
  closed,
);
export const CognitionChoiceSchema = Type.Object(
  {
    id: NonBlankStringSchema,
    kind: Type.Union([
      Type.Literal("remain_quiet"),
      Type.Literal("respond"),
      Type.Literal("clarify"),
      Type.Literal("continue_shared"),
      Type.Literal("start_conversation"),
      Type.Literal("continue_character"),
    ]),
    situationId: Type.Optional(localRef),
    intentId: Type.Optional(localRef),
    evidenceIds: ids,
    rationale: NonBlankStringSchema,
    userImpact: Type.Union([
      Type.Literal("none"),
      Type.Literal("light"),
      Type.Literal("interruption"),
    ]),
    executionScope: Type.Union([
      Type.Literal("none"),
      Type.Literal("conversation"),
      Type.Literal("territory"),
      Type.Literal("external"),
    ]),
    reversibility: Type.Union([
      Type.Literal("read_only"),
      Type.Literal("undoable"),
      Type.Literal("approval_required"),
    ]),
    timing: Type.Union([
      Type.Literal("now"),
      Type.Literal("next_boundary"),
      Type.Literal("defer"),
    ]),
    resumeConditions: Type.Array(CognitionConditionSchema),
    instruction: Type.Optional(NonBlankStringSchema),
    chatId: Type.Optional(EntityIdSchema),
    journeyId: Type.Optional(EntityIdSchema),
  },
  closed,
);
export const CognitionSelectedBasisSchema = Type.Object(
  {
    choiceId: NonBlankStringSchema,
    evidenceUses: Type.Array(
      Type.Object(
        {
          evidenceId: EntityIdSchema,
          use: Type.Union([
            Type.Literal("history"),
            Type.Literal("current_object"),
            Type.Literal("current_foreground"),
            Type.Literal("current_recollection"),
          ]),
        },
        closed,
      ),
    ),
    currentClaimRefs: Type.Array(
      Type.Object(
        { situationId: localRef, claimId: NonBlankStringSchema },
        closed,
      ),
    ),
    waitingInputContinuation: Type.Optional(
      Type.Object(
        {
          runId: EntityIdSchema,
          itemId: EntityIdSchema,
          requestEvidenceId: EntityIdSchema,
        },
        closed,
      ),
    ),
    requestedContinuation: Type.Optional(
      Type.Object(
        {
          requestEvidenceId: EntityIdSchema,
          conditionClaimRefs: Type.Array(
            Type.Object(
              { situationId: localRef, claimId: NonBlankStringSchema },
              closed,
            ),
            { minItems: 1, uniqueItems: true },
          ),
        },
        closed,
      ),
    ),
  },
  closed,
);
export const CognitionActionReadSetSchema = Type.Object(
  {
    choiceId: NonBlankStringSchema,
    selectedIntent: Type.Optional(
      Type.Object({ id: EntityIdSchema, revision }, closed),
    ),
    situationLifecycles: Type.Array(
      Type.Object(
        {
          id: EntityIdSchema,
          status: CognitionSituationSchema.properties.status,
          supersededBy: Type.Optional(EntityIdSchema),
        },
        closed,
      ),
    ),
    claims: Type.Array(
      Type.Object(
        {
          situationId: EntityIdSchema,
          claimId: NonBlankStringSchema,
          materialVersion: NonBlankStringSchema,
        },
        closed,
      ),
    ),
    currentObjects: Type.Array(
      Type.Object(
        {
          evidenceId: EntityIdSchema,
          requireForeground: Type.Boolean(),
          focusRevision: Type.Optional(cursor),
        },
        closed,
      ),
    ),
    recollections: Type.Array(
      Type.Object(
        { evidenceId: EntityIdSchema, requireCurrent: Type.Boolean() },
        closed,
      ),
    ),
    opportunityEvidenceIds: ids,
  },
  closed,
);
export const CognitionDecisionSchema = Type.Object(
  {
    choices: Type.Array(CognitionChoiceSchema, { minItems: 1 }),
    selectedChoiceId: NonBlankStringSchema,
    selectedBasis: CognitionSelectedBasisSchema,
    reason: NonBlankStringSchema,
  },
  closed,
);
export const CognitionAttemptStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("analyzing"),
  Type.Literal("awaiting_recall"),
  Type.Literal("ready"),
  Type.Literal("dispatched"),
  Type.Literal("settled"),
  Type.Literal("superseded"),
  Type.Literal("failed"),
]);
export const CognitionAllocationSchema = Type.Object(
  {
    situations: Type.Array(
      Type.Object(
        {
          id: EntityIdSchema,
          episodeIds: strings,
          claimIds: strings,
          preservedFields: Type.Array(
            Type.Union([
              Type.Literal("title"),
              Type.Literal("summary"),
              Type.Literal("objectRefs"),
              Type.Literal("unresolved"),
              Type.Literal("relatedSituationIds"),
              Type.Literal("journeyId"),
              Type.Literal("togetherSessionId"),
              Type.Literal("supersededBy"),
            ]),
          ),
        },
        closed,
      ),
    ),
    intents: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: EntityIdSchema,
            evidenceIds: ids,
            effectEvidenceIds: ids,
            preservedFields: Type.Array(
              Type.Union([
                Type.Literal("goal"),
                Type.Literal("successCriteria"),
                Type.Literal("blockers"),
                Type.Literal("resumeConditions"),
                Type.Literal("progress"),
                Type.Literal("completion"),
              ]),
            ),
          },
          closed,
        ),
      ),
    ),
  },
  closed,
);
// A catalogue entry identifies available originals; its ID and change excerpts
// are not claim evidence. Only actual snapshot.evidence bodies qualify.
const CognitionSourceTextRangeSchema = Type.Object(
  { startCharacter: cursor, endCharacter: cursor, totalCharacters: cursor },
  closed,
);
export const CognitionSourceReadPlanSchema = Type.Object(
  {
    requests: Type.Array(
      Type.Object(
        {
          catalogueId: NonBlankStringSchema,
          evidenceId: EntityIdSchema,
          question: NonBlankStringSchema,
          startCharacter: Type.Optional(cursor),
        },
        closed,
      ),
      { minItems: 1 },
    ),
  },
  closed,
);
export const CognitionSourceCoverageSchema = Type.Object(
  {
    fromSequence: cursor,
    throughSequence: cursor,
    receivedThroughSequence: cursor,
    eventCount: cursor,
    entries: Type.Array(
      Type.Object(
        {
          id: NonBlankStringSchema,
          fromSequence: cursor,
          throughSequence: cursor,
          firstEvidenceId: EntityIdSchema,
          latestEvidenceId: EntityIdSchema,
          actor: CognitionActorSchema,
          kind: CognitionEvidenceSchema.properties.kind,
          sourceKind: CognitionSourceKindSchema,
          sourceEpoch: Type.Optional(NonBlankStringSchema),
          objectKey: Type.Optional(NonBlankStringSchema),
          title: Type.Optional(Type.String()),
          visibility: Type.Optional(Type.String()),
          firstAt: TimestampSchema,
          lastAt: TimestampSchema,
          eventCount: cursor,
          requiresBody: Type.Boolean(),
          textBytes: cursor,
          visualCount: cursor,
          changes: Type.Array(
            Type.Object(
              {
                evidenceId: EntityIdSchema,
                replacedByEvidenceId: EntityIdSchema,
                excerpt: Type.Optional(Type.String()),
                startCharacter: cursor,
                excerpted: Type.Boolean(),
              },
              closed,
            ),
          ),
          omittedChangeCount: cursor,
          interaction: Type.Optional(
            Type.Object(
              { clicks: cursor, keystrokes: cursor, scrolls: cursor },
              closed,
            ),
          ),
        },
        closed,
      ),
    ),
    supplied: Type.Array(
      Type.Object(
        {
          evidenceId: EntityIdSchema,
          receiptSequence: cursor,
          textRange: Type.Optional(CognitionSourceTextRangeSchema),
          status: Type.Union([
            Type.Literal("complete"),
            Type.Literal("excerpted"),
          ]),
        },
        closed,
      ),
    ),
    unopenedCount: cursor,
    omittedEventCount: cursor,
    readPlan: Type.Optional(CognitionSourceReadPlanSchema),
    readResults: Type.Optional(
      Type.Array(
        Type.Object(
          {
            evidenceId: EntityIdSchema,
            textRange: Type.Optional(CognitionSourceTextRangeSchema),
            status: Type.Union([
              Type.Literal("complete"),
              Type.Literal("excerpted"),
              Type.Literal("missing"),
              Type.Literal("released"),
              Type.Literal("omitted"),
            ]),
          },
          closed,
        ),
      ),
    ),
    recoveredFromAttemptId: Type.Optional(EntityIdSchema),
    completionPending: Type.Boolean(),
  },
  closed,
);
export const CognitionDecisionAttemptSchema = Type.Object(
  {
    id: EntityIdSchema,
    personaId: EntityIdSchema,
    status: CognitionAttemptStatusSchema,
    trigger: Type.Union([
      Type.Literal("user_turn"),
      Type.Literal("semantic_change"),
      Type.Literal("feedback"),
      Type.Literal("resume"),
      Type.Literal("character_due"),
    ]),
    throughSequence: cursor,
    dependencies: CognitionDependenciesSchema,
    allocation: Type.Optional(CognitionAllocationSchema),
    sourceCoverage: Type.Optional(CognitionSourceCoverageSchema),
    // Host receipt of the due work actually supplied to this attempt.
    wakeSources: Type.Optional(
      Type.Object(
        {
          attentionWakeAt: Type.Optional(TimestampSchema),
          intents: Type.Array(
            Type.Object(
              { id: EntityIdSchema, revision, nextWakeAt: TimestampSchema },
              closed,
            ),
          ),
        },
        closed,
      ),
    ),
    recallPlan: Type.Optional(RecallPlanSchema),
    recallSummary: Type.Optional(
      Type.Pick(EvidencePackSchema, [
        "coverage",
        "gaps",
        "truncated",
        "incompleteReasons",
      ]),
    ),
    decision: Type.Optional(CognitionDecisionSchema),
    actionReadSet: Type.Optional(CognitionActionReadSetSchema),
    dispatchKey: NonBlankStringSchema,
    runId: Type.Optional(EntityIdSchema),
    // Supplying an existing Run does not acquire its execution/delivery owner.
    contextContinuation: Type.Optional(
      Type.Object(
        {
          runId: EntityIdSchema,
          itemId: EntityIdSchema,
          acceptedAt: TimestampSchema,
        },
        closed,
      ),
    ),
    outcome: Type.Optional(
      Type.Union([
        Type.Literal("quiet"),
        Type.Literal("deferred"),
        Type.Literal("delivered"),
        Type.Literal("performed"),
        Type.Literal("context_supplied"),
        Type.Literal("interrupted"),
        Type.Literal("failed"),
        Type.Literal("unknown"),
      ]),
    ),
    feedbackEvidenceIds: ids,
    error: Type.Optional(NonBlankStringSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  closed,
);
const situationValue = Type.Omit(CognitionSituationSchema, [
  "id",
  "personaId",
  "revision",
  "createdAt",
  "updatedAt",
]);
const proposedSituation = Type.Object(
  {
    ...situationValue.properties,
    relatedSituationIds: Type.Array(localRef),
    supersededBy: Type.Optional(localRef),
  },
  closed,
);
const intentValue = Type.Omit(CognitionIntentSchema, [
  "id",
  "personaId",
  "revision",
  "createdAt",
  "updatedAt",
]);
const proposedIntent = Type.Object(
  { ...intentValue.properties, situationId: Type.Optional(localRef) },
  closed,
);
export const CognitionStateDeltaSchema = Type.Object(
  {
    createSituations: Type.Array(
      Type.Object(
        {
          localId: Type.String({ pattern: "^new:.+" }),
          value: proposedSituation,
        },
        closed,
      ),
    ),
    updateSituations: Type.Array(
      Type.Object(
        {
          id: EntityIdSchema,
          expectedRevision: revision,
          value: proposedSituation,
        },
        closed,
      ),
    ),
    createIntents: Type.Array(
      Type.Object(
        { localId: Type.String({ pattern: "^new:.+" }), value: proposedIntent },
        closed,
      ),
    ),
    updateIntents: Type.Array(
      Type.Object(
        {
          id: EntityIdSchema,
          expectedRevision: revision,
          value: proposedIntent,
          // Internal decoded operation; the model uses the existing changes
          // field's keep/set/clear object, not this additional wire field.
          completionOperation: Type.Optional(
            Type.Union([
              Type.Literal("keep"),
              Type.Literal("set"),
              Type.Literal("clear"),
            ]),
          ),
        },
        closed,
      ),
    ),
    attention: Type.Object(
      {
        currentSituationId: Type.Optional(Type.Union([localRef, Type.Null()])),
        committedIntentId: Type.Optional(Type.Union([localRef, Type.Null()])),
      },
      closed,
    ),
  },
  closed,
);
export const CognitionAnalysisSchema = Type.Object(
  {
    sourceReadPlan: Type.Optional(CognitionSourceReadPlanSchema),
    delta: CognitionStateDeltaSchema,
    recallPlan: Type.Optional(
      Type.Object(
        {
          ...RecallPlanSchema.properties,
          situationId: Type.Optional(localRef),
        },
        closed,
      ),
    ),
    decision: CognitionDecisionSchema,
  },
  closed,
);
// A snapshot can expose execution feedback without loading the full prior
// decision and CAS read-set. This view is never a persistable Attempt.
export const CognitionAttemptLifecycleSchema = Type.Object(
  {
    ...Type.Pick(CognitionDecisionAttemptSchema, [
      "id",
      "personaId",
      "status",
      "trigger",
      "throughSequence",
      "runId",
      "contextContinuation",
      "outcome",
      "error",
      "createdAt",
      "updatedAt",
    ]).properties,
    projection: Type.Literal("lifecycle"),
  },
  closed,
);
const CognitionAttemptViewSchema = Type.Union([
  Type.Object(
    {
      ...CognitionDecisionAttemptSchema.properties,
      projection: Type.Literal("complete"),
    },
    closed,
  ),
  CognitionAttemptLifecycleSchema,
]);
export const CognitionSnapshotSchema = Type.Object(
  {
    attention: CognitionAttentionStateSchema,
    situations: Type.Array(CognitionSituationSchema),
    intents: Type.Array(CognitionIntentSchema),
    evidence: Type.Array(CognitionEvidenceSchema),
    recentAttempts: Type.Array(CognitionAttemptViewSchema),
  },
  closed,
);
export const CognitionPreparedContextSchema = Type.Object(
  {
    situationIds: ids,
    intentIds: ids,
    evidenceIds: ids,
    text: Type.String(),
    recallPlan: Type.Optional(RecallPlanSchema),
    evidencePack: Type.Optional(EvidencePackSchema),
    historicalMemoryRevisionIds: Type.Optional(ids),
    decisionAttemptId: Type.Optional(EntityIdSchema),
  },
  closed,
);

/** Source identities and frozen one-hop membership awaiting durable Memory intake. */
export const CognitionMemoryHandoffSchema = Type.Object(
  {
    id: EntityIdSchema,
    personaId: EntityIdSchema,
    situationId: EntityIdSchema,
    committedAt: TimestampSchema,
    primaryEvidenceIds: Type.Array(EntityIdSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    historyEvidenceIds: Type.Array(EntityIdSchema, { uniqueItems: true }),
    contextGroups: Type.Array(
      Type.Object(
        {
          anchorEvidenceIds: Type.Array(EntityIdSchema, {
            minItems: 1,
            uniqueItems: true,
          }),
          contextEvidenceIds: Type.Array(EntityIdSchema, { uniqueItems: true }),
        },
        closed,
      ),
    ),
  },
  closed,
);
