import type { Static } from "@sinclair/typebox";

import type {
  EvidenceCoverageSchema,
  EvidencePackSchema,
  EvidenceSourceRefSchema,
  MemoryBasisSchema,
  MemoryEvidenceItemSchema,
  MemoryEvidenceReferenceSchema,
  MemoryFormationEpisodeSchema,
  MemoryFormationMaterialSchema,
  MemoryFormationSourceUseSchema,
  MemoryFormationSourceSchema,
  MemoryRevisionSemanticsSchema,
  MemorySourceSpanSchema,
  RecallPlanSchema,
  RecallQuestionSchema,
  RecallTimeScopeSchema,
} from "../schemas/memoryRecall";

export type RecallQuestion = Static<typeof RecallQuestionSchema>;
export type RecallTimeScope = Static<typeof RecallTimeScopeSchema>;
export type RecallPlan = Static<typeof RecallPlanSchema>;
export type EvidenceSourceRef = Static<typeof EvidenceSourceRefSchema>;
export type MemorySourceSpan = Static<typeof MemorySourceSpanSchema>;
export type MemoryBasis = Static<typeof MemoryBasisSchema>;
export type MemoryRevisionSemantics = Static<
  typeof MemoryRevisionSemanticsSchema
>;
export type MemoryEvidenceItem = Static<typeof MemoryEvidenceItemSchema>;
export type EvidenceCoverage = Static<typeof EvidenceCoverageSchema>;
export type EvidencePack = Static<typeof EvidencePackSchema>;
export type MemoryFormationSource = Static<typeof MemoryFormationSourceSchema>;
export type MemoryFormationEpisode = Static<
  typeof MemoryFormationEpisodeSchema
>;

export interface MemoryRecall {
  recall(plan: RecallPlan, signal?: AbortSignal): Promise<EvidencePack>;
  /** Return unavailable references using metadata only; safe inside Run allocation. */
  validateEvidenceReferences(
    request: MemoryEvidenceReferenceRequest,
  ): MemoryEvidenceReference[];
  /** Read only these exact revisions; no model, embedding, or replacement search. */
  resolveEvidence(request: MemoryEvidenceReadRequest): MemoryEvidenceResolution;
}

export type MemoryEvidenceReference = Static<
  typeof MemoryEvidenceReferenceSchema
>;

export interface MemoryEvidenceReferenceRequest {
  /** Reading may explain corrected records; grounding cannot treat them as facts. */
  readonly usage?: "read" | "grounding";
  readonly personaId: string;
  readonly references: readonly MemoryEvidenceReference[];
  /** Host-captured qualification of an actual prior reading, not model-supplied constraints. */
  readonly expectedHistory?: readonly Pick<
    MemoryEvidenceItem,
    "memoryId" | "revisionId" | "historyStatus" | "historyStatusRevisionId"
  >[];
  readonly retrieval?: Pick<RecallPlan, "timeScope" | "references">;
}

export interface MemoryEvidenceReadRequest extends MemoryEvidenceReferenceRequest {
  readonly resourceBudget: { readonly maxReadBytes: number };
}

/** Scalar bytes and rows in the selected SQL projection, not JSON, tokens or heap. */
export interface MemoryEvidenceReadCost {
  readonly rawValueBytes: number;
  readonly rowCount: number;
}

export type MemoryEvidenceResolution =
  | {
      readonly status: "resolved";
      readonly items: MemoryEvidenceItem[];
      readonly readCost: MemoryEvidenceReadCost;
    }
  | {
      readonly status: "unavailable";
      readonly unavailable: MemoryEvidenceReference[];
    }
  | {
      readonly status: "resource_limit";
      readonly readCost: MemoryEvidenceReadCost;
    };

export type MemoryFormationSourceUse = Static<
  typeof MemoryFormationSourceUseSchema
>;
export type MemoryFormationMaterial = Static<
  typeof MemoryFormationMaterialSchema
>;

/** Durable intake carries references; raw sources are loaded once on demand. */
export interface MemoryFormationIntake {
  readonly episode: MemoryFormationEpisode;
  readonly sources: () => Iterable<MemoryFormationSourceUse>;
  readonly resolveSource: (
    sourceId: string,
  ) => MemoryFormationSource | undefined;
}

export interface MemoryFormationWorkRef {
  readonly workId: string;
  readonly episodeId: string;
  readonly sourceVersion: string;
  readonly processorVersion: string;
  readonly status: "pending" | "running" | "complete" | "failed";
}

/** Metadata for one complete canonical body; no source text is materialized. */
export interface MemoryCanonicalSourceCandidate extends Omit<
  MemoryFormationSource,
  "content"
> {
  readonly length: number;
  readonly jsonBytes: number;
}

export interface MemoryCanonicalStorageStats {
  readonly presentSources: number;
  readonly releasedSources: number;
  readonly rawUtf16Bytes: number;
  readonly quoteUtf8Bytes: number;
}

export interface MemorySourceReclamation {
  /** Keyset read of one candidate not needed by unfinished formation work. */
  nextReclaimableSource(
    afterSourceId?: string,
  ): MemoryCanonicalSourceCandidate | undefined;
  /** Must share Main's synchronous consumer-check transaction; rechecks Memory work. */
  releaseCanonicalSource(sourceId: string): boolean;
  canonicalStorageStats(): MemoryCanonicalStorageStats;
}
