import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { ToolResult } from "../../shared/contracts/tool";
import { requiresApproval } from "./approvalPolicy";
import { ContextCompiler } from "./contextCompiler";
import { createMemoryContextInput } from "./memoryContext";
import { detectToolCycle, semanticToolSignature } from "./loopGuard";
import {
  collectModelTurn,
  supportsStrictToolSchema,
  type ModelEvent,
} from "./modelProvider";

function failedResult(): ToolResult {
  return {
    artifacts: [],
    error: {
      code: "TEST.NO_PROGRESS",
      message: "no progress",
      retryable: true,
    },
    modelContent: { observed: false },
    retryable: true,
    status: "error",
    summary: "no progress",
  };
}

async function* events(values: readonly ModelEvent[]) {
  await Promise.resolve();
  yield* values;
}

describe("Phase 2 Runtime mechanics", () => {
  it("uses Provider strict mode only when every object field is required", () => {
    expect(
      supportsStrictToolSchema({
        additionalProperties: false,
        properties: {
          target: {
            additionalProperties: false,
            properties: { id: { type: "string" } },
            required: ["id"],
            type: "object",
          },
        },
        required: ["target"],
        type: "object",
      }),
    ).toBe(true);
    expect(
      supportsStrictToolSchema({
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
        type: "object",
      }),
    ).toBe(false);
  });

  it("detects only five repeated semantic cycles with periods up to five", () => {
    const periodTwo = Array.from({ length: 10 }, (_, index) => ({
      retryable: true,
      signature: index % 2 === 0 ? "a" : "b",
      toolName: index % 2 === 0 ? "test.a" : "test.b",
    }));
    expect(detectToolCycle(periodTwo.slice(0, 9))).toBeUndefined();
    expect(detectToolCycle(periodTwo)).toMatchObject({
      key: "a -> b",
      period: 2,
    });
    expect(
      detectToolCycle(
        Array.from({ length: 30 }, (_, index) => ({
          retryable: true,
          signature: String(index % 6),
          toolName: "test.read",
        })),
      ),
    ).toBeUndefined();
  });

  it("ignores transport noise but retains semantic Tool arguments", () => {
    const first = semanticToolSignature(
      "test.read",
      "read",
      { attempt: 1, path: "a.txt", trace_id: "one" },
      failedResult(),
    );
    const noisyRetry = semanticToolSignature(
      "test.read",
      "read",
      { attempt: 8, path: "a.txt", trace_id: "two" },
      failedResult(),
    );
    const changed = semanticToolSignature(
      "test.read",
      "read",
      { path: "b.txt" },
      failedResult(),
    );
    expect(noisyRetry).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("compacts at 90% of resolved input budget into the selected handoff shape", () => {
    const compiler = new ContextCompiler();
    const largeItems = [
      { content: "old user", role: "user", type: "message" },
      {
        call_id: "call-old",
        output: "large completed Tool output that must not be replayed",
        type: "function_call_output",
      },
    ] satisfies JsonValue[];
    const previousBytes = Buffer.byteLength(JSON.stringify(largeItems), "utf8");
    const compiled = compiler.compile(
      {
        items: largeItems,
        lastRequestBytes: previousBytes,
        lastUsage: {
          cachedInputTokens: 0,
          inputTokens: 91_000,
          outputTokens: 100,
        },
        recentUsers: ["old user", "latest user"],
      },
      { maxPromptTokens: 100_000 },
      {
        constraints: ["keep evidence"],
        currentProgress: ["read input"],
        decisions: ["use selected path"],
        nextSteps: ["finish"],
      },
    );

    expect(compiled.compacted).toBe(true);
    expect(compiled.input).toHaveLength(2);
    expect(compiled.input[1]).toMatchObject({
      content: "latest user",
      role: "user",
    });
    expect(JSON.stringify(compiled.input)).toContain("currentProgress");
    expect(JSON.stringify(compiled.input)).toContain("decisions");
    expect(JSON.stringify(compiled.input)).toContain("constraints");
    expect(JSON.stringify(compiled.input)).toContain("nextSteps");
    expect(JSON.stringify(compiled.input)).not.toContain("call-old");
  });

  it("preserves the structured latest user input across compaction", () => {
    const compiler = new ContextCompiler();
    const currentUserInput = {
      content: "请分析截图并按我的选择继续",
      role: "user",
      type: "message",
    } satisfies JsonValue;
    const latestUserInput = {
      content: [
        { text: "请继续看这张图", type: "input_text" },
        {
          source: "/workspace/layout.png",
          type: "charamate_image_reference",
        },
      ],
      role: "user",
      type: "message",
    } satisfies JsonValue;
    const compiled = compiler.compile(
      {
        items: [currentUserInput, latestUserInput],
        currentUserInput,
        latestUserInput,
        recentUsers: ["old", "请继续看这张图"],
      },
      { maxPromptTokens: 100_000 },
      {
        constraints: [],
        currentProgress: [],
        decisions: [],
        nextSteps: [],
      },
      true,
    );

    expect(compiled.compacted).toBe(true);
    expect(compiled.input[1]).toEqual(currentUserInput);
    expect(compiled.input[2]).toEqual(latestUserInput);
  });

  it("keeps the selected long-term memory evidence before the current goal", () => {
    const compiler = new ContextCompiler();
    const memoryContext = createMemoryContextInput([]);
    const current = {
      content: "继续完成当前目标",
      role: "user",
      type: "message",
    } satisfies JsonValue;
    const compiled = compiler.compile(
      {
        currentUserInput: current,
        items: [
          { content: "较早内容", role: "user", type: "message" },
          memoryContext,
          current,
        ],
        recentUsers: ["继续完成当前目标"],
      },
      { maxPromptTokens: 100_000 },
      {
        constraints: [],
        currentProgress: [],
        decisions: [],
        nextSteps: [],
      },
      true,
    );

    expect(compiled.input).toEqual([
      expect.objectContaining({ role: "developer" }),
      memoryContext,
      current,
    ]);
  });

  it("keeps the latest action Tool boundary next to the current goal", () => {
    const compiler = new ContextCompiler();
    const oldCall = {
      arguments: "{}",
      call_id: "old-call",
      name: "read",
      namespace: "file",
      type: "function_call",
    } satisfies JsonValue;
    const oldOutput = {
      call_id: "old-call",
      output: "old result",
      type: "function_call_output",
    } satisfies JsonValue;
    const latestCall = {
      arguments: "{}",
      call_id: "latest-call",
      name: "search",
      namespace: "memory",
      type: "function_call",
    } satisfies JsonValue;
    const latestOutput = {
      call_id: "latest-call",
      output: "latest evidence",
      type: "function_call_output",
    } satisfies JsonValue;
    const current = {
      content: "继续完成当前目标",
      role: "user",
      type: "message",
    } satisfies JsonValue;
    const compiled = compiler.compile(
      {
        currentUserInput: current,
        items: [oldCall, oldOutput, latestCall, latestOutput, current],
        recentUsers: ["继续完成当前目标"],
      },
      { maxPromptTokens: 100_000 },
      {
        constraints: [],
        currentProgress: [],
        decisions: [],
        nextSteps: [],
      },
      true,
    );

    expect(compiled.input).toEqual([
      expect.objectContaining({ role: "developer" }),
      latestCall,
      latestOutput,
      current,
    ]);
    expect(JSON.stringify(compiled.input)).not.toContain("old result");
  });

  it("keeps the 90% trigger proportional to the Provider-resolved model window", () => {
    const compiler = new ContextCompiler();
    const items = [
      { content: "current", role: "user", type: "message" },
    ] satisfies JsonValue[];
    const lastRequestBytes = Buffer.byteLength(JSON.stringify(items), "utf8");
    const checkpoint = (inputTokens: number) => ({
      items,
      lastRequestBytes,
      lastUsage: {
        cachedInputTokens: 0,
        inputTokens,
        outputTokens: 1,
      },
      recentUsers: ["current"],
    });
    const codexEffectiveWindow = { effectiveInputTokens: 258_400 };

    expect(
      compiler.shouldCompact(checkpoint(232_559), codexEffectiveWindow),
    ).toBe(false);
    expect(
      compiler.shouldCompact(checkpoint(232_560), codexEffectiveWindow),
    ).toBe(true);
    expect(
      compiler.shouldCompact(checkpoint(232_560), {
        effectiveInputTokens: 922_000,
      }),
    ).toBe(false);
  });

  it("does not invent a compaction trigger when Provider limits are unknown", () => {
    const compiler = new ContextCompiler();
    expect(
      compiler.shouldCompact(
        {
          items: [{ content: "x", role: "user", type: "message" }],
          lastRequestBytes: 1,
          lastUsage: {
            cachedInputTokens: 0,
            inputTokens: 1_000_000,
            outputTokens: 1,
          },
          recentUsers: ["x"],
        },
        {},
      ),
    ).toBe(false);
  });

  it("implements exactly the three Composer approval levels", () => {
    const read = {
      description: "read",
      effect: "read" as const,
      idempotency: "idempotent" as const,
      inputSchema: {},
      itemKind: "tool_call" as const,
      name: "test.read",
      namespace: "test",
      source: "builtin" as const,
      summary: "read",
    };
    const write = { ...read, effect: "write" as const, name: "test.write" };
    const critical = {
      ...read,
      effect: "critical" as const,
      name: "test.critical",
    };
    expect(requiresApproval({ mode: "chat" }, write)).toBe(false);
    expect(
      requiresApproval(
        { approvalMode: "request_approval", mode: "agent" },
        write,
      ),
    ).toBe(true);
    expect(
      requiresApproval({ approvalMode: "auto_approve", mode: "agent" }, write),
    ).toBe(false);
    expect(
      requiresApproval(
        { approvalMode: "auto_approve", mode: "agent" },
        critical,
      ),
    ).toBe(true);
    expect(
      requiresApproval(
        { approvalMode: "full_access", mode: "agent" },
        critical,
      ),
    ).toBe(false);
    expect(
      requiresApproval(
        { approvalMode: "request_approval", mode: "agent" },
        read,
      ),
    ).toBe(false);
  });

  it("round-trips native namespace and Tool Search output items without exposing reasoning", async () => {
    const rawFunction = {
      arguments: '{"path":"a.txt"}',
      call_id: "call-1",
      name: "file.read",
      namespace: "file",
      type: "function_call",
    } satisfies JsonValue;
    const turn = await collectModelTurn(
      events([
        { item: rawFunction, type: "output.item" },
        {
          item: {
            arguments: { limit: 30, query: "read local file" },
            call_id: "search-1",
            type: "tool_search_call",
          },
          type: "output.item",
        },
        {
          item: { encrypted_content: "hidden", type: "reasoning" },
          type: "output.item",
        },
        {
          responseId: "response-1",
          type: "response.completed",
          usage: { cachedInputTokens: 10, inputTokens: 20, outputTokens: 3 },
        },
      ]),
    );
    expect(turn.functionCalls[0]).toMatchObject({
      callId: "call-1",
      name: "file.read",
      namespace: "file",
      rawItem: rawFunction,
    });
    expect(turn.toolSearchCalls[0]).toMatchObject({
      callId: "search-1",
      limit: 8,
      query: "read local file",
    });
    expect(turn.outputItems).toContainEqual(
      expect.objectContaining({ type: "reasoning" }),
    );
  });
});
