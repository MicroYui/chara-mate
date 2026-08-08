import { createHash } from "node:crypto";

import {
  Client,
  SdkError,
  StreamableHTTPClientTransport,
  type Tool as McpTool,
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";

import type {
  McpServer,
  McpServerDraft,
  McpTransportDraft,
} from "../../shared/contracts/extensions";
import type { JsonValue } from "../../shared/contracts/primitives";
import type { AppError, ArtifactReference } from "../../shared/contracts/run";
import type { ToolEffect, ToolResult } from "../../shared/contracts/tool";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import {
  redactKnownBoundaryValue,
  redactKnownText,
} from "../../shared/pure/redaction";
import {
  McpIdRequestSchema,
  McpServerDraftSchema,
} from "../../shared/schemas/extensions";
import { parseSchema } from "../../shared/schemas/validation";
import type { ProviderSecretStore } from "../providers/secretStore";
import type { ArtifactStore } from "../tools/artifactStore";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import { ExtensionError } from "./extensionError";
import type {
  McpRepository,
  McpServerRecord,
  PersistedMcpTransport,
  PersistedSecretField,
} from "./mcpRepository";
import { transportSecretReferences } from "./mcpRepository";

interface ConnectedServer {
  readonly client: Client;
  readonly namespace: string;
  readonly toolNames: readonly string[];
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function objectValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  return normalized || fallback;
}

function serverNameKey(value: string): string {
  return safeSegment(value, "") || value.normalize("NFKC").trim().toLowerCase();
}

function serverNamespace(record: Pick<McpServerRecord, "id" | "name">): string {
  return `mcp_${safeSegment(record.name, record.id.replaceAll("-", "").slice(0, 12))}`;
}

function registeredToolName(record: McpServerRecord, toolName: string): string {
  const fallback = createHash("sha256")
    .update(toolName)
    .digest("hex")
    .slice(0, 12);
  return `mcp__${safeSegment(record.name, record.id.slice(0, 8))}__${safeSegment(toolName, fallback)}`;
}

function toolEffect(tool: McpTool): ToolEffect {
  if (tool.annotations?.readOnlyHint) return "read";
  if (tool.annotations?.destructiveHint) return "critical";
  return "write";
}

async function artifactContent(
  artifacts: ArtifactStore,
  runId: string,
  serverName: string,
  content: readonly unknown[],
  sensitiveValues: readonly string[],
): Promise<{
  artifacts: ArtifactReference[];
  modelContent: JsonValue;
}> {
  const references: ArtifactReference[] = [];
  const presented: JsonValue[] = [];
  for (const [index, block] of content.entries()) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block.type === "image" || block.type === "audio") &&
      "data" in block &&
      typeof block.data === "string"
    ) {
      const mediaType =
        "mimeType" in block && typeof block.mimeType === "string"
          ? block.mimeType
          : block.type === "image"
            ? "image/png"
            : "audio/mpeg";
      const extension = mediaType.split("/")[1]?.split("+")[0] ?? "bin";
      const reference = await artifacts.storeBuffer(
        runId,
        `${serverName}-${String(index + 1)}.${extension}`,
        Buffer.from(block.data, "base64"),
        mediaType,
        block.type,
      );
      references.push(reference);
      presented.push({
        artifactId: reference.artifactId,
        mediaType,
        type: block.type,
      });
    } else if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      const text = await artifacts.presentText(
        runId,
        `${serverName}-${String(index + 1)}.txt`,
        redactKnownText(block.text, sensitiveValues),
      );
      references.push(...text.artifacts);
      presented.push({ text: text.displayOutput, type: "text" });
    } else {
      presented.push(
        jsonValue(redactKnownBoundaryValue(block, sensitiveValues)),
      );
    }
  }
  return { artifacts: references, modelContent: presented };
}

async function structuredContent(
  artifacts: ArtifactStore,
  runId: string,
  serverName: string,
  value: unknown,
  sensitiveValues: readonly string[],
): Promise<{
  artifacts: ArtifactReference[];
  modelContent: JsonValue;
}> {
  const modelContent = jsonValue(
    redactKnownBoundaryValue(value, sensitiveValues),
  );
  const presented = await artifacts.presentText(
    runId,
    `${serverName}-structured-result.json`,
    redactKnownText(JSON.stringify(modelContent, null, 2), sensitiveValues),
  );
  if (presented.artifacts.length === 0) {
    return { artifacts: [], modelContent };
  }
  return {
    artifacts: [...presented.artifacts],
    modelContent: {
      output: presented.displayOutput,
      truncated: true,
    },
  };
}

export class McpService {
  readonly #connected = new Map<string, ConnectedServer>();

  constructor(
    private readonly repository: McpRepository,
    private readonly secrets: ProviderSecretStore,
    private readonly registry: ToolRegistry,
    private readonly artifacts: ArtifactStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async initialize(): Promise<void> {
    for (const record of this.repository.list()) {
      if (!record.enabled) continue;
      await this.#connect(record).catch(() => undefined);
    }
  }

  registerConfigurationTools(): void {
    this.registry.register({
      descriptor: {
        description:
          "List the MCP servers configured in CharaMate, including enabled state, connection status, and discovered tool names. Use this to answer which MCP servers are installed or available.",
        effect: "read",
        idempotency: "idempotent",
        inputSchema: {
          additionalProperties: false,
          properties: {},
          required: [],
          type: "object",
        },
        itemKind: "tool_call",
        name: "mcp_config.server_list",
        namespace: "mcp_config",
        summary: "列出 MCP Server",
        source: "builtin",
      },
      execute: () => {
        const servers = jsonValue(this.list());
        return Promise.resolve({
          artifacts: [],
          evidenceHash: toolEvidenceHash(servers),
          modelContent: servers,
          retryable: false,
          status: "success" as const,
          summary: "已列出 MCP Server",
        });
      },
      summarize: () => "列出 MCP Server",
    });
    this.registry.register({
      descriptor: {
        description:
          "Add or update an MCP server only when the user explicitly asks to configure MCP. Secret values are stored in the platform-backed secret store.",
        effect: "critical",
        idempotency: "idempotent",
        inputSchema: {
          additionalProperties: false,
          properties: { server: jsonValue(McpServerDraftSchema) },
          required: ["server"],
          type: "object",
        },
        itemKind: "tool_call",
        name: "mcp_config.server_save",
        namespace: "mcp_config",
        summary: "保存 MCP Server",
        source: "builtin",
      },
      execute: async (input) => {
        const server = parseSchema(McpServerDraftSchema, input["server"]);
        const saved = await this.save(server);
        return {
          artifacts: [],
          evidenceHash: toolEvidenceHash(jsonValue(saved)),
          modelContent: jsonValue(saved),
          retryable: false,
          status: "success",
          summary: `已保存 MCP Server ${saved.name}`,
        };
      },
      summarize: (input) => {
        const server = objectValue(input["server"]);
        return `保存 MCP Server ${typeof server?.["name"] === "string" ? server["name"] : ""}`;
      },
    });
    this.registry.register({
      descriptor: {
        description:
          "Reconnect an enabled MCP server and rediscover its current tool list.",
        effect: "write",
        idempotency: "idempotent",
        inputSchema: jsonValue(McpIdRequestSchema),
        itemKind: "tool_call",
        name: "mcp_config.server_refresh",
        namespace: "mcp_config",
        summary: "刷新 MCP Server",
        source: "builtin",
      },
      execute: async (input) => {
        const { serverId } = parseSchema(McpIdRequestSchema, input);
        const refreshed = await this.refresh(serverId);
        return {
          artifacts: [],
          evidenceHash: toolEvidenceHash(jsonValue(refreshed)),
          modelContent: jsonValue(refreshed),
          retryable: false,
          status: "success",
          summary: `已刷新 MCP Server ${refreshed.name}`,
        };
      },
      summarize: (input) =>
        `刷新 MCP Server ${typeof input["serverId"] === "string" ? input["serverId"] : ""}`,
    });
    this.registry.register({
      descriptor: {
        description:
          "Delete an MCP server configuration and its stored secrets.",
        effect: "critical",
        idempotency: "idempotent",
        inputSchema: jsonValue(McpIdRequestSchema),
        itemKind: "tool_call",
        name: "mcp_config.server_delete",
        namespace: "mcp_config",
        summary: "删除 MCP Server",
        source: "builtin",
      },
      execute: async (input) => {
        const { serverId } = parseSchema(McpIdRequestSchema, input);
        const deleted = await this.delete(serverId);
        const modelContent = jsonValue(deleted);
        return {
          artifacts: [],
          evidenceHash: toolEvidenceHash(modelContent),
          modelContent,
          retryable: false,
          status: "success",
          summary: "已删除 MCP Server",
        };
      },
      summarize: (input) =>
        `删除 MCP Server ${typeof input["serverId"] === "string" ? input["serverId"] : ""}`,
    });
  }

  listSecretReferences(): ReadonlySet<string> {
    return this.repository.listSecretReferences();
  }

  list(): McpServer[] {
    return this.repository.list().map((record) => this.#snapshot(record));
  }

  async save(draft: McpServerDraft): Promise<McpServer> {
    const existing = draft.id ? this.repository.get(draft.id) : undefined;
    if (draft.id && !existing) {
      throw new ExtensionError("MCP.NOT_FOUND", "MCP Server 不存在。", false);
    }
    const normalizedName = serverNameKey(draft.name);
    if (
      this.repository
        .list()
        .some(
          (record) =>
            record.id !== existing?.id &&
            serverNameKey(record.name) === normalizedName,
        )
    ) {
      throw new ExtensionError(
        "MCP.NAME_CONFLICT",
        "MCP Server 名称与已有配置冲突。",
        false,
      );
    }
    const newlyStored: string[] = [];
    let configurationSaved = false;
    let transport: PersistedMcpTransport;
    try {
      transport = await this.#persistTransport(
        draft.transport,
        existing?.transport,
        newlyStored,
      );
      const now = this.clock.now();
      const next: McpServerRecord = {
        createdAt: existing?.createdAt ?? now,
        enabled: draft.enabled,
        id: existing?.id ?? this.ids.generate(),
        name: draft.name.trim(),
        transport,
        updatedAt: now,
      };
      const saved = this.repository.save(next);
      configurationSaved = true;
      const retained = transportSecretReferences(transport);
      if (existing) {
        await Promise.all(
          [...transportSecretReferences(existing.transport)]
            .filter((reference) => !retained.has(reference))
            .map((reference) => this.secrets.delete(reference)),
        );
      }
      if (saved.enabled) await this.#connect(saved).catch(() => undefined);
      else await this.#disconnect(saved.id);
      return this.#snapshot(this.repository.get(saved.id) ?? saved);
    } catch (error) {
      if (!configurationSaved) {
        await Promise.all(
          newlyStored.map((reference) => this.secrets.delete(reference)),
        );
      }
      if (error instanceof ExtensionError) throw error;
      throw new ExtensionError(
        "MCP.SAVE_FAILED",
        error instanceof Error ? error.message : "无法保存 MCP Server。",
        false,
      );
    }
  }

  async refresh(serverId: string): Promise<McpServer> {
    const record = this.#require(serverId);
    if (!record.enabled) return this.#snapshot(record);
    await this.#connect(record);
    return this.#snapshot(this.repository.get(serverId) ?? record);
  }

  async delete(serverId: string): Promise<{ serverId: string }> {
    const record = this.repository.delete(serverId);
    if (!record) {
      throw new ExtensionError("MCP.NOT_FOUND", "MCP Server 不存在。", false);
    }
    await this.#disconnect(serverId, serverNamespace(record));
    await Promise.all(
      [...transportSecretReferences(record.transport)].map((reference) =>
        this.secrets.delete(reference),
      ),
    );
    return { serverId };
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.#connected.values()].map(({ client }) => client.close()),
    );
    this.#connected.clear();
  }

  async #connect(record: McpServerRecord): Promise<void> {
    await this.#disconnect(record.id);
    const namespace = serverNamespace(record);
    const client = new Client(
      { name: "CharaMate", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    let sensitiveValues: readonly string[] = [];
    try {
      if (record.transport.type === "stdio") {
        const environment = await this.#hydrateFields(
          record.transport.environment,
        );
        sensitiveValues = Object.values(environment);
        await client.connect(
          new StdioClientTransport({
            args: [...record.transport.args],
            command: record.transport.command,
            ...(record.transport.cwd ? { cwd: record.transport.cwd } : {}),
            env: { ...getDefaultEnvironment(), ...environment },
            stderr: "pipe",
          }),
        );
      } else {
        const headers = await this.#hydrateFields(record.transport.headers);
        sensitiveValues = Object.values(headers);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(record.transport.url), {
            requestInit: { headers },
          }),
        );
      }
      const { tools } = await client.listTools(undefined, {
        cacheMode: "refresh",
      });
      const toolNames = tools.map((tool) =>
        registeredToolName(record, tool.name),
      );
      if (new Set(toolNames).size !== toolNames.length) {
        throw new ExtensionError(
          "MCP.TOOL_NAME_CONFLICT",
          `MCP Server ${record.name} 返回了规范化后重名的 Tool。`,
          false,
        );
      }
      tools.forEach((tool, index) => {
        const name = toolNames[index];
        if (!name) return;
        this.registry.register({
          descriptor: {
            description:
              tool.description ?? tool.title ?? `MCP Tool ${tool.name}`,
            effect: toolEffect(tool),
            idempotency: tool.annotations?.idempotentHint
              ? "idempotent"
              : "non_idempotent",
            inputSchema: jsonValue(tool.inputSchema),
            itemKind: "tool_call",
            name,
            namespace,
            source: "mcp",
            summary: tool.title ?? tool.name,
          },
          execute: async (input, context): Promise<ToolResult> => {
            try {
              const result = await client.callTool(
                { arguments: input, name: tool.name },
                { signal: context.signal },
              );
              const converted = await artifactContent(
                this.artifacts,
                context.runId,
                record.name,
                result.content,
                sensitiveValues,
              );
              const structured =
                result.structuredContent === undefined
                  ? undefined
                  : await structuredContent(
                      this.artifacts,
                      context.runId,
                      record.name,
                      result.structuredContent,
                      sensitiveValues,
                    );
              const modelContent =
                structured?.modelContent ?? converted.modelContent;
              return {
                artifacts: [
                  ...converted.artifacts,
                  ...(structured?.artifacts ?? []),
                ],
                ...(result.isError
                  ? {
                      error: {
                        code: "MCP.TOOL_ERROR",
                        message: `MCP Tool ${tool.name} 返回错误。`,
                        retryable: false,
                      },
                    }
                  : {}),
                evidenceHash: toolEvidenceHash(modelContent),
                modelContent,
                retryable: false,
                status: result.isError ? "error" : "success",
                summary: result.isError
                  ? `${tool.name} 执行失败`
                  : `${tool.name} 执行完成`,
              };
            } catch (error) {
              if (context.signal.aborted) {
                throw context.signal.reason instanceof Error
                  ? context.signal.reason
                  : new DOMException("Operation was aborted", "AbortError");
              }
              const retryable = error instanceof SdkError;
              const message = redactKnownText(
                error instanceof Error ? error.message : "MCP 调用失败。",
                sensitiveValues,
              );
              return {
                artifacts: [],
                error: {
                  code: "MCP.CALL_FAILED",
                  message,
                  retryable,
                },
                modelContent: {
                  error: message,
                },
                retryable,
                status: "error",
                summary: `${tool.name} 调用失败`,
              };
            }
          },
          summarize: () => `调用 ${record.name} · ${tool.title ?? tool.name}`,
        });
      });
      this.#connected.set(record.id, { client, namespace, toolNames });
      this.repository.updateConnection(record.id, this.clock.now(), undefined);
    } catch (error) {
      await client.close().catch(() => undefined);
      this.registry.unregisterWhere(
        (descriptor) =>
          descriptor.source === "mcp" && descriptor.namespace === namespace,
      );
      const appError: AppError = {
        code: "MCP.CONNECT_FAILED",
        message:
          error instanceof Error ? error.message : "无法连接 MCP Server。",
        retryable: true,
      };
      this.repository.updateConnection(record.id, undefined, appError);
      throw new ExtensionError(appError.code, appError.message, true);
    }
  }

  async #disconnect(id: string, knownNamespace?: string): Promise<void> {
    const connected = this.#connected.get(id);
    this.#connected.delete(id);
    const namespace = knownNamespace ?? connected?.namespace;
    if (namespace) {
      this.registry.unregisterWhere(
        (descriptor) =>
          descriptor.source === "mcp" && descriptor.namespace === namespace,
      );
    }
    await connected?.client.close();
  }

  async #persistTransport(
    draft: McpTransportDraft,
    previous: PersistedMcpTransport | undefined,
    newlyStored: string[],
  ): Promise<PersistedMcpTransport> {
    if (draft.type === "stdio") {
      const previousFields =
        previous?.type === "stdio" ? previous.environment : [];
      return {
        args: [...draft.args],
        command: draft.command.trim(),
        ...(draft.cwd?.trim() ? { cwd: draft.cwd.trim() } : {}),
        environment: await this.#persistFields(
          draft.environment,
          previousFields,
          newlyStored,
        ),
        type: "stdio",
      };
    }
    const previousFields =
      previous?.type === "streamable_http" ? previous.headers : [];
    return {
      headers: await this.#persistFields(
        draft.headers,
        previousFields,
        newlyStored,
      ),
      type: "streamable_http",
      url: new URL(draft.url).toString(),
    };
  }

  async #persistFields(
    fields: readonly { readonly name: string; readonly value?: string }[],
    previous: readonly PersistedSecretField[],
    newlyStored: string[],
  ): Promise<PersistedSecretField[]> {
    const previousByName = new Map(
      previous.map((field) => [field.name.toLowerCase(), field]),
    );
    const result: PersistedSecretField[] = [];
    for (const field of fields) {
      const name = field.name.trim();
      if (!name) continue;
      if (
        result.some(
          (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        throw new ExtensionError(
          "MCP.INVALID_CONFIGURATION",
          `配置项 ${name} 重复。`,
          false,
        );
      }
      let secretRef = previousByName.get(name.toLowerCase())?.secretRef;
      if (field.value !== undefined) {
        secretRef = await this.secrets.store(field.value);
        newlyStored.push(secretRef);
      }
      if (!secretRef) {
        throw new ExtensionError(
          "MCP.CREDENTIAL_REQUIRED",
          `请填写 ${name} 的值。`,
          false,
        );
      }
      result.push({ name, secretRef });
    }
    return result;
  }

  async #hydrateFields(
    fields: readonly PersistedSecretField[],
  ): Promise<Record<string, string>> {
    return Object.fromEntries(
      await Promise.all(
        fields.map(
          async ({ name, secretRef }): Promise<readonly [string, string]> =>
            [name, await this.secrets.get(secretRef)] as const,
        ),
      ),
    );
  }

  #snapshot(record: McpServerRecord): McpServer {
    const connected = this.#connected.get(record.id);
    const common = {
      createdAt: record.createdAt,
      enabled: record.enabled,
      id: record.id,
      ...(record.lastConnectedAt
        ? { lastConnectedAt: record.lastConnectedAt }
        : {}),
      name: record.name,
      status: !record.enabled
        ? ("disabled" as const)
        : connected
          ? ("connected" as const)
          : record.lastError
            ? ("error" as const)
            : ("disconnected" as const),
      toolNames: [...(connected?.toolNames ?? [])],
      updatedAt: record.updatedAt,
    };
    if (record.transport.type === "stdio") {
      return {
        ...common,
        ...(record.lastError ? { error: record.lastError } : {}),
        transport: {
          args: [...record.transport.args],
          command: record.transport.command,
          ...(record.transport.cwd ? { cwd: record.transport.cwd } : {}),
          environment: record.transport.environment.map(({ name }) => ({
            hasValue: true,
            name,
          })),
          type: "stdio",
        },
      };
    }
    return {
      ...common,
      ...(record.lastError ? { error: record.lastError } : {}),
      transport: {
        headers: record.transport.headers.map(({ name }) => ({
          hasValue: true,
          name,
        })),
        type: "streamable_http",
        url: record.transport.url,
      },
    };
  }

  #require(id: string): McpServerRecord {
    const record = this.repository.get(id);
    if (!record) {
      throw new ExtensionError("MCP.NOT_FOUND", "MCP Server 不存在。", false);
    }
    return record;
  }
}
