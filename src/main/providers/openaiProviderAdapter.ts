import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  AzureOpenAI,
  PermissionDeniedError,
  RateLimitError,
} from "openai";

import type {
  ProviderModelDescriptor,
  ProviderProfileDraft,
} from "../../shared/contracts/provider";
import { ProviderError } from "./providerError";

export interface ProviderHttpAdapter {
  listModels(): Promise<ProviderModelDescriptor[]>;
}

function createClient(profile: ProviderProfileDraft, apiKey: string): OpenAI {
  const common = {
    apiKey,
    logLevel: "off" as const,
  };

  if (profile.apiStyle === "azure-openai") {
    const url = new URL(profile.baseUrl);
    const azureLocation =
      url.pathname === "/" || url.pathname === ""
        ? { endpoint: profile.baseUrl }
        : { baseURL: profile.baseUrl };
    return new AzureOpenAI({
      ...common,
      ...azureLocation,
      apiVersion: profile.apiVersion,
    });
  }

  return new OpenAI({ ...common, baseURL: profile.baseUrl });
}

function mapSdkError(error: unknown): ProviderError {
  if (error instanceof AuthenticationError) {
    return new ProviderError(
      "PROVIDER.AUTHENTICATION_FAILED",
      "Provider 拒绝了 API Key。",
      false,
    );
  }
  if (error instanceof PermissionDeniedError) {
    return new ProviderError(
      "PROVIDER.PERMISSION_DENIED",
      "当前 API Key 没有列出模型的权限。",
      false,
    );
  }
  if (error instanceof RateLimitError) {
    return new ProviderError(
      "PROVIDER.RATE_LIMITED",
      "Provider 暂时限制了请求，请稍后重试。",
      true,
    );
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new ProviderError(
      "PROVIDER.TIMEOUT",
      "连接 Provider 超时，请稍后重试。",
      true,
    );
  }
  if (error instanceof APIConnectionError) {
    return new ProviderError(
      "PROVIDER.UNREACHABLE",
      "无法连接 Provider，请检查 URL 和网络。",
      true,
    );
  }
  if (
    error instanceof APIError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  ) {
    return new ProviderError(
      "PROVIDER.MODEL_DISCOVERY_UNAVAILABLE",
      "该 Provider 没有标准模型列表端点，请手动填写 Model ID。",
      false,
    );
  }

  return new ProviderError(
    "PROVIDER.REQUEST_FAILED",
    "Provider 请求失败，请检查配置后重试。",
    false,
  );
}

export class OpenAISdkProviderAdapter implements ProviderHttpAdapter {
  readonly #client: OpenAI;

  constructor(profile: ProviderProfileDraft, apiKey: string) {
    try {
      this.#client = createClient(profile, apiKey);
    } catch {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "Provider SDK 配置无效，请检查 URL 与 API Version。",
        false,
      );
    }
  }

  async listModels(): Promise<ProviderModelDescriptor[]> {
    try {
      const page = await this.#client.models.list();
      const models = new Map<string, ProviderModelDescriptor>();
      for await (const model of page) {
        const id = model.id.trim();
        if (id) {
          models.set(id, {
            createdAtUnixSeconds: Math.max(0, model.created),
            id,
            ownedBy: model.owned_by.trim() || "unknown",
          });
        }
      }
      return [...models.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
    } catch (error) {
      throw mapSdkError(error);
    }
  }
}
