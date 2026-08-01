import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  AzureOpenAI,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
import WebSocket from "ws";

import type {
  ProviderModelDescriptor,
  ProviderProfileDraft,
} from "../../shared/contracts/provider";
import { ProviderError } from "./providerError";

export interface ProviderHttpAdapter {
  listModels(): Promise<ProviderModelDescriptor[]>;
  testRealtimeConnection(): Promise<void>;
  verifyImageConfiguration(): Promise<void>;
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

function mapSdkError(
  error: unknown,
  unavailableMessage = "该 Provider 没有标准模型列表端点，请手动填写 Model ID。",
): ProviderError {
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
      "当前 API Key 没有访问该 Provider 能力的权限。",
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
      unavailableMessage,
      false,
    );
  }

  return new ProviderError(
    "PROVIDER.REQUEST_FAILED",
    "Provider 请求失败，请检查配置后重试。",
    false,
  );
}

class RealtimeHandshakeError extends Error {
  constructor(readonly statusCode?: number) {
    super("Realtime handshake failed");
    this.name = "RealtimeHandshakeError";
  }
}

function mapRealtimeError(
  error: unknown,
  apiStyle: ProviderProfileDraft["apiStyle"],
): ProviderError {
  if (error instanceof RealtimeHandshakeError) {
    if (error.statusCode === 400) {
      return new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "Realtime 拒绝了连接参数，请检查 Endpoint 与 Model。",
        false,
      );
    }
    if (error.statusCode === 401) {
      return new ProviderError(
        "PROVIDER.AUTHENTICATION_FAILED",
        "Realtime 拒绝了 API Key。",
        false,
      );
    }
    if (error.statusCode === 403) {
      return new ProviderError(
        "PROVIDER.PERMISSION_DENIED",
        "当前 API Key 没有访问 Realtime 的权限。",
        false,
      );
    }
    if (error.statusCode === 404) {
      return new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        apiStyle === "azure-openai"
          ? "Azure Realtime 路由或 deployment 不存在；Endpoint 应以 /openai/v1/realtime 结尾，Model 请填写 deployment 名称。"
          : "Realtime 路由或模型不存在，请检查 Endpoint 与 Model。",
        false,
      );
    }
    if (error.statusCode === 429) {
      return new ProviderError(
        "PROVIDER.RATE_LIMITED",
        "Realtime 暂时限制了连接，请稍后重试。",
        true,
      );
    }
    if (error.statusCode !== undefined) {
      return new ProviderError(
        "PROVIDER.REQUEST_FAILED",
        `Realtime 握手失败（HTTP ${String(error.statusCode)}），请检查 Endpoint、Model 与 Provider 权限。`,
        false,
      );
    }
  }
  return new ProviderError(
    "PROVIDER.REQUEST_FAILED",
    "Realtime 握手失败，请检查 Endpoint、Model 与 Provider 权限。",
    false,
  );
}

function requireEndpoint(
  value: string | undefined,
  suffix: string,
  fieldName: string,
): URL {
  if (!value) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      `请先填写 ${fieldName}。`,
      false,
    );
  }
  const endpoint = new URL(value);
  const pathname = endpoint.pathname.replace(/\/+$/u, "");
  if (!pathname.endsWith(suffix)) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      `${fieldName} 应以 ${suffix} 结尾。`,
      false,
    );
  }
  endpoint.pathname = pathname;
  return endpoint;
}

function endpointBaseUrl(endpoint: URL, suffix: string): string {
  const baseUrl = new URL(endpoint);
  baseUrl.pathname = baseUrl.pathname.slice(0, -suffix.length) || "/";
  baseUrl.search = "";
  return baseUrl.toString().replace(/\/$/u, "");
}

export class OpenAISdkProviderAdapter implements ProviderHttpAdapter {
  readonly #client: OpenAI;
  readonly #apiKey: string;
  readonly #profile: ProviderProfileDraft;

  constructor(profile: ProviderProfileDraft, apiKey: string) {
    try {
      this.#apiKey = apiKey;
      this.#profile = profile;
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

  async testRealtimeConnection(): Promise<void> {
    const endpoint = requireEndpoint(
      this.#profile.realtimeEndpoint,
      "/realtime",
      "Realtime Endpoint",
    );
    const model = this.#profile.realtimeModel?.trim();
    if (!model) {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "请先填写 Realtime Model。",
        false,
      );
    }

    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    endpoint.hash = "";
    endpoint.search = "";
    endpoint.searchParams.set("model", model);

    let socket: WebSocket | undefined;
    try {
      socket = new WebSocket(endpoint, {
        headers:
          this.#profile.apiStyle === "azure-openai"
            ? { "api-key": this.#apiKey }
            : { Authorization: `Bearer ${this.#apiKey}` },
      });
      await new Promise<void>((resolve, reject) => {
        socket?.once("open", resolve);
        socket?.once("error", reject);
        socket?.once("unexpected-response", (_request, response) => {
          response.resume();
          reject(new RealtimeHandshakeError(response.statusCode));
        });
        socket?.once("close", (code) => {
          if (code !== 1000) reject(new RealtimeHandshakeError());
        });
      });
      socket.close(1000, "configuration test");
    } catch (error) {
      socket?.terminate();
      throw mapRealtimeError(error, this.#profile.apiStyle);
    }
  }

  async verifyImageConfiguration(): Promise<void> {
    const endpoint = requireEndpoint(
      this.#profile.imageEditEndpoint,
      "/images/edits",
      "Image Edit Endpoint",
    );
    const model = this.#profile.imageModel?.trim();
    if (!model) {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "请先填写 Image Model。",
        false,
      );
    }

    try {
      const client =
        this.#profile.apiStyle === "openai-compatible"
          ? createClient(
              {
                ...this.#profile,
                baseUrl: endpointBaseUrl(endpoint, "/images/edits"),
              },
              this.#apiKey,
            )
          : this.#client;
      await client.models.retrieve(model);
    } catch (error) {
      throw mapSdkError(
        error,
        "该 Provider 不支持无生成的 Image Model 验证，请手动确认配置。",
      );
    }
  }
}
