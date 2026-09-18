import { estimateInputBudget } from "../../src/main/providers/inputBudget";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectModelTurn,
  type ModelEvent,
  type ModelRequest,
  type ModelUsage,
} from "../../src/main/agent/modelProvider";
import { OpenAIResponsesModelProvider } from "../../src/main/providers/openaiModelProvider";
import type { JsonValue } from "../../src/shared/contracts/primitives";
import citationFixture from "../fixtures/openai-citations.json";
import type { ProviderProfileDraft } from "../../src/shared/contracts/provider";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    ),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}/v1`;
}

async function requestBody(request: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
}

function handleUnsupportedBudgetProbe(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (request.method !== "GET" && !request.url?.includes("/input_tokens"))
    return false;
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "not found" } }));
  return true;
}

function responseEvents(): readonly JsonValue[] {
  return [
    { delta: "完成", type: "response.output_text.delta" },
    {
      item: {
        arguments:
          '{"toolName":"charamate_file.read","url":"https://example.com"}',
        call_id: "call-1",
        name: "navigate",
        namespace: "charamate_browser",
        type: "function_call",
      },
      type: "response.output_item.done",
    },
    {
      response: {
        id: "response-1",
        usage: {
          input_tokens: 17,
          input_tokens_details: { cached_tokens: 8 },
          output_tokens: 3,
        },
      },
      type: "response.completed",
    },
  ];
}

function writeEventStream(
  response: ServerResponse,
  events: readonly JsonValue[] = responseEvents(),
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    const rawType =
      typeof event === "object" && event !== null && !Array.isArray(event)
        ? event["type"]
        : "message";
    const type = typeof rawType === "string" ? rawType : "message";
    response.write(
      `event: ${String(type)}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

async function collect(
  provider: OpenAIResponsesModelProvider,
  modelId: string,
  withTools: boolean,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(
    {
      input: withTools
        ? [
            { content: "test", role: "user", type: "message" },
            {
              arguments: '{"url":"https://example.com"}',
              call_id: "prior-call",
              name: "browser.navigate",
              namespace: "browser",
              type: "function_call",
            },
            {
              call_id: "search-call",
              execution: "client",
              status: "completed",
              tools: [
                {
                  description: "Browser tools",
                  name: "browser",
                  tools: [
                    {
                      description: "Navigate",
                      name: "browser.navigate",
                      parameters: {
                        additionalProperties: false,
                        properties: { url: { type: "string" } },
                        required: ["url"],
                        type: "object",
                      },
                      strict: true,
                      type: "function",
                    },
                  ],
                  type: "namespace",
                },
                {
                  description: "File tools",
                  name: "file",
                  tools: [
                    {
                      description: "Read a file",
                      name: "file.read",
                      parameters: {
                        additionalProperties: false,
                        properties: { path: { type: "string" } },
                        required: ["path"],
                        type: "object",
                      },
                      strict: true,
                      type: "function",
                    },
                  ],
                  type: "namespace",
                },
              ],
              type: "tool_search_output",
            },
          ]
        : [{ content: "test", role: "user", type: "message" }],
      instructions: "test",
      modelId,
      nativeWebSearch: true,
      toolNamespaces: withTools
        ? [
            {
              description: "Local files",
              name: "browser",
              tools: [
                {
                  description: "Navigate",
                  inputSchema: {
                    additionalProperties: false,
                    properties: { url: { type: "string" } },
                    required: ["url"],
                    type: "object",
                  },
                  name: "browser.navigate",
                  namespace: "browser",
                  strict: true,
                },
              ],
            },
            {
              description: "Computer controls",
              name: "computer",
              tools: [
                {
                  description: "Capture the screen",
                  inputSchema: {
                    additionalProperties: false,
                    properties: {},
                    required: [],
                    type: "object",
                  },
                  name: "computer.snapshot",
                  namespace: "computer",
                  strict: true,
                },
              ],
            },
            {
              description: "Agent collaboration",
              name: "collaboration",
              tools: [
                {
                  deferLoading: false,
                  description: "Dispatch two read-only child tasks",
                  inputSchema: {
                    additionalProperties: false,
                    properties: { subtasks: { type: "array" } },
                    required: ["subtasks"],
                    type: "object",
                  },
                  name: "collaboration.dispatch",
                  namespace: "collaboration",
                  strict: true,
                },
              ],
            },
            {
              description: "Local files",
              name: "file",
              tools: [
                {
                  deferLoading: false,
                  description: "Read a file",
                  inputSchema: {
                    additionalProperties: false,
                    properties: { path: { type: "string" } },
                    required: ["path"],
                    type: "object",
                  },
                  name: "file.read",
                  namespace: "file",
                  strict: true,
                },
              ],
            },
            {
              description: "Current plan",
              name: "plan",
              tools: [
                {
                  deferLoading: false,
                  description: "Update the current plan",
                  inputSchema: {
                    additionalProperties: false,
                    properties: { plan: { type: "array" } },
                    required: ["plan"],
                    type: "object",
                  },
                  name: "plan.update",
                  namespace: "plan",
                  strict: true,
                },
              ],
            },
            {
              description: "Territory item generation",
              name: "territory",
              tools: [
                {
                  description: "Generate a Territory item candidate",
                  inputSchema: {
                    additionalProperties: false,
                    properties: { name: { type: "string" } },
                    required: ["name"],
                    type: "object",
                  },
                  name: "territory.generate_item",
                  namespace: "territory",
                  strict: false,
                },
              ],
            },
          ]
        : [],
      ...(withTools
        ? {
            allowedTools: [
              { name: "browser.navigate", namespace: "browser" },
              { name: "file.read", namespace: "file" },
            ],
          }
        : {}),
    },
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

describe("OpenAI Responses Agent wire shape", () => {
  it.each([
    {
      label: "complete",
      wireUsage: {
        input_tokens: 17,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens: 3,
      },
      expected: { cachedInputTokens: 8, inputTokens: 17, outputTokens: 3 },
    },
    {
      label: "reported zero",
      wireUsage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
      },
      expected: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 },
    },
    { label: "absent usage", wireUsage: undefined, expected: {} },
    { label: "empty usage", wireUsage: {}, expected: {} },
    {
      label: "absent input details",
      wireUsage: { input_tokens: 17, output_tokens: 3 },
      expected: { inputTokens: 17, outputTokens: 3 },
    },
    {
      label: "cached input only",
      wireUsage: { input_tokens_details: { cached_tokens: 8 } },
      expected: { cachedInputTokens: 8 },
    },
    {
      label: "output only",
      wireUsage: { output_tokens: 3 },
      expected: { outputTokens: 3 },
    },
  ] satisfies readonly {
    label: string;
    wireUsage: JsonValue | undefined;
    expected: ModelUsage;
  }[])(
    "preserves $label through actual SDK SSE and turn collection",
    async ({ wireUsage, expected }) => {
      const bodies: JsonValue[] = [];
      const server = createServer((incoming, response) => {
        if (handleUnsupportedBudgetProbe(incoming, response)) return;
        void requestBody(incoming).then((body) => {
          bodies.push(body);
          writeEventStream(response, [
            { type: "response.output_text.delta", delta: "实际完成" },
            {
              type: "response.completed",
              response: {
                id: "usage-presence-response",
                ...(wireUsage === undefined ? {} : { usage: wireUsage }),
              },
            },
          ]);
        });
      });
      const provider = new OpenAIResponsesModelProvider(
        {
          apiStyle: "openai-compatible",
          baseUrl: await listen(server),
          name: "Usage presence",
        },
        "test-secret",
      );
      const request: ModelRequest = {
        input: [{ type: "message", role: "user", content: "核对用量" }],
        instructions: "保持同一完整请求。",
        modelId: "gpt-6-astra",
        toolNamespaces: [],
      };
      const before = provider.estimateInput(request);
      const turn = await collectModelTurn(
        provider.stream(request, new AbortController().signal),
      );
      expect(turn).toMatchObject({
        responseId: "usage-presence-response",
        status: "completed",
        text: "实际完成",
      });
      expect(turn.usage).toEqual(expected);
      expect(bodies).toHaveLength(1);
      expect(before).toEqual(estimateInputBudget(bodies[0], request.modelId));
      expect(bodies[0]).toMatchObject({
        input: request.input,
        instructions: request.instructions,
        model: request.modelId,
      });
    },
  );

  it("estimates the actual final wire body with mapped tools, native tools and output schema without another request", async () => {
    const bodies: JsonValue[] = [];
    let networkRequests = 0;
    const server = createServer((incoming, response) => {
      networkRequests += 1;
      if (handleUnsupportedBudgetProbe(incoming, response)) return;
      void requestBody(incoming).then((body) => {
        bodies.push(body);
        writeEventStream(response);
      });
    });
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl: await listen(server),
        name: "Wire measurement",
      },
      "test-secret",
    );
    const request: ModelRequest = {
      input: [
        {
          type: "function_call",
          namespace: "file",
          name: "file.read",
          call_id: "read-1",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "read-1",
          output: "actual receipt",
        },
      ],
      instructions: "Current role and required task conditions.",
      modelId: "gpt-6-astra",
      maxOutputTokens: 4096,
      nativeWebSearch: true,
      structuredOutput: {
        name: "result",
        schema: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
          additionalProperties: false,
        },
      },
      toolNamespaces: [
        {
          name: "file",
          description: "Files",
          tools: [
            {
              name: "file.read",
              namespace: "file",
              description: "Read a file",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              strict: true,
            },
          ],
        },
      ],
    };
    const before = provider.estimateInput(request);
    expect(networkRequests).toBe(0);
    await collectModelTurn(
      provider.stream(request, new AbortController().signal),
    );
    expect(bodies).toHaveLength(1);
    expect(before).toEqual(estimateInputBudget(bodies[0], request.modelId));
    expect(JSON.stringify(bodies[0])).toContain("charamate_file");
    expect(JSON.stringify(bodies[0])).toContain("tool_search");
    expect(JSON.stringify(bodies[0])).toContain("json_schema");
  });

  it("streams saved raw deltas immediately and materializes citations only at completion", async () => {
    let finish!: () => void;
    let streamed!: () => void;
    const received = new Promise<void>((resolve) => {
      streamed = resolve;
    });
    const server = createServer((request, response) => {
      if (handleUnsupportedBudgetProbe(request, response)) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: JsonValue) =>
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      for (const delta of citationFixture.deltas)
        send({ type: "response.output_text.delta", delta });
      send({ type: "response.output_item.done", item: citationFixture.item });
      finish = () => {
        send({
          type: "response.completed",
          response: {
            id: "response-citations",
            output: [citationFixture.item],
            usage: citationFixture.usage,
          },
        });
        response.end("data: [DONE]\n\n");
      };
    });
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl: await listen(server),
        name: "Saved SSE",
      },
      "test-secret",
    );
    const deltas: string[] = [];
    let completed = false;
    const result = collectModelTurn(
      provider.stream(
        {
          input: [],
          instructions: "Offline replay",
          modelId: "gpt-6-astra",
          toolNamespaces: [],
        },
        new AbortController().signal,
      ),
      (delta) => {
        deltas.push(delta);
        if (deltas.length === citationFixture.deltas.length) streamed();
      },
    ).then((turn) => {
      completed = true;
      return turn;
    });
    await received;
    expect(completed).toBe(false);
    expect(deltas).toEqual(citationFixture.deltas);
    finish();
    const turn = await result;
    expect(turn.text).toBe(citationFixture.deltas.join(""));
    expect(turn.outputItems).toEqual([citationFixture.item]);
    expect(turn.displayText).toContain(
      "[1](<https://docs.stripe.com/webhooks?",
    );
    expect(turn.displayText).not.toContain("\uE200cite\uE202");
  });

  it("keeps streamed text without inventing completed citations when cancelled", async () => {
    const server = createServer((request, response) => {
      if (handleUnsupportedBudgetProbe(request, response)) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: citationFixture.deltas.join("") })}\n\n`,
      );
      response.once("close", () => response.end());
    });
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl: await listen(server),
        name: "Cancelled SSE",
      },
      "test-secret",
    );
    const abort = new AbortController();
    const events: ModelEvent[] = [];
    let text = "";
    async function* observedEvents(): AsyncIterable<ModelEvent> {
      for await (const event of provider.stream(
        {
          input: [],
          instructions: "Offline replay",
          modelId: "gpt-6-astra",
          toolNamespaces: [],
        },
        abort.signal,
      )) {
        events.push(event);
        yield event;
      }
    }
    const replay = collectModelTurn(observedEvents(), (delta) => {
      text += delta;
      abort.abort();
    });
    // SDK 6.49.0 ends iteration on AbortError; the collector still rejects a
    // missing terminal event, and Runtime recognizes the aborted signal.
    await expect(replay).rejects.toThrow(
      "Provider stream ended without response.completed",
    );
    expect(text).toBe(citationFixture.deltas.join(""));
    expect(events.some((event) => event.type === "response.completed")).toBe(
      false,
    );
  });

  it("preserves image content and omits Tool Search for an always-loaded core namespace", async () => {
    const bodies: JsonValue[] = [];
    const baseUrl = await listen(
      createServer((request, response) => {
        if (handleUnsupportedBudgetProbe(request, response)) return;
        void requestBody(request).then((body) => {
          bodies.push(body);
          writeEventStream(response);
        });
      }),
    );
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Test Provider",
      },
      "test-secret",
    );
    const events: ModelEvent[] = [];
    for await (const event of provider.stream(
      {
        input: [
          {
            content: [
              { text: "inspect", type: "input_text" },
              {
                detail: "auto",
                image_url: "data:image/png;base64,aW1hZ2U=",
                type: "input_image",
              },
            ],
            role: "user",
            type: "message",
          },
        ],
        instructions: "test",
        modelId: "gpt-5.6-sol",
        nativeWebSearch: true,
        toolNamespaces: [
          {
            description: "Structured interaction",
            name: "interaction",
            tools: [
              {
                deferLoading: false,
                description: "Ask the user",
                inputSchema: {
                  additionalProperties: false,
                  properties: { questions: { type: "array" } },
                  required: ["questions"],
                  type: "object",
                },
                name: "request_user_input",
                namespace: "interaction",
                strict: true,
              },
            ],
          },
        ],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(bodies[0]).toMatchObject({
      input: [
        {
          content: [
            { type: "input_text" },
            {
              detail: "auto",
              image_url: "data:image/png;base64,aW1hZ2U=",
              type: "input_image",
            },
          ],
        },
      ],
      tools: [
        {
          name: "charamate_interaction",
          tools: [
            {
              defer_loading: false,
              name: "request_user_input",
              type: "function",
            },
          ],
          type: "namespace",
        },
        { type: "web_search" },
      ],
    });
    expect(JSON.stringify(bodies[0])).not.toContain('"type":"tool_search"');
  });

  it("prefixes every client namespace and uses portable Tool Search continuation", async () => {
    const bodies: JsonValue[] = [];
    const baseUrl = await listen(
      createServer((request, response) => {
        if (request.method === "GET") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              data: [
                {
                  context_window: 1_050_000,
                  id: "gpt-5.6-sol",
                  max_input_tokens: 922_000,
                  max_output_tokens: 128_000,
                  object: "model",
                  owned_by: "openai",
                },
              ],
              object: "list",
            }),
          );
          return;
        }
        if (handleUnsupportedBudgetProbe(request, response)) return;
        void requestBody(request).then((body) => {
          bodies.push(body);
          writeEventStream(response);
        });
      }),
    );
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Test Provider",
      },
      "test-secret",
    );

    await expect(provider.resolveContextLimits("gpt-5.6-sol")).resolves.toEqual(
      {
        effectiveInputTokens: 922_000,
        maxContextTokens: 1_050_000,
        maxOutputTokens: 128_000,
        maxPromptTokens: 922_000,
      },
    );
    await expect(collect(provider, "gpt-5.6-sol", true)).resolves.toEqual([
      { delta: "完成", type: "text.delta" },
      {
        item: {
          arguments:
            '{"toolName":"charamate_file.read","url":"https://example.com"}',
          call_id: "call-1",
          name: "navigate",
          namespace: "browser",
          type: "function_call",
        },
        runtimeArguments: {
          toolName: "file.read",
          url: "https://example.com",
        },
        type: "output.item",
      },
      {
        responseId: "response-1",
        status: "completed",
        type: "response.completed",
        usage: { cachedInputTokens: 8, inputTokens: 17, outputTokens: 3 },
      },
    ]);

    const wire = JSON.stringify(bodies[0]);
    expect(wire).toContain('"type":"namespace"');
    expect(wire).toContain('"defer_loading":true');
    expect(wire).toContain('"strict":true');
    expect(wire).toContain('"type":"tool_search"');
    expect(wire).toContain('"execution":"client"');
    expect(wire).not.toContain('"type":"allowed_tools"');
    expect(bodies[0]).toMatchObject({
      tool_choice: "auto",
      tools: [
        {
          name: "charamate_browser",
          tools: [{ name: "navigate", type: "function" }],
          type: "namespace",
        },
        {
          name: "charamate_computer",
          tools: [{ name: "snapshot", type: "function" }],
          type: "namespace",
        },
        {
          name: "charamate_collaboration",
          tools: [{ defer_loading: false, name: "dispatch", type: "function" }],
          type: "namespace",
        },
        {
          name: "charamate_file",
          tools: [{ defer_loading: false, name: "read", type: "function" }],
          type: "namespace",
        },
        {
          name: "charamate_plan",
          tools: [{ defer_loading: false, name: "update", type: "function" }],
          type: "namespace",
        },
        {
          name: "charamate_territory",
          tools: [{ name: "generate_item", strict: false, type: "function" }],
          type: "namespace",
        },
        { type: "tool_search" },
        { type: "web_search" },
      ],
    });
    expect(bodies[0]).toMatchObject({
      input: [
        { type: "message" },
        {
          name: "navigate",
          namespace: "charamate_browser",
          type: "function_call",
        },
        {
          tools: [
            {
              name: "charamate_browser",
              tools: [{ name: "navigate", type: "function" }],
              type: "namespace",
            },
            {
              name: "charamate_file",
              tools: [{ name: "read", type: "function" }],
              type: "namespace",
            },
          ],
          type: "tool_search_output",
        },
      ],
    });
    expect(wire).not.toContain('"name":"browser.navigate"');
    expect(wire).not.toContain('"name":"collaboration.dispatch"');
    expect(wire).not.toContain('"name":"computer.snapshot"');
    expect(wire).not.toContain('"name":"file.read"');
    expect(wire).not.toContain('"name":"territory.generate_item"');
    expect(wire).toContain(
      '"prompt_cache_options":{"mode":"implicit","ttl":"30m"}',
    );
    expect(wire).not.toContain("prompt_cache_key");
    expect(wire).not.toContain("prompt_cache_breakpoint");
    expect(wire).toContain('"parallel_tool_calls":false');
    expect(wire).toContain('"store":false');
  });

  it("forwards a strict JSON Schema response format without adding a Tool", async () => {
    const bodies: JsonValue[] = [];
    const baseUrl = await listen(
      createServer((request, response) => {
        if (handleUnsupportedBudgetProbe(request, response)) return;
        void requestBody(request).then((body) => {
          bodies.push(body);
          writeEventStream(response);
        });
      }),
    );
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Structured Output Provider",
      },
      "test-secret",
    );

    const events: ModelEvent[] = [];
    for await (const event of provider.stream(
      {
        input: [{ content: "review", role: "user", type: "message" }],
        instructions: "Return one structured review.",
        modelId: "structured-model",
        structuredOutput: {
          description: "Review result",
          name: "charamate_review",
          schema: {
            additionalProperties: false,
            properties: { candidates: { type: "array" } },
            required: ["candidates"],
            type: "object",
          },
        },
        toolNamespaces: [],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      text: {
        format: {
          description: "Review result",
          name: "charamate_review",
          schema: {
            additionalProperties: false,
            required: ["candidates"],
            type: "object",
          },
          strict: true,
          type: "json_schema",
        },
      },
    });
    expect(bodies[0]).not.toHaveProperty("tools");
  });

  it("resolves Copilot nested model limits from the standard model list", async () => {
    const requests: string[] = [];
    const baseUrl = await listen(
      createServer((request, response) => {
        requests.push(`${request.method ?? "GET"} ${request.url ?? ""}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [
              {
                capabilities: {
                  limits: {
                    max_context_window_tokens: 1_050_000,
                    max_output_tokens: 128_000,
                    max_prompt_tokens: 922_000,
                    vision: {
                      max_prompt_images: 1,
                      supported_media_types: ["image/png"],
                    },
                  },
                  supports: { vision: true },
                },
                id: "gpt-5.6-sol",
                object: "model",
                owned_by: "OpenAI",
              },
            ],
            object: "list",
          }),
        );
      }),
    );
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Copilot-compatible",
      },
      "test-secret",
    );

    await expect(provider.resolveContextLimits("gpt-5.6-sol")).resolves.toEqual(
      {
        effectiveInputTokens: 922_000,
        maxContextTokens: 1_050_000,
        maxOutputTokens: 128_000,
        maxPromptTokens: 922_000,
        supportsVision: true,
      },
    );
    expect(requests).toEqual(["GET /v1/models"]);
  });

  it("uses Codex effective-window metadata when the list needs a detail lookup", async () => {
    const requests: string[] = [];
    const baseUrl = await listen(
      createServer((request, response) => {
        requests.push(`${request.method ?? "GET"} ${request.url ?? ""}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          request.url === "/v1/models"
            ? JSON.stringify({
                data: [
                  {
                    id: "gpt-5.6-sol",
                    object: "model",
                    owned_by: "openai",
                  },
                ],
                object: "list",
              })
            : JSON.stringify({
                context_window: 272_000,
                effective_context_window_percent: 95,
                id: "gpt-5.6-sol",
                max_context_window: 272_000,
                object: "model",
                owned_by: "openai",
              }),
        );
      }),
    );
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Codex-compatible",
      },
      "test-secret",
    );

    await expect(provider.resolveContextLimits("gpt-5.6-sol")).resolves.toEqual(
      {
        effectiveInputTokens: 258_400,
        maxContextTokens: 272_000,
      },
    );
    expect(requests).toEqual(["GET /v1/models", "GET /v1/models/gpt-5.6-sol"]);
  });

  it("intersects conflicting aliases and nested Provider limits", async () => {
    const baseUrl = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "gpt-6-astra",
                object: "model",
                owned_by: "test",
                context_window: 30_000,
                max_input_tokens: 18_000,
                max_prompt_tokens: 17_000,
                max_output_tokens: 4_000,
                capabilities: {
                  limits: {
                    max_context_window_tokens: 20_000,
                    max_prompt_tokens: 16_000,
                    max_output_tokens: 6_000,
                    effective_context_window_percent: 95,
                  },
                },
              },
            ],
          }),
        );
      }),
    );
    const provider = new OpenAIResponsesModelProvider(
      { apiStyle: "openai-compatible", baseUrl, name: "Conflicting metadata" },
      "test-secret",
    );
    await expect(provider.resolveContextLimits("gpt-6-astra")).resolves.toEqual(
      {
        effectiveInputTokens: 16_000,
        maxContextTokens: 20_000,
        maxOutputTokens: 4_000,
        maxPromptTokens: 16_000,
      },
    );
  });

  it("cancels an in-flight model metadata request", async () => {
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const baseUrl = await listen(
      createServer((request, response) => {
        markRequestStarted();
        request.once("close", () => response.destroy());
      }),
    );
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Abortable compatible",
      },
      "test-secret",
    );
    const controller = new AbortController();

    const resolving = provider.resolveContextLimits(
      "gpt-5.6-sol",
      controller.signal,
    );
    const cancelled = expect(resolving).rejects.toMatchObject({
      name: "AbortError",
    });
    await requestStarted;
    controller.abort();

    await cancelled;
  });

  it("keeps context limits unknown when neither metadata endpoint supports them", async () => {
    const baseUrl = await listen(
      createServer((_request, response) => {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "not found", type: "invalid_request_error" },
          }),
        );
      }),
    );
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Manual compatible",
      },
      "test-secret",
    );

    await expect(
      provider.resolveContextLimits("manual-model"),
    ).resolves.toEqual({});
  });

  it("gives Chat only native read-only web search and does not apply cache evidence to other models", async () => {
    const bodies: JsonValue[] = [];
    const baseUrl = await listen(
      createServer((request, response) => {
        if (handleUnsupportedBudgetProbe(request, response)) return;
        void requestBody(request).then((body) => {
          bodies.push(body);
          writeEventStream(response);
        });
      }),
    );
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Test Provider",
      },
      "test-secret",
    );

    await collect(provider, "gpt-5.6-sol", false);
    await collect(provider, "another-model", true);
    const azureProvider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "azure-openai",
        apiVersion: "2026-08-01",
        baseUrl,
        name: "Test Azure Provider",
      },
      "test-secret",
    );
    await collect(azureProvider, "azure-deployment", false);

    const chatWire = JSON.stringify(bodies[0]);
    expect(bodies[0]).toMatchObject({
      tool_choice: "auto",
      tools: [{ type: "web_search" }],
    });
    expect(chatWire).not.toContain('"type":"namespace"');
    expect(chatWire).not.toContain('"type":"tool_search"');
    expect(chatWire).toContain('"prompt_cache_options"');
    const otherModelWire = JSON.stringify(bodies[1]);
    expect(otherModelWire).toContain('"type":"tool_search"');
    expect(otherModelWire).not.toContain('"prompt_cache_options"');
    expect(bodies[2]).toMatchObject({
      tool_choice: "auto",
      tools: [{ type: "web_search" }],
    });
  });
});

async function budgetFixture(
  options: {
    countStatus?: number;
    inputTokens?: number;
    maxInputTokens?: number;
    generationStatus?: number;
    disconnectCount?: boolean;
    countBody?: JsonValue;
    waitForCount?: () => Promise<void>;
  } = {},
) {
  const counts: JsonValue[] = [];
  const generations: JsonValue[] = [];
  const baseUrl = await listen(
    createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "gpt-6-astra",
                object: "model",
                owned_by: "test",
                max_input_tokens: options.maxInputTokens ?? 1_000_000,
                max_context_tokens: 1_050_000,
                max_output_tokens: 128_000,
              },
            ],
          }),
        );
        return;
      }
      void requestBody(request).then(async (body) => {
        if (request.url?.includes("/input_tokens")) {
          counts.push(body);
          await options.waitForCount?.();
          if (options.disconnectCount) {
            response.destroy();
            return;
          }
          const status = options.countStatus ?? 200;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              options.countBody ??
                (status === 200
                  ? {
                      object: "response.input_tokens",
                      input_tokens: options.inputTokens ?? 2_500,
                    }
                  : { error: { message: "count error" } }),
            ),
          );
        } else {
          generations.push(body);
          if (options.generationStatus) {
            response.writeHead(options.generationStatus, {
              "content-type": "application/json",
            });
            response.end(
              JSON.stringify({ error: { message: "generation failed" } }),
            );
          } else writeEventStream(response);
        }
      });
    }),
  );
  const profile = {
    apiStyle: "openai-compatible" as const,
    baseUrl,
    name: "Budget fixture",
  };
  const provider = new OpenAIResponsesModelProvider(profile, "test-secret");
  return { counts, generations, profile, provider };
}

function budgetTurn(
  provider: OpenAIResponsesModelProvider,
  overrides: Partial<ModelRequest> = {},
) {
  return collectModelTurn(
    provider.stream(
      {
        input: [{ content: "今天想聊一会儿。", role: "user", type: "message" }],
        instructions: "Be a helpful companion.",
        modelId: "gpt-6-astra",
        toolNamespaces: [],
        ...overrides,
      },
      new AbortController().signal,
    ),
  );
}

function exactRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    input: [
      {
        type: "message",
        role: "user",
        content: "Current document. ".repeat(3_000),
      },
    ],
    instructions: "Keep the complete document and all conditions.",
    modelId: "gpt-6-astra",
    toolNamespaces: [],
    ...overrides,
  };
}

describe("Responses preflight exact measurement", () => {
  it.each([400, 401, 503])(
    "does not reinterpret count failure %i as unsupported or return an estimate",
    async (countStatus) => {
      const f = await budgetFixture({ maxInputTokens: 30_000, countStatus });
      await expect(
        f.provider.measureInput(exactRequest(), new AbortController().signal),
      ).rejects.toBeInstanceOf(Error);
      await expect(
        f.provider.measureInput(exactRequest(), new AbortController().signal),
      ).rejects.toBeInstanceOf(Error);
      expect(f.counts).toHaveLength(2);
      expect(f.generations).toHaveLength(0);
    },
  );
  it("counts uncertain preflight once and reuses only the same complete wire in final", async () => {
    const f = await budgetFixture({
      maxInputTokens: 30_000,
      inputTokens: 6_000,
    });
    const request = exactRequest();
    const signal = new AbortController().signal;
    const measured = await f.provider.measureInput(request, signal);
    expect(measured.estimatedTokens).toBeGreaterThan(30_000);
    expect(measured.exactInputTokens).toBe(6_000);
    expect(f.counts).toHaveLength(1);
    await collectModelTurn(f.provider.stream(request, signal));
    expect(f.counts).toHaveLength(1);
    expect(f.generations).toHaveLength(1);
    for (const [key, value] of Object.entries(
      f.counts[0] as Record<string, JsonValue>,
    )) {
      expect((f.generations[0] as Record<string, JsonValue>)[key]).toEqual(
        value,
      );
    }
  });

  it("keeps small preflight local but still counts the final request", async () => {
    const f = await budgetFixture();
    const request = exactRequest({
      input: [{ type: "message", role: "user", content: "你好" }],
    });
    expect(
      (await f.provider.measureInput(request, new AbortController().signal))
        .exactInputTokens,
    ).toBeUndefined();
    expect(f.counts).toHaveLength(0);
    await collectModelTurn(
      f.provider.stream(request, new AbortController().signal),
    );
    expect(f.counts).toHaveLength(1);
    expect(f.generations).toHaveLength(1);
  });

  it("adjudicates a caller's conservative decision through the same counter and reuses it for final input", async () => {
    const f = await budgetFixture({ inputTokens: 100 });
    const request = exactRequest({
      input: [
        { type: "message", role: "user", content: "Short current request" },
      ],
    });
    const signal = new AbortController().signal;
    expect(
      (await f.provider.measureInput(request, signal)).exactInputTokens,
    ).toBeUndefined();
    expect(f.counts).toHaveLength(0);
    expect(
      (await f.provider.measureInput(request, signal, { requireExact: true }))
        .exactInputTokens,
    ).toBe(100);
    await collectModelTurn(f.provider.stream(request, signal));
    expect(f.counts).toHaveLength(1);
    expect(f.generations).toHaveLength(1);
  });

  it("returns an exact over-limit measurement for compaction and still prevents generation", async () => {
    const f = await budgetFixture({
      maxInputTokens: 4_000,
      inputTokens: 4_001,
    });
    const request = exactRequest();
    expect(
      (await f.provider.measureInput(request, new AbortController().signal))
        .exactInputTokens,
    ).toBe(4_001);
    await expect(
      collectModelTurn(
        f.provider.stream(request, new AbortController().signal),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
    expect(f.counts).toHaveLength(1);
    expect(f.generations).toHaveLength(0);
  });

  it("rechecks output reserve even when the exact input wire is unchanged", async () => {
    const f = await budgetFixture({
      maxInputTokens: 30_000,
      inputTokens: 6_000,
    });
    const request = exactRequest();
    await f.provider.measureInput(request, new AbortController().signal);
    await expect(
      collectModelTurn(
        f.provider.stream(
          { ...request, maxOutputTokens: 1_049_000 },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
    expect(f.counts).toHaveLength(1);
    expect(f.generations).toHaveLength(0);
  });

  it.each(["instructions", "input", "tools", "schema", "model"])(
    "recounts a changed %s and retains only one completed wire",
    async (field) => {
      const f = await budgetFixture({
        maxInputTokens: 30_000,
        inputTokens: 6_000,
      });
      const a = exactRequest();
      const b: ModelRequest =
        field === "instructions"
          ? { ...a, instructions: "Changed instruction" }
          : field === "input"
            ? {
                ...a,
                input: [
                  ...a.input,
                  { type: "message", role: "user", content: "New condition" },
                ],
              }
            : field === "schema"
              ? {
                  ...a,
                  structuredOutput: {
                    name: "answer",
                    schema: {
                      type: "object",
                      properties: { answer: { type: "string" } },
                    },
                  },
                }
              : field === "model"
                ? { ...a, modelId: "another-deployment" }
                : {
                    ...a,
                    toolNamespaces: [
                      {
                        name: "notes",
                        description: "Notes",
                        tools: [
                          {
                            name: "read",
                            namespace: "notes",
                            strict: false,
                            description: "Read notes",
                            inputSchema: { type: "object" },
                          },
                        ],
                      },
                    ],
                  };
      await collectModelTurn(
        f.provider.stream(a, new AbortController().signal),
      );
      await collectModelTurn(
        f.provider.stream(b, new AbortController().signal),
      );
      await collectModelTurn(
        f.provider.stream(a, new AbortController().signal),
      );
      expect(f.counts).toHaveLength(3);
    },
  );

  it("never shares a completed count across Provider instances", async () => {
    const f = await budgetFixture({ maxInputTokens: 30_000 });
    await f.provider.measureInput(exactRequest(), new AbortController().signal);
    await new OpenAIResponsesModelProvider(
      f.profile,
      "other-synthetic-key",
    ).measureInput(exactRequest(), new AbortController().signal);
    expect(f.counts).toHaveLength(2);
  });

  it("does not cache a cancelled count or let its late response authorize generation", async () => {
    let arrive!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await budgetFixture({
      maxInputTokens: 30_000,
      waitForCount: () => {
        arrive();
        return gate;
      },
    });
    const controller = new AbortController();
    const reason = new Error("Preparation cancelled");
    const pending = f.provider.measureInput(exactRequest(), controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    try {
      await arrived;
      controller.abort(reason);
      await rejected;
    } finally {
      release();
    }
    await f.provider.measureInput(exactRequest(), new AbortController().signal);
    expect(f.counts).toHaveLength(2);
    expect(f.generations).toHaveLength(0);
  });

  it("captures the body across count so caller mutation cannot alter generation", async () => {
    let arrive!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await budgetFixture({
      waitForCount: () => {
        arrive();
        return gate;
      },
    });
    const source = {
      type: "message",
      role: "user",
      content: "Original condition",
    };
    const request = exactRequest({ input: [source] });
    const pending = collectModelTurn(
      f.provider.stream(request, new AbortController().signal),
    );
    try {
      await arrived;
      source.content = "Later caller mutation";
    } finally {
      release();
    }
    await pending;
    expect((f.counts[0] as Record<string, JsonValue>)["input"]).toEqual(
      (f.generations[0] as Record<string, JsonValue>)["input"],
    );
    expect(JSON.stringify(f.generations[0])).toContain("Original condition");
    expect(JSON.stringify(f.generations[0])).not.toContain(
      "Later caller mutation",
    );
  });
});

describe("Responses submitted input guard", () => {
  it("keeps small text usable and caches unsupported counting only on that Provider instance", async () => {
    const fixture = await budgetFixture({ countStatus: 404 });
    await budgetTurn(fixture.provider);
    await budgetTurn(fixture.provider);
    expect(fixture.counts).toHaveLength(1);
    expect(fixture.generations).toHaveLength(2);
    await budgetTurn(
      new OpenAIResponsesModelProvider(fixture.profile, "test-secret"),
    );
    expect(fixture.counts).toHaveLength(2);
  });

  it("counts the same mapped input, instructions, schemas and tools that are submitted", async () => {
    const fixture = await budgetFixture();
    await budgetTurn(fixture.provider, {
      nativeWebSearch: true,
      instructions: "Full instructions including current memory.",
      input: [
        {
          type: "function_call",
          call_id: "call-1",
          namespace: "file",
          name: "file.read",
          arguments: "{}",
        },
      ],
      structuredOutput: { name: "answer", schema: { type: "object" } },
      toolNamespaces: [
        {
          name: "file",
          description: "Files",
          tools: [
            {
              namespace: "file",
              name: "file.read",
              description: "Read",
              strict: false,
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
              },
            },
          ],
        },
      ],
    });
    const count = fixture.counts[0] as Record<string, JsonValue>;
    const generation = fixture.generations[0] as Record<string, JsonValue>;
    for (const field of [
      "input",
      "instructions",
      "tools",
      "tool_choice",
      "text",
      "model",
      "parallel_tool_calls",
    ]) {
      expect(count[field]).toEqual(generation[field]);
    }
    expect(JSON.stringify(count)).toContain("charamate_file");
    expect(count).not.toHaveProperty("stream");
    expect(fixture.counts).toHaveLength(1);
    expect(fixture.generations).toHaveLength(1);
  });

  it.each([405, 501])(
    "handles explicit unsupported count status %i without disabling small text",
    async (countStatus) => {
      const fixture = await budgetFixture({ countStatus });
      await budgetTurn(fixture.provider);
      expect(fixture.counts).toHaveLength(1);
      expect(fixture.generations).toHaveLength(1);
    },
  );

  it.each([
    { object: "response.input_tokens", input_tokens: -1 },
    { object: "response.input_tokens", input_tokens: 1.5 },
    { object: "other", input_tokens: 2_500 },
  ])(
    "rejects malformed count results before generation: %j",
    async (countBody) => {
      const fixture = await budgetFixture({ countBody });
      await expect(budgetTurn(fixture.provider)).rejects.toMatchObject({
        code: "PROVIDER.REQUEST_FAILED",
      });
      expect(fixture.generations).toHaveLength(0);
    },
  );

  it.each([258_000, 258_001])(
    "applies the exact count at the user boundary: %i",
    async (inputTokens) => {
      const fixture = await budgetFixture({ inputTokens });
      if (inputTokens === 258_000) await budgetTurn(fixture.provider);
      else
        await expect(budgetTurn(fixture.provider)).rejects.toMatchObject({
          code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
          retryable: false,
        });
      expect(fixture.generations).toHaveLength(inputTokens === 258_000 ? 1 : 0);
    },
  );

  it("enforces a lower Provider limit and actual output reservation", async () => {
    const fixture = await budgetFixture({
      inputTokens: 4_001,
      maxInputTokens: 4_000,
    });
    await expect(budgetTurn(fixture.provider)).rejects.toMatchObject({
      code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
    });
    const outputLimited = await budgetFixture({ inputTokens: 1_001 });
    await expect(
      budgetTurn(outputLimited.provider, { maxOutputTokens: 1_049_000 }),
    ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
    expect(fixture.generations).toHaveLength(0);
    expect(outputLimited.generations).toHaveLength(0);
  });

  it.each(["instructions", "input", "tool", "output schema"])(
    "blocks oversized %s before generation when counting is unsupported",
    async (field) => {
      const fixture = await budgetFixture({ countStatus: 404 });
      const large = "汉".repeat(90_000);
      const overrides: Partial<ModelRequest> =
        field === "instructions"
          ? { instructions: large }
          : field === "input"
            ? { input: [{ role: "user", content: large }] }
            : field === "output schema"
              ? {
                  structuredOutput: {
                    name: "large",
                    schema: { description: large },
                  },
                }
              : {
                  toolNamespaces: [
                    { name: "file", description: large, tools: [] },
                  ],
                };
      await expect(
        budgetTurn(fixture.provider, overrides),
      ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
      expect(fixture.generations).toHaveLength(0);
    },
  );

  it("allows a bounded screenshot and visible reasoning, but requires real counts for opaque continuation and PDFs", async () => {
    const fixture = await budgetFixture({ countStatus: 404 });
    await budgetTurn(fixture.provider, {
      input: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "The visible plan." }],
        },
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAAA",
              detail: "auto",
            },
          ],
        },
      ],
    });
    for (const input of [
      { type: "reasoning", encrypted_content: "opaque", summary: [] },
      { type: "input_file", file_data: "compressed-pdf" },
    ]) {
      await expect(
        budgetTurn(fixture.provider, { input: [input] }),
      ).rejects.toMatchObject({ code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED" });
    }
    const counted = await budgetFixture();
    await budgetTurn(counted.provider, {
      input: [{ type: "reasoning", encrypted_content: "opaque", summary: [] }],
    });
    expect(fixture.generations).toHaveLength(1);
    expect(counted.generations).toHaveLength(1);
  });

  it.each([
    [400, "PROVIDER.REQUEST_FAILED"],
    [401, "PROVIDER.AUTHENTICATION_FAILED"],
    [403, "PROVIDER.PERMISSION_DENIED"],
    [429, "PROVIDER.RATE_LIMITED"],
    [500, "PROVIDER.UNAVAILABLE"],
    [503, "PROVIDER.UNAVAILABLE"],
  ] as const)(
    "does not swallow count status %i as unsupported",
    async (countStatus, code) => {
      const fixture = await budgetFixture({ countStatus });
      await expect(budgetTurn(fixture.provider)).rejects.toMatchObject({
        code,
      });
      expect(fixture.counts).toHaveLength(1);
      expect(fixture.generations).toHaveLength(0);
    },
  );

  it("keeps count connection failures distinct and does not retry a generation request", async () => {
    const disconnected = await budgetFixture({ disconnectCount: true });
    await expect(budgetTurn(disconnected.provider)).rejects.toMatchObject({
      code: "PROVIDER.UNREACHABLE",
    });
    expect(disconnected.generations).toHaveLength(0);
    const failure = await budgetFixture({ generationStatus: 500 });
    await expect(budgetTurn(failure.provider)).rejects.toMatchObject({
      code: "PROVIDER.UNAVAILABLE",
      retryable: true,
    });
    expect(failure.counts).toHaveLength(1);
    expect(failure.generations).toHaveLength(1);
  });
});

describe("actual model request identity on Provider failures", () => {
  it.each(["openai-compatible", "azure-openai"] as const)(
    "preserves the bound %s profile and actual request model through count and generation failures",
    async (apiStyle) => {
      for (const options of [
        { countStatus: 429, code: "PROVIDER.RATE_LIMITED", generations: 0 },
        { disconnectCount: true, code: "PROVIDER.UNREACHABLE", generations: 0 },
        {
          generationStatus: 429,
          code: "PROVIDER.RATE_LIMITED",
          generations: 1,
        },
        {
          generationStatus: 500,
          code: "PROVIDER.UNAVAILABLE",
          generations: 1,
        },
        {
          generationStatus: 503,
          code: "PROVIDER.UNAVAILABLE",
          generations: 1,
        },
      ]) {
        const f = await budgetFixture(options);
        const profileId = randomUUID();
        const profile: ProviderProfileDraft = {
          ...f.profile,
          apiStyle,
          id: profileId,
          chatModel: "different-default-model",
          ...(apiStyle === "azure-openai"
            ? { apiVersion: "2025-04-01-preview" }
            : {}),
        };
        const provider = new OpenAIResponsesModelProvider(
          profile,
          "fixture-secret",
        );
        profile.id = randomUUID();
        await expect(budgetTurn(provider)).rejects.toMatchObject({
          code: options.code,
          requestIdentity: { profileId, apiStyle, modelId: "gpt-6-astra" },
        });
        expect(f.counts).toHaveLength(1);
        expect(f.generations).toHaveLength(options.generations);
      }
    },
  );

  it.each(["list", "detail"] as const)(
    "records the requested model for the actual %s metadata failure",
    async (failureStage) => {
      const paths: string[] = [];
      const baseUrl = await listen(
        createServer((request, response) => {
          paths.push(request.url!);
          if (failureStage === "detail" && request.url === "/v1/models") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ object: "list", data: [] }));
            return;
          }
          response.writeHead(429, {
            "content-type": "application/json",
            "x-should-retry": "false",
          });
          response.end(
            JSON.stringify({ error: { message: "fixture temporary failure" } }),
          );
        }),
      );
      const profileId = randomUUID();
      const provider = new OpenAIResponsesModelProvider(
        {
          apiStyle: "openai-compatible",
          id: profileId,
          baseUrl,
          name: "Metadata identity",
          chatModel: "unused-default",
        },
        "fixture-secret",
      );
      await expect(
        provider.resolveContextLimits("gpt-6-astra"),
      ).rejects.toMatchObject({
        code: "PROVIDER.RATE_LIMITED",
        requestIdentity: {
          profileId,
          apiStyle: "openai-compatible",
          modelId: "gpt-6-astra",
        },
      });
      expect(paths).toEqual(
        failureStage === "list"
          ? ["/v1/models"]
          : ["/v1/models", "/v1/models/gpt-6-astra"],
      );
    },
  );

  it("leaves an unsaved draft unbound rather than inventing a profile identity", async () => {
    const f = await budgetFixture({ countStatus: 429 });
    const error: unknown = await budgetTurn(f.provider).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({
      code: "PROVIDER.RATE_LIMITED",
    });
    expect(
      (error as { requestIdentity?: unknown }).requestIdentity,
    ).toBeUndefined();
  });

  it("preserves an actual cancellation instead of classifying it as an availability failure", async () => {
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const baseUrl = await listen(
      createServer((_request, response) => {
        response.on("close", () => response.destroy());
        entered();
      }),
    );
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        id: randomUUID(),
        baseUrl,
        name: "Cancelled metadata",
      },
      "fixture-secret",
    );
    const controller = new AbortController();
    const reason = new Error("Foreground interrupted this actual request");
    const result = provider.resolveContextLimits(
      "gpt-6-astra",
      controller.signal,
    );
    const rejected = expect(result).rejects.toBe(reason);
    await requested;
    controller.abort(reason);
    await rejected;
    expect(reason).not.toHaveProperty("requestIdentity");
    expect(reason).not.toHaveProperty("code");
  });
});

it("replays original assistant phases with interleaved item deltas and one global citation numbering", async () => {
  const source = (
    id: string,
    text: string,
    url: string,
    phase?: "commentary" | "final_answer" | null,
  ): JsonValue => ({
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    ...(phase === undefined ? {} : { phase }),
    content: [
      {
        type: "output_text",
        text,
        annotations: [
          {
            type: "url_citation",
            start_index: 0,
            end_index: text.length,
            url,
            title: id,
          },
        ],
      },
    ],
  });
  const messages = [
    source("progress", "正在核对。", "https://example.com/a", "commentary"),
    source("answer", "核对结果。", "https://example.com/b", "final_answer"),
    source("null-phase", "附注。", "https://example.com/a", null),
    source("unknown-phase", "来源。", "https://example.com/b"),
    {
      id: "refusal",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "refusal", refusal: "不能提供这一项。" }],
    },
  ];
  const bodies: JsonValue[] = [];
  const server = createServer((request, response) => {
    if (handleUnsupportedBudgetProbe(request, response)) return;
    void requestBody(request).then((body) => {
      bodies.push(body);
      writeEventStream(response, [
        {
          type: "response.output_text.delta",
          delta: "核对",
          item_id: "answer",
          output_index: 1,
          content_index: 0,
          sequence_number: 1,
        },
        {
          type: "response.output_text.delta",
          delta: "正在核对。",
          item_id: "progress",
          output_index: 0,
          content_index: 0,
          sequence_number: 2,
        },
        {
          type: "response.output_text.delta",
          delta: "结果。",
          item_id: "answer",
          output_index: 1,
          content_index: 0,
          sequence_number: 3,
        },
        {
          type: "response.output_item.done",
          item: messages[1]!,
          output_index: 1,
          sequence_number: 4,
        },
        {
          type: "response.output_item.done",
          item: messages[0]!,
          output_index: 0,
          sequence_number: 5,
        },
        {
          type: "response.completed",
          response: {
            id: "phase-response",
            output: messages,
            usage: { input_tokens: 12, output_tokens: 8 },
          },
        },
      ]);
    });
  });
  const provider = new OpenAIResponsesModelProvider(
    {
      apiStyle: "openai-compatible",
      baseUrl: await listen(server),
      name: "Phase SDK loopback",
    },
    "test-secret",
  );
  const request: ModelRequest = {
    input: [],
    instructions: "Replay",
    modelId: "gpt-6-astra",
    toolNamespaces: [],
  };
  const observed: ModelEvent[] = [];
  async function* recording() {
    for await (const event of provider.stream(
      request,
      new AbortController().signal,
    )) {
      observed.push(event);
      yield event;
    }
  }
  const turn = await collectModelTurn(recording());
  expect(observed[0]).toMatchObject({
    type: "text.delta",
    itemId: "answer",
    outputIndex: 1,
    contentIndex: 0,
  });
  expect(turn.text).toBe("正在核对。核对结果。附注。来源。不能提供这一项。");
  expect(turn.assistantMessages).toEqual(messages);
  expect(turn.displayText).toBe(
    '正在核对。[1](<https://example.com/a> "progress")核对结果。[2](<https://example.com/b> "answer")附注。[1](<https://example.com/a> "null-phase")来源。[2](<https://example.com/b> "unknown-phase")不能提供这一项。',
  );
  await collectModelTurn(
    provider.stream(
      { ...request, input: turn.assistantMessages! },
      new AbortController().signal,
    ),
  );
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toHaveProperty("input", messages);
});

it.each(["absent", "older"] as const)(
  "uses completed Tool arguments from the same normalized output when item.done is %s",
  async (done) => {
    const finalItem: JsonValue = {
      id: "final-tool",
      type: "function_call",
      namespace: "charamate_browser",
      name: "navigate",
      call_id: "same-call",
      arguments: JSON.stringify({
        toolName: "charamate_file.read",
        choice: "canonical",
      }),
    };
    const server = createServer((request, response) => {
      if (handleUnsupportedBudgetProbe(request, response)) return;
      writeEventStream(response, [
        ...(done === "older"
          ? [
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "function_call",
                  namespace: "charamate_browser",
                  name: "navigate",
                  call_id: "same-call",
                  arguments: JSON.stringify({
                    toolName: "charamate_computer.snapshot",
                    choice: "older",
                  }),
                },
              },
            ]
          : []),
        {
          type: "response.completed",
          response: {
            id: "canonical-complete",
            output: [finalItem],
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        },
      ]);
    });
    const provider = new OpenAIResponsesModelProvider(
      {
        apiStyle: "openai-compatible",
        baseUrl: await listen(server),
        name: "Canonical SDK loopback",
      },
      "test-secret",
    );
    const turn = await collectModelTurn(
      (async function* () {
        const observed = await collect(provider, "gpt-6-astra", true);
        yield* observed;
      })(),
    );
    expect(turn.functionCalls).toHaveLength(1);
    expect(turn.functionCalls[0]?.arguments).toEqual({
      toolName: "file.read",
      choice: "canonical",
    });
    expect(turn.functionCalls[0]?.rawItem).toMatchObject({
      namespace: "browser",
      arguments: JSON.stringify({
        toolName: "charamate_file.read",
        choice: "canonical",
      }),
    });
    expect(turn.outputItems).toEqual([turn.functionCalls[0]!.rawItem]);
    expect(turn.assistantMessages).toBeUndefined();
    expect(turn.text).toBe("");
  },
);
