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

  it("forms explicit memories directly while routing inference through deduplicated candidates", () => {
    const { database, service } = harness();
    const source = (id: string) => ({
      id,
      label: `用户消息 ${id}`,
      referenceId: randomUUID(),
      type: "chat" as const,
    });
    const firstSourceId = randomUUID();
    const formed = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "preference.response_style",
      content: "  用户偏好技术回答先给结论。  ",
      operation: "create",
      source: source(firstSourceId),
    });
    expect(formed).toMatchObject({ outcome: "created" });
    if (!("memoryId" in formed)) throw new Error("Expected formed Memory");

    const duplicate = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "preference.response_style",
      content: "用户偏好技术回答先给结论。",
      operation: "create",
      source: source(randomUUID()),
    });
    expect(duplicate).toMatchObject({
      memoryId: formed.memoryId,
      outcome: "duplicate",
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memories").get(),
    ).toEqual({ count: 1 });

    const inferredContent = "用户可能更喜欢在上午处理复杂任务。";
    const candidate = service.form({
      allowedMemoryIds: [],
      basis: "inference",
      claimSlot: "preference.schedule",
      content: inferredContent,
      operation: "create",
      source: source(randomUUID()),
    });
    const duplicateCandidate = service.form({
      allowedMemoryIds: [],
      basis: "inference",
      claimSlot: "preference.schedule",
      content: inferredContent,
      operation: "create",
      source: source(randomUUID()),
    });
    expect(candidate).toMatchObject({ outcome: "candidate_created" });
    expect(duplicateCandidate).toMatchObject({
      candidateId:
        "candidateId" in candidate ? candidate.candidateId : undefined,
      outcome: "candidate_duplicate",
    });
    expect(service.list({}).candidates).toHaveLength(1);
    expect(service.list({ query: "上午复杂任务" }).memories).toEqual([]);

    const revised = service.form({
      allowedMemoryIds: [formed.memoryId],
      basis: "explicit_user_statement",
      claimSlot: "preference.response_style",
      content: "用户偏好技术回答只保留必要依据。",
      memoryId: formed.memoryId,
      operation: "replace",
      source: source(randomUUID()),
    });
    expect(revised).toMatchObject({
      memoryId: formed.memoryId,
      outcome: "revised",
    });
    const detail = service.get(formed.memoryId);
    expect(detail.revisions).toHaveLength(2);
    expect(
      detail.revisions.find(({ id }) => id === detail.memory.currentRevisionId)
        ?.content,
    ).toBe("用户偏好技术回答只保留必要依据。");
    expect(detail.sources).toHaveLength(2);
    database.close();
  });

  it("turns an existing inference into an active memory when the user states it explicitly", () => {
    const { database, service } = harness();
    const content = "用户正在长期维护 Lantern 项目。";
    const source = (id: string) => ({
      id,
      label: `用户消息 ${id}`,
      referenceId: randomUUID(),
      type: "chat" as const,
    });
    service.form({
      allowedMemoryIds: [],
      basis: "inference",
      content,
      operation: "create",
      source: source(randomUUID()),
      type: "project",
    });
    expect(service.list({}).candidates).toHaveLength(1);

    const confirmed = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      content,
      operation: "create",
      source: source(randomUUID()),
      type: "project",
    });
    expect(confirmed).toMatchObject({ outcome: "created" });
    expect(service.list({}).candidates).toEqual([]);
    expect(service.list({ query: "Lantern" }).memories).toHaveLength(1);
    database.close();
  });

  it("updates a stable claim slot across Chats without creating a second active fact", () => {
    const { database, service } = harness();
    const source = () => ({
      id: randomUUID(),
      label: "跨 Chat 用户消息",
      referenceId: randomUUID(),
      type: "chat" as const,
    });
    const first = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户的爱好是徒步。",
      operation: "create",
      source: source(),
    });
    if (!("memoryId" in first)) throw new Error("Expected Memory");
    expect(service.get(first.memoryId).memory.claimSlot).toBe(
      "preference.hobbies",
    );

    const replaced = service.form({
      allowedMemoryIds: [first.memoryId],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户现在的爱好是游泳。",
      memoryId: first.memoryId,
      operation: "replace",
      source: source(),
    });
    expect(replaced).toMatchObject({
      memoryId: first.memoryId,
      outcome: "revised",
    });
    const afterReplace = service.get(first.memoryId);
    expect(afterReplace.revisions).toHaveLength(2);
    expect(
      afterReplace.revisions.find(
        ({ id }) => id === afterReplace.memory.currentRevisionId,
      )?.content,
    ).toBe("用户现在的爱好是游泳。");
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM memories WHERE status = 'active'",
        )
        .get(),
    ).toEqual({ count: 1 });

    const replay = service.form({
      allowedMemoryIds: [first.memoryId],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户现在的爱好是游泳。",
      memoryId: first.memoryId,
      operation: "replace",
      source: source(),
    });
    expect(replay).toMatchObject({ outcome: "duplicate" });
    expect(service.get(first.memoryId).revisions).toHaveLength(2);

    const collision = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户的爱好是攀岩。",
      operation: "create",
      source: source(),
    });
    expect(collision).toMatchObject({ outcome: "candidate_created" });
    expect(service.list({}).candidates[0]).toMatchObject({
      claimOperation: "create",
      claimSlot: "preference.hobbies",
      supersedesMemoryId: first.memoryId,
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM memories WHERE status = 'active'",
        )
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("keeps set append and remove operations on one Memory revision chain", () => {
    const { database, service } = harness();
    const source = () => ({
      id: randomUUID(),
      label: "集合偏好更新",
      referenceId: randomUUID(),
      type: "chat" as const,
    });
    const formed = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户的爱好包括徒步和游泳。",
      operation: "create",
      source: source(),
    });
    if (!("memoryId" in formed)) throw new Error("Expected Memory");

    const appended = service.form({
      allowedMemoryIds: [formed.memoryId],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户的爱好包括徒步、游泳和攀岩。",
      memoryId: formed.memoryId,
      operation: "append",
      source: source(),
    });
    expect(appended).toMatchObject({
      memoryId: formed.memoryId,
      outcome: "revised",
    });

    const removed = service.form({
      allowedMemoryIds: [formed.memoryId],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户的爱好包括游泳和攀岩。",
      memoryId: formed.memoryId,
      operation: "remove",
      source: source(),
    });
    expect(removed).toMatchObject({
      memoryId: formed.memoryId,
      outcome: "revised",
    });
    const detail = service.get(formed.memoryId);
    expect(detail.revisions).toHaveLength(3);
    expect(
      detail.revisions.find(({ id }) => id === detail.memory.currentRevisionId)
        ?.content,
    ).toBe("用户的爱好包括游泳和攀岩。");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memories").get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("candidate-gates a new slot when the Run loaded another same-type stable field", () => {
    const { database, service } = harness();
    const source = () => ({
      id: randomUUID(),
      label: "可能误分类的改口",
      referenceId: randomUUID(),
      type: "chat" as const,
    });
    const hobby = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户的爱好是徒步。",
      operation: "create",
      source: source(),
    });
    if (!("memoryId" in hobby)) throw new Error("Expected hobby Memory");

    const ambiguousCreate = service.form({
      allowedMemoryIds: [hobby.memoryId],
      basis: "explicit_user_statement",
      claimSlot: "preference.likes",
      content: "用户现在喜欢游泳。",
      operation: "create",
      source: source(),
    });
    expect(ambiguousCreate).toMatchObject({ outcome: "candidate_created" });
    const candidate = service.list({}).candidates[0];
    expect(candidate).toMatchObject({
      claimOperation: "create",
      claimSlot: "preference.likes",
      reason: "本轮已加载其他同类稳定字段，等待确认这是新增字段而不是改口",
    });
    expect(candidate).not.toHaveProperty("supersedesMemoryId");
    expect(service.get(hobby.memoryId).revisions).toHaveLength(1);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM memories WHERE status = 'active'",
        )
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("rejects unlisted or mismatched update targets without mutating Memory", () => {
    const { database, service } = harness();
    const source = () => ({
      id: randomUUID(),
      label: "用户改口消息",
      referenceId: randomUUID(),
      type: "chat" as const,
    });
    const hobby = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户的爱好是徒步。",
      operation: "create",
      source: source(),
    });
    const location = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "profile.home_location",
      content: "用户住在北京。",
      operation: "create",
      source: source(),
    });
    if (!("memoryId" in hobby) || !("memoryId" in location)) {
      throw new Error("Expected formed Memories");
    }

    expect(() =>
      service.form({
        allowedMemoryIds: [],
        basis: "explicit_user_statement",
        claimSlot: "preference.hobbies",
        content: "用户现在的爱好是游泳。",
        memoryId: hobby.memoryId,
        operation: "replace",
        source: source(),
      }),
    ).toThrow("不在当前 Run 的合法候选");
    expect(() =>
      service.form({
        allowedMemoryIds: [location.memoryId],
        basis: "explicit_user_statement",
        claimSlot: "preference.hobbies",
        content: "用户现在的爱好是游泳。",
        memoryId: location.memoryId,
        operation: "replace",
        source: source(),
      }),
    ).toThrow("类型与当前事实不一致");
    expect(service.get(hobby.memoryId).revisions).toHaveLength(1);
    expect(service.get(location.memoryId).revisions).toHaveLength(1);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memories").get(),
    ).toEqual({ count: 2 });
    database.close();
  });

  it("contains missing, legacy and invalid-cardinality updates as review candidates", () => {
    const { database, service } = harness();
    const source = () => ({
      id: randomUUID(),
      label: "用户改口消息",
      referenceId: randomUUID(),
      type: "chat" as const,
    });
    const hobby = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户的爱好是徒步。",
      operation: "create",
      source: source(),
    });
    if (!("memoryId" in hobby)) throw new Error("Expected hobby Memory");
    const missingTarget = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户现在的爱好是游泳。",
      operation: "replace",
      source: source(),
    });
    expect(missingTarget).toMatchObject({ outcome: "candidate_created" });
    if (!("candidateId" in missingTarget)) {
      throw new Error("Expected update candidate");
    }
    expect(service.get(hobby.memoryId).revisions).toHaveLength(1);
    const accepted = service.acceptCandidate(missingTarget.candidateId);
    expect(accepted.memory.id).toBe(hobby.memoryId);
    expect(accepted.revisions).toHaveLength(2);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memories").get(),
    ).toEqual({ count: 1 });

    const legacy = service.create({
      confidence: 1,
      content: "用户喜欢爵士乐。",
      importance: 0.5,
      reason: "v5 旧数据",
      sources: [],
      type: "preference",
    });
    const legacyUpdate = service.form({
      allowedMemoryIds: [legacy.memory.id],
      basis: "explicit_user_statement",
      claimSlot: "preference.music",
      content: "用户现在喜欢古典乐。",
      memoryId: legacy.memory.id,
      operation: "replace",
      source: source(),
    });
    expect(legacyUpdate).toMatchObject({ outcome: "candidate_created" });
    if (!("candidateId" in legacyUpdate)) {
      throw new Error("Expected legacy binding candidate");
    }
    const bound = service.acceptCandidate(legacyUpdate.candidateId);
    expect(bound.memory).toMatchObject({
      claimSlot: "preference.music",
      id: legacy.memory.id,
    });
    expect(bound.revisions).toHaveLength(2);

    const location = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "profile.home_location",
      content: "用户住在北京。",
      operation: "create",
      source: source(),
    });
    if (!("memoryId" in location)) throw new Error("Expected location");
    const invalidAppend = service.form({
      allowedMemoryIds: [location.memoryId],
      basis: "explicit_user_statement",
      claimSlot: "profile.home_location",
      content: "用户还住在上海。",
      memoryId: location.memoryId,
      operation: "append",
      source: source(),
    });
    expect(invalidAppend).toMatchObject({ outcome: "candidate_created" });
    expect(service.get(location.memoryId).revisions).toHaveLength(1);
    database.close();
  });

  it("persists stable claim identity across a database reopen", () => {
    const { clock, database, databasePath, service } = harness();
    const source = () => ({
      id: randomUUID(),
      label: "用户消息",
      referenceId: randomUUID(),
      type: "chat" as const,
    });
    const formed = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户的爱好是徒步。",
      operation: "create",
      source: source(),
    });
    if (!("memoryId" in formed)) throw new Error("Expected Memory");
    database.close();

    const reopenedDatabase = openApplicationDatabase(databasePath);
    const repository = new MemoryRepository(reopenedDatabase);
    const reopened = new MemoryService(
      repository,
      new LexicalRetrievalPipeline(reopenedDatabase, repository, clock),
      new CryptoIdGenerator(),
      clock,
    );
    const replaced = reopened.form({
      allowedMemoryIds: [formed.memoryId],
      basis: "explicit_user_statement",
      claimSlot: "preference.hobbies",
      content: "用户现在的爱好是游泳。",
      memoryId: formed.memoryId,
      operation: "replace",
      source: source(),
    });
    expect(replaced).toMatchObject({
      memoryId: formed.memoryId,
      outcome: "revised",
    });
    expect(reopened.get(formed.memoryId).memory.claimSlot).toBe(
      "preference.hobbies",
    );
    expect(
      reopenedDatabase.prepare("SELECT COUNT(*) AS count FROM memories").get(),
    ).toEqual({ count: 1 });
    reopenedDatabase.close();
  });

  it("requires an allowlisted target before updating an unscoped Memory", () => {
    const { database, service } = harness();
    const source = () => ({
      id: randomUUID(),
      label: "项目更新消息",
      referenceId: randomUUID(),
      type: "chat" as const,
    });
    const project = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      content: "Lantern 计划五月发布。",
      operation: "create",
      source: source(),
      type: "project",
    });
    if (!("memoryId" in project)) throw new Error("Expected project Memory");
    const unresolved = service.form({
      allowedMemoryIds: [],
      basis: "explicit_user_statement",
      content: "Lantern 现在改成六月发布。",
      operation: "replace",
      source: source(),
      type: "project",
    });
    expect(unresolved).toMatchObject({ outcome: "candidate_created" });
    expect(service.get(project.memoryId).revisions).toHaveLength(1);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memories").get(),
    ).toEqual({ count: 1 });

    const revised = service.form({
      allowedMemoryIds: [project.memoryId],
      basis: "explicit_user_statement",
      content: "Lantern 现在改成六月发布。",
      memoryId: project.memoryId,
      operation: "replace",
      source: source(),
      type: "project",
    });
    expect(revised).toMatchObject({
      memoryId: project.memoryId,
      outcome: "revised",
    });
    expect(service.get(project.memoryId).revisions).toHaveLength(2);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memories").get(),
    ).toEqual({ count: 1 });
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
