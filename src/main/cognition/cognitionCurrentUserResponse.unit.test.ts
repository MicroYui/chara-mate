import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
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
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  databases.splice(0).forEach((database) => database.close());
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
          rationale: "此前已实际回应，无需重复确认；不推断世界效果。",
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
      reason: "已回应仅指说话事实",
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
  const insert = (
    text: string,
    override: Partial<CognitionEvidenceInput> = {},
  ) =>
    repository.ingest(
      {
        id: randomUUID(),
        personaId,
        actor: "user",
        kind: "observation",
        source: { kind: "activity", id: randomUUID() },
        observedAt: now(),
        text,
        ...override,
      },
      now(),
    ).evidence;
  const runSource = (
    runId: string,
    fragment: string = randomUUID(),
    revision = "completed",
  ) => ({ kind: "run" as const, id: runId, fragment, revision });
  const user = (runId: string, text = "请区分本地保存与对外发送。") =>
    insert(text, { kind: "utterance", source: runSource(runId) });
  const reply = (
    runId: string,
    text = "我会区分保存、发送与送达；当前没有发送确认。",
    override: Partial<CognitionEvidenceInput> = {},
  ) =>
    insert(text, {
      actor: "agent",
      kind: "utterance",
      source: runSource(runId),
      ...override,
    });
  const terminal = (runId: string, revision = "completed") =>
    insert(`Run ${revision}；只表示本轮生命周期。`, {
      actor: "system",
      kind: "observation",
      source: runSource(runId, "terminal", revision),
    });
  const backlog = () =>
    Array.from({ length: 20 }, (_, i) =>
      insert(`旧窗口 ${i}: ${"仅草稿，不能推定发送。".repeat(50)}`),
    );
  const read = (maxBytes = 6000) =>
    repository.readSnapshot(personaId, now(), maxBytes);
  return {
    database,
    repository,
    now,
    insert,
    runSource,
    user,
    reply,
    terminal,
    backlog,
    read,
  };
}

describe("Current user and same-Run response allocation", () => {
  it("supplies a completed reply and terminal past the FIFO page with the real user source, without consuming the intervening backlog", () => {
    const f = fixture();
    const old = f.backlog();
    const runId = randomUUID();
    const user = f.user(runId);
    f.insert("夹在对话来源间的新窗口");
    const reply = f.reply(runId);
    const terminal = f.terminal(runId);
    const read = f.read();
    expect(read.coverage.currentUserSource).toEqual({
      evidenceId: user.id,
      status: "complete",
      runResponse: {
        runId,
        replyObserved: true,
        terminalObserved: true,
        evidenceIds: [reply.id, terminal.id],
        omittedForBudget: false,
      },
    });
    for (const source of [user, reply, terminal])
      expect(read.snapshot.evidence.find(({ id }) => id === source.id)).toEqual(
        source,
      );
    expect(read.coverage.sourceCoverage?.entries[0]?.firstEvidenceId).toBe(
      old[0]!.id,
    );
    expect(read.snapshot.attention.lastReceiptSequence).toBeLessThan(
      user.receiptSequence,
    );
    expect(read.coverage.moreEvidencePending).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(6000);
    const attempt = f.repository.createAttempt(
      read,
      "semantic_change",
      f.now(),
      read.coverage.allocation,
      undefined,
      read.coverage.sourceCoverage,
    );
    f.repository.saveAttempt({ ...attempt, status: "analyzing" });
    const done = f.repository.commitAnalysis(
      attempt.id,
      quiet([user.id, reply.id, terminal.id]),
      f.now(),
    );
    expect(done.dependencies.evidenceIds).toEqual(
      expect.arrayContaining([user.id, reply.id, terminal.id]),
    );
    expect(
      f.repository.getAttention(personaId, f.now()).analyzedThroughSequence,
    ).toBe(read.snapshot.attention.lastReceiptSequence);
    expect(f.repository.actionFreshness(done, f.now())).toEqual({
      current: true,
    });
  });

  it("does not supply another Run or Persona, a streaming utterance, or a Tool effect as the current Run reply", () => {
    const f = fixture();
    f.backlog();
    const runId = randomUUID();
    f.user(runId);
    const excluded = [
      f.reply(randomUUID()),
      f.reply(runId, "另一角色", { personaId: otherPersonaId }),
      f.reply(runId, "未完成片段", {
        source: f.runSource(runId, randomUUID(), "streaming"),
      }),
      f.insert("实际工具结果另有用途", {
        actor: "agent",
        kind: "effect",
        source: f.runSource(runId),
      }),
      f.insert("并非 terminal", {
        actor: "system",
        source: f.runSource(runId),
      }),
    ];
    const read = f.read();
    expect(read.coverage.currentUserSource?.runResponse).toEqual({
      runId,
      replyObserved: false,
      terminalObserved: false,
      evidenceIds: [],
      omittedForBudget: false,
    });
    for (const item of excluded)
      expect(read.snapshot.evidence.some(({ id }) => id === item.id)).toBe(
        false,
      );
  });

  it("keeps all fitting completed messages in order, excludes a pre-user message, and preserves a failed terminal without inventing a successful action", () => {
    const f = fixture();
    f.backlog();
    const runId = randomUUID();
    const prior = f.reply(runId, "早于当前原话");
    f.user(runId);
    const first = f.reply(runId, "第一条已完成回复");
    const second = f.reply(runId, "第二条已完成回复");
    const terminal = f.terminal(runId, "failed");
    const read = f.read(8000);
    expect(read.coverage.currentUserSource?.runResponse?.evidenceIds).toEqual([
      first.id,
      second.id,
      terminal.id,
    ]);
    expect(read.snapshot.evidence.some(({ id }) => id === prior.id)).toBe(
      false,
    );
    expect(read.snapshot.evidence.find(({ id }) => id === terminal.id)).toEqual(
      terminal,
    );
    expect(
      read.snapshot.evidence.filter(({ kind }) => kind === "effect"),
    ).toEqual([]);
  });

  it("reports absence of observed response for an in-flight Run and observes real completion only after it arrives", () => {
    const f = fixture();
    f.backlog();
    const runId = randomUUID();
    f.user(runId);
    expect(f.read().coverage.currentUserSource?.runResponse).toMatchObject({
      replyObserved: false,
      terminalObserved: false,
    });
    const reply = f.reply(runId);
    expect(f.read().coverage.currentUserSource?.runResponse).toMatchObject({
      replyObserved: true,
      terminalObserved: false,
      evidenceIds: [reply.id],
    });
    const terminal = f.terminal(runId);
    expect(f.read().coverage.currentUserSource?.runResponse).toMatchObject({
      replyObserved: true,
      terminalObserved: true,
      evidenceIds: [reply.id, terminal.id],
    });
  });

  it("reserves response identities before expanding a huge current user source, with honest excerpts and unchanged originals", () => {
    const f = fixture();
    f.backlog();
    const runId = randomUUID();
    const user = f.user(runId, "真实用户原话🙂。".repeat(5000));
    const reply = f.reply(runId, "实际已完成回复🙂。".repeat(5000));
    const terminal = f.terminal(runId);
    const read = f.read(6000);
    expect(read.coverage.currentUserSource).toMatchObject({
      status: "excerpted",
      runResponse: {
        evidenceIds: [reply.id, terminal.id],
        omittedForBudget: false,
      },
    });
    for (const source of [user, reply, terminal]) {
      const supplied = read.snapshot.evidence.find(
        ({ id }) => id === source.id,
      )!;
      expect(supplied).toBeDefined();
      if (read.coverage.excerptedEvidenceIds.includes(source.id))
        expect(supplied.text).toContain(INCOMPLETE_RECEIPT);
      expect(readEvidence(f.database, source.id, 1000000)?.evidence.text).toBe(
        source.text,
      );
    }
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(6000);
  });

  it("reports known response identities that cannot fit rather than spending past a low allocation", () => {
    const f = fixture();
    f.backlog();
    const runId = randomUUID();
    f.user(runId);
    const replies = Array.from({ length: 20 }, (_, i) =>
      f.reply(runId, `已完成消息 ${i}`),
    );
    f.terminal(runId);
    const read = f.read(6000);
    const response = read.coverage.currentUserSource!.runResponse!;
    expect(response.replyObserved).toBe(true);
    expect(response.terminalObserved).toBe(true);
    expect(response.omittedForBudget).toBe(true);
    expect(response.evidenceIds.length).toBeGreaterThan(0);
    expect(response.evidenceIds.length).toBeLessThan(replies.length);
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(6000);
  });

  it("does not duplicate an already represented response when FIFO reaches the same terminal", () => {
    const f = fixture();
    const runId = randomUUID();
    const user = f.user(runId);
    const reply = f.reply(runId);
    const terminal = f.terminal(runId);
    const read = f.read();
    expect(read.snapshot.evidence.map(({ id }) => id)).toEqual([
      user.id,
      reply.id,
      terminal.id,
    ]);
    expect(read.snapshot.attention.lastReceiptSequence).toBe(
      terminal.receiptSequence,
    );
    expect(read.coverage.moreEvidencePending).toBe(false);
  });

  it("does not renew a consumed Run's response merely because it was previously supplied", () => {
    const f = fixture();
    const runId = randomUUID();
    const user = f.user(runId);
    const reply = f.reply(runId);
    const terminal = f.terminal(runId);
    const read = f.read();
    const attempt = f.repository.createAttempt(
      read,
      "semantic_change",
      f.now(),
      read.coverage.allocation,
    );
    f.repository.saveAttempt({ ...attempt, status: "analyzing" });
    const done = f.repository.commitAnalysis(attempt.id, quiet(), f.now());
    f.repository.saveAttempt({
      ...done,
      status: "settled",
      updatedAt: f.now(),
    });
    f.backlog();
    const next = f.read();
    expect(next.coverage.currentUserSource).toBeUndefined();
    for (const source of [user, reply, terminal])
      expect(next.snapshot.evidence.some(({ id }) => id === source.id)).toBe(
        false,
      );
  });

  it("only pairs the latest unread user Run and never pairs a screen quotation", () => {
    const f = fixture();
    f.backlog();
    const oldRun = randomUUID();
    f.user(oldRun);
    const oldReply = f.reply(oldRun);
    const latestRun = randomUUID();
    const user = f.user(latestRun);
    const reply = f.reply(latestRun);
    let read = f.read();
    expect(read.coverage.currentUserSource?.evidenceId).toBe(user.id);
    expect(read.coverage.currentUserSource?.runResponse?.evidenceIds).toEqual([
      reply.id,
    ]);
    expect(read.snapshot.evidence.some(({ id }) => id === oldReply.id)).toBe(
      false,
    );
    const quoted = f.insert("屏幕上的用户引语", {
      actor: "user",
      kind: "utterance",
    });
    read = f.read();
    expect(read.coverage.currentUserSource?.evidenceId).toBe(quoted.id);
    expect(read.coverage.currentUserSource?.runResponse).toBeUndefined();
  });

  it("truthfully marks completion omission without mutating the original coverage or promoting an unavailable reply to text", () => {
    const f = fixture();
    f.backlog();
    const runId = randomUUID();
    f.user(runId);
    const reply = f.reply(runId);
    f.terminal(runId);
    const read = f.read();
    const selected = selectAnalysisSnapshot(
      {
        ...read.snapshot,
        evidence: read.snapshot.evidence.filter(({ id }) => id !== reply.id),
      },
      6000,
      read.coverage,
    );
    expect(selected.coverage.currentUserSource?.runResponse).toMatchObject({
      replyObserved: true,
      omittedForBudget: true,
    });
    expect(read.coverage.currentUserSource?.runResponse?.omittedForBudget).toBe(
      false,
    );
  });

  it("retains the actual response across real Service analysis and recall completion while preserving the original through sequence", async () => {
    const f = fixture();
    f.backlog();
    const runId = randomUUID();
    const user = f.user(runId);
    const reply = f.reply(runId);
    const terminal = f.terminal(runId);
    const captured: CognitionAnalysisInput[] = [];
    const errors: unknown[] = [];
    const service = new CognitionService({
      repository: f.repository,
      driver: {
        analyze: (input) => {
          captured.push(structuredClone(input));
          const result = quiet([user.id, reply.id]);
          if (!input.evidencePack)
            result.recallPlan = {
              purpose: "initiative",
              query: "曾经约定的表达边界",
              questions: [],
              contextBudget: { maxTokens: 1000 },
            };
          return Promise.resolve(result);
        },
      },
      memory: {
        recall: () => {
          f.insert("检索期间的新视图");
          return Promise.resolve(emptyPack);
        },
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
      clock: { now: f.now },
      activePersonaId: () => personaId,
      analysisReadBudgetBytes: 6000,
      analysisBudgetTokens: 32768,

      batchWindowMs: 0,
      onError: (error) => errors.push(error),
    });
    services.push(service);
    service.ingest({
      id: randomUUID(),
      personaId,
      actor: "user",
      kind: "observation",
      source: { kind: "activity", id: randomUUID() },
      observedAt: f.now(),
      text: "触发分析",
    });
    await service.runDue(f.now());
    expect(errors).toEqual([]);
    expect(captured).toHaveLength(2);
    for (const input of captured)
      for (const source of [user, reply, terminal]) {
        expect(
          input.snapshot.evidence.find(({ id }) => id === source.id)?.text,
        ).toBe(source.text);
        expect(input.attempt.dependencies.evidenceIds).toContain(source.id);
      }
    expect(captured[1]!.snapshot.attention.lastReceiptSequence).toBe(
      captured[0]!.snapshot.attention.lastReceiptSequence,
    );
    expect(
      captured[1]!.coverage?.currentUserSource?.runResponse?.omittedForBudget,
    ).toBe(false);
    expect(captured[1]!.attempt.dependencies.receivedThroughSequence).toBe(
      captured[0]!.attempt.dependencies.receivedThroughSequence,
    );
    expect(f.repository.getAttempt(captured[0]!.attempt.id)).toMatchObject({
      status: "settled",
      outcome: "quiet",
    });
  });
});
