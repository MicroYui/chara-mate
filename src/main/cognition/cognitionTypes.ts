import type { InputBudgetEstimate } from "../providers/inputBudget";
import type { Run, UserInputQuestion } from "../../shared/contracts/run";
import type { ToolDescriptor } from "../../shared/contracts/tool";
import type { EvidencePack } from "../../shared/contracts/memoryRecall";
import type {
  CognitionAnalysis,
  CognitionActor,
  CognitionChoice,
  CognitionDecisionAttempt,
  CognitionEvidenceInput,
  CognitionPreparedContext,
  CognitionSnapshot,
  CognitionSourceCoverage,
} from "../../shared/contracts/cognition";

export const CHARACTER_LIFE_PAUSED_BLOCKER = "autonomous_life_paused";

export type {
  CognitionActor,
  CognitionSourceKind,
  CognitionSourceRef,
  CognitionObjectRef,
  CognitionEvidenceInput,
  CognitionEvidence,
  CognitionClaim,
  CognitionEpisode,
  CognitionSituation,
  CognitionCondition,
  CognitionIntent,
  CognitionEffect,
  CognitionAttentionState,
  CognitionDependencies,
  CognitionChoice,
  CognitionSelectedBasis,
  CognitionActionReadSet,
  CognitionDecision,
  CognitionAttemptStatus,
  CognitionDecisionAttempt,
  CognitionStateDelta,
  CognitionAnalysis,
  CognitionSnapshot,
  CognitionPreparedContext,
  CognitionMemoryHandoff,
} from "../../shared/contracts/cognition";

export interface CognitionRuntimeAvailability {
  /** Current execution/Voice ownership, not an unanswered historical question. */
  userEngaged: boolean;
  /** Ordinary queued/running Runs; waiting questions and approvals are resumable. */
  activeUserRunIds: string[];
  /** Same-Chat allocation boundaries. Waiting material may continue only through
   * the exact supplied question; this does not mark it answered. */
  chatRuns: {
    runId: string;
    chatId: string;
    status: Run["status"];
    waitingInput?: { itemId: string; questions: readonly UserInputQuestion[] };
  }[];
  continuableInput?: { runId: string; itemId: string };
  waitingIntentRunIds?: string[];
  selectedChatId?: string;
  activeCharacterRunId?: string;
  activeVoice: boolean;
  sleeping: boolean;
  hasOutstandingBubble: boolean;
  mayInitiateConversation: boolean;
  mayActInTerritory: boolean;
  /** Current own-life Run capability metadata, independent of temporary availability. */
  characterTools: readonly Pick<
    ToolDescriptor,
    "name" | "summary" | "description" | "effect"
  >[];
}
export interface CognitionAnalysisInput {
  attempt: CognitionDecisionAttempt;
  snapshot: CognitionSnapshot;
  evidencePack?: EvidencePack;
  availability: CognitionRuntimeAvailability;
  coverage?: CognitionAnalysisCoverage;
  /** Canonical source cost facts, not an allocation or new semantic evidence. */
  executionMaterial?: {
    sources: {
      evidenceId: string;
      /** Complete canonical UTF-8 payload size, not model tokens or a consumer quota. */
      fullPayloadBytes?: number;
      resolution: "evidence" | "memory_domain" | "unavailable";
    }[];
  };
}
/** Projection metadata, never a replacement for the original persisted evidence/state. */
export interface CognitionPassiveSpan {
  fromSequence: number;
  throughSequence: number;
  firstEvidenceId: string;
  lastEvidenceId: string;
  actor: CognitionActor;
  boundary: "interaction" | "idle";
  objectKey?: string;
  sourceKind: string;
  sourceEpoch?: string;
  firstAt: string;
  lastAt: string;
  eventCount: number;
  interaction: { clicks: number; keystrokes: number; scrolls: number };
}
export interface CognitionAnalysisCoverage {
  sourceCoverage?: CognitionSourceCoverage;
  /** Reference discovery/read gaps, not an assertion that historical state is absent. */
  stateReferences?: {
    missing: boolean;
    omittedForBudget: boolean;
    sourceMappingMissingCount: number;
    sourceMappingTruncated: boolean;
  };
  passiveSpans?: CognitionPassiveSpan[];
  /** Actual latest focused-object evidence, possibly ahead of the historical watermark. */
  currentViewEvidenceId?: string;
  /** Latest unread real user utterance; early visibility never advances the FIFO watermark. */
  currentUserSource?: {
    evidenceId: string;
    status: "complete" | "excerpted" | "omitted";
    /** Observed same-Run speech/lifecycle, never proof of Tool or world effects. */
    runResponse?: {
      runId: string;
      replyObserved: boolean;
      terminalObserved: boolean;
      evidenceIds: string[];
      omittedForBudget: boolean;
    };
  };
  excerptedEvidenceIds: string[];
  omittedSituationCount: number;
  omittedIntentCount: number;
  omittedAttemptCount: number;
  moreEvidencePending?: boolean;
  allocation?: CognitionDecisionAttempt["allocation"];
  note: string;
}
/** IDs only: the reader must obtain current canonical revisions and allocations. */
export interface CognitionStateReferences {
  situationIds: string[];
  intentIds: string[];
  /** Exact source-matched children, prioritized within the same bounded parent view. */
  situationChildren?: {
    situationId: string;
    claimIds: string[];
    episodeIds: string[];
  }[];
  missingReferenceCount: number;
  truncated: boolean;
}
/** Only a complete input rejected before this analyze call generated any output. */
export class CognitionInputBudgetError extends RangeError {
  constructor(
    readonly measurement: InputBudgetEstimate,
    readonly budget: number,
  ) {
    super(
      "Cognition request exceeds the complete model input budget before generation",
    );
    this.name = "CognitionInputBudgetError";
  }
}
export interface CognitionDriver {
  analyze(
    input: CognitionAnalysisInput,
    signal: AbortSignal,
  ): Promise<CognitionAnalysis>;
}
/** Exact coverage for the ordinary conversation reader, not analysis progress. */
export interface CognitionConversationCoverage {
  allocation: NonNullable<CognitionDecisionAttempt["allocation"]>;
  excerptedEvidenceIds: string[];
  /** Receipt identity remains present; its retired original body is not supplied. */
  releasedEvidenceIds: string[];
  missing: {
    situationIds: string[];
    intentIds: string[];
    evidenceIds: string[];
  };
  omittedForResource: {
    situationIds: string[];
    intentIds: string[];
    evidenceIds: string[];
  };
  /** Only the latest Attempt can qualify a selected fulfilled Intent. */
  selectionOmittedForResource: boolean;
  incompleteSituationClaims: string[];
  incompleteIntentSources: string[];
}
export interface CognitionConversationRead {
  snapshot: CognitionSnapshot;
  coverage: CognitionConversationCoverage;
  /** Real receipt boundary, never the represented FIFO prefix. */
  receivedThroughSequence: number;
  /** UTF-8 payload/field strings actually returned by body reads, including
   * partial fields. Initial attention routing, SQL identity/size/count probes
   * and JS framing are outside this body-query cost, as in action reads. */
  readCost: { rawValueBytes: number; rowCount: number };
}
/** Omitted third projection argument means a complete caller-owned in-memory
 * view. Production preparation always supplies its actual read coverage. */
export interface CognitionConversationProjectionRead {
  coverage: CognitionConversationCoverage | CognitionAnalysisCoverage;
  receivedThroughSequence: number;
}
export interface CognitionTurnInput {
  personaId: string;
  chatId: string;
  currentInput: string;
  contextBudget: { maxTokens: number };
  resourceBudget: { maxReadBytes: number };
  signal: AbortSignal;
}
export interface CognitionDispatchRequest {
  attemptId: string;
  signal: AbortSignal;
  dispatchKey: string;
  personaId: string;
  choice: CognitionChoice;
  readonly prepareContext: (budget: {
    readonly maxReadBytes: number;
    readonly signal: AbortSignal;
  }) => CognitionPreparedContext;
}
export interface CognitionDispatchResult {
  runId: string;
  /** Receipt of context acceptance, never a new Run or completed contribution. */
  continuedInputItemId?: string;
}
export interface CognitionRuntimePort {
  availability(
    personaId: string,
    attempt?: CognitionDecisionAttempt,
    ownRunId?: string,
  ): CognitionRuntimeAvailability;
  // Must reserve-or-retrieve using dispatchKey in the same SQLite transaction as Run allocation.
  dispatch(request: CognitionDispatchRequest): Promise<CognitionDispatchResult>;
  yieldCharacterRun(personaId: string, continuingRunId?: string): Promise<void>;
  reconcileRun(runId: string): {
    terminal: boolean;
    // A completed requested contribution may be waiting for its selected surface.
    deliveryPending?: boolean;
    unsuccessful?: "failed" | "interrupted";
    evidence: CognitionEvidenceInput[];
  };
}
export interface CognitionServiceContract {
  ingest(evidence: CognitionEvidenceInput): void;
  prepareTurn(input: CognitionTurnInput): Promise<CognitionPreparedContext>;
  observeFeedback(evidence: CognitionEvidenceInput): void;
  yieldToUser(personaId: string, continuingRunId?: string): Promise<void>;
  runDue(now?: string): Promise<void>;
  earliestNextRunAt(): string | undefined;
  getSnapshot(personaId: string): CognitionSnapshot;
  retryAfterConfigurationChange(): void;
  notifyVisualChange(): void;
  shutdown(): Promise<void>;
}

export type CognitionActionFreshness =
  | { current: true }
  | {
      current: false;
      reason:
        | "missing_basis"
        | "control_changed"
        | "intent_changed"
        | "situation_changed"
        | "claim_changed"
        | "object_changed"
        | "focus_changed"
        | "source_missing"
        | "cue_changed";
      referenceId?: string;
    };
