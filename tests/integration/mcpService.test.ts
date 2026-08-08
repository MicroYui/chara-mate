import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import { McpRepository } from "../../src/main/extensions/mcpRepository";
import { McpService } from "../../src/main/extensions/mcpService";
import type { ProviderSecretStore } from "../../src/main/providers/secretStore";
import { ArtifactStore } from "../../src/main/tools/artifactStore";
import { ToolRegistry } from "../../src/main/tools/toolRegistry";
import type { JsonValue } from "../../src/shared/contracts/primitives";
import { SystemClock } from "../../src/shared/pure/clock";
import { CryptoIdGenerator } from "../../src/shared/pure/id";

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const ITEM_ID = "10000000-0000-4000-8000-000000000002";
const services: McpService[] = [];
const servers: Server[] = [];
const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

class MemorySecretStore implements ProviderSecretStore {
  readonly values = new Map<string, string>();
  readonly #ids = new CryptoIdGenerator();

  delete(secretRef: string): Promise<void> {
    this.values.delete(secretRef);
    return Promise.resolve();
  }

  get(secretRef: string): Promise<string> {
    const value = this.values.get(secretRef);
    if (value === undefined) throw new Error("Secret does not exist");
    return Promise.resolve(value);
  }

  prune(allowedReferences: ReadonlySet<string>): Promise<void> {
    for (const reference of this.values.keys()) {
      if (!allowedReferences.has(reference)) this.values.delete(reference);
    }
    return Promise.resolve();
  }

  store(plainText: string): Promise<string> {
    const reference = this.#ids.generate();
    this.values.set(reference, plainText);
    return Promise.resolve(reference);
  }
}

afterEach(async () => {
  await Promise.allSettled(
    services.splice(0).map((service) => service.close()),
  );
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    ),
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-mcp-service-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function createService(root: string): {
  readonly databasePath: string;
  readonly registry: ToolRegistry;
  readonly secrets: MemorySecretStore;
  readonly service: McpService;
} {
  const databasePath = path.join(root, "app.sqlite");
  const database = openApplicationDatabase(databasePath);
  databases.push(database);
  const registry = new ToolRegistry();
  const secrets = new MemorySecretStore();
  const service = new McpService(
    new McpRepository(database),
    secrets,
    registry,
    new ArtifactStore(path.join(root, "artifacts"), new CryptoIdGenerator()),
    new CryptoIdGenerator(),
    new SystemClock(),
  );
  services.push(service);
  return { databasePath, registry, secrets, service };
}

function execute(
  registry: ToolRegistry,
  name: string,
  input: Readonly<Record<string, JsonValue>>,
  signal = new AbortController().signal,
) {
  return registry.execute(name, input, {
    itemId: ITEM_ID,
    onDelta: () => undefined,
    runId: RUN_ID,
    signal,
  });
}

async function requestBuffer(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function webRequest(request: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : (await requestBuffer(request)).toString("utf8");
  return new Request(
    new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    ),
    { ...(body === undefined ? {} : { body }), headers, method },
  );
}

async function listenMcpHttp(
  onAuthorization: (value: string) => void,
): Promise<string> {
  const inputSchema = fromJsonSchema<{ text: string }>({
    additionalProperties: false,
    properties: { text: { type: "string" } },
    required: ["text"],
    type: "object",
  });
  const handler = createMcpHandler(() => {
    const server = new McpServer({
      name: "CharaMate HTTP fixture",
      version: "1.0.0",
    });
    server.registerTool(
      "echo",
      {
        annotations: { idempotentHint: true, readOnlyHint: true },
        description: "Echo text over Streamable HTTP",
        inputSchema,
      },
      ({ text }) => ({ content: [{ text: `http:${text}`, type: "text" }] }),
    );
    return server;
  });
  const server = createServer((request, response) => {
    onAuthorization(request.headers.authorization ?? "");
    void (async () => {
      const webResponse = await handler.fetch(await webRequest(request));
      response.statusCode = webResponse.status;
      for (const [name, value] of webResponse.headers) {
        response.setHeader(name, value);
      }
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "MCP HTTP error");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}/mcp`;
}

describe("official MCP client boundary", () => {
  it("registers configuration tools with namespace-qualified internal names", async () => {
    const root = await temporaryDirectory();
    const { registry, service } = createService(root);

    service.registerConfigurationTools();

    expect(
      registry.list().map(({ descriptor }) => ({
        name: descriptor.name,
        namespace: descriptor.namespace,
      })),
    ).toEqual([
      { name: "mcp_config.server_delete", namespace: "mcp_config" },
      { name: "mcp_config.server_list", namespace: "mcp_config" },
      { name: "mcp_config.server_refresh", namespace: "mcp_config" },
      { name: "mcp_config.server_save", namespace: "mcp_config" },
    ]);

    await service.save({
      enabled: false,
      name: "Configured Fixture",
      transport: {
        args: [],
        command: process.execPath,
        environment: [],
        type: "stdio",
      },
    });
    const listed = await execute(registry, "mcp_config.server_list", {});
    expect(listed).toMatchObject({
      modelContent: [
        {
          enabled: false,
          name: "Configured Fixture",
          status: "disabled",
          toolNames: [],
        },
      ],
      status: "success",
    });
    expect(registry.search("mcpServers")[0]?.descriptor.name).toBe(
      "mcp_config.server_list",
    );
  });

  it("connects over stdio, redacts output, artifacts large results, cancels, and rediscovers", async () => {
    const root = await temporaryDirectory();
    const { databasePath, registry, secrets, service } = createService(root);
    const fixturePath = path.resolve("tests/fixtures/mcp-server.mjs");
    const secret = "mcp-secret-must-not-persist";
    const saved = await service.save({
      enabled: true,
      name: "Fixture",
      transport: {
        args: [fixturePath, "full"],
        command: process.execPath,
        cwd: process.cwd(),
        environment: [{ name: "MCP_TEST_SECRET", value: secret }],
        type: "stdio",
      },
    });

    expect(saved.status).toBe("connected");
    expect(saved.toolNames).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__large",
      "mcp__fixture__slow",
    ]);
    const echo = await execute(registry, "mcp__fixture__echo", {
      text: "hello",
    });
    expect(JSON.stringify(echo.modelContent)).toContain("hello [REDACTED]");
    expect(JSON.stringify(echo)).not.toContain(secret);
    expect((await readFile(databasePath)).includes(Buffer.from(secret))).toBe(
      false,
    );

    const large = await execute(registry, "mcp__fixture__large", {});
    expect(large.status).toBe("success");
    expect(large.artifacts).toHaveLength(1);
    expect(JSON.stringify(large.modelContent)).toContain("完整输出已保存");

    const controller = new AbortController();
    const slow = execute(registry, "mcp__fixture__slow", {}, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(slow).rejects.toThrow("cancelled");

    const refreshed = await service.save({
      enabled: true,
      id: saved.id,
      name: "Fixture",
      transport: {
        args: [fixturePath, "minimal"],
        command: process.execPath,
        cwd: process.cwd(),
        environment: [{ name: "MCP_TEST_SECRET" }],
        type: "stdio",
      },
    });
    expect(refreshed.status).toBe("connected");
    expect(refreshed.toolNames).toEqual(["mcp__fixture__echo"]);
    expect(registry.get("mcp__fixture__large")).toBeUndefined();

    await service.delete(saved.id);
    expect(registry.get("mcp__fixture__echo")).toBeUndefined();
    expect(secrets.values.size).toBe(0);
  });

  it("connects and calls a Tool over Streamable HTTP with hydrated headers", async () => {
    let authorization = "";
    const url = await listenMcpHttp((value) => {
      authorization = value;
    });
    const root = await temporaryDirectory();
    const { registry, service } = createService(root);
    const saved = await service.save({
      enabled: true,
      name: "HTTP Fixture",
      transport: {
        headers: [{ name: "Authorization", value: "Bearer http-secret" }],
        type: "streamable_http",
        url,
      },
    });

    expect(saved.status).toBe("connected");
    expect(authorization).toBe("Bearer http-secret");
    expect(saved.toolNames).toEqual(["mcp__http_fixture__echo"]);
    const result = await execute(registry, "mcp__http_fixture__echo", {
      text: "hello",
    });
    expect(result.status).toBe("success");
    expect(JSON.stringify(result.modelContent)).toContain("http:hello");
  });
});
