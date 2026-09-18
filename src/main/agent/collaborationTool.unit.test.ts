import { estimateInputBudget } from "../providers/inputBudget";
import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { Run } from "../../shared/contracts/run";
import type { ToolResult } from "../../shared/contracts/tool";
import { defaultPersonaSnapshot } from "../persona/personaPresets";
import { ToolRegistry, toolEvidenceHash } from "../tools/toolRegistry";
import {
  COLLABORATION_DISPATCH_TOOL_NAME,
  registerCollaborationTool,
} from "./collaborationTool";
import type {
  ModelContextLimits,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "./modelProvider";

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const PROFILE_ID = "20000000-0000-4000-8000-000000000002";

const run = {
  chatId: "30000000-0000-4000-8000-000000000003",
  createdAt: "2026-08-13T00:00:00.000Z",
  execution: { approvalMode: "full_access", mode: "agent" },
  id: RUN_ID,
  latestSequence: 1,
  persona: defaultPersonaSnapshot("2026-08-13T00:00:00.000Z"),
  provider: {
    apiStyle: "openai-compatible",
    modelId: "gpt-test",
    profileId: PROFILE_ID,
    profileName: "Test",
  },
  source: "text",
  startedAt: "2026-08-13T00:00:00.000Z",
  status: "running",
} satisfies Run;

class ConcurrentProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  maxActive = 0;
  #active = 0;
  readonly #gate: Promise<void>;
  #release!: () => void;

  constructor() {
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  measureInput(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    return Promise.resolve(this.estimateInput(request));
  }
  estimateInput(request: ModelRequest) {
    return estimateInputBudget(request, request.modelId);
  }

  resolveContextLimits(): Promise<ModelContextLimits> {
    return Promise.resolve({});
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.#active += 1;
    this.maxActive = Math.max(this.maxActive, this.#active);
    if (this.#active === 2) this.#release();
    try {
      await this.#gate;
      signal.throwIfAborted();
      const content = (request.input[0] as Readonly<Record<string, JsonValue>>)[
        "content"
      ];
      if (typeof content !== "string")
        throw new TypeError("Missing child input");
      const child = JSON.parse(content) as { goal: string };
      yield { delta: `摘要：${child.goal}`, type: "text.delta" };
      yield {
        responseId: `response-${String(this.requests.length)}`,
        status: "completed",
        type: "response.completed",
        usage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 4 },
      };
    } finally {
      this.#active -= 1;
    }
  }
}

class BlockingProvider implements ModelProvider {
  started = 0;
  readonly bothStarted: Promise<void>;
  #resolveBoth!: () => void;

  constructor() {
    this.bothStarted = new Promise((resolve) => {
      this.#resolveBoth = resolve;
    });
  }

  measureInput(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    return Promise.resolve(this.estimateInput(request));
  }
  estimateInput(request: ModelRequest) {
    return estimateInputBudget(request, request.modelId);
  }

  resolveContextLimits(): Promise<ModelContextLimits> {
    return Promise.resolve({});
  }

  async *stream(
    _request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    this.started += 1;
    if (this.started === 2) this.#resolveBoth();
    await new Promise<void>((resolve, reject) => {
      const abort = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("cancelled", "AbortError"),
        );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void resolve;
    });
    signal.throwIfAborted();
    yield {
      responseId: "unexpected",
      status: "completed",
      type: "response.completed",
      usage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 },
    };
  }
}

class PartialProvider implements ModelProvider {
  measureInput(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    return Promise.resolve(this.estimateInput(request));
  }
  estimateInput(request: ModelRequest) {
    return estimateInputBudget(request, request.modelId);
  }

  resolveContextLimits(): Promise<ModelContextLimits> {
    return Promise.resolve({});
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    await Promise.resolve();
    signal.throwIfAborted();
    const input = request.input[0];
    const content =
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      typeof input["content"] === "string"
        ? input["content"]
        : "";
    if (content.includes("分析资源 A")) throw new Error("child A failed");
    yield { delta: "子任务 B 完成", type: "text.delta" };
    yield {
      responseId: "response-child-b",
      status: "completed",
      type: "response.completed",
      usage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 4 },
    };
  }
}

function success(summary: string): ToolResult {
  const modelContent = { summary };
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success",
    summary,
  };
}

function registerTestTool(
  registry: ToolRegistry,
  options: {
    readonly effect?: "read" | "write";
    readonly name: string;
    readonly namespace?: string;
  },
): void {
  registry.register({
    descriptor: {
      description: "Test capability",
      effect: options.effect ?? "read",
      idempotency: "idempotent",
      inputSchema: {
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
        type: "object",
      },
      itemKind: "tool_call",
      name: options.name,
      namespace: options.namespace ?? "test",
      source: "builtin",
      summary: "Test read",
    },
    execute: (input) => {
      const value = input["value"];
      if (typeof value !== "string")
        throw new TypeError("value must be a string");
      return Promise.resolve(success(value));
    },
    summarize: () => "Test read",
  });
}

function dispatchInput(
  secondTool = "test.read",
): Readonly<Record<string, JsonValue>> {
  return {
    subtasks: [
      {
        goal: "分析资源 A",
        id: "resource_a",
        reads: [
          {
            input: { value: "A" },
            resourceClaim: "fixture:A",
            toolName: "test.read",
          },
        ],
        resourceClaims: ["fixture:A"],
      },
      {
        goal: "分析资源 B",
        id: "resource_b",
        reads: [
          {
            input: { value: "B" },
            resourceClaim: "fixture:B",
            toolName: secondTool,
          },
        ],
        resourceClaims: ["fixture:B"],
      },
    ],
  };
}

function setup() {
  const registry = new ToolRegistry();
  const provider = new ConcurrentProvider();
  registerTestTool(registry, { name: "test.read" });
  registerCollaborationTool(registry, {
    createChatModelRuntime: () =>
      Promise.resolve({ provider, snapshot: run.provider }),
    getRun: (runId) => (runId === RUN_ID ? run : undefined),
  });
  return { provider, registry };
}

function execute(
  registry: ToolRegistry,
  input: Readonly<Record<string, JsonValue>>,
  availableToolNames: readonly string[] = [
    COLLABORATION_DISPATCH_TOOL_NAME,
    "test.read",
  ],
) {
  return registry.execute(COLLABORATION_DISPATCH_TOOL_NAME, input, {
    availableToolNames,
    itemId: "40000000-0000-4000-8000-000000000004",
    onDelta: () => undefined,
    runId: RUN_ID,
    signal: new AbortController().signal,
  });
}

describe("collaboration.dispatch", () => {
  it("runs exactly two bounded read-only children concurrently and returns both for parent join", async () => {
    const { provider, registry } = setup();

    const result = await execute(registry, dispatchInput());

    expect(result).toMatchObject({
      modelContent: {
        children: [
          {
            id: "resource_a",
            status: "completed",
            summary: "摘要：分析资源 A",
          },
          {
            id: "resource_b",
            status: "completed",
            summary: "摘要：分析资源 B",
          },
        ],
        joinRequired: true,
      },
      status: "success",
    });
    expect(provider.maxActive).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(
      provider.requests.every(
        ({ nativeWebSearch, toolNamespaces }) =>
          nativeWebSearch === false && toolNamespaces.length === 0,
      ),
    ).toBe(true);
    expect(
      registry.get(COLLABORATION_DISPATCH_TOOL_NAME)?.descriptor,
    ).toMatchObject({
      effect: "read",
      idempotency: "idempotent",
      itemKind: "subtask",
    });
  });

  it("rejects overlapping claims before creating child model work", async () => {
    const { provider, registry } = setup();
    const input = dispatchInput();
    const subtasks = input["subtasks"] as JsonValue[];
    const second = subtasks[1] as Record<string, JsonValue>;
    second["resourceClaims"] = ["fixture:A"];
    const reads = second["reads"] as JsonValue[];
    (reads[0] as Record<string, JsonValue>)["resourceClaim"] = "fixture:A";

    await expect(execute(registry, input)).rejects.toThrow(
      /Resource claim fixture:A is shared/u,
    );
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects write, mutable-session, and out-of-scope child Tools", async () => {
    const cases = [
      { effect: "write" as const, name: "test.write", namespace: "test" },
      {
        effect: "read" as const,
        name: "browser.snapshot",
        namespace: "browser",
      },
    ];
    for (const candidate of cases) {
      const { registry } = setup();
      registerTestTool(registry, candidate);
      const input = dispatchInput(candidate.name);
      const available = [
        COLLABORATION_DISPATCH_TOOL_NAME,
        "test.read",
        candidate.name,
      ];
      await expect(execute(registry, input, available)).rejects.toThrow();
    }
  });

  it("rejects a child read outside the current Run Tool scope", async () => {
    const { registry } = setup();
    registerTestTool(registry, { name: "test.hidden" });

    await expect(
      execute(registry, dispatchInput("test.hidden")),
    ).rejects.toThrow(/outside this Run scope/u);
  });

  it("propagates one parent cancellation to both active children", async () => {
    const registry = new ToolRegistry();
    const provider = new BlockingProvider();
    registerTestTool(registry, { name: "test.read" });
    registerCollaborationTool(registry, {
      createChatModelRuntime: () =>
        Promise.resolve({ provider, snapshot: run.provider }),
      getRun: (runId) => (runId === RUN_ID ? run : undefined),
    });
    const abort = new AbortController();
    const execution = registry.execute(
      COLLABORATION_DISPATCH_TOOL_NAME,
      dispatchInput(),
      {
        availableToolNames: [COLLABORATION_DISPATCH_TOOL_NAME, "test.read"],
        itemId: "40000000-0000-4000-8000-000000000004",
        onDelta: () => undefined,
        runId: RUN_ID,
        signal: abort.signal,
      },
    );
    await provider.bothStarted;

    abort.abort(new DOMException("cancelled", "AbortError"));

    await expect(execution).rejects.toThrow(/cancelled/u);
    expect(provider.started).toBe(2);
  });

  it("waits for the other child and preserves bounded evidence when one analysis fails", async () => {
    const registry = new ToolRegistry();
    const provider = new PartialProvider();
    registerTestTool(registry, { name: "test.read" });
    registerCollaborationTool(registry, {
      createChatModelRuntime: () =>
        Promise.resolve({ provider, snapshot: run.provider }),
      getRun: (runId) => (runId === RUN_ID ? run : undefined),
    });

    const result = await execute(registry, dispatchInput());

    expect(result).toMatchObject({
      error: {
        code: "AGENT.COLLABORATION_FAILED",
        details: { failedChildIds: ["resource_a"] },
      },
      modelContent: {
        children: [
          { evidence: [{ resourceClaim: "fixture:A" }], status: "failed" },
          {
            evidence: [{ resourceClaim: "fixture:B" }],
            status: "completed",
            summary: "子任务 B 完成",
          },
        ],
        joinRequired: true,
      },
      status: "error",
    });
  });
});
