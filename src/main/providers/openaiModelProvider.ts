import type OpenAI from "openai";
import type {
  NamespaceTool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
  Tool,
  ToolChoiceAllowed,
} from "openai/resources/responses/responses";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { ProviderProfileDraft } from "../../shared/contracts/provider";
import type {
  ModelContextLimits,
  ModelAllowedTool,
  ModelEvent,
  ModelFunctionTool,
  ModelProvider,
  ModelRequest,
  ModelToolNamespace,
} from "../agent/modelProvider";
import { createClient, mapSdkError } from "./openaiProviderAdapter";
import { ProviderError } from "./providerError";

const SELECTED_PROMPT_CACHE_MODEL = "gpt-5.6-sol";
const TOOL_WIRE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const TOOL_NAMESPACE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["browser", "charamate_browser"],
  ["computer", "charamate_computer"],
] as const);
const TOOL_NAMESPACE_ALIASES_REVERSED: ReadonlyMap<string, string> = new Map(
  [...TOOL_NAMESPACE_ALIASES].map(([runtime, wire]) => [wire, runtime]),
);

function toolWireNamespace(namespace: string) {
  const name = TOOL_NAMESPACE_ALIASES.get(namespace) ?? namespace;
  if (!TOOL_WIRE_NAME_PATTERN.test(name)) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      `Tool namespace ${namespace} 无法映射为 Provider 支持的名称。`,
      false,
    );
  }
  return name;
}

function toolRuntimeNamespace(namespace: string) {
  return TOOL_NAMESPACE_ALIASES_REVERSED.get(namespace) ?? namespace;
}

function toolWireName(tool: Pick<ModelFunctionTool, "name" | "namespace">) {
  const namespacePrefix = `${tool.namespace}.`;
  const name = tool.name.startsWith(namespacePrefix)
    ? tool.name.slice(namespacePrefix.length)
    : tool.name;
  if (!TOOL_WIRE_NAME_PATTERN.test(name)) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      `Tool ${tool.name} 无法映射为 Provider 支持的名称。`,
      false,
    );
  }
  return name;
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function jsonRecord(
  value: JsonValue,
): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function wireInputValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(wireInputValue);
  const source = jsonRecord(value);
  if (!source) return value;

  const mapped = Object.fromEntries(
    Object.entries(source).map(([key, nested]) => [
      key,
      wireInputValue(nested),
    ]),
  ) as Record<string, JsonValue>;
  if (source["type"] === "namespace" && typeof source["name"] === "string") {
    const namespace = source["name"];
    mapped["name"] = toolWireNamespace(namespace);
    if (Array.isArray(source["tools"])) {
      mapped["tools"] = source["tools"].map((tool) => {
        const mappedTool = wireInputValue(tool);
        const toolRecord = jsonRecord(mappedTool);
        return toolRecord && typeof toolRecord["name"] === "string"
          ? {
              ...toolRecord,
              name: toolWireName({
                name: toolRecord["name"],
                namespace,
              }),
            }
          : mappedTool;
      });
    }
  } else if (
    source["type"] === "function_call" &&
    typeof source["namespace"] === "string"
  ) {
    const namespace = source["namespace"];
    mapped["namespace"] = toolWireNamespace(namespace);
    if (typeof source["name"] === "string") {
      mapped["name"] = toolWireName({ name: source["name"], namespace });
    }
  }
  return mapped;
}

function runtimeOutputItem(value: unknown): JsonValue {
  const item = asJsonValue(value);
  const record = jsonRecord(item);
  if (
    record?.["type"] !== "function_call" ||
    typeof record["namespace"] !== "string"
  ) {
    return item;
  }
  return {
    ...record,
    namespace: toolRuntimeNamespace(record["namespace"]),
  };
}

function namespaceTool(namespace: ModelToolNamespace): NamespaceTool {
  return {
    description: namespace.description,
    name: toolWireNamespace(namespace.name),
    tools: namespace.tools.map((tool) => ({
      defer_loading: tool.deferLoading ?? true,
      description: tool.description,
      name: toolWireName(tool),
      parameters: tool.inputSchema,
      strict: tool.strict,
      type: "function",
    })),
    type: "namespace",
  };
}

function toolChoice(
  allowedTools: readonly ModelAllowedTool[] | undefined,
): ToolChoiceAllowed | "auto" {
  if (!allowedTools?.length) return "auto";
  return {
    mode: "auto",
    tools: allowedTools.map(({ name, namespace }) => ({
      name: toolWireName({ name, namespace }),
      namespace: toolWireNamespace(namespace),
      type: "function",
    })),
    type: "allowed_tools",
  };
}

function requestTools(
  namespaces: readonly ModelToolNamespace[],
  supportsNativeWebSearch: boolean,
): Tool[] {
  const webSearch = { type: "web_search" as const };
  if (namespaces.length === 0) {
    return supportsNativeWebSearch ? [webSearch] : [];
  }
  const hasDeferredTools = namespaces.some(({ tools }) =>
    tools.some(({ deferLoading }) => deferLoading !== false),
  );
  const toolSearch = {
    description:
      "Search CharaMate's current capability registry and load only the tools needed for the next action.",
    execution: "client" as const,
    parameters: {
      additionalProperties: false,
      properties: {
        limit: { maximum: 8, minimum: 1, type: "integer" },
        query: { minLength: 1, type: "string" },
      },
      required: ["query"],
      type: "object" as const,
    },
    type: "tool_search" as const,
  };
  return [
    ...namespaces.map(namespaceTool),
    ...(hasDeferredTools ? [toolSearch] : []),
    ...(supportsNativeWebSearch ? [webSearch] : []),
  ];
}

function readPositiveInteger(
  record: Readonly<Record<string, unknown>>,
  ...names: readonly string[]
): number | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function metadataRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readPositiveIntegerFrom(
  records: readonly (Readonly<Record<string, unknown>> | undefined)[],
  ...names: readonly string[]
): number | undefined {
  for (const record of records) {
    if (!record) continue;
    const value = readPositiveInteger(record, ...names);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readEffectiveContextPercent(
  records: readonly (Readonly<Record<string, unknown>> | undefined)[],
): number | undefined {
  const value = readPositiveIntegerFrom(
    records,
    "effective_context_window_percent",
  );
  return value !== undefined && value <= 100 ? value : undefined;
}

function contextLimitsFromModel(value: unknown): ModelContextLimits {
  const record = metadataRecord(value);
  if (!record) return {};
  const capabilities = metadataRecord(record["capabilities"]);
  const nestedLimits = metadataRecord(capabilities?.["limits"]);
  const supportedCapabilities = metadataRecord(capabilities?.["supports"]);
  const declaredVisionSupport = supportedCapabilities?.["vision"];
  const supportsVision =
    typeof declaredVisionSupport === "boolean"
      ? declaredVisionSupport
      : metadataRecord(nestedLimits?.["vision"])
        ? true
        : undefined;
  const records = [record, nestedLimits] as const;
  const maxContextTokens = readPositiveIntegerFrom(
    records,
    "context_window",
    "context_window_tokens",
    "max_context_tokens",
    "max_context_window",
    "max_context_window_tokens",
  );
  const maxPromptTokens = readPositiveIntegerFrom(
    records,
    "max_input_tokens",
    "max_prompt_tokens",
  );
  const maxOutputTokens = readPositiveIntegerFrom(records, "max_output_tokens");
  const effectiveContextPercent = readEffectiveContextPercent(records);
  const byContext =
    maxContextTokens !== undefined &&
    maxOutputTokens !== undefined &&
    maxContextTokens > maxOutputTokens
      ? maxContextTokens - maxOutputTokens
      : undefined;
  const byEffectiveContext =
    maxContextTokens !== undefined && effectiveContextPercent !== undefined
      ? Math.floor((maxContextTokens * effectiveContextPercent) / 100)
      : undefined;
  const effectiveInputTokens =
    byEffectiveContext !== undefined
      ? maxPromptTokens === undefined
        ? byEffectiveContext
        : Math.min(byEffectiveContext, maxPromptTokens)
      : maxPromptTokens === undefined
        ? byContext
        : byContext === undefined
          ? maxPromptTokens
          : Math.min(maxPromptTokens, byContext);
  return {
    ...(effectiveInputTokens ? { effectiveInputTokens } : {}),
    ...(maxContextTokens ? { maxContextTokens } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(maxPromptTokens ? { maxPromptTokens } : {}),
    ...(supportsVision === undefined ? {} : { supportsVision }),
  };
}

function unsupportedModelMetadataEndpoint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

function eventError(event: ResponseStreamEvent): ProviderError | undefined {
  if (event.type === "error") {
    return new ProviderError("PROVIDER.REQUEST_FAILED", event.message, false);
  }
  if (event.type === "response.failed") {
    return new ProviderError(
      "PROVIDER.REQUEST_FAILED",
      event.response.error?.message ?? "Provider 无法完成本轮响应。",
      false,
    );
  }
  if (event.type === "response.incomplete") {
    return new ProviderError(
      "PROVIDER.REQUEST_FAILED",
      `Provider 提前结束本轮响应：${event.response.incomplete_details?.reason ?? "unknown"}。`,
      false,
    );
  }
  return undefined;
}

export class OpenAIResponsesModelProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #openAICompatible: boolean;
  readonly supportsNativeWebSearch: boolean;

  constructor(profile: ProviderProfileDraft, apiKey: string) {
    this.#client = createClient(profile, apiKey);
    this.#openAICompatible = profile.apiStyle === "openai-compatible";
    this.supportsNativeWebSearch = true;
  }

  async resolveContextLimits(modelId: string): Promise<ModelContextLimits> {
    let listedLimits: ModelContextLimits | undefined;
    try {
      const page = await this.#client.models.list();
      for await (const model of page) {
        if (model.id !== modelId) continue;
        listedLimits = contextLimitsFromModel(model);
        if (listedLimits.effectiveInputTokens !== undefined) {
          return listedLimits;
        }
        break;
      }
    } catch (error) {
      if (!unsupportedModelMetadataEndpoint(error)) throw mapSdkError(error);
    }

    try {
      const detailedLimits = contextLimitsFromModel(
        await this.#client.models.retrieve(modelId),
      );
      return { ...listedLimits, ...detailedLimits };
    } catch (error) {
      if (unsupportedModelMetadataEndpoint(error)) return listedLimits ?? {};
      throw mapSdkError(error);
    }
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const tools = requestTools(
      request.toolNamespaces,
      this.supportsNativeWebSearch && request.nativeWebSearch === true,
    );
    const useSelectedPromptCache =
      this.#openAICompatible && request.modelId === SELECTED_PROMPT_CACHE_MODEL;
    const body = {
      input: request.input.map(wireInputValue) as unknown as ResponseInput,
      instructions: request.instructions,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: request.maxOutputTokens }),
      model: request.modelId,
      parallel_tool_calls: false,
      ...(useSelectedPromptCache
        ? {
            prompt_cache_options: {
              mode: "implicit" as const,
              ttl: "30m" as const,
            },
          }
        : {}),
      store: false,
      stream: true,
      ...(tools.length === 0
        ? {}
        : {
            tool_choice: toolChoice(request.allowedTools),
            tools,
          }),
    } satisfies ResponseCreateParamsStreaming;

    try {
      const stream = await this.#client.responses.create(body, { signal });
      for await (const event of stream) {
        const error = eventError(event);
        if (error) throw error;
        if (event.type === "response.output_text.delta") {
          yield { delta: event.delta, type: "text.delta" };
        } else if (event.type === "response.output_item.done") {
          yield { item: runtimeOutputItem(event.item), type: "output.item" };
        } else if (event.type === "response.completed") {
          const usage = event.response.usage;
          yield {
            responseId: event.response.id,
            status: "completed",
            type: "response.completed",
            usage: {
              cachedInputTokens: usage?.input_tokens_details.cached_tokens ?? 0,
              inputTokens: usage?.input_tokens ?? 0,
              outputTokens: usage?.output_tokens ?? 0,
            },
          };
        }
      }
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Operation was aborted", "AbortError");
      }
      throw mapSdkError(error, "该 Provider 不支持所需 Responses 能力。");
    }
  }
}

export function modelToolForSearchOutput(
  namespace: string,
  tool: ModelFunctionTool,
): NamespaceTool {
  return namespaceTool({
    description: `${namespace} capability namespace`,
    name: namespace,
    tools: [tool],
  });
}
