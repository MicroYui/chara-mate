import { describe, expect, it, vi } from "vitest";

import type { ChatApi } from "../../../shared/contracts/chat";
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
    list: vi.fn<ChatApi["list"]>(() =>
      Promise.resolve({ ok: true as const, value: [chatFixture] }),
    ),
    rename,
    restore: vi.fn<ChatApi["restore"]>(() =>
      Promise.resolve({ ok: true as const, value: chatFixture }),
    ),
    setPinned: vi.fn<ChatApi["setPinned"]>(() =>
      Promise.resolve({ ok: true as const, value: chatFixture }),
    ),
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
  return {
    chatApi,
    emit: (event: RunEventEnvelope) => eventListener?.(event),
    providerApi,
    spies: { getSnapshot, rename, replay, subscribe },
    runEventsApi,
  };
}

describe("ChatDomainStore", () => {
  it("builds its projection from typed Chat and Provider snapshots", async () => {
    const { chatApi, providerApi, runEventsApi, spies } = createApis();
    const store = new ChatDomainStore(chatApi, providerApi, runEventsApi);
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
  });

  it("treats Run events as sequence notifications and reloads Main truth", async () => {
    const { chatApi, emit, providerApi, runEventsApi, spies } = createApis();
    const store = new ChatDomainStore(chatApi, providerApi, runEventsApi);
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

  it("surfaces mutation failures instead of swallowing them in the App", async () => {
    const { chatApi, providerApi, runEventsApi, spies } = createApis();
    spies.rename.mockResolvedValue({
      error: {
        code: "CHAT.STORAGE_FAILED",
        message: "无法保存会话。",
        retryable: true,
      },
      ok: false,
    });
    const store = new ChatDomainStore(chatApi, providerApi, runEventsApi);

    await expect(store.rename(chatFixture.id, "New title")).rejects.toThrow(
      "无法保存会话。",
    );
    expect(store.getState().error).toBe("无法保存会话。");
    store.clearError();
    expect(store.getState().error).toBeUndefined();
  });
});
