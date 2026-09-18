import { Type } from "@sinclair/typebox";

import {
  MemoryHistoryStatusSchema,
  MemorySourceTypeSchema,
  MemoryTypeSchema,
} from "./memory";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "./primitives";

const closed = { additionalProperties: false } as const;

export const RecallQuestionSchema = Type.Object(
  {
    id: NonBlankStringSchema,
    text: NonBlankStringSchema,
  },
  closed,
);

export const RecallTimeScopeSchema = Type.Object(
  {
    occurredFrom: Type.Optional(
      Type.String({
        ...TimestampSchema,
        description:
          "Event occurrence lower bound for every question, not the time a statement was recorded. Supply only when all questions require this bound and its event-time meaning is known. Keep uncertain relative dates in query/questions; do not guess an instant or source time zone.",
      }),
    ),
    occurredTo: Type.Optional(
      Type.String({
        ...TimestampSchema,
        description:
          "Exclusive event occurrence upper bound for every question. Supply only when all questions require this known bound. Setting this to now excludes future plans and appointments, even when already known; unknown occurrence times are also excluded. Keep uncertain relative dates in query/questions; do not guess an instant or source time zone.",
      }),
    ),
    knownAt: Type.Optional(
      Type.String({
        ...TimestampSchema,
        description:
          "Recorded knowledge as of this instant. Use for what was known at a specified past time; this is not an event occurrence bound.",
      }),
    ),
    validAt: Type.Optional(
      Type.String({
        ...TimestampSchema,
        description:
          "When a fact or commitment applies, independent of occurrence and recorded time.",
      }),
    ),
    includeSuperseded: Type.Optional(Type.Boolean()),
  },
  closed,
);

export const MemoryEvidenceReferenceSchema = Type.Object(
  {
    memoryId: EntityIdSchema,
    revisionId: EntityIdSchema,
    use: Type.Union([Type.Literal("history"), Type.Literal("current")]),
  },
  {
    ...closed,
    description:
      "Read this exact supplied Memory/Revision pair. current requires it to remain the current applicable revision; history permits reading that exact past record with its historyStatus; it does not assert that corrected or unresolved content was once true. Unknown or unavailable references are reported, never silently replaced with another revision.",
  },
);

export const RecallPlanSchema = Type.Object(
  {
    purpose: Type.Union([
      Type.Literal("conversation"),
      Type.Literal("recollection"),
      Type.Literal("formation"),
      Type.Literal("initiative"),
      Type.Literal("reflection"),
      Type.Literal("character_life"),
    ]),
    query: Type.String({
      description:
        "Related-memory search intent. With references, use an empty string to read only those exact records; use a nonempty query when related evidence is also needed.",
    }),
    questions: Type.Array(RecallQuestionSchema),
    references: Type.Optional(
      Type.Array(MemoryEvidenceReferenceSchema, {
        description:
          "Exact records whose IDs were supplied in evidence. Their identity and current/history eligibility are checked separately from related-search entity/time filters. Questions state what these records need to establish.",
      }),
    ),
    entityIds: Type.Optional(
      Type.Array(EntityIdSchema, {
        description:
          "Hard filter across all related-search questions for actual Memory entity IDs identifying people/things, obtained from returned entityIds. Supply only when the intended entity scope is known and necessary for every question; put mere mentions or associations in query/questions. Never put Memory, Revision, Situation, Chat, event or source IDs here. Omit when no entity ID is known.",
      }),
    ),
    entityNames: Type.Optional(
      Type.Array(NonBlankStringSchema, {
        description:
          "Names of people/things resolved by exact alias for related search. Resolved names join entityIds as a hard filter across all questions; unresolved names do not broaden a partially resolved filter. Supply only when the intended entity scope is known and necessary for every question; put mere mentions or associations in query/questions. Names are not Memory record IDs.",
      }),
    ),
    timeScope: Type.Optional(
      Type.Object(RecallTimeScopeSchema.properties, {
        ...closed,
        description:
          "Hard constraints on related search for the whole plan. Occurrence bounds must have a known meaning required by every question; use separate queries when scopes differ. Exact references have their own current/history eligibility and are not excluded by these search filters.",
      }),
    ),
    situationId: Type.Optional(EntityIdSchema),
    personaId: Type.Optional(EntityIdSchema),
    owner: Type.Optional(
      Type.Union([Type.Literal("user"), Type.Literal("character")]),
    ),
    excludeRevisionIds: Type.Optional(Type.Array(EntityIdSchema)),
    contextBudget: Type.Object(
      { maxTokens: Type.Integer({ minimum: 1 }) },
      closed,
    ),
  },
  closed,
);

export const MemorySourceSpanSchema = Type.Object(
  {
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 1 }),
    quote: NonBlankStringSchema,
  },
  closed,
);

export const EvidenceSourceRefSchema = Type.Object(
  {
    sourceId: EntityIdSchema,
    referenceId: EntityIdSchema,
    type: MemorySourceTypeSchema,
    spans: Type.Optional(Type.Array(MemorySourceSpanSchema)),
  },
  closed,
);

export const MemoryBasisSchema = Type.Union([
  Type.Literal("explicit_user_statement"),
  Type.Literal("direct_observation"),
  Type.Literal("inference"),
]);

export const MemoryRevisionSemanticsSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("episode"),
      Type.Literal("claim"),
      Type.Literal("commitment"),
      Type.Literal("experience"),
      Type.Literal("reflection"),
    ]),
    owner: Type.Union([Type.Literal("user"), Type.Literal("character")]),
    personaId: Type.Optional(EntityIdSchema),
    basis: MemoryBasisSchema,
    occurredFrom: Type.Optional(TimestampSchema),
    occurredTo: Type.Optional(TimestampSchema),
    timePrecision: Type.Optional(
      Type.Union([
        Type.Literal("instant"),
        Type.Literal("day"),
        Type.Literal("month"),
        Type.Literal("year"),
        Type.Literal("range"),
        Type.Literal("unknown"),
      ]),
    ),
    validFrom: Type.Optional(TimestampSchema),
    validTo: Type.Optional(TimestampSchema),
    subjectEntityId: Type.Optional(EntityIdSchema),
    predicate: Type.Optional(NonBlankStringSchema),
    objectEntityId: Type.Optional(EntityIdSchema),
    objectValue: Type.Optional(NonBlankStringSchema),
    qualifiers: Type.Record(Type.String(), Type.String()),
    commitmentState: Type.Optional(
      Type.Union([
        Type.Literal("proposed"),
        Type.Literal("active"),
        Type.Literal("completed"),
        Type.Literal("cancelled"),
      ]),
    ),
  },
  closed,
);

export const MemoryEvidenceItemSchema = Type.Object(
  {
    memoryId: EntityIdSchema,
    revisionId: EntityIdSchema,
    type: MemoryTypeSchema,
    content: NonBlankStringSchema,
    basis: Type.Optional(MemoryBasisSchema),
    entityIds: Type.Array(EntityIdSchema),
    sourceRefs: Type.Array(EvidenceSourceRefSchema),
    sourceCount: Type.Optional(Type.Integer({ minimum: 0 })),
    derivation: Type.Optional(
      Type.Object(
        {
          kind: Type.Literal("consolidation"),
          dependencies: Type.Array(MemoryEvidenceReferenceSchema, {
            minItems: 1,
          }),
          sourceRevisionCount: Type.Integer({ minimum: 1 }),
          distinctUserDays: Type.Integer({
            minimum: 0,
            description:
              "Distinct UTC date buckets of original user source timestamps, not local calendar days or independent proof of a stable pattern. Inspect exact sources and contexts; crossing UTC midnight within one short interaction is not repeated long-term support.",
          }),
          distinctContexts: Type.Integer({ minimum: 0 }),
        },
        closed,
      ),
    ),
    semantics: Type.Optional(MemoryRevisionSemanticsSchema),
    recordedAt: TimestampSchema,
    occurredFrom: Type.Optional(TimestampSchema),
    occurredTo: Type.Optional(TimestampSchema),
    validFrom: Type.Optional(TimestampSchema),
    validTo: Type.Optional(TimestampSchema),
    current: Type.Boolean(),
    questionIds: Type.Array(NonBlankStringSchema),
    historyStatus: MemoryHistoryStatusSchema,
    historyStatusRevisionId: Type.Optional(
      Type.String({
        ...EntityIdSchema,
        description:
          "Exact successor Revision in this same Memory that establishes historyStatus. Read it with this memoryId and use=history if its correction details are needed; the identifier alone does not supply its content.",
      }),
    ),
    relations: Type.Optional(
      Type.Array(
        Type.Object(
          {
            revisionId: EntityIdSchema,
            relation: Type.Union([
              Type.Literal("supersedes"),
              Type.Literal("contradicts"),
              Type.Literal("caused_by"),
              Type.Literal("part_of"),
              Type.Literal("follows"),
              Type.Literal("derived_from"),
            ]),
          },
          closed,
        ),
      ),
    ),
    owner: Type.Optional(
      Type.Union([Type.Literal("user"), Type.Literal("character")]),
    ),
    personaId: Type.Optional(EntityIdSchema),
  },
  closed,
);

export const EvidenceCoverageSchema = Type.Object(
  {
    questionId: NonBlankStringSchema,
    status: Type.Union([
      Type.Literal("supported"),
      Type.Literal("partial"),
      Type.Literal("missing"),
      Type.Literal("conflicting"),
    ]),
    revisionIds: Type.Array(EntityIdSchema),
  },
  closed,
);

export const EvidencePackSchema = Type.Object(
  {
    items: Type.Array(MemoryEvidenceItemSchema),
    coverage: Type.Array(EvidenceCoverageSchema),
    gaps: Type.Array(
      Type.Object(
        {
          questionId: NonBlankStringSchema,
          reason: NonBlankStringSchema,
        },
        closed,
      ),
    ),
    estimatedTokens: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    incompleteReasons: Type.Array(NonBlankStringSchema),
  },
  closed,
);

export const MemoryFormationSourceSchema = Type.Object(
  {
    id: EntityIdSchema,
    referenceId: EntityIdSchema,
    type: MemorySourceTypeSchema,
    content: NonBlankStringSchema,
    speaker: Type.Union([
      Type.Literal("user"),
      Type.Literal("assistant"),
      Type.Literal("tool"),
      Type.Literal("environment"),
    ]),
    occurredAt: TimestampSchema,
  },
  closed,
);

export const MemoryFormationEpisodeSchema = Type.Object(
  {
    id: EntityIdSchema,
    version: NonBlankStringSchema,
    availableMemoryReferences: Type.Optional(
      Type.Array(MemoryEvidenceReferenceSchema),
    ),
    situationId: Type.Optional(EntityIdSchema),
    personaId: Type.Optional(EntityIdSchema),
    recordedAt: TimestampSchema,
  },
  closed,
);

export const MemoryFormationSourceUseSchema = Type.Object(
  { sourceId: EntityIdSchema, primary: Type.Boolean() },
  closed,
);

// Only the current, budgeted model working set carries source text.
export const MemoryFormationMaterialSchema = Type.Object(
  {
    ...MemoryFormationEpisodeSchema.properties,
    sources: Type.Array(MemoryFormationSourceSchema, { minItems: 1 }),
    evidenceSourceIds: Type.Array(EntityIdSchema, {
      minItems: 1,
      uniqueItems: true,
      description:
        "Primary sources in this segment; other supplied sources only disambiguate context.",
    }),
  },
  closed,
);
