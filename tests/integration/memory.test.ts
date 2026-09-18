import {
  formationRuntime,
  formationResourceBudget,
} from "../fixtures/formationModel";
import { estimateInputBudget } from "../../src/main/providers/inputBudget";
import { formationIntake } from "../fixtures/memoryFormation";
import { searchMemoryVectors } from "../../src/main/memory/memoryVectorSearch";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import {
  registerMemoryFormationTool,
  registerMemoryTool,
} from "../../src/main/memory/memoryTool";
import { ToolRegistry } from "../../src/main/tools/toolRegistry";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

function harness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "charamate-memory-"));
  roots.push(root);
  const databasePath = path.join(root, "app.sqlite");
  const database = openApplicationDatabase(databasePath);
  const repository = new MemoryRepository(database);
  const clock = new FakeClock("2026-08-08T12:00:00.000Z");
  const retrieval = new LexicalRetrievalPipeline(database, repository, clock);
  return {
    clock,
    database,
    databasePath,
    repository,
    service: new MemoryService(
      repository,
      retrieval,
      new CryptoIdGenerator(),
      clock,
      {
        embedding: {
          modelKey: "integration-vector-fixture",
          dimensions: 2,
          splitDocument: (text) => Promise.resolve([text]),
          embedDocuments: (texts) =>
            Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
          embedQuery: () => Promise.resolve(new Float32Array([1, 0])),
        },
        vectorSearch: {
          search: ({ query, plan, modelKey, now, limit }, signal) =>
            Promise.resolve(
              searchMemoryVectors(
                query,
                repository.recall.vectors(plan, modelKey, now),
                limit,
                () => signal?.throwIfAborted(),
              ),
            ),
        },
        selector: {
          select: ({ plan, candidates }) =>
            Promise.resolve({
              selected: candidates.map(({ revisionId }) => ({
                revisionId,
                questionIds: plan.questions.map(({ id }) => id),
              })),
              coverage: plan.questions.map(({ id }) => ({
                questionId: id,
                status: candidates.length ? "supported" : "missing",
                revisionIds: candidates.map(({ revisionId }) => revisionId),
              })),
            }),
        },
        formation: formationRuntime({
          version: "integration-formation-fixture",
          form: ({ episode }) =>
            Promise.resolve({
              entities: [],
              units: [
                {
                  operation: "create",
                  type: "project",
                  content: episode.sources[0]!.content,
                  semantics: {
                    kind: "claim",
                    basis: "explicit_user_statement",
                    owner: "user",
                    qualifiers: {},
                  },
                  entityKeys: [],
                  citations: [
                    {
                      sourceId: episode.sources[0]!.id,
                      quote: episode.sources[0]!.content,
                    },
                  ],
                  links: [],
                },
              ],
            }),
        }),
        formationResourceBudget,
        formationContextBudget: () => ({ maxTokens: 8000 }),
      },
    ),
  };
}

describe("Memory persistence", () => {
  it("notifies the integration owner after mutations that can reschedule outreach", () => {
    const { database, service } = harness();
    const changed = vi.fn();
    service.setChangedListener(changed);
    const created = service.create({
      confidence: 1,
      content: "用户明天下午三点有一场重要分享。",
      importance: 0.9,
      importantMoment: true,
      occursAt: "2026-08-09T07:00:00.000Z",
      reason: "用户明确说明",
      sources: [],
      timeZone: "Asia/Shanghai",
      type: "event",
    });

    service.revise({
      content: "用户明天下午四点有一场重要分享。",
      importantMoment: true,
      memoryId: created.memory.id,
      occursAt: "2026-08-09T08:00:00.000Z",
      reason: "用户明确改期",
      sources: [],
      timeZone: "Asia/Shanghai",
    });
    service.archive(created.memory.id);
    service.restore(created.memory.id);
    service.delete(created.memory.id);
    service.restore(created.memory.id);
    service.delete(created.memory.id);
    service.purge(created.memory.id);

    expect(changed).toHaveBeenCalledTimes(8);
    expect(changed).toHaveBeenCalledWith(created.memory.id);
    database.close();
  });

  it("keeps current state, Revision, sources and Profile projection aligned", () => {
    const { clock, database, service } = harness();
    const sourceId = randomUUID();
    const created = service.create({
      confidence: 0.9,
      content: "用户喜欢安静的咖啡馆。",
      importance: 0.8,
      reason: "用户明确说明",
      sources: [
        {
          createdAt: clock.now(),
          id: sourceId,
          label: "聊天消息",
          referenceId: randomUUID(),
          type: "chat",
        },
      ],
      type: "profile",
    });
    expect(created.revisions).toHaveLength(1);
    expect(created.sources.map(({ id }) => id)).toEqual([sourceId]);

    clock.advance(1_000);
    const revised = service.revise({
      confidence: 1,
      content: "用户喜欢安静、有插座的独立咖啡馆。",
      importance: 0.9,
      memoryId: created.memory.id,
      reason: "用户补充条件",
      sources: [],
    });
    expect(revised.revisions).toHaveLength(2);
    expect(revised.memory.currentRevisionId).toBe(revised.revisions[0]?.id);
    expect(revised.revisions[0]?.sourceType).toBe("user_edit");
    expect(
      database
        .prepare("SELECT revision_id FROM profile_fields WHERE memory_id = ?")
        .get(created.memory.id),
    ).toEqual({ revision_id: revised.memory.currentRevisionId });

    expect(service.list({}).profile[0]?.revision.content).toContain("插座");
    service.archive(created.memory.id);
    expect(
      database
        .prepare("SELECT 1 FROM profile_fields WHERE memory_id = ?")
        .get(created.memory.id),
    ).toBeUndefined();
    expect(() =>
      service.revise({
        content: "归档后不应直接编辑。",
        memoryId: created.memory.id,
        reason: "非法编辑",
        sources: [],
      }),
    ).toThrow("只有当前有效");
    service.restore(created.memory.id);
    expect(
      database
        .prepare("SELECT revision_id FROM profile_fields WHERE memory_id = ?")
        .get(created.memory.id),
    ).toEqual({ revision_id: revised.memory.currentRevisionId });
    clock.advance(1_000);
    const replacement = service.create({
      confidence: 1,
      content: "用户现在更偏爱可以安静工作的图书馆。",
      importance: 0.9,
      reason: "用户更新画像",
      sources: [],
      supersedesMemoryId: created.memory.id,
      type: "profile",
    });
    expect(
      database
        .prepare("SELECT memory_id FROM profile_fields ORDER BY memory_id")
        .all(),
    ).toEqual([{ memory_id: replacement.memory.id }]);
    expect(
      service.list({ asOf: created.memory.createdAt }).profile[0]?.revision
        .content,
    ).toBe("用户喜欢安静的咖啡馆。");
    database.close();
  });

  it("redacts detected credentials before Memory persistence", () => {
    const { clock, database, service } = harness();
    const sourceId = randomUUID();
    const created = service.create({
      confidence: 1,
      content: "临时 key 是 sk-memorysecret123456，请记住项目名。",
      importance: 0.5,
      reason: "来自 api_key=memory-secret-value",
      sources: [
        {
          createdAt: clock.now(),
          id: sourceId,
          label: "凭据 sk-sourcesecret123456 出现在消息中",
          referenceId: randomUUID(),
          type: "chat",
        },
      ],
      type: "project",
    });

    expect(created.revisions[0]?.content).not.toContain("memorysecret");
    expect(created.revisions[0]?.reason).not.toContain("memory-secret-value");
    expect(created.sources[0]?.label).not.toContain("sourcesecret");
    expect(JSON.stringify(created)).toContain("[REDACTED]");
    database.close();
  });

  it("supersedes old facts and keeps soft deletion recoverable before purge", () => {
    const { clock, database, service } = harness();
    const old = service.create({
      confidence: 0.8,
      content: "饮料选择半糖。",
      importance: 0.7,
      reason: "旧偏好",
      sources: [],
      type: "preference",
    });
    clock.advance(1_000);
    const sourceId = randomUUID();
    const current = service.create({
      confidence: 1,
      content: "饮料选择无糖。",
      importance: 0.9,
      reason: "用户改口",
      sources: [
        {
          createdAt: clock.now(),
          id: sourceId,
          label: "用户改口消息",
          referenceId: randomUUID(),
          type: "chat",
        },
      ],
      supersedesMemoryId: old.memory.id,
      type: "preference",
    });
    expect(service.get(old.memory.id).memory).toMatchObject({
      status: "superseded",
      supersededById: current.memory.id,
    });

    const deleted = service.delete(current.memory.id);
    expect(deleted.memory.deletedAt).toBe(clock.now());
    expect(
      service.list({}).memories.map(({ memory }) => memory.id),
    ).not.toContain(current.memory.id);
    expect(service.restore(current.memory.id).memory.status).toBe("active");
    service.delete(current.memory.id);
    service.purge(current.memory.id);
    expect(() => service.get(current.memory.id)).toThrow("找不到这条记忆");
    expect(
      database
        .prepare("SELECT 1 FROM memory_sources WHERE id = ?")
        .get(sourceId),
    ).toBeUndefined();
    database.close();
  });

  it("accepts or rejects each Activity candidate once with traceable evidence", () => {
    const { database, service } = harness();
    const evidenceId = randomUUID();
    const acceptedCandidate = service.propose({
      confidence: 0.75,
      content: "过去多日经常在上午编辑 Lantern。",
      importance: 0.6,
      novelty: 0.8,
      reason: "跨日行为归纳",
      sourceIds: [evidenceId],
      sourceLabels: ["多日编码 Episode"],
      sourceType: "activity",
      type: "activity_digest",
    });
    const accepted = service.acceptCandidate(acceptedCandidate.id);
    expect(accepted.sources).toEqual([
      expect.objectContaining({
        referenceId: evidenceId,
        type: "activity",
      }),
    ]);
    expect(() => service.acceptCandidate(acceptedCandidate.id)).toThrow(
      "已接受",
    );

    const rejectedCandidate = service.propose({
      confidence: 0.2,
      content: "用户长期喜欢某首偶然播放的音乐。",
      importance: 0.1,
      novelty: 0.3,
      reason: "一次性事件",
      sourceIds: [randomUUID()],
      sourceLabels: ["一次性音乐 Episode"],
      sourceType: "activity",
      type: "preference",
    });
    expect(service.rejectCandidate(rejectedCandidate.id).status).toBe(
      "rejected",
    );
    expect(() => service.rejectCandidate(rejectedCandidate.id)).toThrow(
      "已拒绝",
    );
    database.close();
  });

  it("rejects event time metadata that the packaged runtime cannot interpret", () => {
    const { database, service } = harness();
    const input = {
      confidence: 1,
      content: "用户明天下午三点有一场重要的演示。",
      importance: 0.8,
      importantMoment: true,
      occursAt: "2026-08-09T07:00:00.000Z",
      reason: "用户明确说明",
      sources: [],
      type: "event" as const,
    };

    expect(() =>
      service.create({ ...input, timeZone: "Mars/Olympus" }),
    ).toThrow(/timeZone must be recognized/u);
    expect(() =>
      service.create({
        ...input,
        occursAt: "2026-08-09 07:00",
        timeZone: "Asia/Shanghai",
      }),
    ).toThrow(/canonical UTC timestamp/u);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memories").get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("keeps a shared source unique while associating it with each Revision", () => {
    const { clock, database, service } = harness();
    const source = {
      createdAt: clock.now(),
      id: randomUUID(),
      label: "同一条聊天证据",
      referenceId: randomUUID(),
      type: "chat" as const,
    };
    const created = service.create({
      confidence: 1,
      content: "用户偏好简短回答。",
      importance: 0.7,
      reason: "用户说明",
      sources: [source],
      type: "preference",
    });
    clock.advance(1_000);
    const revised = service.revise({
      content: "用户偏好先给简短结论。",
      memoryId: created.memory.id,
      reason: "同一证据的准确表述",
      sources: [source],
    });

    expect(revised.sources).toEqual([source]);
    expect(revised.revisions.map(({ sourceIds }) => sourceIds)).toEqual([
      [source.id],
      [source.id],
    ]);
    database.close();
  });

  it("searches only the selected current Revision and can reconstruct an explicit historical Revision", () => {
    const { clock, database, service } = harness();
    const memory = service.create({
      confidence: 1,
      content: "Lantern 正式版使用 Tauri。",
      importance: 0.8,
      reason: "初始技术方案",
      sources: [],
      type: "project",
    });
    const historicalAt = clock.now();
    clock.advance(1_000);
    service.revise({
      content: "Lantern 正式版使用 Electron。",
      memoryId: memory.memory.id,
      reason: "技术方案已变更",
      sources: [],
    });
    clock.advance(1_000);
    service.setPinned(memory.memory.id, true);

    expect(service.list({ query: "Tauri" }).memories).toEqual([]);
    expect(
      service.list({ query: "Electron" }).memories[0]?.revision.content,
    ).toContain("Electron");
    const historical = service.list({
      asOf: historicalAt,
      query: "Tauri",
    });
    expect(historical.candidates).toEqual([]);
    const historicalMemory = historical.memories[0];
    expect(historicalMemory?.revision.content).toContain("Tauri");
    expect(historicalMemory?.memory.updatedAt).toBe(memory.memory.createdAt);
    expect(historicalMemory?.memory.pinnedAt).toBeUndefined();
    database.close();
  });

  it("projects last access only from usages visible at the historical time", async () => {
    const { clock, database, service } = harness();
    const created = service.create({
      confidence: 1,
      content: "用户偏好先给结论。",
      importance: 0.8,
      reason: "用户说明",
      sources: [],
      type: "preference",
    });
    clock.advance(1_000);
    const firstUsedAt = clock.now();
    await service.recall(
      {
        purpose: "recollection",
        query: "结论",
        questions: [],
        contextBudget: { maxTokens: 8000 },
      },
      undefined,
      "tool",
    );
    clock.advance(1_000);
    const historicalAt = clock.now();
    clock.advance(1_000);
    await service.recall({
      purpose: "recollection",
      query: "结论",
      questions: [],
      contextBudget: { maxTokens: 8000 },
    });

    const historical = service.list({
      asOf: historicalAt,
      query: "结论",
    });
    expect(historical.memories[0]?.memory).toMatchObject({
      id: created.memory.id,
      lastAccessedAt: firstUsedAt,
    });
    database.close();
  });

  it.each(["tool", "context"] as const)(
    "keeps equal-relevance ordering after %s exposure while a real Revision updates it",
    async (consumer) => {
      const { clock, database, service } = harness();
      const older = service.create({
        confidence: 0.8,
        content: "weekend walk cedar ridge",
        importance: 0.8,
        reason: "用户说明周末计划",
        sources: [],
        type: "project",
      });
      clock.advance(1_000);
      const newer = service.create({
        confidence: 0.8,
        content: "weekend walk birch trail",
        importance: 0.8,
        reason: "用户提及另一段经历",
        sources: [],
        type: "event",
      });
      const ids = (query?: string) =>
        service
          .list(query ? { query } : {})
          .memories.map(({ memory }) => memory.id);
      expect(ids("weekend")).toEqual([newer.memory.id, older.memory.id]);
      expect(ids()).toEqual([newer.memory.id, older.memory.id]);

      clock.advance(1_000);
      await service.recall(
        {
          purpose: "recollection",
          query: "weekend",
          questions: [],
          contextBudget: { maxTokens: 8000 },
        },
        undefined,
        consumer,
      );
      expect(ids("weekend")).toEqual([newer.memory.id, older.memory.id]);
      expect(ids()).toEqual([newer.memory.id, older.memory.id]);
      expect(service.get(older.memory.id)).toMatchObject({
        memory: {
          lastAccessedAt: clock.now(),
          updatedAt: older.memory.updatedAt,
        },
        usages: [{ consumer, revisionId: older.memory.currentRevisionId }],
      });

      clock.advance(1_000);
      const revised = service.revise({
        content: "weekend walk cedar river",
        memoryId: older.memory.id,
        reason: "用户更正目的地",
        sources: [],
      });
      expect(revised.memory.updatedAt).toBe(clock.now());
      expect(ids("weekend")).toEqual([older.memory.id, newer.memory.id]);
      expect(ids()).toEqual([older.memory.id, newer.memory.id]);
      expect(revised.revisions).toHaveLength(2);
      database.close();
    },
  );

  it("keeps a specific old episode reachable after a long absence and recent unrelated activity", async () => {
    const { clock, database, service } = harness();
    const remembered = service.create({
      confidence: 1,
      content: "第一次雾谷徒步时迷了路，后来一起走了出来，用户说愿意再试一次。",
      importance: 0.5,
      reason: "用户分享经历",
      sources: [],
      type: "event",
    });
    clock.advance(2 * 365 * 24 * 60 * 60 * 1_000);
    service.create({
      confidence: 1,
      content: "今天整理了桌面文件，做完了日常工作。",
      importance: 0.5,
      reason: "近期经历",
      sources: [],
      type: "event",
    });
    await service.indexPending();
    const evidence = await service.recall({
      purpose: "recollection",
      query: "雾谷",
      questions: [{ id: "past", text: "雾谷" }],
      contextBudget: { maxTokens: 8000 },
    });
    expect(evidence.items.map(({ memoryId }) => memoryId)).toContain(
      remembered.memory.id,
    );
    expect(service.get(remembered.memory.id)).toMatchObject({
      memory: { status: "active", updatedAt: remembered.memory.updatedAt },
      revisions: [remembered.revisions[0]],
    });
    database.close();
  });

  it("excludes superseded and archived memories by default while retaining explicit filters", () => {
    const { clock, database, service } = harness();
    const old = service.create({
      confidence: 1,
      content: "饮料甜度选择半糖。",
      importance: 0.7,
      reason: "旧偏好",
      sources: [],
      type: "preference",
    });
    const historicalAt = clock.now();
    clock.advance(1_000);
    const current = service.create({
      confidence: 1,
      content: "饮料甜度选择无糖。",
      importance: 0.9,
      reason: "用户改口",
      sources: [],
      supersedesMemoryId: old.memory.id,
      type: "preference",
    });
    const archived = service.create({
      confidence: 1,
      content: "不再维护的临时项目。",
      importance: 0.3,
      reason: "临时记录",
      sources: [],
      type: "project",
    });
    service.archive(archived.memory.id);

    expect(
      service
        .list({ query: "饮料甜度" })
        .memories.map(({ memory }) => memory.id),
    ).toEqual([current.memory.id]);
    expect(
      service
        .list({ asOf: historicalAt, query: "饮料甜度" })
        .memories.map(({ memory }) => memory.id),
    ).toEqual([old.memory.id]);
    expect(
      service
        .list({ includeInactive: true })
        .memories.map(({ memory }) => memory.id),
    ).toEqual(expect.arrayContaining([old.memory.id, archived.memory.id]));
    database.close();
  });

  it("retains claim-slot filtering for the user memory list", () => {
    const { database, service } = harness();
    const hobbies = service.create({
      claimSlot: "preference.hobbies",
      confidence: 1,
      content: "用户喜欢安静地玩游戏。",
      importance: 0.7,
      reason: "用户说明",
      sources: [],
      type: "preference",
    });
    service.create({
      claimSlot: "preference.response_style",
      confidence: 1,
      content: "用户喜欢安静简洁的回答。",
      importance: 0.7,
      reason: "用户说明",
      sources: [],
      type: "preference",
    });

    expect(
      service
        .list({ claimSlot: "preference.hobbies", query: "用户喜欢安静" })
        .memories.map(({ memory }) => memory.id),
    ).toEqual([hobbies.memory.id]);
    database.close();
  });

  it("keeps hundreds of source references within a host budget without losing the remembered statement", async () => {
    const { service, database, clock } = harness();
    const sources = Array.from({ length: 600 }, () => ({
      id: randomUUID(),
      referenceId: randomUUID(),
      type: "activity" as const,
      createdAt: clock.now(),
    }));
    const created = service.create({
      content: "技术回答先给结论，再说明依据",
      type: "preference",
      confidence: 1,
      importance: 0.5,
      reason: "fixture",
      sources,
    });
    await service.indexPending();
    const registry = new ToolRegistry();
    registerMemoryTool(registry, service, () => ({}));
    const result = await registry.execute(
      "memory.search",
      { query: "技术回答" },
      {
        measureResult: (candidate) =>
          Promise.resolve({
            kind: "responses_request" as const,
            inputBudgetTokens: 2400,
            measurement: estimateInputBudget(candidate),
          }),
        itemId: randomUUID(),
        runId: randomUUID(),
        onDelta: () => undefined,
        signal: new AbortController().signal,
      },
    );
    expect(result.modelContent).toMatchObject({
      items: [
        {
          memoryId: created.memory.id,
          sourceCount: 600,
          content: "技术回答先给结论，再说明依据",
        },
      ],
      truncated: true,
    });
    const evidence = result.modelContent as {
      items: { sourceRefs: unknown[] }[];
      estimatedTokens: number;
      incompleteReasons: string[];
    };
    expect(evidence.items[0]!.sourceRefs.length).toBeGreaterThan(0);
    expect(evidence.items[0]!.sourceRefs.length).toBeLessThan(600);
    expect(evidence.estimatedTokens).toBeLessThanOrEqual(2400);
    expect(evidence.incompleteReasons.join(" ")).toContain("节选");
    expect(service.get(created.memory.id).sources).toHaveLength(600);
    expect(service.get(created.memory.id).usages).toMatchObject([
      { consumer: "tool", revisionId: created.memory.currentRevisionId },
    ]);
    database.close();
  });

  it("forms a source-backed episode through the same registered tool and keeps user-visible detail", async () => {
    const { service, database, clock } = harness();
    const registry = new ToolRegistry();
    const episode = {
      id: randomUUID(),
      version: "v1",
      recordedAt: clock.now(),
      sources: [
        {
          id: randomUUID(),
          referenceId: randomUUID(),
          type: "chat" as const,
          speaker: "user" as const,
          content: "周末一起整理我的读书笔记",
          occurredAt: clock.now(),
        },
      ],
    };
    registerMemoryFormationTool(registry, service, () =>
      formationIntake(episode),
    );
    const context = {
      itemId: randomUUID(),
      runId: randomUUID(),
      onDelta: () => undefined,
      signal: new AbortController().signal,
    };
    const first = await registry.execute("memory.record", {}, context);
    const repeated = await registry.execute("memory.record", {}, context);
    expect(repeated.modelContent).toEqual({
      ...(first.modelContent as Record<string, unknown>),
      replayed: true,
    });
    const changes = (
      first.modelContent as {
        changes: { memoryId: string; revisionId: string }[];
      }
    ).changes;
    expect(changes).toHaveLength(1);
    expect(service.get(changes[0]!.memoryId)).toMatchObject({
      revisions: [{ content: episode.sources[0]!.content }],
      sources: [{ referenceId: episode.sources[0]!.referenceId }],
    });
    database.close();
  });
});
