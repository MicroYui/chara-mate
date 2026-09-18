import { createHash } from "node:crypto";

import Ajv, { type ValidateFunction } from "ajv";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { ToolDescriptor, ToolResult } from "../../shared/contracts/tool";
import { redactBoundaryValue } from "../../shared/pure/redaction";
import {
  ToolDescriptorSchema,
  ToolResultSchema,
} from "../../shared/schemas/tool";
import {
  isUtcTimestamp,
  UTC_TIMESTAMP_FORMAT,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { InputBudgetEstimate } from "../providers/inputBudget";
import { Bm25SearchIndex } from "./bm25";

export type ToolResultContextMeasurement =
  | {
      readonly kind: "responses_request";
      readonly inputBudgetTokens: number;
      readonly measurement: InputBudgetEstimate;
    }
  | {
      readonly kind: "realtime_submission";
      readonly inputBudgetTokens: number;
      readonly measurement: InputBudgetEstimate;
      readonly conversationOccupancy: "unknown";
      readonly capacityBasis: "configured_name_rule" | "user_limit_only";
    };

export interface ToolExecutionContext {
  readonly availableToolNames?: readonly string[];
  readonly itemId: string;
  /** Measures a successful candidate result without executing or committing it. */
  readonly measureResult?: (
    result: ToolResult,
  ) => Promise<ToolResultContextMeasurement>;
  readonly onDelta: (delta: string) => void;
  readonly providerProfileId?: string;
  readonly runId: string;
  readonly signal: AbortSignal;
}

export interface ToolDefinition {
  readonly descriptor: ToolDescriptor;
  execute(
    input: Readonly<Record<string, JsonValue>>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
  summarize(input: Readonly<Record<string, JsonValue>>): string;
}

interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly validate: ValidateFunction;
}

function schemaSearchText(descriptor: ToolDescriptor): string {
  return JSON.stringify(descriptor.inputSchema)
    .replaceAll(/[{}[\]",:]/gu, " ")
    .replaceAll(/\\[nrt]/gu, " ");
}

function metadataSearchText(descriptor: ToolDescriptor): string {
  return [
    descriptor.name,
    descriptor.namespace,
    descriptor.summary,
    descriptor.description,
    descriptor.source,
    schemaSearchText(descriptor),
  ].join(" ");
}

export function toolEvidenceHash(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeToolResult(value: ToolResult): ToolResult {
  const result = parseSchema(ToolResultSchema, value);
  const redacted = parseSchema(ToolResultSchema, redactBoundaryValue(result));
  return {
    ...redacted,
    evidenceHash: toolEvidenceHash(redacted.modelContent),
  };
}

export class ToolRegistry {
  readonly #ajv = new Ajv({ allErrors: true, strict: true });
  readonly #tools = new Map<string, RegisteredTool>();
  #searchIndex = new Bm25SearchIndex<ToolDefinition>([]);

  constructor() {
    this.#ajv.addFormat(UTC_TIMESTAMP_FORMAT, isUtcTimestamp);
  }

  register(input: ToolDefinition): void {
    const descriptor = parseSchema(ToolDescriptorSchema, input.descriptor);
    if (this.#tools.has(descriptor.name)) {
      throw new Error(`Duplicate Tool name: ${descriptor.name}`);
    }
    const inputSchema = descriptor.inputSchema;
    if (
      typeof inputSchema !== "object" ||
      inputSchema === null ||
      Array.isArray(inputSchema)
    ) {
      throw new TypeError(
        `Tool ${descriptor.name} inputSchema must be an object`,
      );
    }
    const definition = { ...input, descriptor };
    this.#tools.set(descriptor.name, {
      definition,
      validate: this.#ajv.compile(inputSchema),
    });
    this.#rebuildSearchIndex();
  }

  unregisterWhere(predicate: (descriptor: ToolDescriptor) => boolean): void {
    for (const [name, tool] of this.#tools) {
      if (predicate(tool.definition.descriptor)) this.#tools.delete(name);
    }
    this.#rebuildSearchIndex();
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name)?.definition;
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()]
      .map(({ definition }) => definition)
      .sort((left, right) =>
        left.descriptor.name.localeCompare(right.descriptor.name),
      );
  }

  search(
    query: string,
    limit = 8,
    availableNames?: ReadonlySet<string>,
  ): ToolDefinition[] {
    // A named capability is an identity lookup; a description mentioning that
    // name must not displace it. Unnamed queries retain the metadata ranking.
    const named: ToolDefinition[] = [];
    const names = new Set<string>();
    for (const token of query
      .normalize("NFKC")
      .toLowerCase()
      .match(/[a-z0-9._-]+/gu) ?? []) {
      const name = token.replace(/^\.+|\.+$/gu, "");
      const tool = this.get(name);
      if (tool && !names.has(name) && (availableNames?.has(name) ?? true)) {
        names.add(name);
        named.push(tool);
      }
    }
    return [
      ...named,
      ...this.#searchIndex
        .search(query, limit, availableNames)
        .filter(({ descriptor }) => !names.has(descriptor.name)),
    ].slice(0, Math.max(0, Math.min(8, limit)));
  }

  recoveryCandidates(toolName: string): ToolDefinition[] {
    const current = this.get(toolName)?.descriptor;
    if (!current?.recoveryGroup) return [];
    return this.list().filter(
      ({ descriptor }) =>
        descriptor.name !== current.name &&
        descriptor.recoveryGroup === current.recoveryGroup,
    );
  }

  validateInput(
    name: string,
    input: Readonly<Record<string, JsonValue>>,
  ): void {
    const registered = this.#tools.get(name);
    if (!registered) throw new Error(`Unknown Tool: ${name}`);
    if (!registered.validate(input)) {
      throw new TypeError(
        `Invalid arguments for ${name}: ${this.#ajv.errorsText(
          registered.validate.errors,
        )}`,
      );
    }
  }

  async execute(
    name: string,
    input: Readonly<Record<string, JsonValue>>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const registered = this.#tools.get(name);
    if (!registered) throw new Error(`Unknown Tool: ${name}`);
    this.validateInput(name, input);
    const measureResult = context.measureResult;
    const definitionContext = measureResult
      ? {
          ...context,
          measureResult: (result: ToolResult) =>
            measureResult(normalizeToolResult(result)),
        }
      : context;
    return normalizeToolResult(
      await registered.definition.execute(input, definitionContext),
    );
  }

  #rebuildSearchIndex(): void {
    this.#searchIndex = new Bm25SearchIndex(
      this.list().map((definition) => ({
        id: definition.descriptor.name,
        text: metadataSearchText(definition.descriptor),
        value: definition,
      })),
    );
  }
}
