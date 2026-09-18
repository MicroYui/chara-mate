import type { MemoryEvidenceResolution } from "../../src/shared/contracts/memoryRecall";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import { MEMORY_CONSOLIDATION_VERSION } from "../../src/main/memory/memoryLearningRepository";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import { PersonaRepository } from "../../src/main/persona/personaRepository";
import { TerritoryWorldAssetStore } from "../../src/main/territory/territoryWorldAssetStore";
import {
  TerritoryWorldCandidateService,
  type TerritoryWorldCandidateJob,
  type TerritoryWorldImageRuntimeFactory,
} from "../../src/main/territory/territoryWorldCandidateService";
import {
  assertTerritoryMemorySources,
  TerritoryWorldMemoryService,
} from "../../src/main/territory/territoryWorldMemoryService";
import { TerritoryWorldRepository } from "../../src/main/territory/territoryWorldRepository";
import { TerritoryWorldService } from "../../src/main/territory/territoryWorldService";
import { createStarterTerritoryWorldSeed } from "../../src/main/territory/territoryStarterWorld";
import type {
  MemoryEvidenceReference,
  MemoryFormationSource,
} from "../../src/shared/contracts/memoryRecall";
import type { TerritoryCreateChangeCandidateRequest } from "../../src/shared/contracts/territoryWorld";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";
import { formationIntake } from "../fixtures/memoryFormation";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// The image adapter is deterministic; the PNG file, AssetStore install/rollback,
// Memory repositories and World transactions below are the real owners.
function png(width: number, height: number): Buffer {
  const chunk = (type: string, content: Buffer) => {
    const bytes = Buffer.alloc(12 + content.length);
    bytes.writeUInt32BE(content.length, 0);
    bytes.write(type, 4, "ascii");
    content.copy(bytes, 8);
    bytes.writeUInt32BE(
      crc32(bytes.subarray(4, 8 + content.length)),
      8 + content.length,
    );
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class ImageGate implements TerritoryWorldImageRuntimeFactory {
  readonly started = deferred<void>();
  readonly completed = deferred<Buffer>();
  readonly generate = vi.fn(() => {
    this.started.resolve();
    return this.completed.promise;
  });

  resolveImageProfileId() {
    return "20000000-0000-4000-8000-000000000001";
  }

  createImageProvider() {
    return Promise.resolve({ edit: this.generate, generate: this.generate });
  }

  finish() {
    this.completed.resolve(png(1, 1));
  }
}

function fixture(dependencyUse: MemoryEvidenceReference["use"] = "current") {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "territory-memory-dependency-"),
  );
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  const runtimes = new ImageGate();
  const pending: TerritoryWorldCandidateJob["completion"][] = [];
  cleanups.push(async () => {
    runtimes.finish();
    await Promise.allSettled(pending);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const ids = new CryptoIdGenerator();
  const clock = new FakeClock("2026-09-01T12:00:00.000Z");
  const personas = new PersonaRepository(database);
  personas.initialize(clock.now());
  const persona = personas.getActiveSnapshot();
  const memoryRepository = new MemoryRepository(database);
  const memory = new MemoryService(
    memoryRepository,
    { search: () => [] },
    ids,
    clock,
  );

  const originals: MemoryFormationSource[] = [
    "以前周末我和爸爸在河边一起做纸灯。",
    "下次还想跟爸爸一起做纸灯。",
  ].map((content) => ({
    id: ids.generate(),
    referenceId: ids.generate(),
    type: "chat",
    speaker: "user",
    content,
    occurredAt: clock.now(),
  }));
  const work = memoryRepository.formation.enqueue(
    formationIntake({
      id: ids.generate(),
      version: "territory-dependency-fixture",
      personaId: persona.personaId,
      recordedAt: clock.now(),
      sources: originals,
    }),
    "territory-dependency-fixture",
    clock.now(),
  );
  const execution = memoryRepository.formation.startWork(
    work.workId,
    "territory-dependency-fixture",
    undefined,
    clock.now(),
  )!;
  memoryRepository.formation.finish(
    execution,
    {
      sourceIds: originals.map(({ id }) => id),
      changes: [],
    },
    clock.now(),
  );

  // Seed the persisted derivation contract, not model output quality. Each
  // independent parent has a real canonical source and an exact retained span.
  const parents = originals.map((source) => {
    const detail = memoryRepository.create({
      memoryId: ids.generate(),
      revisionId: ids.generate(),
      content: source.content,
      type: "event",
      confidence: 1,
      importance: 0.5,
      reason: "用户原始陈述",
      now: clock.now(),
      sources: [memoryRepository.formation.sourceProvenance(source.id)],
    });
    memoryRepository.recall.putSemantics(
      detail.memory.currentRevisionId,
      {
        kind: "episode",
        owner: "user",
        basis: "explicit_user_statement",
        qualifiers: {},
      },
      [],
    );
    memoryRepository.recall.addSpan(
      detail.memory.currentRevisionId,
      source.id,
      0,
      source.content.length,
      source.content,
    );
    return detail;
  });
  const summary = memoryRepository.create({
    memoryId: ids.generate(),
    revisionId: ids.generate(),
    content: "和爸爸做纸灯，承载着河边的回忆和下一次相聚的期待。",
    type: "agent_learning",
    confidence: 0.5,
    importance: 0.5,
    reason: "两条原始事件的派生总结",
    now: clock.now(),
    sources: originals.map(({ id }) =>
      memoryRepository.formation.sourceProvenance(id),
    ),
  });
  memoryRepository.recall.putSemantics(
    summary.memory.currentRevisionId,
    {
      kind: "reflection",
      owner: "user",
      basis: "inference",
      qualifiers: {
        consolidationVersion: MEMORY_CONSOLIDATION_VERSION,
        consolidationDependencyCount: "2",
        account: "episode_summary",
      },
    },
    [],
  );
  for (const [index, source] of originals.entries()) {
    memoryRepository.recall.addSpan(
      summary.memory.currentRevisionId,
      source.id,
      0,
      source.content.length,
      source.content,
    );
    memoryRepository.recall.link(
      summary.memory.currentRevisionId,
      parents[index]!.memory.currentRevisionId,
      "derived_from",
      source.id,
      dependencyUse,
    );
  }
  const reference: MemoryEvidenceReference = {
    memoryId: summary.memory.id,
    revisionId: summary.memory.currentRevisionId,
    use: "current",
  };
  const evidenceRequest = {
    personaId: persona.personaId,
    references: [reference],
    resourceBudget: { maxReadBytes: 6000 },
  };
  expect(memory.validateEvidenceReferences(evidenceRequest)).toEqual([]);
  expect(
    requireResolvedItems(memory.resolveEvidence(evidenceRequest))[0]?.derivation
      ?.sourceRevisionCount,
  ).toBe(2);

  const repository = new TerritoryWorldRepository(database, ids);
  repository.ensureInitialized(createStarterTerritoryWorldSeed(clock.now()));
  const assets = new TerritoryWorldAssetStore(path.join(directory, "assets"), {
    normalize: (_source, size) => png(size.width, size.height),
  });
  const installs = vi.spyOn(assets, "prepareInstall");
  const installedAsset = () => {
    const result = installs.mock.results[0];
    if (result?.type !== "return")
      throw new Error("No actual asset install returned");
    return result.value;
  };
  const candidates = new TerritoryWorldCandidateService(
    repository,
    assets,
    runtimes,
    ids,
    clock,
    (sources) =>
      assertTerritoryMemorySources(memory, persona.personaId, sources),
  );
  const sourceService = new TerritoryWorldMemoryService(
    repository,
    memory,
    {
      getDigest: () => {
        throw new Error("Activity is not used by this fixture");
      },
    },
    clock,
    () => persona.personaId,
    candidates,
  );
  const world = new TerritoryWorldService(
    repository,
    clock,
    candidates,
    assets,
  );
  const before = repository.getSnapshot();
  const viewRequest = {
    zoneId: before.world.activeZoneId,
    revisionId: before.world.currentRevision.id,
  };
  const beforeView = world.getZoneView(viewRequest);
  const track = (job: TerritoryWorldCandidateJob) => {
    pending.push(job.completion);
    return job;
  };

  return {
    directory,
    database,
    memory,
    memoryRepository,
    originals,
    parents,
    summary,
    reference,
    evidenceRequest,
    repository,
    assets,
    installs,
    installedAsset,
    candidates,
    runtimes,
    world,
    before,
    begin: () =>
      track(
        sourceService.beginSourceCandidate({
          source: { kind: "memory", memoryId: summary.memory.id },
        }),
      ),
    beginHistorical: (refs: MemoryEvidenceReference[]) => {
      const request: TerritoryCreateChangeCandidateRequest = {
        baseRevisionId: before.world.currentRevision.id,
        intent: "item",
        lockedInstanceIds: [],
        prompt: "代表过去纸灯回忆的纪念物",
        providerProfileId: null,
        scope: { kind: "zone", zoneId: before.world.activeZoneId },
        sources: [
          {
            kind: "chat_moment",
            id: "a".repeat(64),
            momentKey: "a".repeat(64),
            chatId: ids.generate(),
            messageId: ids.generate(),
            runId: ids.generate(),
            attachments: [],
            label: "回望以前做纸灯的日子",
            occurredAt: clock.now(),
            personaRef: {
              personaId: persona.personaId,
              revision: persona.revision,
            },
            memoryRevisions: refs,
          },
        ],
      };
      return track(candidates.beginCreate(request));
    },
    change: (kind: "correction" | "retained_history" | "delete" | "purge") => {
      clock.advance(1000);
      const parent = parents[0]!.memory.id;
      if (kind === "correction" || kind === "retained_history")
        memoryRepository.revise({
          memoryId: parent,
          revisionId: ids.generate(),
          predecessorRevisionId: parents[0]!.memory.currentRevisionId,
          priorDispositions: [
            {
              revisionId: parents[0]!.memory.currentRevisionId,
              disposition:
                kind === "correction" ? "corrected" : "retained_history",
            },
          ],
          content:
            kind === "correction"
              ? "更正一下，之前在河边做纸灯的是妈妈，不是爸爸。"
              : "以前确实和爸爸在河边做纸灯；现在改在家里一起做。",
          reason:
            kind === "correction" ? "用户纠正父事实" : "当时真实的安排后来改变",
          sources: [],
          now: clock.now(),
        });
      else {
        memory.delete(parent);
        if (kind === "purge") memory.purge(parent);
      }
      // This is the regression trigger: only the dependency changed.
      expect(memory.get(summary.memory.id)).toEqual(summary);
    },
    expectUnavailable: () => {
      expect(memory.validateEvidenceReferences(evidenceRequest)).toEqual([
        reference,
      ]);
      expect(memory.resolveEvidence(evidenceRequest)).toMatchObject({
        status: "unavailable",
      });
      expect(
        memoryRepository.recall.unavailableDerivationReasons(
          [reference.revisionId],
          clock.now(),
        ),
      ).toEqual([
        `derived_memory_dependency_unavailable:${reference.revisionId}`,
      ]);
    },
    expectWorldUnchanged: () => {
      expect(world.getSnapshot().world).toEqual(before.world);
      expect(world.getZoneView(viewRequest)).toEqual(beforeView);
    },
    expectAssetRemoved: async () => {
      expect(installs).toHaveBeenCalledOnce();
      const installed = await installedAsset();
      expect(installed.created).toBe(true);
      expect(repository.getStoredAsset(installed.asset.id)).toBeUndefined();
      expect(
        existsSync(path.join(directory, "assets", installed.storageKey)),
      ).toBe(false);
      expect(
        repository
          .getSnapshot()
          .assets.filter(({ origin }) => origin === "generated"),
      ).toEqual([]);
    },
  };
}

describe("Territory consumes actual Memory derivation eligibility", () => {
  it.each(["correction", "delete", "purge"] as const)(
    "rejects a derived source before generation after parent %s, despite unchanged summary revision",
    (change) => {
      const f = fixture();
      f.change(change);
      f.expectUnavailable();
      expect(() => f.begin()).toThrow("记忆或其依据已变化");
      expect(f.runtimes.generate).not.toHaveBeenCalled();
      expect(f.installs).not.toHaveBeenCalled();
      expect(f.repository.getSnapshot().candidates).toEqual([]);
      f.expectWorldUnchanged();
    },
  );

  it.each(["correction", "delete", "purge"] as const)(
    "rolls back the actual generated asset after parent %s during generation",
    async (change) => {
      const f = fixture();
      const job = f.begin();
      await f.runtimes.started.promise;
      f.change(change);
      f.expectUnavailable();
      f.runtimes.finish();
      const result = await job.completion;
      expect(
        result.snapshot.candidates.find(
          ({ id }) => id === job.initial.candidateId,
        ),
      ).toMatchObject({
        status: "failed",
        error: { code: "TERRITORY.SOURCE_NOT_FOUND" },
        changeSet: null,
      });
      f.expectWorldUnchanged();
      await f.expectAssetRemoved();
    },
  );

  it.each(["correction", "delete", "purge"] as const)(
    "rejects ready preview application after parent %s and reclaims it on cancellation",
    async (change) => {
      const f = fixture();
      f.runtimes.finish();
      const job = f.begin();
      const ready = await job.completion;
      expect(
        ready.snapshot.candidates.find(({ id }) => id === ready.candidateId)
          ?.status,
      ).toBe("ready");
      const installed = await f.installedAsset();
      expect(f.repository.getStoredAsset(installed.asset.id)).toBeDefined();
      expect(
        existsSync(path.join(f.directory, "assets", installed.storageKey)),
      ).toBe(true);
      f.change(change);
      f.expectUnavailable();
      expect(() =>
        f.world.applyCandidate({ candidateId: ready.candidateId }),
      ).toThrow("记忆或其依据已变化");
      f.expectWorldUnchanged();
      // Ready previews stay reviewable until the existing cancel action retires
      // them; a failed apply does not silently delete the user's preview.
      expect(
        f.repository
          .getSnapshot()
          .candidates.find(({ id }) => id === ready.candidateId)?.status,
      ).toBe("ready");
      await f.world.cancelCandidate({ candidateId: ready.candidateId });
      await f.expectAssetRemoved();
      f.expectWorldUnchanged();
    },
  );

  it("keeps true past parent evidence and its historical derivation usable after a later change", async () => {
    const f = fixture("history");
    const historical: MemoryEvidenceReference[] = [
      {
        memoryId: f.parents[0]!.memory.id,
        revisionId: f.parents[0]!.memory.currentRevisionId,
        use: "history",
      },
      { ...f.reference, use: "history" },
    ];
    const job = f.beginHistorical(historical);
    await f.runtimes.started.promise;
    f.change("retained_history");
    expect(
      f.memory.validateEvidenceReferences({
        ...f.evidenceRequest,
        references: historical,
      }),
    ).toEqual([]);
    f.runtimes.finish();
    const ready = await job.completion;
    expect(
      ready.snapshot.candidates.find(({ id }) => id === ready.candidateId),
    ).toMatchObject({
      status: "ready",
      sources: [{ memoryRevisions: historical }],
    });
    const applied = f.world.applyCandidate({ candidateId: ready.candidateId });
    expect(applied.snapshot.world.currentRevision.sequence).toBe(
      f.before.world.currentRevision.sequence + 1,
    );
    expect(
      applied.snapshot.candidates.find(({ id }) => id === ready.candidateId)
        ?.status,
    ).toBe("applied");
    const installed = await f.installedAsset();
    expect(f.repository.getStoredAsset(installed.asset.id)).toBeDefined();
    expect(await f.assets.read(installed)).toEqual(
      png(installed.asset.width, installed.asset.height),
    );
    expect(
      f.repository.findInstanceBySource("chat_moment", "a".repeat(64)),
    ).toBeDefined();
  });

  it.each(["before_generation", "during_generation", "before_apply"] as const)(
    "rejects a corrected historical dependency %s even when requested as history",
    async (boundary) => {
      const f = fixture("history");
      const historical = [{ ...f.reference, use: "history" as const }];
      if (boundary === "before_generation") {
        f.change("correction");
        expect(() => f.beginHistorical(historical)).toThrow(
          "记忆或其依据已变化",
        );
        expect(f.runtimes.generate).not.toHaveBeenCalled();
      } else {
        const job = f.beginHistorical(historical);
        await f.runtimes.started.promise;
        if (boundary === "during_generation") f.change("correction");
        f.runtimes.finish();
        const result = await job.completion;
        if (boundary === "during_generation") {
          expect(result.snapshot.candidates[0]).toMatchObject({
            status: "failed",
            error: { code: "TERRITORY.SOURCE_NOT_FOUND" },
          });
          await f.expectAssetRemoved();
        } else {
          expect(result.snapshot.candidates[0]?.status).toBe("ready");
          f.change("correction");
          expect(() =>
            f.world.applyCandidate({ candidateId: result.candidateId }),
          ).toThrow("记忆或其依据已变化");
          await f.world.cancelCandidate({ candidateId: result.candidateId });
          await f.expectAssetRemoved();
        }
      }
      f.expectWorldUnchanged();
    },
  );

  it("does not turn a broken current dependency into valid evidence merely by requesting history", () => {
    const f = fixture("current");
    f.change("correction");
    const historical = [{ ...f.reference, use: "history" as const }];
    expect(
      f.memory.validateEvidenceReferences({
        ...f.evidenceRequest,
        references: historical,
      }),
    ).toEqual(historical);
    expect(() => f.beginHistorical(historical)).toThrow("记忆或其依据已变化");
    expect(f.runtimes.generate).not.toHaveBeenCalled();
  });

  it("preserves a valid derivation when canonical raw text is released but its exact quotes remain", async () => {
    const f = fixture();
    const job = f.begin();
    await f.runtimes.started.promise;
    for (const source of f.originals)
      expect(f.memory.releaseCanonicalSource(source.id)).toBe(true);
    expect(f.memory.validateEvidenceReferences(f.evidenceRequest)).toEqual([]);
    expect(
      requireResolvedItems(f.memory.resolveEvidence(f.evidenceRequest))[0]
        ?.derivation?.sourceRevisionCount,
    ).toBe(2);
    f.runtimes.finish();
    const ready = await job.completion;
    const applied = f.world.applyCandidate({ candidateId: ready.candidateId });
    expect(
      applied.snapshot.candidates.find(({ id }) => id === ready.candidateId)
        ?.status,
    ).toBe("applied");
    expect(
      f.repository.findInstanceBySource("memory", f.reference.memoryId),
    ).toBeDefined();
  });
});

function requireResolvedItems(value: MemoryEvidenceResolution) {
  expect(value.status).toBe("resolved");
  if (value.status !== "resolved")
    throw new Error("Expected complete Memory read");
  return value.items;
}
