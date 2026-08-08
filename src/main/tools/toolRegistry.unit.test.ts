import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "./toolRegistry";
import { ToolRegistry } from "./toolRegistry";

function definition(index: number, description: string): ToolDefinition {
  return {
    descriptor: {
      description,
      effect: "read",
      idempotency: "idempotent",
      inputSchema: {
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
        type: "object",
      },
      itemKind: "tool_call",
      name: `test.tool_${String(index)}`,
      namespace: "test",
      source: "builtin",
      summary: description,
    },
    execute: (input) =>
      Promise.resolve({
        artifacts: [],
        modelContent: input,
        retryable: false,
        status: "success",
        summary: "done",
      }),
    summarize: () => description,
  };
}

describe("Tool Registry", () => {
  it("returns at most eight metadata BM25 matches and never keeps duplicate names", () => {
    const registry = new ToolRegistry();
    for (let index = 0; index < 12; index += 1) {
      registry.register(
        definition(
          index,
          index === 9 ? "calendar meeting schedule" : "file data",
        ),
      );
    }
    expect(registry.search("calendar schedule", 8)[0]?.descriptor.name).toBe(
      "test.tool_9",
    );
    expect(registry.search("file", 8)).toHaveLength(8);
    expect(() => registry.register(definition(0, "duplicate"))).toThrow(
      /Duplicate Tool/u,
    );
  });

  it("validates JSON Schema inputs and structured Tool Results at the boundary", async () => {
    const registry = new ToolRegistry();
    registry.register(definition(1, "read"));
    expect(() => registry.validateInput("test.tool_1", {})).toThrow(
      /Invalid arguments/u,
    );
    await expect(
      registry.execute(
        "test.tool_1",
        { query: "hello" },
        {
          itemId: "10000000-0000-4000-8000-000000000001",
          onDelta: () => undefined,
          runId: "10000000-0000-4000-8000-000000000002",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({ status: "success" });
  });
});
