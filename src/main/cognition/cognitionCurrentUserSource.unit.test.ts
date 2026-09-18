import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";
import { CognitionService } from "./cognitionService";
import { selectAnalysisSnapshot } from "./cognitionProjection";
import { INCOMPLETE_RECEIPT, readEvidence } from "./cognitionSnapshotReader";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
  CognitionEvidenceInput,
} from "./cognitionTypes";
import type { EvidencePack } from "../../shared/contracts/memoryRecall";

const personaId = "11111111-1111-4111-8111-111111111111";
const otherPersonaId = "22222222-2222-4222-8222-222222222222";
const databases: Database.Database[] = [];
const services: CognitionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
  databases.splice(0).forEach((d) => d.close());
});
const emptyPack: EvidencePack = {
  items: [],
  coverage: [],
  gaps: [],
  estimatedTokens: 0,
  truncated: false,
  incompleteReasons: [],
};
function quiet(ids: string[] = []): CognitionAnalysis {
  return {
    delta: {
      createSituations: [],
      updateSituations: [],
      createIntents: [],
      updateIntents: [],
      attention: {},
    },
    decision: {
      choices: [
        {
          id: "quiet",
          kind: "remain_quiet",
          evidenceIds: ids,
          rationale: "仅保留实际原话，等待未读来源",
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
        evidenceUses: ids.map((evidenceId) => ({ evidenceId, use: "history" })),
        currentClaimRefs: [],
      },
      reason: "未声称执行世界动作",
    },
  };
}
function fixture() {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(CURRENT_SCHEMA_SQL);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 16, 8, 0, tick++)).toISOString();
  for (const id of [personaId, otherPersonaId])
    database
      .prepare(
        "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
      )
      .run(id, now(), now());
  const repository = new CognitionRepository(database, {
    readBudgetBytes: 6000,
  });
  const input = (
    text: string,
    override: Partial<CognitionEvidenceInput> = {},
  ): CognitionEvidenceInput => ({
    id: randomUUID(),
    personaId,
    actor: "user",
    kind: "observation",
    source: { kind: "activity", id: randomUUID() },
    observedAt: now(),
    text,
    ...override,
  });
  const insert = (
    text: string,
    override: Partial<CognitionEvidenceInput> = {},
  ) => repository.ingest(input(text, override), now()).evidence;
  const user = (text: string, override: Partial<CognitionEvidenceInput> = {}) =>
    insert(text, {
      kind: "utterance",
      source: {
        kind: "run",
        id: randomUUID(),
        fragment: randomUUID(),
        revision: "completed",
      },
      ...override,
    });
  const backlog = () =>
    Array.from({ length: 20 }, (_, i) =>
      insert(`旧编辑来源 ${i}：${"候选，不代表已执行。".repeat(45)}`),
    );
  const commit = (
    read: ReturnType<CognitionRepository["readSnapshot"]>,
    analysis = quiet(),
  ) => {
    const attempt = repository.createAttempt(
      read,
      "semantic_change",
      now(),
      read.coverage.allocation,
      undefined,
      read.coverage.sourceCoverage,
    );
    repository.saveAttempt({ ...attempt, status: "analyzing" });
    const done = repository.commitAnalysis(attempt.id, analysis, now());
    repository.saveAttempt({ ...done, status: "settled", updatedAt: now() });
    return done;
  };
  const makeService = (
    analyze: (input: CognitionAnalysisInput) => Promise<CognitionAnalysis>,
    recall = () => Promise.resolve(emptyPack),
  ) => {
    const errors: unknown[] = [];
    const service = new CognitionService({
      repository,
      driver: { analyze },
      memory: {
        recall,
        resolveEvidence: () => ({
          status: "resolved",
          items: [],
          readCost: { rawValueBytes: 0, rowCount: 0 },
        }),
        validateEvidenceReferences: () => [],
      },
      runtime: {
        availability: () => ({
          userEngaged: false,
          activeUserRunIds: [],
          chatRuns: [],
          activeVoice: false,
          sleeping: false,
          hasOutstandingBubble: false,
          mayInitiateConversation: true,
          characterTools: [],
          mayActInTerritory: true,
        }),
        dispatch: () => Promise.reject(new Error("No dispatch expected")),
        yieldCharacterRun: () => Promise.resolve(),
        reconcileRun: () => ({ terminal: false, evidence: [] }),
      },
      clock: { now },
      activePersonaId: () => personaId,
      analysisReadBudgetBytes: 6000,
      analysisBudgetTokens: 32768,

      batchWindowMs: 0,
      onError: (e) => errors.push(e),
    });
    services.push(service);
    return { service, errors };
  };
  return {
    database,
    repository,
    now,
    input,
    insert,
    user,
    backlog,
    commit,
    makeService,
  };
}

describe("Current user source allocation", () => {
  it("supplies the real correction ahead of the old viewport page without advancing its FIFO watermark", () => {
    const f = fixture();
    const old = f.backlog();
    const user = f.user("南楼只是比选草稿，目前地点未定，不能记成订好了。");
    const read = f.repository.readSnapshot(personaId, f.now(), 6000);
    expect(read.snapshot.evidence.find(({ id }) => id === user.id)).toEqual(
      user,
    );
    expect(read.coverage.currentUserSource).toMatchObject({
      evidenceId: user.id,
      status: "complete",
    });
    expect(read.coverage.sourceCoverage?.entries[0]?.firstEvidenceId).toBe(
      old[0]!.id,
    );
    expect(read.snapshot.attention.lastReceiptSequence).toBeLessThan(
      user.receiptSequence,
    );
    expect(read.receivedThroughSequence).toBe(user.receiptSequence);
    expect(read.coverage.moreEvidencePending).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(
      6000,
    );
    const committed = f.commit(read, quiet([user.id]));
    expect(committed.dependencies.evidenceIds).toContain(user.id);
    expect(committed.dependencies.receivedThroughSequence).toBe(
      user.receiptSequence,
    );
    expect(
      f.repository.getAttention(personaId, f.now()).analyzedThroughSequence,
    ).toBe(read.snapshot.attention.lastReceiptSequence);
    expect(f.repository.actionFreshness(committed, f.now())).toEqual({
      current: true,
    });
  });

  it("rejects a same-generation utterance received after the snapshot but before attempt creation", () => {
    const f = fixture();
    f.backlog();
    const observedAt = f.now();
    const control = f.insert("用户已接管", {
      kind: "control",
      control: "user_engaged",
      source: { kind: "system", id: randomUUID() },
      observedAt,
    });
    const read = f.repository.readSnapshot(personaId, observedAt, 6000);
    const generation = read.snapshot.attention.userGeneration;
    expect(read.receivedThroughSequence).toBe(control.receiptSequence);
    const later = f.user("这个方案先停一下，最后一步由我来做。", {
      observedAt,
    });
    expect(
      f.repository.getAttention(personaId, observedAt).userGeneration,
    ).toBe(generation);
    expect(later.receiptSequence).toBeGreaterThan(read.receivedThroughSequence);
    const committed = f.commit(read);
    expect(committed.dependencies.receivedThroughSequence).toBe(
      control.receiptSequence,
    );
    expect(f.repository.actionFreshness(committed, observedAt)).toEqual({
      current: false,
      reason: "control_changed",
    });
    f.repository.saveAttempt({ ...committed, status: "ready" });
    expect(() =>
      f.database.transaction(() =>
        f.repository.bindDispatched(
          committed.dispatchKey,
          randomUUID(),
          observedAt,
        ),
      )(),
    ).toThrow("Dispatch dependencies changed before Run allocation");
    expect(f.repository.getAttempt(committed.id)?.runId).toBeUndefined();
    f.repository.saveAttempt({ ...committed, status: "superseded" });
    const nextRead = f.repository.readSnapshot(personaId, observedAt, 6000);
    expect(nextRead.coverage.currentUserSource?.evidenceId).toBe(later.id);
    const fresh = f.commit(nextRead, quiet([later.id]));
    const reopened = new CognitionRepository(f.database, {
      readBudgetBytes: 6000,
    });
    const restored = reopened.getAttempt(fresh.id)!;
    expect(restored.dependencies.receivedThroughSequence).toBe(
      later.receiptSequence,
    );
    expect(reopened.actionFreshness(restored, observedAt)).toEqual({
      current: true,
    });
    expect(
      reopened.getAttention(personaId, observedAt).analyzedThroughSequence,
    ).toBeLessThan(later.receiptSequence);
  });

  it("rejects a newly received user control and keeps other-persona utterances outside this receipt boundary", () => {
    const f = fixture();
    const initial = f.user("我现在先自己处理。");
    const read = f.repository.readSnapshot(personaId, f.now(), 6000);
    const committed = f.commit(read, quiet([initial.id]));
    f.user("另一个角色的新对话", { personaId: otherPersonaId });
    expect(f.repository.actionFreshness(committed, f.now())).toEqual({
      current: true,
    });
    f.insert("用户再次接管", {
      kind: "control",
      control: "user_engaged",
      source: { kind: "system", id: randomUUID() },
    });
    expect(f.repository.actionFreshness(committed, f.now())).toEqual({
      current: false,
      reason: "control_changed",
    });
  });

  it("prioritizes only the latest real user utterance, leaving older corrections in the ordinary FIFO", () => {
    const f = fixture();
    f.backlog();
    const earlier = f.user("周五版还不是最后确定。");
    const latest = f.user("以周一15点线上这一版为准，邀请还没发。");
    let read = f.repository.readSnapshot(personaId, f.now(), 6000);
    expect(read.coverage.currentUserSource?.evidenceId).toBe(latest.id);
    expect(read.snapshot.evidence.some(({ id }) => id === earlier.id)).toBe(
      false,
    );
    const newest = f.user("再补充，别自动代发，要等我确认。");
    read = f.repository.readSnapshot(personaId, f.now(), 6000);
    expect(read.coverage.currentUserSource?.evidenceId).toBe(newest.id);
    expect(
      read.snapshot.evidence.find(({ id }) => id === newest.id)?.text,
    ).toBe(newest.text);
    expect(read.snapshot.attention.lastReceiptSequence).toBeLessThan(
      earlier.receiptSequence,
    );
    const seen = new Set<string>();
    while (f.repository.hasReviewableInput(personaId)) {
      const page = f.repository.readSnapshot(personaId, f.now(), 6000);
      page.snapshot.evidence.forEach(({ id }) => seen.add(id));
      const before = page.coverage.sourceCoverage!.fromSequence;
      f.commit(page);
      expect(
        f.repository.getAttention(personaId, f.now())
          .catalogueReviewedThroughSequence,
      ).toBeGreaterThan(before);
    }
    expect([...seen]).toEqual(
      expect.arrayContaining([earlier.id, latest.id, newest.id]),
    );
    expect(readEvidence(f.database, earlier.id, 100000)?.evidence.text).toBe(
      earlier.text,
    );
  });

  it("does not treat screen quotations, agent utterances or another Persona's user message as this user's current source", () => {
    const f = fixture();
    f.backlog();
    const own = f.user("这是我的原话。");
    f.insert("采访引语：我已经预订了南楼。", {
      object: { key: "interview", identity: "adapter" },
    });
    f.user("助手复述，不能作为用户的新改口。", { actor: "agent" });
    const other = f.user("另一角色会话里的最新原话。", {
      personaId: otherPersonaId,
    });
    const read = f.repository.readSnapshot(personaId, f.now(), 6000);
    expect(read.coverage.currentUserSource).toMatchObject({
      evidenceId: own.id,
      status: "complete",
    });
    expect(read.snapshot.evidence.some(({ id }) => id === other.id)).toBe(
      false,
    );
    expect(
      f.repository.readSnapshot(otherPersonaId, f.now(), 6000).coverage
        .currentUserSource?.evidenceId,
    ).toBe(other.id);
  });

  it("uses receipt order for consecutive corrections with identical observed times", () => {
    const f = fixture();
    f.backlog();
    const observedAt = f.now();
    f.user("旧的：周五。", { observedAt });
    const newest = f.user("更正：周一。", { observedAt });
    expect(
      f.repository.readSnapshot(personaId, f.now(), 6000).coverage
        .currentUserSource?.evidenceId,
    ).toBe(newest.id);
  });

  it("does not renew a consumed user's raw body solely because it was previously exposed", () => {
    const f = fixture();
    const user = f.user("当前地点未定。");
    f.commit(f.repository.readSnapshot(personaId, f.now(), 6000));
    f.backlog();
    const read = f.repository.readSnapshot(personaId, f.now(), 6000);
    expect(read.coverage.currentUserSource).toBeUndefined();
    expect(read.snapshot.evidence.some(({ id }) => id === user.id)).toBe(false);
    expect(readEvidence(f.database, user.id, 1000000)?.evidence.text).toBe(
      user.text,
    );
  });

  it("keeps one source when the latest user is also the oldest unread receipt", () => {
    const f = fixture();
    const user = f.user("这就是当前的真实原话。");
    f.backlog();
    const read = f.repository.readSnapshot(personaId, f.now(), 6000);
    expect(read.snapshot.evidence.filter(({ id }) => id === user.id)).toEqual([
      user,
    ]);
    expect(read.coverage.currentUserSource?.status).toBe("complete");
    expect(read.snapshot.attention.lastReceiptSequence).toBeGreaterThanOrEqual(
      user.receiptSequence,
    );
  });

  it("marks a long Unicode source as an exact bounded excerpt and preserves the original", () => {
    const f = fixture();
    const first = f.insert("旧来源".repeat(500));
    const user = f.user("这是新原话🙂，不能把片段补成事实。".repeat(1500));
    const read = f.repository.readSnapshot(personaId, f.now(), 6000);
    const supplied = read.snapshot.evidence.find(({ id }) => id === user.id)!;
    expect(supplied.text).toContain(INCOMPLETE_RECEIPT);
    expect(
      user.text!.startsWith(
        supplied.text!.split("\n" + INCOMPLETE_RECEIPT)[0]!,
      ),
    ).toBe(true);
    expect(supplied.text).not.toContain("\uFFFD");
    expect(read.coverage.currentUserSource).toMatchObject({
      evidenceId: user.id,
      status: "excerpted",
    });
    expect(read.coverage.excerptedEvidenceIds).toContain(user.id);
    expect(read.coverage.sourceCoverage?.entries[0]?.firstEvidenceId).toBe(
      first.id,
    );
    expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(
      6000,
    );
    expect(readEvidence(f.database, user.id, 1000000)?.evidence.text).toBe(
      user.text,
    );
  });

  it("fails explicitly when its oldest and latest source identities cannot both fit", () => {
    const f = fixture();
    f.backlog();
    f.user("新原话");
    expect(() => f.repository.readSnapshot(personaId, f.now(), 1600)).toThrow(
      /allocation cannot hold/i,
    );
  });

  it("reports omission if completion has no copy of the indicated current source", () => {
    const f = fixture();
    f.backlog();
    const user = f.user("用户新原话。");
    const read = f.repository.readSnapshot(personaId, f.now(), 6000);
    const projected = selectAnalysisSnapshot(
      {
        ...read.snapshot,
        evidence: read.snapshot.evidence.filter(({ id }) => id !== user.id),
      },
      6000,
      read.coverage,
    );
    expect(projected.coverage.currentUserSource).toMatchObject({
      evidenceId: user.id,
      status: "omitted",
    });
    expect(read.coverage.currentUserSource?.status).toBe("complete");
  });

  it("passes the current user's exact source through actual Service preparation and recall completion", async () => {
    const f = fixture();
    f.backlog();
    const user = f.user("请核对以前的时间，但当前地点仍未定。");
    const captured: CognitionAnalysisInput[] = [];
    const analyze = vi.fn((input: CognitionAnalysisInput) => {
      captured.push(structuredClone(input));
      const result = quiet([user.id]);
      if (!input.evidencePack)
        result.recallPlan = {
          purpose: "initiative",
          query: "以前的时间",
          questions: [],
          contextBudget: { maxTokens: 1000 },
        };
      return Promise.resolve(result);
    });
    const h = f.makeService(analyze, () => {
      f.insert("检索期间到达的新窗口");
      return Promise.resolve(emptyPack);
    });
    h.service.ingest(f.input("触发真实Service"));
    await h.service.runDue(f.now());
    expect(h.errors).toEqual([]);
    expect(captured).toHaveLength(2);
    for (const input of captured) {
      expect(
        input.snapshot.evidence.find(({ id }) => id === user.id)?.text,
      ).toBe(user.text);
      expect(input.coverage?.currentUserSource).toMatchObject({
        evidenceId: user.id,
        status: "complete",
      });
      expect(input.attempt.dependencies.evidenceIds).toContain(user.id);
    }
    expect(captured[1]!.snapshot.attention.lastReceiptSequence).toBe(
      captured[0]!.snapshot.attention.lastReceiptSequence,
    );
    expect(captured[1]!.attempt.dependencies.receivedThroughSequence).toBe(
      captured[0]!.attempt.dependencies.receivedThroughSequence,
    );
    expect(f.repository.getAttempt(captured[0]!.attempt.id)).toMatchObject({
      status: "settled",
      outcome: "quiet",
    });
    expect(readEvidence(f.database, user.id, 1000000)?.evidence.text).toBe(
      user.text,
    );
  });

  it("keeps the original receipt boundary through recall when a same-generation user message arrives", async () => {
    const f = fixture();
    f.backlog();
    const user = f.user("先查以前的时间，当前地点还未定。");
    const captured: CognitionAnalysisInput[] = [];
    let late: ReturnType<typeof f.user> | undefined;
    const h = f.makeService(
      (input) => {
        captured.push(structuredClone(input));
        const result = quiet([user.id]);
        if (!input.evidencePack)
          result.recallPlan = {
            purpose: "initiative",
            query: "以前的时间",
            questions: [],
            contextBudget: { maxTokens: 1000 },
          };
        return Promise.resolve(result);
      },
      () => {
        late = f.user("我改主意了，先不要继续这个安排。");
        return Promise.resolve(emptyPack);
      },
    );
    h.service.ingest(f.input("触发当前检索"));
    await h.service.runDue(f.now());
    expect(h.errors).toEqual([]);
    expect(captured).toHaveLength(2);
    const initial = captured[0]!;
    const completion = captured[1]!;
    expect(late!.receiptSequence).toBeGreaterThan(
      initial.attempt.dependencies.receivedThroughSequence,
    );
    expect(completion.attempt.dependencies.userGeneration).toBe(
      initial.attempt.dependencies.userGeneration,
    );
    expect(completion.attempt.dependencies.receivedThroughSequence).toBe(
      initial.attempt.dependencies.receivedThroughSequence,
    );
    expect(completion.snapshot.evidence.some(({ id }) => id === late!.id)).toBe(
      false,
    );
    const done = f.repository.getAttempt(initial.attempt.id)!;
    expect(done).toMatchObject({ status: "superseded", outcome: "deferred" });
    expect(f.repository.actionFreshness(done, f.now())).toEqual({
      current: false,
      reason: "control_changed",
    });
    const nextRead = f.repository.readSnapshot(personaId, f.now(), 6000);
    expect(nextRead.coverage.currentUserSource?.evidenceId).toBe(late!.id);
    expect(nextRead.snapshot.attention.analyzedThroughSequence).toBeLessThan(
      late!.receiptSequence,
    );
  });

  it("keeps takeover cancellation and supplies the new utterance on the following analysis", async () => {
    const f = fixture();
    f.backlog();
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (value: CognitionAnalysis) => void;
    const captured: CognitionAnalysisInput[] = [];
    const analyze = vi.fn((input: CognitionAnalysisInput) => {
      captured.push(structuredClone(input));
      if (captured.length === 1) {
        started();
        return new Promise<CognitionAnalysis>((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve(quiet());
    });
    const h = f.makeService(analyze);
    h.service.ingest(f.input("原后台来源"));
    const running = h.service.runDue(f.now());
    await begun;
    await h.service.yieldToUser(personaId);
    const user = f.user("暂停之前的行动，地点尚未确定。");
    finish(quiet());
    await running;
    expect(f.repository.getAttempt(captured[0]!.attempt.id)?.status).toBe(
      "superseded",
    );
    await h.service.runDue(f.now());
    expect(captured).toHaveLength(2);
    expect(
      captured[1]!.snapshot.evidence.find(({ id }) => id === user.id)?.text,
    ).toBe(user.text);
    expect(captured[1]!.coverage?.currentUserSource?.evidenceId).toBe(user.id);
    expect(captured[1]!.snapshot.attention.lastReceiptSequence).toBeLessThan(
      user.receiptSequence,
    );
    expect(h.errors).toEqual([]);
  });

  it("restores pending current input after restart without resuming an obsolete recall call", () => {
    const f = fixture();
    f.backlog();
    const user = f.user("最新改口仍需处理。");
    const read = f.repository.readSnapshot(personaId, f.now(), 6000);
    const done = f.commit(read, quiet([user.id]));
    f.repository.saveAttempt({
      ...done,
      status: "awaiting_recall",
      recallPlan: {
        purpose: "initiative",
        query: "以前的约定",
        questions: [],
        contextBudget: { maxTokens: 1000 },
      },
    });
    const analyze = vi.fn(() => Promise.resolve(quiet()));
    const h = f.makeService(analyze);
    h.service.initialize();
    expect(f.repository.getAttempt(done.id)?.status).toBe("superseded");
    expect(analyze).not.toHaveBeenCalled();
    const restored = f.repository.readSnapshot(personaId, f.now(), 6000);
    expect(restored.coverage.currentUserSource).toMatchObject({
      evidenceId: user.id,
      status: "complete",
    });
    expect(
      restored.snapshot.evidence.find(({ id }) => id === user.id)?.text,
    ).toBe(user.text);
    expect(restored.snapshot.attention.analyzedThroughSequence).toBe(
      read.snapshot.attention.lastReceiptSequence,
    );
  });
});
