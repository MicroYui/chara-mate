import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryConsolidationRuntime } from "../../src/main/app/memoryConsolidationRuntime";
import type { MemoryConsolidationInput } from "../../src/main/memory/memoryConsolidation";
import { OpenAIResponsesModelProvider } from "../../src/main/providers/openaiModelProvider";
import { fitsInputBudget } from "../../src/main/providers/inputBudget";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
});

const output = {
  disposition: "retain_originals",
  reason: "保留原始材料。",
  dependencies: [],
  citations: [],
};
const input: MemoryConsolidationInput = {
  anchorRevisionId: "allocation-anchor",
  evidence: [
    {
      memoryId: "allocation-memory",
      revisionId: "allocation-anchor",
      type: "event",
      content: "照片要等核对日期以后再移动。",
      recordedAt: "2026-09-16T11:00:00.000Z",
      current: true,
      historyStatus: "current",
      entityIds: [],
      questionIds: ["developments"],
      sourceRefs: [
        {
          sourceId: "allocation-source",
          referenceId: "allocation-chat",
          type: "chat",
          spans: [
            {
              start: 0,
              end: "照片要等核对日期以后再移动。".length,
              quote: "照片要等核对日期以后再移动。",
            },
          ],
        },
      ],
    },
  ],
  support: [],
  coverage: {
    namespaceFormationIncomplete: false,
    retrieval: {
      coverage: [],
      gaps: [],
      truncated: false,
      incompleteReasons: [],
    },
    materialOmissions: [
      { revisionId: "read-tail", reason: "resource_limit" },
      { revisionId: "request-tail", reason: "input_limit" },
    ],
    supplied: [],
    knownFormationConnections: [],
  },
};

async function fixture(
  options: {
    count?: number;
    status?: number;
    holdCount?: Promise<void>;
    entered?: () => void;
  } = {},
) {
  const requests: { url: string; body?: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new TypeError("Expected HTTP bytes");
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({
        url: request.url ?? "",
        ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}),
      });
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "allocation-model",
                object: "model",
                created: 1,
                owned_by: "fixture",
                context_window: 3000,
                max_output_tokens: 2000,
              },
            ],
          }),
        );
      } else if (request.url === "/v1/responses/input_tokens") {
        options.entered?.();
        await options.holdCount;
        if (response.destroyed) return;
        response.writeHead(options.status ?? 200, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify(
            options.status
              ? { error: { message: "count fixture response" } }
              : {
                  object: "response.input_tokens",
                  input_tokens: options.count ?? 1000,
                },
          ),
        );
      } else if (request.url === "/v1/responses") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          {
            type: "response.output_text.delta",
            item_id: "message-fixture",
            content_index: 0,
            output_index: 0,
            delta: JSON.stringify(output),
          },
          {
            type: "response.completed",
            response: {
              id: "response-fixture",
              status: "completed",
              output: [],
              usage: {
                input_tokens: 1000,
                output_tokens: 12,
                input_tokens_details: { cached_tokens: 4 },
              },
            },
          },
        ])
          response.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        response.end();
      } else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "unexpected fixture route" } }),
        );
      }
    })().catch((error: unknown) => {
      if (response.destroyed) return;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : "fixture error",
          },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const snapshot = {
    profileId: "allocation-profile",
    profileName: "Offline actual SDK",
    apiStyle: "openai-compatible" as const,
    modelId: "allocation-model",
  };
  const provider = new OpenAIResponsesModelProvider(
    {
      id: snapshot.profileId,
      apiStyle: snapshot.apiStyle,
      name: snapshot.profileName,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    },
    "fixture-key",
  );
  const createRuntime = vi.fn(() => Promise.resolve({ provider, snapshot }));
  const onUsage = vi.fn();
  const runtime = createMemoryConsolidationRuntime(
    {
      getDefaultChatProfileId: () => snapshot.profileId,
      createSnapshot: () => snapshot,
      createChatModelRuntime: createRuntime,
    },
    onUsage,
  );
  const controller = new AbortController();
  const execution = {
    expectedProcessorVersion: runtime.version,
    assertInputCurrent: vi.fn(),
  };
  const model = await runtime.bind(execution, controller.signal);
  return { model, execution, controller, requests, createRuntime, onUsage };
}

describe("consolidation complete request through actual SDK", () => {
  it("counts full instructions/schema and reuses the same last wire for generation with an output reserve", async () => {
    const f = await fixture();
    const measured = await f.model.measureInput(
      input,
      f.execution,
      f.controller.signal,
    );
    expect(measured.budget).toBe(1000);
    expect(measured.measurement.exactInputTokens).toBe(1000);
    expect(measured.measurement.estimatedTokens).toBeGreaterThan(1000);
    expect(fitsInputBudget(measured.measurement, measured.budget)).toBe(true);
    await expect(
      f.model.consolidate(input, f.execution, f.controller.signal),
    ).resolves.toEqual(output);
    expect(f.requests.map(({ url }) => url)).toEqual([
      "/v1/models",
      "/v1/responses/input_tokens",
      "/v1/responses",
    ]);
    const count = f.requests[1]!.body!,
      generation = f.requests[2]!.body!;
    for (const [key, value] of Object.entries(count))
      expect(generation[key]).toEqual(value);
    expect(count["instructions"]).toContain("Every dependency");
    expect(count["text"]).toMatchObject({
      format: { type: "json_schema", name: "memory_consolidation" },
    });
    expect(count["input"]).toEqual(generation["input"]);
    expect(count["input"]).toEqual([
      { role: "user", type: "message", content: JSON.stringify(input) },
    ]);
    expect(f.createRuntime).toHaveBeenCalledOnce();
    expect(f.onUsage).toHaveBeenCalledOnce();
    expect(f.onUsage).toHaveBeenCalledWith({
      inputTokens: 1000,
      outputTokens: 12,
      cachedInputTokens: 4,
    });
  });

  it.each([404, 405, 501])(
    "keeps unsupported count %s conservative and never generates an oversized request",
    async (status) => {
      const f = await fixture({ status });
      const measured = await f.model.measureInput(
        input,
        f.execution,
        f.controller.signal,
      );
      expect(measured.measurement.exactInputTokens).toBeUndefined();
      expect(fitsInputBudget(measured.measurement, measured.budget)).toBe(
        false,
      );
      await expect(
        f.model.consolidate(input, f.execution, f.controller.signal),
      ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
      expect(f.requests.map(({ url }) => url)).toEqual([
        "/v1/models",
        "/v1/responses/input_tokens",
      ]);
      expect(f.onUsage).not.toHaveBeenCalled();
    },
  );

  it.each([
    [400, "PROVIDER.REQUEST_FAILED"],
    [503, "PROVIDER.UNAVAILABLE"],
  ] as const)(
    "preserves real count %s errors without generation or false unknown-success",
    async (status, code) => {
      const f = await fixture({ status });
      await expect(
        f.model.measureInput(input, f.execution, f.controller.signal),
      ).rejects.toMatchObject({
        code,
        requestIdentity: {
          profileId: "allocation-profile",
          modelId: "allocation-model",
        },
      });
      expect(f.onUsage).not.toHaveBeenCalled();
      expect(f.requests.map(({ url }) => url)).toEqual([
        "/v1/models",
        "/v1/responses/input_tokens",
      ]);
    },
  );

  it("joins an owned cancelled count without accepting its late value or reporting generation usage", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const holdCount = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({ holdCount, entered: enter });
    const pending = f.model.measureInput(
      input,
      f.execution,
      f.controller.signal,
    );
    const settled = pending.catch((error: unknown) => error);
    try {
      await entered;
      f.controller.abort(new Error("owner stopped preparation"));
      release();
      expect(await settled).toBe(f.controller.signal.reason);
      expect(f.requests.map(({ url }) => url)).toEqual([
        "/v1/models",
        "/v1/responses/input_tokens",
      ]);
      expect(f.onUsage).not.toHaveBeenCalled();
    } finally {
      f.controller.abort();
      release();
      await settled;
    }
  });
});
