import type {
  ProviderConnection,
  ProviderConnectionTest,
  ProviderDeleteProfileRequest,
  ProviderModelDiscovery,
  ProviderProfile,
  ProviderProfileDraft,
  ProviderSaveProfileRequest,
  ProviderSnapshot,
  ProviderTestCapability,
} from "../../shared/contracts/provider";
import type { ModelProvider } from "../agent/modelProvider";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { ProviderProfileSchema } from "../../shared/schemas/provider";
import { parseSchema } from "../../shared/schemas/validation";
import type { AppLogger } from "../observability/logger";
import {
  AzureTerritoryImageProvider,
  type TerritoryImageProvider,
} from "./azureImageProvider";
import {
  OpenAISdkProviderAdapter,
  type ProviderHttpAdapter,
} from "./openaiProviderAdapter";
import { createInitialProviderRecords } from "./initialProviderProfiles";
import { ProviderError } from "./providerError";
import { OpenAIResponsesModelProvider } from "./openaiModelProvider";
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

export type ModelProviderFactory = (
  profile: ProviderProfileDraft,
  apiKey: string,
) => ModelProvider;

export type ImageProviderFactory = (
  profile: ProviderProfileDraft,
  apiKey: string,
) => TerritoryImageProvider;

export interface ChatModelRuntime {
  readonly provider: ModelProvider;
  readonly snapshot: ProviderSnapshot;
}

export interface RealtimeProviderRuntime {
  readonly apiKey: string;
  readonly profile: ProviderProfileDraft;
  readonly snapshot: ProviderSnapshot;
}

function recordToDraft(record: ProviderRecord): ProviderProfileDraft {
  const common = {
    baseUrl: record.baseUrl,
    ...(record.chatModel ? { chatModel: record.chatModel } : {}),
    id: record.id,
    ...(record.imageGenerationEndpoint
      ? { imageGenerationEndpoint: record.imageGenerationEndpoint }
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
        ...(record.apiVersion ? { apiVersion: record.apiVersion } : {}),
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
  #changed: (() => void) | undefined;

  setChangedListener(listener: () => void): void {
    this.#changed = listener;
  }

  private notifyChanged(): void {
    try {
      this.#changed?.();
    } catch (error) {
      this.logger.warn("PROVIDER_CHANGE_OBSERVER_ERROR", { error });
    }
  }

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
    private readonly modelProviderFactory: ModelProviderFactory = (
      profile,
      apiKey,
    ) => new OpenAIResponsesModelProvider(profile, apiKey),
    private readonly imageProviderFactory: ImageProviderFactory = (
      profile,
      apiKey,
    ) => new AzureTerritoryImageProvider(profile, apiKey),
  ) {}

  async createImageProvider(
    profileId: string,
  ): Promise<TerritoryImageProvider> {
    const record = this.#requireProfile(profileId);
    if (!record.apiKeyRef) {
      throw new ProviderError(
        "PROVIDER.CREDENTIAL_REQUIRED",
        "该 Provider 尚未保存 API Key。",
        false,
      );
    }
    if (!record.imageModel) {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "请先为该 Provider 配置 Image Model。",
        false,
      );
    }
    const apiKey = await this.secretStore.get(record.apiKeyRef);
    const profile = normalizeProviderDraft(recordToDraft(record));
    return this.imageProviderFactory(profile, apiKey);
  }

  resolveImageProfileId(preferredProfileId?: string): string {
    let profiles: ProviderRecord[];
    try {
      profiles = this.repository.list();
    } catch {
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "无法读取 Provider Profiles。",
        true,
      );
    }
    const available = profiles.filter(
      (profile) =>
        profile.apiStyle === "azure-openai" &&
        profile.apiKeyRef !== undefined &&
        profile.imageGenerationEndpoint !== undefined &&
        profile.imageModel !== undefined,
    );
    const selected =
      available.find(({ id }) => id === preferredProfileId) ?? available[0];
    if (!selected) {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "请先配置一个带凭据、Image Generation Endpoint 与 Image Model 的 Azure Provider。",
        false,
      );
    }
    return selected.id;
  }

  async createChatModelRuntime(
    profileId: string,
    modelId?: string,
  ): Promise<ChatModelRuntime> {
    const record = this.#requireProfile(profileId);
    if (!record.apiKeyRef) {
      throw new ProviderError(
        "PROVIDER.CREDENTIAL_REQUIRED",
        "该 Provider 尚未保存 API Key。",
        false,
      );
    }
    const snapshot = this.createSnapshot(profileId, modelId);
    const profile = normalizeProviderDraft(recordToDraft(record));
    const apiKey = await this.secretStore.get(record.apiKeyRef);
    return {
      provider: this.modelProviderFactory(profile, apiKey),
      snapshot,
    };
  }

  async createRealtimeProviderRuntime(
    profileId: string,
  ): Promise<RealtimeProviderRuntime> {
    const record = this.#requireProfile(profileId);
    if (!record.apiKeyRef) {
      throw new ProviderError(
        "PROVIDER.CREDENTIAL_REQUIRED",
        "该 Provider 尚未保存 API Key。",
        false,
      );
    }
    if (record.apiStyle !== "azure-openai") {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "Realtime Voice 当前需要 Azure OpenAI Profile。",
        false,
      );
    }
    if (!record.realtimeEndpoint || !record.realtimeModel) {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "请先填写 Realtime Endpoint 与 Model。",
        false,
      );
    }
    const profile = normalizeProviderDraft(recordToDraft(record));
    return {
      apiKey: await this.secretStore.get(record.apiKeyRef),
      profile,
      snapshot: {
        apiStyle: profile.apiStyle,
        modelId: record.realtimeModel,
        profileId: record.id,
        profileName: record.name,
      },
    };
  }

  getDefaultChatProfileId(): string {
    let profiles: ProviderRecord[];
    try {
      profiles = this.repository.list();
    } catch {
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "无法读取默认 Chat Provider。",
        true,
      );
    }
    const configured = profiles.filter(({ apiKeyRef, chatModel }) =>
      Boolean(apiKeyRef && chatModel),
    );
    const selected =
      configured.find(({ apiStyle }) => apiStyle === "openai-compatible") ??
      configured[0];
    if (!selected) {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "请先配置一个可用的 Chat Provider 与模型。",
        false,
      );
    }
    return selected.id;
  }

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

  async initialize(
    additionalSecretReferences: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    try {
      if (this.repository.list().length === 0) {
        for (const record of createInitialProviderRecords(this.clock.now())) {
          this.repository.save(record);
        }
      }
    } catch {
      throw new ProviderError(
        "PROVIDER.STORAGE_FAILED",
        "无法初始化 Provider Profiles。",
        true,
      );
    }

    try {
      await this.secretStore.prune(
        new Set([
          ...this.repository.listSecretReferences(),
          ...additionalSecretReferences,
        ]),
      );
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
    this.notifyChanged();
    return recordToProfile(saved);
  }

  async testConnection(
    connection: ProviderConnection,
    capability: ProviderTestCapability,
  ): Promise<ProviderConnectionTest> {
    if (capability === "chat") {
      const discovery = await this.discoverModels(connection);
      return discovery.status === "available"
        ? {
            capability: "chat",
            modelCount: discovery.models.length,
            status: "connected",
          }
        : { ...discovery, capability: "chat" };
    }

    const adapter = await this.#createAdapter(connection);
    if (capability === "realtime") {
      await adapter.testRealtimeConnection();
      return { capability: "realtime", status: "connected" };
    }

    try {
      await adapter.verifyImageConfiguration();
      return { capability: "image", status: "connected" };
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER.MODEL_DISCOVERY_UNAVAILABLE"
      ) {
        return {
          capability: "image",
          reason: "model_verification_unsupported",
          status: "manual_required",
        };
      }
      throw error;
    }
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
    const profile = normalizeProviderDraft(connection.profile);
    if (profile.id && profile.id !== connection.profileId) {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "Provider Profile 与已保存密钥不匹配。",
        false,
      );
    }
    return this.adapterFactory(profile, apiKey);
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
