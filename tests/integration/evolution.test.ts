import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import { EvolutionRepository } from "../../src/main/evolution/evolutionRepository";
import type {
  EvolutionCandidateGenerator,
  EvolutionReplayRunner,
} from "../../src/main/evolution/evolutionReviewer";
import { EvolutionService } from "../../src/main/evolution/evolutionService";
import { SkillRepository } from "../../src/main/extensions/skillRepository";
import { SkillService } from "../../src/main/extensions/skillService";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import type {
  EvolutionCandidate,
  EvolutionChangedEvent,
} from "../../src/shared/contracts/evolution";
import type { RunEventEnvelope } from "../../src/shared/contracts/ipc";
import type { Run, RunItem } from "../../src/shared/contracts/run";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";
import {
  chatFixture,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
  messageFixture,
  runFixture,
  runItemFixture,
} from "../fixtures/foundationContracts";

const temporaryDirectories: string[] = [];

const skillContent = `---
name: release-flow
description: Run the verified release workflow.
---

# Workflow

1. Build the package.
2. Verify the checksum.
`;

const updatedSkillContent = skillContent.replace(
  "Verify the checksum.",
  "Verify the checksum and smoke test.",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function envelope(
  sequence: number,
  event: RunEventEnvelope["event"],
): RunEventEnvelope {
  return {
    event,
    occurredAt: new Date(
      Date.parse(FIXTURE_TIMESTAMPS.created) + sequence * 1_000,
    ).toISOString(),
    sequence,
    streamId: FIXTURE_IDS.run,
  };
}

function persistCompletedRun(
  chats: ChatRepository,
  runs: RunRepository,
): RunEventEnvelope {
  chats.insertChat(chatFixture);
  const startedRun: Run = {
    ...runFixture,
    latestSequence: 1,
    status: "running",
  };
  runs.appendEvent(envelope(1, { run: startedRun, type: "run.started" }));
  chats.insertMessage({
    ...messageFixture,
    content: "以后按这套发布流程做，请记住。",
  });
  const startedItem: RunItem = {
    ...runItemFixture,
    artifacts: [],
    sequence: 2,
    status: "running",
  };
  runs.appendEvent(envelope(2, { item: startedItem, type: "item.started" }));
  const completedItem: RunItem = {
    ...startedItem,
    displayOutput: "构建与校验全部通过",
    endedAt: FIXTURE_TIMESTAMPS.updated,
    status: "completed",
  };
  runs.appendEvent(
    envelope(3, { item: completedItem, type: "item.completed" }),
  );
  const completedRun: Run = {
    ...startedRun,
    endedAt: FIXTURE_TIMESTAMPS.updated,
    latestSequence: 4,
    status: "completed",
  };
  const completed = envelope(4, {
    run: completedRun,
    type: "run.completed",
  });
  runs.appendEvent(completed);
  return completed;
}

class EvolutionEventCollector {
  readonly events: EvolutionChangedEvent[] = [];
  readonly #waiters: Array<{
    readonly predicate: (candidate: EvolutionCandidate) => boolean;
    readonly resolve: (candidate: EvolutionCandidate) => void;
  }> = [];

  publish = (event: EvolutionChangedEvent): void => {
    this.events.push(event);
    if (event.type !== "candidate.changed") return;
    for (const waiter of [...this.#waiters]) {
      if (!waiter.predicate(event.candidate)) continue;
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve(event.candidate);
    }
  };

  waitForCandidate(
    predicate: (candidate: EvolutionCandidate) => boolean,
  ): Promise<EvolutionCandidate> {
    const existing = this.events.find(
      (event) =>
        event.type === "candidate.changed" && predicate(event.candidate),
    );
    if (existing?.type === "candidate.changed") {
      return Promise.resolve(existing.candidate);
    }
    return new Promise((resolve) => {
      this.#waiters.push({ predicate, resolve });
    });
  }
}

describe("Self-evolution production path", () => {
  it("queues a triggered Review, requires confirmation, replays Skills and restores versions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-evolution-"));
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    const completed = persistCompletedRun(chats, runs);
    const clock = new FakeClock("2026-08-13T08:00:00.000Z");
    const ids = new CryptoIdGenerator();
    const memoryRepository = new MemoryRepository(database);
    const memory = new MemoryService(
      memoryRepository,
      new LexicalRetrievalPipeline(database, memoryRepository, clock),
      ids,
      clock,
    );
    const skills = new SkillService(
      path.join(root, "workspace", ".agents", "skills"),
      path.join(root, "user-skills"),
      new SkillRepository(database),
      ids,
      clock,
    );
    await skills.initialize();
    const recordRunSuccess = vi.spyOn(skills, "recordRunSuccess");

    const review = vi.fn<EvolutionCandidateGenerator["review"]>(() =>
      Promise.resolve([
        {
          evidence: ["以后按这套发布流程做，请记住。"],
          proposal: {
            claimSlot: "preference.response_style",
            content: "交付结果时先给结论。",
            kind: "persona_preference",
            reason: "用户明确纠正表达偏好",
          },
          rationale: "明确教学",
          replayCases: [],
          sourceItemIds: [FIXTURE_IDS.item],
        },
        {
          evidence: ["构建与校验全部通过"],
          proposal: {
            content: skillContent,
            kind: "new_skill",
            name: "release-flow",
          },
          rationale: "已客观验证的可复用流程",
          replayCases: [
            {
              expectedOutcome: "执行发布流程",
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              input: "正式发布",
              scope: "in_scope",
            },
            {
              expectedOutcome: "不执行发布流程",
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              input: "只做本地单元测试",
              scope: "out_of_scope",
            },
          ],
          sourceItemIds: [FIXTURE_IDS.item],
        },
      ]),
    );
    const replay = vi
      .fn<EvolutionReplayRunner["replay"]>()
      .mockResolvedValueOnce({
        failureReason: "旁路任务被错误覆盖",
        passed: false,
      })
      .mockResolvedValueOnce({ passed: true });
    const collector = new EvolutionEventCollector();
    const repository = new EvolutionRepository(database);
    const service = new EvolutionService(
      repository,
      runs,
      chats,
      skills,
      memory,
      { review },
      { replay },
      ids,
      clock,
      { warn: vi.fn() },
      collector,
    );
    service.initialize();

    service.observeRun(completed);
    service.observeRun(completed);
    expect(review).not.toHaveBeenCalled();
    expect(recordRunSuccess).toHaveBeenCalledTimes(1);
    expect(repository.requireReviewByRun(FIXTURE_IDS.run).status).toBe(
      "queued",
    );
    expect(service.list({}).reviews).toHaveLength(1);

    const skillDraft = await collector.waitForCandidate(
      (candidate) =>
        candidate.kind === "new_skill" && candidate.status === "draft",
    );
    const personaDraft = service
      .list({ kind: "persona_preference" })
      .candidates.at(0);
    expect(personaDraft?.status).toBe("draft");
    expect(review).toHaveBeenCalledTimes(1);
    expect(skills.list()).toEqual([]);
    expect(memory.list({}).memories).toEqual([]);

    if (!personaDraft || personaDraft.proposal.kind !== "persona_preference") {
      throw new Error("Missing Persona candidate");
    }
    const personaProposal = personaDraft.proposal;
    expect(() =>
      service.updateCandidate({
        candidateId: personaDraft.id,
        proposal: {
          claimSlot: "profile.name",
          content: personaProposal.content,
          kind: "persona_preference",
          reason: personaProposal.reason,
        },
        rationale: personaDraft.rationale,
        replayCases: [],
      }),
    ).toThrow("preference.*");
    const archivedPreference = memory.create({
      claimSlot: "preference.response_style",
      confidence: 1,
      content: "交付结果时最后给结论。",
      importance: 0.5,
      reason: "旧偏好",
      sources: [
        {
          createdAt: clock.now(),
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          referenceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          type: "user_edit",
        },
      ],
      type: "preference",
    });
    memory.archive(archivedPreference.memory.id);
    const persona = service.acceptCandidate(personaDraft.id);
    expect(persona.activatedMemoryId).toBe(archivedPreference.memory.id);
    expect(persona.status).toBe("active");
    expect(memory.list({ type: "preference" }).memories).toHaveLength(1);
    expect(memory.get(archivedPreference.memory.id).revisions[0]?.content).toBe(
      "交付结果时先给结论。",
    );

    const firstFailure = collector.waitForCandidate(
      (candidate) =>
        candidate.id === skillDraft.id &&
        candidate.replayResult.status === "failed",
    );
    expect(service.acceptCandidate(skillDraft.id)).toMatchObject({
      replayResult: { status: "pending" },
      status: "accepted",
    });
    expect(await firstFailure).toMatchObject({
      replayResult: {
        failureReason: "旁路任务被错误覆盖",
        status: "failed",
      },
      status: "accepted",
    });
    expect(skills.list()).toEqual([]);

    const edited = service.updateCandidate({
      candidateId: skillDraft.id,
      proposal: {
        ...skillDraft.proposal,
        content: updatedSkillContent,
      },
      rationale: skillDraft.rationale,
      replayCases: skillDraft.replayCases,
    });
    expect(edited.status).toBe("draft");
    const activated = collector.waitForCandidate(
      (candidate) =>
        candidate.id === skillDraft.id && candidate.status === "active",
    );
    service.acceptCandidate(skillDraft.id);
    expect(await activated).toMatchObject({
      activatedSkillId: "user:release-flow",
      activatedSkillRevision: 1,
      replayResult: { status: "passed" },
      status: "active",
    });
    expect(replay).toHaveBeenCalledTimes(2);
    expect(skills.list()).toEqual([
      expect.objectContaining({
        lifecycle: "active",
        patchCount: 0,
        revision: 1,
        successCount: 0,
        useCount: 0,
      }),
    ]);

    expect(service.setCandidatePinned(skillDraft.id, true).pinned).toBe(true);
    expect(skills.list()[0]?.pinned).toBe(true);
    expect(await service.archiveCandidate(skillDraft.id)).toMatchObject({
      status: "archived",
    });
    expect(skills.list()[0]).toMatchObject({
      archived: true,
      lifecycle: "archived",
    });
    const restored = await service.restoreCandidate(skillDraft.id);
    expect(restored).toMatchObject({
      activatedSkillRevision: 2,
      status: "active",
    });
    expect(skills.list()[0]).toMatchObject({
      archived: false,
      lifecycle: "active",
      pinned: true,
      revision: 2,
    });
    expect(skills.history("user:release-flow")).toHaveLength(2);

    const manualRevision = await skills.save("release-flow", skillContent);
    expect(manualRevision.revision).toBe(3);
    expect(service.synchronizeSkill("user:release-flow")).toMatchObject([
      { id: skillDraft.id, status: "stale" },
    ]);
    expect(() => service.setCandidatePinned(skillDraft.id, false)).toThrow(
      "只有已生效候选",
    );

    await service.shutdown();
    const staleCandidate = repository.requireCandidate(skillDraft.id);
    repository.updateCandidate({
      ...staleCandidate,
      status: "active",
      updatedAt: clock.now(),
    });
    const restarted = new EvolutionService(
      repository,
      runs,
      chats,
      skills,
      memory,
      { review },
      { replay },
      ids,
      clock,
      { warn: vi.fn() },
      new EvolutionEventCollector(),
    );
    restarted.initialize();
    expect(repository.requireCandidate(skillDraft.id).status).toBe("stale");
    await restarted.shutdown();
    database.close();
  });

  it("rejects stale Skill patches and never claims an exact workspace Skill", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-evolution-skill-"),
    );
    temporaryDirectories.push(root);
    const workspaceSkillDirectory = path.join(
      root,
      "workspace",
      ".agents",
      "skills",
      "release-flow",
    );
    await mkdir(workspaceSkillDirectory, { recursive: true });
    await writeFile(
      path.join(workspaceSkillDirectory, "SKILL.md"),
      skillContent,
      "utf8",
    );
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    const skills = new SkillService(
      path.join(root, "workspace", ".agents", "skills"),
      path.join(root, "user-skills"),
      new SkillRepository(database),
      new CryptoIdGenerator(),
      new FakeClock("2026-08-13T08:00:00.000Z"),
    );
    await skills.initialize();

    await expect(
      skills.saveFromEvolution({
        candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        content: skillContent,
        name: "release-flow",
      }),
    ).rejects.toMatchObject({ code: "SKILL.PROTECTED" });

    const base = await skills.save("release-flow", skillContent);
    const manualSave = skills.save("release-flow", updatedSkillContent);
    const proposedPatch = updatedSkillContent.replace(
      "smoke test.",
      "smoke test twice.",
    );
    const stalePatch = skills.saveFromEvolution({
      candidateId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      content: proposedPatch,
      name: "release-flow",
      targetContentSha256: base.contentSha256,
      targetRevision: base.revision,
      targetSkillId: base.id,
    });
    await manualSave;
    await expect(stalePatch).rejects.toMatchObject({
      code: "SKILL.STALE_PATCH",
    });

    database.close();
  });

  it("keeps an activated Skill version when its source Chat is deleted", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-evolution-chat-delete-"),
    );
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    persistCompletedRun(chats, runs);
    const repository = new EvolutionRepository(database);
    const reviewId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const candidateId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    repository.createReview({
      chatId: FIXTURE_IDS.chat,
      completedAt: FIXTURE_TIMESTAMPS.updated,
      createdAt: FIXTURE_TIMESTAMPS.created,
      id: reviewId,
      runId: FIXTURE_IDS.run,
      status: "completed",
      triggers: ["explicit_teaching"],
      updatedAt: FIXTURE_TIMESTAMPS.updated,
    });
    repository.insertCandidate({
      chatId: FIXTURE_IDS.chat,
      createdAt: FIXTURE_TIMESTAMPS.created,
      evidence: ["构建与校验全部通过"],
      id: candidateId,
      kind: "new_skill",
      pinned: false,
      proposal: {
        content: skillContent,
        kind: "new_skill",
        name: "release-flow",
      },
      rationale: "保留来源但不绑定 Chat 生命周期",
      replayCases: [
        {
          expectedOutcome: "执行",
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          input: "发布",
          scope: "in_scope",
        },
        {
          expectedOutcome: "不执行",
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          input: "本地测试",
          scope: "out_of_scope",
        },
      ],
      replayResult: { status: "passed" },
      reviewId,
      sourceItemIds: [FIXTURE_IDS.item],
      sourceRunIds: [FIXTURE_IDS.run],
      status: "accepted",
      updatedAt: FIXTURE_TIMESTAMPS.updated,
    });
    const skills = new SkillService(
      path.join(root, "workspace", ".agents", "skills"),
      path.join(root, "user-skills"),
      new SkillRepository(database),
      new CryptoIdGenerator(),
      new FakeClock("2026-08-13T08:00:00.000Z"),
    );
    await skills.initialize();
    await skills.saveFromEvolution({
      candidateId,
      content: skillContent,
      name: "release-flow",
    });
    expect(skills.history("user:release-flow")[0]?.sourceCandidateId).toBe(
      candidateId,
    );

    expect(chats.deleteChat(FIXTURE_IDS.chat)).toBe(true);
    expect(repository.getCandidate(candidateId)).toBeUndefined();
    expect(
      skills.history("user:release-flow")[0]?.sourceCandidateId,
    ).toBeUndefined();
    expect(skills.list()).toEqual([
      expect.objectContaining({ id: "user:release-flow", revision: 1 }),
    ]);
    database.close();
  });

  it("recovers interrupted Review and replay work from SQLite", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-evolution-recovery-"),
    );
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "app.sqlite");
    let database = openApplicationDatabase(databasePath);
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    persistCompletedRun(chats, runs);
    let repository = new EvolutionRepository(database);
    const reviewId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const candidateId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    repository.createReview({
      chatId: FIXTURE_IDS.chat,
      createdAt: FIXTURE_TIMESTAMPS.created,
      id: reviewId,
      runId: FIXTURE_IDS.run,
      startedAt: FIXTURE_TIMESTAMPS.updated,
      status: "running",
      triggers: ["explicit_teaching"],
      updatedAt: FIXTURE_TIMESTAMPS.updated,
    });
    repository.insertCandidate({
      chatId: FIXTURE_IDS.chat,
      createdAt: FIXTURE_TIMESTAMPS.created,
      evidence: ["构建与校验全部通过"],
      id: candidateId,
      kind: "new_skill",
      pinned: false,
      proposal: {
        content: skillContent,
        kind: "new_skill",
        name: "release-flow",
      },
      rationale: "等待恢复的 replay",
      replayCases: [
        {
          expectedOutcome: "执行",
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          input: "发布",
          scope: "in_scope",
        },
        {
          expectedOutcome: "不执行",
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          input: "本地测试",
          scope: "out_of_scope",
        },
      ],
      replayResult: { status: "running" },
      reviewId,
      sourceItemIds: [FIXTURE_IDS.item],
      sourceRunIds: [FIXTURE_IDS.run],
      status: "accepted",
      updatedAt: FIXTURE_TIMESTAMPS.updated,
    });
    database.close();

    database = openApplicationDatabase(databasePath);
    repository = new EvolutionRepository(database);
    repository.recoverRunningReviews("2026-08-13T08:00:00.000Z");
    expect(repository.requireReviewByRun(FIXTURE_IDS.run)).toMatchObject({
      status: "queued",
    });
    expect(repository.requireCandidate(candidateId)).toMatchObject({
      replayResult: { status: "pending" },
      status: "accepted",
    });
    expect(repository.listPendingReplayCandidateIds()).toEqual([candidateId]);
    database.close();
  });
});
