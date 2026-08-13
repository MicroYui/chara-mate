import type { JsonValue } from "../../shared/contracts/primitives";

export interface ModelFunctionTool {
  readonly deferLoading?: boolean;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly namespace: string;
  readonly strict: boolean;
}

export interface ModelToolNamespace {
  readonly description: string;
  readonly name: string;
  readonly tools: readonly ModelFunctionTool[];
}

export interface ModelContextLimits {
  readonly effectiveInputTokens?: number;
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxPromptTokens?: number;
  readonly supportsVision?: boolean;
}

export interface ModelUsage {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ModelResponseStatus = "cancelled" | "completed";

export interface ModelRequest {
  readonly allowedTools?: readonly ModelAllowedTool[];
  readonly input: readonly JsonValue[];
  readonly instructions: string;
  readonly maxOutputTokens?: number;
  readonly modelId: string;
  readonly nativeWebSearch?: boolean;
  readonly toolNamespaces: readonly ModelToolNamespace[];
}

export interface ModelAllowedTool {
  readonly name: string;
  readonly namespace: string;
}

export interface ModelTextDeltaEvent {
  readonly delta: string;
  readonly type: "text.delta";
}

export interface ModelOutputItemEvent {
  readonly item: JsonValue;
  readonly runtimeArguments?: Readonly<Record<string, JsonValue>>;
  readonly type: "output.item";
}

export interface ModelCompletedEvent {
  readonly responseId: string;
  readonly status: ModelResponseStatus;
  readonly type: "response.completed";
  readonly usage: ModelUsage;
}

export type ModelEvent =
  ModelTextDeltaEvent | ModelOutputItemEvent | ModelCompletedEvent;

export interface ModelProvider {
  readonly supportsNativeWebSearch?: boolean;
  resolveContextLimits(modelId: string): Promise<ModelContextLimits>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ModelFunctionCall {
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly callId: string;
  readonly name: string;
  readonly namespace?: string;
  readonly rawItem: JsonValue;
}

export interface ModelToolSearchCall {
  readonly callId: string;
  readonly limit: number;
  readonly query: string;
  readonly rawItem: JsonValue;
}

export interface CollectedModelTurn {
  readonly functionCalls: readonly ModelFunctionCall[];
  readonly outputItems: readonly JsonValue[];
  readonly responseId: string;
  readonly status: ModelResponseStatus;
  readonly text: string;
  readonly toolSearchCalls: readonly ModelToolSearchCall[];
  readonly usage: ModelUsage;
}

function schemaRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function supportsStrictToolSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(supportsStrictToolSchema);
  const schema = schemaRecord(value);
  if (!schema) return true;

  const type = schema["type"];
  const isObject =
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    Object.hasOwn(schema, "properties");
  if (isObject) {
    const properties = schemaRecord(schema["properties"]);
    const required = schema["required"];
    if (
      !properties ||
      schema["additionalProperties"] !== false ||
      !Array.isArray(required) ||
      !Object.keys(properties).every((name) => required.includes(name))
    ) {
      return false;
    }
  }

  return Object.values(schema).every(supportsStrictToolSchema);
}

function record(value: unknown): Readonly<Record<string, JsonValue>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : null;
}

function stringProperty(
  value: Readonly<Record<string, JsonValue>>,
  name: string,
): string | undefined {
  const property = value[name];
  return typeof property === "string" ? property : undefined;
}

function parseArguments(value: string): Readonly<Record<string, JsonValue>> {
  const parsed = JSON.parse(value) as JsonValue;
  const argumentsRecord = record(parsed);
  if (!argumentsRecord) {
    throw new TypeError("Model Tool arguments must be a JSON object");
  }
  return argumentsRecord;
}

export async function collectModelTurn(
  events: AsyncIterable<ModelEvent>,
  onTextDelta?: (delta: string) => void,
): Promise<CollectedModelTurn> {
  let text = "";
  let completed: ModelCompletedEvent | undefined;
  const outputEvents: ModelOutputItemEvent[] = [];

  for await (const event of events) {
    if (event.type === "text.delta") {
      text += event.delta;
      onTextDelta?.(event.delta);
    } else if (event.type === "output.item") {
      outputEvents.push(event);
    } else {
      completed = event;
    }
  }
  if (!completed) {
    throw new Error("Provider stream ended without response.completed");
  }

  const functionCalls: ModelFunctionCall[] = [];
  const toolSearchCalls: ModelToolSearchCall[] = [];
  for (const event of outputEvents) {
    const rawItem = event.item;
    const item = record(rawItem);
    if (!item) continue;
    const type = stringProperty(item, "type");
    if (type === "function_call") {
      const callId = stringProperty(item, "call_id");
      const name = stringProperty(item, "name");
      const argumentsJson = stringProperty(item, "arguments");
      if (!callId || !name || argumentsJson === undefined) {
        throw new TypeError("Provider returned an incomplete function_call");
      }
      const namespace = stringProperty(item, "namespace");
      functionCalls.push({
        arguments: event.runtimeArguments ?? parseArguments(argumentsJson),
        callId,
        name,
        ...(namespace ? { namespace } : {}),
        rawItem,
      });
    } else if (type === "tool_search_call") {
      const callId = stringProperty(item, "call_id");
      const rawArguments = item["arguments"];
      const argumentsRecord = record(rawArguments);
      const query = argumentsRecord
        ? stringProperty(argumentsRecord, "query")
        : undefined;
      const requestedLimit = argumentsRecord?.["limit"];
      if (!callId || !query?.trim()) {
        throw new TypeError("Provider returned an invalid tool_search_call");
      }
      toolSearchCalls.push({
        callId,
        limit:
          typeof requestedLimit === "number" && Number.isInteger(requestedLimit)
            ? Math.max(1, Math.min(8, requestedLimit))
            : 8,
        query: query.trim(),
        rawItem,
      });
    }
  }

  return {
    functionCalls,
    outputItems: outputEvents.map(({ item }) => item),
    responseId: completed.responseId,
    status: completed.status,
    text,
    toolSearchCalls,
    usage: completed.usage,
  };
}
