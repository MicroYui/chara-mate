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
  PetComposerAttachments,
  PetLibrarySnapshot,
  PetMainTarget,
  PetTerritoryCandidateNavigation,
} from "../../shared/contracts/pet";
import type {
  PersonaApi,
  PersonaLibrarySnapshot,
} from "../../shared/contracts/persona";
import type {
  ProviderApi,
  ProviderProfile,
} from "../../shared/contracts/provider";
import type {
  VoiceApi,
  VoiceSessionSnapshot,
} from "../../shared/contracts/voice";
import {
  chatDataSnapshotFixture,
  chatFixture,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
  personaSnapshotFixture,
  runFixture,
} from "../../../tests/fixtures/foundationContracts";
import {
  starterTerritorySnapshot,
  starterTerritoryZoneView,
} from "../../../tests/fixtures/territoryWorld";
import { App } from "./App";

vi.mock("../features/territory/PixiTerritoryWorldCanvas", () => ({
  PixiTerritoryWorldCanvas: () => <div data-testid="world-canvas" />,
}));

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
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-foundation-ready");
  document.documentElement.removeAttribute("data-background-scheme");
  document.documentElement.removeAttribute("data-theme");
  for (const property of [
    "--custom-accent",
    "--custom-canvas",
    "--custom-sidebar",
    "--custom-surface",
  ]) {
    document.documentElement.style.removeProperty(property);
  }
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function renderApp({
  initialChats,
  initialJourneySnapshot = { journeys: [], sessions: [] },
  modelAvailable = false,
  profiles,
  providerList,
  seeded = false,
}: {
  readonly initialChats?: readonly Chat[];
  readonly initialJourneySnapshot?: JourneySnapshot;
  readonly modelAvailable?: boolean;
  readonly profiles?: readonly ProviderProfile[];
  readonly providerList?: ProviderApi["listProfiles"];
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
  let personaLibrary: PersonaLibrarySnapshot = {
    activePersonaId: personaSnapshotFixture.personaId,
    personas: [
      {
        createdAt: FIXTURE_TIMESTAMPS.created,
        kind: "preset",
        snapshot: personaSnapshotFixture,
        updatedAt: FIXTURE_TIMESTAMPS.updated,
      },
    ],
  };
  let personaLibraryListener:
    ((snapshot: PersonaLibrarySnapshot) => void) | undefined;
  let petMainListener: ((target: PetMainTarget) => void) | undefined;
  let petComposerAttachmentsListener:
    ((target: PetComposerAttachments) => void) | undefined;
  let petTerritoryCandidateListener:
    ((target: PetTerritoryCandidateNavigation) => void) | undefined;
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
  const listProfiles = vi.fn<ProviderApi["listProfiles"]>(
    providerList ??
      (() =>
        Promise.resolve({
          ok: true,
          value: profiles
            ? [...profiles]
            : modelAvailable
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
        })),
  );
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
  const cancelStart = vi.fn<AgentApi["cancelStart"]>(({ requestId }) =>
    Promise.resolve({
      ok: true,
      value: { requestId, outcome: "accepted" },
    }),
  );
  const cancel = vi.fn<AgentApi["cancel"]>();
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
      resolveEventReference: vi.fn(),
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
      cancelStart,
      cancel,
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
    companion: {
      getSnapshot: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { state: "unpaired" } }),
      setNotificationsEnabled: vi.fn(),
      startPairing: vi.fn(),
      subscribeChanged: vi.fn(() => () => undefined),
      unpair: vi.fn(),
    },
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
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
      dismissReview: vi.fn(),
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
    persona: {
      copy: vi.fn(),
      getLibrary: vi.fn().mockResolvedValue({
        ok: true,
        value: personaLibrary,
      }),
      select: vi.fn(),
      subscribeChanged: vi.fn<PersonaApi["subscribeChanged"]>((listener) => {
        personaLibraryListener = listener;
        return () => {
          if (personaLibraryListener === listener)
            personaLibraryListener = undefined;
        };
      }),
      update: vi.fn(),
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
      subscribeOpenComposerAttachments: vi.fn(
        (
          listener: Parameters<
            CharaMateApi["pet"]["subscribeOpenComposerAttachments"]
          >[0],
        ) => {
          petComposerAttachmentsListener = listener;
          return () => {
            if (petComposerAttachmentsListener === listener) {
              petComposerAttachmentsListener = undefined;
            }
          };
        },
      ),
      subscribeOpenConversation: vi.fn(() => () => undefined),
      subscribeOpenTerritoryCandidate: vi.fn(
        (
          listener: Parameters<
            CharaMateApi["pet"]["subscribeOpenTerritoryCandidate"]
          >[0],
        ) => {
          petTerritoryCandidateListener = listener;
          return () => {
            if (petTerritoryCandidateListener === listener) {
              petTerritoryCandidateListener = undefined;
            }
          };
        },
      ),
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
      subscribePetAction: vi.fn(() => () => undefined),
    },
    settings: {
      getDataSnapshot: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          categories: [
            {
              byteLength: 4096,
              id: "database",
              label: "对话与应用数据库",
            },
          ],
          dataDirectory: "/tmp/chara-mate",
          totalByteLength: 4096,
        },
      }),
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
          companionInitiative: {
            importantMomentOutreachEnabled: false,
            importantMomentOutreachPrompted: false,
            level: "balanced",
            quietHours: {
              enabled: true,
              endMinute: 8 * 60,
              startMinute: 22 * 60,
            },
            territoryMomentSurprisesEnabled: false,
            territoryMomentSurprisesPrompted: false,
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
      openDataDirectory: vi.fn(),
      openManagedBrowser: vi.fn(),
      saveAgent: vi.fn(),
      saveCompanionInitiative: vi.fn(),
      saveVoice: vi.fn(),
    },
    voice: {
      cancelStart: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { outcome: "accepted" } }),
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
    voiceWake: {
      getSnapshot: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          enabled: false,
          microphone: "granted",
          phase: "disabled",
          phrase: "Hi Mika",
        },
      }),
      setEnabled: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    },
  };
  Object.defineProperty(window, "charaMate", {
    configurable: true,
    value: desktopApi,
  });

  const view = render(<App />);
  return {
    automationList,
    cancel,
    cancelStart,
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
    openComposerAttachments: (target: PetComposerAttachments) =>
      petComposerAttachmentsListener?.(target),
    openTerritoryCandidate: (target: PetTerritoryCandidateNavigation) =>
      petTerritoryCandidateListener?.(target),
    selectPersona: (snapshot: PersonaLibrarySnapshot) => {
      personaLibrary = snapshot;
      personaLibraryListener?.(personaLibrary);
    },
    selectPet: (petId: string) => {
      petLibrary = { ...petLibrary, activePetId: petId };
      petLibraryListener?.(petLibrary);
    },
    start,
    setTerritoryActive,
    voiceEnd,
    voiceStart,
    unmount: view.unmount,
  };
}

const modelPreferenceKey = "chara-mate.chat-model";
const firstModelProfile: ProviderProfile = {
  apiStyle: "openai-compatible",
  baseUrl: "https://example.test/v1",
  chatModel: "gpt-chat",
  createdAt: FIXTURE_TIMESTAMPS.created,
  hasApiKey: true,
  id: FIXTURE_IDS.provider,
  name: "First Provider",
  updatedAt: FIXTURE_TIMESTAMPS.updated,
};
const secondModelProfile: ProviderProfile = {
  ...firstModelProfile,
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  name: "Second Provider",
  chatModel: "gpt-6-astra",
};

describe("application shell", () => {
  it("projects the active Persona into the sidebar", async () => {
    const { selectPersona } = renderApp();
    expect(await screen.findByText("元气开朗")).toBeVisible();

    act(() =>
      selectPersona({
        activePersonaId: personaSnapshotFixture.personaId,
        personas: [
          {
            createdAt: FIXTURE_TIMESTAMPS.created,
            kind: "custom",
            snapshot: {
              ...personaSnapshotFixture,
              displayName: "Lumi",
              styleName: "清醒温暖",
            },
            updatedAt: FIXTURE_TIMESTAMPS.updated,
          },
        ],
      }),
    );

    expect(await screen.findByText("Lumi")).toBeVisible();
    expect(screen.getByText("清醒温暖")).toBeVisible();
  });

  it("shows the persisted Chat after validating runtime and reports readiness", async () => {
    const { markRendererReady } = renderApp({ seeded: true });

    expect(
      await within(
        await screen.findByRole("region", { name: "会话列表" }),
      ).findByRole("button", { name: chatFixture.title }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "更多会话操作" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /归档会话|恢复会话/u }),
    ).not.toBeInTheDocument();
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
    await screen.findByRole("region", { name: "Chats" });
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

  it("opens Automations and starts its one-page form from the page", async () => {
    const { automationList } = renderApp({ modelAvailable: true });
    await screen.findByRole("region", { name: "Chats" });

    fireEvent.click(screen.getByRole("button", { name: "Automations" }));

    expect(
      await screen.findByRole("heading", { name: "按时提醒，也按时完成" }),
    ).toBeVisible();
    expect(automationList).toHaveBeenCalledOnce();
    const createButton = screen.getByRole("button", { name: "新建任务" });
    fireEvent.click(createButton);

    const form = screen.getByRole("region", { name: "新建定时任务" });
    expect(within(form).getByLabelText("模型")).toHaveTextContent(
      "gpt-chat · Test Provider",
    );
    expect(within(form).getByLabelText("角色")).toHaveTextContent("Mika");
  });

  it("routes Character menu requests to Chat or Character settings", async () => {
    const { openMain } = renderApp();
    await screen.findByRole("region", { name: "Chats" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "界面背景" })).toBeVisible();

    act(() => openMain("chat"));
    expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();

    act(() => openMain("character"));
    expect(screen.getByRole("heading", { name: "角色人格" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "桌面形象" })).toBeVisible();
  });

  it("opens Chats and prefills attachments dropped on the desktop pet", async () => {
    const { openComposerAttachments } = renderApp();
    await screen.findByRole("region", { name: "Chats" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    act(() =>
      openComposerAttachments({
        attachments: [
          {
            byteLength: 321,
            displayName: "sunset.jpg",
            id: "11111111-1111-4111-8111-111111111111",
            mediaType: "image/jpeg",
            source: "image",
            storageKey: "/tmp/sunset.jpg",
          },
        ],
      }),
    );

    expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
    expect(screen.getByLabelText("待发送附件")).toHaveTextContent("sunset.jpg");
  });

  it("keeps New Chat as a right-side draft until the first send", async () => {
    const { create } = renderApp();
    await screen.findByRole("region", { name: "Chats" });

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
    const chatButton = await within(
      await screen.findByRole("region", { name: "会话列表" }),
    ).findByRole("button", { name: chatFixture.title });
    act(() =>
      emitVoiceChanged({
        assistantTranscript: "",
        chatId: chatFixture.id,
        connectedAt: FIXTURE_TIMESTAMPS.updated,
        createdAt: FIXTURE_TIMESTAMPS.created,
        generation: 0,
        inputMode: "hands_free",
        muted: false,
        persona: personaSnapshotFixture,
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
    expect(chatButton).toHaveAttribute("data-active", "true");

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
    const chatList = await screen.findByRole("region", {
      name: "会话列表",
    });
    await within(chatList).findByRole("button", { name: voiceChat.title });
    act(() =>
      emitVoiceChanged({
        assistantTranscript: "",
        chatId: voiceChat.id,
        connectedAt: FIXTURE_TIMESTAMPS.updated,
        createdAt: FIXTURE_TIMESTAMPS.created,
        generation: 0,
        inputMode: "hands_free",
        muted: false,
        persona: personaSnapshotFixture,
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
      within(chatList).getByRole("button", { name: otherChat.title }),
    ).toHaveAttribute("data-active", "true");
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
        persona: personaSnapshotFixture,
        phase: "paused",
        sessionId: "20000000-0000-4000-8000-000000000001",
        userTranscript: "",
        voice: "verse",
      }),
    );
    expect(
      within(chatList).getByRole("button", { name: otherChat.title }),
    ).toHaveAttribute("data-active", "true");
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
    await within(
      await screen.findByRole("region", { name: "会话列表" }),
    ).findByRole("button", { name: activeChat.title });

    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    expect(
      await within(screen.getByRole("region", { name: "会话列表" })).findByRole(
        "button",
        { name: archivedChat.title },
      ),
    ).toHaveAttribute("data-active", "true");
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
    expect(
      screen.getByRole("heading", { name: "今天想从哪里开始？" }),
    ).toBeVisible();
  });

  it("persists on first send, uses the first message fallback, then accepts the AI title", async () => {
    const { create, emitChatChanged, start } = renderApp({
      initialChats: [chatFixture],
      modelAvailable: true,
    });
    await within(
      await screen.findByRole("region", { name: "会话列表" }),
    ).findByRole("button", { name: chatFixture.title });
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
      await within(screen.getByRole("region", { name: "会话列表" })).findByRole(
        "button",
        { name: "北京周末行程规划" },
      ),
    ).toBeVisible();
  });

  it("opens the complete Chat action menu from a sidebar context click", async () => {
    const contextChat: Chat = {
      ...chatFixture,
      id: ACTIVE_CHAT_ID,
      title: "右键会话",
    };
    renderApp({ initialChats: [chatFixture, contextChat] });
    await within(
      await screen.findByRole("region", { name: "会话列表" }),
    ).findByRole("button", { name: chatFixture.title });

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
    const titleInput = await screen.findByRole("textbox", {
      name: "会话标题",
    });
    expect(titleInput).toHaveValue(contextChat.title);
    expect(titleInput.closest("section")).toHaveAccessibleName("会话列表");
  });

  it("switches the user-selected background without changing the page tree", async () => {
    renderApp();
    await screen.findByRole("region", { name: "Chats" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "明暗主题" })).getByRole(
        "radio",
        { name: /^深色/u },
      ),
    );
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
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem("chara-mate.theme")).toBe("dark");
    expect(screen.getByRole("heading", { name: "界面背景" })).toBeVisible();
  });

  it("lets the user create and persist a custom background palette", async () => {
    renderApp();
    await screen.findByRole("region", { name: "Chats" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("radio", { name: /自定义/u }));
    fireEvent.change(screen.getByLabelText("画布颜色"), {
      target: { value: "#123456" },
    });

    await waitFor(() => {
      expect(document.documentElement).toHaveStyle({
        "--custom-canvas": "#123456",
      });
    });
    expect(window.localStorage.getItem("chara-mate.background-scheme")).toBe(
      "custom",
    );
    expect(
      JSON.parse(
        window.localStorage.getItem("chara-mate.custom-background") ?? "{}",
      ),
    ).toMatchObject({ canvas: "#123456" });
    expect(screen.getByRole("button", { name: "恢复默认颜色" })).toBeVisible();
  });

  it("opens the Data settings page with real usage information", async () => {
    renderApp();
    await screen.findByRole("region", { name: "Chats" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Data" }));

    expect(
      await screen.findByRole("heading", { name: "本地数据" }),
    ).toBeVisible();
    expect(screen.getAllByText("4.0 KB")).toHaveLength(2);
    expect(screen.getByText("/tmp/chara-mate")).toBeVisible();
  });

  it("opens Devices inside Settings without adding another primary page", async () => {
    renderApp();
    await screen.findByRole("region", { name: "Chats" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settingsNavigation = screen.getByLabelText("设置分类");
    const categories = within(settingsNavigation)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(categories.indexOf("Devices")).toBe(
      categories.indexOf("Browser & Computer") + 1,
    );
    expect(categories.indexOf("Skills")).toBe(
      categories.indexOf("Devices") + 1,
    );

    fireEvent.click(
      within(settingsNavigation).getByRole("button", { name: "Devices" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Android Companion" }),
    ).toBeVisible();
    expect(screen.getByText("尚未连接手机")).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
  });

  it("opens the exact Territory candidate requested by the pet", async () => {
    const { openTerritoryCandidate } = renderApp();
    await screen.findByRole("region", { name: "Chats" });

    act(() =>
      openTerritoryCandidate({
        candidateId: starterTerritorySnapshot.candidates[0]!.id,
      }),
    );

    expect(await screen.findByText("AI 创作台")).toBeVisible();
    expect(screen.getByText("正在预览 AI 变更")).toBeVisible();
  });

  it("keeps the saved preference while the first list is pending, then restores it", async () => {
    const selected = `${secondModelProfile.id}::gpt-6-astra`;
    window.localStorage.setItem(modelPreferenceKey, selected);
    let resolve!: (
      value: Awaited<ReturnType<ProviderApi["listProfiles"]>>,
    ) => void;
    renderApp({
      providerList: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await screen.findByRole("region", { name: "Chats" });
    expect(window.localStorage.getItem(modelPreferenceKey)).toBe(selected);
    await act(() => {
      resolve({ ok: true, value: [firstModelProfile, secondModelProfile] });
      return Promise.resolve();
    });
    expect(
      await screen.findByRole("button", { name: "gpt-6-astra" }),
    ).toBeVisible();
    expect(window.localStorage.getItem(modelPreferenceKey)).toBe(selected);
  });

  it("persists an explicit choice and restores it on a new App mount without another selection", async () => {
    const profiles = [firstModelProfile, secondModelProfile];
    const first = renderApp({ profiles });
    const menu = await screen.findByRole("button", { name: "Model" });
    expect(window.localStorage.getItem(modelPreferenceKey)).toBeNull();
    fireEvent.pointerDown(menu, { button: 0, ctrlKey: false });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "gpt-6-astraSecond Provider",
      }),
    );
    expect(window.localStorage.getItem(modelPreferenceKey)).toBe(
      `${secondModelProfile.id}::gpt-6-astra`,
    );
    first.unmount();
    const second = renderApp({ profiles });
    expect(
      await screen.findByRole("button", { name: "gpt-6-astra" }),
    ).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "重开后继续聊" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(second.start).toHaveBeenCalledWith(
        expect.objectContaining({ providerProfileId: secondModelProfile.id }),
      ),
    );
  });

  it("does not erase the preference when model loading fails even though Chats opens", async () => {
    const selected = `${secondModelProfile.id}::gpt-6-astra`;
    window.localStorage.setItem(modelPreferenceKey, selected);
    const first = renderApp({
      providerList: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: "PROVIDER.UNREACHABLE",
            message: "模型列表暂时不可用",
            retryable: true,
          },
        }),
    });
    await screen.findByRole("region", { name: "Chats" });
    await act(() => Promise.resolve());
    expect(window.localStorage.getItem(modelPreferenceKey)).toBe(selected);
    first.unmount();
    renderApp({ profiles: [firstModelProfile, secondModelProfile] });
    expect(
      await screen.findByRole("button", { name: "gpt-6-astra" }),
    ).toBeVisible();
  });

  it("clears a removed choice after success without guessing among remaining models", async () => {
    window.localStorage.setItem(
      modelPreferenceKey,
      "removed-provider::old-model",
    );
    renderApp({ profiles: [firstModelProfile, secondModelProfile] });
    expect(await screen.findByRole("button", { name: "Model" })).toBeVisible();
    await waitFor(() =>
      expect(window.localStorage.getItem(modelPreferenceKey)).toBeNull(),
    );
  });

  it("uses the existing single-model rule when the configured model has changed", async () => {
    window.localStorage.setItem(
      modelPreferenceKey,
      `${secondModelProfile.id}::old-model`,
    );
    renderApp({ profiles: [secondModelProfile] });
    expect(
      await screen.findByRole("button", { name: "gpt-6-astra" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(window.localStorage.getItem(modelPreferenceKey)).toBe(
        `${secondModelProfile.id}::gpt-6-astra`,
      ),
    );
  });

  it("clears an unavailable saved choice only when an empty list actually succeeds", async () => {
    window.localStorage.setItem(
      modelPreferenceKey,
      `${secondModelProfile.id}::gpt-6-astra`,
    );
    renderApp({ profiles: [] });
    await screen.findByRole("region", { name: "Chats" });
    await waitFor(() =>
      expect(window.localStorage.getItem(modelPreferenceKey)).toBeNull(),
    );
  });

  it("keeps a newly selected model usable when persisting the preference fails", async () => {
    const setItem = Storage.prototype.setItem.bind(window.localStorage);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
      if (key === modelPreferenceKey) throw new Error("storage full");
      setItem(key, value);
    });
    const { start } = renderApp({
      profiles: [firstModelProfile, secondModelProfile],
    });
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Model" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "gpt-6-astraSecond Provider",
      }),
    );
    expect(screen.getByRole("button", { name: "gpt-6-astra" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "仍用这次选择" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ providerProfileId: secondModelProfile.id }),
      ),
    );
  });

  it("restores Provider identity for equal model names without changing a historical Run", async () => {
    const duplicateName = { ...secondModelProfile, chatModel: "gpt-chat" };
    window.localStorage.setItem(
      modelPreferenceKey,
      `${duplicateName.id}::gpt-chat`,
    );
    const { start } = renderApp({
      profiles: [firstModelProfile, duplicateName],
      seeded: true,
    });
    await screen.findByRole("button", { name: "gpt-chat" });
    fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "新对话保留这个Provider" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ providerProfileId: duplicateName.id }),
      ),
    );
    const historical = await window.charaMate.chat.getSnapshot({
      chatId: chatFixture.id,
    });
    expect(historical).toEqual({ ok: true, value: chatDataSnapshotFixture });
  });

  it("opens the integrated Provider settings from Models", async () => {
    const { listProfiles } = renderApp();
    await screen.findByRole("region", { name: "Chats" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Models" }));

    expect(
      await screen.findByRole("heading", { name: "Provider 与模型" }),
    ).toBeVisible();
    expect(screen.getByText("还没有 Provider。")).toBeVisible();
    expect(listProfiles).toHaveBeenCalled();
  });

  it("guides a first-time user from Chats to model configuration", async () => {
    const { listProfiles } = renderApp();
    await screen.findByRole("region", { name: "Chats" });

    expect(screen.getByRole("region", { name: "配置模型" })).toBeVisible();
    expect(screen.getByRole("button", { name: "录入语音" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "前往 Models" }));

    expect(
      await screen.findByRole("heading", { name: "Provider 与模型" }),
    ).toBeVisible();
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
    await screen.findByRole("region", { name: "Chats" });

    fireEvent.click(screen.getByRole("button", { name: "开始语音对话" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法连接 Realtime。",
    );
    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(voiceStart.mock.calls[0]?.[0].request).not.toHaveProperty(
      "inputMode",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(voiceStart).toHaveBeenCalledTimes(2));
    expect(resume).toHaveBeenCalledTimes(2);
    expect(voiceStart.mock.calls[1]?.[0].request).not.toHaveProperty(
      "inputMode",
    );
  });
});

describe("unallocated submission controls", () => {
  it("keeps Stop available until the unallocated ordinary submission settles", async () => {
    const { start } = renderApp({
      initialChats: [chatFixture],
      modelAvailable: true,
    });
    await screen.findByRole("button", { name: "gpt-chat" });
    let release!: (value: Awaited<ReturnType<AgentApi["start"]>>) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    start.mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "先准备这条消息。" },
    });
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        await started;
      });
      expect(screen.getByRole("button", { name: "停止" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(
        "先准备这条消息。",
      );
    } finally {
      await act(() => {
        release({
          ok: false,
          error: {
            code: "AGENT.RUNTIME_FAILED",
            message: "离线 fixture 收口",
            retryable: false,
          },
        });
        return Promise.resolve();
      });
    }
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(
      "先准备这条消息。",
    );
  });
});

it("stops an unallocated submission using the actual Renderer request identity", async () => {
  const { cancel, cancelStart, start } = renderApp({
    initialChats: [chatFixture],
    modelAvailable: true,
  });
  await screen.findByRole("button", { name: "gpt-chat" });
  let release!: (value: Awaited<ReturnType<AgentApi["start"]>>) => void;
  start.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  cancelStart.mockImplementation(({ requestId }) => {
    release({
      ok: false,
      error: {
        code: "AGENT.PREPARATION_CANCELLED",
        message: "已停止准备",
        retryable: false,
      },
    });
    return Promise.resolve({
      ok: true,
      value: { requestId, outcome: "accepted" },
    });
  });
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
    target: { value: "等待中的内容" },
  });
  await act(() => {
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    return Promise.resolve();
  });
  await act(() => {
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    return Promise.resolve();
  });
  expect(cancelStart).toHaveBeenCalledWith({
    requestId: start.mock.calls[0]![0].requestId,
    requestedAt: expect.any(String) as string,
  });
  expect(cancel).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(
    "等待中的内容",
  );
  expect(screen.getByRole("button", { name: "发送" })).toBeVisible();
});

it("waits for first Chat creation after Stop and never submits a new Run", async () => {
  const { cancelStart, create, start } = renderApp({ modelAvailable: true });
  await screen.findByRole("button", { name: "gpt-chat" });
  const original = create.getMockImplementation()!;
  let release!: () => void;
  create.mockImplementation(async (input) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original(input);
  });
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
    target: { value: "建 Chat 期间停止" },
  });
  await act(() => {
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    return Promise.resolve();
  });
  try {
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(start).not.toHaveBeenCalled();
    expect(cancelStart).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "正在停止" })).toBeVisible();
  } finally {
    await act(() => {
      release();
      return Promise.resolve();
    });
  }
  expect(start).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(
    "建 Chat 期间停止",
  );
  expect(screen.getByRole("button", { name: "发送" })).toBeVisible();
});
