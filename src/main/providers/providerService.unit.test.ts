import { describe, expect, it, vi } from "vitest";

import type { ProviderProfileDraft } from "../../shared/contracts/provider";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import type { ProviderHttpAdapter } from "./openaiProviderAdapter";
import { ProviderError } from "./providerError";
import type {
  ProviderProfileRepository,
  ProviderRecord,
} from "./providerRepository";
import { ProviderService } from "./providerService";
import type { ProviderAdapterFactory } from "./providerService";
import type { ProviderSecretStore } from "./secretStore";

const PROFILE_ID = "77777777-7777-4777-8777-777777777777";
const SECRET_REF = "66666666-6666-4666-8666-666666666666";
const REPLACEMENT_SECRET_REF = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-08-01T08:00:00.000Z";

class FixedIdGenerator implements IdGenerator {
  generate(): string {
    return PROFILE_ID;
  }
}

class FixedClock implements Clock {
  now(): string {
    return NOW;
  }
}

class MemoryProviderRepository implements ProviderProfileRepository {
  records = new Map<string, ProviderRecord>();
  failGet = false;
  failSave = false;

  delete(profileId: string): ProviderRecord | undefined {
    const record = this.records.get(profileId);
    this.records.delete(profileId);
    return record;
  }

  get(profileId: string): ProviderRecord | undefined {
    if (this.failGet) {
      throw new Error("database failed");
    }
    return this.records.get(profileId);
  }

  list(): ProviderRecord[] {
    return [...this.records.values()];
  }

  listSecretReferences(): ReadonlySet<string> {
    return new Set(
      this.list().flatMap((record) =>
        record.apiKeyRef ? [record.apiKeyRef] : [],
      ),
    );
  }

  save(record: ProviderRecord): ProviderRecord {
    if (this.failSave) {
      throw new Error("database failed");
    }
    this.records.set(record.id, record);
    return record;
  }
}

class MemorySecretStore implements ProviderSecretStore {
  deleted: string[] = [];
  storeCount = 0;
  values = new Map<string, string>();

  delete(secretRef: string): Promise<void> {
    this.deleted.push(secretRef);
    this.values.delete(secretRef);
    return Promise.resolve();
  }

  get(secretRef: string): Promise<string> {
    const value = this.values.get(secretRef);
    if (!value) {
      throw new ProviderError("PROVIDER.CREDENTIAL_REQUIRED", "missing", false);
    }
    return Promise.resolve(value);
  }

  prune(allowedReferences: ReadonlySet<string>): Promise<void> {
    for (const key of this.values.keys()) {
      if (!allowedReferences.has(key)) {
        this.values.delete(key);
      }
    }
    return Promise.resolve();
  }

  store(plainText: string): Promise<string> {
    const secretRef =
      this.storeCount++ === 0 ? SECRET_REF : REPLACEMENT_SECRET_REF;
    this.values.set(secretRef, plainText);
    return Promise.resolve(secretRef);
  }
}

const baseDraft = {
  apiStyle: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  chatModel: "model-b",
  name: "Example",
} satisfies ProviderProfileDraft;

function createService(
  adapter: ProviderHttpAdapter = {
    listModels: vi.fn().mockResolvedValue([
      { createdAtUnixSeconds: 2, id: "model-b", ownedBy: "example" },
      { createdAtUnixSeconds: 1, id: "model-a", ownedBy: "example" },
    ]),
    testRealtimeConnection: vi.fn().mockResolvedValue(undefined),
    verifyImageConfiguration: vi.fn().mockResolvedValue(undefined),
  },
) {
  const repository = new MemoryProviderRepository();
  const secrets = new MemorySecretStore();
  const logger = { warn: vi.fn() };
  const adapterFactory: ProviderAdapterFactory = vi.fn(() => adapter);
  return {
    adapterFactory,
    logger,
    repository,
    secrets,
    service: new ProviderService(
      repository,
      secrets,
      new FixedIdGenerator(),
      new FixedClock(),
      logger,
      adapterFactory,
    ),
  };
}

describe("Provider Service", () => {
  it("persists metadata and a secret reference, then creates immutable Run snapshots", async () => {
    const { adapterFactory, repository, service } = createService();
    const secret = "sk-service-secret";
    const profile = await service.saveProfile({
      credential: { mode: "replace", value: secret },
      profile: baseDraft,
    });

    expect(profile).toEqual({
      ...baseDraft,
      createdAt: NOW,
      hasApiKey: true,
      id: PROFILE_ID,
      updatedAt: NOW,
    });
    expect(profile).not.toHaveProperty("apiKey");
    expect(profile).not.toHaveProperty("apiKeyRef");
    expect(repository.get(PROFILE_ID)).toMatchObject({ apiKeyRef: SECRET_REF });
    expect(JSON.stringify(repository.get(PROFILE_ID))).not.toContain(secret);
    expect(service.createSnapshot(PROFILE_ID)).toEqual({
      apiStyle: "openai-compatible",
      modelId: "model-b",
      profileId: PROFILE_ID,
      profileName: "Example",
    });

    await expect(
      service.discoverModels({
        profile: { ...baseDraft, id: PROFILE_ID },
        profileId: PROFILE_ID,
        source: "saved_profile",
      }),
    ).resolves.toMatchObject({ status: "available" });
    expect(adapterFactory).toHaveBeenCalledWith(
      expect.objectContaining({ id: PROFILE_ID }),
      secret,
    );
  });

  it("supports transient draft tests and the explicit manual-model fallback", async () => {
    const manualAdapter: ProviderHttpAdapter = {
      listModels: vi
        .fn()
        .mockRejectedValue(
          new ProviderError(
            "PROVIDER.MODEL_DISCOVERY_UNAVAILABLE",
            "manual",
            false,
          ),
        ),
      testRealtimeConnection: vi.fn().mockResolvedValue(undefined),
      verifyImageConfiguration: vi.fn().mockResolvedValue(undefined),
    };
    const { repository, service } = createService(manualAdapter);

    await expect(
      service.testConnection(
        {
          apiKey: "draft-secret",
          profile: baseDraft,
          source: "draft",
        },
        "chat",
      ),
    ).resolves.toEqual({
      capability: "chat",
      reason: "model_list_unsupported",
      status: "manual_required",
    });
    expect(repository.list()).toEqual([]);
  });

  it("tests Realtime and Image through the same transient connection boundary", async () => {
    const testRealtimeConnection = vi
      .fn<ProviderHttpAdapter["testRealtimeConnection"]>()
      .mockResolvedValue(undefined);
    const verifyImageConfiguration = vi
      .fn<ProviderHttpAdapter["verifyImageConfiguration"]>()
      .mockResolvedValue(undefined);
    const adapter: ProviderHttpAdapter = {
      listModels: vi.fn().mockResolvedValue([]),
      testRealtimeConnection,
      verifyImageConfiguration,
    };
    const { service } = createService(adapter);
    const connection = {
      apiKey: "draft-secret",
      profile: {
        ...baseDraft,
        imageGenerationEndpoint:
          "https://api.example.com/v1/images/generations",
        imageModel: "image-model",
        realtimeEndpoint: "https://api.example.com/v1/realtime",
        realtimeModel: "realtime-model",
      },
      source: "draft" as const,
    };

    await expect(
      service.testConnection(connection, "realtime"),
    ).resolves.toEqual({ capability: "realtime", status: "connected" });
    await expect(service.testConnection(connection, "image")).resolves.toEqual({
      capability: "image",
      status: "connected",
    });
    expect(testRealtimeConnection).toHaveBeenCalledOnce();
    expect(verifyImageConfiguration).toHaveBeenCalledOnce();
  });

  it("reports Image manual verification without claiming the endpoint passed", async () => {
    const adapter: ProviderHttpAdapter = {
      listModels: vi.fn().mockResolvedValue([]),
      testRealtimeConnection: vi.fn().mockResolvedValue(undefined),
      verifyImageConfiguration: vi
        .fn()
        .mockRejectedValue(
          new ProviderError(
            "PROVIDER.MODEL_DISCOVERY_UNAVAILABLE",
            "manual",
            false,
          ),
        ),
    };
    const { service } = createService(adapter);

    await expect(
      service.testConnection(
        {
          apiKey: "draft-secret",
          profile: baseDraft,
          source: "draft",
        },
        "image",
      ),
    ).resolves.toEqual({
      capability: "image",
      reason: "model_verification_unsupported",
      status: "manual_required",
    });
  });

  it("keeps, replaces, removes and deletes credential references deterministically", async () => {
    const { repository, secrets, service } = createService();
    await service.saveProfile({
      credential: { mode: "replace", value: "first-secret" },
      profile: baseDraft,
    });

    await service.saveProfile({
      credential: { mode: "keep" },
      profile: { ...baseDraft, id: PROFILE_ID, name: "Renamed" },
    });
    expect(repository.get(PROFILE_ID)?.apiKeyRef).toBe(SECRET_REF);

    await service.saveProfile({
      credential: { mode: "replace", value: "second-secret" },
      profile: { ...baseDraft, id: PROFILE_ID },
    });
    expect(repository.get(PROFILE_ID)?.apiKeyRef).toBe(REPLACEMENT_SECRET_REF);
    expect(secrets.deleted).toContain(SECRET_REF);

    await service.saveProfile({
      credential: { mode: "remove" },
      profile: { ...baseDraft, id: PROFILE_ID },
    });
    expect(repository.get(PROFILE_ID)?.apiKeyRef).toBeUndefined();
    expect(secrets.deleted).toContain(REPLACEMENT_SECRET_REF);

    await expect(
      service.deleteProfile({ profileId: PROFILE_ID }),
    ).resolves.toEqual({ profileId: PROFILE_ID });
    expect(repository.get(PROFILE_ID)).toBeUndefined();
  });

  it("rolls back a newly stored secret reference when metadata persistence fails", async () => {
    const { repository, secrets, service } = createService();
    repository.failSave = true;

    await expect(
      service.saveProfile({
        credential: { mode: "replace", value: "must-be-removed" },
        profile: baseDraft,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER.STORAGE_FAILED" });
    expect(secrets.deleted).toContain(SECRET_REF);
    expect(secrets.values.has(SECRET_REF)).toBe(false);
  });

  it("maps metadata lookup failures to the stable storage error", async () => {
    const { repository, service } = createService();
    repository.failGet = true;

    await expect(
      service.saveProfile({
        credential: { mode: "keep" },
        profile: { ...baseDraft, id: PROFILE_ID },
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER.STORAGE_FAILED",
      message: "无法读取 Provider Profile。",
    });
  });
});
