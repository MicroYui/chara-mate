import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelEvent } from "../../src/main/agent/modelProvider";
import { OpenAIResponsesModelProvider } from "../../src/main/providers/openaiModelProvider";
import type { JsonValue } from "../../src/shared/contracts/primitives";

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

function responseEvents(): readonly JsonValue[] {
  return [
    { delta: "完成", type: "response.output_text.delta" },
    {
      item: {
        arguments: '{"url":"https://example.com"}',
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

function writeEventStream(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of responseEvents()) {
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
              ],
              type: "tool_search_output",
            },
          ]
        : [{ content: "test", role: "user", type: "message" }],
      instructions: "test",
      modelId,
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
            allowedTools: [{ name: "browser.navigate", namespace: "browser" }],
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
  it("preserves image content and omits Tool Search for an always-loaded core namespace", async () => {
    const bodies: JsonValue[] = [];
    const baseUrl = await listen(
      createServer((request, response) => {
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
          name: "interaction",
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

  it("uses the accepted native Tool Search, allowed_tools and selected implicit cache shape", async () => {
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
          arguments: '{"url":"https://example.com"}',
          call_id: "call-1",
          name: "navigate",
          namespace: "browser",
          type: "function_call",
        },
        type: "output.item",
      },
      {
        responseId: "response-1",
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
    expect(wire).toContain('"type":"allowed_tools"');
    expect(wire).toContain('"mode":"auto"');
    expect(bodies[0]).toMatchObject({
      tool_choice: {
        tools: [
          {
            name: "navigate",
            namespace: "charamate_browser",
            type: "function",
          },
        ],
      },
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
          name: "plan",
          tools: [{ defer_loading: false, name: "update", type: "function" }],
          type: "namespace",
        },
        {
          name: "territory",
          tools: [{ name: "generate_item", type: "function" }],
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
          ],
          type: "tool_search_output",
        },
      ],
    });
    expect(wire).not.toContain('"name":"browser.navigate"');
    expect(wire).not.toContain('"name":"computer.snapshot"');
    expect(wire).not.toContain('"name":"territory.generate_item"');
    expect(wire).toContain(
      '"prompt_cache_options":{"mode":"implicit","ttl":"30m"}',
    );
    expect(wire).not.toContain("prompt_cache_key");
    expect(wire).not.toContain("prompt_cache_breakpoint");
    expect(wire).toContain('"parallel_tool_calls":false');
    expect(wire).toContain('"store":false');
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
    const azureChatWire = JSON.stringify(bodies[2]);
    expect(azureChatWire).not.toContain('"tools"');
    expect(azureChatWire).not.toContain('"tool_choice"');
  });
});
