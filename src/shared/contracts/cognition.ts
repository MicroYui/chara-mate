import type { Static } from "@sinclair/typebox";

import type {
  CognitionActorSchema,
  CognitionSourceCoverageSchema,
  CognitionSourceReadPlanSchema,
  CognitionMemoryHandoffSchema,
  CognitionSourceKindSchema,
  CognitionSourceRefSchema,
  CognitionObjectRefSchema,
  CognitionEffectSchema,
  CognitionRecollectionMetadataSchema,
  CognitionEvidenceInputSchema,
  CognitionEvidenceSchema,
  CognitionClaimSchema,
  CognitionEpisodeSchema,
  CognitionSituationSchema,
  CognitionConditionSchema,
  CognitionIntentSchema,
  CognitionAttentionStateSchema,
  CognitionDependenciesSchema,
  CognitionChoiceSchema,
  CognitionDecisionSchema,
  CognitionSelectedBasisSchema,
  CognitionActionReadSetSchema,
  CognitionAttemptStatusSchema,
  CognitionAllocationSchema,
  CognitionDecisionAttemptSchema,
  CognitionStateDeltaSchema,
  CognitionAnalysisSchema,
  CognitionSnapshotSchema,
  CognitionPreparedContextSchema,
} from "../schemas/cognition";

export type CognitionActor = Static<typeof CognitionActorSchema>;
export type CognitionSourceKind = Static<typeof CognitionSourceKindSchema>;
export type CognitionSourceRef = Static<typeof CognitionSourceRefSchema>;
export type CognitionObjectRef = Static<typeof CognitionObjectRefSchema>;
export type CognitionEffect = Static<typeof CognitionEffectSchema>;
export type CognitionRecollectionMetadata = Static<
  typeof CognitionRecollectionMetadataSchema
>;
export type CognitionEvidenceInput = Static<
  typeof CognitionEvidenceInputSchema
>;
export type CognitionEvidence = Static<typeof CognitionEvidenceSchema>;
export type CognitionClaim = Static<typeof CognitionClaimSchema>;
export type CognitionEpisode = Static<typeof CognitionEpisodeSchema>;
export type CognitionSituation = Static<typeof CognitionSituationSchema>;
export type CognitionCondition = Static<typeof CognitionConditionSchema>;
export type CognitionIntent = Static<typeof CognitionIntentSchema>;
export type CognitionAttentionState = Static<
  typeof CognitionAttentionStateSchema
>;
export type CognitionDependencies = Static<typeof CognitionDependenciesSchema>;
export type CognitionChoice = Static<typeof CognitionChoiceSchema>;
export type CognitionDecision = Static<typeof CognitionDecisionSchema>;
export type CognitionSelectedBasis = Static<
  typeof CognitionSelectedBasisSchema
>;
export type CognitionActionReadSet = Static<
  typeof CognitionActionReadSetSchema
>;
export type CognitionAttemptStatus = Static<
  typeof CognitionAttemptStatusSchema
>;
export type CognitionAllocation = Static<typeof CognitionAllocationSchema>;
export type CognitionDecisionAttempt = Static<
  typeof CognitionDecisionAttemptSchema
>;
export type CognitionStateDelta = Static<typeof CognitionStateDeltaSchema>;
export type CognitionAnalysis = Static<typeof CognitionAnalysisSchema>;
export type CognitionSnapshot = Static<typeof CognitionSnapshotSchema>;
export type CognitionPreparedContext = Static<
  typeof CognitionPreparedContextSchema
>;

export type CognitionMemoryHandoff = Static<
  typeof CognitionMemoryHandoffSchema
>;

/** A canonical original can back multiple observed representations. Revision is
 * intentionally absent: all uses of that same original must have settled. */
export interface CognitionSourceRetentionCandidate {
  readonly candidateId: string;
  readonly references: readonly Pick<
    CognitionSourceRef,
    "kind" | "id" | "fragment"
  >[];
}

export type CognitionSourceRetentionReason =
  | "current_view"
  | "unanalysed"
  | "decision"
  | "handoff"
  | "episode"
  | "claim"
  | "intent";

export interface CognitionSourceRetention {
  readonly candidateId: string;
  readonly reasons: readonly CognitionSourceRetentionReason[];
}

export type CognitionSourceCoverage = Static<
  typeof CognitionSourceCoverageSchema
>;
export type CognitionSourceReadPlan = Static<
  typeof CognitionSourceReadPlanSchema
>;
