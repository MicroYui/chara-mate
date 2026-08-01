import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { OpenAISdkProviderAdapter } from "../../src/main/providers/openaiProviderAdapter";

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
  return `http://127.0.0.1:${String(address.port)}`;
}

function modelListBody() {
  return JSON.stringify({
    data: [
      { created: 2, id: "model-z", object: "model", owned_by: "vendor" },
      { created: 1, id: "model-a", object: "model", owned_by: "vendor" },
    ],
    object: "list",
  });
}

describe("official OpenAI SDK Provider adapter", () => {
  it("discovers and normalizes OpenAI-compatible models with Bearer auth", async () => {
    let observedAuthorization = "";
    const baseUrl = await listen(
      createServer((request, response) => {
        observedAuthorization = request.headers.authorization ?? "";
        expect(request.url).toBe("/v1/models");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(modelListBody());
      }),
    );
    const adapter = new OpenAISdkProviderAdapter(
      {
        apiStyle: "openai-compatible",
        baseUrl: `${baseUrl}/v1`,
        name: "Local compatible",
      },
      "sk-compatible-secret",
    );

    await expect(adapter.listModels()).resolves.toEqual([
      { createdAtUnixSeconds: 1, id: "model-a", ownedBy: "vendor" },
      { createdAtUnixSeconds: 2, id: "model-z", ownedBy: "vendor" },
    ]);
    expect(observedAuthorization).toBe("Bearer sk-compatible-secret");
  });

  it("uses Azure api-key auth and the configured API Version", async () => {
    let observedApiKey = "";
    const endpoint = await listen(
      createServer((request, response) => {
        observedApiKey = String(request.headers["api-key"] ?? "");
        expect(request.url).toBe(
          "/openai/models?api-version=2025-04-01-preview",
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(modelListBody());
      }),
    );
    const adapter = new OpenAISdkProviderAdapter(
      {
        apiStyle: "azure-openai",
        apiVersion: "2025-04-01-preview",
        baseUrl: endpoint,
        name: "Azure",
      },
      "azure-secret",
    );

    await expect(adapter.listModels()).resolves.toHaveLength(2);
    expect(observedApiKey).toBe("azure-secret");
  });

  it("maps remote failures to stable errors without echoing credentials", async () => {
    const secret = "sk-never-return-this";
    const baseUrl = await listen(
      createServer((_request, response) => {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: `Rejected ${secret}` } }),
        );
      }),
    );
    const adapter = new OpenAISdkProviderAdapter(
      {
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Rejected",
      },
      secret,
    );

    await expect(adapter.listModels()).rejects.toMatchObject({
      code: "PROVIDER.AUTHENTICATION_FAILED",
      message: "Provider 拒绝了 API Key。",
      retryable: false,
    });
    try {
      await adapter.listModels();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("recognizes a missing standard model-list endpoint as manual fallback", async () => {
    const baseUrl = await listen(
      createServer((_request, response) => {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
      }),
    );
    const adapter = new OpenAISdkProviderAdapter(
      {
        apiStyle: "openai-compatible",
        baseUrl,
        name: "Manual",
      },
      "secret",
    );

    await expect(adapter.listModels()).rejects.toMatchObject({
      code: "PROVIDER.MODEL_DISCOVERY_UNAVAILABLE",
    });
  });
});
