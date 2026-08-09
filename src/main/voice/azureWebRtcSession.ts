import type { JsonValue } from "../../shared/contracts/primitives";
import type {
  VoiceName,
  VoicePreviewConnection,
} from "../../shared/contracts/voice";
import type { RealtimeProviderRuntime } from "../providers/providerService";
import { ProviderError } from "../providers/providerError";

interface ClientSecretResponse {
  readonly expires_at?: unknown;
  readonly value?: unknown;
}

export interface AzureRealtimeSessionOptions {
  readonly instructions: string;
  readonly tools?: readonly AzureRealtimeFunctionTool[];
  readonly voice: VoiceName;
}

export interface AzureRealtimeFunctionTool {
  readonly description: string;
  readonly name: string;
  readonly parameters: JsonValue;
  readonly type: "function";
}

type Fetch = typeof fetch;

function realtimeBase(endpoint: string): URL {
  const url = new URL(endpoint);
  url.search = "";
  url.hash = "";
  if (url.protocol !== "https:") {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      "Azure Realtime Endpoint 必须使用 HTTPS。",
      false,
    );
  }
  const normalizedPath = url.pathname.replaceAll("//", "/");
  const path = normalizedPath.endsWith("/")
    ? normalizedPath.slice(0, -1)
    : normalizedPath;
  if (!path.endsWith("/openai/v1/realtime")) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      "Realtime Endpoint 必须以 /openai/v1/realtime 结尾。",
      false,
    );
  }
  url.pathname = path;
  return url;
}

function endpoint(base: URL, suffix: "calls" | "client_secrets"): string {
  const url = new URL(base);
  url.pathname = `${url.pathname}/${suffix}`;
  return url.toString();
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

async function requestError(response: Response): Promise<ProviderError> {
  const status = response.status;
  if (status === 401 || status === 403) {
    return new ProviderError(
      "PROVIDER.AUTHENTICATION_FAILED",
      "Azure Realtime 凭据无效或无权访问该 deployment。",
      false,
    );
  }
  if (status === 429) {
    return new ProviderError(
      "PROVIDER.RATE_LIMITED",
      "Azure Realtime 当前繁忙，请稍后重试。",
      true,
    );
  }
  let detail: string | undefined;
  try {
    const error = record(record(await response.json())?.["error"]);
    const values = [error?.["code"], error?.["param"], error?.["message"]]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    detail = values.join(" · ") || undefined;
  } catch {
    // The HTTP status remains sufficient when Azure omits a JSON error body.
  }
  return new ProviderError(
    "PROVIDER.REQUEST_FAILED",
    `Azure Realtime 无法创建会话（HTTP ${String(status)}）${detail ? `：${detail}` : "。"}`,
    status >= 500,
  );
}

function expiresAt(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ProviderError(
      "PROVIDER.REQUEST_FAILED",
      "Azure Realtime 返回了无效的临时凭据。",
      false,
    );
  }
  return new Date(value * 1_000).toISOString();
}

export class AzureWebRtcSessionIssuer {
  constructor(private readonly fetchImplementation: Fetch = fetch) {}

  async issue(
    runtime: RealtimeProviderRuntime,
    options: AzureRealtimeSessionOptions,
  ): Promise<VoicePreviewConnection> {
    const endpointValue = runtime.profile.realtimeEndpoint;
    const model = runtime.profile.realtimeModel;
    if (!endpointValue || !model) {
      throw new ProviderError(
        "PROVIDER.INVALID_CONFIGURATION",
        "请先填写 Realtime Endpoint 与 Model。",
        false,
      );
    }
    const base = realtimeBase(endpointValue);
    let response: Response;
    try {
      response = await this.fetchImplementation(
        endpoint(base, "client_secrets"),
        {
          body: JSON.stringify({
            session: {
              audio: {
                input: {
                  transcription: {
                    model: "whisper-1",
                    prompt:
                      "简体中文, English, CharaMate, Chat, Agent, Settings, Voice, Model, Provider, Realtime, Azure OpenAI",
                  },
                  turn_detection: {
                    create_response: false,
                    interrupt_response: true,
                    type: "server_vad",
                  },
                },
                output: { voice: options.voice },
              },
              instructions: options.instructions,
              model,
              output_modalities: ["audio"],
              parallel_tool_calls: false,
              tool_choice: "auto",
              tools: options.tools ?? [],
              type: "realtime",
            },
          }),
          headers: {
            "api-key": runtime.apiKey,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "manual",
        },
      );
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "PROVIDER.UNREACHABLE",
        "无法连接 Azure Realtime。",
        true,
      );
    }
    if (!response.ok) throw await requestError(response);
    const body = (await response.json()) as ClientSecretResponse;
    if (typeof body.value !== "string" || !body.value.trim()) {
      throw new ProviderError(
        "PROVIDER.REQUEST_FAILED",
        "Azure Realtime 没有返回临时凭据。",
        false,
      );
    }
    return {
      callsUrl: endpoint(base, "calls"),
      clientSecret: body.value,
      expiresAt: expiresAt(body.expires_at),
    };
  }
}
