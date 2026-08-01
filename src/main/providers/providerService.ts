import type {
  ProviderConnection,
  ProviderConnectionTest,
  ProviderDeleteProfileRequest,
  ProviderModelDiscovery,
  ProviderProfile,
  ProviderProfileDraft,
  ProviderSaveProfileRequest,
  ProviderSnapshot,
} from "../../shared/contracts/provider";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { ProviderProfileSchema } from "../../shared/schemas/provider";
import { parseSchema } from "../../shared/schemas/validation";
import type { AppLogger } from "../observability/logger";
import {
  OpenAISdkProviderAdapter,
  type ProviderHttpAdapter,
} from "./openaiProviderAdapter";
import { ProviderError } from "./providerError";
import { normalizeProviderDraft } from "./providerNormalization";
import type {
  ProviderRecord,
  ProviderProfileRepository,
} from "./providerRepository";
import type { ProviderSecretStore } from "./secretStore";

export type ProviderAdapterFactory = (
  profile: ProviderProfileDraft,
  apiKey: string,
) => ProviderHttpAdapter;

function recordToDraft(record: ProviderRecord): ProviderProfileDraft {
  const common = {
    baseUrl: record.baseUrl,
    ...(record.chatModel ? { chatModel: record.chatModel } : {}),
    id: record.id,
    ...(record.imageEditEndpoint
      ? { imageEditEndpoint: record.imageEditEndpoint }
      : {}),
    ...(record.imageModel ? { imageModel: record.imageModel } : {}),
    name: record.name,
    ...(record.realtimeEndpoint
      ? { realtimeEndpoint: record.realtimeEndpoint }
      : {}),
    ...(record.realtimeModel ? { realtimeModel: record.realtimeModel } : {}),
  };
  return record.apiStyle === "azure-openai"
    ? {
        ...common,
        apiStyle: "azure-openai",
        apiVersion: record.apiVersion,
      }
    : { ...common, apiStyle: "openai-compatible" };
}

function recordToProfile(record: ProviderRecord): ProviderProfile {
  const draft = recordToDraft(record);
  return parseSchema(ProviderProfileSchema, {
    ...draft,
    createdAt: record.createdAt,
    hasApiKey: record.apiKeyRef !== undefined,
    updatedAt: record.updatedAt,
  });
}

export class ProviderService {
  constructor(
    private readonly repository: ProviderProfileRepository,
    private readonly secretStore: ProviderSecretStore,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: Pick<AppLogger, "warn">,
    private readonly adapterFactory: ProviderAdapterFactory = (
      profile,
      apiKey,
    ) => new OpenAISdkProviderAdapter(profile, apiKey),
  ) {}

  createSnapshot(profileId: string, modelId?: string): ProviderSnapshot {
    const profile = this.#requireProfile(profileId);
    const selectedModel = modelId?.trim() || profile.chatModel;
    if (!selectedModel) {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "请先为该 Provider 选择 Chat Model。",
        false,
      );
    }
    return {
      apiStyle: profile.apiStyle,
      modelId: selectedModel,
      profileId: profile.id,
      profileName: profile.name,
    };
  }

  async deleteProfile(
    request: ProviderDeleteProfileRequest,
  ): Promise<{ profileId: string }> {
    let deleted: ProviderRecord | undefined;
    try {
      deleted = this.repository.delete(request.profileId);
    } catch {
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "无法删除 Provider Profile。",
        true,
      );
    }
    if (!deleted) {
      throw new ProviderError(
        "PROVIDER.PROFILE_NOT_FOUND",
        "Provider Profile 不存在。",
        false,
      );
    }
    if (deleted.apiKeyRef) {
      await this.#deleteOrphanedSecret(deleted.apiKeyRef);
    }
    return { profileId: request.profileId };
  }

  async discoverModels(
    connection: ProviderConnection,
  ): Promise<ProviderModelDiscovery> {
    try {
      const adapter = await this.#createAdapter(connection);
      return { models: await adapter.listModels(), status: "available" };
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER.MODEL_DISCOVERY_UNAVAILABLE"
      ) {
        return {
          reason: "model_list_unsupported",
          status: "manual_required",
        };
      }
      throw error;
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.secretStore.prune(this.repository.listSecretReferences());
    } catch (error) {
      this.logger.warn("PROVIDER_SECRET_PRUNE_FAILED", {
        code:
          error instanceof ProviderError
            ? error.code
            : "PROVIDER.STORAGE_FAILED",
      });
    }
  }

  listProfiles(): ProviderProfile[] {
    try {
      return this.repository.list().map(recordToProfile);
    } catch {
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "无法读取 Provider Profiles。",
        true,
      );
    }
  }

  async saveProfile(
    request: ProviderSaveProfileRequest,
  ): Promise<ProviderProfile> {
    const draft = normalizeProviderDraft(request.profile);
    let existing: ProviderRecord | undefined;
    try {
      existing = draft.id ? this.repository.get(draft.id) : undefined;
    } catch {
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "无法读取 Provider Profile。",
        true,
      );
    }
    if (draft.id && !existing) {
      throw new ProviderError(
        "PROVIDER.PROFILE_NOT_FOUND",
        "要更新的 Provider Profile 不存在。",
        false,
      );
    }

    let nextSecretRef = existing?.apiKeyRef;
    let newlyStoredSecretRef: string | undefined;
    if (request.credential.mode === "replace") {
      newlyStoredSecretRef = await this.secretStore.store(
        request.credential.value,
      );
      nextSecretRef = newlyStoredSecretRef;
    } else if (request.credential.mode === "remove") {
      nextSecretRef = undefined;
    }

    const now = this.clock.now();
    const record = {
      ...draft,
      ...(nextSecretRef ? { apiKeyRef: nextSecretRef } : {}),
      createdAt: existing?.createdAt ?? now,
      id: existing?.id ?? this.idGenerator.generate(),
      updatedAt: now,
    } satisfies ProviderRecord;

    let saved: ProviderRecord;
    try {
      saved = this.repository.save(record);
    } catch {
      if (newlyStoredSecretRef) {
        await this.#deleteOrphanedSecret(newlyStoredSecretRef);
      }
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "无法保存 Provider Profile。",
        true,
      );
    }

    if (existing?.apiKeyRef && existing.apiKeyRef !== nextSecretRef) {
      await this.#deleteOrphanedSecret(existing.apiKeyRef);
    }
    return recordToProfile(saved);
  }

  async testConnection(
    connection: ProviderConnection,
  ): Promise<ProviderConnectionTest> {
    const discovery = await this.discoverModels(connection);
    return discovery.status === "available"
      ? { modelCount: discovery.models.length, status: "connected" }
      : discovery;
  }

  async #createAdapter(
    connection: ProviderConnection,
  ): Promise<ProviderHttpAdapter> {
    if (connection.source === "draft") {
      const profile = normalizeProviderDraft(connection.profile);
      const apiKey = connection.apiKey.trim();
      if (!apiKey) {
        throw new ProviderError(
          "PROVIDER.CREDENTIAL_REQUIRED",
          "请填写 API Key。",
          false,
        );
      }
      return this.adapterFactory(profile, apiKey);
    }

    const record = this.#requireProfile(connection.profileId);
    if (!record.apiKeyRef) {
      throw new ProviderError(
        "PROVIDER.CREDENTIAL_REQUIRED",
        "该 Provider 尚未保存 API Key。",
        false,
      );
    }
    const apiKey = await this.secretStore.get(record.apiKeyRef);
    return this.adapterFactory(recordToDraft(record), apiKey);
  }

  async #deleteOrphanedSecret(secretRef: string): Promise<void> {
    try {
      await this.secretStore.delete(secretRef);
    } catch (error) {
      this.logger.warn("PROVIDER_SECRET_DELETE_FAILED", {
        code:
          error instanceof ProviderError
            ? error.code
            : "PROVIDER.STORAGE_FAILED",
      });
    }
  }

  #requireProfile(profileId: string): ProviderRecord {
    let profile: ProviderRecord | undefined;
    try {
      profile = this.repository.get(profileId);
    } catch {
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "无法读取 Provider Profile。",
        true,
      );
    }
    if (!profile) {
      throw new ProviderError(
        "PROVIDER.PROFILE_NOT_FOUND",
        "Provider Profile 不存在。",
        false,
      );
    }
    return profile;
  }
}
