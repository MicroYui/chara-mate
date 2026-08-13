import type OpenAI from "openai";
import type {
  NamespaceTool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
  Tool,
} from "openai/resources/responses/responses";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { ProviderProfileDraft } from "../../shared/contracts/provider";
import type {
  ModelContextLimits,
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
// Namespace tools are all CharaMate client tools. Provider-native tools such as
// web_search use distinct wire types, so a uniform prefix avoids every reserved
// namespace without leaking Provider naming concerns into the runtime contract.
const TOOL_WIRE_NAMESPACE_PREFIX = "charamate_";

function toolWireNamespace(namespace: string) {
  const name = `${TOOL_WIRE_NAMESPACE_PREFIX}${namespace}`;
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
  return namespace.startsWith(TOOL_WIRE_NAMESPACE_PREFIX)
    ? namespace.slice(TOOL_WIRE_NAMESPACE_PREFIX.length)
    : namespace;
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

function runtimeToolReferenceMap(
  namespaces: readonly ModelToolNamespace[],
): ReadonlyMap<string, string> {
  const references = new Map<string, string>();
  for (const namespace of namespaces) {
    const wireNamespace = toolWireNamespace(namespace.name);
    references.set(wireNamespace, namespace.name);
    for (const tool of namespace.tools) {
      references.set(`${wireNamespace}.${toolWireName(tool)}`, tool.name);
    }
  }
  return references;
}

function runtimeToolReferences(
  value: JsonValue,
  references: ReadonlyMap<string, string>,
): JsonValue {
  if (typeof value === "string") return references.get(value) ?? value;
  if (Array.isArray(value)) {
    return value.map((entry) => runtimeToolReferences(entry, references));
  }
  const record = jsonRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      runtimeToolReferences(entry, references),
    ]),
  );
}

function runtimeFunctionArguments(
  value: JsonValue,
  references: ReadonlyMap<string, string>,
): Readonly<Record<string, JsonValue>> | undefined {
  const item = jsonRecord(value);
  const rawArguments = item?.["arguments"];
  if (item?.["type"] !== "function_call" || typeof rawArguments !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawArguments) as JsonValue;
    const runtime = runtimeToolReferences(parsed, references);
    const runtimeRecord = jsonRecord(runtime);
    return runtimeRecord && JSON.stringify(runtime) !== JSON.stringify(parsed)
      ? runtimeRecord
      : undefined;
  } catch {
    // collectModelTurn owns malformed argument reporting.
    return undefined;
  }
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
    const toolReferences = runtimeToolReferenceMap(request.toolNamespaces);
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
      ...(request.structuredOutput
        ? {
            text: {
              format: {
                ...(request.structuredOutput.description
                  ? { description: request.structuredOutput.description }
                  : {}),
                name: request.structuredOutput.name,
                schema: request.structuredOutput.schema,
                strict: true,
                type: "json_schema" as const,
              },
            },
          }
        : {}),
      ...(tools.length === 0
        ? {}
        : {
            // Responses documents allowed_tools references for top-level tools,
            // but no portable reference shape for members of a namespace. The
            // loaded Tool Search scope is therefore enforced by the Harness.
            tool_choice: "auto" as const,
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
          const item = runtimeOutputItem(event.item);
          const runtimeArguments = runtimeFunctionArguments(
            item,
            toolReferences,
          );
          yield {
            item,
            ...(runtimeArguments === undefined ? {} : { runtimeArguments }),
            type: "output.item",
          };
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
