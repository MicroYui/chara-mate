import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import type { TerritoryImageRenderOptions } from "../../src/main/providers/azureImageProvider";
import { ProviderError } from "../../src/main/providers/providerError";
import { TerritoryWorldAssetStore } from "../../src/main/territory/territoryWorldAssetStore";
import {
  TerritoryWorldCandidateService,
  type TerritoryWorldImageRuntimeFactory,
} from "../../src/main/territory/territoryWorldCandidateService";
import { TerritoryWorldRepository } from "../../src/main/territory/territoryWorldRepository";
import { TerritoryWorldService } from "../../src/main/territory/territoryWorldService";
import { createStarterTerritoryWorldSeed } from "../../src/main/territory/territoryStarterWorld";
import {
  FIXTURE_IDS,
  personaSnapshotFixture,
  chatFixture,
  messageFixture,
  runFixture,
} from "../fixtures/foundationContracts";
import type {
  TerritoryCreateChangeCandidateRequest,
  TerritoryWorldSnapshot,
} from "../../src/shared/contracts/territoryWorld";
import { ToolRegistry } from "../../src/main/tools/toolRegistry";
import { registerTerritoryTools } from "../../src/main/territory/territoryTools";
import { TerritoryMomentService } from "../../src/main/territory/territoryMomentService";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { RunRepository } from "../../src/main/agent/runRepository";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { RunEventService } from "../../src/main/agent/runEventService";
import { DEFAULT_COMPANION_INITIATIVE_SETTINGS } from "../../src/shared/contracts/settings";
import type { MemoryEvidenceReference } from "../../src/shared/contracts/memoryRecall";
import { TerritoryError } from "../../src/main/territory/territoryError";
import type { EntityId } from "../../src/shared/contracts/primitives";
import type { IdGenerator } from "../../src/shared/pure/id";
import { validateTerritoryZoneSpatialState } from "../../src/shared/pure/territoryWorldGrid";
import { FakeClock } from "../fixtures/fakeClock";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import { PersonaRepository } from "../../src/main/persona/personaRepository";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import {
  assertTerritoryMemorySources,
  TerritoryWorldMemoryService,
} from "../../src/main/territory/territoryWorldMemoryService";

class CounterIds implements IdGenerator {
  #value = 0;

  generate(): EntityId {
    this.#value += 1;
    return `70000000-0000-4000-8000-${String(this.#value).padStart(12, "0")}`;
  }
}

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

class FakeRuntimes implements TerritoryWorldImageRuntimeFactory {
  readonly calls: {
    kind: "edit" | "generate";
    options: TerritoryImageRenderOptions;
    prompt: string;
  }[] = [];

  constructor(private readonly error?: ProviderError) {}

  resolveImageProfileId(): string {
    if (this.error) throw this.error;
    return "20000000-0000-4000-8000-000000000001";
  }

  createImageProvider(): ReturnType<
    TerritoryWorldImageRuntimeFactory["createImageProvider"]
  > {
    return Promise.resolve({
      edit: (
        _image: Buffer,
        prompt: string,
        options: TerritoryImageRenderOptions,
      ) => {
        this.calls.push({ kind: "edit", options, prompt });
        return Promise.resolve(Buffer.from("edited"));
      },
      generate: (prompt: string, options: TerritoryImageRenderOptions) => {
        this.calls.push({ kind: "generate", options, prompt });
        return Promise.resolve(Buffer.from("generated"));
      },
    });
  }
}

class BlockingRuntimes implements TerritoryWorldImageRuntimeFactory {
  readonly started: Promise<void>;
  private signalStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.signalStarted = resolve;
    });
  }

  resolveImageProfileId(): string {
    return "20000000-0000-4000-8000-000000000001";
  }

  createImageProvider(): ReturnType<
    TerritoryWorldImageRuntimeFactory["createImageProvider"]
  > {
    const render = (
      _prompt: string,
      _options: TerritoryImageRenderOptions,
      signal?: AbortSignal,
    ): Promise<Buffer> => {
      this.signalStarted();
      return new Promise<Buffer>((_resolve, reject) => {
        const abort = () => reject(new DOMException("cancelled", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    };
    return Promise.resolve({
      edit: (
        _image: Buffer,
        prompt: string,
        options: TerritoryImageRenderOptions,
        signal?: AbortSignal,
      ) => render(prompt, options, signal),
      generate: render,
    });
  }
}

let directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  directories = [];
});

async function fixture<
  TRuntimes extends TerritoryWorldImageRuntimeFactory = FakeRuntimes,
>(
  runtimes: TRuntimes = new FakeRuntimes() as unknown as TRuntimes,
  onChanged?: (snapshot: TerritoryWorldSnapshot) => void,
  assertSourcesValid: TerritoryWorldCandidateService["assertSourcesValid"] = () =>
    undefined,
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "territory-generation-"),
  );
  directories.push(directory);
  const database = openApplicationDatabase(
    path.join(directory, "world.sqlite"),
  );
  const ids = new CounterIds();
  const repository = new TerritoryWorldRepository(database, ids);
  repository.ensureInitialized(
    createStarterTerritoryWorldSeed("2026-08-13T10:00:00.000Z"),
  );
  const normalizations: Array<{
    removeBackground: boolean;
    size: { readonly height: number; readonly width: number };
  }> = [];
  const assets = new TerritoryWorldAssetStore(path.join(directory, "assets"), {
    normalize: (_source, size, options) => {
      normalizations.push({ removeBackground: options.removeBackground, size });
      return png(size.width, size.height);
    },
  });
  const service = new TerritoryWorldCandidateService(
    repository,
    assets,
    runtimes,
    ids,
    new FakeClock("2026-08-13T10:01:00.000Z"),
    assertSourcesValid,
    onChanged,
  );
  return {
    assets,
    database,
    directory,
    normalizations,
    repository,
    runtimes,
    service,
  };
}

describe("Territory World AI generation", () => {
  it("returns a generating candidate immediately and cancels the background job", async () => {
    const runtimes = new BlockingRuntimes();
    const { database, repository, service } = await fixture(runtimes);
    const snapshot = repository.getSnapshot();
    const job = service.beginCreate({
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: "item",
      lockedInstanceIds: [],
      prompt: "一枚正在缓慢发光的月相徽章",
      providerProfileId: null,
      scope: { kind: "zone", zoneId: snapshot.world.activeZoneId },
      sources: [],
    });
    expect(job.initial.snapshot.candidates[0]).toMatchObject({
      id: job.initial.candidateId,
      status: "generating",
    });
    await runtimes.started;
    const cancelled = await service.cancelCandidate(job.initial.candidateId);
    expect(cancelled.snapshot.candidates[0]?.status).toBe("cancelled");
    await expect(job.completion).resolves.toMatchObject({
      candidateId: job.initial.candidateId,
      snapshot: { candidates: [{ status: "cancelled" }] },
    });
    expect(repository.getSnapshot().world.currentRevision.id).toBe(
      snapshot.world.currentRevision.id,
    );
    database.close();
  });

  it("generates and atomically applies an editable item", async () => {
    const { database, normalizations, repository, runtimes, service } =
      await fixture();
    const snapshot = repository.getSnapshot();
    const result = await service.create({
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: "item",
      itemContent: {
        description: "玻璃灯把雨声收进一圈柔光里，夜深时仍替桌边留着温度。",
        name: "听雨玻璃灯",
      },
      lockedInstanceIds: [],
      prompt: "透明玻璃灯，黄铜底座，雨滴纹理与柔和暖光",
      providerProfileId: null,
      scope: { kind: "zone", zoneId: snapshot.world.activeZoneId },
      sources: [],
    });
    expect(result.snapshot.candidates[0]).toMatchObject({
      intent: "item",
      providerProfileId: "20000000-0000-4000-8000-000000000001",
      status: "ready",
    });
    expect(runtimes.calls[0]).toMatchObject({
      kind: "generate",
      options: { background: "opaque", size: "1024x1024" },
    });
    expect(normalizations[0]).toMatchObject({ removeBackground: true });
    const applied = repository.applyCandidate(
      result.candidateId,
      "2026-08-13T10:02:00.000Z",
    );
    const generatedDefinition = applied.definitions.find(({ id }) =>
      id.startsWith("generated.item."),
    );
    expect(generatedDefinition).toMatchObject({
      description: "玻璃灯把雨声收进一圈柔光里，夜深时仍替桌边留着温度。",
      name: "听雨玻璃灯",
    });
    expect(generatedDefinition?.description).not.toContain("黄铜底座");
    expect(applied.assets.some(({ origin }) => origin === "generated")).toBe(
      true,
    );
    expect(
      applied.assetPacks.some(({ id }) => id.startsWith("generated.pack.")),
    ).toBe(true);
    database.close();
  });

  it("creates a poetic host fallback instead of displaying a raw visual prompt", async () => {
    const { database, repository, service } = await fixture();
    const snapshot = repository.getSnapshot();
    const rawPrompt = "一枚透明水晶月相徽章，opaque magenta background";

    const result = await service.create({
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: "item",
      lockedInstanceIds: [],
      prompt: rawPrompt,
      providerProfileId: null,
      scope: { kind: "zone", zoneId: snapshot.world.activeZoneId },
      sources: [],
    });
    const definition = result.snapshot.candidates[0]?.changeSet?.mutations.find(
      (mutation) => mutation.kind === "definition.put",
    );

    expect(definition?.kind).toBe("definition.put");
    if (definition?.kind === "definition.put") {
      expect(definition.definition.description).not.toBe(rawPrompt);
      expect(definition.definition.description).not.toContain("magenta");
      expect(definition.definition.description).toContain("日常");
    }
    database.close();
  });

  it("creates immutable Definition revisions when repainting a selection", async () => {
    const { database, repository, service } = await fixture();
    const snapshot = repository.getSnapshot();
    const view = repository.getZoneView({
      revisionId: snapshot.world.currentRevision.id,
      zoneId: snapshot.world.activeZoneId,
    });
    const desk = view.instances.find(
      ({ definition }) => definition.id === "starter.writing-desk",
    )!;
    const result = await service.create({
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: "selection",
      lockedInstanceIds: [],
      prompt: "改成深色胡桃木，保留轮廓",
      providerProfileId: null,
      scope: { instanceIds: [desk.id], kind: "entities", zoneId: view.zone.id },
      sources: [],
    });
    const definitionChange =
      result.snapshot.candidates[0]?.changeSet?.mutations.find(
        (mutation) => mutation.kind === "definition.put",
      );
    expect(definitionChange).toMatchObject({
      definition: { id: "starter.writing-desk", revision: 2 },
      kind: "definition.put",
    });
    database.close();
  });

  it("redesigns a Zone while preserving locked structures", async () => {
    const { database, normalizations, repository, runtimes, service } =
      await fixture();
    const snapshot = repository.getSnapshot();
    const view = repository.getZoneView({
      revisionId: snapshot.world.currentRevision.id,
      zoneId: snapshot.world.activeZoneId,
    });
    const wall = view.instances.find(
      ({ definition }) => definition.id === "starter.cabin-wall",
    )!;
    const result = await service.create({
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: "zone",
      lockedInstanceIds: [wall.id],
      prompt: "改成月光下的玻璃花房",
      providerProfileId: null,
      scope: { kind: "zone", zoneId: view.zone.id },
      sources: [],
    });
    expect(result.snapshot.candidates[0]).toMatchObject({ status: "ready" });
    const zoneCandidate = result.snapshot.candidates[0]!;
    const packChange = zoneCandidate.changeSet?.mutations.find(
      (mutation) => mutation.kind === "asset-pack.put",
    );
    expect(
      zoneCandidate.previewGroups.find(({ action }) => action === "replace")
        ?.changeIds,
    ).toContain(packChange?.changeId);
    expect(
      result.snapshot.candidates[0]?.changeSet?.mutations.some(
        (mutation) =>
          mutation.kind === "instance.put" && mutation.instance.id === wall.id,
      ),
    ).toBe(false);
    expect(runtimes.calls[0]?.options).toMatchObject({
      background: "opaque",
      quality: "high",
      size: "1536x960",
    });
    expect(normalizations[0]).toMatchObject({ removeBackground: false });
    expect(runtimes.calls).toHaveLength(21);
    expect(
      runtimes.calls
        .slice(1)
        .every(
          ({ kind, options }) =>
            kind === "generate" &&
            options.quality === "high" &&
            options.size === "1024x1024",
        ),
    ).toBe(true);
    expect(
      normalizations.slice(1).every(({ removeBackground }) => removeBackground),
    ).toBe(true);
    const zoneDefinitions = zoneCandidate.changeSet?.mutations.filter(
      (mutation) =>
        mutation.kind === "definition.put" &&
        mutation.definition.id.startsWith("generated.zone-piece."),
    );
    expect(zoneDefinitions).toHaveLength(20);
    expect(
      zoneDefinitions?.every(
        (mutation) =>
          mutation.kind === "definition.put" &&
          !mutation.definition.description.includes("生成主题") &&
          !mutation.definition.description.includes("改成月光下的玻璃花房"),
      ),
    ).toBe(true);
    const applied = repository.applyCandidate(
      result.candidateId,
      "2026-08-13T10:02:00.000Z",
    );
    const generatedView = repository.getZoneView({
      revisionId: applied.world.currentRevision.id,
      zoneId: view.zone.id,
    });
    expect(validateTerritoryZoneSpatialState(generatedView)).toEqual([]);
    expect(
      generatedView.instances.filter(({ definition }) =>
        definition.id.startsWith("generated.zone-piece."),
      ),
    ).toHaveLength(22);
    database.close();
  });

  it("regenerates a candidate while excluding one semantic change group", async () => {
    const { database, repository, runtimes, service } = await fixture();
    const snapshot = repository.getSnapshot();
    const first = await service.create({
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: "zone",
      lockedInstanceIds: [],
      prompt: "改成月光下的玻璃花房",
      providerProfileId: null,
      scope: { kind: "zone", zoneId: snapshot.world.activeZoneId },
      sources: [],
    });
    const candidate = first.snapshot.candidates.find(
      ({ id }) => id === first.candidateId,
    )!;
    const moveGroup = candidate.previewGroups.find(
      ({ action }) => action === "move",
    )!;
    const firstAssetId = candidate.changeSet?.mutations.find(
      (mutation) => mutation.kind === "definition.put",
    );
    expect(firstAssetId?.kind).toBe("definition.put");

    const regenerated = await service.edit({
      candidateId: first.candidateId,
      excludedChangeIds: moveGroup.changeIds,
      instruction: "增加雨水反光，但保留原有墙面",
      lockedInstanceIds: [],
    });
    const next = regenerated.snapshot.candidates.find(
      ({ id }) => id === first.candidateId,
    )!;
    expect(next.status).toBe("ready");
    expect(next.previewGroups.some(({ action }) => action === "move")).toBe(
      false,
    );
    expect(
      next.changeSet?.mutations.some(
        (mutation) =>
          mutation.kind === "instance.put" &&
          mutation.instance.definition.id === "starter.cabin-wall",
      ),
    ).toBe(false);
    expect(runtimes.calls).toHaveLength(42);
    if (firstAssetId?.kind === "definition.put") {
      expect(
        repository.getStoredAsset(firstAssetId.definition.visual.assetId),
      ).toBeUndefined();
    }
    database.close();
  });

  it("adds a connected Zone that remains valid after apply", async () => {
    const { database, repository, service } = await fixture();
    const snapshot = repository.getSnapshot();
    const result = await service.create({
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: "expansion",
      lockedInstanceIds: [],
      prompt: "通向萤火花园的小径",
      providerProfileId: null,
      scope: {
        direction: "east",
        fromZoneId: snapshot.world.activeZoneId,
        kind: "expansion",
      },
      sources: [],
    });
    const applied = repository.applyCandidate(
      result.candidateId,
      "2026-08-13T10:03:00.000Z",
    );
    expect(applied.world.zones).toHaveLength(2);
    expect(applied.world.connections).toHaveLength(1);
    const addedZone = applied.world.zones.find(
      ({ id }) => id !== snapshot.world.activeZoneId,
    )!;
    const world = new TerritoryWorldService(
      repository,
      new FakeClock("2026-08-13T10:04:00.000Z"),
    );
    const entered = world.enterZone({
      fromZoneId: snapshot.world.activeZoneId,
      toZoneId: addedZone.id,
    });
    expect(entered.world.activeZoneId).toBe(addedZone.id);
    expect(entered.pet.zoneId).toBe(addedZone.id);
    expect(entered.world.currentRevision.sequence).toBe(
      applied.world.currentRevision.sequence + 1,
    );
    database.close();
  });

  it("purges generated Definitions, candidate projections, and asset files", async () => {
    const { assets, database, repository, service } = await fixture();
    const snapshot = repository.getSnapshot();
    const generated = await service.create({
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: "item",
      lockedInstanceIds: [],
      prompt: "一只会发出萤火微光的玻璃罐",
      providerProfileId: null,
      scope: { kind: "zone", zoneId: snapshot.world.activeZoneId },
      sources: [],
    });
    const applied = repository.applyCandidate(
      generated.candidateId,
      "2026-08-13T10:02:00.000Z",
    );
    const definition = applied.definitions.find(({ id }) =>
      id.startsWith("generated.item."),
    )!;
    const instance = repository
      .getCurrentState()
      .instances.find(
        ({ definition: reference }) => reference.id === definition.id,
      )!;
    const stored = repository.getStoredAsset(definition.visual.assetId)!;
    const pack = applied.assetPacks.find(({ assets: entries }) =>
      entries.some(({ assetId }) => assetId === stored.asset.id),
    )!;
    await expect(assets.resolve(stored)).resolves.toContain(
      definition.visual.assetId,
    );
    const trashed = {
      ...instance,
      status: "trashed" as const,
      trashedAt: "2026-08-13T10:03:00.000Z",
      updatedAt: "2026-08-13T10:03:00.000Z",
    };
    const trashedSnapshot = repository.commitChangeSet({
      changeSet: {
        baseRevisionId: applied.world.currentRevision.id,
        id: repository.nextId(),
        label: "删除生成物件",
        mutations: [
          {
            changeId: repository.nextId(),
            instance: trashed,
            kind: "instance.put",
          },
        ],
      },
      now: "2026-08-13T10:03:00.000Z",
      reason: "direct",
    });
    const world = new TerritoryWorldService(
      repository,
      new FakeClock("2026-08-13T10:04:00.000Z"),
      undefined,
      assets,
    );
    const purged = await world.purgeInstance({ instanceId: instance.id });
    expect(purged.world.currentRevision.sequence).toBe(
      trashedSnapshot.world.currentRevision.sequence + 1,
    );
    expect(purged.definitions.some(({ id }) => id === definition.id)).toBe(
      false,
    );
    expect(purged.assets.some(({ id }) => id === stored.asset.id)).toBe(false);
    expect(purged.assetPacks.some(({ id }) => id === pack.id)).toBe(false);
    expect(
      purged.candidates.some(({ id }) => id === generated.candidateId),
    ).toBe(false);
    await expect(assets.resolve(stored)).rejects.toThrow();
    database.close();
  });

  it("persists provider failures without changing the World revision", async () => {
    const runtimes = new FakeRuntimes(
      new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "缺少图片模型",
        false,
      ),
    );
    const { database, repository, service } = await fixture(runtimes);
    const snapshot = repository.getSnapshot();
    const result = await service.create({
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: "item",
      lockedInstanceIds: [],
      prompt: "一只陶杯",
      providerProfileId: null,
      scope: { kind: "zone", zoneId: snapshot.world.activeZoneId },
      sources: [],
    });
    expect(result.snapshot.candidates[0]).toMatchObject({
      error: { code: "PROVIDER.INVALID_CONFIGURATION" },
      status: "failed",
    });
    expect(result.snapshot.world.currentRevision.id).toBe(
      snapshot.world.currentRevision.id,
    );
    database.close();
  });
});

class DeferredImageRuntimes extends FakeRuntimes {
  private releaseImage!: (bytes: Buffer) => void;
  private markBegun!: () => void;
  readonly gate = {
    promise: new Promise<Buffer>((resolve) => {
      this.releaseImage = resolve;
    }),
    resolve: (bytes: Buffer) => this.releaseImage(bytes),
  };
  readonly begun = {
    promise: new Promise<void>((resolve) => {
      this.markBegun = resolve;
    }),
    resolve: () => this.markBegun(),
  };

  override createImageProvider(): ReturnType<
    TerritoryWorldImageRuntimeFactory["createImageProvider"]
  > {
    const generate = () => {
      this.begun.resolve();
      return this.gate.promise;
    };
    return Promise.resolve({ generate, edit: generate });
  }
}

function creationRequest(
  snapshot: TerritoryWorldSnapshot,
): TerritoryCreateChangeCandidateRequest {
  return {
    baseRevisionId: snapshot.world.currentRevision.id,
    intent: "item",
    itemContent: {
      name: "月光石",
      description: "一抹月色在小石头的边缘停下来。",
    },
    lockedInstanceIds: [],
    prompt: "柔和月光中的小石头",
    providerProfileId: null,
    scope: { kind: "zone", zoneId: snapshot.world.activeZoneId },
    sources: [
      {
        id: FIXTURE_IDS.item,
        kind: "character_creation",
        label: "月光石",
        occurredAt: "2026-08-13T10:01:00.000Z",
        personaRef: {
          personaId: personaSnapshotFixture.personaId,
          revision: personaSnapshotFixture.revision,
        },
        runId: FIXTURE_IDS.run,
      },
    ],
  };
}

function reviseWorld(
  repository: TerritoryWorldRepository,
): TerritoryWorldSnapshot {
  const snapshot = repository.getSnapshot();
  const zone = snapshot.world.zones.find(
    ({ id }) => id === snapshot.world.activeZoneId,
  )!;
  return repository.commitChangeSet({
    changeSet: {
      baseRevisionId: snapshot.world.currentRevision.id,
      id: FIXTURE_IDS.request,
      label: "用户修改房间名称",
      mutations: [
        {
          kind: "zone.put",
          changeId: FIXTURE_IDS.item,
          zone: { ...zone, name: "用户的新房间名" },
        },
      ],
    },
    now: "2026-08-13T10:02:00.000Z",
    reason: "direct",
  });
}

describe("autonomous Territory creation", () => {
  it("publishes only the atomic applied state and deduplicates a repeated Tool Item", async () => {
    const published: TerritoryWorldSnapshot[] = [];
    const { database, repository, service, runtimes } = await fixture(
      new FakeRuntimes(),
      (snapshot) => published.push(snapshot),
    );
    const before = repository.getSnapshot();
    const request = creationRequest(before);
    const validate = vi.fn();
    const result = await service.createAutonomousItem(request, validate);
    const candidate = result.snapshot.candidates.find(
      ({ id }) => id === result.candidateId,
    )!;
    expect(candidate.status).toBe("applied");
    expect(candidate.appliedRevisionId).toBe(
      result.snapshot.world.currentRevision.id,
    );
    expect(result.snapshot.world.currentRevision.sequence).toBe(
      before.world.currentRevision.sequence + 1,
    );
    expect(
      published.flatMap(({ candidates }) =>
        candidates.map(({ status }) => status),
      ),
    ).not.toContain("ready");
    expect(
      repository.findInstanceBySource("character_creation", FIXTURE_IDS.item),
    ).toBeDefined();
    expect(validate.mock.calls.length).toBeGreaterThanOrEqual(2);
    const repeated = await service.createAutonomousItem(request, validate);
    expect(repeated.candidateId).toBe(result.candidateId);
    expect(runtimes.calls).toHaveLength(1);
    database.close();
  });

  it("keeps a late image stale after a user edit and never replaces that edit", async () => {
    const runtimes = new DeferredImageRuntimes();
    const { database, repository, service } = await fixture(runtimes);
    const pending = service.createAutonomousItem(
      creationRequest(repository.getSnapshot()),
      () => undefined,
    );
    await runtimes.begun.promise;
    const edited = reviseWorld(repository);
    runtimes.gate.resolve(Buffer.from("late image"));
    const result = await pending;
    expect(result.snapshot.candidates[0]?.status).toBe("stale");
    expect(result.snapshot.world.currentRevision.id).toBe(
      edited.world.currentRevision.id,
    );
    expect(
      result.snapshot.assets.some(({ origin }) => origin === "generated"),
    ).toBe(false);
    database.close();
  });

  it.each(["abort", "source"] as const)(
    "does not apply when %s changes while an image adapter ignores cancellation",
    async (change) => {
      const runtimes = new DeferredImageRuntimes();
      const { database, repository, service } = await fixture(runtimes);
      const before = repository.getSnapshot();
      const controller = new AbortController();
      let valid = true;
      const pending = service.createAutonomousItem(
        creationRequest(before),
        () => {
          if (!valid)
            throw new TerritoryError(
              "TERRITORY.SOURCE_NOT_FOUND",
              "source deleted",
              false,
            );
        },
        controller.signal,
      );
      await runtimes.begun.promise;
      if (change === "abort") controller.abort();
      else valid = false;
      runtimes.gate.resolve(Buffer.from("late image"));
      const result = await pending;
      expect(result.snapshot.candidates[0]?.status).toBe(
        change === "abort" ? "cancelled" : "failed",
      );
      expect(result.snapshot.world.currentRevision.id).toBe(
        before.world.currentRevision.id,
      );
      expect(
        result.snapshot.assets.some(({ origin }) => origin === "generated"),
      ).toBe(false);
      database.close();
    },
  );

  it("cancels before image work starts instead of leaving a generating candidate", async () => {
    const { database, repository, service, runtimes } = await fixture();
    const controller = new AbortController();
    const pending = service.createAutonomousItem(
      creationRequest(repository.getSnapshot()),
      () => undefined,
      controller.signal,
    );
    controller.abort();
    expect((await pending).snapshot.candidates[0]?.status).toBe("cancelled");
    expect(runtimes.calls).toHaveLength(0);
    database.close();
  });

  it("atomically rolls back candidate completion and installed assets if World commit fails", async () => {
    const { database, repository, service } = await fixture();
    const before = repository.getSnapshot();
    database.exec(
      "CREATE TEMP TRIGGER fail_world_commit BEFORE INSERT ON territory_world_revisions WHEN NEW.reason = 'ai' BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END",
    );
    const result = await service.createAutonomousItem(
      creationRequest(before),
      () => undefined,
    );
    expect(result.snapshot.candidates[0]?.status).toBe("failed");
    expect(result.snapshot.world.currentRevision.id).toBe(
      before.world.currentRevision.id,
    );
    expect(
      result.snapshot.definitions.some(({ id }) =>
        id.startsWith("generated.item."),
      ),
    ).toBe(false);
    expect(
      result.snapshot.assets.some(({ origin }) => origin === "generated"),
    ).toBe(false);
    database.close();
  });

  it("stores an object in the collection when the current room has no matching anchor", async () => {
    const { database, repository, service } = await fixture();
    const initial = repository.getSnapshot();
    const view = repository.getZoneView({
      revisionId: initial.world.currentRevision.id,
      zoneId: initial.world.activeZoneId,
    });
    repository.commitChangeSet({
      changeSet: {
        baseRevisionId: initial.world.currentRevision.id,
        id: FIXTURE_IDS.request,
        label: "清空布置",
        mutations: view.instances.map((instance, index) => ({
          kind: "instance.remove",
          instanceId: instance.id,
          changeId: `73000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        })),
      },
      now: "2026-08-13T10:02:00.000Z",
      reason: "direct",
    });
    const result = await service.createAutonomousItem(
      {
        ...creationRequest(repository.getSnapshot()),
        prompt: "一张温暖的壁画",
      },
      () => undefined,
    );
    expect(result.snapshot.candidates[0]?.status).toBe("applied");
    expect(
      repository.findInstanceBySource("character_creation", FIXTURE_IDS.item)
        ?.placement,
    ).toEqual({ kind: "collection" });
    database.close();
  });

  it("restores the latest creation and rejects an old undo after a subsequent edit", async () => {
    const { database, repository, service } = await fixture();
    const before = repository.getSnapshot();
    const first = await service.createAutonomousItem(
      creationRequest(before),
      () => undefined,
    );
    const restored = repository.restoreRevision(
      before.world.currentRevision.id,
      "2026-08-13T10:03:00.000Z",
      first.snapshot.world.currentRevision.id,
    );
    expect(
      repository.findInstanceBySource("character_creation", FIXTURE_IDS.item),
    ).toBeUndefined();
    expect(restored.world.currentRevision.reason).toBe("restore");
    const edited = reviseWorld(repository);
    expect(() =>
      repository.restoreRevision(
        before.world.currentRevision.id,
        "2026-08-13T10:04:00.000Z",
        first.snapshot.world.currentRevision.id,
      ),
    ).toThrow("已有新的变化");
    expect(repository.getSnapshot().world.currentRevision.id).toBe(
      edited.world.currentRevision.id,
    );
    database.close();
  });

  it("joins an in-flight moment and only commits its shared result once", async () => {
    const runtimes = new DeferredImageRuntimes();
    const { database, repository, service } = await fixture(runtimes);
    const key = "a".repeat(64);
    const original = creationRequest(repository.getSnapshot());
    const request: TerritoryCreateChangeCandidateRequest = {
      ...original,
      sources: [
        {
          attachments: [],
          chatId: FIXTURE_IDS.chat,
          id: key,
          kind: "chat_moment",
          label: "真实的共同经历",
          memoryRevisions: [],
          messageId: FIXTURE_IDS.message,
          momentKey: key,
          occurredAt: "2026-08-13T10:01:00.000Z",
          personaRef: { personaId: FIXTURE_IDS.persona, revision: 1 },
          runId: FIXTURE_IDS.run,
        },
      ],
    };
    const validate = () => undefined;
    const first = service.beginCreateMoment(key, request, validate);
    await runtimes.begun.promise;
    const second = service.beginCreateMoment(key, request, validate);
    expect(second.completion).toBe(first.completion);
    runtimes.gate.resolve(Buffer.from("shared image"));
    const [a, b] = await Promise.all([first.completion, second.completion]);
    expect(a.candidateId).toBe(b.candidateId);
    expect(a.snapshot.candidates[0]?.status).toBe("applied");
    expect(a.snapshot.world.currentRevision.sequence).toBe(2);
    database.close();
  });
});

async function memoryFixture<
  TRuntimes extends TerritoryWorldImageRuntimeFactory,
>(runtimes: TRuntimes) {
  const f: Awaited<ReturnType<typeof fixture<TRuntimes>>> = await fixture(
    runtimes,
    undefined,
    (sources) => assertTerritoryMemorySources(memory, personaId, sources),
  );
  const clock = new FakeClock("2026-08-13T10:01:00.000Z");
  const personas = new PersonaRepository(f.database);
  personas.initialize(clock.now());
  const personaId = personas.getActiveSnapshot().personaId;
  const memory = new MemoryService(
    new MemoryRepository(f.database),
    { search: () => [] },
    new CryptoIdGenerator(),
    clock,
  );
  const detail = memory.create({
    content: "周末一起做纸灯。",
    confidence: 1,
    importance: 0.5,
    reason: "用户留下的约定",
    sources: [],
    type: "commitment",
  });
  const source: TerritoryCreateChangeCandidateRequest["sources"][number] = {
    kind: "memory",
    id: detail.memory.id,
    revisionId: detail.memory.currentRevisionId,
    label: "一起做纸灯",
    occurredAt: clock.now(),
  };
  const request: TerritoryCreateChangeCandidateRequest = {
    ...creationRequest(f.repository.getSnapshot()),
    sources: [source],
  };
  const world = new TerritoryWorldService(
    f.repository,
    clock,
    f.service,
    f.assets,
  );
  const sourceService = new TerritoryWorldMemoryService(
    f.repository,
    memory,
    {
      getDigest: () => {
        throw new Error("Activity is not part of this fixture");
      },
    },
    clock,
    () => personaId,
    f.service,
  );
  const revise = () =>
    memory.revise({
      memoryId: detail.memory.id,
      content: "周末先休息，纸灯留到下次。",
      reason: "用户改变安排",
      sources: [],
    });
  // This boundary fixture explicitly supplies the Formation disposition. A
  // manual edit alone has no evidence that the former claim was ever true.
  const retainPriorCommitment = () =>
    new MemoryRepository(f.database).revise({
      memoryId: detail.memory.id,
      revisionId: randomUUID(),
      predecessorRevisionId: detail.memory.currentRevisionId,
      priorDispositions: [
        {
          revisionId: detail.memory.currentRevisionId,
          disposition: "retained_history",
        },
      ],
      content: "之前确实约好周末做纸灯；现在改约到下周。",
      reason: "原约定当时有效，随后改期",
      sources: [],
      now: clock.now(),
    });
  return {
    ...f,
    clock,
    detail,
    memory,
    request,
    revise,
    retainPriorCommitment,
    sourceService,
    world,
  };
}

describe("Territory current memory sources", () => {
  it("rejects an obsolete source before creating a preview or calling the image provider", async () => {
    const f = await memoryFixture(new FakeRuntimes());
    try {
      f.revise();
      expect(() => f.service.beginCreate(f.request)).toThrow(
        "记忆或其依据已变化",
      );
      expect(f.runtimes.calls).toHaveLength(0);
      expect(f.repository.getSnapshot().candidates).toHaveLength(0);
    } finally {
      f.database.close();
    }
  });

  it.each(["revision", "delete"] as const)(
    "does not publish an image when its memory %s changes during generation",
    async (change) => {
      const f = await memoryFixture(new DeferredImageRuntimes());
      try {
        const before = f.repository.getSnapshot();
        const pending = f.service.create(f.request);
        await f.runtimes.begun.promise;
        if (change === "revision") f.revise();
        else f.memory.delete(f.detail.memory.id);
        f.runtimes.gate.resolve(Buffer.from("late image"));
        const result = await pending;
        expect(
          result.snapshot.candidates.find(
            ({ id }) => id === result.candidateId,
          ),
        ).toMatchObject({
          status: "failed",
          error: { code: "TERRITORY.SOURCE_NOT_FOUND" },
        });
        expect(result.snapshot.world.currentRevision.id).toBe(
          before.world.currentRevision.id,
        );
        expect(
          result.snapshot.assets.some(({ origin }) => origin === "generated"),
        ).toBe(false);
      } finally {
        f.database.close();
      }
    },
  );

  it("checks again before applying a ready preview and replaces that obsolete preview with the current source", async () => {
    const f = await memoryFixture(new FakeRuntimes());
    try {
      const before = f.repository.getSnapshot();
      const first = await f.sourceService.createSourceCandidate({
        source: { kind: "memory", memoryId: f.detail.memory.id },
      });
      expect(
        first.snapshot.candidates.find(({ id }) => id === first.candidateId)
          ?.status,
      ).toBe("ready");
      const revised = f.revise();
      expect(() =>
        f.world.applyCandidate({ candidateId: first.candidateId }),
      ).toThrow("记忆或其依据已变化");
      expect(f.repository.getSnapshot().world.currentRevision.id).toBe(
        before.world.currentRevision.id,
      );
      const second = await f.sourceService.createSourceCandidate({
        source: { kind: "memory", memoryId: f.detail.memory.id },
      });
      expect(second.candidateId).not.toBe(first.candidateId);
      expect(
        second.snapshot.candidates.find(({ id }) => id === first.candidateId)
          ?.status,
      ).toBe("cancelled");
      expect(
        second.snapshot.candidates.find(({ id }) => id === second.candidateId)
          ?.sources,
      ).toMatchObject([
        { kind: "memory", revisionId: revised.memory.currentRevisionId },
      ]);
      const applied = f.world.applyCandidate({
        candidateId: second.candidateId,
      });
      expect(applied.snapshot.world.currentRevision.id).not.toBe(
        before.world.currentRevision.id,
      );
      expect(
        f.repository.findInstanceBySource("memory", f.detail.memory.id),
      ).toBeDefined();
    } finally {
      f.database.close();
    }
  });
});

function momentFixture(
  f: Awaited<ReturnType<typeof memoryFixture<DeferredImageRuntimes>>>,
  refs: MemoryEvidenceReference[],
) {
  const chats = new ChatRepository(f.database);
  chats.insertChat(chatFixture);
  const runs = new RunRepository(f.database);
  const run = {
    ...runFixture,
    persona: new PersonaRepository(f.database).getActiveSnapshot(),
  };
  runs.appendEvent({
    event: { type: "run.started", run },
    streamId: run.id,
    sequence: 1,
    occurredAt: f.clock.now(),
  });
  const writer = new RunEventWriter(
    runs,
    new RunEventService(runs, { publish: () => undefined }),
    new CryptoIdGenerator(),
    f.clock,
  );
  const addMessage = (text: string, older = false) => {
    const message = chats.insertMessage({
      ...messageFixture,
      id: randomUUID(),
      runId: run.id,
      content: text,
      createdAt: older ? "2026-08-01T00:00:00.000Z" : f.clock.now(),
      updatedAt: f.clock.now(),
    });
    const item = writer.startItem(run.id, "user_message", {
      messageId: message.id,
      content: text,
      steering: true,
    });
    writer.completeItem(item.id, {
      status: "completed",
      output: { messageId: message.id },
    });
    return message;
  };
  addMessage("那次一起做纸灯的晚上，让我觉得有人陪着挺好。");
  const assistant = writer.startItem(run.id, "assistant_message", {});
  writer.completeItem(assistant.id, {
    status: "completed",
    output: { memoryReferences: refs, functionCallIds: ["moment"] },
  });
  const tool = writer.startItem(run.id, "tool_call", {
    toolName: "territory.propose_moment",
    callId: "moment",
    arguments: {},
  });
  const moments = new TerritoryMomentService(
    runs,
    chats,
    f.repository,
    f.service,
    {
      getCompanionInitiative: () => ({
        ...DEFAULT_COMPANION_INITIATIVE_SETTINGS,
        territoryMomentSurprisesEnabled: true,
      }),
    },
    f.memory,
  );
  const create = () =>
    moments.createForRun(
      run.id,
      tool.id,
      {
        name: "纸灯里的夜晚",
        description: "一起折纸灯时留下的安静。",
        visualPrompt: "a small softly lit paper lantern",
      },
      new AbortController().signal,
    );
  return { chats, runs, writer, run, tool, addMessage, create };
}

describe("Territory Moment actual Run and Memory boundaries", () => {
  it("can express a valid historical recollection after its former current revision has changed", async () => {
    const f = await memoryFixture(new DeferredImageRuntimes());
    try {
      const original: MemoryEvidenceReference = {
        memoryId: f.detail.memory.id,
        revisionId: f.detail.memory.currentRevisionId,
        use: "history",
      };
      f.retainPriorCommitment();
      const m = momentFixture(f, [original]);
      const pending = m.create();
      await f.runtimes.begun.promise;
      f.runtimes.gate.resolve(Buffer.from("historical image"));
      const result = await pending;
      expect(
        result.snapshot.candidates.find(({ id }) => id === result.candidateId),
      ).toMatchObject({
        status: "applied",
        sources: [{ memoryRevisions: [original] }],
      });
    } finally {
      f.database.close();
    }
  });

  it("does not ground a historical moment in a manual edit whose former truth is unresolved", async () => {
    const f = await memoryFixture(new DeferredImageRuntimes());
    try {
      const original: MemoryEvidenceReference = {
        memoryId: f.detail.memory.id,
        revisionId: f.detail.memory.currentRevisionId,
        use: "history",
      };
      f.revise();
      await expect(momentFixture(f, [original]).create()).rejects.toMatchObject(
        {
          code: "TERRITORY.SOURCE_NOT_FOUND",
        },
      );
      expect(f.runtimes.calls).toHaveLength(0);
      expect(f.repository.getSnapshot().candidates).toHaveLength(0);
    } finally {
      f.database.close();
    }
  });

  it.each(["memory-correction", "new-message"] as const)(
    "does not apply a late generation after %s",
    async (change) => {
      const f = await memoryFixture(new DeferredImageRuntimes());
      try {
        const before = f.repository.getSnapshot().world.currentRevision.id;
        const m = momentFixture(f, [
          {
            memoryId: f.detail.memory.id,
            revisionId: f.detail.memory.currentRevisionId,
            use: "current",
          },
        ]);
        const pending = m.create();
        await f.runtimes.begun.promise;
        if (change === "memory-correction") f.revise();
        else m.addMessage("先不做纸灯了，想跟你说点别的。", true);
        f.runtimes.gate.resolve(Buffer.from("obsolete generation"));
        const result = await pending;
        expect(
          result.snapshot.candidates.find(
            ({ id }) => id === result.candidateId,
          ),
        ).toMatchObject({
          status: "failed",
          error: { code: "TERRITORY.SOURCE_NOT_FOUND" },
        });
        expect(result.snapshot.world.currentRevision.id).toBe(before);
        expect(
          result.snapshot.assets.some(({ origin }) => origin === "generated"),
        ).toBe(false);
      } finally {
        f.database.close();
      }
    },
  );
});

describe("Territory creation during actual Run receipt changes", () => {
  it.each([
    { origin: "existing conversation", hasUser: true, takeOver: true },
    { origin: "autonomous Run", hasUser: false, takeOver: true },
    { origin: "undisturbed autonomous Run", hasUser: false, takeOver: false },
  ])("finishes truthfully for $origin", async ({ hasUser, takeOver }) => {
    const f = await fixture(new DeferredImageRuntimes());
    try {
      const clock = new FakeClock("2026-08-13T10:01:00.000Z");
      const chats = new ChatRepository(f.database);
      chats.insertChat(chatFixture);
      const runs = new RunRepository(f.database);
      runs.appendEvent({
        event: { type: "run.started", run: runFixture },
        streamId: runFixture.id,
        sequence: 1,
        occurredAt: clock.now(),
      });
      const writer = new RunEventWriter(
        runs,
        new RunEventService(runs, { publish: () => undefined }),
        new CryptoIdGenerator(),
        clock,
      );
      const addMessage = (content: string, at: string) => {
        const message = chats.insertMessage({
          ...messageFixture,
          id: randomUUID(),
          runId: runFixture.id,
          content,
          createdAt: at,
          updatedAt: at,
        });
        const item = writer.startItem(runFixture.id, "user_message", {
          messageId: message.id,
          content,
          steering: true,
        });
        writer.completeItem(item.id, {
          status: "completed",
          output: { messageId: message.id },
        });
      };
      if (hasUser) addMessage("你想做点什么就自己做吧。", clock.now());
      const tool = writer.startItem(runFixture.id, "tool_call", {
        toolName: "territory.generate_item",
        callId: "create",
        arguments: {},
      });
      const world = new TerritoryWorldService(
        f.repository,
        clock,
        f.service,
        f.assets,
      );
      const registry = new ToolRegistry();
      registerTerritoryTools(registry, {
        candidates: f.service,
        runs,
        territory: world,
      });
      const before = world.getSnapshot().world.currentRevision.id;
      const controller = new AbortController();
      const resultPromise = registry.execute(
        "territory.generate_item",
        {
          name: "窗边的小灯",
          description: "在窗边留一圈温柔的光。",
          visualPrompt: "small warm desk lamp",
        },
        {
          runId: runFixture.id,
          itemId: tool.id,
          providerProfileId: runFixture.provider.profileId,
          signal: controller.signal,
          onDelta: () => undefined,
        },
      );
      await f.runtimes.begun.promise;
      if (takeOver)
        addMessage("先别做这个，来和我聊一会儿。", "2026-08-01T00:00:00.000Z");
      f.runtimes.gate.resolve(Buffer.from("completed image"));
      const result = await resultPromise;
      expect(controller.signal.aborted).toBe(false);
      expect(runs.getRun(runFixture.id)?.status).toBe("running");
      const after = world.getSnapshot();
      if (takeOver) {
        expect(result).toMatchObject({
          status: "error",
          error: { code: "TERRITORY.SOURCE_NOT_FOUND" },
        });
        expect(after.world.currentRevision.id).toBe(before);
        expect(after.candidates[0]?.status).toBe("failed");
        expect(after.assets.some((asset) => asset.origin === "generated")).toBe(
          false,
        );
        const installed = await readdir(path.join(f.directory, "assets"), {
          recursive: true,
        }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        expect(installed.filter((name) => name.endsWith(".png"))).toEqual([]);
      } else {
        expect(result).toMatchObject({
          status: "success",
          modelContent: { status: "applied" },
        });
        expect(after.world.currentRevision.id).not.toBe(before);
        expect(
          f.repository.findInstanceBySource("character_creation", tool.id),
        ).toBeDefined();
      }
    } finally {
      f.database.close();
    }
  });
});
