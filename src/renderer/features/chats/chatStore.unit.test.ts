import { describe, expect, it, vi } from "vitest";

import type { AgentApi } from "../../../shared/contracts/agent";
import type { Chat, ChatApi } from "../../../shared/contracts/chat";
import type {
  RunEventEnvelope,
  RunEventsApi,
} from "../../../shared/contracts/ipc";
import type {
  ProviderApi,
  ProviderProfile,
} from "../../../shared/contracts/provider";
import {
  chatDataSnapshotFixture,
  chatFixture,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
} from "../../../../tests/fixtures/foundationContracts";
import { ChatDomainStore } from "./chatStore";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createApis() {
  let chatChangedListener: ((chat: Chat) => void) | undefined;
  let eventListener: ((event: RunEventEnvelope) => void) | undefined;
  const getSnapshot = vi.fn<ChatApi["getSnapshot"]>(() =>
    Promise.resolve({
      ok: true as const,
      value: chatDataSnapshotFixture,
    }),
  );
  const rename = vi.fn<ChatApi["rename"]>(() =>
    Promise.resolve({ ok: true as const, value: chatFixture }),
  );
  const list = vi.fn<ChatApi["list"]>(() =>
    Promise.resolve({ ok: true as const, value: [chatFixture] }),
  );
  const subscribeChanged = vi.fn<ChatApi["subscribeChanged"]>((listener) => {
    chatChangedListener = listener;
    return () => {
      chatChangedListener = undefined;
    };
  });
  const chatApi: ChatApi = {
    archive: vi.fn<ChatApi["archive"]>(() =>
      Promise.resolve({ ok: true as const, value: chatFixture }),
    ),
    create: vi.fn<ChatApi["create"]>(() =>
      Promise.resolve({ ok: true as const, value: chatFixture }),
    ),
    delete: vi.fn<ChatApi["delete"]>(({ chatId }) =>
      Promise.resolve({
        ok: true as const,
        value: { chatId },
      }),
    ),
    getSnapshot,
    list,
    rename,
    restore: vi.fn<ChatApi["restore"]>(() =>
      Promise.resolve({ ok: true as const, value: chatFixture }),
    ),
    setPinned: vi.fn<ChatApi["setPinned"]>(() =>
      Promise.resolve({ ok: true as const, value: chatFixture }),
    ),
    subscribeChanged,
  };
  const profile: ProviderProfile = {
    apiStyle: "openai-compatible",
    baseUrl: "https://example.test/v1",
    chatModel: "gpt-chat",
    createdAt: FIXTURE_TIMESTAMPS.created,
    hasApiKey: true,
    id: FIXTURE_IDS.provider,
    name: "Primary",
    updatedAt: FIXTURE_TIMESTAMPS.updated,
  };
  const listProfiles = vi.fn<ProviderApi["listProfiles"]>(() =>
    Promise.resolve({
      ok: true as const,
      value: [profile],
    }),
  );
  const providerApi: ProviderApi = {
    deleteProfile: vi.fn(),
    discoverModels: vi.fn(),
    listProfiles,
    saveProfile: vi.fn(),
    testConnection: vi.fn(),
  };
  const replay = vi.fn<RunEventsApi["replay"]>(({ streamId }) =>
    Promise.resolve({
      events: [],
      latestSequence: 3,
      streamId,
    }),
  );
  const subscribe = vi.fn<RunEventsApi["subscribe"]>((listener) => {
    eventListener = listener;
    return () => {
      eventListener = undefined;
    };
  });
  const runEventsApi: RunEventsApi = {
    replay,
    subscribe,
  };
  const resume = vi.fn<AgentApi["resume"]>(({ runId }) =>
    Promise.resolve({ ok: true as const, value: { runId } }),
  );
  const start = vi.fn<AgentApi["start"]>(() =>
    Promise.resolve({
      ok: true as const,
      value: chatDataSnapshotFixture.runs[0]!,
    }),
  );
  const steer = vi.fn<AgentApi["steer"]>(({ runId }) =>
    Promise.resolve({ ok: true as const, value: { runId } }),
  );
  const agentApi: AgentApi = {
    cancel: vi.fn(),
    getPendingApproval: vi.fn(),
    resolveApproval: vi.fn(),
    resolveUserInput: vi.fn(),
    resume,
    start,
    steer,
    subscribeOpenApproval: vi.fn(() => () => undefined),
  };
  return {
    agentApi,
    chatApi,
    emitChatChanged: (chat = chatFixture) => chatChangedListener?.(chat),
    emit: (event: RunEventEnvelope) => eventListener?.(event),
    providerApi,
    spies: {
      getSnapshot,
      list,
      listProfiles,
      rename,
      replay,
      resume,
      start,
      steer,
      subscribe,
      subscribeChanged,
    },
    runEventsApi,
  };
}

describe("ChatDomainStore", () => {
  it("builds its projection from typed Chat and Provider snapshots", async () => {
    const { agentApi, chatApi, providerApi, runEventsApi, spies } =
      createApis();
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );
    const stop = store.start();
    await flushMicrotasks();
    await store.loadSnapshot(chatFixture.id);

    expect(store.getState()).toMatchObject({
      activeSnapshot: chatDataSnapshotFixture,
      chats: [chatFixture],
      models: [
        {
          displayName: "gpt-chat",
          id: `${FIXTURE_IDS.provider}::gpt-chat`,
          provider: {
            apiStyle: "openai-compatible",
            modelId: "gpt-chat",
            profileId: FIXTURE_IDS.provider,
            profileName: "Primary",
          },
        },
      ],
      status: "ready",
    });
    stop();
    expect(spies.subscribe).toHaveBeenCalledOnce();
    expect(spies.subscribeChanged).toHaveBeenCalledOnce();
  });

  it("keeps keyless initial profiles in Settings rather than exposing unusable Composer models", async () => {
    const { agentApi, chatApi, providerApi, runEventsApi, spies } =
      createApis();
    spies.listProfiles.mockResolvedValue({
      ok: true,
      value: [
        {
          apiStyle: "openai-compatible",
          baseUrl: "http://localhost:4141/v1",
          chatModel: "gpt-5.6-sol",
          createdAt: FIXTURE_TIMESTAMPS.created,
          hasApiKey: false,
          id: "99999999-9999-4999-8999-999999999999",
          name: "copilot_api",
          updatedAt: FIXTURE_TIMESTAMPS.updated,
        },
      ],
    });
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );

    await store.refreshModels();

    expect(store.getState().models).toEqual([]);
  });

  it("routes a second message into the active Run as steering", async () => {
    const { agentApi, chatApi, providerApi, runEventsApi, spies } =
      createApis();
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );
    await store.loadSnapshot(chatFixture.id);

    await store.submit({
      attachments: [],
      chatId: chatFixture.id,
      content: "先改用更简单的方案",
      execution: { approvalMode: "request_approval", mode: "agent" },
      providerProfileId: FIXTURE_IDS.provider,
    });

    expect(spies.steer).toHaveBeenCalledOnce();
    expect(spies.steer.mock.calls[0]?.[0]).toMatchObject({
      content: "先改用更简单的方案",
      runId: FIXTURE_IDS.run,
    });
    expect(spies.start).not.toHaveBeenCalled();
  });

  it("treats Run events as sequence notifications and reloads Main truth", async () => {
    const { agentApi, chatApi, emit, providerApi, runEventsApi, spies } =
      createApis();
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );
    store.start();
    await flushMicrotasks();
    await store.loadSnapshot(chatFixture.id);
    spies.getSnapshot.mockClear();

    emit({
      event: {
        delta: { text: "continued" },
        itemId: FIXTURE_IDS.item,
        type: "item.delta",
      },
      occurredAt: FIXTURE_TIMESTAMPS.updated,
      sequence: 3,
      streamId: FIXTURE_IDS.run,
    });
    await flushMicrotasks();

    expect(spies.replay).toHaveBeenCalledWith({
      afterSequence: 1,
      streamId: FIXTURE_IDS.run,
    });
    expect(spies.getSnapshot).toHaveBeenCalledWith({
      chatId: chatFixture.id,
    });
  });

  it("reloads the list and active snapshot when Main publishes an AI title", async () => {
    const {
      agentApi,
      chatApi,
      emitChatChanged,
      providerApi,
      runEventsApi,
      spies,
    } = createApis();
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );
    store.start();
    await flushMicrotasks();
    await store.loadSnapshot(chatFixture.id);
    spies.getSnapshot.mockClear();
    spies.list.mockClear();

    emitChatChanged({ ...chatFixture, title: "AI 总结标题" });
    await flushMicrotasks();

    expect(spies.list).toHaveBeenCalledWith({ query: "", status: "active" });
    expect(spies.getSnapshot).toHaveBeenCalledWith({ chatId: chatFixture.id });
  });

  it("surfaces mutation failures instead of swallowing them in the App", async () => {
    const { agentApi, chatApi, providerApi, runEventsApi, spies } =
      createApis();
    spies.rename.mockResolvedValue({
      error: {
        code: "CHAT.STORAGE_FAILED",
        message: "无法保存会话。",
        retryable: true,
      },
      ok: false,
    });
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );

    await expect(store.rename(chatFixture.id, "New title")).rejects.toThrow(
      "无法保存会话。",
    );
    expect(store.getState().error).toBe("无法保存会话。");
    store.clearError();
    expect(store.getState().error).toBeUndefined();
  });

  it("resumes an interrupted Run through Main and reloads its Chat snapshot", async () => {
    const { agentApi, chatApi, providerApi, runEventsApi, spies } =
      createApis();
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );
    await store.loadSnapshot(chatFixture.id);
    spies.getSnapshot.mockClear();

    await store.resume(FIXTURE_IDS.run);

    expect(spies.resume).toHaveBeenCalledOnce();
    const request = spies.resume.mock.calls[0]?.[0];
    expect(request?.runId).toBe(FIXTURE_IDS.run);
    expect(Date.parse(request?.requestedAt ?? "")).not.toBeNaN();
    expect(spies.getSnapshot).toHaveBeenCalledWith({ chatId: chatFixture.id });
  });
});
