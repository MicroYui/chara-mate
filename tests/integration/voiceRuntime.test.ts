import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatTitleGenerator } from "../../src/main/chat/chatTitleService";
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { RunRepository } from "../../src/main/agent/runRepository";
import type { SettingsRepository } from "../../src/main/app/settingsRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { registerBrowserTools } from "../../src/main/browser/managedBrowser";
import { openApplicationDatabase } from "../../src/main/db/database";
import type { ProviderService } from "../../src/main/providers/providerService";
import { registerLocalTools } from "../../src/main/tools/localTools";
import { ToolRegistry } from "../../src/main/tools/toolRegistry";
import type { AzureWebRtcSessionIssuer } from "../../src/main/voice/azureWebRtcSession";
import { VoiceRepository } from "../../src/main/voice/voiceRepository";
import { VoiceService } from "../../src/main/voice/voiceService";
import type {
  VoiceClientCommand,
  VoiceDriverEvent,
  VoiceSessionSnapshot,
} from "../../src/shared/contracts/voice";
import type { IdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";

const NOW = "2026-08-09T12:00:00.000Z";
const CHAT_ID = "10000000-0000-4000-8000-000000000001";
const PROFILE_ID = "10000000-0000-4000-8000-000000000002";

class SequenceIds implements IdGenerator {
  #next = 10;

  generate() {
    const value = `10000000-0000-4000-8000-${String(this.#next).padStart(12, "0")}`;
    this.#next += 1;
    return value;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture(options?: { title?: ChatTitleGenerator }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chara-mate-voice-"));
  temporaryDirectories.push(directory);
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  const chats = new ChatRepository(database);
  chats.insertChat({
    createdAt: NOW,
    id: CHAT_ID,
    status: "active",
    title: "Voice",
    updatedAt: NOW,
  });
  const ids = new SequenceIds();
  const clock = new FakeClock(NOW);
  const runs = new RunRepository(database);
  const writer = new RunEventWriter(
    runs,
    new RunEventService(runs, { publish: vi.fn() }),
    ids,
    clock,
  );
  const chatTurns = new ChatService(chats, runs, ids, clock);
  const repository = new VoiceRepository(database);
  const commands: VoiceClientCommand[] = [];
  const snapshots: Array<VoiceSessionSnapshot | null> = [];
  const tools = new ToolRegistry();
  registerLocalTools(tools, undefined as never);
  registerBrowserTools(tools, undefined as never, undefined as never);
  const read = vi.fn().mockResolvedValue({
    artifacts: [],
    modelContent: { forecast: "晴" },
    retryable: false,
    status: "success",
    summary: "天气为晴",
  });
  tools.register({
    descriptor: {
      description: "查询指定城市天气。",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: {
        additionalProperties: false,
        properties: { city: { type: "string" } },
        required: ["city"],
        type: "object",
      },
      itemKind: "tool_call",
      name: "weather.lookup",
      namespace: "weather",
      source: "builtin",
      summary: "查询天气",
    },
    execute: read,
    summarize: (input) =>
      `查询${typeof input["city"] === "string" ? input["city"] : ""}天气`,
  });
  const write = vi.fn().mockResolvedValue({
    artifacts: [],
    modelContent: { saved: true },
    retryable: false,
    status: "success",
    summary: "已经保存",
  });
  tools.register({
    descriptor: {
      description: "保存一条便签。",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: {
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"],
        type: "object",
      },
      itemKind: "tool_call",
      name: "note.save",
      namespace: "note",
      source: "builtin",
      summary: "保存便签",
    },
    execute: write,
    summarize: (input) =>
      `保存便签：${typeof input["text"] === "string" ? input["text"] : ""}`,
  });
  const settings = {
    getVoice: () => ({
      inputMode: "hands_free",
      instructions: "使用自然、简洁的中文口语。",
      providerProfileId: PROFILE_ID,
      voice: "verse",
    }),
  } as unknown as SettingsRepository;
  const chatProvider = {
    resolveContextLimits: vi.fn().mockResolvedValue({}),
    stream: vi.fn(),
    supportsNativeWebSearch: true,
  };
  const chatRuntime = {
    provider: chatProvider,
    snapshot: {
      apiStyle: "openai-compatible" as const,
      modelId: "gpt-5.6",
      profileId: PROFILE_ID,
      profileName: "Chat",
    },
  };
  const createChatModelRuntime = vi.fn().mockResolvedValue(chatRuntime);
  const providers = {
    createChatModelRuntime,
    createRealtimeProviderRuntime: vi.fn().mockResolvedValue({
      apiKey: "test-key",
      profile: {
        apiStyle: "azure-openai",
        baseUrl: "https://unit.openai.azure.com/openai/v1",
        id: PROFILE_ID,
        name: "Azure Voice",
        realtimeEndpoint: "https://unit.openai.azure.com/openai/v1/realtime",
        realtimeModel: "gpt-realtime-2.1",
      },
      snapshot: {
        apiStyle: "azure-openai",
        modelId: "gpt-realtime-2.1",
        profileId: PROFILE_ID,
        profileName: "Azure Voice",
      },
    }),
    getDefaultChatProfileId: vi.fn().mockReturnValue(PROFILE_ID),
  } as unknown as ProviderService;
  const issue = vi.fn<AzureWebRtcSessionIssuer["issue"]>().mockResolvedValue({
    callsUrl: "https://unit.openai.azure.com/openai/v1/realtime/calls",
    clientSecret: "ephemeral",
    expiresAt: "2026-08-09T12:01:00.000Z",
  });
  const service = new VoiceService(
    repository,
    settings,
    providers,
    { issue } as unknown as AzureWebRtcSessionIssuer,
    tools,
    runs,
    writer,
    chatTurns,
    chats,
    ids,
    clock,
    {
      command: (command) => commands.push(command),
      snapshot: (snapshot) => snapshots.push(snapshot),
    },
    () => "Workspace skill instructions.",
    options?.title,
  );
  return {
    chatProvider,
    chatRuntime,
    chatTurns,
    chats,
    clock,
    commands,
    createChatModelRuntime,
    database,
    issue,
    read,
    repository,
    runs,
    service,
    snapshots,
    tools,
    write,
  };
}

async function report(
  service: VoiceService,
  sessionId: string,
  event: VoiceDriverEvent,
) {
  return service.report({ event, occurredAt: NOW, sessionId });
}

async function startTurn(
  value: Awaited<ReturnType<typeof fixture>>,
  execution:
    | { mode: "chat" }
    | {
        approvalMode: "request_approval";
        mode: "agent";
      },
  transcript: string,
) {
  const connection = await value.service.start({
    chatId: CHAT_ID,
    chatProviderProfileId: PROFILE_ID,
    execution,
    requestedAt: NOW,
  });
  await report(value.service, connection.sessionId, {
    protocolSessionId: "protocol-session",
    type: "session.ready",
  });
  await report(value.service, connection.sessionId, {
    itemId: "user-item-1",
    type: "speech.started",
  });
  await report(value.service, connection.sessionId, {
    itemId: "user-item-1",
    transcript,
    type: "transcript.user.completed",
  });
  const run = value.runs.getActiveRun(CHAT_ID);
  if (!run) throw new Error("Voice Run was not created");
  return { connection, run };
}

async function finalResponse(
  value: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  generation: number,
  responseId: string,
  text: string,
) {
  await report(value.service, sessionId, {
    generation,
    responseId,
    type: "response.started",
  });
  await report(value.service, sessionId, {
    delta: text,
    generation,
    itemId: `${responseId}-item`,
    outputIndex: 0,
    responseId,
    type: "transcript.assistant.delta",
  });
  await report(value.service, sessionId, {
    generation,
    itemId: `${responseId}-item`,
    outputIndex: 0,
    responseId,
    transcript: text,
    type: "transcript.assistant.done",
  });
  await report(value.service, sessionId, {
    generation,
    responseId,
    status: "completed",
    type: "response.done",
  });
}

describe("Realtime native Voice runtime", () => {
  it("freezes the final turn instructions after time advances during speech", async () => {
    const value = await fixture();
    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    await report(value.service, connection.sessionId, {
      protocolSessionId: "protocol-session",
      type: "session.ready",
    });
    await report(value.service, connection.sessionId, {
      itemId: "user-item-after-delay",
      type: "speech.started",
    });

    value.clock.advance(1_000);
    await value.service.report({
      event: {
        itemId: "user-item-after-delay",
        transcript: "你好啊",
        type: "transcript.user.completed",
      },
      occurredAt: value.clock.now(),
      sessionId: connection.sessionId,
    });

    const turn = value.repository.getCurrentTurn(connection.sessionId);
    expect(turn).toMatchObject({
      status: "responding",
      userTranscript: "你好啊",
    });
    expect(turn?.instructions).toContain(value.clock.now());
    value.database.close();
  });

  it("lets Realtime own the answer while persisting the exact transcript in one Voice Run", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "你好，直接回答我",
    );

    const responseCreate = value.commands.find(
      (command) => command.type === "response.create",
    );
    expect(responseCreate).toMatchObject({
      generation: 1,
      type: "response.create",
    });
    expect(responseCreate).not.toHaveProperty("text");
    expect(responseCreate?.instructions).toContain(
      "Realtime owns this spoken conversation",
    );
    expect(responseCreate?.instructions).toContain(
      "Workspace skill instructions.",
    );
    expect(responseCreate?.instructions).toContain(
      "never claim that an earlier query is still loading",
    );

    await finalResponse(
      value,
      connection.sessionId,
      1,
      "response-final",
      "你好，我会直接回答。",
    );

    expect(value.runs.getRun(run.id)?.status).toBe("completed");
    expect(value.chats.listRunMessages(run.id)).toMatchObject([
      { content: "你好，直接回答我", role: "user", status: "completed" },
      {
        content: "你好，我会直接回答。",
        role: "assistant",
        status: "completed",
      },
    ]);
    expect(value.chatProvider.stream).not.toHaveBeenCalled();
    expect(value.commands.some(({ type }) => type === "tool.result")).toBe(
      false,
    );
    value.database.close();
  });

  it("keeps one Chat message aligned with ordered audio items in a response", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "帮我查天气",
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-multiple-audio-items",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      delta: "北京明天晴。",
      generation: 1,
      itemId: "assistant-final",
      outputIndex: 1,
      responseId: "response-multiple-audio-items",
      type: "transcript.assistant.delta",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      itemId: "assistant-acknowledgement",
      outputIndex: 0,
      responseId: "response-multiple-audio-items",
      transcript: "好的，我来查一下。",
      type: "transcript.assistant.done",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      itemId: "assistant-final",
      outputIndex: 1,
      responseId: "response-multiple-audio-items",
      transcript: "北京明天晴。",
      type: "transcript.assistant.done",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-multiple-audio-items",
      status: "completed",
      type: "response.done",
    });

    const assistantMessages = value.chats
      .listRunMessages(run.id)
      .filter(({ role }) => role === "assistant");
    expect(assistantMessages).toMatchObject([
      {
        content: "好的，我来查一下。\n\n北京明天晴。",
        status: "completed",
      },
    ]);
    expect(value.repository.listTurns(connection.sessionId)[0]).toMatchObject({
      assistantTranscript: assistantMessages[0]?.content,
      status: "completed",
    });
    expect(
      value.runs
        .listRunItems(run.id)
        .filter(({ kind }) => kind === "assistant_message"),
    ).toMatchObject([
      {
        displayOutput: assistantMessages[0]?.content,
        status: "completed",
      },
    ]);
    value.database.close();
  });

  it("does not block Realtime when the optional title Provider credential cannot be read", async () => {
    const generate = vi
      .fn<ChatTitleGenerator["generate"]>()
      .mockResolvedValue();
    const value = await fixture({ title: { generate } });
    value.createChatModelRuntime.mockRejectedValue(
      new Error("title credential unavailable"),
    );

    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "先正常开始语音",
    );
    expect(value.createChatModelRuntime).not.toHaveBeenCalled();

    await finalResponse(
      value,
      connection.sessionId,
      1,
      "response-without-title-provider",
      "语音连接不受标题服务影响。",
    );

    await vi.waitFor(() =>
      expect(value.createChatModelRuntime).toHaveBeenCalledOnce(),
    );
    expect(generate).not.toHaveBeenCalled();
    expect(value.runs.getRun(run.id)?.status).toBe("completed");
    expect(value.service.getActive()?.phase).toBe("listening");
    value.database.close();
  });

  it("keeps an object-union Tool contract while satisfying Realtime's object root", async () => {
    const value = await fixture();
    value.tools.register({
      descriptor: {
        description: "按查询或 ID 读取内容。",
        effect: "read",
        idempotency: "idempotent",
        inputSchema: {
          anyOf: [
            {
              additionalProperties: false,
              properties: { query: { type: "string" } },
              required: ["query"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: { id: { type: "string" } },
              required: ["id"],
              type: "object",
            },
          ],
        },
        itemKind: "tool_call",
        name: "choice.lookup",
        namespace: "choice",
        source: "builtin",
        summary: "读取内容",
      },
      execute: vi.fn().mockResolvedValue({
        artifacts: [],
        modelContent: { found: true },
        retryable: false,
        status: "success",
        summary: "已读取",
      }),
      summarize: () => "读取内容",
    });

    const connection = await value.service.start({
      chatId: CHAT_ID,
      chatProviderProfileId: PROFILE_ID,
      execution: { mode: "chat" },
      requestedAt: NOW,
    });
    const unionTool = value.issue.mock.calls[0]?.[1].tools?.find(
      ({ name }) => name === "choice_lookup",
    );
    expect(unionTool?.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        query: { type: "string" },
      },
      type: "object",
    });
    expect(unionTool?.parameters).not.toHaveProperty("anyOf");
    value.service.end({ sessionId: connection.sessionId });
    value.database.close();
  });

  it("injects the same allowed client tools and continues after function_call_output", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { mode: "chat" },
      "北京天气如何",
    );
    const issueOptions = value.issue.mock.calls[0]?.[1];
    expect(issueOptions?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_navigate", type: "function" }),
        expect.objectContaining({ name: "browser_snapshot", type: "function" }),
        expect.objectContaining({ name: "file_read", type: "function" }),
        expect.objectContaining({ name: "weather_lookup", type: "function" }),
      ]),
    );
    expect(issueOptions?.tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "command_run" }),
        expect.objectContaining({ name: "note_save" }),
      ]),
    );

    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-tool",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      arguments: '{"city":"北京"}',
      callId: "call-weather",
      generation: 1,
      itemId: "function-item",
      name: "weather_lookup",
      responseId: "response-tool",
      type: "tool.call",
    });
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-tool",
      status: "completed",
      type: "response.done",
    });
    await vi.waitFor(() => expect(value.read).toHaveBeenCalledOnce());
    const result = value.commands.find(
      (command) => command.type === "tool.result",
    );
    expect(result).toMatchObject({
      callId: "call-weather",
      generation: 1,
      type: "tool.result",
    });
    expect(
      JSON.parse(result?.type === "tool.result" ? result.output : "{}"),
    ).toMatchObject({ modelContent: { forecast: "晴" }, status: "success" });

    await finalResponse(
      value,
      connection.sessionId,
      1,
      "response-after-tool",
      "北京今天晴。",
    );
    expect(value.runs.getRun(run.id)?.status).toBe("completed");
    expect(value.runs.listRunItems(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool_call", status: "completed" }),
      ]),
    );
    value.database.close();
  });

  it("uses the existing Approval item and bubble decision before a write tool", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { approvalMode: "request_approval", mode: "agent" },
      "帮我保存便签",
    );
    expect(value.issue.mock.calls[0]?.[1].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "command_run" }),
        expect.objectContaining({ name: "note_save" }),
        expect.objectContaining({ name: "weather_lookup" }),
      ]),
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-write",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      arguments: '{"text":"买牛奶"}',
      callId: "call-note",
      generation: 1,
      itemId: "function-note",
      name: "note_save",
      responseId: "response-write",
      type: "tool.call",
    });

    const approval = value.runs.getLatestPendingApproval();
    expect(approval).toMatchObject({
      runId: run.id,
      status: "pending",
      toolName: "note.save",
    });
    expect(value.service.getActive()?.phase).toBe("waiting_approval");
    if (!approval) throw new Error("Approval was not created");
    value.service.resolveApproval({
      approvalId: approval.id,
      decidedAt: NOW,
      decision: "approved",
    });

    await vi.waitFor(() => expect(value.write).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        value.commands.find((command) => command.type === "tool.result"),
      ).toMatchObject({ callId: "call-note", type: "tool.result" }),
    );
    expect(value.runs.getApproval(approval.id)?.status).toBe("approved");
    expect(value.runs.getRun(run.id)?.status).toBe("running");
    value.database.close();
  });

  it("returns a rejected Approval to Realtime without executing the write", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { approvalMode: "request_approval", mode: "agent" },
      "帮我保存便签",
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-rejected-write",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      arguments: '{"text":"买牛奶"}',
      callId: "call-rejected-note",
      generation: 1,
      itemId: "function-rejected-note",
      name: "note_save",
      responseId: "response-rejected-write",
      type: "tool.call",
    });

    const approval = value.runs.getLatestPendingApproval();
    if (!approval) throw new Error("Approval was not created");
    value.service.resolveApproval({
      approvalId: approval.id,
      decidedAt: NOW,
      decision: "rejected",
      reason: "暂时不要保存",
    });

    await vi.waitFor(() =>
      expect(
        value.commands.find(
          (command) =>
            command.type === "tool.result" &&
            command.callId === "call-rejected-note",
        ),
      ).toBeDefined(),
    );
    const result = value.commands.find(
      (command) =>
        command.type === "tool.result" &&
        command.callId === "call-rejected-note",
    );
    expect(
      JSON.parse(result?.type === "tool.result" ? result.output : "{}"),
    ).toMatchObject({
      modelContent: { decision: "rejected", reason: "暂时不要保存" },
      status: "rejected",
    });
    expect(value.write).not.toHaveBeenCalled();
    expect(value.runs.getApproval(approval.id)?.status).toBe("rejected");
    expect(value.runs.getRun(run.id)?.status).toBe("running");
    expect(value.service.getActive()?.phase).toBe("thinking");
    value.database.close();
  });

  it("cancels a pending Approval when the Realtime turn fails", async () => {
    const value = await fixture();
    const { connection, run } = await startTurn(
      value,
      { approvalMode: "request_approval", mode: "agent" },
      "帮我保存便签",
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-failed-write",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      arguments: '{"text":"买牛奶"}',
      callId: "call-failed-note",
      generation: 1,
      itemId: "function-failed-note",
      name: "note_save",
      responseId: "response-failed-write",
      type: "tool.call",
    });
    const approval = value.runs.getLatestPendingApproval();
    if (!approval) throw new Error("Approval was not created");

    await report(value.service, connection.sessionId, {
      code: "VOICE.REALTIME_ERROR",
      message: "Realtime failed",
      type: "server.error",
    });

    expect(value.runs.getApproval(approval.id)?.status).toBe("cancelled");
    expect(value.runs.getLatestPendingApproval()).toBeUndefined();
    expect(value.runs.getRun(run.id)?.status).toBe("failed");
    expect(value.service.getActive()?.phase).toBe("failed");
    expect(value.write).not.toHaveBeenCalled();
    value.database.close();
  });

  it("interrupts the prior Run on natural barge-in and accepts the next turn", async () => {
    const value = await fixture();
    const { connection, run: firstRun } = await startTurn(
      value,
      { mode: "chat" },
      "先回答第一问",
    );
    await report(value.service, connection.sessionId, {
      generation: 1,
      responseId: "response-first",
      type: "response.started",
    });
    await report(value.service, connection.sessionId, {
      delta: "还没说完",
      generation: 1,
      itemId: "assistant-first",
      outputIndex: 0,
      responseId: "response-first",
      type: "transcript.assistant.delta",
    });

    await report(value.service, connection.sessionId, {
      assistantItemId: "assistant-first",
      audioEndMs: 240,
      itemId: "user-item-2",
      type: "speech.started",
    });
    expect(value.runs.getRun(firstRun.id)?.status).toBe("interrupted");
    expect(value.chats.listRunMessages(firstRun.id).at(-1)).toMatchObject({
      content: "还没说完",
      role: "assistant",
      status: "interrupted",
    });

    await report(value.service, connection.sessionId, {
      itemId: "user-item-2",
      transcript: "改问第二个问题",
      type: "transcript.user.completed",
    });
    const secondRun = value.runs.getActiveRun(CHAT_ID);
    expect(secondRun?.id).not.toBe(firstRun.id);
    await finalResponse(
      value,
      connection.sessionId,
      2,
      "response-second",
      "这是第二个问题的回答。",
    );
    expect(value.runs.getRun(secondRun!.id)?.status).toBe("completed");
    expect(value.service.getActive()?.phase).toBe("listening");
    value.database.close();
  });

  it("reuses the ordinary fallback and AI title chain for a quick Voice Chat", async () => {
    const generate = vi
      .fn<ChatTitleGenerator["generate"]>()
      .mockResolvedValue();
    const value = await fixture({ title: { generate } });
    const connection = await value.service.quickStart({ requestedAt: NOW });
    const chatId = value.service.getActive()?.chatId;
    if (!chatId) throw new Error("Quick Voice Chat was not created");
    expect(value.chats.getChat(chatId)?.title).toBe("语音对话");
    await report(value.service, connection.sessionId, {
      protocolSessionId: "quick-session",
      type: "session.ready",
    });
    await report(value.service, connection.sessionId, {
      itemId: "quick-user",
      type: "speech.started",
    });
    await report(value.service, connection.sessionId, {
      itemId: "quick-user",
      transcript: "帮我安排今天",
      type: "transcript.user.completed",
    });
    expect(value.runs.getActiveRun(chatId)?.execution).toEqual({
      approvalMode: "full_access",
      mode: "agent",
    });
    expect(value.chats.getChat(chatId)?.title).toBe("帮我安排今天");
    await finalResponse(
      value,
      connection.sessionId,
      1,
      "quick-response",
      "可以，我们从最重要的事情开始。",
    );
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      assistantContent: "可以，我们从最重要的事情开始。",
      chatId,
      firstUserContent: "帮我安排今天",
      modelId: "gpt-5.6",
      provider: value.chatRuntime.provider,
    });
    value.database.close();
  });
});
