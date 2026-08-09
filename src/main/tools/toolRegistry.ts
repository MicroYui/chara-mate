import { createHash } from "node:crypto";

import Ajv, { type ValidateFunction } from "ajv";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { ToolDescriptor, ToolResult } from "../../shared/contracts/tool";
import { redactBoundaryValue } from "../../shared/pure/redaction";
import {
  ToolDescriptorSchema,
  ToolResultSchema,
} from "../../shared/schemas/tool";
import { parseSchema } from "../../shared/schemas/validation";
import { Bm25SearchIndex } from "./bm25";

export interface ToolExecutionContext {
  readonly itemId: string;
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

export class ToolRegistry {
  readonly #ajv = new Ajv({ allErrors: true, strict: true });
  readonly #tools = new Map<string, RegisteredTool>();
  #searchIndex = new Bm25SearchIndex<ToolDefinition>([]);

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

  search(query: string, limit = 8): ToolDefinition[] {
    return this.#searchIndex.search(query, limit);
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
    const result = parseSchema(
      ToolResultSchema,
      await registered.definition.execute(input, context),
    );
    const redacted = parseSchema(ToolResultSchema, redactBoundaryValue(result));
    return {
      ...redacted,
      evidenceHash: toolEvidenceHash(redacted.modelContent),
    };
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
