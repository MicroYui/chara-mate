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
  const cancelStart = vi.fn<AgentApi["cancelStart"]>(({ requestId }) =>
    Promise.resolve({ ok: true, value: { requestId, outcome: "accepted" } }),
  );
  const cancel = vi.fn<AgentApi["cancel"]>();
  const agentApi: AgentApi = {
    cancelStart,
    cancel,
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
      cancel,
      cancelStart,
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

  it("distinguishes a failed model load from a ready Chat projection", async () => {
    const { agentApi, chatApi, providerApi, runEventsApi, spies } =
      createApis();
    spies.listProfiles.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "PROVIDER.UNREACHABLE",
        message: "暂时无法读取模型",
        retryable: true,
      },
    });
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );
    const stop = store.start();
    await flushMicrotasks();
    expect(store.getState()).toMatchObject({
      status: "ready",
      modelsStatus: "failed",
      models: [],
    });
    await store.refreshModels();
    expect(store.getState().modelsStatus).toBe("ready");
    expect(store.getState().models).toHaveLength(1);
    stop();
  });

  it("preserves the last successful list during loading and a failed refresh", async () => {
    const { agentApi, chatApi, providerApi, runEventsApi, spies } =
      createApis();
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );
    await store.refreshModels();
    const models = store.getState().models;
    let reject!: (reason: Error) => void;
    spies.listProfiles.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const pending = store.refreshModels();
    expect(store.getState().modelsStatus).toBe("loading");
    expect(store.getState().models).toBe(models);
    reject(new Error("连接暂时不可用"));
    await pending;
    expect(store.getState().modelsStatus).toBe("failed");
    expect(store.getState().models).toBe(models);
    spies.listProfiles.mockResolvedValueOnce({ ok: true, value: [] });
    await store.refreshModels();
    expect(store.getState()).toMatchObject({
      modelsStatus: "ready",
      models: [],
    });
  });

  it("does not let an older empty response erase a newer successful list", async () => {
    const { agentApi, chatApi, providerApi, runEventsApi, spies } =
      createApis();
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );
    let resolve!: (
      value: Awaited<ReturnType<ProviderApi["listProfiles"]>>,
    ) => void;
    spies.listProfiles.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const older = store.refreshModels();
    await store.refreshModels();
    const current = store.getState().models;
    resolve({ ok: true, value: [] });
    await older;
    expect(store.getState().models).toBe(current);
    expect(store.getState().modelsStatus).toBe("ready");
  });

  it("does not promote a model response after its owner stopped", async () => {
    const { agentApi, chatApi, providerApi, runEventsApi, spies } =
      createApis();
    const store = new ChatDomainStore(
      chatApi,
      agentApi,
      providerApi,
      runEventsApi,
    );
    let resolve!: (
      value: Awaited<ReturnType<ProviderApi["listProfiles"]>>,
    ) => void;
    spies.listProfiles.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = store.refreshModels();
    store.stop();
    resolve({ ok: true, value: [] });
    await pending;
    expect(store.getState().modelsStatus).toBe("loading");
    await store.refreshModels();
    expect(store.getState().modelsStatus).toBe("ready");
    expect(store.getState().models).toHaveLength(1);
  });

  it.each(["running", "waiting_approval", "needs_input"] as const)(
    "routes a second message into a %s Run as steering",
    async (status) => {
      const { agentApi, chatApi, providerApi, runEventsApi, spies } =
        createApis();
      spies.getSnapshot.mockResolvedValue({
        ok: true,
        value: {
          ...chatDataSnapshotFixture,
          runs: chatDataSnapshotFixture.runs.map((run) => ({ ...run, status })),
        },
      });
      const store = new ChatDomainStore(
        chatApi,
        agentApi,
        providerApi,
        runEventsApi,
      );
      await store.loadSnapshot(chatFixture.id);

      await store.submit({
        requestId: "20000000-0000-4000-8000-000000000001",
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
    },
  );

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

it("cancels the pending submission before a Run exists and retains pending until real cleanup", async () => {
  const { agentApi, chatApi, providerApi, runEventsApi, spies } = createApis();
  spies.getSnapshot.mockResolvedValue({
    ok: true,
    value: { ...chatDataSnapshotFixture, runs: [], runItems: [], messages: [] },
  });
  let releaseStart!: (value: Awaited<ReturnType<AgentApi["start"]>>) => void;
  let releaseCancel!: () => void;
  spies.start.mockReturnValue(
    new Promise((resolve) => {
      releaseStart = resolve;
    }),
  );
  spies.cancelStart.mockImplementation(async ({ requestId }) => {
    await new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    return { ok: true, value: { requestId, outcome: "accepted" } };
  });
  const store = new ChatDomainStore(
    chatApi,
    agentApi,
    providerApi,
    runEventsApi,
  );
  await store.loadSnapshot(chatFixture.id);
  const requestId = "20000000-0000-4000-8000-000000000001";
  const pending = store
    .submit({
      requestId,
      attachments: [],
      chatId: chatFixture.id,
      content: "准备中的消息",
      execution: { mode: "chat" },
      providerProfileId: FIXTURE_IDS.provider,
    })
    .catch((error: unknown) => error);
  try {
    expect(store.getState().pendingChatIds).toEqual([chatFixture.id]);
    const stopping = store.cancelActive(chatFixture.id);
    expect(spies.cancelStart).toHaveBeenCalledWith({
      requestId,
      requestedAt: expect.any(String) as string,
    });
    expect(spies.cancel).not.toHaveBeenCalled();
    releaseStart({
      ok: false,
      error: {
        code: "AGENT.PREPARATION_CANCELLED",
        message: "已停止准备",
        retryable: false,
      },
    });
    await flushMicrotasks();
    expect(store.getState().pendingChatIds).toEqual([chatFixture.id]);
    releaseCancel();
    await stopping;
    await pending;
    expect(store.getState().pendingChatIds).toEqual([]);
    expect(spies.start).toHaveBeenCalledOnce();
  } finally {
    releaseStart({
      ok: false,
      error: {
        code: "AGENT.PREPARATION_CANCELLED",
        message: "已停止准备",
        retryable: false,
      },
    });
    releaseCancel?.();
    await pending;
    store.stop();
  }
});

it("routes Stop to a resumed interrupted Run while Provider preparation has no active Run", async () => {
  const { agentApi, chatApi, providerApi, runEventsApi, spies } = createApis();
  const run = {
    ...chatDataSnapshotFixture.runs[0]!,
    status: "interrupted" as const,
  };
  spies.getSnapshot.mockResolvedValue({
    ok: true,
    value: { ...chatDataSnapshotFixture, runs: [run] },
  });
  let release!: () => void;
  spies.resume.mockImplementation(async ({ runId }) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true, value: { runId } };
  });
  spies.cancel.mockImplementation(({ runId }) =>
    Promise.resolve({
      ok: true,
      value: { outcome: "already_terminal", runId, status: "interrupted" },
    }),
  );
  const store = new ChatDomainStore(
    chatApi,
    agentApi,
    providerApi,
    runEventsApi,
  );
  await store.loadSnapshot(run.chatId);
  const pending = store.resume(run.id);
  try {
    expect(store.getState().pendingChatIds).toEqual([run.chatId]);
    await store.cancelActive(run.chatId);
    expect(spies.cancel).toHaveBeenCalledWith({
      runId: run.id,
      requestedAt: expect.any(String) as string,
    });
    expect(spies.cancelStart).not.toHaveBeenCalled();
  } finally {
    release();
    await pending;
    store.stop();
  }
});

it("keeps a failed Stop visible and permits another explicit Stop for the same pending request", async () => {
  const { agentApi, chatApi, providerApi, runEventsApi, spies } = createApis();
  spies.getSnapshot.mockResolvedValue({
    ok: true,
    value: { ...chatDataSnapshotFixture, runs: [], runItems: [], messages: [] },
  });
  let release!: (value: Awaited<ReturnType<AgentApi["start"]>>) => void;
  spies.start.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  spies.cancelStart.mockResolvedValueOnce({
    ok: false,
    error: {
      code: "AGENT.RUNTIME_FAILED",
      message: "停止失败",
      retryable: true,
    },
  });
  const store = new ChatDomainStore(
    chatApi,
    agentApi,
    providerApi,
    runEventsApi,
  );
  const requestId = "20000000-0000-4000-8000-000000000005";
  await store.loadSnapshot(chatFixture.id);
  const pending = store
    .submit({
      requestId,
      attachments: [],
      chatId: chatFixture.id,
      content: "保留草稿",
      execution: { mode: "chat" },
      providerProfileId: FIXTURE_IDS.provider,
    })
    .catch((error: unknown) => error);
  try {
    await expect(store.cancelActive(chatFixture.id)).rejects.toThrow(
      "停止失败",
    );
    expect(store.getState()).toMatchObject({
      error: "停止失败",
      pendingChatIds: [chatFixture.id],
    });
    await store.cancelActive(chatFixture.id);
    expect(spies.cancelStart).toHaveBeenCalledTimes(2);
  } finally {
    release({
      ok: false,
      error: {
        code: "AGENT.PREPARATION_CANCELLED",
        message: "已停止准备",
        retryable: false,
      },
    });
    await pending;
    store.stop();
  }
});
