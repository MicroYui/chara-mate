import type Database from "better-sqlite3";
import {
  readSourceCatalogue,
  recordSourceSupply,
} from "./cognitionSourceCatalogue";
import type { CognitionSourceCoverage } from "../../shared/contracts/cognition";
import {
  readPassiveSpan,
  readLatestPassiveSpan,
} from "./cognitionPassiveSpans";
import {
  CognitionDecisionAttemptSchema,
  CognitionAttemptLifecycleSchema,
  CognitionEvidenceSchema,
  CognitionIntentSchema,
  CognitionSituationSchema,
} from "../../shared/schemas/cognition";
import { parseSchema } from "../../shared/schemas/validation";
import type {
  CognitionAnalysisCoverage,
  CognitionConversationRead,
  CognitionAttentionState,
  CognitionDecisionAttempt,
  CognitionEvidence,
  CognitionIntent,
  CognitionSituation,
  CognitionSnapshot,
  CognitionStateReferences,
} from "./cognitionTypes";
import {
  CognitionConflictError,
  latestSelectedContextIntent,
} from "./cognitionProjection";

export const INCOMPLETE_RECEIPT =
  "[INCOMPLETE EXCERPT: original persisted source remains available; omitted content cannot support a claim.]";
const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
type JsonRow = { payload_json: string };
type SourceTextRange = NonNullable<
  CognitionSourceCoverage["supplied"][number]["textRange"]
>;
type Allocation = NonNullable<CognitionDecisionAttempt["allocation"]>;
type SituationAllocation = Allocation["situations"][number];
type ReferencedChildren = NonNullable<
  CognitionStateReferences["situationChildren"]
>[number];
type ReferenceGap = { missing: boolean; omittedForBudget: boolean };
type IntentAllocation = NonNullable<Allocation["intents"]>[number];
const situationFields = [
  "title",
  "summary",
  "objectRefs",
  "unresolved",
  "relatedSituationIds",
  "journeyId",
  "togetherSessionId",
  "supersededBy",
] as const;
const intentFields = [
  "goal",
  "successCriteria",
  "blockers",
  "resumeConditions",
  "progress",
  "completion",
] as const;

/** Read one source without first moving an oversized payload across the SQLite/JS boundary. */
export function readEvidence(
  database: Database.Database,
  id: string,
  maxBytes: number,
  startCharacter = 0,
  recordRaw?: (raw: string) => void,
):
  | {
      evidence: CognitionEvidence;
      excerpted: boolean;
      textRange?: SourceTextRange;
    }
  | undefined {
  if (!Number.isSafeInteger(startCharacter) || startCharacter < 0)
    throw new CognitionConflictError(
      "Source text position must be a nonnegative Unicode character offset",
    );
  const row = database
    .prepare(
      `SELECT length(CAST(payload_json AS BLOB)) AS size,
    length(COALESCE(json_extract(payload_json,'$.text'),'')) AS text_characters,
    json_type(payload_json,'$.text') IS NOT NULL AS has_text,
    CASE WHEN ?=0 AND length(CAST(payload_json AS BLOB))<=? THEN payload_json ELSE NULL END AS payload_json
    FROM cognition_evidence WHERE id=? AND json_extract(payload_json,'$.bodyReleasedAt') IS NULL`,
    )
    .get(startCharacter, maxBytes, id) as
    | {
        size: number;
        text_characters: number;
        has_text: number;
        payload_json: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (startCharacter > row.text_characters)
    throw new CognitionConflictError(
      "Source text position exceeds the actual original",
    );
  if (row.payload_json) {
    recordRaw?.(row.payload_json);
    return {
      evidence: parseSchema(
        CognitionEvidenceSchema,
        JSON.parse(row.payload_json),
      ),
      excerpted: false,
      ...(row.has_text
        ? {
            textRange: {
              startCharacter: 0,
              endCharacter: row.text_characters,
              totalCharacters: row.text_characters,
            },
          }
        : {}),
    };
  }
  const base = database
    .prepare(
      `SELECT json_remove(payload_json,'$.text','$.object.title','$.object.url',
    '$.effect.description','$.effect.sourceRefs') AS payload_json FROM cognition_evidence WHERE id=?`,
    )
    .get(id) as JsonRow;
  const value = JSON.parse(base.payload_json) as CognitionEvidence;
  value.text = INCOMPLETE_RECEIPT;
  if (value.effect)
    value.effect = {
      ...value.effect,
      description: INCOMPLETE_RECEIPT,
      sourceRefs: [],
    };
  if (bytes(value) > maxBytes) return undefined;
  // SQLite offsets count Unicode code points. Only the explicitly selected,
  // bounded slice crosses into JS; a tail is never concatenated with the head.
  let lower = 0,
    upper = Math.min(
      row.text_characters - startCharacter,
      Math.max(0, maxBytes - bytes(value)),
    );
  const slice = database.prepare(
    `SELECT substr(COALESCE(json_extract(payload_json,'$.text'),''),?,?) AS text FROM cognition_evidence WHERE id=?`,
  );
  while (lower < upper) {
    const count = Math.ceil((lower + upper) / 2);
    const text = (slice.get(startCharacter + 1, count, id) as { text: string })
      .text;
    value.text = `${text}\n${INCOMPLETE_RECEIPT}`;
    if (bytes(value) <= maxBytes) lower = count;
    else upper = count - 1;
  }
  value.text = `${(slice.get(startCharacter + 1, lower, id) as { text: string }).text}\n${INCOMPLETE_RECEIPT}`;
  return {
    evidence: parseSchema(CognitionEvidenceSchema, value),
    excerpted: true,
    ...(row.has_text
      ? {
          textRange: {
            startCharacter,
            endCharacter: startCharacter + lower,
            totalCharacters: row.text_characters,
          },
        }
      : {}),
  };
}

/** Exact validation metadata, not content for the model or for memory formation. */
export function readEvidenceMetadata(
  database: Database.Database,
  id: string,
): CognitionEvidence | undefined {
  const row = database
    .prepare(
      `SELECT json_remove(payload_json, '$.text', '$.object.title', '$.object.url',
    '$.effect.description', '$.effect.sourceRefs') AS payload_json FROM cognition_evidence WHERE id = ?`,
    )
    .get(id) as JsonRow | undefined;
  if (!row) return undefined;
  const value = JSON.parse(row.payload_json) as CognitionEvidence;
  if (value.effect)
    value.effect = {
      ...value.effect,
      description: "Actual effect metadata; content not loaded.",
      sourceRefs: [],
    };
  return parseSchema(CognitionEvidenceSchema, value);
}

export interface CognitionSnapshotRead {
  snapshot: CognitionSnapshot;
  coverage: CognitionAnalysisCoverage;
  /** Actual receipt boundary when this snapshot was captured, independent of content consumption. */
  receivedThroughSequence: number;
}

/** Ordinary conversation reads its semantic roots directly. It neither scans
 * the unread journal nor advances analysis/directory watermarks. Caller owns
 * one synchronous transaction for attention, selection, bodies and coverage. */
export function readConversationContext(
  database: Database.Database,
  attention: CognitionAttentionState,
  maxReadBytes: number,
  signal: AbortSignal,
): CognitionConversationRead {
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0)
    throw new RangeError(
      "Conversation requires a positive raw-read allocation",
    );
  signal.throwIfAborted();
  const read: CognitionConversationRead = {
    snapshot: {
      attention,
      situations: [],
      intents: [],
      evidence: [],
      recentAttempts: [],
    },
    receivedThroughSequence: attention.lastReceiptSequence,
    coverage: {
      allocation: { situations: [], intents: [] },
      excerptedEvidenceIds: [],
      releasedEvidenceIds: [],
      missing: { situationIds: [], intentIds: [], evidenceIds: [] },
      omittedForResource: { situationIds: [], intentIds: [], evidenceIds: [] },
      selectionOmittedForResource: false,
      incompleteSituationClaims: [],
      incompleteIntentSources: [],
    },
    readCost: { rawValueBytes: 0, rowCount: 0 },
  };
  const { snapshot, coverage, readCost } = read;
  const budget: ConversationReadBudget = {
    remaining: () => maxReadBytes - readCost.rawValueBytes,
    record: (raw) => {
      signal.throwIfAborted();
      const count = Buffer.byteLength(raw, "utf8");
      if (count > budget.remaining())
        throw new CognitionConflictError(
          "Conversation body read exceeded its raw allocation",
        );
      readCost.rawValueBytes += count;
      readCost.rowCount += 1;
    },
  };
  const found = (table: string, id: string): boolean => {
    signal.throwIfAborted();
    return !!database
      .prepare(`SELECT 1 FROM ${table} WHERE id=? AND persona_id=?`)
      .get(id, attention.personaId);
  };
  const seenSituations = new Set<string>();
  const seenIntents = new Set<string>();
  const seenEvidence = new Set<string>();
  const addSituation = (id: string): void => {
    if (seenSituations.has(id)) return;
    seenSituations.add(id);
    if (!found("cognition_situations", id)) {
      coverage.missing.situationIds.push(id);
      return;
    }
    const view = readSituationView(
      database,
      id,
      budget.remaining(),
      false,
      undefined,
      budget,
    );
    if (!view) {
      coverage.omittedForResource.situationIds.push(id);
      return;
    }
    snapshot.situations.push(view.value);
    if (view.allocation) {
      coverage.allocation.situations.push(view.allocation);
      const count = database
        .prepare(
          "SELECT json_array_length(payload_json,'$.claims') AS n FROM cognition_situations WHERE id=?",
        )
        .get(id) as { n: number };
      if (count.n !== view.value.claims.length)
        coverage.incompleteSituationClaims.push(id);
    }
  };
  const addIntent = (id: string): void => {
    if (seenIntents.has(id)) return;
    seenIntents.add(id);
    if (!found("cognition_intents", id)) {
      coverage.missing.intentIds.push(id);
      return;
    }
    const view = readIntentView(
      database,
      id,
      budget.remaining(),
      false,
      budget,
    );
    if (!view) {
      coverage.omittedForResource.intentIds.push(id);
      return;
    }
    snapshot.intents.push(view.value);
    if (view.allocation) {
      coverage.allocation.intents!.push(view.allocation);
      const count = database
        .prepare(
          "SELECT json_array_length(payload_json,'$.evidenceIds') AS sources,json_array_length(payload_json,'$.effectEvidenceIds') AS effects FROM cognition_intents WHERE id=?",
        )
        .get(id) as { sources: number; effects: number };
      if (
        count.sources !== view.value.evidenceIds.length ||
        count.effects !== view.value.effectEvidenceIds.length
      )
        coverage.incompleteIntentSources.push(id);
    }
    if (view.value.situationId) addSituation(view.value.situationId);
  };
  const addEvidence = (id: string): void => {
    if (seenEvidence.has(id)) return;
    seenEvidence.add(id);
    signal.throwIfAborted();
    const row = database
      .prepare(
        `SELECT length(CAST(payload_json AS BLOB)) AS size,
      json_extract(payload_json,'$.bodyReleasedAt') AS released
      FROM cognition_evidence WHERE id=? AND persona_id=?`,
      )
      .get(id, attention.personaId) as
      { size: number; released: string | null } | undefined;
    if (!row) {
      coverage.missing.evidenceIds.push(id);
      return;
    }
    if (row.released) {
      coverage.releasedEvidenceIds.push(id);
      return;
    }
    // Optional original bodies are supplied whole or marked unread. The shared
    // excerpt parser remains available to analysis; no substring probe is hidden
    // from this consumer's raw-read accounting.
    if (row.size > budget.remaining()) {
      coverage.omittedForResource.evidenceIds.push(id);
      return;
    }
    const body = readEvidence(database, id, row.size, 0, (raw) =>
      budget.record(raw),
    );
    if (!body)
      throw new CognitionConflictError(
        "Conversation source changed within its read transaction",
      );
    snapshot.evidence.push(body.evidence);
    if (body.excerpted) coverage.excerptedEvidenceIds.push(id);
  };
  const addSupport = (): void => {
    for (const situation of snapshot.situations)
      for (const claim of situation.claims)
        for (const id of [
          ...claim.evidenceIds,
          ...claim.contradictingEvidenceIds,
        ])
          addEvidence(id);
    for (const intent of snapshot.intents)
      for (const id of [
        ...intent.evidenceIds,
        ...intent.effectEvidenceIds,
        ...(intent.completion?.evidenceUses.map(
          ({ evidenceId }) => evidenceId,
        ) ?? []),
      ])
        addEvidence(id);
  };
  if (attention.currentSituationId) addSituation(attention.currentSituationId);
  if (attention.committedIntentId) addIntent(attention.committedIntentId);
  if (attention.currentSituationId)
    for (const row of database
      .prepare(
        `SELECT id FROM cognition_intents WHERE persona_id=? AND situation_id=?
      AND status IN ('active','suspended') ORDER BY updated_at DESC,id`,
      )
      .iterate(attention.personaId, attention.currentSituationId) as Iterable<{
      id: string;
    }>)
      addIntent(row.id);
  addSupport();

  // Preserve small current semantics before a potentially huge latest Attempt.
  // Never filter statuses before choosing the latest or fall back to an older one.
  const attempt = database
    .prepare(
      `SELECT id,length(CAST(payload_json AS BLOB)) AS size FROM cognition_decision_attempts
    WHERE persona_id=? ORDER BY creation_sequence DESC LIMIT 1`,
    )
    .get(attention.personaId) as { id: string; size: number } | undefined;
  if (attempt) {
    if (attempt.size > budget.remaining())
      coverage.selectionOmittedForResource = true;
    else {
      const row = database
        .prepare(
          "SELECT payload_json FROM cognition_decision_attempts WHERE id=?",
        )
        .get(attempt.id) as JsonRow;
      budget.record(row.payload_json);
      const value = parseSchema(
        CognitionDecisionAttemptSchema,
        JSON.parse(row.payload_json),
      );
      snapshot.recentAttempts.push({ ...value, projection: "complete" });
      const selected = latestSelectedContextIntent(snapshot);
      if (selected) addIntent(selected);
      addSupport();
    }
  }
  const coreIds = new Set(snapshot.situations.map(({ id }) => id));
  const relatedIds = new Set(
    snapshot.situations.flatMap(
      ({ relatedSituationIds }) => relatedSituationIds,
    ),
  );
  for (const id of relatedIds) if (!coreIds.has(id)) addSituation(id);
  addSupport();
  snapshot.evidence.sort((a, b) => a.receiptSequence - b.receiptSequence);
  signal.throwIfAborted();
  return read;
}

/** A byte allocation bounds JS materialization, separately from the model's token limit. */
export function readCognitionSnapshot(
  database: Database.Database,
  attention: CognitionAttentionState,
  now: string,
  maxBytes: number,
  pendingCues: Iterable<string>,
  referencedState?: CognitionStateReferences,
  retainedEvidenceIds: readonly string[] = [],
): CognitionSnapshotRead {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError(
      "Cognition read allocation must be a positive byte count",
    );
  const receivedThroughSequence = attention.lastReceiptSequence;
  const personaId = attention.personaId;
  const latestAttempt = database
    .prepare(
      "SELECT id FROM cognition_decision_attempts WHERE persona_id = ? ORDER BY creation_sequence DESC LIMIT 1",
    )
    .get(personaId) as { id: string } | undefined;
  const count = (table: string, where: string): number =>
    (
      database
        .prepare(
          `SELECT count(*) AS count FROM ${table} WHERE persona_id = ? AND ${where}`,
        )
        .get(personaId) as { count: number }
    ).count;
  const snapshot: CognitionSnapshot = {
    attention,
    situations: [],
    intents: [],
    evidence: [],
    recentAttempts: [],
  };
  const coverage: CognitionAnalysisCoverage = {
    ...(latestAttempt || referencedState
      ? {
          stateReferences: {
            missing: false,
            omittedForBudget: false,
            sourceMappingMissingCount:
              referencedState?.missingReferenceCount ?? 0,
            sourceMappingTruncated: referencedState?.truncated ?? false,
          },
        }
      : {}),
    excerptedEvidenceIds: [],
    omittedSituationCount: count("cognition_situations", "status != 'closed'"),
    omittedIntentCount: count(
      "cognition_intents",
      "status NOT IN ('fulfilled','abandoned')",
    ),
    omittedAttemptCount: count(
      "cognition_decision_attempts",
      "status NOT IN ('settled','failed','superseded')",
    ),
    moreEvidencePending: false,
    passiveSpans: [],
    allocation: { situations: [], intents: [] },
    note: "This is an explicitly bounded database view. Partial entity arrays contain only the listed visible IDs: upsert supplied episodes/claims/references, preserve unseen entries. Preserved fields cannot overwrite canonical values. Missing state is unchanged, not closed or forgotten. Receipt excerpts cannot establish unseen facts; original sources stay persisted. Journal advancement is only the oldest represented contiguous prefix, never the latest selected cue. A lifecycle Attempt view supplies execution feedback only; its omitted decision and dependencies grant no selected-state or source-use authority. Catalogue coverage records reviewed identities only. Its unseen originals cannot ground claims; supplied original bodies and the historical processing prefix are recorded separately.",
  };
  coverage.sourceCoverage = readSourceCatalogue(
    database,
    attention,
    Math.floor(maxBytes / 4),
  );
  const recovered = database
    .prepare(
      `SELECT id,json_extract(payload_json,'$.sourceCoverage') AS coverage
    FROM cognition_decision_attempts WHERE persona_id=? AND user_generation=?
      AND json_extract(payload_json,'$.sourceCoverage.completionPending')=1
      AND json_extract(payload_json,'$.sourceCoverage.throughSequence')>?
      AND json_extract(payload_json,'$.sourceCoverage.readPlan') IS NOT NULL
    ORDER BY creation_sequence DESC LIMIT 1`,
    )
    .get(
      personaId,
      attention.userGeneration,
      attention.catalogueReviewedThroughSequence ??
        attention.analyzedThroughSequence,
    ) as { id: string; coverage: string } | undefined;
  if (recovered) {
    const previous = JSON.parse(recovered.coverage) as CognitionSourceCoverage;
    coverage.sourceCoverage.readPlan = previous.readPlan!;
    coverage.sourceCoverage.recoveredFromAttemptId = recovered.id;
  }
  const sourcePositions = new Map(
    (coverage.sourceCoverage.readPlan?.requests ?? []).map((request) => [
      request.evidenceId,
      request.startCharacter ?? 0,
    ]),
  );
  const sourceTextRanges = new Map<string, SourceTextRange>();
  const sourceReadStatuses = new Map(
    (coverage.sourceCoverage.readPlan?.requests ?? []).map(({ evidenceId }) => {
      const metadata = readEvidenceMetadata(database, evidenceId);
      return [
        evidenceId,
        metadata?.personaId !== personaId
          ? ("missing" as const)
          : metadata.bodyReleasedAt
            ? ("released" as const)
            : ("omitted" as const),
      ] as const;
    }),
  );
  const size = (): number => {
    recordSourceSupply(
      coverage.sourceCoverage!,
      snapshot,
      coverage.excerptedEvidenceIds,
      sourceTextRanges,
    );
    if (coverage.sourceCoverage?.readPlan)
      coverage.sourceCoverage.readResults =
        coverage.sourceCoverage.readPlan.requests.map(({ evidenceId }) => {
          const supplied = coverage.sourceCoverage!.supplied.find(
            (item) => item.evidenceId === evidenceId,
          );
          return {
            evidenceId,
            ...(supplied?.textRange ? { textRange: supplied.textRange } : {}),
            status:
              supplied?.status ??
              sourceReadStatuses.get(evidenceId) ??
              "missing",
          };
        });
    return bytes({ snapshot, coverage, receivedThroughSequence });
  };
  const fits = (): boolean => size() <= maxBytes;
  const remaining = (): number => maxBytes - size();
  if (!fits())
    throw new CognitionConflictError(
      "Read allocation cannot hold its identity and coverage metadata",
    );
  if (latestAttempt) {
    // Project in SQLite before crossing into JS. A failed material read must
    // remain visible even when its decision or required dependencies are large.
    // The complete record remains untouched for dispatch/recovery validation.
    const row = database
      .prepare(
        `SELECT CASE WHEN length(CAST(view AS BLOB)) <= ? THEN view ELSE NULL END AS payload_json
        FROM (SELECT json_set(json_remove(payload_json,
          '$.dependencies', '$.allocation', '$.wakeSources', '$.recallPlan',
          '$.recallSummary', '$.decision', '$.actionReadSet', '$.dispatchKey',
          '$.feedbackEvidenceIds', '$.sourceCoverage'), '$.projection', 'lifecycle') AS view
          FROM cognition_decision_attempts WHERE id=?)`,
      )
      .get(remaining(), latestAttempt.id) as { payload_json: string | null };
    if (!row.payload_json)
      throw new CognitionConflictError(
        "Read allocation cannot hold the latest attempt lifecycle feedback",
      );
    const view = parseSchema(
      CognitionAttemptLifecycleSchema,
      JSON.parse(row.payload_json),
    );
    snapshot.recentAttempts.push(view);
    if (!["settled", "failed", "superseded"].includes(view.status))
      coverage.omittedAttemptCount -= 1;
    if (!fits())
      throw new CognitionConflictError(
        "Read allocation cannot hold the latest attempt lifecycle feedback",
      );
  }
  const evidenceIds = new Set<string>();
  const addEvidence = (id: string, minimal = false): boolean => {
    if (evidenceIds.has(id)) return true;
    let allowance = remaining();
    for (;;) {
      const metadata = minimal ? readEvidenceMetadata(database, id) : undefined;
      if (metadata?.bodyReleasedAt) return false;
      const found = metadata
        ? {
            evidence: { ...metadata, text: INCOMPLETE_RECEIPT },
            excerpted: true,
          }
        : readEvidence(database, id, allowance, sourcePositions.get(id) ?? 0);
      if (!found) return false;
      if (found.textRange) sourceTextRanges.set(id, found.textRange);
      else sourceTextRanges.delete(id);
      snapshot.evidence.push(found.evidence);
      if (found.excerpted) coverage.excerptedEvidenceIds.push(id);
      if (fits()) break;
      const excess = size() - maxBytes;
      snapshot.evidence.pop();
      coverage.excerptedEvidenceIds = coverage.excerptedEvidenceIds.filter(
        (value) => value !== id,
      );
      if (minimal) return false;
      allowance -= excess;
      if (allowance <= 0) return false;
    }
    evidenceIds.add(id);
    return true;
  };
  const expandEvidence = (id: string): void => {
    if (!coverage.excerptedEvidenceIds.includes(id)) return;
    const index = snapshot.evidence.findIndex((value) => value.id === id);
    const old = snapshot.evidence[index]!;
    const oldRange = sourceTextRanges.get(id);
    snapshot.evidence.splice(index, 1);
    evidenceIds.delete(id);
    coverage.excerptedEvidenceIds = coverage.excerptedEvidenceIds.filter(
      (value) => value !== id,
    );
    if (!addEvidence(id)) {
      snapshot.evidence.splice(index, 0, old);
      if (oldRange) sourceTextRanges.set(id, oldRange);
      else sourceTextRanges.delete(id);
      evidenceIds.add(id);
      coverage.excerptedEvidenceIds.push(id);
    }
  };
  // A real current user message must not wait behind old viewport pages. This
  // source is readable ahead of the FIFO cursor, just as the latest viewport is;
  // neither its receipt nor a claim about it consumes intervening journal rows.
  const currentUser = database
    .prepare(
      `SELECT id, source_kind, source_id, receipt_sequence FROM cognition_evidence
      WHERE persona_id = ? AND receipt_sequence > ?
        AND actor = 'user' AND kind = 'utterance' AND source_kind != 'memory'
      ORDER BY receipt_sequence DESC LIMIT 1`,
    )
    .get(
      personaId,
      attention.catalogueReviewedThroughSequence ??
        attention.analyzedThroughSequence,
    ) as
    | {
        id: string;
        source_kind: string;
        source_id: string;
        receipt_sequence: number;
      }
    | undefined;
  if (currentUser) {
    coverage.currentUserSource = {
      evidenceId: currentUser.id,
      status: "excerpted",
    };
    if (currentUser.source_kind === "run") {
      // The same-Run source prefix uses the existing identity index. Apply the
      // receipt boundary inside aggregates/iteration so an old FIFO cursor does
      // not make SQLite scan unrelated journal rows instead of this Run.
      const observed = database
        .prepare(
          `SELECT
        max(CASE WHEN actor='agent' AND receipt_sequence>? THEN 1 ELSE 0 END) AS reply,
        max(CASE WHEN actor='system' AND receipt_sequence>? THEN 1 ELSE 0 END) AS terminal
        FROM cognition_evidence WHERE persona_id=? AND source_kind='run' AND source_id=?
          AND ((actor='agent' AND kind='utterance' AND source_revision='completed')
            OR (actor='system' AND kind='observation' AND source_fragment='terminal'))`,
        )
        .get(
          currentUser.receipt_sequence,
          currentUser.receipt_sequence,
          personaId,
          currentUser.source_id,
        ) as { reply: number | null; terminal: number | null };
      coverage.currentUserSource.runResponse = {
        runId: currentUser.source_id,
        replyObserved: observed.reply === 1,
        terminalObserved: observed.terminal === 1,
        evidenceIds: [],
        omittedForBudget: false,
      };
    }
    if (!fits() || !addEvidence(currentUser.id, true))
      throw new CognitionConflictError(
        "Read allocation cannot hold the oldest receipt and current user source identities",
      );
    const response = coverage.currentUserSource.runResponse;
    if (response) {
      // Reserve bounded identities before expanding a possibly large utterance.
      // The later FIFO pass deduplicates these exact IDs and keeps its own cursor.
      for (const row of database
        .prepare(
          `SELECT id, receipt_sequence FROM cognition_evidence
        WHERE persona_id=? AND source_kind='run' AND source_id=?
          AND ((actor='agent' AND kind='utterance' AND source_revision='completed')
            OR (actor='system' AND kind='observation' AND source_fragment='terminal'))
        ORDER BY CASE WHEN actor='agent' THEN 0 ELSE 1 END, receipt_sequence`,
        )
        .iterate(personaId, currentUser.source_id) as Iterable<{
        id: string;
        receipt_sequence: number;
      }>) {
        if (row.receipt_sequence <= currentUser.receipt_sequence) continue;
        response.evidenceIds.push(row.id);
        if (!fits() || !addEvidence(row.id, true)) {
          response.evidenceIds.pop();
          response.omittedForBudget = true;
          break;
        }
      }
    }
    expandEvidence(currentUser.id);
    for (const id of response?.evidenceIds ?? []) expandEvidence(id);
    coverage.currentUserSource.status = coverage.excerptedEvidenceIds.includes(
      currentUser.id,
    )
      ? "excerpted"
      : "complete";
  }

  for (const entry of coverage.sourceCoverage.entries) {
    if (!entry.requiresBody) continue;
    if (!addEvidence(entry.latestEvidenceId)) {
      coverage.sourceCoverage.throughSequence = entry.fromSequence - 1;
      break;
    }
  }
  for (const request of coverage.sourceCoverage.readPlan?.requests ?? []) {
    addEvidence(request.evidenceId);
  }
  const childReferences = new Map<string, ReferencedChildren>();
  const childrenFor = (situationId: string): ReferencedChildren | undefined => {
    const cached = childReferences.get(situationId);
    if (cached) return cached;
    const supplied = referencedState?.situationChildren?.find(
      (value) => value.situationId === situationId,
    );
    const children: ReferencedChildren = {
      situationId,
      claimIds: [...(supplied?.claimIds ?? [])],
      episodeIds: [...(supplied?.episodeIds ?? [])],
    };
    if (latestAttempt)
      for (const row of database
        .prepare(
          `SELECT json_extract(claim.value,'$.claimId') AS id
        FROM cognition_decision_attempts a, json_each(a.payload_json,'$.decision.selectedBasis.currentClaimRefs') claim
        WHERE a.id=? AND json_extract(claim.value,'$.situationId')=?
          AND EXISTS (SELECT 1 FROM json_each(a.payload_json,'$.dependencies.situations') d WHERE json_extract(d.value,'$.id')=?)`,
        )
        .iterate(latestAttempt.id, situationId, situationId) as Iterable<{
        id: string;
      }>) {
        if (children.claimIds.includes(row.id)) continue;
        children.claimIds.push(row.id);
        if (bytes(children) > maxBytes) {
          children.claimIds.pop();
          coverage.stateReferences!.omittedForBudget = true;
          break;
        }
      }
    childReferences.set(situationId, children);
    return children;
  };
  const recordReferenceGap = (gap: ReferenceGap | undefined): void => {
    if (!gap || !coverage.stateReferences) return;
    coverage.stateReferences.missing ||= gap.missing;
    coverage.stateReferences.omittedForBudget ||= gap.omittedForBudget;
  };
  const addSituation = (id: string, minimal = false): boolean => {
    if (snapshot.situations.some((value) => value.id === id)) return true;
    const view = readSituationView(
      database,
      id,
      remaining(),
      minimal,
      childrenFor(id),
    );
    if (!view || view.value.personaId !== personaId) return false;
    snapshot.situations.push(view.value);
    if (view.allocation) coverage.allocation!.situations.push(view.allocation);
    recordReferenceGap(view.referenceGap);
    coverage.omittedSituationCount -= Number(view.value.status !== "closed");
    if (!fits()) {
      snapshot.situations.pop();
      coverage.allocation!.situations = coverage.allocation!.situations.filter(
        (value) => value.id !== id,
      );
      coverage.omittedSituationCount += Number(view.value.status !== "closed");
      return false;
    }
    return true;
  };
  const addIntent = (id: string, minimal = false): boolean => {
    if (snapshot.intents.some((value) => value.id === id)) return true;
    const view = readIntentView(database, id, remaining(), minimal);
    if (!view || view.value.personaId !== personaId) return false;
    snapshot.intents.push(view.value);
    if (view.allocation) coverage.allocation!.intents!.push(view.allocation);
    coverage.omittedIntentCount -= Number(
      !["fulfilled", "abandoned"].includes(view.value.status),
    );
    if (!fits()) {
      snapshot.intents.pop();
      coverage.allocation!.intents = coverage.allocation!.intents!.filter(
        (value) => value.id !== id,
      );
      coverage.omittedIntentCount += Number(
        !["fulfilled", "abandoned"].includes(view.value.status),
      );
      return false;
    }
    if (view.value.situationId) addSituation(view.value.situationId, minimal);
    return true;
  };
  for (const id of retainedEvidenceIds) if (!addEvidence(id, true)) break;
  if (attention.currentSituationId)
    addSituation(attention.currentSituationId, true);
  if (attention.committedIntentId) addIntent(attention.committedIntentId, true);
  // A due consideration omitted from this bounded input must remain pending.
  for (const row of database
    .prepare(
      `SELECT id FROM cognition_intents WHERE persona_id = ?
      AND status NOT IN ('fulfilled','abandoned') AND next_wake_at <= ?
      ORDER BY next_wake_at, updated_at, id`,
    )
    .iterate(personaId, now) as Iterable<{ id: string }>)
    if (!addIntent(row.id, true)) break;
  // Character life is also a persistent commitment even while user focus is elsewhere.
  const character = database
    .prepare(
      `SELECT id FROM cognition_intents WHERE persona_id = ? AND owner = 'character'
    AND status NOT IN ('fulfilled','abandoned') ORDER BY updated_at DESC, id DESC LIMIT 1`,
    )
    .get(personaId) as { id: string } | undefined;
  if (character) addIntent(character.id, true);
  for (const id of pendingCues) if (!addEvidence(id)) break;
  if (attention.foregroundObject) {
    const currentView = database
      .prepare(
        `SELECT id FROM cognition_evidence
      WHERE persona_id = ? AND kind = 'observation' AND json_extract(payload_json,'$.object.key') = ?
      AND COALESCE(json_extract(payload_json,'$.boundary'),'') != 'idle'
      AND (COALESCE(json_extract(payload_json,'$.text'),'') != '' OR json_extract(payload_json,'$.visual') IS NOT NULL)
      ORDER BY observed_at DESC, receipt_sequence DESC LIMIT 1`,
      )
      .get(personaId, attention.foregroundObject.key) as
      { id: string } | undefined;
    if (currentView && addEvidence(currentView.id))
      coverage.currentViewEvidenceId = currentView.id;
  }

  // Reserve referenced state after the necessary source/cue identities, alongside
  // current entities, before the remaining journal can fill the whole page.
  // Exact IDs only restore readability, never change lifecycle state.
  const addReferenced = (kind: "situation" | "intent", id: string): boolean => {
    const table =
      kind === "situation" ? "cognition_situations" : "cognition_intents";
    if (
      !database
        .prepare(`SELECT 1 FROM ${table} WHERE id = ? AND persona_id = ?`)
        .get(id, personaId)
    ) {
      coverage.stateReferences!.missing = true;
      return true;
    }
    if (kind === "situation" ? addSituation(id, true) : addIntent(id, true))
      return true;
    coverage.stateReferences!.omittedForBudget = true;
    return false;
  };
  for (const kind of ["situation", "intent"] as const) {
    const supplied =
      kind === "situation"
        ? referencedState?.situationIds
        : referencedState?.intentIds;
    if (supplied)
      for (const id of supplied) if (!addReferenced(kind, id)) break;
    if (latestAttempt) {
      // Only selected uses that were actually read can renew residency. A read-set
      // alone would recursively keep every previously exposed closed entity.
      for (const row of database
        .prepare(
          `SELECT json_extract(d.value,'$.id') AS id
        FROM cognition_decision_attempts a, json_each(a.payload_json, ?) d
        WHERE a.id=? AND (
          EXISTS (SELECT 1 FROM json_each(a.payload_json,'$.decision.choices') choice
            WHERE json_extract(choice.value,'$.id')=json_extract(a.payload_json,'$.decision.selectedChoiceId')
              AND json_extract(choice.value, ?)=json_extract(d.value,'$.id'))
          OR (?='situation' AND EXISTS (
            SELECT 1 FROM json_each(a.payload_json,'$.decision.selectedBasis.currentClaimRefs') claim
            WHERE json_extract(claim.value,'$.situationId')=json_extract(d.value,'$.id')))
        ) ORDER BY CAST(d.key AS INTEGER)`,
        )
        .iterate(
          `$.dependencies.${kind === "situation" ? "situations" : "intents"}`,
          latestAttempt.id,
          kind === "situation" ? "$.situationId" : "$.intentId",
          kind,
        ) as Iterable<{ id: string }>)
        if (!addReferenced(kind, row.id)) break;
    }
  }

  // Matched children need their actual support in the same allocation, not only a parent title.
  const matchedEvidence = new Set<string>();
  for (const situation of snapshot.situations) {
    const preferred = childrenFor(situation.id);
    for (const episode of situation.episodes)
      if (preferred?.episodeIds.includes(episode.id))
        episode.evidenceIds.forEach((id) => matchedEvidence.add(id));
    for (const claim of situation.claims)
      if (preferred?.claimIds.includes(claim.id))
        [
          ...claim.evidenceIds,
          ...claim.contradictingEvidenceIds,
          ...(claim.historyEvidenceIds ?? []),
        ].forEach((id) => matchedEvidence.add(id));
  }
  for (const id of matchedEvidence) {
    if (
      !database
        .prepare("SELECT 1 FROM cognition_evidence WHERE id=? AND persona_id=?")
        .get(id, personaId)
    ) {
      if (coverage.stateReferences) coverage.stateReferences.missing = true;
    } else if (!addEvidence(id) && coverage.stateReferences)
      coverage.stateReferences.omittedForBudget = true;
  }
  // Enlarge already-selected completion sources only within the same remaining allocation.
  for (const id of retainedEvidenceIds) expandEvidence(id);

  // Direct speech, control and actual effects are supplied before ordinary
  // object versions. A critical identity without a body cannot be disposed of
  // merely because its directory row fitted.
  const catalogue = coverage.sourceCoverage;
  for (const entry of catalogue.entries) {
    if (!entry.requiresBody) continue;
    if (!addEvidence(entry.latestEvidenceId)) {
      catalogue.throughSequence = entry.fromSequence - 1;
      break;
    }
  }
  catalogue.entries = catalogue.entries.filter(
    (entry) => entry.throughSequence <= catalogue.throughSequence,
  );
  catalogue.eventCount = catalogue.entries.reduce(
    (total, entry) => total + entry.eventCount,
    0,
  );
  catalogue.omittedEventCount = (
    database
      .prepare(
        `SELECT count(*) AS count FROM cognition_evidence
    WHERE persona_id=? AND receipt_sequence>? AND receipt_sequence<=?`,
      )
      .get(
        personaId,
        catalogue.throughSequence,
        attention.lastReceiptSequence,
      ) as { count: number }
  ).count;
  // Current foreground is already present. Latest bodies of the remaining
  // actual objects compete within the same allocation; intermediate originals
  // remain directory-only unless the model asks to open them.
  for (const entry of [...catalogue.entries].reverse())
    addEvidence(entry.latestEvidenceId);
  const priorSpan = readLatestPassiveSpan(
    database,
    personaId,
    attention.analyzedThroughSequence,
  );
  if (priorSpan) {
    coverage.passiveSpans!.push(priorSpan);
    if (!fits()) coverage.passiveSpans!.pop();
  }
  let through = attention.analyzedThroughSequence;
  const nextOriginal =
    database.prepare(`SELECT id,receipt_sequence FROM cognition_evidence
    WHERE persona_id=? AND receipt_sequence>? AND receipt_sequence<=? ORDER BY receipt_sequence LIMIT 1`);
  for (;;) {
    const next = nextOriginal.get(
      personaId,
      through,
      catalogue.throughSequence,
    ) as { id: string; receipt_sequence: number } | undefined;
    if (!next) break;
    if (evidenceIds.has(next.id)) {
      through = next.receipt_sequence;
      continue;
    }
    const passive = readPassiveSpan(
      database,
      personaId,
      next.receipt_sequence,
      catalogue.throughSequence,
    );
    if (!passive) break;
    through = passive.throughSequence;
  }
  snapshot.attention = { ...attention, lastReceiptSequence: through };
  coverage.moreEvidencePending = catalogue.omittedEventCount > 0;

  // Expand partial current entities only with the space actually left by the journal page.
  for (const [index, old] of snapshot.situations.entries()) {
    const allocation = coverage.allocation!.situations.find(
      (value) => value.id === old.id,
    );
    if (!allocation) continue;
    const view = readSituationView(
      database,
      old.id,
      remaining() + bytes(old) + bytes(allocation),
      false,
      childrenFor(old.id),
    );
    if (!view) continue;
    recordReferenceGap(view.referenceGap);
    snapshot.situations[index] = view.value;
    coverage.allocation!.situations = coverage.allocation!.situations.filter(
      (value) => value.id !== old.id,
    );
    if (view.allocation) coverage.allocation!.situations.push(view.allocation);
    if (!fits()) {
      snapshot.situations[index] = old;
      coverage.allocation!.situations = coverage.allocation!.situations.filter(
        (value) => value.id !== old.id,
      );
      coverage.allocation!.situations.push(allocation);
    }
  }
  for (const [index, old] of snapshot.intents.entries()) {
    const allocation = coverage.allocation!.intents!.find(
      (value) => value.id === old.id,
    );
    if (!allocation) continue;
    const view = readIntentView(
      database,
      old.id,
      remaining() + bytes(old) + bytes(allocation),
      false,
    );
    if (!view) continue;
    snapshot.intents[index] = view.value;
    coverage.allocation!.intents = coverage.allocation!.intents!.filter(
      (value) => value.id !== old.id,
    );
    if (view.allocation) coverage.allocation!.intents.push(view.allocation);
    if (!fits()) {
      snapshot.intents[index] = old;
      coverage.allocation!.intents = coverage.allocation!.intents.filter(
        (value) => value.id !== old.id,
      );
      coverage.allocation!.intents.push(allocation);
    }
  }
  for (const table of ["cognition_intents", "cognition_situations"] as const) {
    const where =
      table === "cognition_intents"
        ? "status NOT IN ('fulfilled','abandoned')"
        : "status != 'closed'";
    for (const row of database
      .prepare(
        `SELECT id FROM ${table} WHERE persona_id = ? AND ${where} ORDER BY updated_at DESC, id`,
      )
      .iterate(personaId) as Iterable<{ id: string }>) {
      if (
        !(table === "cognition_intents"
          ? addIntent(row.id)
          : addSituation(row.id))
      )
        break;
    }
  }
  const references = new Set(
    snapshot.situations
      .flatMap((value) => [
        ...value.episodes.flatMap((episode) => episode.evidenceIds),
        ...value.claims.flatMap((claim) => [
          ...claim.evidenceIds,
          ...claim.contradictingEvidenceIds,
          ...(claim.historyEvidenceIds ?? []),
        ]),
      ])
      .concat(
        snapshot.intents.flatMap((value) => [
          ...value.evidenceIds,
          ...value.effectEvidenceIds,
          ...(value.completion?.evidenceUses.map(
            ({ evidenceId }) => evidenceId,
          ) ?? []),
        ]),
      ),
  );
  for (const id of references) if (!addEvidence(id)) break;
  for (const row of database
    .prepare(
      `SELECT id, length(CAST(payload_json AS BLOB)) AS size FROM cognition_decision_attempts
    WHERE persona_id = ? AND (status NOT IN ('settled','failed','superseded') OR id = ?)
    ORDER BY creation_sequence DESC`,
    )
    .iterate(personaId, latestAttempt?.id ?? null) as Iterable<{
    id: string;
    size: number;
  }>) {
    const previous = snapshot.recentAttempts.findIndex(
      ({ id }) => id === row.id,
    );
    const old = snapshot.recentAttempts[previous];
    if (row.size > remaining() + (old ? bytes(old) : 0)) break;
    const stored = database
      .prepare(
        "SELECT payload_json FROM cognition_decision_attempts WHERE id = ?",
      )
      .get(row.id) as JsonRow;
    const value = parseSchema(
      CognitionDecisionAttemptSchema,
      JSON.parse(stored.payload_json),
    );
    const view = { ...value, projection: "complete" as const };
    if (old) snapshot.recentAttempts[previous] = view;
    else snapshot.recentAttempts.push(view);
    if (!old && !["settled", "failed", "superseded"].includes(value.status))
      coverage.omittedAttemptCount -= 1;
    if (!fits()) {
      if (old) snapshot.recentAttempts[previous] = old;
      else snapshot.recentAttempts.pop();
      if (!old && !["settled", "failed", "superseded"].includes(value.status))
        coverage.omittedAttemptCount += 1;
      break;
    }
    // The full dependency read-set remains available for CAS validation. Only
    // actual selected uses and lifecycle feedback renew source-body residency.
    const selected = value.decision?.choices.find(
      ({ id }) => id === value.decision?.selectedChoiceId,
    );
    const used = new Set([
      ...(selected?.evidenceIds ?? []),
      ...(value.decision?.selectedBasis.evidenceUses.map(
        ({ evidenceId }) => evidenceId,
      ) ?? []),
      ...(value.actionReadSet?.currentObjects.map(
        ({ evidenceId }) => evidenceId,
      ) ?? []),
      ...(value.actionReadSet?.recollections.map(
        ({ evidenceId }) => evidenceId,
      ) ?? []),
      ...(value.actionReadSet?.opportunityEvidenceIds ?? []),
      ...value.feedbackEvidenceIds,
    ]);
    for (const id of used) if (!addEvidence(id)) break;
  }
  // Keep the latest cancellation/revision cue for every cited opportunity when it fits.
  for (const item of [...snapshot.evidence]) {
    if (!item.opportunity) continue;
    const latest = database
      .prepare(
        `SELECT id FROM cognition_evidence WHERE persona_id = ? AND source_kind = 'memory'
      AND json_extract(payload_json,'$.opportunity.id') = ? ORDER BY receipt_sequence DESC LIMIT 1`,
      )
      .get(personaId, item.opportunity.id) as { id: string } | undefined;
    if (latest) addEvidence(latest.id);
  }
  snapshot.evidence.sort((a, b) => a.receiptSequence - b.receiptSequence);
  if (coverage.currentUserSource)
    coverage.currentUserSource.status = coverage.excerptedEvidenceIds.includes(
      coverage.currentUserSource.evidenceId,
    )
      ? "excerpted"
      : "complete";
  size();
  return { snapshot, coverage, receivedThroughSequence };
}

/** Present only for the ordinary conversation consumer. Accounts for payload
 * strings at the SQLite/JS boundary; never a token or JSON-view allowance. */
interface ConversationReadBudget {
  remaining(): number;
  record(raw: string): void;
}

function readField(
  database: Database.Database,
  table: string,
  id: string,
  field: string,
  maxBytes: number,
  conversation?: ConversationReadBudget,
): unknown {
  const row = database
    .prepare(
      `SELECT CASE WHEN length(CAST(json_quote(json_extract(payload_json, ?)) AS BLOB)) <= ?
    THEN json_quote(json_extract(payload_json, ?)) ELSE NULL END AS value FROM ${table} WHERE id = ?`,
    )
    .get(
      `$.${field}`,
      Math.min(maxBytes, conversation?.remaining() ?? maxBytes),
      `$.${field}`,
      id,
    ) as { value: string | null };
  if (row.value === null) return undefined;
  conversation?.record(row.value);
  return JSON.parse(row.value);
}

export function readSituationView(
  database: Database.Database,
  id: string,
  maxBytes: number,
  minimal: boolean,
  preferred?: ReferencedChildren,
  conversation?: ConversationReadBudget,
):
  | {
      value: CognitionSituation;
      allocation?: SituationAllocation;
      referenceGap?: ReferenceGap;
    }
  | undefined {
  // Ordinary conversation does not project Episode history. Remove it in
  // SQLite before either the full view or its cost crosses into JavaScript.
  const payload = conversation
    ? "json_set(payload_json, '$.episodes', json('[]'))"
    : "payload_json";
  const full = database
    .prepare(
      `SELECT CASE WHEN length(CAST(${payload} AS BLOB)) <= ? THEN ${payload} ELSE NULL END AS payload_json
    FROM cognition_situations WHERE id = ?`,
    )
    .get(Math.min(maxBytes, conversation?.remaining() ?? maxBytes), id) as
    { payload_json: string | null } | undefined;
  if (!full) return undefined;
  if (full.payload_json && !minimal) {
    conversation?.record(full.payload_json);
    const value = parseSchema(
      CognitionSituationSchema,
      JSON.parse(full.payload_json),
    );
    return {
      value,
      ...(preferred
        ? {
            referenceGap: {
              missing:
                preferred.claimIds.some(
                  (id) => !value.claims.some((child) => child.id === id),
                ) ||
                preferred.episodeIds.some(
                  (id) => !value.episodes.some((child) => child.id === id),
                ),
              omittedForBudget: false,
            },
          }
        : {}),
    };
  }
  const baseSql = `SELECT json_remove(payload_json, '$.episodes', '$.claims', ${situationFields.map(() => "?").join(",")}) AS payload_json
    FROM cognition_situations WHERE id = ?`;
  const row = database
    .prepare(
      conversation
        ? `SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= ? THEN payload_json ELSE NULL END AS payload_json FROM (${baseSql})`
        : baseSql,
    )
    .get(
      ...(conversation ? [conversation.remaining()] : []),
      ...situationFields.map((key) => `$.${key}`),
      id,
    ) as { payload_json: string | null };
  if (row.payload_json === null) return undefined;
  conversation?.record(row.payload_json);
  const value = {
    ...JSON.parse(row.payload_json),
    title: "[PARTIAL SITUATION: canonical fields preserved]",
    summary: "",
    objectRefs: [],
    episodes: [],
    claims: [],
    unresolved: [],
    relatedSituationIds: [],
  } as CognitionSituation;
  const allocation: SituationAllocation = {
    id,
    episodeIds: [],
    claimIds: [],
    preservedFields: [...situationFields],
  };
  const fits = (): boolean => bytes(value) + bytes(allocation) <= maxBytes;
  if (!fits()) return undefined;
  const referenceGap: ReferenceGap = {
    missing: false,
    omittedForBudget: false,
  };
  const positions = {
    claims: new Map<string, number>(),
    episodes: new Map<string, number>(),
  };
  for (const field of ["claims", "episodes"] as const) {
    const preferredIds =
      field === "claims"
        ? preferred?.claimIds
        : conversation
          ? []
          : preferred?.episodeIds;
    for (const childId of preferredIds ?? []) {
      const remaining = Math.max(
        0,
        maxBytes - bytes(value) - bytes(allocation),
      );
      const child = database
        .prepare(
          `SELECT CASE WHEN length(CAST(child.value AS BLOB)) <= ? THEN child.value ELSE NULL END AS value, CAST(child.key AS INTEGER) AS ordinal
        FROM cognition_situations s, json_each(s.payload_json, ?) child
        WHERE s.id=? AND json_extract(child.value,'$.id')=?`,
        )
        .get(
          Math.min(remaining, conversation?.remaining() ?? remaining),
          `$.${field}`,
          id,
          childId,
        ) as { value: string | null; ordinal: number } | undefined;
      if (!child) {
        referenceGap.missing = true;
        continue;
      }
      if (child.value === null) {
        referenceGap.omittedForBudget = true;
        continue;
      }
      conversation?.record(child.value);
      const entry = JSON.parse(
        child.value,
      ) as CognitionSituation[typeof field][number];
      const ids =
        field === "claims" ? allocation.claimIds : allocation.episodeIds;
      if (ids.includes(entry.id)) continue;
      (value[field] as (typeof entry)[]).push(entry);
      ids.push(entry.id);
      positions[field].set(entry.id, child.ordinal);
      if (!fits()) {
        value[field].pop();
        ids.pop();
        referenceGap.omittedForBudget = true;
      }
    }
  }
  if (minimal) {
    for (const field of ["title", "summary"] as const) {
      const text = readField(
        database,
        "cognition_situations",
        id,
        field,
        Math.max(0, maxBytes - bytes(value) - bytes(allocation)),
        conversation,
      );
      if (text !== undefined) {
        value[field] = text as string;
        allocation.preservedFields = allocation.preservedFields.filter(
          (key) => key !== field,
        );
      }
    }
    for (const field of ["claims", "episodes"] as const)
      value[field].sort(
        (a, b) => positions[field].get(a.id)! - positions[field].get(b.id)!,
      );
    return { value, allocation, ...(preferred ? { referenceGap } : {}) };
  }
  for (const field of situationFields) {
    const content = readField(
      database,
      "cognition_situations",
      id,
      field,
      Math.max(0, maxBytes - bytes(value) - bytes(allocation)),
      conversation,
    );
    if (content === undefined) continue;
    const previous = (value as unknown as Record<string, unknown>)[field];
    if (content === null)
      delete (value as unknown as Record<string, unknown>)[field];
    else (value as unknown as Record<string, unknown>)[field] = content;
    if (!fits())
      (value as unknown as Record<string, unknown>)[field] = previous;
    else
      allocation.preservedFields = allocation.preservedFields.filter(
        (key) => key !== field,
      );
  }
  if (conversation) {
    const claims = readField(
      database,
      "cognition_situations",
      id,
      "claims",
      Math.max(0, maxBytes - bytes(value) - bytes(allocation)),
      conversation,
    );
    if (claims !== undefined) {
      value.claims = claims as CognitionSituation["claims"];
      allocation.claimIds = value.claims.map(({ id }) => id);
    }
    return { value: parseSchema(CognitionSituationSchema, value), allocation };
  }
  for (const field of ["episodes", "claims"] as const) {
    const chosen =
      field === "episodes" ? allocation.episodeIds : allocation.claimIds;
    for (const child of database
      .prepare(
        `SELECT CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value ELSE NULL END AS value, length(CAST(value AS BLOB)) AS size, CAST(child.key AS INTEGER) AS ordinal FROM cognition_situations s, json_each(s.payload_json, ?) child
      WHERE s.id = ? AND json_extract(child.value,'$.id') NOT IN (SELECT value FROM json_each(?)) ORDER BY CAST(child.key AS INTEGER) DESC`,
      )
      .iterate(maxBytes, `$.${field}`, id, JSON.stringify(chosen)) as Iterable<{
      value: string | null;
      size: number;
      ordinal: number;
    }>) {
      if (
        child.value === null ||
        child.size > maxBytes - bytes(value) - bytes(allocation)
      )
        break;
      const entry = JSON.parse(
        child.value,
      ) as CognitionSituation[typeof field][number];
      (value[field] as (typeof entry)[]).push(entry);
      const ids =
        field === "episodes" ? allocation.episodeIds : allocation.claimIds;
      ids.push(entry.id);
      positions[field].set(entry.id, child.ordinal);
      if (!fits()) {
        value[field].pop();
        ids.pop();
        break;
      }
    }
    value[field].sort(
      (a, b) => positions[field].get(a.id)! - positions[field].get(b.id)!,
    );
  }
  return {
    value: parseSchema(CognitionSituationSchema, value),
    allocation,
    ...(preferred ? { referenceGap } : {}),
  };
}

export function readIntentView(
  database: Database.Database,
  id: string,
  maxBytes: number,
  minimal: boolean,
  conversation?: ConversationReadBudget,
): { value: CognitionIntent; allocation?: IntentAllocation } | undefined {
  const full = database
    .prepare(
      `SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= ? THEN payload_json ELSE NULL END AS payload_json FROM cognition_intents WHERE id = ?`,
    )
    .get(Math.min(maxBytes, conversation?.remaining() ?? maxBytes), id) as
    { payload_json: string | null } | undefined;
  if (!full) return undefined;
  if (full.payload_json && !minimal) {
    conversation?.record(full.payload_json);
    return {
      value: parseSchema(CognitionIntentSchema, JSON.parse(full.payload_json)),
    };
  }
  const baseSql = `SELECT json_remove(payload_json, '$.evidenceIds', '$.effectEvidenceIds', ${intentFields.map(() => "?").join(",")}) AS payload_json FROM cognition_intents WHERE id = ?`;
  const row = database
    .prepare(
      conversation
        ? `SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= ? THEN payload_json ELSE NULL END AS payload_json FROM (${baseSql})`
        : baseSql,
    )
    .get(
      ...(conversation ? [conversation.remaining()] : []),
      ...intentFields.map((key) => `$.${key}`),
      id,
    ) as { payload_json: string | null };
  if (row.payload_json === null) return undefined;
  conversation?.record(row.payload_json);
  const value = {
    ...JSON.parse(row.payload_json),
    goal: "[PARTIAL INTENT: canonical fields preserved]",
    successCriteria: [],
    blockers: [],
    resumeConditions: [],
    progress: "",
    evidenceIds: [],
    effectEvidenceIds: [],
  } as CognitionIntent;
  const allocation: IntentAllocation = {
    id,
    evidenceIds: [],
    effectEvidenceIds: [],
    preservedFields: [...intentFields],
  };
  const fits = (): boolean => bytes(value) + bytes(allocation) <= maxBytes;
  if (!fits()) return undefined;
  for (const field of minimal
    ? (["goal", "blockers"] as const)
    : intentFields) {
    const content = readField(
      database,
      "cognition_intents",
      id,
      field,
      Math.max(0, maxBytes - bytes(value) - bytes(allocation)),
      conversation,
    );
    if (content === undefined) continue;
    if (field === "completion" && content === null) {
      allocation.preservedFields = allocation.preservedFields.filter(
        (key) => key !== field,
      );
      continue;
    }
    const previous = (value as unknown as Record<string, unknown>)[field];
    (value as unknown as Record<string, unknown>)[field] = content;
    if (!fits())
      (value as unknown as Record<string, unknown>)[field] = previous;
    else
      allocation.preservedFields = allocation.preservedFields.filter(
        (key) => key !== field,
      );
  }
  if (conversation) {
    for (const field of ["evidenceIds", "effectEvidenceIds"] as const) {
      const ids = readField(
        database,
        "cognition_intents",
        id,
        field,
        Math.max(0, maxBytes - bytes(value) - bytes(allocation)),
        conversation,
      );
      if (ids !== undefined) {
        value[field] = ids as string[];
        allocation[field] = [...value[field]];
      }
    }
    return { value: parseSchema(CognitionIntentSchema, value), allocation };
  }
  if (!minimal)
    for (const field of ["evidenceIds", "effectEvidenceIds"] as const) {
      for (const row of database
        .prepare(
          `SELECT value FROM cognition_intents i, json_each(i.payload_json, ?) WHERE i.id = ? ORDER BY CAST(key AS INTEGER) DESC`,
        )
        .iterate(`$.${field}`, id) as Iterable<{ value: string }>) {
        value[field].push(row.value);
        allocation[field].push(row.value);
        if (!fits()) {
          value[field].pop();
          allocation[field].pop();
          break;
        }
      }
      value[field].reverse();
    }
  return { value: parseSchema(CognitionIntentSchema, value), allocation };
}
