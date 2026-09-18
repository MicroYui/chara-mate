import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import {
  CognitionSituationSchema,
  CognitionSnapshotSchema,
} from "../../shared/schemas/cognition";
import { parseSchema } from "../../shared/schemas/validation";
import { CognitionRepository } from "./cognitionRepository";
import {
  latestSelectedContextIntent,
  projectCognitionContext,
  selectAnalysisSnapshot,
} from "./cognitionProjection";
import {
  INCOMPLETE_RECEIPT,
  readEvidence,
  readEvidenceMetadata,
} from "./cognitionSnapshotReader";
import { readPassiveSpan } from "./cognitionPassiveSpans";
import type { CognitionSituation } from "./cognitionTypes";

const personaId = "11111111-1111-4111-8111-111111111111";
const otherPersonaId = "22222222-2222-4222-8222-222222222222";
const now = "2026-09-17T00:00:00.000Z";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(CURRENT_SCHEMA_SQL);
  for (const id of [personaId, otherPersonaId])
    db.prepare(
      "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES(?,'custom',1,?,?)",
    ).run(id, now, now);
  const repo = new CognitionRepository(db, { readBudgetBytes: 32_768 });
  const source = (text: string, owner = personaId) =>
    repo.ingest(
      {
        id: randomUUID(),
        personaId: owner,
        actor: "user",
        kind: "utterance",
        source: { kind: "run", id: randomUUID() },
        observedAt: now,
        text,
      },
      now,
    ).evidence;
  // This read fixture owns canonical semantic rows; formation/commit validation
  // remains covered by the existing repository integration cases.
  const save = (value: CognitionSituation) => {
    parseSchema(CognitionSituationSchema, value);
    db.prepare(
      `INSERT INTO cognition_situations
      (id,persona_id,revision,status,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      revision=excluded.revision,status=excluded.status,payload_json=excluded.payload_json`,
    ).run(
      value.id,
      value.personaId,
      value.revision,
      value.status,
      JSON.stringify(value),
      now,
      now,
    );
    return value;
  };
  const situation = (title: string, owner = personaId): CognitionSituation => ({
    id: randomUUID(),
    personaId: owner,
    revision: 1,
    status: "current",
    title,
    summary: title,
    objectRefs: [],
    episodes: [],
    claims: [],
    unresolved: [],
    relatedSituationIds: [],
    createdAt: now,
    updatedAt: now,
  });
  const focus = (id: string) =>
    repo.updateAttention(personaId, now, (state) => ({
      ...state,
      currentSituationId: id,
    }));
  const read = (maxReadBytes = 16 * 1024 * 1024) =>
    repo.readConversationContext(
      personaId,
      now,
      { maxReadBytes },
      new AbortController().signal,
    );
  return { db, repo, source, save, situation, focus, read };
}

describe("ordinary committed Cognition read", () => {
  it("keeps a genuinely retired body distinct from missing and unread originals in current and one-hop claims", () => {
    const f = fixture();
    const retired = f.source("已退休的原文不得重新回放");
    const relatedRetired = f.source("关联事项的旧原文也已退休");
    const foreignRetired = f.source("另一 Persona 的旧原文", otherPersonaId);
    // Fixture-owned review state makes these unreferenced originals legally
    // reclaimable. Retirement itself uses the actual atomic Repository owner.
    for (const owner of [personaId, otherPersonaId])
      f.repo.updateAttention(owner, now, (state) => ({
        ...state,
        catalogueReviewedThroughSequence: state.lastReceiptSequence,
      }));
    for (const source of [retired, relatedRetired, foreignRetired]) {
      expect(f.repo.releaseEvidenceBody(source.id, now)).toBeDefined();
      expect(readEvidence(f.db, source.id, 16 * 1024 * 1024)).toBeUndefined();
      expect(readEvidenceMetadata(f.db, source.id)).toMatchObject({
        id: source.id,
        source: source.source,
        receiptSequence: source.receiptSequence,
        bodyReleasedAt: now,
      });
    }
    const small = f.source("当前尚可读取的完整原文");
    const large = f.source("存在但资源未读的原文".repeat(10_000));
    const missing = randomUUID();
    const current = f.situation("已提交当前事项");
    const related = f.situation("直接关联的历史事项");
    related.status = "closed";
    current.relatedSituationIds = [related.id];
    current.claims = [
      {
        id: "prior",
        text: "原先解释仍可见，原文不再可读",
        basis: "reported",
        state: "superseded",
        evidenceIds: [retired.id, small.id, missing, foreignRetired.id],
        contradictingEvidenceIds: [large.id],
      },
    ];
    related.claims = [
      {
        id: "related-prior",
        text: "保留关联历史解释",
        basis: "reported",
        state: "superseded",
        evidenceIds: [relatedRetired.id],
        contradictingEvidenceIds: [],
      },
    ];
    f.save(current);
    f.save(related);
    f.focus(current.id);
    const attention = f.repo.getAttention(personaId, now);
    const read = f.read(bytes(current) + bytes(related) + bytes(small));
    const context = projectCognitionContext(read.snapshot, 100_000, read);
    expect(read.coverage.releasedEvidenceIds).toEqual([
      retired.id,
      relatedRetired.id,
    ]);
    expect(read.coverage.missing.evidenceIds).toEqual([
      missing,
      foreignRetired.id,
    ]);
    expect(read.coverage.omittedForResource.evidenceIds).toEqual([large.id]);
    expect(read.snapshot.evidence).toEqual([small]);
    expect(read.readCost).toEqual({
      rawValueBytes: bytes(current) + bytes(related) + bytes(small),
      rowCount: 3,
    });
    expect(context.evidenceIds).toEqual([small.id]);
    for (const source of [retired, relatedRetired]) {
      expect(context.text).toContain(
        JSON.stringify({ evidenceGap: { id: source.id, reason: "released" } }),
      );
      expect(context.text).not.toContain(source.text);
    }
    expect(context.text).toContain('"releasedEvidence":2');
    expect(context.text).toContain('"released":true');
    expect(context.text).toContain(
      JSON.stringify({
        evidenceGap: { id: large.id, reason: "unloaded_for_resource" },
      }),
    );
    expect(context.text).toContain(
      JSON.stringify({
        evidenceGap: { id: foreignRetired.id, reason: "missing" },
      }),
    );
    expect(f.repo.getAttention(personaId, now)).toEqual(attention);
    expect(f.repo.getSituation(current.id)).toEqual(current);
  });

  it("keeps catalogue fields out of the bounded lifecycle view without granting selected authority", () => {
    const f = fixture();
    f.source("这是真实已接收的小来源");
    const first = f.repo.readSnapshot(personaId, now, 32_768);
    const attempt = f.repo.createAttempt(
      first,
      "semantic_change",
      now,
      first.coverage.allocation,
      now,
      first.coverage.sourceCoverage,
    );
    const failed = f.repo.saveAttempt({
      ...attempt,
      status: "failed",
      error: "实际持久失败反馈",
      decision: {
        choices: [
          {
            id: "quiet",
            kind: "remain_quiet",
            evidenceIds: [],
            rationale: "等待",
            userImpact: "none",
            executionScope: "none",
            reversibility: "read_only",
            timing: "now",
            resumeConditions: [],
          },
        ],
        selectedChoiceId: "quiet",
        selectedBasis: {
          choiceId: "quiet",
          evidenceUses: [],
          currentClaimRefs: [],
        },
        reason: "大型原决策".repeat(10_000),
      },
    });
    expect(failed.sourceCoverage?.entries.length).toBeGreaterThan(0);
    const read = f.repo.readSnapshot(personaId, now, 16_384);
    parseSchema(CognitionSnapshotSchema, read.snapshot);
    expect(read.snapshot.recentAttempts[0]).toMatchObject({
      projection: "lifecycle",
      id: failed.id,
      error: failed.error,
    });
    expect(read.snapshot.recentAttempts[0]).not.toHaveProperty(
      "sourceCoverage",
    );
    expect(read.snapshot.recentAttempts[0]).not.toHaveProperty("decision");
    expect(latestSelectedContextIntent(read.snapshot)).toBeUndefined();
    expect(f.repo.getAttempt(failed.id)).toMatchObject({
      sourceCoverage: failed.sourceCoverage,
      decision: failed.decision,
    });
  });

  it("keeps actual Unicode range coverage when a reserved current user source is narrowed a second time", () => {
    const f = fixture();
    const old = f.source("旧消息");
    const user = f.source("🙂请保留实际条件。".repeat(7000));
    const read = f.repo.readSnapshot(personaId, now, 32_768);
    const supplied = read.coverage.sourceCoverage!.supplied.find(
      ({ evidenceId }) => evidenceId === user.id,
    )!;
    const selected = selectAnalysisSnapshot(read.snapshot, 8192, read.coverage);
    const range = selected.coverage.sourceCoverage!.supplied.find(
      ({ evidenceId }) => evidenceId === user.id,
    )!.textRange!;
    const projected = selected.snapshot.evidence.find(
      ({ id }) => id === user.id,
    )!;
    expect(selected.coverage.currentUserSource).toMatchObject({
      evidenceId: user.id,
      status: "excerpted",
    });
    expect(range.startCharacter).toBe(supplied.textRange!.startCharacter);
    expect(range.endCharacter).toBeLessThan(supplied.textRange!.endCharacter);
    const exact = Array.from(user.text!)
      .slice(range.startCharacter, range.endCharacter)
      .join("");
    expect(projected.text?.startsWith(exact + "\n[INCOMPLETE EXCERPT:")).toBe(
      true,
    );
    if (!read.snapshot.evidence.some(({ id }) => id === old.id))
      expect(selected.snapshot.attention.lastReceiptSequence).toBeLessThan(
        old.receiptSequence,
      );
    expect(selected.snapshot.attention.lastReceiptSequence).toBeLessThanOrEqual(
      read.snapshot.attention.lastReceiptSequence,
    );
    expect(bytes(selected)).toBeLessThanOrEqual(8192);
  });

  it("never reclassifies a retired semantic interaction as an originally empty passive receipt", () => {
    const f = fixture();
    const publish = (text?: string) => {
      const id = randomUUID();
      return f.repo.ingest(
        {
          id,
          personaId,
          actor: "unknown",
          kind: "observation",
          source: { kind: "activity", id },
          boundary: "interaction",
          observedAt: now,
          interaction: { clicks: 0, keystrokes: 1000, scrolls: 0 },
          ...(text ? { text } : {}),
        },
        now,
      ).evidence;
    };
    const genuinelyEmpty = publish();
    f.repo.consumePassivePrefix(personaId, now);
    expect(f.repo.getAttention(personaId, now).analyzedThroughSequence).toBe(
      genuinelyEmpty.receiptSequence,
    );
    const semantic = publish("当时真实可见的正文，不是空计数");
    const laterEmpty = publish();
    f.repo.updateAttention(personaId, now, (state) => ({
      ...state,
      catalogueReviewedThroughSequence: state.lastReceiptSequence,
    }));
    expect(f.repo.releaseEvidenceBody(semantic.id, now)).toBeDefined();
    f.repo.consumePassivePrefix(personaId, now);
    const attention = f.repo.getAttention(personaId, now);
    expect(attention.analyzedThroughSequence).toBe(
      genuinelyEmpty.receiptSequence,
    );
    expect(attention.catalogueReviewedThroughSequence).toBe(
      laterEmpty.receiptSequence,
    );
    expect(
      readPassiveSpan(
        f.db,
        personaId,
        semantic.receiptSequence,
        laterEmpty.receiptSequence,
      ),
    ).toBeUndefined();
    expect(
      readPassiveSpan(
        f.db,
        personaId,
        genuinelyEmpty.receiptSequence,
        laterEmpty.receiptSequence,
      ),
    ).toMatchObject({
      throughSequence: genuinelyEmpty.receiptSequence,
      eventCount: 1,
      interaction: { keystrokes: 1000 },
    });
    expect(
      readPassiveSpan(
        f.db,
        personaId,
        laterEmpty.receiptSequence,
        laterEmpty.receiptSequence,
      ),
    ).toMatchObject({
      throughSequence: laterEmpty.receiptSequence,
      eventCount: 1,
      interaction: { keystrokes: 1000 },
    });
  });

  it("restores the original retained fragment and range after late Reader expansion cannot fit", () => {
    const f = fixture();
    const publish = (text: string) => {
      const id = randomUUID();
      return f.repo.ingest(
        {
          id,
          personaId,
          actor: "unknown",
          kind: "observation",
          source: { kind: "activity", id },
          boundary: "content",
          observedAt: now,
          text,
        },
        now,
      ).evidence;
    };
    const retained = publish("🙂之前已读的较长原文。".repeat(3000));
    const support = publish("🪴当前Claim的真实支持正文。".repeat(3000));
    const current = f.situation("限定页内的当前事项");
    current.claims = [
      {
        id: "support",
        text: "保留当前依据",
        basis: "observed",
        state: "supported",
        evidenceIds: [support.id],
        contradictingEvidenceIds: [],
      },
    ];
    f.save(current);
    f.focus(current.id);
    f.repo.updateAttention(personaId, now, (state) => ({
      ...state,
      analyzedThroughSequence: state.lastReceiptSequence,
      catalogueReviewedThroughSequence: state.lastReceiptSequence,
    }));
    // Reader first reserves retained metadata, then the requested current Claim
    // and actual large support. The late expansion must restore the earlier
    // metadata-only fragment if its added text/range framing no longer fits.
    const read = f.repo.readSnapshot(
      personaId,
      now,
      8192,
      {
        situationIds: [current.id],
        intentIds: [],
        situationChildren: [
          { situationId: current.id, claimIds: ["support"], episodeIds: [] },
        ],
        missingReferenceCount: 0,
        truncated: false,
      },
      [retained.id],
    );
    expect(read.snapshot.situations[0]?.claims.map(({ id }) => id)).toContain(
      "support",
    );
    expect(
      read.snapshot.evidence.find(({ id }) => id === support.id)?.text,
    ).toContain("当前Claim的真实支持正文");
    expect(
      read.snapshot.evidence.find(({ id }) => id === retained.id)?.text,
    ).toBe(INCOMPLETE_RECEIPT);
    expect(
      read.coverage.sourceCoverage!.supplied.find(
        ({ evidenceId }) => evidenceId === retained.id,
      ),
    ).toEqual({
      evidenceId: retained.id,
      receiptSequence: retained.receiptSequence,
      status: "excerpted",
    });
    expect(read.coverage.excerptedEvidenceIds).toContain(retained.id);
    expect(bytes(read)).toBeLessThanOrEqual(8192);
    expect(
      readEvidence(f.db, retained.id, 16 * 1024 * 1024)?.evidence.text,
    ).toBe(retained.text);
  });

  it("reads constraints, withdrawal and opposing sources despite an unread journal and large unprojected Episodes", () => {
    const f = fixture();
    const original = f.source("当前事项：只保存本地，不发给别人。");
    const withdrawal = f.source("刚才说可以发送已经撤回，现在不要发送。");
    const opposing = f.source("导出尚未成功，不能把保存回执当成导出完成。");
    const current = f.situation("核对当前导出");
    current.claims = [
      {
        id: "local-only",
        text: "只保存在本地",
        basis: "reported",
        state: "supported",
        evidenceIds: [original.id],
        contradictingEvidenceIds: [],
      },
      {
        id: "send",
        text: "原发送许可已撤回",
        basis: "reported",
        state: "superseded",
        evidenceIds: [original.id],
        contradictingEvidenceIds: [withdrawal.id],
      },
      {
        id: "export",
        text: "导出是否完成有反证",
        basis: "observed",
        state: "disputed",
        evidenceIds: [original.id],
        contradictingEvidenceIds: [opposing.id],
      },
    ];
    current.episodes = [
      {
        id: "old",
        label: "旧历史".repeat(40_000),
        state: "closed",
        startedAt: now,
        endedAt: now,
        evidenceIds: [original.id],
        objectKeys: [],
        boundaryReason: "已结束",
      },
    ];
    f.save(current);
    f.focus(current.id);
    for (let index = 0; index < 64; index++)
      f.source(`尚未分析的背景${index}:` + "原始页面".repeat(3000));
    const before = f.repo.getAttention(personaId, now);
    const read = f.read();
    const context = projectCognitionContext(read.snapshot, 200_000, read);
    expect(read.snapshot.situations[0]?.claims).toEqual(current.claims);
    expect(read.snapshot.situations[0]?.episodes).toEqual([]);
    expect(context.evidenceIds).toEqual([
      original.id,
      withdrawal.id,
      opposing.id,
    ]);
    expect(context.text).toContain(withdrawal.text);
    expect(context.text).toContain(opposing.text);
    expect(context.text).toContain('"state":"superseded"');
    expect(context.text).not.toContain("尚未分析的背景");
    expect(context.text).not.toContain("旧历史旧历史");
    expect(context.text).toContain("Newer observations await interpretation");
    expect(read.receivedThroughSequence).toBe(before.lastReceiptSequence);
    expect(read.snapshot.attention).toEqual(before);
    expect(f.repo.getAttention(personaId, now)).toEqual(before);
    expect(read.readCost).toEqual({
      rawValueBytes:
        bytes({ ...current, episodes: [] }) +
        bytes(original) +
        bytes(withdrawal) +
        bytes(opposing),
      rowCount: 4,
    });
    expect(f.repo.getSituation(current.id)).toEqual(current);
  });

  it("reads current and committed roots plus one hop, never unrelated tasks, a second hop or another Persona", () => {
    const f = fixture();
    const current = f.situation("当前事项");
    const related = f.situation("直接相关的已结束事项");
    related.status = "closed";
    const distant = f.situation("第二跳不得自动进入");
    const other = f.situation("另一Persona", otherPersonaId);
    const committedSituation = f.situation("当前承诺所属事项");
    const missing = randomUUID();
    current.relatedSituationIds = [related.id, other.id, missing];
    related.relatedSituationIds = [distant.id];
    [current, related, distant, other, committedSituation].forEach(f.save);
    f.focus(current.id);
    const source = f.source("承诺的原话");
    const intent = f.repo.saveIntent({
      id: randomUUID(),
      personaId,
      revision: 1,
      owner: "user",
      basis: "explicit_user",
      status: "suspended",
      goal: "明确保留的承诺",
      situationId: committedSituation.id,
      successCriteria: [],
      evidenceIds: [source.id],
      effectEvidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress: "等待继续",
      createdAt: now,
      updatedAt: now,
    });
    const anchored = f.repo.saveIntent({
      ...intent,
      id: randomUUID(),
      status: "active",
      situationId: current.id,
    });
    const unrelated = f.repo.saveIntent({
      ...intent,
      id: randomUUID(),
      situationId: distant.id,
    });
    const foreign = f.repo.saveIntent({
      ...intent,
      id: randomUUID(),
      personaId: otherPersonaId,
      situationId: current.id,
    });
    f.repo.updateAttention(personaId, now, (state) => ({
      ...state,
      committedIntentId: intent.id,
    }));
    const read = f.read();
    const context = projectCognitionContext(read.snapshot, 100_000, read);
    expect(context.situationIds).toEqual([
      current.id,
      committedSituation.id,
      related.id,
    ]);
    expect(context.intentIds).toEqual([intent.id, anchored.id]);
    expect(read.snapshot.intents.map(({ id }) => id)).not.toContain(foreign.id);
    expect(read.snapshot.situations.map(({ id }) => id)).not.toContain(
      distant.id,
    );
    expect(read.snapshot.intents.map(({ id }) => id)).not.toContain(
      unrelated.id,
    );
    expect(context.text).not.toContain(other.title);
    // Missing means absent in this Persona's readable domain, not globally absent.
    expect(read.coverage.missing.situationIds).toEqual([other.id, missing]);
    expect(read.coverage.omittedForResource.situationIds).toEqual([]);
    expect(context.text).toContain('"missing":true');
    expect(context.text).toContain('"unloaded":false');
  });

  it("distinguishes a missing original from a present original too large for raw reading", () => {
    const f = fixture();
    const small = f.source("真实小来源");
    const large = f.source("大原文".repeat(10_000));
    const missing = randomUUID();
    const current = f.situation("来源可见范围");
    current.claims = [
      {
        id: "bounded",
        text: "已提交的小事实",
        basis: "reported",
        state: "disputed",
        evidenceIds: [small.id, missing],
        contradictingEvidenceIds: [large.id],
      },
    ];
    f.save(current);
    f.focus(current.id);
    const read = f.read(bytes(current) + bytes(small));
    const context = projectCognitionContext(read.snapshot, 100_000, read);
    expect(read.coverage.missing.evidenceIds).toEqual([missing]);
    expect(read.coverage.omittedForResource.evidenceIds).toEqual([large.id]);
    expect(read.snapshot.evidence.map(({ id }) => id)).toEqual([small.id]);
    expect(read.readCost).toEqual({
      rawValueBytes: bytes(current) + bytes(small),
      rowCount: 2,
    });
    expect(context.text).toContain(
      JSON.stringify({ evidenceGap: { id: missing, reason: "missing" } }),
    );
    expect(context.text).toContain(
      JSON.stringify({
        evidenceGap: { id: large.id, reason: "unloaded_for_resource" },
      }),
    );
    expect(
      f.db
        .prepare(
          "SELECT json_extract(payload_json,'$.text') AS text FROM cognition_evidence WHERE id=?",
        )
        .get(large.id),
    ).toEqual({ text: large.text });
  });

  it("does not turn unloaded canonical fields into empty facts or false missing related state", () => {
    const f = fixture();
    const current = f.situation("小标题仍可读取");
    const related = f.situation("真实存在但未读");
    current.summary = "超长摘要".repeat(10_000);
    current.claims = [
      {
        id: "large",
        text: "长断言".repeat(10_000),
        basis: "reported",
        state: "supported",
        evidenceIds: [],
        contradictingEvidenceIds: [],
      },
    ];
    current.relatedSituationIds = [related.id];
    related.title = "巨大关联标题".repeat(10_000);
    related.summary = "巨大关联摘要".repeat(10_000);
    f.save(current);
    f.save(related);
    f.focus(current.id);
    const read = f.read(2048);
    const context = projectCognitionContext(read.snapshot, 100_000, read);
    expect(
      read.coverage.allocation.situations.find(({ id }) => id === current.id)
        ?.preservedFields,
    ).toContain("summary");
    expect(read.coverage.incompleteSituationClaims).toContain(current.id);
    const lines = context.text
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const value = lines.find(
      (line) =>
        (line["situation"] as { id: string } | undefined)?.id === current.id,
    )!;
    expect(value["situation"]).not.toHaveProperty("summary");
    expect(value["situation"]).not.toHaveProperty("claims");
    expect(value["visibility"]).toMatchObject({
      claimsComplete: false,
      unloadedFields: expect.arrayContaining(["summary"]) as unknown,
    });
    expect(read.coverage.missing.situationIds).toEqual([]);
    // A related body may be partial or entirely omitted; neither is missing.
    expect(context.text).toContain('"missing":false');
    expect(read.readCost.rawValueBytes).toBeLessThanOrEqual(2048);
  });

  it("passes explicit SQL-page coverage and the actual received boundary to projection", () => {
    const f = fixture();
    const current = f.situation("已提交事项");
    current.summary = "大摘要".repeat(2000);
    current.claims = [
      {
        id: "long",
        text: "不可假装空集合".repeat(2000),
        basis: "reported",
        state: "supported",
        evidenceIds: [],
        contradictingEvidenceIds: [],
      },
    ];
    f.save(current);
    f.focus(current.id);
    for (let index = 0; index < 4; index++)
      f.source(
        index === 3 ? "当前简短输入" : `${index}:` + "很大的原文".repeat(4000),
      );
    const read = f.repo.readSnapshot(personaId, now, 8192);
    const context = projectCognitionContext(read.snapshot, 20_000, read);
    expect(read.coverage.allocation?.situations).toHaveLength(1);
    expect(read.receivedThroughSequence).toBeGreaterThan(
      read.snapshot.attention.lastReceiptSequence,
    );
    expect(context.text).toContain('"boundedAnalysisView":true');
    expect(context.text).toContain('"claimsComplete":false');
    expect(context.text).toContain("Newer observations await interpretation");
  });

  it("reports a whole unread core and a model-token omission separately from a missing entity", () => {
    const f = fixture();
    const current = f.save(f.situation("真实核心"));
    f.focus(current.id);
    const unread = f.read(1);
    expect(unread.snapshot.situations).toEqual([]);
    expect(unread.coverage.omittedForResource.situationIds).toEqual([
      current.id,
    ]);
    expect(unread.coverage.missing.situationIds).toEqual([]);
    expect(
      projectCognitionContext(unread.snapshot, 10_000, unread).text,
    ).toContain(
      '"omittedForResource":{"situations":1,"intents":0,"evidence":0}',
    );
    const source = f.source(
      "来源虽已物理读取，但可能超出模型投影。".repeat(2000),
    );
    current.claims = [
      {
        id: "source",
        text: "已提交的小结",
        basis: "reported",
        state: "supported",
        evidenceIds: [source.id],
        contradictingEvidenceIds: [],
      },
    ];
    f.save(current);
    const read = f.read();
    expect(read.coverage.omittedForResource.evidenceIds).toEqual([]);
    const context = projectCognitionContext(read.snapshot, 2000, read);
    expect(context.evidenceIds).not.toContain(source.id);
    expect(context.text).toContain('"omittedForTokens":true');
  });

  it("rejects an aborted read before querying and never initializes a missing state", () => {
    const f = fixture();
    const controller = new AbortController();
    const reason = new Error("User ended preparation");
    controller.abort(reason);
    const prepare = vi.spyOn(f.db, "prepare");
    expect(() =>
      f.repo.readConversationContext(
        personaId,
        now,
        { maxReadBytes: 1000 },
        controller.signal,
      ),
    ).toThrow(reason);
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    const read = f.read();
    expect(read.snapshot.attention).toMatchObject({
      revision: 0,
      lastReceiptSequence: 0,
    });
    expect(read.readCost).toEqual({ rawValueBytes: 0, rowCount: 0 });
    expect(f.repo.listPersonaIds()).toEqual([]);
  });
});
