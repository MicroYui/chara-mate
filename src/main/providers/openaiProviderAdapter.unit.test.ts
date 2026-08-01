import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

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

describe("OpenAI Provider adapter capability checks", () => {
  it("opens an authenticated Realtime WebSocket and closes without sending content", async () => {
    let requestedUrl = "";
    let authorization = "";
    const server = createServer();
    server.on("upgrade", (request, socket) => {
      requestedUrl = request.url ?? "";
      authorization = request.headers.authorization ?? "";
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
          imageEditEndpoint: `${listener.baseUrl}/v1/images/edits`,
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
