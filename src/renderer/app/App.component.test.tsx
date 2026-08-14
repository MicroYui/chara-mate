import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentApi } from "../../shared/contracts/agent";
import type { AutomationApi } from "../../shared/contracts/automation";
import type {
  Chat,
  ChatApi,
  ChatDataSnapshot,
} from "../../shared/contracts/chat";
import type { CharaMateApi } from "../../shared/contracts/foundation";
import type {
  JourneyApi,
  JourneySnapshot,
} from "../../shared/contracts/journey";
import type {
  PetLibrarySnapshot,
  PetMainTarget,
} from "../../shared/contracts/pet";
import type {
  VoiceApi,
  VoiceSessionSnapshot,
} from "../../shared/contracts/voice";
import {
  chatDataSnapshotFixture,
  chatFixture,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
  runFixture,
} from "../../../tests/fixtures/foundationContracts";
import {
  starterTerritorySnapshot,
  starterTerritoryZoneView,
} from "../../../tests/fixtures/territoryWorld";
import { App } from "./App";

const CREATED_CHAT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTIVE_CHAT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PETS = [
  {
    description: "Directional v2 pet",
    displayName: "Columbinya",
    id: "columbinya",
    spriteHeight: 2288,
    spriteUrl: "chara-mate-pet://asset/columbinya/spritesheet.webp",
    spriteVersionNumber: 2 as const,
    spriteWidth: 1536,
  },
  {
    description: "Legacy v1 pet",
    displayName: "Linnea",
    id: "linnea",
    spriteHeight: 1872,
    spriteUrl: "chara-mate-pet://asset/linnea/spritesheet.webp",
    spriteVersionNumber: 1 as const,
    spriteWidth: 1536,
  },
] satisfies PetLibrarySnapshot["pets"];

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-foundation-ready");
  document.documentElement.removeAttribute("data-background-scheme");
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function renderApp({
  initialChats,
  initialJourneySnapshot = { journeys: [], sessions: [] },
  modelAvailable = false,
  seeded = false,
}: {
  readonly initialChats?: readonly Chat[];
  readonly initialJourneySnapshot?: JourneySnapshot;
  readonly modelAvailable?: boolean;
  readonly seeded?: boolean;
} = {}) {
  let chats: Chat[] = [...(initialChats ?? (seeded ? [chatFixture] : []))];
  let petLibrary: PetLibrarySnapshot = {
    activePetId: "columbinya",
    animationSpeed: 0.75,
    pets: PETS,
    scale: 1,
  };
  let petLibraryListener: ((snapshot: PetLibrarySnapshot) => void) | undefined;
  let petMainListener: ((target: PetMainTarget) => void) | undefined;
  let chatChangedListener: ((chat: Chat) => void) | undefined;
  let journeyChangedListener: ((snapshot: JourneySnapshot) => void) | undefined;
  let voiceChangedListener:
    ((snapshot: VoiceSessionSnapshot | null) => void) | undefined;
  const snapshots = new Map<string, ChatDataSnapshot>();
  for (const chat of chats) {
    snapshots.set(
      chat.id,
      seeded && chat.id === chatFixture.id
        ? chatDataSnapshotFixture
        : {
            approvals: [],
            attachments: [],
            chat,
            messages: [],
            runItems: [],
            runs: [],
          },
    );
  }
  const markRendererReady = vi.fn();
  const setTerritoryActive = vi.fn();
  const listProfiles = vi.fn().mockResolvedValue({
    ok: true,
    value: modelAvailable
      ? [
          {
            apiStyle: "openai-compatible" as const,
            baseUrl: "https://example.test/v1",
            chatModel: "gpt-chat",
            createdAt: FIXTURE_TIMESTAMPS.created,
            hasApiKey: true,
            id: FIXTURE_IDS.provider,
            name: "Test Provider",
            updatedAt: FIXTURE_TIMESTAMPS.updated,
          },
        ]
      : [],
  });
  const create = vi.fn<ChatApi["create"]>((request) => {
    const chat: Chat = {
      createdAt: FIXTURE_TIMESTAMPS.created,
      id: CREATED_CHAT_ID,
      status: "active",
      title: request.title ?? request.initialMessage ?? "新对话",
      updatedAt: FIXTURE_TIMESTAMPS.created,
    };
    chats = [chat, ...chats];
    snapshots.set(chat.id, {
      approvals: [],
      attachments: [],
      chat,
      messages: [],
      runItems: [],
      runs: [],
    });
    return Promise.resolve({ ok: true as const, value: chat });
  });
  const update = (chat: Chat) => {
    chats = chats.map((candidate) =>
      candidate.id === chat.id ? chat : candidate,
    );
    const snapshot = snapshots.get(chat.id);
    if (snapshot) snapshots.set(chat.id, { ...snapshot, chat });
    return { ok: true as const, value: chat };
  };
  const findChat = (chatId: string) => {
    const chat = chats.find(({ id }) => id === chatId);
    if (!chat) throw new Error(`Missing test Chat ${chatId}`);
    return chat;
  };
  const start = vi.fn<AgentApi["start"]>(() =>
    Promise.resolve({
      ok: true as const,
      value: { ...runFixture, chatId: CREATED_CHAT_ID },
    }),
  );
  const voiceStart = vi.fn<VoiceApi["start"]>().mockResolvedValue({
    error: {
      code: "PROVIDER.UNREACHABLE",
      message: "暂时无法连接 Realtime。",
      retryable: true,
    },
    ok: false,
  });
  const voiceEnd = vi.fn<VoiceApi["end"]>().mockImplementation(() => {
    voiceChangedListener?.(null);
    return Promise.resolve({ ok: true, value: null });
  });
  const automationList = vi.fn<AutomationApi["list"]>().mockResolvedValue({
    ok: true,
    value: { items: [] },
  });
  const desktopApi: CharaMateApi = {
    activity: {
      cleanup: vi.fn(),
      deleteEpisode: vi.fn(),
      getEpisode: vi.fn(),
      getSnapshot: vi.fn(),
      setPaused: vi.fn(),
      updateEpisode: vi.fn(),
    },
    automations: {
      create: vi.fn(),
      get: vi.fn(),
      list: automationList,
      runNow: vi.fn(),
      setPaused: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      update: vi.fn(),
    },
    agent: {
      cancel: vi.fn<AgentApi["cancel"]>(),
      getPendingApproval: vi.fn<AgentApi["getPendingApproval"]>(),
      resolveApproval: vi.fn<AgentApi["resolveApproval"]>(),
      resolveUserInput: vi.fn<AgentApi["resolveUserInput"]>(),
      resume: vi.fn<AgentApi["resume"]>(),
      start,
      steer: vi.fn<AgentApi["steer"]>(),
      subscribeOpenApproval: vi.fn<AgentApi["subscribeOpenApproval"]>(
        () => () => undefined,
      ),
    },
    chat: {
      archive: vi.fn<ChatApi["archive"]>(({ chatId }) => {
        const chat = findChat(chatId);
        return Promise.resolve(
          update({
            ...chat,
            archivedAt: FIXTURE_TIMESTAMPS.updated,
            status: "archived",
            updatedAt: FIXTURE_TIMESTAMPS.updated,
          }),
        );
      }),
      create,
      delete: vi.fn<ChatApi["delete"]>(({ chatId }) => {
        chats = chats.filter(({ id }) => id !== chatId);
        snapshots.delete(chatId);
        return Promise.resolve({ ok: true as const, value: { chatId } });
      }),
      getSnapshot: vi.fn<ChatApi["getSnapshot"]>(({ chatId }) =>
        Promise.resolve({
          ok: true as const,
          value: snapshots.get(chatId) ?? null,
        }),
      ),
      list: vi.fn<ChatApi["list"]>(({ query = "", status }) =>
        Promise.resolve({
          ok: true as const,
          value: chats.filter(
            (chat) =>
              chat.status === status &&
              chat.title.toLowerCase().includes(query.trim().toLowerCase()),
          ),
        }),
      ),
      rename: vi.fn<ChatApi["rename"]>(({ chatId, title }) =>
        Promise.resolve(update({ ...findChat(chatId), title })),
      ),
      restore: vi.fn<ChatApi["restore"]>(({ chatId }) => {
        const chat = { ...findChat(chatId) };
        delete chat.archivedAt;
        return Promise.resolve(update({ ...chat, status: "active" }));
      }),
      setPinned: vi.fn<ChatApi["setPinned"]>(({ chatId, pinned }) => {
        const current = findChat(chatId);
        if (pinned) {
          return Promise.resolve(
            update({
              ...current,
              pinnedAt: FIXTURE_TIMESTAMPS.updated,
            }),
          );
        }
        const chat = { ...current };
        delete chat.pinnedAt;
        return Promise.resolve(update(chat));
      }),
      subscribeChanged: vi.fn<ChatApi["subscribeChanged"]>((listener) => {
        chatChangedListener = listener;
        return () => {
          chatChangedListener = undefined;
        };
      }),
    },
    extensions: {
      mcpDelete: vi.fn(),
      mcpList: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      mcpRefresh: vi.fn(),
      mcpSave: vi.fn(),
      skillArchive: vi.fn(),
      skillDelete: vi.fn(),
      skillGet: vi.fn(),
      skillHistory: vi.fn(),
      skillList: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      skillRefresh: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      skillRestore: vi.fn(),
      skillSave: vi.fn(),
      skillSetEnabled: vi.fn(),
      skillSetPinned: vi.fn(),
    },
    evolution: {
      acceptCandidate: vi.fn(),
      archiveCandidate: vi.fn(),
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: { candidates: [], reviews: [] },
      }),
      rejectCandidate: vi.fn(),
      restoreCandidate: vi.fn(),
      retryReplay: vi.fn(),
      retryReview: vi.fn(),
      setCandidatePinned: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      updateCandidate: vi.fn(),
    },
    files: {
      getPathForFile: vi.fn(() => "/tmp/test-attachment"),
    },
    foundation: {
      getSnapshot: vi.fn().mockResolvedValue({
        appName: "CharaMate",
        appVersion: "0.1.0",
        databaseRoundTrip: true,
        electronVersion: "43.2.0",
        nodeVersion: "24.13.0",
        platform: "darwin",
      }),
      markRendererReady,
    },
    journey: {
      getSnapshot: vi.fn().mockResolvedValue({
        ok: true,
        value: initialJourneySnapshot,
      }),
      subscribeChanged: vi.fn<JourneyApi["subscribeChanged"]>((listener) => {
        journeyChangedListener = listener;
        return () => {
          if (journeyChangedListener === listener) {
            journeyChangedListener = undefined;
          }
        };
      }),
    },
    memory: {
      acceptCandidate: vi.fn(),
      archive: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      purge: vi.fn(),
      rejectCandidate: vi.fn(),
      restore: vi.fn(),
      revise: vi.fn(),
      setPinned: vi.fn(),
    },
    pet: {
      getLibrary: vi.fn(() =>
        Promise.resolve({ ok: true as const, value: petLibrary }),
      ),
      importFromFolder: vi.fn(),
      select: vi.fn(),
      setAnimationSpeed: vi.fn(),
      setScale: vi.fn(),
      setTerritoryActive,
      subscribeChanged: vi.fn(
        (listener: (snapshot: PetLibrarySnapshot) => void) => {
          petLibraryListener = listener;
          return () => {
            if (petLibraryListener === listener) petLibraryListener = undefined;
          };
        },
      ),
      subscribeOpenMain: vi.fn((listener: (target: PetMainTarget) => void) => {
        petMainListener = listener;
        return () => {
          if (petMainListener === listener) petMainListener = undefined;
        };
      }),
      subscribeOpenConversation: vi.fn(() => () => undefined),
    },
    provider: {
      deleteProfile: vi.fn(),
      discoverModels: vi.fn(),
      listProfiles,
      saveProfile: vi.fn(),
      testConnection: vi.fn(),
    },
    runEvents: {
      replay: ({ afterSequence, streamId }) =>
        Promise.resolve({
          events: [],
          latestSequence: afterSequence,
          streamId,
        }),
      subscribe: () => () => undefined,
    },
    territory: {
      applyCandidate: vi.fn(),
      cancelCandidate: vi.fn(),
      commitChangeSet: vi.fn(),
      createCandidate: vi.fn(),
      createSourceCandidate: vi.fn(),
      editCandidate: vi.fn(),
      enterZone: vi.fn(),
      getSnapshot: vi.fn().mockResolvedValue({
        ok: true,
        value: starterTerritorySnapshot,
      }),
      getZoneView: vi.fn().mockResolvedValue({
        ok: true,
        value: starterTerritoryZoneView,
      }),
      movePet: vi.fn(),
      purgeInstance: vi.fn(),
      restoreRevision: vi.fn(),
      subscribeChanged: vi.fn(() => () => undefined),
    },
    settings: {
      getSnapshot: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          agent: {
            defaultApprovalMode: "request_approval",
            defaultMode: "chat",
            workingDirectory: "/workspace",
          },
          browserComputer: {
            accessibility: "unavailable",
            browser: "not_installed",
            profileDirectory: "/browser/profile",
            screenRecording: "unavailable",
          },
          voice: {
            inputMode: "hands_free",
            instructions: "使用自然、简洁的中文口语。",
            microphone: "granted",
            providerProfileId: FIXTURE_IDS.provider,
            voice: "verse",
          },
        },
      }),
      importBrowserCookies: vi.fn(),
      openManagedBrowser: vi.fn(),
      saveAgent: vi.fn(),
      saveVoice: vi.fn(),
    },
    voice: {
      end: voiceEnd,
      getActive: vi.fn().mockResolvedValue({ ok: true, value: null }),
      preview: vi.fn(),
      quickStart: vi.fn(),
      report: vi.fn(),
      setMuted: vi.fn(),
      setPaused: vi.fn(),
      start: voiceStart,
      subscribeChanged: vi.fn<VoiceApi["subscribeChanged"]>((listener) => {
        voiceChangedListener = listener;
        return () => {
          if (voiceChangedListener === listener)
            voiceChangedListener = undefined;
        };
      }),
      subscribeCommand: vi.fn(() => () => undefined),
    },
  };
  Object.defineProperty(window, "charaMate", {
    configurable: true,
    value: desktopApi,
  });

  render(<App />);
  return {
    automationList,
    create,
    emitChatChanged: (chat: Chat) => {
      update(chat);
      chatChangedListener?.(chat);
    },
    emitVoiceChanged: (snapshot: VoiceSessionSnapshot | null) =>
      voiceChangedListener?.(snapshot),
    listProfiles,
    markRendererReady,
    openMain: (target: PetMainTarget) => petMainListener?.(target),
    selectPet: (petId: string) => {
      petLibrary = { ...petLibrary, activePetId: petId };
      petLibraryListener?.(petLibrary);
    },
    start,
    setTerritoryActive,
    voiceEnd,
    voiceStart,
  };
}

describe("application shell", () => {
  it("shows the persisted Chat after validating runtime and reports readiness", async () => {
    const { markRendererReady } = renderApp({ seeded: true });

    expect(
      await screen.findByRole("heading", { name: chatFixture.title }),
    ).toBeVisible();
    expect(screen.getByTestId("foundation-status")).toHaveTextContent(
      "Electron 43.2.0",
    );
    await waitFor(() => {
      expect(markRendererReady).toHaveBeenCalledOnce();
    });
    const navigation = screen.getByRole("navigation", { name: "主要页面" });
    expect(within(navigation).getAllByRole("button")).toHaveLength(5);
    expect(
      within(navigation).getByRole("button", { name: "Territory" }),
    ).toBeVisible();
    expect(screen.queryByText("领地")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("img", { name: "Columbinya 桌宠缩略图" }),
    ).toHaveAttribute("style", expect.stringContaining("columbinya"));
    const settingsButton = screen.getByRole("button", { name: "Settings" });
    const collapseButton = screen.getByRole("button", { name: "折叠侧栏" });
    expect(settingsButton).toBeVisible();
    expect(settingsButton.parentElement).toBe(collapseButton.parentElement);
  });

  it("updates the CharaMate brand thumbnail with the selected pet", async () => {
    const { selectPet } = renderApp();
    await screen.findByRole("img", { name: "Columbinya 桌宠缩略图" });

    act(() => selectPet("linnea"));

    expect(
      await screen.findByRole("img", { name: "Linnea 桌宠缩略图" }),
    ).toHaveAttribute("style", expect.stringContaining("linnea"));
    expect(
      screen.queryByRole("img", { name: "Columbinya 桌宠缩略图" }),
    ).not.toBeInTheDocument();
  });

  it("hands desktop pet visibility to Territory only while that page is active", async () => {
    const { setTerritoryActive } = renderApp();
    await screen.findByRole("heading", { name: "新对话" });
    await waitFor(() => {
      expect(setTerritoryActive).toHaveBeenLastCalledWith({ active: false });
    });

    const navigation = screen.getByRole("navigation", { name: "主要页面" });
    fireEvent.click(
      within(navigation).getByRole("button", { name: "Territory" }),
    );
    await waitFor(() => {
      expect(setTerritoryActive).toHaveBeenLastCalledWith({ active: true });
    });

    fireEvent.click(within(navigation).getByRole("button", { name: "Memory" }));
    await waitFor(() => {
      expect(setTerritoryActive).toHaveBeenLastCalledWith({ active: false });
    });
  });

  it("keeps companionship state invisible while showing one natural presence hint", async () => {
    const homeChat: Chat = {
      ...chatFixture,
      id: "11111111-1111-4111-8111-111111111111",
      title: "毕业论文",
    };
    const ordinaryChat: Chat = {
      ...chatFixture,
      id: "22222222-2222-4222-8222-222222222222",
      title: "普通对话",
    };
    const journeyId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const journeySnapshot: JourneySnapshot = {
      activeSession: {
        chatId: homeChat.id,
        createdAt: FIXTURE_TIMESTAMPS.created,
        id: sessionId,
        journeyId,
        status: "active",
        title: "一起梳理研究问题",
        updatedAt: FIXTURE_TIMESTAMPS.updated,
      },
      journeys: [
        {
          createdAt: FIXTURE_TIMESTAMPS.created,
          currentPosition: "正在收窄研究问题",
          homeChatId: homeChat.id,
          id: journeyId,
          nextStep: "继续整理相关工作",
          purpose: "完成未来几个月的毕业论文",
          status: "active",
          title: "毕业论文",
          updatedAt: FIXTURE_TIMESTAMPS.updated,
        },
      ],
      sessions: [
        {
          chatId: homeChat.id,
          createdAt: FIXTURE_TIMESTAMPS.created,
          id: sessionId,
          journeyId,
          status: "active",
          title: "一起梳理研究问题",
          updatedAt: FIXTURE_TIMESTAMPS.updated,
        },
      ],
    };
    renderApp({
      initialChats: [ordinaryChat, homeChat],
      initialJourneySnapshot: journeySnapshot,
    });

    expect(
      await screen.findByRole("region", { name: "Mika 正在和你一起" }),
    ).toHaveTextContent("一起梳理研究问题");
    const chatList = screen.getByRole("region", { name: "会话列表" });
    expect(
      within(chatList).getByRole("button", { name: "毕业论文" }),
    ).toBeVisible();
    expect(
      within(chatList).getByRole("button", { name: "普通对话" }),
    ).toBeVisible();
    expect(chatList).not.toHaveTextContent(
      /同行中|待续共处|同行回望|Together Session|Journey/u,
    );
    expect(
      screen.queryByRole("button", { name: /暂停|结束|恢复|告一段落/u }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(
      screen.getByRole("region", { name: "Mika 正在和你一起" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "理解有误" }));
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(
      "我们现在一起做的不是「一起梳理研究问题」，实际是：",
    );
  });

  it("opens Automations and starts its one-page form from the header", async () => {
    const { automationList } = renderApp({ modelAvailable: true });
    await screen.findByRole("heading", { name: "新对话" });

    fireEvent.click(screen.getByRole("button", { name: "Automations" }));

    expect(
      await screen.findByRole("heading", { name: "按时提醒，也按时完成" }),
    ).toBeVisible();
    expect(automationList).toHaveBeenCalledOnce();
    const createButtons = screen.getAllByRole("button", { name: "新建任务" });
    fireEvent.click(createButtons[0]!);

    const form = screen.getByRole("region", { name: "新建定时任务" });
    expect(within(form).getByLabelText("模型")).toHaveTextContent(
      "gpt-chat · Test Provider",
    );
    expect(within(form).getByLabelText("角色")).toHaveTextContent("Mika");
  });

  it("routes Character menu requests to Chat or Character settings", async () => {
    const { openMain } = renderApp();
    await screen.findByRole("heading", { name: "新对话" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "界面背景" })).toBeVisible();

    act(() => openMain("chat"));
    expect(screen.getByRole("heading", { name: "新对话" })).toBeVisible();

    act(() => openMain("character"));
    expect(screen.getByRole("heading", { name: "桌面角色" })).toBeVisible();
  });

  it("keeps New Chat as a right-side draft until the first send", async () => {
    const { create } = renderApp();
    await screen.findByRole("heading", { name: "新对话" });

    fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
    expect(create).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("region", { name: "会话列表" })).queryByRole(
        "button",
        { name: "新对话" },
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "今天想从哪里开始？" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "聊聊今天发生的事" }));
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(
      "聊聊今天发生的事",
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toHaveAttribute(
      "title",
      "请先选择可用模型",
    );
  });

  it("ends the active Voice session before opening a new Chat draft", async () => {
    const { emitVoiceChanged, voiceEnd } = renderApp({ seeded: true });
    await screen.findByRole("heading", { name: chatFixture.title });
    act(() =>
      emitVoiceChanged({
        assistantTranscript: "",
        chatId: chatFixture.id,
        connectedAt: FIXTURE_TIMESTAMPS.updated,
        createdAt: FIXTURE_TIMESTAMPS.created,
        generation: 0,
        inputMode: "hands_free",
        muted: false,
        phase: "listening",
        sessionId: "20000000-0000-4000-8000-000000000001",
        userTranscript: "",
        voice: "verse",
      }),
    );
    await screen.findByRole("button", { name: "结束语音" });

    let finishEnd:
      ((value: Awaited<ReturnType<VoiceApi["end"]>>) => void) | undefined;
    voiceEnd.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishEnd = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "新建对话" }));

    await waitFor(() =>
      expect(voiceEnd).toHaveBeenCalledWith({
        sessionId: "20000000-0000-4000-8000-000000000001",
      }),
    );
    expect(
      screen.getByRole("heading", { name: chatFixture.title }),
    ).toBeVisible();

    act(() => {
      finishEnd?.({ ok: true, value: null });
    });
    expect(
      await screen.findByRole("heading", { name: "今天想从哪里开始？" }),
    ).toBeVisible();
  });

  it("keeps Voice bound to its original Chat while another Chat is browsed", async () => {
    const voiceChat: Chat = {
      ...chatFixture,
      id: ACTIVE_CHAT_ID,
      title: "桌宠语音 Chat",
    };
    const otherChat: Chat = {
      ...chatFixture,
      id: "20000000-0000-4000-8000-000000000099",
      title: "其他 Chat",
    };
    const { emitVoiceChanged } = renderApp({
      initialChats: [voiceChat, otherChat],
    });
    await screen.findByRole("heading", { name: voiceChat.title });
    act(() =>
      emitVoiceChanged({
        assistantTranscript: "",
        chatId: voiceChat.id,
        connectedAt: FIXTURE_TIMESTAMPS.updated,
        createdAt: FIXTURE_TIMESTAMPS.created,
        generation: 0,
        inputMode: "hands_free",
        muted: false,
        phase: "listening",
        sessionId: "20000000-0000-4000-8000-000000000001",
        userTranscript: "",
        voice: "verse",
      }),
    );
    await screen.findByRole("button", { name: "暂停语音" });

    fireEvent.click(
      within(screen.getByRole("region", { name: "会话列表" })).getByRole(
        "button",
        { name: otherChat.title },
      ),
    );

    expect(
      await screen.findByRole("heading", { name: otherChat.title }),
    ).toBeVisible();
    expect(screen.getByText("原 Voice Chat")).toBeVisible();
    act(() =>
      emitVoiceChanged({
        assistantTranscript: "",
        chatId: voiceChat.id,
        connectedAt: FIXTURE_TIMESTAMPS.updated,
        createdAt: FIXTURE_TIMESTAMPS.created,
        generation: 0,
        inputMode: "hands_free",
        muted: false,
        phase: "paused",
        sessionId: "20000000-0000-4000-8000-000000000001",
        userTranscript: "",
        voice: "verse",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: otherChat.title }),
    ).toBeVisible();
  });

  it("opens a new draft in Recent even when Archived is selected", async () => {
    const activeChat: Chat = {
      ...chatFixture,
      id: ACTIVE_CHAT_ID,
      title: "最近会话",
    };
    const archivedChat: Chat = {
      ...chatFixture,
      archivedAt: FIXTURE_TIMESTAMPS.updated,
      status: "archived",
    };
    const { create } = renderApp({ initialChats: [activeChat, archivedChat] });
    await screen.findByRole("heading", { name: activeChat.title });

    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    expect(
      await screen.findByRole("heading", { name: archivedChat.title }),
    ).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索会话" }), {
      target: { value: "不会匹配新对话" },
    });

    fireEvent.click(screen.getByRole("button", { name: "新建对话" }));

    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "最近" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("searchbox", { name: "搜索会话" })).toHaveValue("");
    expect(
      within(screen.getByRole("region", { name: "会话列表" })).queryByRole(
        "button",
        { name: "新对话" },
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "新对话" })).toBeVisible();
  });

  it("persists on first send, uses the first message fallback, then accepts the AI title", async () => {
    const { create, emitChatChanged, start } = renderApp({
      initialChats: [chatFixture],
      modelAvailable: true,
    });
    await screen.findByRole("heading", { name: chatFixture.title });
    await screen.findByRole("button", { name: "gpt-chat" });

    fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "帮我规划北京周末行程" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        initialMessage: "帮我规划北京周末行程",
      }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(
      within(screen.getByRole("region", { name: "会话列表" })).getByRole(
        "button",
        { name: "帮我规划北京周末行程" },
      ),
    ).toBeVisible();

    act(() =>
      emitChatChanged({
        createdAt: FIXTURE_TIMESTAMPS.created,
        id: CREATED_CHAT_ID,
        status: "active",
        title: "北京周末行程规划",
        updatedAt: FIXTURE_TIMESTAMPS.updated,
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "北京周末行程规划" }),
    ).toBeVisible();
  });

  it("opens the complete Chat action menu from a sidebar context click", async () => {
    const contextChat: Chat = {
      ...chatFixture,
      id: ACTIVE_CHAT_ID,
      title: "右键会话",
    };
    renderApp({ initialChats: [chatFixture, contextChat] });
    await screen.findByRole("heading", { name: chatFixture.title });

    const chatButton = within(
      screen.getByRole("region", { name: "会话列表" }),
    ).getByRole("button", { name: contextChat.title });
    fireEvent.contextMenu(chatButton, { clientX: 80, clientY: 120 });

    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "重命名" }),
    ).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: "置顶" })).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: "归档" })).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: "删除" })).toBeVisible();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名" }));
    expect(
      await screen.findByRole("textbox", { name: "会话标题" }),
    ).toHaveValue(contextChat.title);
  });

  it("switches the user-selected background without changing the page tree", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "新对话" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("radio", { name: /暖灰/u }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute(
        "data-background-scheme",
        "warm",
      );
    });
    expect(window.localStorage.getItem("chara-mate.background-scheme")).toBe(
      "warm",
    );
    expect(screen.getByRole("heading", { name: "界面背景" })).toBeVisible();
  });

  it("opens the integrated Provider settings from Models", async () => {
    const { listProfiles } = renderApp();
    await screen.findByRole("heading", { name: "新对话" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Models" }));

    expect(
      await screen.findByRole("heading", { name: "Provider 与模型" }),
    ).toBeVisible();
    expect(screen.getByText("还没有 Provider。")).toBeVisible();
    expect(listProfiles).toHaveBeenCalled();
  });

  it("offers a retry when Voice fails before creating a Realtime session", async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "AudioContext",
      class {
        state: AudioContextState = "suspended";

        close(): Promise<void> {
          this.state = "closed";
          return Promise.resolve();
        }

        async resume(): Promise<void> {
          this.state = "running";
          await resume();
        }
      },
    );
    const { create, voiceStart } = renderApp({ modelAvailable: true });
    await screen.findByRole("heading", { name: "新对话" });

    fireEvent.click(screen.getByRole("button", { name: "开始语音对话" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法连接 Realtime。",
    );
    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(voiceStart.mock.calls[0]?.[0]).not.toHaveProperty("inputMode");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(voiceStart).toHaveBeenCalledTimes(2));
    expect(resume).toHaveBeenCalledTimes(2);
    expect(voiceStart.mock.calls[1]?.[0]).not.toHaveProperty("inputMode");
  });
});
