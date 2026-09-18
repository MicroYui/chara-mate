import { describe, expect, it } from "vitest";

import { registerTerritoryTools } from "../territory/territoryTools";
import type { ToolDefinition } from "./toolRegistry";
import type { ToolResult } from "../../shared/contracts/tool";
import { ToolRegistry, toolEvidenceHash } from "./toolRegistry";

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
  it("measures precisely the normalized result later returned by one execution", async () => {
    const registry = new ToolRegistry();
    const measured: string[] = [];
    let executions = 0;
    const candidate: ToolResult = {
      artifacts: [],
      modelContent: { text: '换行\n引用"原话"', apiKey: "fixture-value" },
      summary: "查询材料",
      retryable: false,
      status: "success",
    };
    registry.register({
      ...definition(1, "read"),
      execute: async (_input, context) => {
        executions += 1;
        await context.measureResult!(candidate);
        await context.measureResult!({
          ...candidate,
          modelContent: { text: '换行\n引用"原话"', apiKey: "[REDACTED]" },
        });
        return candidate;
      },
    });
    const result = await registry.execute(
      "test.tool_1",
      { query: "材料" },
      {
        itemId: "10000000-0000-4000-8000-000000000001",
        runId: "10000000-0000-4000-8000-000000000002",
        onDelta: () => undefined,
        signal: new AbortController().signal,
        measureResult: (value) => {
          measured.push(JSON.stringify(value));
          return Promise.resolve({
            kind: "responses_request",
            inputBudgetTokens: 50_000,
            measurement: {
              estimatedTokens: 200,
              wireBytes: 200,
              unknownKinds: [],
            },
          });
        },
      },
    );
    expect(executions).toBe(1);
    expect(measured).toEqual([JSON.stringify(result), JSON.stringify(result)]);
    expect(result.modelContent).toEqual({
      text: '换行\n引用"原话"',
      apiKey: "[REDACTED]",
    });
    expect(result.evidenceHash).toBe(toolEvidenceHash(result.modelContent));
    expect(candidate.modelContent).toHaveProperty("apiKey", "fixture-value");
  });

  it("filters complete names and metadata matches within the supplied scope before limiting", () => {
    const registry = new ToolRegistry();
    for (let index = 0; index < 20; index += 1)
      registry.register(definition(index, "current layout"));
    const available = new Set(["test.tool_18", "test.tool_19"]);
    const query = Array.from(
      { length: 20 },
      (_, index) => `test.tool_${String(index)}`,
    ).join(" ");
    expect(
      registry
        .search(query, 1, available)
        .map(({ descriptor }) => descriptor.name),
    ).toEqual(["test.tool_18"]);
    expect(
      registry
        .search("current layout", 8, available)
        .map(({ descriptor }) => descriptor.name),
    ).toEqual(["test.tool_18", "test.tool_19"]);
    expect(registry.search(query, 8, new Set())).toEqual([]);
    expect(registry.search(query, 8, new Set(["test.missing"]))).toEqual([]);
    expect(
      registry.search(
        query,
        99,
        new Set(registry.list().map(({ descriptor }) => descriptor.name)),
      ),
    ).toHaveLength(8);
  });

  it.each([
    "+territory.observe",
    "territory.observe 读取当前住处布局 revisionId targets",
  ])(
    "finds the named Territory read before an action mentioning it: %s",
    (query) => {
      const registry = new ToolRegistry();
      const notExecuted = () => {
        throw new Error("Discovery must not execute a Tool");
      };
      registerTerritoryTools(registry, {
        candidates: { createAutonomousItem: notExecuted },
        runs: {
          getRun: notExecuted,
          getRunItem: notExecuted,
          latestUserMessageId: notExecuted,
        },
        territory: {
          getSnapshot: notExecuted,
          observePetActions: notExecuted,
          performPetAction: notExecuted,
        },
      });
      expect(
        registry.search(query, 1).map(({ descriptor }) => descriptor.name),
      ).toEqual(["territory.observe"]);
    },
  );

  it("keeps complete names distinct from prefixes and ranks unnamed queries by metadata", () => {
    const registry = new ToolRegistry();
    registry.register(definition(1, "calendar meeting schedule"));
    registry.register(
      definition(2, "test.tool_1_backup test.tool_10 other.test.tool_1"),
    );
    for (const query of [
      "test.tool_1_backup",
      "test.tool_10",
      "other.test.tool_1",
    ])
      expect(registry.search(query, 1)[0]?.descriptor.name).toBe("test.tool_2");
    expect(
      registry.search("calendar meeting schedule", 1)[0]?.descriptor.name,
    ).toBe("test.tool_1");
    expect(registry.search("ordinary unmatched greeting")).toEqual([]);
  });

  it("deduplicates named tools, honors result limits and uses the current registry", () => {
    const registry = new ToolRegistry();
    for (let index = 0; index < 12; index += 1)
      registry.register(definition(index, "shared tools"));
    expect(
      registry
        .search("`test.tool_9`, +test.tool_3 test.tool_9.", 2)
        .map(({ descriptor }) => descriptor.name),
    ).toEqual(["test.tool_9", "test.tool_3"]);
    expect(registry.search("test.tool_9", 0)).toEqual([]);
    expect(registry.search("test.tool_9 shared", 99)).toHaveLength(8);
    registry.unregisterWhere(({ name }) => name === "test.tool_9");
    expect(
      registry
        .search("test.tool_9")
        .some(({ descriptor }) => descriptor.name === "test.tool_9"),
    ).toBe(false);
  });

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
