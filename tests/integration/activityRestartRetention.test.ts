import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ActivityAssetStore } from "../../src/main/activity/activityAssetStore";
import { ActivityRepository } from "../../src/main/activity/activityRepository";
import { ActivityService } from "../../src/main/activity/activityService";
import { visualFrameFixture } from "../../src/main/activity/activityVisual.fixture";
import { CognitionRepository } from "../../src/main/cognition/cognitionRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import { MEMORY_CONSOLIDATION_VERSION } from "../../src/main/memory/memoryLearningRepository";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import { PersonaRepository } from "../../src/main/persona/personaRepository";
import type {
  ActivityEvent,
  ActivityVisualReference,
} from "../../src/shared/contracts/activity";
import type {
  CognitionAnalysis,
  CognitionEvidence,
} from "../../src/shared/contracts/cognition";
import type {
  MemoryEvidenceResolution,
  MemoryFormationSource,
} from "../../src/shared/contracts/memoryRecall";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";
import { formationIntake } from "../fixtures/memoryFormation";

const initialTime = "2026-07-01T12:00:00.000Z";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "activity-restart-"));
  const databasePath = path.join(directory, "app.sqlite");
  let database = openApplicationDatabase(databasePath);
  const clock = new FakeClock(initialTime);
  const ids = new CryptoIdGenerator();
  const personas = new PersonaRepository(database);
  personas.initialize(initialTime);
  const personaId = personas.getLibrary().activePersonaId;

  function domains() {
    const memoryRepository = new MemoryRepository(database);
    // Lifecycle reads and Activity's deterministic distillation need no model.
    const memory = new MemoryService(
      memoryRepository,
      { search: () => [] },
      ids,
      clock,
    );
    const activityRepository = new ActivityRepository(database);
    const assets = new ActivityAssetStore(path.join(directory, "assets"));
    const activity = new ActivityService(
      activityRepository,
      memory,
      assets,
      ids,
      clock,
      "UTC",
    );
    const cognition = new CognitionRepository(database, {
      readBudgetBytes: 32_768,
    });
    return {
      memoryRepository,
      memory,
      activityRepository,
      assets,
      activity,
      cognition,
    };
  }
  let owners = domains();
  owners.activityRepository.initialize(clock.now());
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function event(label: string): ActivityEvent {
    const value: ActivityEvent = {
      id: ids.generate(),
      actor: "user",
      details: { source: "active_app", appName: label, windowTitle: label },
      startedAt: clock.now(),
      endedAt: clock.now(),
    };
    owners.activityRepository.insertEvent(value, clock.now());
    return value;
  }

  async function visual(label: string) {
    const frame = await visualFrameFixture();
    frame.visual.capturedAt = clock.now();
    frame.visual.receivedAt = clock.now();
    frame.visual.surface = {
      ...frame.visual.surface,
      id: label,
      windowId: label,
    };
    const asset = await owners.assets.save(
      ids.generate(),
      { ...frame, mediaType: "image/png" },
      clock.now(),
    );
    const value: ActivityEvent = {
      id: ids.generate(),
      actor: "user",
      details: {
        source: "screenshot",
        artifactId: asset.id,
        storageKey: asset.storageKey,
        mediaType: asset.mediaType,
        width: asset.width,
        height: asset.height,
        summary: label,
        visual: frame.visual,
      },
      startedAt: clock.now(),
      endedAt: clock.now(),
    };
    owners.activityRepository.insertScreenshot(asset, value, clock.now());
    const reference: ActivityVisualReference = {
      eventId: value.id,
      artifactId: asset.id,
      contentRevision: frame.visual.contentRevision,
      surface: frame.visual.surface,
      capturedAt: frame.visual.capturedAt,
      width: frame.width,
      height: frame.height,
      trigger: frame.visual.trigger,
    };
    return { event: value, reference, asset, bytes: frame.bytes };
  }

  function canonical(
    value: ActivityEvent,
    status: "complete" | "running" | "failed" = "complete",
  ) {
    const source: MemoryFormationSource = {
      id: value.id,
      type: "activity_event",
      referenceId: value.id,
      speaker: "environment",
      content: JSON.stringify(value),
      occurredAt: value.startedAt,
    };
    const repository = owners.memoryRepository.formation;
    const work = repository.enqueue(
      formationIntake({
        id: ids.generate(),
        version: "restart-source-v1",
        personaId,
        recordedAt: clock.now(),
        sources: [source],
      }),
      "restart-source-v1",
      clock.now(),
    );
    const execution = repository.startWork(
      work.workId,
      "restart-source-v1",
      undefined,
      clock.now(),
    )!;
    if (status === "complete")
      repository.finish(
        execution,
        { changes: [], sourceIds: [source.id] },
        clock.now(),
      );
    else if (status === "failed")
      repository.fail(execution, "FIXTURE.INTERRUPTED_FORMATION", clock.now());
    return { source, work };
  }

  function observe(
    value: ActivityEvent,
    reference?: ActivityVisualReference,
  ): CognitionEvidence {
    return owners.cognition.ingest(
      {
        id: ids.generate(),
        personaId,
        actor: "user",
        kind: "observation",
        source: { kind: "activity", id: value.id },
        text: JSON.stringify(value.details),
        observedAt: clock.now(),
        ...(reference
          ? {
              visual: reference,
              object: {
                key: reference.surface.id,
                identity: "adapter" as const,
              },
            }
          : {}),
      },
      clock.now(),
    ).evidence;
  }

  function settleWithHandoff(evidence: CognitionEvidence) {
    const analysis: CognitionAnalysis = {
      delta: {
        attention: {},
        createIntents: [],
        updateIntents: [],
        updateSituations: [],
        createSituations: [
          {
            localId: "new:restart-handoff",
            value: {
              status: "closed",
              title: "待交给记忆的真实事件",
              summary: "事件已结束，交接尚未完成。",
              objectRefs: [],
              episodes: [
                {
                  id: "closed-event",
                  label: "待交接事件",
                  state: "closed",
                  startedAt: clock.now(),
                  endedAt: clock.now(),
                  evidenceIds: [evidence.id],
                  objectKeys: [],
                  boundaryReason: "事件完成",
                },
              ],
              claims: [],
              unresolved: [],
              relatedSituationIds: [],
            },
          },
        ],
      },
      decision: {
        choices: [
          {
            id: "quiet",
            kind: "remain_quiet",
            evidenceIds: [],
            rationale: "没有需要执行的动作",
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
        reason: "完成分析后等待交接",
      },
    };
    const attempt = owners.cognition.createAttempt(
      owners.cognition.readSnapshot(personaId, clock.now()),
      "semantic_change",
      clock.now(),
    );
    owners.cognition.saveAttempt({ ...attempt, status: "analyzing" });
    const ready = owners.cognition.commitAnalysis(
      attempt.id,
      analysis,
      clock.now(),
    );
    owners.cognition.saveAttempt({
      ...ready,
      status: "settled",
      outcome: "quiet",
    });
  }

  function derived(sources: MemoryFormationSource[]) {
    const repository = owners.memoryRepository;
    const parents = sources.map((source) => {
      const detail = repository.create({
        memoryId: ids.generate(),
        revisionId: ids.generate(),
        content: source.content,
        type: "event",
        confidence: 1,
        importance: 0.5,
        reason: "来源明确的重启夹具",
        now: clock.now(),
        sources: [repository.formation.sourceProvenance(source.id)],
      });
      repository.recall.putSemantics(
        detail.memory.currentRevisionId,
        {
          kind: "episode",
          owner: "user",
          basis: "direct_observation",
          qualifiers: {},
        },
        [],
      );
      repository.recall.addSpan(
        detail.memory.currentRevisionId,
        source.id,
        0,
        source.content.length,
        source.content,
      );
      return detail;
    });
    // Seed the persisted owner contract; the test exercises real derived-source
    // validation and reads, not the semantic quality of a summarizing model.
    const summary = repository.create({
      memoryId: ids.generate(),
      revisionId: ids.generate(),
      content: "两条有原始依据的陶艺记录。",
      type: "agent_learning",
      confidence: 0.5,
      importance: 0.5,
      reason: "重启后派生来源完整性",
      now: clock.now(),
      sources: sources.map((source) =>
        repository.formation.sourceProvenance(source.id),
      ),
    });
    repository.recall.putSemantics(
      summary.memory.currentRevisionId,
      {
        kind: "reflection",
        basis: "inference",
        owner: "user",
        qualifiers: {
          consolidationVersion: MEMORY_CONSOLIDATION_VERSION,
          consolidationDependencyCount: String(parents.length),
          account: "episode_summary",
        },
      },
      [],
    );
    for (const [index, source] of sources.entries()) {
      repository.recall.addSpan(
        summary.memory.currentRevisionId,
        source.id,
        0,
        source.content.length,
        source.content,
      );
      repository.recall.link(
        summary.memory.currentRevisionId,
        parents[index]!.memory.currentRevisionId,
        "derived_from",
        source.id,
        "current",
      );
    }
    return {
      memoryId: summary.memory.id,
      revisionId: summary.memory.currentRevisionId,
      use: "current" as const,
    };
  }

  return {
    clock,
    personaId,
    event,
    visual,
    canonical,
    observe,
    settleWithHandoff,
    derived,
    get owners() {
      return owners;
    },
    workStatus(workId: string) {
      return database
        .prepare("SELECT status FROM memory_work WHERE id=?")
        .get(workId);
    },
    reopen() {
      database.close();
      database = openApplicationDatabase(databasePath);
      owners = domains();
      // Same composition as Main, installed before initialize's first cleanup.
      owners.activity.setSourceRetentionGuard((eventIds) => {
        const snapshots = owners.memory.snapshottedActivitySourceIds(eventIds);
        const retained = new Set(
          owners.cognition.protectedActivitySourceIds(eventIds, snapshots),
        );
        for (const id of owners.memory.protectedActivitySourceIds(eventIds))
          retained.add(id);
        return retained;
      });
    },
  };
}

describe("Activity startup retention across durable consumers", () => {
  it("reopens actual files, preserves pending and visual consumers, and reclaims only redundant originals", async () => {
    const f = fixture();
    const handoff = f.event("待交接的陶艺事件");
    const running = f.event("形成尚未完成的事件");
    const failed = f.event("形成失败等待恢复的事件");
    const firstParent = f.event("第一次陶艺记录");
    const secondParent = f.event("第二次陶艺记录");
    const unused = f.event("已处理且没有消费者的旧事件");
    const previousVisual = await f.visual("旧窗口");
    const currentVisual = await f.visual("当前窗口");
    f.canonical(handoff);
    f.canonical(currentVisual.event);
    const runningWork = f.canonical(running, "running");
    const failedWork = f.canonical(failed, "failed");
    const parentSources = [
      f.canonical(firstParent).source,
      f.canonical(secondParent).source,
    ];
    const summary = f.derived(parentSources);
    const handoffEvidence = f.observe(handoff);
    f.observe(unused);
    f.observe(previousVisual.event, previousVisual.reference);
    f.observe(currentVisual.event, currentVisual.reference);
    f.settleWithHandoff(handoffEvidence);

    const beforeAttention = f.owners.cognition.getAttention(
      f.personaId,
      f.clock.now(),
    );
    expect(beforeAttention.analyzedThroughSequence).toBe(
      beforeAttention.lastReceiptSequence,
    );
    expect(beforeAttention.foregroundObject?.key).toBe(
      currentVisual.reference.surface.id,
    );
    const pendingHandoffs = [...f.owners.cognition.pendingMemoryHandoffs()];
    expect(pendingHandoffs).toHaveLength(1);
    expect(pendingHandoffs[0]!.primaryEvidenceIds).toEqual([
      handoffEvidence.id,
    ]);
    expect(
      f.owners.cognition.protectedCanonicalSources([
        {
          candidateId: handoff.id,
          references: [{ kind: "activity", id: handoff.id }],
        },
      ]),
    ).toEqual([{ candidateId: handoff.id, reasons: ["handoff"] }]);
    expect(
      f.owners.memory.snapshottedActivitySourceIds([
        handoff.id,
        currentVisual.event.id,
      ]),
    ).toEqual(new Set([handoff.id, currentVisual.event.id]));

    const readRequest = {
      personaId: f.personaId,
      references: [summary],
      resourceBudget: { maxReadBytes: 6000 },
    };
    const beforeRead = f.owners.memory.resolveEvidence(readRequest);
    expect(beforeRead.status).toBe("resolved");
    if (beforeRead.status !== "resolved")
      throw new Error("Expected complete Memory read");
    expect(beforeRead.items).toHaveLength(1);
    expect(beforeRead.items[0]!.derivation?.sourceRevisionCount).toBe(2);

    f.clock.advance(45 * 86_400_000);
    f.reopen();
    // No Cognition Service, Bridge, MemoryMaintenance or model is initialized.
    await f.owners.activity.initialize();

    expect([...f.owners.cognition.pendingMemoryHandoffs()]).toEqual(
      pendingHandoffs,
    );
    expect(f.workStatus(runningWork.work.workId)).toEqual({
      status: "running",
    });
    expect(f.workStatus(failedWork.work.workId)).toEqual({ status: "failed" });
    for (const source of [handoff, running, failed, currentVisual.event])
      expect(f.owners.activity.getEvent(source.id)).toEqual(source);
    expect(
      f.owners.memory.protectedActivitySourceIds([running.id, failed.id]),
    ).toEqual(new Set([running.id, failed.id]));
    expect(
      await f.owners.activity.resolveVisualEvidence(currentVisual.reference),
    ).toMatchObject({
      status: "available",
      reference: currentVisual.reference,
    });
    expect(readFileSync(f.owners.assets.resolve(currentVisual.asset))).toEqual(
      currentVisual.bytes,
    );

    // A no-guard startup currently skips deletion; this control makes that
    // behavior fail this fixture rather than counting "keep everything" as success.
    for (const source of [
      unused,
      previousVisual.event,
      firstParent,
      secondParent,
    ])
      expect(f.owners.activity.getEvent(source.id)).toBeUndefined();
    expect(
      f.owners.activityRepository.getAsset(previousVisual.asset.id),
    ).toBeUndefined();
    expect(existsSync(f.owners.assets.resolve(previousVisual.asset))).toBe(
      false,
    );

    for (const source of parentSources)
      expect(
        f.owners.memory.getFormationSource(
          "activity_event",
          source.referenceId,
        ),
      ).toEqual(source);
    expect(f.owners.memory.validateEvidenceReferences(readRequest)).toEqual([]);
    expect(
      requireResolvedItems(f.owners.memory.resolveEvidence(readRequest)),
    ).toEqual(beforeRead.items);
    for (const source of parentSources)
      expect(f.owners.memory.releaseCanonicalSource(source.id)).toBe(true);
    expect(f.owners.memory.validateEvidenceReferences(readRequest)).toEqual([]);
    expect(
      requireResolvedItems(f.owners.memory.resolveEvidence(readRequest)),
    ).toEqual(beforeRead.items);
  });
});

function requireResolvedItems(value: MemoryEvidenceResolution) {
  expect(value.status).toBe("resolved");
  if (value.status !== "resolved")
    throw new Error("Expected complete Memory read");
  return value.items;
}
