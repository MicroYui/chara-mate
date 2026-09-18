import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { ToolResult } from "../../shared/contracts/tool";
import { VOICE_END_TOOL_NAME } from "../../shared/contracts/voice";
import {
  COMPANIONSHIP_UPDATE_TOOL_NAME,
  CompanionshipUpdateInputSchema,
} from "../journey/companionshipTool";
import { CHAT_CONTEXT_SUMMARY_PREFIX } from "../chat/chatContext";
import { requiresApproval, toolAllowedInExecution } from "./approvalPolicy";
import { ContextCompiler } from "./contextCompiler";
import {
  createCognitionContextInput,
  shareSelectedObservationBodies,
  materializeCognitionContextInput,
} from "./cognitionContext";
import { detectToolCycle, semanticToolSignature } from "./loopGuard";
import {
  collectModelTurn,
  supportsStrictToolSchema,
  type ModelEvent,
} from "./modelProvider";
import { decodeRuntimeCheckpoint } from "./runtimeCheckpoint";

it("passes final display text separately from raw structured text and live deltas", async () => {
  const raw = '{"answer":"original"}';
  const deltas: string[] = [];
  const turn = await collectModelTurn(
    events([
      { delta: raw, type: "text.delta" },
      {
        responseId: "response-display",
        status: "completed",
        type: "response.completed",
        displayText: "Rendered source [1](https://example.com)",
        usage: { cachedInputTokens: 0, inputTokens: 1, outputTokens: 1 },
      },
    ]),
    (delta) => deltas.push(delta),
  );
  expect(turn.text).toBe(raw);
  expect(JSON.parse(turn.text)).toEqual({ answer: "original" });
  expect(turn.displayText).toBe("Rendered source [1](https://example.com)");
  expect(deltas).toEqual([raw]);
});

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
  it("uses Provider strict mode only for the supported JSON Schema subset", () => {
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
    expect(
      supportsStrictToolSchema({
        additionalProperties: false,
        properties: {
          value: {
            anyOf: [
              { format: "custom-timestamp", type: "string" },
              { type: "null" },
            ],
          },
        },
        required: ["value"],
        type: "object",
      }),
    ).toBe(false);
    expect(supportsStrictToolSchema(CompanionshipUpdateInputSchema)).toBe(
      false,
    );
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

  it("counts the model-visible cognition message once, excluding duplicate persisted provenance", async () => {
    const compiler = new ContextCompiler();
    const input = {
      type: "charamate_cognition_context",
      content: "relevant condition",
      memoryEvidence: { content: "x".repeat(100_000) },
      evidenceIds: ["evidence-1"],
    };
    const compiled = await compiler.compile(
      { items: [input], recentUsers: [] },
      { effectiveInputTokens: 20_000 },
      { constraints: [], currentProgress: [], decisions: [], nextSteps: [] },
    );
    expect(compiled.compacted).toBe(false);
    expect(compiled.input).toEqual([input]);
    expect(compiled.requestBytes).toBeLessThan(200);
  });

  it("compacts at 90% of resolved input budget into the selected handoff shape", async () => {
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
    const compiled = await compiler.compile(
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

  it("preserves the structured latest user input across compaction", async () => {
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
    const compiled = await compiler.compile(
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

  it("keeps the selected long-term memory evidence before the current goal", async () => {
    const compiler = new ContextCompiler();
    const memoryContext = createCognitionContextInput({
      situationIds: [],
      intentIds: [],
      evidenceIds: [],
      text: "Current matter: finish the implementation; no unrelated personal history.",
    });
    const current = {
      content: "继续完成当前目标",
      role: "user",
      type: "message",
    } satisfies JsonValue;
    const compiled = await compiler.compile(
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

  it("retains the inspected pixels with their Tool boundary and the newer user correction", async () => {
    const current = {
      type: "message",
      role: "user",
      content: "看一下画布",
    } satisfies JsonValue;
    const correction = {
      type: "message",
      role: "user",
      content: "只说上下位置，不需要评价颜色",
    } satisfies JsonValue;
    const source = "/workspace/observed.png";
    const call = {
      type: "function_call",
      namespace: "image",
      name: "inspect",
      call_id: "inspect-current",
      arguments: JSON.stringify({ path: source }),
    } satisfies JsonValue;
    const output = {
      type: "function_call_output",
      call_id: "inspect-current",
      output: JSON.stringify({
        status: "success",
        modelContent: { loaded: true, source },
      }),
    } satisfies JsonValue;
    const image = {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Pixels from the completed Tool" },
        { type: "charamate_image_reference", source },
      ],
    } satisfies JsonValue;
    const other = {
      type: "message",
      role: "user",
      content: [
        { type: "charamate_image_reference", source: "/workspace/other.png" },
      ],
    } satisfies JsonValue;
    const compiled = await new ContextCompiler().compile(
      {
        currentUserInput: current,
        latestUserInput: correction,
        items: [current, call, output, other, image, correction],
        recentUsers: ["看一下画布", "只说上下位置，不需要评价颜色"],
      },
      { maxPromptTokens: 100_000 },
      { constraints: [], currentProgress: [], decisions: [], nextSteps: [] },
      true,
    );
    expect(compiled.input).toEqual([
      expect.objectContaining({ role: "developer" }),
      call,
      output,
      image,
      current,
      correction,
    ]);
  });

  it("keeps the durable Chat summary when the active Run compacts", async () => {
    const compiler = new ContextCompiler();
    const summary = {
      content: `${CHAT_CONTEXT_SUMMARY_PREFIX}\nEarlier goals and decisions`,
      role: "developer",
      type: "message",
    } satisfies JsonValue;
    const current = {
      content: "继续当前目标",
      role: "user",
      type: "message",
    } satisfies JsonValue;

    const compiled = await compiler.compile(
      {
        currentUserInput: current,
        items: [
          summary,
          { content: "recent raw", role: "user", type: "message" },
          current,
        ],
        recentUsers: ["继续当前目标"],
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
      summary,
      current,
    ]);
  });

  it("keeps the latest action Tool boundary next to the current goal", async () => {
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
    const compiled = await compiler.compile(
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

  it("preserves the actual failed action pair alongside the fresh successful read", async () => {
    const failedCall = {
      type: "function_call",
      call_id: "failed-action",
      name: "territory.act",
      arguments: "{}",
    } satisfies JsonValue;
    const failedOutput = {
      type: "function_call_output",
      call_id: "failed-action",
      output: JSON.stringify(failedResult()),
    } satisfies JsonValue;
    const readCall = {
      type: "function_call",
      call_id: "fresh-read",
      name: "territory.observe",
      arguments: "{}",
    } satisfies JsonValue;
    const readOutput = {
      type: "function_call_output",
      call_id: "fresh-read",
      output: JSON.stringify({
        status: "success",
        modelContent: { revision: "fresh" },
      }),
    } satisfies JsonValue;
    const compiler = new ContextCompiler();
    const handoff = {
      constraints: [],
      currentProgress: ["action failed; observed again"],
      decisions: [],
      nextSteps: [],
    };
    const compiled = await compiler.compile(
      {
        items: [failedCall, failedOutput, readCall, readOutput],
        recentUsers: [],
      },
      { maxPromptTokens: 258_000 },
      handoff,
      true,
    );
    expect(compiled.input.slice(1)).toEqual([
      failedCall,
      failedOutput,
      readCall,
      readOutput,
    ]);
    const again = await compiler.compile(
      { items: compiled.input, recentUsers: [] },
      { maxPromptTokens: 258_000 },
      handoff,
      true,
    );
    expect(again.input).toEqual(compiled.input);
    expect(again.compacted).toBe(false);
  });

  it("reinjects the latest full Plan independently of the mutable handoff", async () => {
    const compiler = new ContextCompiler();
    const currentPlan = {
      explanation: "检查完成，继续实现并验证。",
      plan: [
        { status: "completed" as const, step: "检查现有实现" },
        { status: "in_progress" as const, step: "修复 checkpoint" },
        { status: "pending" as const, step: "运行回归测试" },
      ],
    };
    const latestCall = {
      arguments: "{}",
      call_id: "latest-call",
      name: "read",
      namespace: "file",
      type: "function_call",
    } satisfies JsonValue;
    const latestOutput = {
      call_id: "latest-call",
      output: "ordinary Tool result",
      type: "function_call_output",
    } satisfies JsonValue;
    const current = {
      content: "继续完成当前目标",
      role: "user",
      type: "message",
    } satisfies JsonValue;
    const compiled = await compiler.compile(
      {
        currentPlan,
        currentUserInput: current,
        items: [latestCall, latestOutput, current],
        recentUsers: ["继续完成当前目标"],
      },
      { maxPromptTokens: 100_000 },
      {
        constraints: [],
        currentProgress: ["file.read: ordinary Tool result"],
        decisions: [],
        nextSteps: [],
      },
      true,
    );

    expect(compiled.input).toHaveLength(5);
    expect(compiled.input[0]).toMatchObject({ role: "developer" });
    expect(compiled.input[1]).toEqual(latestCall);
    expect(compiled.input[2]).toEqual(latestOutput);
    expect(compiled.input[3]).toMatchObject({ role: "developer" });
    expect(
      (compiled.input[3] as Readonly<Record<string, JsonValue>>)["content"],
    ).toContain(
      "Current execution plan (authoritative latest complete snapshot)",
    );
    expect(compiled.input[4]).toEqual(current);
    const serialized = JSON.stringify(compiled.input);
    expect(serialized).toContain("检查完成，继续实现并验证");
    expect(serialized).toContain("检查现有实现");
    expect(serialized).toContain("修复 checkpoint");
    expect(serialized).toContain("运行回归测试");
    expect(serialized).toContain("in_progress");
  });

  it("validates a persisted current Plan at the checkpoint boundary", () => {
    const checkpoint = {
      boundaries: [],
      currentPlan: {
        plan: [
          { status: "in_progress", step: "修复 checkpoint" },
          { status: "pending", step: "运行回归测试" },
        ],
      },
      forcedCompactionAttempted: false,
      handoff: {
        constraints: [],
        currentProgress: [],
        decisions: [],
        nextSteps: [],
      },
      input: [],
      recentUsers: [],
      recoveryAttemptedKeys: [],
      version: 1,
    } as JsonValue;

    expect(decodeRuntimeCheckpoint(checkpoint).currentPlan).toMatchObject({
      plan: [
        { status: "in_progress", step: "修复 checkpoint" },
        { status: "pending", step: "运行回归测试" },
      ],
    });
    expect(
      decodeRuntimeCheckpoint({
        ...(checkpoint as Readonly<Record<string, JsonValue>>),
        interactionEnabled: false,
        nativeWebSearchEnabled: false,
        quietCompletionAllowed: true,
      }),
    ).toMatchObject({
      interactionEnabled: false,
      nativeWebSearchEnabled: false,
      quietCompletionAllowed: true,
    });
    expect(() =>
      decodeRuntimeCheckpoint({
        ...(checkpoint as Readonly<Record<string, JsonValue>>),
        currentPlan: {
          plan: [
            { status: "in_progress", step: "第一步" },
            { status: "in_progress", step: "第二步" },
          ],
        },
      }),
    ).toThrow("Unsupported or corrupt Agent checkpoint");
    expect(() =>
      decodeRuntimeCheckpoint({
        ...(checkpoint as Readonly<Record<string, JsonValue>>),
        quietCompletionAllowed: "yes",
      }),
    ).toThrow("Unsupported or corrupt Agent checkpoint");
    expect(() =>
      decodeRuntimeCheckpoint({
        ...(checkpoint as Readonly<Record<string, JsonValue>>),
        nativeWebSearchEnabled: "no",
      }),
    ).toThrow("Unsupported or corrupt Agent checkpoint");
  });

  it("intersects the Provider window with the user input limit before the compaction trigger", async () => {
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
      await compiler.shouldCompact(checkpoint(232_199), codexEffectiveWindow),
    ).toBe(false);
    expect(
      await compiler.shouldCompact(checkpoint(232_200), codexEffectiveWindow),
    ).toBe(true);
    expect(
      await compiler.shouldCompact(checkpoint(232_560), {
        effectiveInputTokens: 922_000,
      }),
    ).toBe(true);
  });

  it("keeps the user input limit when Provider limits are unknown", async () => {
    const compiler = new ContextCompiler();
    expect(
      await compiler.shouldCompact(
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
    ).toBe(true);
  });

  it("detects a large first input and does not let a previous low token ratio hide it", async () => {
    const compiler = new ContextCompiler();
    const checkpoint = {
      items: [{ content: "汉".repeat(90_000), role: "user", type: "message" }],
      recentUsers: [],
    };
    expect(await compiler.shouldCompact(checkpoint, {})).toBe(true);
    expect(
      await compiler.shouldCompact(
        {
          ...checkpoint,
          lastRequestBytes: 1_000_000,
          lastUsage: { cachedInputTokens: 0, inputTokens: 1, outputTokens: 1 },
        },
        { maxPromptTokens: 1_000_000 },
      ),
    ).toBe(true);
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
    const companionship = {
      ...write,
      name: COMPANIONSHIP_UPDATE_TOOL_NAME,
    };
    expect(toolAllowedInExecution({ mode: "chat" }, companionship)).toBe(true);
    expect(requiresApproval({ mode: "chat" }, companionship)).toBe(false);
    expect(
      requiresApproval(
        { approvalMode: "request_approval", mode: "agent" },
        companionship,
      ),
    ).toBe(false);
    const voiceEnd = { ...write, name: VOICE_END_TOOL_NAME };
    expect(
      toolAllowedInExecution(
        { approvalMode: "full_access", mode: "agent" },
        voiceEnd,
      ),
    ).toBe(false);
    expect(
      requiresApproval(
        { approvalMode: "request_approval", mode: "agent" },
        voiceEnd,
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
          status: "completed",
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

describe("original assistant message phases", () => {
  it("uses completed output order, preserving missing/null and separate same-phase messages", async () => {
    const messages: JsonValue[] = [
      {
        id: "progress-1",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "检查", annotations: [] }],
      },
      {
        id: "progress-2",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "中。", annotations: [] }],
      },
      {
        id: "answer",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "结果。", annotations: [] }],
      },
      {
        id: "null",
        type: "message",
        role: "assistant",
        phase: null,
        content: [{ type: "output_text", text: "空标记。", annotations: [] }],
      },
      {
        id: "unknown",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "未知标记。", annotations: [] }],
      },
    ];
    const live: string[] = [];
    const turn = await collectModelTurn(
      events([
        {
          type: "text.delta",
          delta: "结果。",
          itemId: "answer",
          outputIndex: 2,
          contentIndex: 0,
        },
        {
          type: "text.delta",
          delta: "检查",
          itemId: "progress-1",
          outputIndex: 0,
          contentIndex: 0,
        },
        { type: "output.item", item: messages[2]!, outputIndex: 2 },
        { type: "output.item", item: messages[0]!, outputIndex: 0 },
        {
          type: "response.completed",
          responseId: "phases",
          status: "completed",
          outputEvents: messages.map((item, outputIndex) => ({
            type: "output.item" as const,
            item,
            outputIndex,
          })),
          usage: {},
        },
      ]),
      (delta) => live.push(delta),
    );
    expect(live).toEqual(["结果。", "检查"]);
    expect(turn.text).toBe("检查中。结果。空标记。未知标记。");
    expect(turn.assistantMessages).toEqual(messages);
    expect(turn.outputItems).toEqual(messages);
    expect(turn.assistantMessages?.[4]).not.toHaveProperty("phase");
    expect(turn.assistantMessages?.[3]).toHaveProperty("phase", null);
  });

  it("does not turn a completed output message into response completion", async () => {
    await expect(
      collectModelTurn(
        events([
          {
            type: "output.item",
            item: {
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: "一段。" }],
            },
          },
        ]),
      ),
    ).rejects.toThrow("Provider stream ended without response.completed");
  });
});

function observationSharingFixture() {
  const id = (n: number) =>
    `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const zoneId = id(1);
  const group = (n: number, name: string) => ({
    shared: {
      definition: { id: `test.${name}`, revision: 1 },
      content: {
        status: "available",
        name,
        description: `description of ${name}`,
        layer: "object",
        anchors: [],
        visual: { sizePx: { width: 48, height: 48 }, attachmentAnchorPx: null },
      },
      placement: {
        kind: "zone",
        zoneId,
        flipped: false,
        rotation: 0,
        offsetPx: { x: 0, y: 0 },
      },
      layout: { status: "available", sizePx: { width: 48, height: 48 } },
    },
    nodes: [
      {
        instanceId: id(n),
        placement: { point: { x: 0, y: 0 } },
        layout: {
          rootInstanceId: id(n),
          rootGridPoint: { x: 0, y: 0 },
          originPx: { x: 0, y: 0 },
        },
      },
    ],
  });
  const now = "2026-09-17T01:00:00.000Z";
  const old = {
    pet: {
      behavior: "sitting",
      facing: "left",
      point: { x: 0, y: 0 },
      updatedAt: now,
      zoneId,
    },
    revisionId: id(2),
    zone: {
      id: zoneId,
      name: "room",
      bounds: { x: 0, y: 0, width: 4, height: 4 },
    },
    targets: [
      {
        instanceId: id(3),
        actions: ["observe"],
        capabilities: ["inspectable"],
        reachable: true,
      },
      {
        instanceId: id(4),
        actions: ["observe"],
        capabilities: ["inspectable"],
        reachable: true,
      },
    ],
    nodeGroups: [group(3, "chair"), group(4, "removed-map")],
  };
  const current = {
    ...old,
    revisionId: id(5),
    targets: old.targets.slice(0, 1),
    nodeGroups: old.nodeGroups.slice(0, 1),
  };
  const source = {
    kind: "run",
    id: id(6),
    fragment: id(7),
    revision: "completed",
  };
  const evidence = {
    id: id(8),
    personaId: id(9),
    actor: "agent",
    kind: "effect",
    source,
    observedAt: now,
    receivedAt: now,
    receiptSequence: 1,
    text: JSON.stringify({
      tool: "territory.observe",
      status: "success",
      summary: "old room",
      result: old,
    }),
    effect: {
      runId: id(6),
      itemId: id(7),
      callId: "old-read",
      outcome: "performed",
      worldChange: "unchanged",
      description: "old room",
      sourceRefs: [source],
    },
  };
  const material = {
    situations: [],
    intent: {
      goal: "inspect the map quietly",
      condition: "do not disturb user",
      revision: 2,
    },
    claims: [
      {
        text: "map was available",
        evidenceIds: [id(8)],
        contradictingEvidenceIds: [id(10)],
      },
    ],
    evidence: [{ use: "history", evidence }],
  };
  const context = createCognitionContextInput({
    text:
      "Selected decision material follows.\n" +
      JSON.stringify(material) +
      "\n\nMemory evidence must remain verbatim.",
    situationIds: [],
    intentIds: [],
    evidenceIds: [id(8)],
    decisionAttemptId: id(11),
  });
  const call = {
    type: "function_call",
    call_id: "new-read",
    name: "observe",
    namespace: "territory",
    arguments: "{}",
  };
  const result = {
    artifacts: [],
    modelContent: current,
    retryable: false,
    status: "success",
    summary: "current room",
  };
  const output = {
    type: "function_call_output",
    call_id: "new-read",
    output: JSON.stringify(result),
  };
  return {
    old,
    current,
    material,
    context,
    call,
    result,
    output,
    input: [context, call, output] as JsonValue[],
  };
}

it("shares only identical historical observation bodies with the actual complete same-zone read and round-trips all fields", () => {
  const fixture = observationSharingFixture();
  const original = structuredClone(fixture.input);
  const projected = shareSelectedObservationBodies(fixture.input);
  const content = (projected[0] as { content: string }).content;
  const material = JSON.parse(
    content.split("\n")[1]!,
  ) as typeof fixture.material;
  const receipt = JSON.parse(material.evidence[0]!.evidence.text) as {
    result: { nodeGroups: JsonValue[] };
  };
  expect(receipt.result.nodeGroups[0]).toEqual({
    sameAsObservation: { callId: "new-read", nodeGroupIndex: 0 },
  });
  expect(receipt.result.nodeGroups[1]).toEqual(fixture.old.nodeGroups[1]);
  // Expansion is an equality check, not a reconstruction of omitted facts.
  receipt.result.nodeGroups[0] = fixture.current.nodeGroups[0]!;
  expect(receipt).toEqual(
    JSON.parse(fixture.material.evidence[0]!.evidence.text),
  );
  material.evidence[0]!.evidence.text =
    fixture.material.evidence[0]!.evidence.text;
  expect(material).toEqual(fixture.material);
  expect(content).toContain("Memory evidence must remain verbatim.");
  expect(content).toContain("remain historical");
  expect(projected[1]).toBe(fixture.call);
  expect(projected[2]).toBe(fixture.output);
  expect(fixture.input).toEqual(original);
  expect(shareSelectedObservationBodies(fixture.input)).toEqual(projected);
  expect(shareSelectedObservationBodies([fixture.context])).toEqual([
    fixture.context,
  ]);
  expect(materializeCognitionContextInput(projected[0]!)).toEqual({
    type: "message",
    role: "developer",
    content,
  });
});

it.each([
  "other-zone",
  "failed-read",
  "partial-read",
  "different-layout",
  "nonempty-arguments",
  "wrong-source",
  "released-body",
  "missing-output",
])("does not share selected evidence through %s", (reason) => {
  const fixture = observationSharingFixture();
  if (reason === "other-zone")
    fixture.result.modelContent = {
      ...fixture.current,
      zone: {
        ...fixture.current.zone,
        id: "10000000-0000-4000-8000-000000000099",
      },
    };
  if (reason === "failed-read") fixture.result.status = "error";
  if (reason === "partial-read")
    fixture.result.modelContent = {
      ...fixture.current,
      nodeGroups: [
        {
          ...fixture.current.nodeGroups[0]!,
          shared: {
            ...fixture.current.nodeGroups[0]!.shared,
            layout: { status: "available" },
          },
        },
      ],
    } as typeof fixture.current;
  if (reason === "different-layout")
    fixture.result.modelContent = {
      ...fixture.current,
      nodeGroups: [
        {
          ...fixture.current.nodeGroups[0]!,
          nodes: [
            {
              ...fixture.current.nodeGroups[0]!.nodes[0]!,
              layout: {
                ...fixture.current.nodeGroups[0]!.nodes[0]!.layout,
                originPx: { x: 100, y: 100 },
              },
            },
          ],
        },
      ],
    };
  if (reason === "nonempty-arguments")
    fixture.call.arguments = '{"zoneId":"other"}';
  if (reason === "wrong-source" || reason === "released-body") {
    const context = fixture.context as { content: string };
    const lines = context.content.split("\n");
    const material = JSON.parse(lines[1]!) as typeof fixture.material;
    if (reason === "wrong-source")
      material.evidence[0]!.evidence.source.fragment = "wrong-item";
    else
      Object.assign(material.evidence[0]!.evidence, {
        bodyReleasedAt: "2026-09-17T02:00:00.000Z",
      });
    lines[1] = JSON.stringify(material);
    context.content = lines.join("\n");
  }
  fixture.output.output = JSON.stringify(fixture.result);
  if (reason === "missing-output") fixture.input.pop();
  expect(shareSelectedObservationBodies(fixture.input)).toEqual(fixture.input);
});

it("applies a changed current Plan and input even when their required material grows", async () => {
  const compiler = new ContextCompiler();
  const handoff = {
    constraints: [],
    currentProgress: [],
    decisions: [],
    nextSteps: [],
  };
  const first = await compiler.compile(
    { items: [], recentUsers: [] },
    { maxPromptTokens: 258_000 },
    handoff,
    true,
  );
  const plan = {
    plan: [
      {
        step: "preserve the newly supplied constraint",
        status: "in_progress" as const,
      },
    ],
  };
  const user = {
    type: "message",
    role: "user",
    content: "do not disturb the user",
  };
  const next = await compiler.compile(
    {
      items: first.input,
      currentPlan: plan,
      currentUserInput: user,
      recentUsers: [],
    },
    { maxPromptTokens: 258_000 },
    handoff,
    true,
  );
  expect(next.compacted).toBe(true);
  expect(JSON.stringify(next.input)).toContain(
    "preserve the newly supplied constraint",
  );
  expect(next.input).toContainEqual(user);
});
