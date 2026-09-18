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
  InputMeasurementOptions,
  ModelContextLimits,
  ModelEvent,
  ModelFunctionTool,
  ModelOutputItemEvent,
  ModelProvider,
  ModelRequest,
  ModelToolNamespace,
} from "../agent/modelProvider";
import { createClient, mapSdkError } from "./openaiProviderAdapter";
import { openAIResponseDisplayText } from "./openaiCitationDisplay";
import { ProviderError, type ProviderRequestIdentity } from "./providerError";
import {
  estimateInputBudget,
  fitsInputBudget,
  modelInputBudget,
  type InputBudgetEstimate,
} from "./inputBudget";

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
  const values: number[] = [];
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      values.push(value);
    }
  }
  return values.length ? Math.min(...values) : undefined;
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
  const values: number[] = [];
  for (const record of records) {
    if (!record) continue;
    const value = readPositiveInteger(record, ...names);
    if (value !== undefined) values.push(value);
  }
  return values.length ? Math.min(...values) : undefined;
}

function intersectModelLimits(
  listed: ModelContextLimits | undefined,
  detailed: ModelContextLimits,
): ModelContextLimits {
  const limits = { ...listed, ...detailed };
  for (const key of [
    "effectiveInputTokens",
    "maxContextTokens",
    "maxOutputTokens",
    "maxPromptTokens",
  ] as const) {
    const first = listed?.[key];
    const second = detailed[key];
    if (first !== undefined && second !== undefined) {
      limits[key] = Math.min(first, second);
    }
  }
  return limits;
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
  readonly #profileIdentity:
    Omit<ProviderRequestIdentity, "modelId"> | undefined;
  readonly #contextLimits = new Map<string, ModelContextLimits>();
  #inputCountUnsupported = false;
  #lastInputCount:
    { readonly wire: string; readonly inputTokens: number } | undefined;
  readonly supportsNativeWebSearch: boolean;

  constructor(profile: ProviderProfileDraft, apiKey: string) {
    this.#client = createClient(profile, apiKey);
    this.#openAICompatible = profile.apiStyle === "openai-compatible";
    this.#profileIdentity = profile.id
      ? { profileId: profile.id, apiStyle: profile.apiStyle }
      : undefined;
    this.supportsNativeWebSearch = true;
  }

  #requestError(error: unknown, modelId: string, unavailableMessage?: string) {
    const mapped = mapSdkError(error, unavailableMessage);
    if (!this.#profileIdentity || mapped.requestIdentity) return mapped;
    return new ProviderError(mapped.code, mapped.message, mapped.retryable, {
      ...this.#profileIdentity,
      modelId,
    });
  }

  async resolveContextLimits(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ModelContextLimits> {
    signal?.throwIfAborted();
    let listedLimits: ModelContextLimits | undefined;
    try {
      const page = await this.#client.models.list(
        signal ? { signal } : undefined,
      );
      for await (const model of page) {
        if (model.id !== modelId) continue;
        listedLimits = contextLimitsFromModel(model);
        if (listedLimits.effectiveInputTokens !== undefined) {
          signal?.throwIfAborted();
          this.#contextLimits.set(modelId, listedLimits);
          return listedLimits;
        }
        break;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (!unsupportedModelMetadataEndpoint(error))
        throw this.#requestError(error, modelId);
    }
    signal?.throwIfAborted();

    try {
      const detailedLimits = contextLimitsFromModel(
        await this.#client.models.retrieve(
          modelId,
          signal ? { signal } : undefined,
        ),
      );
      signal?.throwIfAborted();
      const limits = intersectModelLimits(listedLimits, detailedLimits);
      this.#contextLimits.set(modelId, limits);
      return limits;
    } catch (error) {
      signal?.throwIfAborted();
      if (unsupportedModelMetadataEndpoint(error)) {
        const limits = listedLimits ?? {};
        this.#contextLimits.set(modelId, limits);
        return limits;
      }
      throw this.#requestError(error, modelId);
    }
  }

  async #measureInput(
    body: ResponseCreateParamsStreaming & {
      input: ResponseInput;
      instructions: string;
      model: string;
    },
    signal: AbortSignal,
    requireExact: boolean,
  ): Promise<{ measurement: InputBudgetEstimate; budget: number }> {
    signal.throwIfAborted();
    const limits =
      this.#contextLimits.get(body.model) ??
      (await this.resolveContextLimits(body.model, signal));
    const budget = modelInputBudget(
      limits,
      body.max_output_tokens ?? undefined,
    );
    signal.throwIfAborted();
    const estimate = estimateInputBudget(body, body.model);
    // These are all token-bearing fields in this adapter's final wire. Output
    // reserve is intentionally excluded from the cache key and rechecked above.
    const countBody = {
      input: body.input,
      instructions: body.instructions,
      model: body.model,
      ...(body.parallel_tool_calls === undefined
        ? {}
        : { parallel_tool_calls: body.parallel_tool_calls }),
      ...(body.text === undefined ? {} : { text: body.text }),
      ...(body.tool_choice === undefined
        ? {}
        : { tool_choice: body.tool_choice }),
      ...(body.tools === undefined ? {} : { tools: body.tools }),
    };
    const wire = JSON.stringify(countBody);
    if (this.#lastInputCount?.wire === wire) {
      return {
        measurement: {
          ...estimate,
          exactInputTokens: this.#lastInputCount.inputTokens,
        },
        budget,
      };
    }
    if (!requireExact && fitsInputBudget(estimate, budget)) {
      return { measurement: estimate, budget };
    }
    if (!this.#inputCountUnsupported) {
      try {
        const count = await this.#client.responses.inputTokens.count(
          countBody,
          { maxRetries: 0, signal },
        );
        signal.throwIfAborted();
        if (
          count.object !== "response.input_tokens" ||
          !Number.isSafeInteger(count.input_tokens) ||
          count.input_tokens < 0
        ) {
          throw new ProviderError(
            "PROVIDER.REQUEST_FAILED",
            "Provider 返回了无效的输入 Token 计数。",
            false,
          );
        }
        // No in-flight sharing: each count belongs to its caller's signal. A
        // cancelled or invalid response never replaces the last completed result.
        this.#lastInputCount = { wire, inputTokens: count.input_tokens };
        return {
          measurement: { ...estimate, exactInputTokens: count.input_tokens },
          budget,
        };
      } catch (error) {
        signal.throwIfAborted();
        if (!unsupportedModelMetadataEndpoint(error)) throw error;
        this.#inputCountUnsupported = true;
      }
    }
    return { measurement: estimate, budget };
  }

  #requestBody(request: ModelRequest) {
    const tools = requestTools(
      request.toolNamespaces,
      this.supportsNativeWebSearch && request.nativeWebSearch === true,
    );
    const useSelectedPromptCache =
      this.#openAICompatible && request.modelId === SELECTED_PROMPT_CACHE_MODEL;
    return {
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
  }

  estimateInput(request: ModelRequest) {
    return estimateInputBudget(this.#requestBody(request), request.modelId);
  }

  async measureInput(
    request: ModelRequest,
    signal: AbortSignal,
    options?: InputMeasurementOptions,
  ): Promise<InputBudgetEstimate> {
    signal.throwIfAborted();
    // Own the complete body across awaits; later caller mutation cannot change
    // what the completed count describes or what final generation will send.
    const body = structuredClone(this.#requestBody(request));
    try {
      const result = await this.#measureInput(
        body,
        signal,
        options?.requireExact === true,
      );
      signal.throwIfAborted();
      return result.measurement;
    } catch (error) {
      signal.throwIfAborted();
      throw this.#requestError(error, body.model);
    }
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const body = structuredClone(this.#requestBody(request));
    const toolReferences = runtimeToolReferenceMap(request.toolNamespaces);
    const outputEvent = (
      value: unknown,
      outputIndex?: number,
    ): ModelOutputItemEvent => {
      const item = runtimeOutputItem(value);
      const runtimeArguments = runtimeFunctionArguments(item, toolReferences);
      return {
        item,
        ...(outputIndex === undefined ? {} : { outputIndex }),
        ...(runtimeArguments === undefined ? {} : { runtimeArguments }),
        type: "output.item",
      };
    };

    try {
      const { measurement, budget } = await this.#measureInput(
        body,
        signal,
        true,
      );
      signal.throwIfAborted();
      if (!fitsInputBudget(measurement, budget)) {
        throw new ProviderError(
          "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
          measurement.exactInputTokens !== undefined
            ? `本次完整输入为 ${measurement.exactInputTokens} Token，超过 ${budget} Token 上限，请缩短内容或先整理历史。`
            : measurement.unknownKinds.length > 0
              ? "Provider 不支持精确输入计数，当前附件或不透明上下文无法可靠计入预算。请改用较短的文本或支持输入计数的 Provider。"
              : `完整请求接近或超过 ${budget} Token 输入预算，且 Provider 不支持精确计数。请减少附件或历史，或改用支持精确输入计数的 Provider。`,
          false,
        );
      }
      const stream = await this.#client.responses.create(body, {
        maxRetries: 0,
        signal,
      });
      for await (const event of stream) {
        const error = eventError(event);
        if (error) throw error;
        if (event.type === "response.output_text.delta") {
          yield {
            contentIndex: event.content_index,
            delta: event.delta,
            itemId: event.item_id,
            outputIndex: event.output_index,
            type: "text.delta",
          };
        } else if (event.type === "response.output_item.done") {
          yield outputEvent(event.item, event.output_index);
        } else if (event.type === "response.completed") {
          const usage = event.response.usage;
          const inputTokens = usage?.input_tokens;
          const outputTokens = usage?.output_tokens;
          const cachedInputTokens = usage?.input_tokens_details?.cached_tokens;
          const displayText = openAIResponseDisplayText(event.response.output);
          yield {
            ...(displayText === undefined ? {} : { displayText }),
            ...(event.response.output === undefined
              ? {}
              : {
                  outputEvents: event.response.output.map((item, outputIndex) =>
                    outputEvent(item, outputIndex),
                  ),
                }),
            responseId: event.response.id,
            status: "completed",
            type: "response.completed",
            usage: {
              ...(typeof cachedInputTokens === "number"
                ? { cachedInputTokens }
                : {}),
              ...(typeof inputTokens === "number" ? { inputTokens } : {}),
              ...(typeof outputTokens === "number" ? { outputTokens } : {}),
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
      throw this.#requestError(
        error,
        body.model,
        "该 Provider 不支持所需 Responses 能力。",
      );
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
