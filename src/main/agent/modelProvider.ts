import type { InputBudgetEstimate } from "../providers/inputBudget";
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

export interface ModelStructuredOutput {
  readonly description?: string;
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface ModelUsage {
  /** Missing means unreported; a reported zero remains zero. */
  readonly cachedInputTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type ModelResponseStatus = "cancelled" | "completed";

export interface ModelRequest {
  readonly allowedTools?: readonly ModelAllowedTool[];
  readonly input: readonly JsonValue[];
  readonly instructions: string;
  readonly maxOutputTokens?: number;
  readonly modelId: string;
  readonly nativeWebSearch?: boolean;
  readonly structuredOutput?: ModelStructuredOutput;
  readonly toolNamespaces: readonly ModelToolNamespace[];
}

export interface ModelAllowedTool {
  readonly name: string;
  readonly namespace: string;
}

export interface ModelTextDeltaEvent {
  readonly contentIndex?: number;
  readonly delta: string;
  readonly itemId?: string;
  readonly outputIndex?: number;
  readonly type: "text.delta";
}

export interface ModelOutputItemEvent {
  readonly item: JsonValue;
  readonly outputIndex?: number;
  readonly runtimeArguments?: Readonly<Record<string, JsonValue>>;
  readonly type: "output.item";
}

export interface ModelCompletedEvent {
  /** Complete Provider output in its original order, when supplied. */
  readonly outputEvents?: readonly ModelOutputItemEvent[];
  /** Optional final user-visible text; raw deltas/output items are unchanged. */
  readonly displayText?: string;
  readonly responseId: string;
  readonly status: ModelResponseStatus;
  readonly type: "response.completed";
  readonly usage: ModelUsage;
}

export type ModelEvent =
  ModelTextDeltaEvent | ModelOutputItemEvent | ModelCompletedEvent;

export interface InputMeasurementOptions {
  /** Ask the same counter to adjudicate an otherwise conservative decision. */
  readonly requireExact?: true;
}

export interface ModelProvider {
  /** Estimate the same complete wire body used by stream; this makes no network call. */
  estimateInput(request: ModelRequest): InputBudgetEstimate;
  /** Measure a complete prospective request; count exactly when its estimate
   * cannot establish that it fits. The caller owns every network operation. */
  measureInput(
    request: ModelRequest,
    signal: AbortSignal,
    options?: InputMeasurementOptions,
  ): Promise<InputBudgetEstimate>;
  readonly supportsNativeWebSearch?: boolean;
  resolveContextLimits(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ModelContextLimits>;
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
  /** Original completed assistant messages, including optional phase and annotations. */
  readonly assistantMessages?: readonly JsonValue[];
  readonly displayText?: string;
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

// OpenAI strict function schemas support only a JSON Schema subset. Keep the
// full domain schema in ToolRegistry/Ajv, but do not opt the Provider into
// strict mode when the wire schema contains unsupported validation keywords.
// Source checked 2026-08-14:
// https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas
const UNSUPPORTED_STRICT_SCHEMA_KEYWORDS = new Set([
  "allOf",
  "contains",
  "else",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "propertyNames",
  "then",
  "unevaluatedProperties",
  "uniqueItems",
]);

function schemaMapValues(value: unknown): readonly unknown[] {
  const map = schemaRecord(value);
  return map ? Object.values(map) : [];
}

function schemaArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function strictSchemaNodeSupported(value: unknown): boolean {
  const schema = schemaRecord(value);
  if (!schema) return true;

  if (
    Object.keys(schema).some((keyword) =>
      UNSUPPORTED_STRICT_SCHEMA_KEYWORDS.has(keyword),
    )
  ) {
    return false;
  }

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

  const nestedSchemas = [
    ...schemaMapValues(schema["$defs"]),
    ...schemaMapValues(schema["definitions"]),
    ...schemaMapValues(schema["properties"]),
    ...schemaArray(schema["anyOf"]),
    ...(schema["items"] === undefined ? [] : [schema["items"]]),
  ];
  return nestedSchemas.every(strictSchemaNodeSupported);
}

export function supportsStrictToolSchema(value: unknown): boolean {
  const schema = schemaRecord(value);
  if (!schema) return false;
  const type = schema["type"];
  const rootIsObject =
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    Object.hasOwn(schema, "properties");
  return rootIsObject && strictSchemaNodeSupported(schema);
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

  const finalOutputEvents = completed.outputEvents ?? outputEvents;
  const outputItems = finalOutputEvents.map(({ item }) => item);
  const assistantMessages = outputItems.filter((value) => {
    const item = record(value);
    return item?.["type"] === "message" && item["role"] === "assistant";
  });
  // Completed output owns message order. Delta arrival order is only a live display.
  // Keep the existing delta-only adapter contract when no message output is supplied.
  if (assistantMessages.length) {
    text = assistantMessages
      .flatMap((value) => {
        const content = record(value)?.["content"];
        if (!Array.isArray(content)) return [];
        return content.flatMap((part) => {
          const entry = record(part);
          if (
            entry?.["type"] === "output_text" &&
            typeof entry["text"] === "string"
          ) {
            return [entry["text"]];
          }
          if (
            entry?.["type"] === "refusal" &&
            typeof entry["refusal"] === "string"
          ) {
            return [entry["refusal"]];
          }
          return [];
        });
      })
      .join("");
  }
  const functionCalls: ModelFunctionCall[] = [];
  const toolSearchCalls: ModelToolSearchCall[] = [];
  for (const event of finalOutputEvents) {
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
    ...(completed.displayText === undefined
      ? {}
      : { displayText: completed.displayText }),
    ...(assistantMessages.length ? { assistantMessages } : {}),
    functionCalls,
    outputItems,
    responseId: completed.responseId,
    status: completed.status,
    text,
    toolSearchCalls,
    usage: completed.usage,
  };
}
