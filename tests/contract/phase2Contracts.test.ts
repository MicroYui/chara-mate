import type { TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { AGENT_CHANNELS } from "../../src/shared/contracts/agent";
import { EXTENSION_CHANNELS } from "../../src/shared/contracts/extensions";
import { SETTINGS_CHANNELS } from "../../src/shared/contracts/settings";
import {
  PendingApprovalResponseSchema,
  ResolveApprovalRequestSchema,
  ResumeRunRequestSchema,
  RunMutationResponseSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  SteerRunRequestSchema,
} from "../../src/shared/schemas/agent";
import {
  McpListResponseSchema,
  McpSaveRequestSchema,
  McpServerSchema,
  SkillContentSchema,
  SkillSetEnabledRequestSchema,
} from "../../src/shared/schemas/extensions";
import { IpcChannelSchema } from "../../src/shared/schemas/ipc";
import {
  AgentSettingsSaveRequestSchema,
  BrowserActionResponseSchema,
  SettingsSnapshotResponseSchema,
} from "../../src/shared/schemas/settings";
import {
  ToolDescriptorSchema,
  ToolResultSchema,
} from "../../src/shared/schemas/tool";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";
import {
  approvalFixture,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
  runFixture,
} from "../fixtures/foundationContracts";

const parsers = [parseSchema, parseSchemaWithoutCodeGeneration] as const;
const skill = {
  archived: false,
  contentSha256: "0".repeat(64),
  description: "Review the current workspace",
  enabled: true,
  id: "workspace:review",
  name: "review",
  readOnly: true,
  revision: 1,
  source: "workspace",
} as const;
const mcpServer = {
  createdAt: FIXTURE_TIMESTAMPS.created,
  enabled: true,
  id: FIXTURE_IDS.request,
  lastConnectedAt: FIXTURE_TIMESTAMPS.updated,
  name: "Local tools",
  status: "connected",
  toolNames: ["mcp__local_tools__read"],
  transport: {
    environment: [{ hasValue: true, name: "API_KEY" }],
    args: ["server.mjs"],
    command: "node",
    type: "stdio",
  },
  updatedAt: FIXTURE_TIMESTAMPS.updated,
} as const;
const agentSettings = {
  defaultApprovalMode: "request_approval",
  defaultMode: "agent",
  workingDirectory: "/workspace",
} as const;
const settingsSnapshot = {
  agent: agentSettings,
  browserComputer: {
    accessibility: "granted",
    browser: "ready",
    profileDirectory: "/profile",
    screenRecording: "not_determined",
  },
} as const;
const toolDescriptor = {
  description: "Read one local file",
  effect: "read",
  idempotency: "idempotent",
  inputSchema: {
    additionalProperties: false,
    properties: { path: { type: "string" } },
    required: ["path"],
    type: "object",
  },
  itemKind: "file_change",
  name: "file.read",
  namespace: "file",
  source: "builtin",
  summary: "读取文件",
} as const;

const validCases: readonly [string, TSchema, unknown][] = [
  [
    "Agent start request",
    StartRunRequestSchema,
    {
      attachments: [],
      chatId: FIXTURE_IDS.chat,
      content: "Complete the task",
      execution: { approvalMode: "request_approval", mode: "agent" },
      providerProfileId: FIXTURE_IDS.provider,
      requestedAt: FIXTURE_TIMESTAMPS.updated,
    },
  ],
  [
    "Agent start response",
    StartRunResponseSchema,
    { ok: true, value: runFixture },
  ],
  [
    "Steering request",
    SteerRunRequestSchema,
    {
      content: "Use the new direction",
      requestedAt: FIXTURE_TIMESTAMPS.updated,
      runId: FIXTURE_IDS.run,
    },
  ],
  [
    "Resume request",
    ResumeRunRequestSchema,
    { requestedAt: FIXTURE_TIMESTAMPS.updated, runId: FIXTURE_IDS.run },
  ],
  [
    "Run mutation response",
    RunMutationResponseSchema,
    { ok: true, value: { runId: FIXTURE_IDS.run } },
  ],
  [
    "Resolve approval request",
    ResolveApprovalRequestSchema,
    {
      approvalId: FIXTURE_IDS.approval,
      decidedAt: FIXTURE_TIMESTAMPS.updated,
      decision: "approved",
    },
  ],
  [
    "Pending approval response",
    PendingApprovalResponseSchema,
    { ok: true, value: approvalFixture },
  ],
  ["Tool descriptor", ToolDescriptorSchema, toolDescriptor],
  [
    "Tool result",
    ToolResultSchema,
    {
      artifacts: [],
      evidenceHash: "1".repeat(64),
      modelContent: { content: "done" },
      retryable: false,
      status: "success",
      summary: "读取完成",
    },
  ],
  ["MCP server", McpServerSchema, mcpServer],
  [
    "MCP list response",
    McpListResponseSchema,
    { ok: true, value: [mcpServer] },
  ],
  [
    "MCP save request",
    McpSaveRequestSchema,
    {
      server: {
        enabled: true,
        name: "Local tools",
        transport: {
          args: ["server.mjs"],
          command: "node",
          environment: [{ name: "API_KEY", value: "secret" }],
          type: "stdio",
        },
      },
    },
  ],
  [
    "Skill content",
    SkillContentSchema,
    { content: "# Review\n\nFollow the checklist.", skill },
  ],
  [
    "Skill enabled request",
    SkillSetEnabledRequestSchema,
    { enabled: false, skillId: skill.id },
  ],
  [
    "Agent settings request",
    AgentSettingsSaveRequestSchema,
    { agent: agentSettings },
  ],
  [
    "Settings snapshot response",
    SettingsSnapshotResponseSchema,
    { ok: true, value: settingsSnapshot },
  ],
  [
    "Browser action response",
    BrowserActionResponseSchema,
    { ok: true, value: { importedCookies: 3, message: "已导入。" } },
  ],
];

describe("Phase 2 boundary contracts", () => {
  it.each(parsers)("accepts every Phase 2 IPC channel through %s", (parse) => {
    for (const channel of [
      ...Object.values(AGENT_CHANNELS),
      ...Object.values(EXTENSION_CHANNELS),
      ...Object.values(SETTINGS_CHANNELS),
    ]) {
      expect(parse(IpcChannelSchema, channel)).toBe(channel);
    }
  });

  it.each(parsers)(
    "round-trips Phase 2 boundary values through %s",
    (parse) => {
      for (const [, schema, value] of validCases) {
        expect(parse(schema, value)).toEqual(value);
      }
    },
  );

  it.each(parsers)(
    "keeps experiment controls and secret values out of production snapshots through %s",
    (parse) => {
      expect(() =>
        parse(AgentSettingsSaveRequestSchema, {
          agent: { ...agentSettings, harnessMode: "H7" },
        }),
      ).toThrow();
      expect(() =>
        parse(McpServerSchema, {
          ...mcpServer,
          transport: {
            ...mcpServer.transport,
            environment: [{ hasValue: true, name: "API_KEY", value: "secret" }],
          },
        }),
      ).toThrow();
      expect(() =>
        parse(ToolDescriptorSchema, {
          ...toolDescriptor,
          discoveryTopK: 8,
        }),
      ).toThrow();
    },
  );
});
