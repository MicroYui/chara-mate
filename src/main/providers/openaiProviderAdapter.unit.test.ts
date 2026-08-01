import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import type { ProviderProfileDraft } from "../../shared/contracts/provider";
import { OpenAISdkProviderAdapter } from "./openaiProviderAdapter";

const apiKey = "provider-adapter-secret";

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type OpenAICompatibleDraft = Extract<
  ProviderProfileDraft,
  { apiStyle: "openai-compatible" }
>;

function profile(
  overrides: Partial<Omit<OpenAICompatibleDraft, "apiStyle">>,
): OpenAICompatibleDraft {
  return {
    apiStyle: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    name: "Example",
    ...overrides,
  };
}

type AzureDraft = Extract<ProviderProfileDraft, { apiStyle: "azure-openai" }>;

function azureProfile(
  overrides: Partial<Omit<AzureDraft, "apiStyle">>,
): AzureDraft {
  return {
    apiStyle: "azure-openai",
    baseUrl: "https://example.openai.azure.com",
    name: "Azure",
    ...overrides,
  };
}

function acceptWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
): void {
  const key = request.headers["sec-websocket-key"];
  const accept = createHash("sha1")
    .update(`${String(key)}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
}

describe("OpenAI Provider adapter capability checks", () => {
  it("opens an authenticated Realtime WebSocket and closes without sending content", async () => {
    let requestedUrl = "";
    let authorization = "";
    const server = createServer();
    server.on("upgrade", (request, socket) => {
      requestedUrl = request.url ?? "";
      authorization = request.headers.authorization ?? "";
      acceptWebSocketUpgrade(request, socket);
    });
    const listener = await listen(server);

    try {
      const adapter = new OpenAISdkProviderAdapter(
        profile({
          realtimeEndpoint: `${listener.baseUrl}/v1/realtime`,
          realtimeModel: "realtime-model",
        }),
        apiKey,
      );

      await expect(adapter.testRealtimeConnection()).resolves.toBeUndefined();
      expect(requestedUrl).toBe("/v1/realtime?model=realtime-model");
      expect(authorization).toBe(`Bearer ${apiKey}`);
    } finally {
      await listener.close();
    }
  });

  it("uses the Azure GA model query and api-key header without legacy parameters", async () => {
    let requestedUrl = "";
    let azureApiKey = "";
    let authorization = "";
    const server = createServer();
    server.on("upgrade", (request, socket) => {
      requestedUrl = request.url ?? "";
      azureApiKey = String(request.headers["api-key"] ?? "");
      authorization = request.headers.authorization ?? "";
      acceptWebSocketUpgrade(request, socket);
    });
    const listener = await listen(server);

    try {
      const adapter = new OpenAISdkProviderAdapter(
        azureProfile({
          realtimeEndpoint: `${listener.baseUrl}/openai/v1/realtime?model=gpt-realtime-2.1&api-version=legacy&deployment=legacy`,
          realtimeModel: "gpt-realtime-2.1-2",
        }),
        apiKey,
      );

      await expect(adapter.testRealtimeConnection()).resolves.toBeUndefined();
      expect(requestedUrl).toBe("/openai/v1/realtime?model=gpt-realtime-2.1-2");
      expect(azureApiKey).toBe(apiKey);
      expect(authorization).toBe("");
    } finally {
      await listener.close();
    }
  });

  it("rejects an Azure resource configured as OpenAI-compatible before networking", async () => {
    const adapter = new OpenAISdkProviderAdapter(
      profile({
        realtimeEndpoint:
          "https://datasetannotator-openai.openai.azure.com/openai/v1/realtime",
        realtimeModel: "gpt-realtime-2.1",
      }),
      apiKey,
    );

    await expect(adapter.testRealtimeConnection()).rejects.toMatchObject({
      code: "PROVIDER.INVALID_CONFIGURATION",
      message:
        "该 Realtime Endpoint 属于 Azure OpenAI；请把 API 类型改为 Azure OpenAI 后再测试。",
    });
  });

  it("does not follow or expose a Realtime redirect", async () => {
    let upgradeRequests = 0;
    const server = createServer();
    server.on("upgrade", (_request, socket) => {
      upgradeRequests += 1;
      socket.end(
        [
          "HTTP/1.1 302 Found",
          "Connection: close",
          "Content-Length: 0",
          "Location: wss://example.invalid/realtime?api-key=must-not-return",
          "",
          "",
        ].join("\r\n"),
      );
    });
    const listener = await listen(server);

    try {
      const adapter = new OpenAISdkProviderAdapter(
        profile({
          realtimeEndpoint: `${listener.baseUrl}/v1/realtime`,
          realtimeModel: "realtime-model",
        }),
        apiKey,
      );

      await expect(adapter.testRealtimeConnection()).rejects.toMatchObject({
        code: "PROVIDER.INVALID_CONFIGURATION",
        message:
          "Realtime Endpoint 返回了重定向；请填写最终 Endpoint。Azure 资源还必须选择 Azure OpenAI API 类型。",
      });
      expect(upgradeRequests).toBe(1);
    } finally {
      await listener.close();
    }
  });

  it("returns actionable Azure GA guidance for a missing route or deployment", async () => {
    const server = createServer();
    server.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    });
    const listener = await listen(server);

    try {
      const adapter = new OpenAISdkProviderAdapter(
        azureProfile({
          realtimeEndpoint: `${listener.baseUrl}/openai/v1/realtime`,
          realtimeModel: "missing-deployment",
        }),
        apiKey,
      );

      await expect(adapter.testRealtimeConnection()).rejects.toMatchObject({
        code: "PROVIDER.INVALID_CONFIGURATION",
        message:
          "Azure Realtime 路由或 deployment 不存在；Endpoint 应以 /openai/v1/realtime 结尾，Model 请填写 deployment 名称。",
      });
    } finally {
      await listener.close();
    }
  });

  it("validates Image credentials and model without calling the edit endpoint", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (
        request.url === "/v1/models/image-model" &&
        request.headers.authorization === `Bearer ${apiKey}`
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            created: 1,
            id: "image-model",
            object: "model",
            owned_by: "example",
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    const listener = await listen(server);

    try {
      const adapter = new OpenAISdkProviderAdapter(
        profile({
          imageGenerationEndpoint: `${listener.baseUrl}/v1/images/generations`,
          imageModel: "image-model",
        }),
        apiKey,
      );

      await expect(adapter.verifyImageConfiguration()).resolves.toBeUndefined();
      expect(requests).toEqual(["GET /v1/models/image-model"]);
    } finally {
      await listener.close();
    }
  });

  it("uses the Image endpoint API Version for Azure model verification", async () => {
    const requests: string[] = [];
    let azureApiKey = "";
    const server = createServer((request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      azureApiKey = String(request.headers["api-key"] ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          created: 1,
          id: "gpt-image-2",
          object: "model",
          owned_by: "azure",
        }),
      );
    });
    const listener = await listen(server);

    try {
      const adapter = new OpenAISdkProviderAdapter(
        azureProfile({
          apiVersion: "profile-version-must-not-win",
          baseUrl: listener.baseUrl,
          imageGenerationEndpoint: `${listener.baseUrl}/openai/deployments/gpt-image-2/images/generations?api-version=2025-04-01-preview`,
          imageModel: "gpt-image-2",
        }),
        apiKey,
      );

      await expect(adapter.verifyImageConfiguration()).resolves.toBeUndefined();
      expect(requests).toEqual([
        "GET /openai/models/gpt-image-2?api-version=2025-04-01-preview",
      ]);
      expect(azureApiKey).toBe(apiKey);
    } finally {
      await listener.close();
    }
  });

  it("uses the Profile API Version when the Azure generation endpoint omits its query", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          created: 1,
          id: "gpt-image-2",
          object: "model",
          owned_by: "azure",
        }),
      );
    });
    const listener = await listen(server);

    try {
      const adapter = new OpenAISdkProviderAdapter(
        azureProfile({
          apiVersion: "2025-04-01-preview",
          baseUrl: listener.baseUrl,
          imageGenerationEndpoint: `${listener.baseUrl}/openai/deployments/gpt-image-2/images/generations`,
          imageModel: "gpt-image-2",
        }),
        apiKey,
      );

      await expect(adapter.verifyImageConfiguration()).resolves.toBeUndefined();
      expect(requests).toEqual([
        "GET /openai/models/gpt-image-2?api-version=2025-04-01-preview",
      ]);
    } finally {
      await listener.close();
    }
  });

  it("requires an API Version only when an Azure HTTP capability is tested", async () => {
    const adapter = new OpenAISdkProviderAdapter(azureProfile({}), apiKey);

    await expect(adapter.listModels()).rejects.toMatchObject({
      code: "PROVIDER.INVALID_CONFIGURATION",
      message: "该 Azure HTTP 能力需要 API Version；Realtime GA 不需要。",
    });
  });

  it("rejects an Image Edit endpoint because the configured capability is generation", async () => {
    const adapter = new OpenAISdkProviderAdapter(
      profile({
        imageGenerationEndpoint: "https://api.example.com/v1/images/edits",
        imageModel: "gpt-image-2",
      }),
      apiKey,
    );

    await expect(adapter.verifyImageConfiguration()).rejects.toMatchObject({
      code: "PROVIDER.INVALID_CONFIGURATION",
      message: "Image Generation Endpoint 应以 /images/generations 结尾。",
    });
  });

  it("rejects incomplete capability configuration before networking", async () => {
    const adapter = new OpenAISdkProviderAdapter(profile({}), apiKey);

    await expect(adapter.testRealtimeConnection()).rejects.toMatchObject({
      code: "PROVIDER.INVALID_CONFIGURATION",
    });
    await expect(adapter.verifyImageConfiguration()).rejects.toMatchObject({
      code: "PROVIDER.INVALID_CONFIGURATION",
    });
  });
});
