import {
  CHARACTER_LIFE_PAUSED_BLOCKER,
  type CognitionAnalysisInput,
} from "./cognitionTypes";
import { validateSourceReadPlan } from "./cognitionSourceCatalogue";
import type {
  CognitionSourceRetentionCandidate,
  CognitionSourceRetention,
} from "../../shared/contracts/cognition";
import { retainedSourceUses } from "./cognitionSourceRetention";
import type {
  MemoryEvidenceReference,
  MemoryEvidenceReferenceRequest,
} from "../../shared/contracts/memoryRecall";
import { readSelectedActionMaterial } from "./cognitionActionContext";
import {
  compileActionReadSet,
  actionFreshness,
} from "./cognitionActionReadSet";
import { randomUUID } from "node:crypto";
import { readPassiveSpan } from "./cognitionPassiveSpans";
import type Database from "better-sqlite3";
import {
  readCognitionSnapshot,
  readConversationContext,
  readEvidenceMetadata,
  type CognitionSnapshotRead,
} from "./cognitionSnapshotReader";

import {
  CognitionAnalysisSchema,
  CognitionAttentionStateSchema,
  CognitionDecisionAttemptSchema,
  CognitionEvidenceInputSchema,
  CognitionEvidenceSchema,
  CognitionIntentSchema,
  CognitionSituationSchema,
} from "../../shared/schemas/cognition";
import { parseSchema } from "../../shared/schemas/validation";
import { sanitizeForPersistence } from "../db/persistenceBoundary";
import {
  choiceBlockReason,
  CognitionConflictError,
  resolveCognitionAnalysis,
} from "./cognitionProjection";
import type {
  CognitionAnalysis,
  CognitionConversationRead,
  CognitionPreparedContext,
  CognitionActionFreshness,
  CognitionChoice,
  CognitionClaim,
  CognitionAttentionState,
  CognitionDecisionAttempt,
  CognitionEvidence,
  CognitionEvidenceInput,
  CognitionIntent,
  CognitionMemoryHandoff,
  CognitionRuntimeAvailability,
  CognitionSituation,
  CognitionSnapshot,
  CognitionSourceRef,
  CognitionStateReferences,
} from "./cognitionTypes";

import {
  enqueueMemoryHandoff,
  pendingMemoryHandoffs,
  memoryHandoffEvidence,
  memoryHandoffContext,
  acknowledgeMemoryHandoff,
  type CognitionMemoryHandoffInput,
} from "./cognitionMemoryHandoff";

interface JsonRow {
  payload_json: string;
}

export class CognitionRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly options: { readBudgetBytes: number },
  ) {
    if (
      !Number.isSafeInteger(options.readBudgetBytes) ||
      options.readBudgetBytes <= 0
    )
      throw new RangeError(
        "Cognition requires an explicit read byte allocation",
      );
  }

  getAttention(personaId: string, now: string): CognitionAttentionState {
    const row = this.database
      .prepare("SELECT payload_json FROM cognition_state WHERE persona_id = ?")
      .get(personaId) as JsonRow | undefined;
    if (row)
      return parseSchema(
        CognitionAttentionStateSchema,
        JSON.parse(row.payload_json),
      );
    const state = this.initialAttention(personaId, now);
    this.saveAttention(state);
    return state;
  }

  private initialAttention(
    personaId: string,
    now: string,
  ): CognitionAttentionState {
    return {
      personaId,
      revision: 0,
      userGeneration: 0,
      focusRevision: 0,
      lastReceiptSequence: 0,
      analyzedThroughSequence: 0,
      catalogueReviewedThroughSequence: 0,
      updatedAt: now,
    };
  }

  private saveAttention(value: CognitionAttentionState): void {
    const state = sanitizeForPersistence(CognitionAttentionStateSchema, value);
    // A successfully consumed contiguous source prefix also covers those source
    // identities. Reviewing a catalogue may move farther; the converse never
    // implies body consumption.
    state.catalogueReviewedThroughSequence = Math.max(
      state.catalogueReviewedThroughSequence ?? 0,
      state.analyzedThroughSequence,
    );
    this.database
      .prepare(
        `INSERT INTO cognition_state (
      persona_id, revision, user_generation, focus_revision, last_receipt_sequence,
      analyzed_through_sequence, current_situation_id, committed_intent_id, next_wake_at,
      payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(persona_id) DO UPDATE SET revision=excluded.revision,
      user_generation=excluded.user_generation, focus_revision=excluded.focus_revision,
      last_receipt_sequence=excluded.last_receipt_sequence,
      analyzed_through_sequence=excluded.analyzed_through_sequence,
      current_situation_id=excluded.current_situation_id,
      committed_intent_id=excluded.committed_intent_id, next_wake_at=excluded.next_wake_at,
      payload_json=excluded.payload_json, updated_at=excluded.updated_at`,
      )
      .run(
        state.personaId,
        state.revision,
        state.userGeneration,
        state.focusRevision,
        state.lastReceiptSequence,
        state.analyzedThroughSequence,
        state.currentSituationId ?? null,
        state.committedIntentId ?? null,
        state.nextWakeAt ?? null,
        JSON.stringify(state),
        state.updatedAt,
      );
  }

  updateAttention(
    personaId: string,
    now: string,
    update: (state: CognitionAttentionState) => CognitionAttentionState,
  ): CognitionAttentionState {
    return this.database.transaction(() => {
      const previous = this.getAttention(personaId, now);
      const value = update(structuredClone(previous));
      const next = {
        ...value,
        personaId,
        revision: previous.revision + 1,
        updatedAt: now,
      };
      this.saveAttention(next);
      return next;
    })();
  }

  ingest(
    input: CognitionEvidenceInput,
    now: string,
  ): { evidence: CognitionEvidence; inserted: boolean } {
    const value = sanitizeForPersistence(CognitionEvidenceInputSchema, input);
    if (value.visibility?.status === "protected" && value.text) {
      throw new CognitionConflictError(
        "Protected content cannot enter evidence",
      );
    }
    if (
      value.opportunity &&
      (value.source.kind !== "memory" ||
        !value.source.revision ||
        value.actor !== "system" ||
        value.kind !== "observation" ||
        value.chatId !== value.opportunity.targetChatId ||
        value.opportunity.evaluateAt >= value.opportunity.occursAt)
    ) {
      throw new CognitionConflictError(
        "Important-moment evidence requires its actual memory revision, time and Chat",
      );
    }
    if (
      value.source.kind === "memory" &&
      !value.opportunity &&
      value.kind !== "recollection"
    )
      throw new CognitionConflictError(
        "A retrieved memory requires recollection kind; it is not a new utterance or observation",
      );
    if (value.kind === "recollection") {
      if (
        !value.recollection ||
        (value.recollection.personaId &&
          value.recollection.personaId !== value.personaId) ||
        value.actor !== "system" ||
        value.source.kind !== "memory" ||
        !value.source.revision ||
        !value.source.fragment ||
        value.object ||
        value.visual ||
        value.effect ||
        value.opportunity ||
        value.control ||
        value.interaction
      )
        throw new CognitionConflictError(
          "Recollection requires actual memory metadata and retrieval identity, without world effects or user control",
        );
    } else if (value.recollection) {
      throw new CognitionConflictError(
        "Memory reading metadata requires recollection kind",
      );
    }
    if (value.effect && value.kind !== "effect") {
      throw new CognitionConflictError(
        "Effect receipt requires effect evidence kind",
      );
    }
    return this.database.transaction(() => {
      if (
        value.kind === "recollection" &&
        !this.database
          .prepare(
            "SELECT id FROM cognition_decision_attempts WHERE id = ? AND persona_id = ?",
          )
          .get(value.source.fragment, value.personaId)
      )
        throw new CognitionConflictError(
          "Recollection reading must belong to an actual decision attempt",
        );
      const existing = this.database
        .prepare(
          `SELECT payload_json FROM cognition_evidence
        WHERE id = ? OR (persona_id = ? AND source_kind = ? AND source_id = ?
          AND source_revision = ? AND source_fragment = ? AND kind = ?)`,
        )
        .get(
          value.id,
          value.personaId,
          value.source.kind,
          value.source.id,
          value.source.revision ?? "",
          value.source.fragment ?? "",
          value.kind,
        ) as JsonRow | undefined;
      if (existing) {
        const evidence = parseSchema(
          CognitionEvidenceSchema,
          JSON.parse(existing.payload_json),
        );
        if (
          evidence.personaId !== value.personaId ||
          evidence.actor !== value.actor ||
          evidence.source.id !== value.source.id ||
          evidence.source.kind !== value.source.kind
        ) {
          throw new CognitionConflictError(
            "Evidence identity reused for another source or actor",
          );
        }
        return { evidence, inserted: false };
      }
      const result = this.database
        .prepare(
          `INSERT INTO cognition_evidence (
        id, persona_id, source_kind, source_id, source_revision, source_fragment, actor, kind,
        observed_at, received_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.personaId,
          value.source.kind,
          value.source.id,
          value.source.revision ?? "",
          value.source.fragment ?? "",
          value.actor,
          value.kind,
          value.observedAt,
          now,
          JSON.stringify(value),
        );
      const evidence = sanitizeForPersistence(CognitionEvidenceSchema, {
        ...value,
        receiptSequence: Number(result.lastInsertRowid),
        receivedAt: now,
      });
      this.database
        .prepare("UPDATE cognition_evidence SET payload_json = ? WHERE id = ?")
        .run(JSON.stringify(evidence), evidence.id);
      const previous = this.getAttention(value.personaId, now);
      const userControl =
        value.control === "user_engaged" ||
        value.control === "user_stop" ||
        value.control === "user_correction" ||
        value.control === "persona_changed";
      this.saveAttention({
        ...previous,
        ...this.physicalFocusUpdate(value, previous),
        revision: previous.revision + 1,
        userGeneration: previous.userGeneration + Number(userControl),
        lastReceiptSequence: evidence.receiptSequence,
        updatedAt: now,
      });
      return { evidence, inserted: true };
    })();
  }

  /** Keep source ordering even when identical content has no new journal receipt. */
  recordCoalescedObservation(input: CognitionEvidenceInput, now: string): void {
    const value = sanitizeForPersistence(CognitionEvidenceInputSchema, input);
    this.database.transaction(() => {
      const previous = this.getAttention(value.personaId, now);
      const update = this.physicalFocusUpdate(value, previous);
      if (!update) return;
      this.saveAttention({ ...previous, ...update, updatedAt: now });
    })();
  }

  private physicalFocusUpdate(
    value: CognitionEvidenceInput,
    previous: CognitionAttentionState,
  ):
    | Pick<
        CognitionAttentionState,
        "foregroundObject" | "foregroundObservationClock" | "focusRevision"
      >
    | undefined {
    if (
      (value.actor !== "user" && value.actor !== "unknown") ||
      value.kind !== "observation" ||
      !value.object
    )
      return undefined;
    // The journal retains known source epochs; the current clock also covers
    // identical observations coalesced without changing historical evidence.
    const latestObject = this.database
      .prepare(
        `SELECT observed_at FROM cognition_evidence
      WHERE persona_id = ? AND actor IN ('user', 'unknown') AND kind = 'observation'
        AND json_extract(payload_json, '$.object') IS NOT NULL AND id != ?
      ORDER BY observed_at DESC, receipt_sequence DESC LIMIT 1`,
      )
      .get(value.personaId, value.id) as { observed_at: string } | undefined;
    const clock = previous.foregroundObservationClock;
    const latestObservedAt = [latestObject?.observed_at, clock?.observedAt]
      .filter((at): at is string => at !== undefined)
      .sort()
      .at(-1);
    const hasSequence =
      value.sourceEpoch !== undefined && value.sourceSequence !== undefined;
    const journalSequence = hasSequence
      ? (
          this.database
            .prepare(
              `SELECT MAX(json_extract(payload_json, '$.sourceSequence')) AS sequence
        FROM cognition_evidence WHERE persona_id = ? AND source_kind = ? AND actor IN ('user', 'unknown')
        AND kind = 'observation' AND json_extract(payload_json, '$.sourceEpoch') = ? AND id != ?`,
            )
            .get(
              value.personaId,
              value.source.kind,
              value.sourceEpoch,
              value.id,
            ) as {
            sequence: number | null;
          }
        ).sequence
      : undefined;
    const clockSequence =
      hasSequence &&
      clock?.sourceKind === value.source.kind &&
      clock.sourceEpoch === value.sourceEpoch
        ? clock.sourceSequence
        : undefined;
    const lateInEpoch =
      hasSequence &&
      value.sourceSequence! <=
        Math.max(journalSequence ?? -1, clockSequence ?? -1);
    if (
      lateInEpoch ||
      (latestObservedAt && value.observedAt < latestObservedAt)
    )
      return undefined;
    return {
      foregroundObject: value.object,
      foregroundObservationClock: {
        observedAt: value.observedAt,
        sourceKind: value.source.kind,
        ...(value.sourceEpoch !== undefined
          ? { sourceEpoch: value.sourceEpoch }
          : {}),
        ...(value.sourceSequence !== undefined
          ? { sourceSequence: value.sourceSequence }
          : {}),
      },
      focusRevision:
        previous.focusRevision +
        Number(previous.foregroundObject?.key !== value.object.key),
    };
  }

  getSituation(id: string): CognitionSituation | undefined {
    const row = this.database
      .prepare("SELECT payload_json FROM cognition_situations WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row
      ? parseSchema(CognitionSituationSchema, JSON.parse(row.payload_json))
      : undefined;
  }

  getIntent(id: string): CognitionIntent | undefined {
    const row = this.database
      .prepare("SELECT payload_json FROM cognition_intents WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row
      ? parseSchema(CognitionIntentSchema, JSON.parse(row.payload_json))
      : undefined;
  }

  *characterIntents(personaId: string): Iterable<CognitionIntent> {
    let id = "";
    const next = this.database
      .prepare(`SELECT id,payload_json FROM cognition_intents WHERE persona_id = ? AND owner = 'character'
      AND status NOT IN ('fulfilled','abandoned') AND id > ? ORDER BY id LIMIT 1`);
    for (;;) {
      const row = next.get(personaId, id) as
        (JsonRow & { id: string }) | undefined;
      if (!row) return;
      id = row.id;
      yield parseSchema(CognitionIntentSchema, JSON.parse(row.payload_json));
    }
  }

  currentCharacterIntent(
    personaId: string,
    now: string,
  ): CognitionIntent | undefined {
    const committed = this.getAttention(personaId, now).committedIntentId;
    const row = this.database
      .prepare(
        `SELECT payload_json FROM cognition_intents WHERE persona_id = ? AND owner = 'character'
      AND status NOT IN ('fulfilled','abandoned') ORDER BY (id = ?) DESC,updated_at DESC,id DESC LIMIT 1`,
      )
      .get(personaId, committed ?? "") as JsonRow | undefined;
    return row
      ? parseSchema(CognitionIntentSchema, JSON.parse(row.payload_json))
      : undefined;
  }

  isCharacterPaused(personaId: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM cognition_intents i,json_each(i.payload_json,'$.blockers') blocker
      WHERE i.persona_id = ? AND i.owner = 'character' AND i.status NOT IN ('fulfilled','abandoned')
        AND blocker.value = 'autonomous_life_paused' LIMIT 1`,
        )
        .get(personaId) !== undefined
    );
  }

  latestObservation(
    personaId: string,
    actor: string,
  ): CognitionEvidence | undefined {
    const row = this.database
      .prepare(
        `SELECT payload_json FROM cognition_evidence
      WHERE persona_id = ? AND actor = ? AND kind = 'observation'
      ORDER BY receipt_sequence DESC LIMIT 1`,
      )
      .get(personaId, actor) as JsonRow | undefined;
    return row
      ? parseSchema(CognitionEvidenceSchema, JSON.parse(row.payload_json))
      : undefined;
  }

  private saveSituation(input: CognitionSituation): void {
    const value = sanitizeForPersistence(CognitionSituationSchema, input);
    this.database
      .prepare(
        `INSERT INTO cognition_situations
      (id, persona_id, revision, status, superseded_by, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      revision=excluded.revision, status=excluded.status, superseded_by=excluded.superseded_by,
      payload_json=excluded.payload_json, updated_at=excluded.updated_at`,
      )
      .run(
        value.id,
        value.personaId,
        value.revision,
        value.status,
        value.supersededBy ?? null,
        JSON.stringify(value),
        value.createdAt,
        value.updatedAt,
      );
    this.database
      .prepare("DELETE FROM cognition_episode_evidence WHERE situation_id = ?")
      .run(value.id);
    for (const episode of value.episodes)
      this.replaceEpisodeSources(value.id, episode.id, episode.evidenceIds);
    this.database
      .prepare("DELETE FROM cognition_claim_evidence WHERE situation_id = ?")
      .run(value.id);
    for (const claim of value.claims) this.replaceClaimSources(value.id, claim);
  }

  private replaceClaimSources(
    situationId: string,
    claim: CognitionClaim,
  ): void {
    this.database
      .prepare(
        "DELETE FROM cognition_claim_evidence WHERE situation_id = ? AND claim_id = ?",
      )
      .run(situationId, claim.id);
    const insert = this.database.prepare(
      "INSERT OR IGNORE INTO cognition_claim_evidence (situation_id,claim_id,evidence_id,state,current_basis) VALUES (?,?,?,?,?)",
    );
    const current = new Set([
      ...claim.evidenceIds,
      ...claim.contradictingEvidenceIds,
    ]);
    for (const evidenceId of new Set([
      ...current,
      ...(claim.historyEvidenceIds ?? []),
    ]))
      insert.run(
        situationId,
        claim.id,
        evidenceId,
        claim.state,
        Number(current.has(evidenceId)),
      );
  }

  private replaceEpisodeSources(
    situationId: string,
    episodeId: string,
    evidenceIds: readonly string[],
  ): void {
    this.database
      .prepare(
        "DELETE FROM cognition_episode_evidence WHERE situation_id = ? AND episode_id = ?",
      )
      .run(situationId, episodeId);
    const insert = this.database.prepare(
      "INSERT OR IGNORE INTO cognition_episode_evidence (situation_id,episode_id,evidence_id) VALUES (?,?,?)",
    );
    for (const evidenceId of evidenceIds)
      insert.run(situationId, episodeId, evidenceId);
  }

  saveIntent(
    input: CognitionIntent,
    expectedRevision?: number,
  ): CognitionIntent {
    const value = sanitizeForPersistence(CognitionIntentSchema, input);
    return this.database.transaction(() => {
      const previous = this.getIntent(value.id);
      if (
        expectedRevision !== undefined &&
        previous?.revision !== expectedRevision
      ) {
        throw new CognitionConflictError("Intent changed before save");
      }
      if (previous && previous.personaId !== value.personaId) {
        throw new CognitionConflictError("Intent belongs to another persona");
      }
      this.database
        .prepare(
          `INSERT INTO cognition_intents
        (id, persona_id, situation_id, revision, owner, basis, status, next_wake_at, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        situation_id=excluded.situation_id, revision=excluded.revision, owner=excluded.owner,
        basis=excluded.basis, status=excluded.status, next_wake_at=excluded.next_wake_at,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at`,
        )
        .run(
          value.id,
          value.personaId,
          value.situationId ?? null,
          value.revision,
          value.owner,
          value.basis,
          value.status,
          value.nextWakeAt ?? null,
          JSON.stringify(value),
          value.createdAt,
          value.updatedAt,
        );
      return value;
    })();
  }

  opportunityPersonaIds(opportunityId: string): string[] {
    return (
      this.database
        .prepare(
          `SELECT DISTINCT persona_id FROM cognition_evidence
      WHERE json_extract(payload_json, '$.opportunity.id') = ?`,
        )
        .all(opportunityId) as { persona_id: string }[]
    ).map(({ persona_id }) => persona_id);
  }

  hasPendingOpportunity(personaId: string, now: string): boolean {
    for (const _id of this.pendingOpportunityEvidenceIds(personaId, now))
      return true;
    return false;
  }

  private *pendingOpportunityEvidenceIds(
    personaId: string,
    now: string,
  ): Iterable<string> {
    const rows = this.database
      .prepare(
        `SELECT e.id FROM cognition_evidence e
      WHERE e.persona_id = ? AND e.source_kind = 'memory' AND json_extract(e.payload_json, '$.opportunity.status') = 'due'
        AND json_extract(e.payload_json, '$.opportunity.occursAt') > ?
        AND NOT EXISTS (SELECT 1 FROM cognition_evidence newer WHERE newer.persona_id = e.persona_id
          AND json_extract(newer.payload_json, '$.opportunity.id') = json_extract(e.payload_json, '$.opportunity.id')
          AND newer.receipt_sequence > e.receipt_sequence)
        AND NOT EXISTS (SELECT 1 FROM cognition_decision_attempts a,
          json_each(a.payload_json, '$.decision.choices') c, json_each(c.value, '$.evidenceIds') used
          WHERE a.persona_id = e.persona_id AND used.value = e.id
            AND json_extract(c.value, '$.id') = json_extract(a.payload_json, '$.decision.selectedChoiceId')
            AND (a.status = 'dispatched' OR (a.status = 'settled'
              AND json_extract(a.payload_json, '$.outcome') IN ('quiet','delivered','performed','unknown'))))`,
      )
      .iterate(personaId, now) as Iterable<{ id: string }>;
    for (const row of rows) yield row.id;
  }

  /** Local routing consumes only a fully represented passive prefix, never semantic evidence. */
  consumePassivePrefix(personaId: string, now: string): void {
    this.database.transaction(() => {
      const attention = this.getAttention(personaId, now);
      let through = attention.analyzedThroughSequence;
      for (;;) {
        const first = this.database
          .prepare(
            `SELECT receipt_sequence FROM cognition_evidence
          WHERE persona_id = ? AND receipt_sequence > ? ORDER BY receipt_sequence LIMIT 1`,
          )
          .get(personaId, through) as { receipt_sequence: number } | undefined;
        if (!first) break;
        const span = readPassiveSpan(
          this.database,
          personaId,
          first.receipt_sequence,
          attention.lastReceiptSequence,
        );
        if (!span) break;
        through = span.throughSequence;
      }
      let reviewed =
        attention.catalogueReviewedThroughSequence ??
        attention.analyzedThroughSequence;
      for (;;) {
        const next = this.database
          .prepare(
            `SELECT receipt_sequence FROM cognition_evidence
          WHERE persona_id=? AND receipt_sequence>? ORDER BY receipt_sequence LIMIT 1`,
          )
          .get(personaId, reviewed) as { receipt_sequence: number } | undefined;
        if (!next) break;
        const span = readPassiveSpan(
          this.database,
          personaId,
          next.receipt_sequence,
          attention.lastReceiptSequence,
        );
        if (!span) break;
        reviewed = span.throughSequence;
      }
      if (
        through > attention.analyzedThroughSequence ||
        reviewed >
          (attention.catalogueReviewedThroughSequence ??
            attention.analyzedThroughSequence)
      )
        this.saveAttention({
          ...attention,
          revision: attention.revision + 1,
          analyzedThroughSequence: through,
          catalogueReviewedThroughSequence: reviewed,
          updatedAt: now,
        });
    })();
  }

  getSnapshot(personaId: string, now: string): CognitionSnapshot {
    return this.readSnapshot(personaId, now).snapshot;
  }

  readSnapshot(
    personaId: string,
    now: string,
    maxBytes = this.options.readBudgetBytes,
    referencedState?: CognitionStateReferences,
    retainedEvidenceIds: readonly string[] = [],
  ): CognitionSnapshotRead {
    return readCognitionSnapshot(
      this.database,
      this.getAttention(personaId, now),
      now,
      maxBytes,
      this.pendingOpportunityEvidenceIds(personaId, now),
      referencedState,
      retainedEvidenceIds,
    );
  }

  readConversationContext(
    personaId: string,
    now: string,
    resourceBudget: { maxReadBytes: number },
    signal: AbortSignal,
  ): CognitionConversationRead {
    signal.throwIfAborted();
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          "SELECT payload_json FROM cognition_state WHERE persona_id = ?",
        )
        .get(personaId) as JsonRow | undefined;
      const attention = row
        ? parseSchema(
            CognitionAttentionStateSchema,
            JSON.parse(row.payload_json),
          )
        : this.initialAttention(personaId, now);
      const result = readConversationContext(
        this.database,
        attention,
        resourceBudget.maxReadBytes,
        signal,
      );
      signal.throwIfAborted();
      return result;
    })();
  }

  /** Canonical aliases locate state, never qualify it as current action evidence. */
  stateReferencesForSources(
    personaId: string,
    candidates: readonly CognitionSourceRetentionCandidate[],
    maxBytes: number,
  ): CognitionStateReferences {
    const budget = maxBytes;
    const result: CognitionStateReferences = {
      situationIds: [],
      intentIds: [],
      missingReferenceCount: 0,
      truncated: false,
    };
    if (
      !Number.isSafeInteger(budget) ||
      budget <= 0 ||
      Buffer.byteLength(
        JSON.stringify({ ...result, missingReferenceCount: candidates.length }),
        "utf8",
      ) > budget
    )
      throw new RangeError(
        "State-reference allocation cannot hold its coverage metadata",
      );
    const situations = new Set<string>();
    const intents = new Set<string>();
    const add = (kind: "situation" | "intent", id: string): boolean => {
      const seen = kind === "situation" ? situations : intents;
      if (seen.has(id)) return true;
      const list =
        kind === "situation" ? result.situationIds : result.intentIds;
      list.push(id);
      // Reserve enough space for the largest possible unmapped-candidate count.
      const measured = { ...result, missingReferenceCount: candidates.length };
      if (Buffer.byteLength(JSON.stringify(measured), "utf8") > budget) {
        list.pop();
        result.truncated = true;
        return false;
      }
      seen.add(id);
      return true;
    };
    const addChild = (
      situationId: string,
      field: "claimIds" | "episodeIds",
      id: string,
    ): boolean => {
      const groups = (result.situationChildren ??= []);
      let group = groups.find((value) => value.situationId === situationId);
      const created = !group;
      if (!group) {
        group = { situationId, claimIds: [], episodeIds: [] };
        groups.push(group);
      }
      if (group[field].includes(id)) return true;
      group[field].push(id);
      if (
        Buffer.byteLength(
          JSON.stringify({
            ...result,
            missingReferenceCount: candidates.length,
          }),
          "utf8",
        ) > budget
      ) {
        group[field].pop();
        if (created) groups.pop();
        if (groups.length === 0) delete result.situationChildren;
        result.truncated = true;
        return false;
      }
      return true;
    };
    const parentIntents = this.database.prepare(
      "SELECT id FROM cognition_intents WHERE situation_id = ? AND persona_id = ? ORDER BY id",
    );
    const statements = [
      "cognition_episode_evidence",
      "cognition_claim_evidence",
    ].map((table) => ({
      field:
        table === "cognition_claim_evidence"
          ? ("claimIds" as const)
          : ("episodeIds" as const),
      statement: this.database
        .prepare(`SELECT link.situation_id, link.${table === "cognition_claim_evidence" ? "claim_id" : "episode_id"} AS child_id FROM cognition_evidence e
        CROSS JOIN ${table} link ON link.evidence_id=e.id
        CROSS JOIN cognition_situations s ON s.id=link.situation_id
        WHERE e.source_kind=? AND e.source_id=? AND e.source_fragment=?
          AND e.persona_id=? AND s.persona_id=?`),
    }));
    for (const candidate of candidates) {
      let matched = false;
      for (const reference of candidate.references) {
        for (const { statement, field } of statements) {
          for (const row of statement.iterate(
            reference.kind,
            reference.id,
            reference.fragment ?? "",
            personaId,
            personaId,
          ) as Iterable<{ situation_id: string; child_id: string }>) {
            matched = true;
            if (!add("situation", row.situation_id)) return result;
            if (!addChild(row.situation_id, field, row.child_id)) return result;
            for (const intent of parentIntents.iterate(
              row.situation_id,
              personaId,
            ) as Iterable<{ id: string }>)
              if (!add("intent", intent.id)) return result;
          }
        }
      }
      if (!matched) result.missingReferenceCount += 1;
    }
    return result;
  }

  /** Directory service progress is distinct from historical body exposure. */
  evidenceBodyStatus(
    personaId: string,
    evidenceId: string,
  ): "available" | "released" | "missing" {
    const row = this.database
      .prepare(
        `SELECT json_extract(payload_json,'$.bodyReleasedAt') AS released
      FROM cognition_evidence WHERE id=? AND persona_id=?`,
      )
      .get(evidenceId, personaId) as { released: string | null } | undefined;
    return row ? (row.released ? "released" : "available") : "missing";
  }

  nextReclaimableEvidenceBody(
    afterSequence: number,
  ): { id: string; receiptSequence: number } | undefined {
    const row = this.database
      .prepare(
        `SELECT e.id,e.receipt_sequence FROM cognition_evidence e
      JOIN cognition_state state ON state.persona_id=e.persona_id
      WHERE e.receipt_sequence>? AND e.receipt_sequence<=COALESCE(
        json_extract(state.payload_json,'$.catalogueReviewedThroughSequence'),state.analyzed_through_sequence)
        AND json_extract(e.payload_json,'$.bodyReleasedAt') IS NULL
        AND (json_extract(e.payload_json,'$.text') IS NOT NULL OR json_extract(e.payload_json,'$.visual') IS NOT NULL)
      ORDER BY e.receipt_sequence LIMIT 1`,
      )
      .get(afterSequence) as
      { id: string; receipt_sequence: number } | undefined;
    return row
      ? { id: row.id, receiptSequence: row.receipt_sequence }
      : undefined;
  }

  /** Each release rechecks all live consumers atomically. Preserve row/FK/source
   * identity and mark body absence; it is not a new empty observation. */
  releaseEvidenceBody(
    evidenceId: string,
    now: string,
  ): { payloadBytesBefore: number; payloadBytesAfter: number } | undefined {
    return this.database.transaction(() => {
      const evidence = readEvidenceMetadata(this.database, evidenceId);
      if (!evidence || evidence.bodyReleasedAt) return undefined;
      const state = this.getAttention(evidence.personaId, now);
      if (
        evidence.receiptSequence >
        (state.catalogueReviewedThroughSequence ??
          state.analyzedThroughSequence)
      )
        return undefined;
      if (
        this.protectedCanonicalSources([
          { candidateId: evidenceId, references: [evidence.source] },
        ]).length
      )
        return undefined;
      const measurement = this.database
        .prepare(
          `SELECT length(CAST(payload_json AS BLOB)) AS before,
        length(CAST(json_set(json_remove(payload_json,'$.text','$.visual'),'$.bodyReleasedAt',?) AS BLOB)) AS after
        FROM cognition_evidence WHERE id=?`,
        )
        .get(now, evidenceId) as { before: number; after: number };
      const changed = this.database
        .prepare(
          `UPDATE cognition_evidence
        SET payload_json=json_set(json_remove(payload_json,'$.text','$.visual'),'$.bodyReleasedAt',?)
        WHERE id=? AND json_extract(payload_json,'$.bodyReleasedAt') IS NULL
          AND (json_extract(payload_json,'$.text') IS NOT NULL OR json_extract(payload_json,'$.visual') IS NOT NULL)`,
        )
        .run(now, evidenceId).changes;
      return changed
        ? {
            payloadBytesBefore: measurement.before,
            payloadBytesAfter: measurement.after,
          }
        : undefined;
    })();
  }

  hasReviewableInput(personaId: string): boolean {
    const state = this.database
      .prepare(
        `SELECT COALESCE(json_extract(payload_json,
      '$.catalogueReviewedThroughSequence'),analyzed_through_sequence) AS reviewed
      FROM cognition_state WHERE persona_id=?`,
      )
      .get(personaId) as { reviewed: number } | undefined;
    return (
      this.hasUnanalyzedMeaning(personaId, state?.reviewed ?? 0) ||
      this.database
        .prepare(
          `SELECT 1 FROM cognition_decision_attempts a
        JOIN cognition_state state ON state.persona_id=a.persona_id
        WHERE a.persona_id=? AND a.user_generation=state.user_generation
          AND json_extract(a.payload_json,'$.sourceCoverage.completionPending')=1
          AND json_extract(a.payload_json,'$.sourceCoverage.readPlan') IS NOT NULL
          AND json_extract(a.payload_json,'$.sourceCoverage.throughSequence')>? LIMIT 1`,
        )
        .get(personaId, state?.reviewed ?? 0) !== undefined
    );
  }

  hasUnanalyzedMeaning(personaId: string, through?: number): boolean {
    const baseline =
      through ??
      (
        this.database
          .prepare(
            "SELECT analyzed_through_sequence FROM cognition_state WHERE persona_id = ?",
          )
          .get(personaId) as { analyzed_through_sequence: number } | undefined
      )?.analyzed_through_sequence ??
      0;
    return (
      this.database
        .prepare(
          `SELECT 1 FROM cognition_evidence WHERE persona_id = ? AND receipt_sequence > ?
      AND (source_kind != 'memory' OR json_extract(payload_json, '$.opportunity') IS NOT NULL)
      AND (COALESCE(json_extract(payload_json, '$.boundary'),'') NOT IN ('interaction','idle')
        OR (json_extract(payload_json, '$.boundary') = 'interaction'
          AND (COALESCE(json_extract(payload_json, '$.text'),'') != '' OR json_extract(payload_json, '$.visual') IS NOT NULL)))
      AND COALESCE(json_extract(payload_json, '$.visual.trigger'),'') != 'frame' LIMIT 1`,
        )
        .get(personaId, baseline) !== undefined
    );
  }

  earliestNextRunAt(personaId: string, after?: string): string | undefined {
    const row = this.database
      .prepare(
        `SELECT min(wake) AS wake FROM (
      SELECT next_wake_at AS wake FROM cognition_state WHERE persona_id = ?
      UNION ALL SELECT next_wake_at AS wake FROM cognition_intents WHERE persona_id = ? AND status NOT IN ('fulfilled','abandoned')) WHERE (? IS NULL OR wake > ?)`,
      )
      .get(personaId, personaId, after ?? null, after ?? null) as {
      wake: string | null;
    };
    return row.wake ?? undefined;
  }

  /** Only called in the final decision transaction, before its read-set is compiled. */
  private consumeAttemptWakes(
    attempt: CognitionDecisionAttempt,
    now: string,
  ): void {
    for (const source of attempt.wakeSources?.intents ?? []) {
      const current = this.getIntent(source.id);
      if (
        !current ||
        current.personaId !== attempt.personaId ||
        current.nextWakeAt !== source.nextWakeAt
      )
        continue;
      const value = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
      };
      delete value.nextWakeAt;
      this.saveIntent(value, current.revision);
    }
  }

  /** Restore an unbound consideration; never overwrite a later plan or replay a bound Run. */
  restoreAttemptWakes(attempt: CognitionDecisionAttempt, now: string): void {
    this.database.transaction(() => {
      const stored = this.getAttempt(attempt.id);
      if (
        !stored ||
        stored.runId ||
        stored.status === "settled" ||
        !stored.wakeSources
      )
        return;
      const state = this.getAttention(stored.personaId, now);
      if (state.userGeneration !== stored.dependencies.userGeneration) return;
      for (const source of stored.wakeSources.intents) {
        const current = this.getIntent(source.id);
        const expected = stored.dependencies.intents.find(
          ({ id }) => id === source.id,
        );
        if (
          !current ||
          current.personaId !== stored.personaId ||
          current.revision !== expected?.revision ||
          !["active", "candidate"].includes(current.status) ||
          current.nextWakeAt ||
          current.blockers.includes(CHARACTER_LIFE_PAUSED_BLOCKER)
        )
          continue;
        this.saveIntent(
          {
            ...current,
            revision: current.revision + 1,
            nextWakeAt: source.nextWakeAt,
            updatedAt: now,
          },
          current.revision,
        );
      }
      const attentionWakeAt = stored.wakeSources.attentionWakeAt;
      if (!state.nextWakeAt && attentionWakeAt)
        this.updateAttention(stored.personaId, now, (current) => ({
          ...current,
          nextWakeAt: attentionWakeAt,
        }));
    })();
  }

  *unfinishedAttempts(personaId: string): Iterable<CognitionDecisionAttempt> {
    let id = "";
    const query = this.database
      .prepare(`SELECT id,payload_json FROM cognition_decision_attempts WHERE persona_id = ?
      AND status NOT IN ('settled','failed','superseded') AND id > ? ORDER BY id LIMIT 1`);
    for (;;) {
      const row = query.get(personaId, id) as
        (JsonRow & { id: string }) | undefined;
      if (!row) return;
      id = row.id;
      yield parseSchema(
        CognitionDecisionAttemptSchema,
        JSON.parse(row.payload_json),
      );
    }
  }

  hasFailedWork(personaId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT status FROM cognition_decision_attempts WHERE persona_id = ? ORDER BY creation_sequence DESC LIMIT 1`,
      )
      .get(personaId) as { status: string } | undefined;
    return row?.status === "failed" || row?.status === "superseded";
  }

  /** Guards inspect persistent revisions and source metadata, never just the current input page. */
  /** Execution gates read the chosen intent's scalar state, never a paged view. */
  choiceBlockReason(
    choice: CognitionChoice,
    personaId: string,
    availability: CognitionRuntimeAvailability,
  ): string | undefined {
    const intent = choice.intentId
      ? (this.database
          .prepare(
            "SELECT id, status, basis, owner FROM cognition_intents WHERE id = ? AND persona_id = ?",
          )
          .get(choice.intentId, personaId) as
          | Pick<CognitionIntent, "id" | "status" | "basis" | "owner">
          | undefined)
      : undefined;
    return choiceBlockReason(
      choice,
      { intents: intent ? [intent] : [] },
      availability,
    );
  }

  actionFreshness(
    attempt: CognitionDecisionAttempt,
    now: string,
  ): CognitionActionFreshness {
    return actionFreshness(
      this.database,
      attempt,
      this.getAttention(attempt.personaId, now),
      (item) => this.opportunityIsCurrent(item, now),
    );
  }

  private dependenciesAreCurrent(attempt: CognitionDecisionAttempt): boolean {
    for (const [table, dependencies] of [
      ["cognition_situations", attempt.dependencies.situations],
      ["cognition_intents", attempt.dependencies.intents],
    ] as const) {
      for (const dependency of dependencies) {
        const current = this.database
          .prepare(
            `SELECT revision FROM ${table} WHERE id = ? AND persona_id = ?`,
          )
          .get(dependency.id, attempt.personaId) as
          { revision: number } | undefined;
        if (current?.revision !== dependency.revision) return false;
      }
    }
    return true;
  }

  /** Exact original references across all Personas; no snapshot bypass. */
  protectedCanonicalSources(
    candidates: readonly CognitionSourceRetentionCandidate[],
  ): CognitionSourceRetention[] {
    return retainedSourceUses(this.database, candidates);
  }

  /** Activity may release its text once Memory owns a complete canonical copy.
   * Current visual pixels remain Activity-owned and independently protected. */
  protectedActivitySourceIds(
    eventIds: readonly string[],
    snapshottedSourceIds: ReadonlySet<string> = new Set(),
  ): ReadonlySet<string> {
    if (!eventIds.length) return new Set();
    const retained = this.protectedCanonicalSources(
      [...new Set(eventIds)].map((id) => ({
        candidateId: id,
        references: [{ kind: "activity", id }],
      })),
    );
    const protectedIds = new Set(
      retained
        .filter(
          (item) =>
            !snapshottedSourceIds.has(item.candidateId) ||
            item.reasons.some(
              (reason) =>
                reason === "unanalysed" ||
                reason === "decision" ||
                reason === "handoff",
            ),
        )
        .map((item) => item.candidateId),
    );
    const visuals = this.database
      .prepare(
        `SELECT DISTINCT e.source_id FROM cognition_evidence e
      JOIN cognition_state state ON state.persona_id=e.persona_id
      WHERE e.source_kind='activity' AND e.source_id IN (SELECT value FROM json_each(?))
        AND json_extract(e.payload_json,'$.visual') IS NOT NULL
        AND json_extract(e.payload_json,'$.object.key')=json_extract(state.payload_json,'$.foregroundObject.key')
        AND e.id=(SELECT latest.id FROM cognition_evidence latest WHERE latest.persona_id=e.persona_id
          AND latest.kind='observation' AND json_extract(latest.payload_json,'$.visual') IS NOT NULL
          AND json_extract(latest.payload_json,'$.object.key')=json_extract(e.payload_json,'$.object.key')
          ORDER BY latest.observed_at DESC,latest.receipt_sequence DESC LIMIT 1)`,
      )
      .all(JSON.stringify([...new Set(eventIds)])) as { source_id: string }[];
    for (const row of visuals) protectedIds.add(row.source_id);
    return protectedIds;
  }

  /** Only selected live visual dependencies. Historical images do not bind the current surface. */
  *actionVisualEvidence(
    attempt: CognitionDecisionAttempt,
  ): Iterable<CognitionEvidence> {
    for (const { evidenceId } of attempt.actionReadSet?.currentObjects ?? []) {
      const evidence = readEvidenceMetadata(this.database, evidenceId);
      if (evidence?.personaId === attempt.personaId && evidence.visual)
        yield evidence;
    }
  }

  *choiceOpportunityEvidence(
    choice: CognitionChoice,
    personaId: string,
  ): Iterable<CognitionEvidence> {
    const rows = this.database
      .prepare(
        `SELECT e.id FROM cognition_evidence e WHERE e.persona_id = ?
      AND e.source_kind = 'memory' AND json_extract(e.payload_json,'$.opportunity.status') = 'due'
      AND (e.id IN (SELECT value FROM json_each(?)) OR e.id IN
        (SELECT value FROM cognition_intents i,json_each(i.payload_json,'$.evidenceIds') WHERE i.id = ? AND i.persona_id = e.persona_id)
        OR e.id IN (SELECT used.value FROM cognition_situations s,json_each(s.payload_json,'$.episodes') ep,json_each(ep.value,'$.evidenceIds') used
          WHERE s.id = COALESCE(?, (SELECT situation_id FROM cognition_intents WHERE id = ? AND persona_id = e.persona_id)) AND s.persona_id = e.persona_id))
      ORDER BY e.receipt_sequence`,
      )
      .all(
        personaId,
        JSON.stringify(choice.evidenceIds),
        choice.intentId ?? "",
        choice.situationId ?? null,
        choice.intentId ?? "",
      ) as { id: string }[];
    for (const row of rows) yield readEvidenceMetadata(this.database, row.id)!;
  }

  opportunityIsCurrent(item: CognitionEvidence, now: string): boolean {
    const cue = item.opportunity;
    if (
      !cue ||
      cue.status !== "due" ||
      cue.evaluateAt > now ||
      cue.occursAt <= now
    )
      return false;
    return !this.database
      .prepare(
        `SELECT 1 FROM cognition_evidence WHERE persona_id = ? AND receipt_sequence > ?
      AND source_kind = 'memory' AND json_extract(payload_json,'$.opportunity') IS NOT NULL
      AND (json_extract(payload_json,'$.opportunity.id') = ? OR (source_id = ? AND source_revision != ?)) LIMIT 1`,
      )
      .get(
        item.personaId,
        item.receiptSequence,
        cue.id,
        item.source.id,
        item.source.revision ?? "",
      );
  }

  getAttempt(id: string): CognitionDecisionAttempt | undefined {
    const row = this.database
      .prepare(
        "SELECT payload_json FROM cognition_decision_attempts WHERE id = ?",
      )
      .get(id) as JsonRow | undefined;
    return row
      ? parseSchema(
          CognitionDecisionAttemptSchema,
          JSON.parse(row.payload_json),
        )
      : undefined;
  }

  /** Actual bound character Runs, newest first. The consumer owns when to stop reading. */
  *characterRunIds(personaId: string): Iterable<string> {
    const rows = this.database
      .prepare(
        `SELECT run_id FROM cognition_decision_attempts
      WHERE persona_id = ? AND run_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(payload_json, '$.decision.choices') choice
        WHERE json_extract(choice.value, '$.id') = json_extract(payload_json, '$.decision.selectedChoiceId')
          AND json_extract(choice.value, '$.kind') = 'continue_character')
      ORDER BY updated_at DESC, id DESC`,
      )
      .iterate(personaId) as Iterable<{ run_id: string }>;
    for (const row of rows) yield row.run_id;
  }

  getAttemptByDispatchKey(
    dispatchKey: string,
  ): CognitionDecisionAttempt | undefined {
    const row = this.database
      .prepare(
        "SELECT payload_json FROM cognition_decision_attempts WHERE dispatch_key = ?",
      )
      .get(dispatchKey) as JsonRow | undefined;
    return row
      ? parseSchema(
          CognitionDecisionAttemptSchema,
          JSON.parse(row.payload_json),
        )
      : undefined;
  }

  getAttemptForRun(runId: string): CognitionDecisionAttempt | undefined {
    const row = this.database
      .prepare(
        "SELECT payload_json FROM cognition_decision_attempts WHERE run_id = ?",
      )
      .get(runId) as JsonRow | undefined;
    return row
      ? parseSchema(
          CognitionDecisionAttemptSchema,
          JSON.parse(row.payload_json),
        )
      : undefined;
  }

  hasEvidence(
    personaId: string,
    source: CognitionSourceRef,
    kind: CognitionEvidenceInput["kind"],
  ): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM cognition_evidence WHERE persona_id = ? AND
      source_kind = ? AND source_id = ? AND source_revision = ? AND source_fragment = ? AND kind = ?`,
        )
        .get(
          personaId,
          source.kind,
          source.id,
          source.revision ?? "",
          source.fragment ?? "",
          kind,
        ) !== undefined
    );
  }

  saveAttempt(input: CognitionDecisionAttempt): CognitionDecisionAttempt {
    const value = sanitizeForPersistence(CognitionDecisionAttemptSchema, input);
    // Directory literals are transient model input. Keep the exact source/range
    // receipts and read plan without retaining another copy of released bodies.
    const persisted = structuredClone(value);
    for (const entry of persisted.sourceCoverage?.entries ?? [])
      for (const change of entry.changes) delete change.excerpt;
    this.database
      .prepare(
        `INSERT INTO cognition_decision_attempts
      (id, persona_id, status, trigger, through_sequence, user_generation, dispatch_key, run_id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      status=excluded.status, through_sequence=excluded.through_sequence,
      user_generation=excluded.user_generation, run_id=excluded.run_id,
      payload_json=excluded.payload_json, updated_at=excluded.updated_at`,
      )
      .run(
        value.id,
        value.personaId,
        value.status,
        value.trigger,
        value.throughSequence,
        value.dependencies.userGeneration,
        value.dispatchKey,
        value.runId ?? null,
        JSON.stringify(persisted),
        value.createdAt,
        value.updatedAt,
      );
    return value;
  }

  createAttempt(
    read: Pick<CognitionSnapshotRead, "snapshot" | "receivedThroughSequence">,
    trigger: CognitionDecisionAttempt["trigger"],
    now: string,
    allocation?: CognitionDecisionAttempt["allocation"],
    snapshotAt = now,
    sourceCoverage?: CognitionDecisionAttempt["sourceCoverage"],
  ): CognitionDecisionAttempt {
    const { snapshot, receivedThroughSequence } = read;
    const id = randomUUID();
    return this.saveAttempt({
      id,
      personaId: snapshot.attention.personaId,
      status: "pending",
      trigger,
      throughSequence: snapshot.attention.lastReceiptSequence,
      dependencies: {
        personaId: snapshot.attention.personaId,
        userGeneration: snapshot.attention.userGeneration,
        receivedThroughSequence,
        focusRevision: snapshot.attention.focusRevision,
        situations: snapshot.situations.map(
          ({ id: situationId, revision }) => ({ id: situationId, revision }),
        ),
        intents: snapshot.intents.map(({ id: intentId, revision }) => ({
          id: intentId,
          revision,
        })),
        evidenceIds: snapshot.evidence.map(({ id: evidenceId }) => evidenceId),
      },
      dispatchKey: `cognition:${id}`,
      feedbackEvidenceIds: [],
      ...(allocation ? { allocation } : {}),
      ...(sourceCoverage ? { sourceCoverage } : {}),
      wakeSources: {
        ...(snapshot.attention.nextWakeAt &&
        snapshot.attention.nextWakeAt <= snapshotAt
          ? { attentionWakeAt: snapshot.attention.nextWakeAt }
          : {}),
        intents: snapshot.intents.flatMap((value) =>
          value.nextWakeAt &&
          value.nextWakeAt <= snapshotAt &&
          !["fulfilled", "abandoned"].includes(value.status)
            ? [
                {
                  id: value.id,
                  revision: value.revision,
                  nextWakeAt: value.nextWakeAt,
                },
              ]
            : [],
        ),
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  private dependencySnapshot(
    attempt: CognitionDecisionAttempt,
    now: string,
  ): CognitionSnapshot {
    const situations: CognitionSituation[] = [];
    const intents: CognitionIntent[] = [];
    for (const dependency of attempt.dependencies.situations) {
      const allocation = attempt.allocation?.situations.find(
        (value) => value.id === dependency.id,
      );
      if (!allocation) {
        const value = this.getSituation(dependency.id);
        if (value) situations.push(value);
        continue;
      }
      const row = this.database
        .prepare(
          `SELECT json_remove(payload_json,'$.episodes','$.claims', ${allocation.preservedFields.length ? allocation.preservedFields.map(() => "?").join(",") : "'$.nonexistentProjectionField'"}) AS payload_json FROM cognition_situations WHERE id = ?`,
        )
        .get(
          ...allocation.preservedFields.map((field) => `$.${field}`),
          dependency.id,
        ) as JsonRow;
      const value = {
        title: "[PARTIAL SITUATION: canonical fields preserved]",
        summary: "",
        objectRefs: [],
        unresolved: [],
        relatedSituationIds: [],
        ...JSON.parse(row.payload_json),
        episodes: [],
        claims: [],
      } as CognitionSituation;
      for (const field of ["episodes", "claims"] as const) {
        const ids =
          field === "episodes" ? allocation.episodeIds : allocation.claimIds;
        const rows = this.database
          .prepare(
            `SELECT value FROM cognition_situations s,json_each(s.payload_json, ?) WHERE s.id = ?
          AND json_extract(value,'$.id') IN (SELECT value FROM json_each(?)) ORDER BY CAST(key AS INTEGER)`,
          )
          .all(`$.${field}`, dependency.id, JSON.stringify(ids)) as {
          value: string;
        }[];
        (value[field] as unknown[]) = rows.map(
          (row) => JSON.parse(row.value) as unknown,
        );
      }
      situations.push(parseSchema(CognitionSituationSchema, value));
    }
    for (const dependency of attempt.dependencies.intents) {
      const allocation = attempt.allocation?.intents?.find(
        (value) => value.id === dependency.id,
      );
      if (!allocation) {
        const value = this.getIntent(dependency.id);
        if (value) intents.push(value);
        continue;
      }
      const row = this.database
        .prepare(
          `SELECT json_remove(payload_json,'$.evidenceIds','$.effectEvidenceIds', ${allocation.preservedFields.length ? allocation.preservedFields.map(() => "?").join(",") : "'$.nonexistentProjectionField'"}) AS payload_json FROM cognition_intents WHERE id = ?`,
        )
        .get(
          ...allocation.preservedFields.map((field) => `$.${field}`),
          dependency.id,
        ) as JsonRow;
      intents.push(
        parseSchema(CognitionIntentSchema, {
          goal: "[PARTIAL INTENT: canonical fields preserved]",
          successCriteria: [],
          blockers: [],
          resumeConditions: [],
          progress: "",
          ...JSON.parse(row.payload_json),
          evidenceIds: allocation.evidenceIds,
          effectEvidenceIds: allocation.effectEvidenceIds,
        }),
      );
    }
    const ids = new Set(attempt.dependencies.evidenceIds);
    for (const value of situations) {
      for (const episode of value.episodes)
        episode.evidenceIds.forEach((id) => ids.add(id));
      for (const claim of value.claims)
        [
          ...claim.evidenceIds,
          ...claim.contradictingEvidenceIds,
          ...(claim.historyEvidenceIds ?? []),
        ].forEach((id) => ids.add(id));
    }
    for (const value of intents)
      [...value.evidenceIds, ...value.effectEvidenceIds].forEach((id) =>
        ids.add(id),
      );
    const evidence = [...ids].flatMap((id) => {
      const value = readEvidenceMetadata(this.database, id);
      return value && value.personaId === attempt.personaId ? [value] : [];
    });
    return {
      attention: this.getAttention(attempt.personaId, now),
      situations,
      intents,
      evidence,
      recentAttempts: [],
    };
  }

  private retainedUserIntentGroundings(
    attempt: CognitionDecisionAttempt,
    analysis: CognitionAnalysis,
  ): ReadonlyMap<string, CognitionEvidence> {
    const retained = new Map<string, CognitionEvidence>();
    for (const update of analysis.delta.updateIntents) {
      const allocation = attempt.allocation?.intents?.find(
        (value) => value.id === update.id,
      );
      if (!allocation) continue;
      const supplied = new Set([
        ...attempt.dependencies.evidenceIds,
        ...allocation.evidenceIds,
        ...allocation.effectEvidenceIds,
      ]);
      for (const id of [
        ...update.value.evidenceIds,
        ...update.value.effectEvidenceIds,
      ])
        if (!supplied.has(id))
          throw new CognitionConflictError(
            "Cannot add evidence omitted from the partial intent input",
          );
      if (
        update.value.owner !== "user" ||
        update.value.basis !== "explicit_user"
      )
        continue;
      // Read one actual source retained by this same canonical revision. Do not
      // expose omitted references to the model or expand its citation namespace.
      const row = this.database
        .prepare(
          `SELECT e.id FROM cognition_intents i,
          json_each(i.payload_json, '$.evidenceIds') r
          JOIN cognition_evidence e ON e.id = r.value
          WHERE i.id = ? AND i.persona_id = ? AND i.revision = ?
          AND i.owner = 'user' AND i.basis = 'explicit_user'
          AND e.persona_id = i.persona_id AND e.actor = 'user' AND e.kind = 'utterance'
          AND julianday(e.received_at) <= julianday(?) LIMIT 1`,
        )
        .get(
          update.id,
          attempt.personaId,
          update.expectedRevision,
          attempt.createdAt,
        ) as { id: string } | undefined;
      const evidence = row && readEvidenceMetadata(this.database, row.id);
      if (evidence) retained.set(update.id, evidence);
    }
    return retained;
  }

  private preservePartialUpdates(
    attempt: CognitionDecisionAttempt,
    analysis: CognitionAnalysis,
    snapshot: CognitionSnapshot,
  ): void {
    for (const update of analysis.delta.updateSituations) {
      const allocation = attempt.allocation?.situations.find(
        (value) => value.id === update.id,
      );
      if (!allocation) continue;
      const previous = snapshot.situations.find(
        (value) => value.id === update.id,
      )!;
      for (const field of allocation.preservedFields) {
        const value = (previous as unknown as Record<string, unknown>)[field];
        if (value === undefined)
          delete (update.value as unknown as Record<string, unknown>)[field];
        else
          (update.value as unknown as Record<string, unknown>)[field] = value;
      }
      for (const field of ["episodes", "claims"] as const) {
        const visible =
          field === "episodes" ? allocation.episodeIds : allocation.claimIds;
        for (const child of update.value[field]) {
          const exists = this.database
            .prepare(
              `SELECT 1 FROM cognition_situations s,json_each(s.payload_json, ?) WHERE s.id = ? AND json_extract(value,'$.id') = ? LIMIT 1`,
            )
            .get(`$.${field}`, update.id, child.id);
          if (exists && !visible.includes(child.id))
            throw new CognitionConflictError(
              "Cannot update an unseen situation child",
            );
        }
        const merged = new Map(
          previous[field].map((value) => [value.id, value]),
        );
        for (const child of update.value[field]) merged.set(child.id, child);
        (update.value[field] as unknown[]) = [...merged.values()];
      }
    }
    for (const update of analysis.delta.updateIntents) {
      const allocation = attempt.allocation?.intents?.find(
        (value) => value.id === update.id,
      );
      if (!allocation) continue;
      const previous = snapshot.intents.find(
        (value) => value.id === update.id,
      )!;
      for (const field of allocation.preservedFields.filter(
        (field) =>
          field !== "completion" ||
          (update.completionOperation ?? "keep") === "keep",
      ))
        (update.value as unknown as Record<string, unknown>)[field] = (
          previous as unknown as Record<string, unknown>
        )[field];
      for (const field of ["evidenceIds", "effectEvidenceIds"] as const)
        update.value[field] = [
          ...new Set([...previous[field], ...update.value[field]]),
        ];
    }
  }

  private savePartialEntity(
    table: "cognition_situations" | "cognition_intents",
    value: CognitionSituation | CognitionIntent,
    preservedFields: string[],
    arrayFields: string[],
  ): void {
    const entries = Object.entries(value).filter(
      ([key]) => !preservedFields.includes(key) && !arrayFields.includes(key),
    );
    const paths = entries.flatMap(([key, content]) => [
      `$.${key}`,
      JSON.stringify(content),
    ]);
    const assignment = entries.map(() => "?,json(?)").join(",");
    const isSituation = table === "cognition_situations";
    const schema = isSituation
      ? CognitionSituationSchema
      : CognitionIntentSchema;
    const required = new Set<string>(schema.required);
    const present = new Set(Object.keys(value));
    const removed = Object.keys(schema.properties).filter(
      (field) =>
        !required.has(field) &&
        !present.has(field) &&
        !preservedFields.includes(field),
    );
    // The expanded value is complete for visible fields. Omission clears an
    // optional field; allocation-protected fields and unseen children survive.
    const previousJson = removed.length
      ? `json_remove(payload_json, ${removed.map(() => "?").join(",")})`
      : "payload_json";
    this.database
      .prepare(
        `UPDATE ${table} SET revision = ?, status = ?, updated_at = ?,
      payload_json = json_set(${previousJson}, ${assignment}) WHERE id = ?`,
      )
      .run(
        value.revision,
        value.status,
        value.updatedAt,
        ...removed.map((field) => `$.${field}`),
        ...paths,
        value.id,
      );
    for (const field of arrayFields) {
      const values = (value as unknown as Record<string, unknown[]>)[field]!;
      for (const child of values) {
        const identity =
          typeof child === "string" ? child : (child as { id: string }).id;
        const row = this.database
          .prepare(
            `SELECT CAST(key AS INTEGER) AS position FROM ${table} e,json_each(e.payload_json, ?) WHERE e.id = ? AND ${isSituation ? "json_extract(json_each.value,'$.id')" : "json_each.value"} = ? LIMIT 1`,
          )
          .get(`$.${field}`, value.id, identity) as
          { position: number } | undefined;
        this.database
          .prepare(
            `UPDATE ${table} SET payload_json = json_set(payload_json, ?, json(?)) WHERE id = ?`,
          )
          .run(
            `$.${field}[${row?.position ?? "#"}]`,
            JSON.stringify(child),
            value.id,
          );
        if (isSituation && field === "episodes") {
          const episode = child as CognitionSituation["episodes"][number];
          this.replaceEpisodeSources(value.id, episode.id, episode.evidenceIds);
        }
        if (isSituation && field === "claims")
          this.replaceClaimSources(value.id, child as CognitionClaim);
      }
    }
    if (isSituation)
      this.database
        .prepare(
          "UPDATE cognition_situations SET superseded_by = json_extract(payload_json,'$.supersededBy') WHERE id = ?",
        )
        .run(value.id);
    else
      this.database
        .prepare(
          "UPDATE cognition_intents SET situation_id = json_extract(payload_json,'$.situationId'),owner = json_extract(payload_json,'$.owner'),basis = json_extract(payload_json,'$.basis'),next_wake_at = json_extract(payload_json,'$.nextWakeAt') WHERE id = ?",
        )
        .run(value.id);
  }

  commitAnalysis(
    attemptId: string,
    input: CognitionAnalysis,
    now: string,
    actualSuppliedEvidence?: readonly CognitionEvidence[],
  ): CognitionDecisionAttempt {
    const analysis = sanitizeForPersistence(CognitionAnalysisSchema, input);
    const handoffs: CognitionMemoryHandoffInput[] = [];
    const committed = this.database.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt || attempt.status !== "analyzing")
        throw new CognitionConflictError("Attempt is no longer analyzing");
      if (analysis.sourceReadPlan)
        validateSourceReadPlan(attempt.sourceCoverage, analysis.sourceReadPlan);
      const completionPending = Boolean(
        analysis.sourceReadPlan || analysis.recallPlan,
      );
      const sourceCoverage = attempt.sourceCoverage
        ? {
            ...attempt.sourceCoverage,
            completionPending,
            ...(analysis.sourceReadPlan
              ? { readPlan: analysis.sourceReadPlan }
              : {}),
          }
        : undefined;
      const snapshot = this.dependencySnapshot(attempt, now);
      if (
        snapshot.attention.userGeneration !==
        attempt.dependencies.userGeneration
      ) {
        throw new CognitionConflictError(
          "User control changed during analysis",
        );
      }
      if (!this.dependenciesAreCurrent(attempt))
        throw new CognitionConflictError(
          "Situation or intent changed during analysis",
        );
      const suppliedSituations = new Set(
        attempt.dependencies.situations.map(({ id }) => id),
      );
      const suppliedIntents = new Set(
        attempt.dependencies.intents.map(({ id }) => id),
      );
      for (const update of analysis.delta.updateSituations)
        if (!suppliedSituations.has(update.id))
          throw new CognitionConflictError(
            "Cannot update a situation omitted from the analysis allocation",
          );
      for (const update of analysis.delta.updateIntents)
        if (!suppliedIntents.has(update.id))
          throw new CognitionConflictError(
            "Cannot update an intent omitted from the analysis allocation",
          );
      for (const choice of analysis.decision.choices) {
        if (
          choice.situationId &&
          !choice.situationId.startsWith("new:") &&
          !suppliedSituations.has(choice.situationId)
        )
          throw new CognitionConflictError(
            "Cannot choose an omitted situation",
          );
        if (
          choice.intentId &&
          !choice.intentId.startsWith("new:") &&
          !suppliedIntents.has(choice.intentId)
        )
          throw new CognitionConflictError("Cannot choose an omitted intent");
      }
      const suppliedEvidence = new Set(attempt.dependencies.evidenceIds);
      for (const use of analysis.decision.selectedBasis.evidenceUses)
        if (!suppliedEvidence.has(use.evidenceId))
          throw new CognitionConflictError(
            "Cannot choose evidence omitted from the analysis input",
          );
      const requested = analysis.decision.selectedBasis.requestedContinuation;
      if (requested) {
        const supplied = actualSuppliedEvidence?.find(
          ({ id }) => id === requested.requestEvidenceId,
        );
        if (
          !supplied?.text ||
          !this.requestedContinuationTextMatches(
            requested.requestEvidenceId,
            supplied.text,
          )
        )
          throw new CognitionConflictError(
            "Requested continuation requires its complete request text in the actual analysis input",
          );
      }
      const retainedGroundings = this.retainedUserIntentGroundings(
        attempt,
        analysis,
      );
      this.preservePartialUpdates(attempt, analysis, snapshot);
      // Historical provenance belongs to the host. Removed support is neither
      // current support nor automatically a contradiction, but must survive restart.
      for (const created of analysis.delta.createSituations)
        for (const claim of created.value.claims)
          delete claim.historyEvidenceIds;
      for (const update of analysis.delta.updateSituations) {
        const before = snapshot.situations.find(
          (value) => value.id === update.id,
        );
        for (const claim of update.value.claims) {
          const old = before?.claims.find((value) => value.id === claim.id);
          delete claim.historyEvidenceIds;
          if (!old) continue;
          const current = new Set([
            ...claim.evidenceIds,
            ...claim.contradictingEvidenceIds,
          ]);
          const history = [
            ...new Set([
              ...(old.historyEvidenceIds ?? []),
              ...(old.basis !== "inferred" ||
              claim.basis !== "inferred" ||
              old.historyEvidenceIds?.length
                ? [...old.evidenceIds, ...old.contradictingEvidenceIds].filter(
                    (id) => !current.has(id),
                  )
                : []),
            ]),
          ].sort();
          if (history.length) claim.historyEvidenceIds = history;
        }
      }
      const resolved = resolveCognitionAnalysis(
        snapshot,
        analysis,
        now,
        undefined,
        retainedGroundings,
        attempt,
        actualSuppliedEvidence ?? [],
      );
      for (const situation of resolved.situations) {
        const previous = snapshot.situations.find(
          ({ id }) => id === situation.id,
        );
        for (const claim of situation.claims) {
          const old = previous?.claims.find(({ id }) => id === claim.id);
          if (old && sameClaimMaterial(old, claim)) continue;
          // An inference is not a new user fact. Its transition may still retire
          // a previously grounded claim, so that actual correction reaches Memory.
          if (claim.basis === "inferred" && (!old || old.basis === "inferred"))
            continue;
          handoffs.push({
            personaId: attempt.personaId,
            situationId: situation.id,
            committedAt: now,
            primaryEvidenceIds: [
              ...new Set([
                ...claim.evidenceIds,
                ...claim.contradictingEvidenceIds,
              ]),
            ],
            historyEvidenceIds: claim.historyEvidenceIds ?? [],
          });
        }
        for (const episode of situation.episodes.filter(
          ({ state }) => state === "closed",
        )) {
          const old = previous?.episodes.find(({ id }) => id === episode.id);
          if (
            old?.state === "closed" &&
            JSON.stringify([...old.evidenceIds].sort()) ===
              JSON.stringify([...episode.evidenceIds].sort())
          )
            continue;
          handoffs.push({
            personaId: attempt.personaId,
            situationId: situation.id,
            committedAt: now,
            primaryEvidenceIds: episode.evidenceIds,
            historyEvidenceIds: [],
          });
        }
      }
      for (const value of resolved.situations) {
        const allocation = attempt.allocation?.situations.find(
          (item) => item.id === value.id,
        );
        if (allocation)
          this.savePartialEntity(
            "cognition_situations",
            value,
            allocation.preservedFields,
            ["episodes", "claims"],
          );
        else this.saveSituation(value);
      }
      for (const value of resolved.intents) {
        const allocation = attempt.allocation?.intents?.find(
          (item) => item.id === value.id,
        );
        if (allocation)
          this.savePartialEntity(
            "cognition_intents",
            value,
            allocation.preservedFields.filter(
              (field) =>
                field !== "completion" ||
                (analysis.delta.updateIntents.find(({ id }) => id === value.id)
                  ?.completionOperation ?? "keep") === "keep",
            ),
            ["evidenceIds", "effectEvidenceIds"],
          );
        else this.saveIntent(value);
      }
      if (!completionPending) this.consumeAttemptWakes(attempt, now);
      // Freeze actual Episode membership only after all final partial/full writes.
      // State and pending handoff either commit together or both roll back.
      for (const handoff of handoffs) {
        const primaryEvidenceIds = handoff.primaryEvidenceIds.filter(
          (id) =>
            readEvidenceMetadata(this.database, id)?.kind !== "recollection",
        );
        if (primaryEvidenceIds.length)
          enqueueMemoryHandoff(this.database, {
            ...handoff,
            primaryEvidenceIds,
          });
      }
      const state = {
        ...snapshot.attention,
        revision: snapshot.attention.revision + 1,
        analyzedThroughSequence: Math.max(
          snapshot.attention.analyzedThroughSequence,
          completionPending
            ? snapshot.attention.analyzedThroughSequence
            : attempt.throughSequence,
        ),
        ...(sourceCoverage && !completionPending
          ? {
              catalogueReviewedThroughSequence: Math.max(
                snapshot.attention.catalogueReviewedThroughSequence ??
                  snapshot.attention.analyzedThroughSequence,
                sourceCoverage.throughSequence,
              ),
            }
          : {}),
        updatedAt: now,
      };
      if (
        snapshot.attention.focusRevision === attempt.dependencies.focusRevision
      ) {
        if (analysis.delta.attention.currentSituationId === null)
          delete state.currentSituationId;
        else if (resolved.currentSituationId)
          state.currentSituationId = resolved.currentSituationId;
        if (analysis.delta.attention.committedIntentId === null)
          delete state.committedIntentId;
        else if (resolved.committedIntentId)
          state.committedIntentId = resolved.committedIntentId;
      }
      if (
        !completionPending &&
        attempt.wakeSources?.attentionWakeAt === state.nextWakeAt &&
        !this.hasUnanalyzedMeaning(
          attempt.personaId,
          Math.max(
            attempt.throughSequence,
            sourceCoverage?.throughSequence ?? 0,
          ),
        )
      )
        delete state.nextWakeAt;
      this.saveAttention(state);
      const situationIds = new Set([
        ...suppliedSituations,
        ...resolved.situations.map(({ id }) => id),
      ]);
      const intentIds = new Set([
        ...suppliedIntents,
        ...resolved.intents.map(({ id }) => id),
      ]);
      return this.saveAttempt({
        ...attempt,
        status: completionPending ? "awaiting_recall" : "ready",
        ...(sourceCoverage ? { sourceCoverage } : {}),
        dependencies: {
          ...attempt.dependencies,
          situations: [...situationIds].flatMap((id) => {
            const row = this.database
              .prepare("SELECT revision FROM cognition_situations WHERE id = ?")
              .get(id) as { revision: number } | undefined;
            return row ? [{ id, revision: row.revision }] : [];
          }),
          intents: [...intentIds].flatMap((id) => {
            const row = this.database
              .prepare("SELECT revision FROM cognition_intents WHERE id = ?")
              .get(id) as { revision: number } | undefined;
            return row ? [{ id, revision: row.revision }] : [];
          }),
        },
        decision: resolved.decision,
        actionReadSet: compileActionReadSet(
          this.database,
          attempt,
          resolved.decision,
          this.choiceOpportunityEvidence(
            resolved.decision.choices.find(
              ({ id }) => id === resolved.decision.selectedChoiceId,
            )!,
            attempt.personaId,
          ),
        ),
        ...(resolved.recallPlan ? { recallPlan: resolved.recallPlan } : {}),
        updatedAt: now,
      });
    })();
    return committed;
  }

  actionMaterialSources(
    personaId: string,
    evidenceIds: readonly string[],
  ): NonNullable<CognitionAnalysisInput["executionMaterial"]> {
    const statement = this.database.prepare(
      `SELECT length(CAST(payload_json AS BLOB)) AS fullPayloadBytes,
        json_extract(payload_json,'$.kind') AS kind,
        json_extract(payload_json,'$.bodyReleasedAt') AS bodyReleasedAt
       FROM cognition_evidence WHERE persona_id = ? AND id = ?`,
    );
    return {
      sources: [...new Set(evidenceIds)].map((evidenceId) => {
        // Only metadata leaves SQLite: no unbounded source load for the planner.
        const row = statement.get(personaId, evidenceId) as
          | {
              fullPayloadBytes: number;
              kind: string;
              bodyReleasedAt: string | null;
            }
          | undefined;
        return {
          evidenceId,
          ...(row && !row.bodyReleasedAt && row.kind !== "recollection"
            ? { fullPayloadBytes: row.fullPayloadBytes }
            : {}),
          resolution: !row
            ? "unavailable"
            : row.kind === "recollection"
              ? "memory_domain"
              : row.bodyReleasedAt
                ? "unavailable"
                : "evidence",
        };
      }),
    };
  }

  readActionContext(
    attempt: CognitionDecisionAttempt,
    maxReadBytes: number,
    complete: (
      context: CognitionPreparedContext,
      remainingReadBytes: number,
    ) => CognitionPreparedContext,
  ): CognitionPreparedContext {
    return this.database.transaction(() => {
      const material = readSelectedActionMaterial(
        this.database,
        attempt,
        maxReadBytes,
      );
      return complete(
        material.context,
        maxReadBytes - material.readCost.rawValueBytes,
      );
    })();
  }

  actionRecollectionRequest(
    attempt: CognitionDecisionAttempt,
  ): MemoryEvidenceReferenceRequest {
    const references: MemoryEvidenceReference[] = [];
    const expectedHistory: NonNullable<
      MemoryEvidenceReferenceRequest["expectedHistory"]
    >[number][] = [];
    for (const { evidenceId, requireCurrent } of attempt.actionReadSet
      ?.recollections ?? []) {
      // Evidence receipts are immutable. Retiring text preserves this exact read-time metadata.
      const item = readEvidenceMetadata(this.database, evidenceId);
      if (
        !item ||
        item.personaId !== attempt.personaId ||
        item.kind !== "recollection" ||
        !item.recollection ||
        item.source.kind !== "memory" ||
        !item.source.revision
      )
        throw new CognitionConflictError(
          "Selected recollection source is unavailable",
        );
      const identity = {
        memoryId: item.source.id,
        revisionId: item.source.revision,
      };
      references.push({
        ...identity,
        use: requireCurrent ? "current" : "history",
      });
      expectedHistory.push({
        ...identity,
        historyStatus: item.recollection.historyStatus,
        ...(item.recollection.historyStatusRevisionId
          ? {
              historyStatusRevisionId:
                item.recollection.historyStatusRevisionId,
            }
          : {}),
      });
    }
    return {
      personaId: attempt.personaId,
      references,
      expectedHistory,
      ...(attempt.recallPlan ? { retrieval: attempt.recallPlan } : {}),
    };
  }

  pendingMemoryHandoffs(): Iterable<CognitionMemoryHandoff> {
    return pendingMemoryHandoffs(this.database);
  }

  memoryHandoffEvidence(
    handoff: CognitionMemoryHandoff,
    evidenceIds: readonly string[],
  ): Iterable<CognitionEvidence> {
    return memoryHandoffEvidence(this.database, handoff, evidenceIds);
  }

  memoryHandoffContext(
    handoff: CognitionMemoryHandoff,
    acceptedPrimaryEvidenceIds: readonly string[],
  ): Iterable<CognitionEvidence> {
    return memoryHandoffContext(
      this.database,
      handoff,
      acceptedPrimaryEvidenceIds,
    );
  }

  acknowledgeMemoryHandoff(id: string): boolean {
    return acknowledgeMemoryHandoff(this.database, id);
  }

  /** One-hop original sources that disambiguate anchors; never later receipts. */
  *formationContext(
    personaId: string,
    anchorEvidenceIds: readonly string[],
  ): Iterable<CognitionEvidence> {
    if (anchorEvidenceIds.length === 0) return;
    const anchors = JSON.stringify([...new Set(anchorEvidenceIds)]);
    // Each step revisits only the indexed one-hop source range. No JSON history
    // scan or live SQLite cursor survives yield: the consumer may enqueue work.
    const next = this.database.prepare(`
      WITH anchors AS MATERIALIZED (
        SELECT e.id,e.receipt_sequence FROM json_each(?) supplied
        CROSS JOIN cognition_evidence e ON e.id = supplied.value
        WHERE e.persona_id = ?
      ), episodes AS MATERIALIZED (
        SELECT DISTINCT a.situation_id,a.episode_id FROM anchors
        CROSS JOIN cognition_episode_evidence a ON a.evidence_id = anchors.id
        CROSS JOIN cognition_situations s ON s.id = a.situation_id
        WHERE s.persona_id = ?
      ), sources AS MATERIALIZED (
        SELECT DISTINCT e.id,e.receipt_sequence FROM episodes
        CROSS JOIN cognition_episode_evidence r
          ON r.situation_id = episodes.situation_id AND r.episode_id = episodes.episode_id
        CROSS JOIN cognition_evidence e ON e.id = r.evidence_id
        WHERE e.persona_id = ? AND e.receipt_sequence > ?
          AND e.receipt_sequence <= (SELECT MAX(receipt_sequence) FROM anchors)
          AND e.id NOT IN (SELECT id FROM anchors)
      ) SELECT e.receipt_sequence,e.payload_json FROM (
        SELECT id,receipt_sequence FROM sources ORDER BY receipt_sequence LIMIT 1
      ) selected CROSS JOIN cognition_evidence e ON e.id = selected.id`);
    let through = 0;
    for (;;) {
      const row = next.get(
        anchors,
        personaId,
        personaId,
        personaId,
        through,
      ) as (JsonRow & { receipt_sequence: number }) | undefined;
      if (!row) return;
      through = row.receipt_sequence;
      yield parseSchema(CognitionEvidenceSchema, JSON.parse(row.payload_json));
    }
  }

  requestedContinuationRequest(id: string): CognitionEvidence | undefined {
    return readEvidenceMetadata(this.database, id);
  }

  requestedContinuationTextMatches(id: string, actualText: string): boolean {
    return (
      actualText.length > 0 &&
      this.database
        .prepare(
          "SELECT 1 FROM cognition_evidence WHERE id = ? AND json_extract(payload_json, '$.text') = ?",
        )
        .get(id, actualText) !== undefined
    );
  }

  /** A request receipt owns at most one generated contribution, across Intent IDs. */
  requestedContinuationBinding(
    personaId: string,
    requestEvidenceId: string,
    exceptAttemptId: string,
  ): CognitionDecisionAttempt | undefined {
    const request = readEvidenceMetadata(this.database, requestEvidenceId);
    if (!request || request.personaId !== personaId) return undefined;
    const row = this.database
      .prepare(
        `
      SELECT a.payload_json FROM cognition_decision_attempts AS a
      JOIN cognition_evidence AS e ON e.id = json_extract(
        a.payload_json, '$.decision.selectedBasis.requestedContinuation.requestEvidenceId')
      WHERE a.persona_id = ? AND a.id != ? AND a.run_id IS NOT NULL
        AND e.source_kind = ? AND e.source_id = ? AND e.source_fragment = ?
        AND coalesce(json_extract(a.payload_json, '$.outcome'), '') NOT IN ('failed', 'interrupted')
      ORDER BY a.creation_sequence LIMIT 1
    `,
      )
      .get(
        personaId,
        exceptAttemptId,
        request.source.kind,
        request.source.id,
        request.source.fragment ?? "",
      ) as { payload_json: string } | undefined;
    return row
      ? parseSchema(
          CognitionDecisionAttemptSchema,
          JSON.parse(row.payload_json),
        )
      : undefined;
  }

  /** Called by the Run allocator inside its existing SQLite transaction. */
  bindDispatched(
    dispatchKey: string,
    runId: string,
    now: string,
  ): CognitionDecisionAttempt {
    if (!this.database.inTransaction)
      throw new CognitionConflictError(
        "Dispatch binding requires the Run allocation transaction",
      );
    const attempt = this.getAttemptByDispatchKey(dispatchKey);
    if (!attempt) throw new CognitionConflictError("Unknown dispatch key");
    if (attempt.runId) {
      if (attempt.runId !== runId)
        throw new CognitionConflictError(
          "Dispatch key is already bound to another Run",
        );
      return attempt;
    }
    if (attempt.status !== "ready")
      throw new CognitionConflictError(
        "Attempt is no longer ready to dispatch",
      );
    if (!this.actionFreshness(attempt, now).current) {
      throw new CognitionConflictError(
        "Dispatch dependencies changed before Run allocation",
      );
    }
    const requested = attempt.decision?.selectedBasis.requestedContinuation;
    if (
      requested &&
      this.requestedContinuationBinding(
        attempt.personaId,
        requested.requestEvidenceId,
        attempt.id,
      )
    )
      throw new CognitionConflictError(
        "Requested contribution is already bound to its Run",
      );
    return this.saveAttempt({
      ...attempt,
      status: "dispatched",
      runId,
      updatedAt: now,
    });
  }

  /** Same transaction as the original Run's input resolution/checkpoint. */
  bindContextContinuation(
    dispatchKey: string,
    runId: string,
    itemId: string,
    now: string,
  ): CognitionDecisionAttempt {
    if (!this.database.inTransaction)
      throw new CognitionConflictError(
        "Context acceptance requires its input resolution transaction",
      );
    const attempt = this.getAttemptByDispatchKey(dispatchKey);
    if (!attempt) throw new CognitionConflictError("Unknown dispatch key");
    if (attempt.contextContinuation) {
      if (
        attempt.contextContinuation.runId !== runId ||
        attempt.contextContinuation.itemId !== itemId
      )
        throw new CognitionConflictError(
          "Context acceptance is already bound to another input",
        );
      return attempt;
    }
    const waiting = attempt.decision?.selectedBasis.waitingInputContinuation;
    if (
      attempt.runId ||
      attempt.status !== "ready" ||
      waiting?.runId !== runId ||
      waiting.itemId !== itemId
    )
      throw new CognitionConflictError(
        "Attempt is no longer ready for this waiting input",
      );
    if (!this.actionFreshness(attempt, now).current)
      throw new CognitionConflictError(
        "Context dependencies changed before acceptance",
      );
    return this.saveAttempt({
      ...attempt,
      status: "settled",
      outcome: "context_supplied",
      contextContinuation: { runId, itemId, acceptedAt: now },
      updatedAt: now,
    });
  }

  listPersonaIds(): string[] {
    return (
      this.database
        .prepare("SELECT persona_id FROM cognition_state ORDER BY persona_id")
        .all() as { persona_id: string }[]
    ).map(({ persona_id }) => persona_id);
  }
}

function sameClaimMaterial(
  left: CognitionClaim,
  right: CognitionClaim,
): boolean {
  const material = (claim: CognitionClaim) => ({
    ...claim,
    evidenceIds: [...claim.evidenceIds].sort(),
    contradictingEvidenceIds: [...claim.contradictingEvidenceIds].sort(),
    ...(claim.historyEvidenceIds
      ? { historyEvidenceIds: [...claim.historyEvidenceIds].sort() }
      : {}),
  });
  return JSON.stringify(material(left)) === JSON.stringify(material(right));
}
