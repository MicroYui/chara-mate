import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import { registerMemoryTool } from "../../src/main/memory/memoryTool";
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
  const database = openApplicationDatabase(path.join(root, "app.sqlite"));
  const repository = new MemoryRepository(database);
  const clock = new FakeClock("2026-08-08T12:00:00.000Z");
  const retrieval = new LexicalRetrievalPipeline(database, repository, clock);
  return {
    clock,
    database,
    repository,
    service: new MemoryService(
      repository,
      retrieval,
      new CryptoIdGenerator(),
      clock,
    ),
  };
}

describe("Memory persistence", () => {
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

  it("projects last access only from usages visible at the historical time", () => {
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
    service.search({ query: "结论" }, "tool", 8);
    clock.advance(1_000);
    const historicalAt = clock.now();
    clock.advance(1_000);
    service.search({ query: "结论" }, "context", 8);

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

  it("uses recent access only as a deterministic equal-relevance tie-break", () => {
    const { clock, database, service } = harness();
    const preference = service.create({
      confidence: 0.8,
      content: "相同排序证据",
      importance: 0.8,
      reason: "排序测试",
      sources: [],
      type: "preference",
    });
    const project = service.create({
      confidence: 0.8,
      content: "相同排序证据",
      importance: 0.8,
      reason: "排序测试",
      sources: [],
      type: "project",
    });
    clock.advance(1_000);
    service.search({ query: "排序证据", type: "project" }, "tool", 8);

    expect(
      service
        .list({ query: "排序证据" })
        .memories.map(({ memory }) => memory.id),
    ).toEqual([project.memory.id, preference.memory.id]);
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

  it("exposes one direct memory.search Tool and records only returned Revision usage", async () => {
    const { database, service } = harness();
    const created = service.create({
      confidence: 1,
      content: "用户希望技术回答先给结论，再给必要依据。",
      importance: 0.9,
      reason: "用户明确表达",
      sources: [],
      type: "preference",
    });
    const tools = new ToolRegistry();
    registerMemoryTool(tools, service);

    const result = await tools.execute(
      "memory.search",
      { query: "技术回答如何组织" },
      {
        itemId: randomUUID(),
        onDelta: () => undefined,
        runId: randomUUID(),
        signal: new AbortController().signal,
      },
    );
    expect(result.status).toBe("success");
    expect(result.modelContent).toMatchObject({
      hits: [
        {
          memoryCreatedAt: created.memory.createdAt,
          memoryId: created.memory.id,
          revisionCreatedAt: created.revisions[0]?.createdAt,
          revisionId: created.memory.currentRevisionId,
          status: "active",
        },
      ],
    });
    expect(
      database
        .prepare(
          "SELECT memory_id, revision_id, consumer FROM memory_usage ORDER BY used_at",
        )
        .all(),
    ).toEqual([
      {
        consumer: "tool",
        memory_id: created.memory.id,
        revision_id: created.memory.currentRevisionId,
      },
    ]);
    expect(service.get(created.memory.id).usages).toEqual([
      expect.objectContaining({
        consumer: "tool",
        memoryId: created.memory.id,
        revisionId: created.memory.currentRevisionId,
      }),
    ]);
    database.close();
  });
});
