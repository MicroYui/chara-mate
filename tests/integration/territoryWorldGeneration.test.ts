import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
import type { EntityId } from "../../src/shared/contracts/primitives";
import type { IdGenerator } from "../../src/shared/pure/id";
import { validateTerritoryZoneSpatialState } from "../../src/shared/pure/territoryWorldGrid";
import { FakeClock } from "../fixtures/fakeClock";

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
>(runtimes: TRuntimes = new FakeRuntimes() as unknown as TRuntimes) {
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
  );
  return { assets, database, normalizations, repository, runtimes, service };
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
