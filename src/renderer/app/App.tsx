import {
  useEffect,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
  useRef,
} from "react";

import type { FoundationSnapshot } from "../../shared/contracts/foundation";
import type { ApprovalNavigationTarget } from "../../shared/contracts/agent";
import type { JourneySnapshot } from "../../shared/contracts/journey";
import type { PersonaLibrarySnapshot } from "../../shared/contracts/persona";
import { VOICE_CHAT_FALLBACK_TITLE } from "../../shared/contracts/voice";
import type {
  PetDescriptor,
  PetLibrarySnapshot,
} from "../../shared/contracts/pet";
import { chatsUiReducer, initialChatsUiState } from "../features/chats/state";
import { ChatDomainStore } from "../features/chats/chatStore";
import { projectChatSnapshot } from "../features/chats/projection";
import { VoiceStore } from "../features/voice/voiceStore";
import styles from "./App.module.css";
import { AppShell } from "./AppShell";
import {
  readBackgroundScheme,
  readCustomBackgroundColors,
  readSidebarCollapsed,
  readThemePreference,
  resolveThemePreference,
  writeBackgroundScheme,
  writeCustomBackgroundColors,
  writeSidebarCollapsed,
  writeThemePreference,
  type BackgroundScheme,
  type CustomBackgroundColors,
  type ThemePreference,
} from "./appearance";

type FoundationState =
  | { readonly status: "loading" }
  | { readonly snapshot: FoundationSnapshot; readonly status: "ready" }
  | { readonly message: string; readonly status: "failed" };

export function App() {
  const [foundation, setFoundation] = useState<FoundationState>({
    status: "loading",
  });
  const [foundationLoadAttempt, setFoundationLoadAttempt] = useState(0);
  const [uiState, dispatch] = useReducer(chatsUiReducer, undefined, () => ({
    ...initialChatsUiState,
    sidebarCollapsed: readSidebarCollapsed(window.localStorage),
  }));
  const [backgroundScheme, setBackgroundScheme] = useState<BackgroundScheme>(
    () => readBackgroundScheme(window.localStorage),
  );
  const [customBackgroundColors, setCustomBackgroundColors] =
    useState<CustomBackgroundColors>(() =>
      readCustomBackgroundColors(window.localStorage),
    );
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readThemePreference(window.localStorage),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [petLibrary, setPetLibrary] = useState<PetLibrarySnapshot | null>(null);
  const [personaLibrary, setPersonaLibrary] =
    useState<PersonaLibrarySnapshot | null>(null);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const [journeySnapshot, setJourneySnapshot] = useState<JourneySnapshot>({
    journeys: [],
    sessions: [],
  });
  const [journeyError, setJourneyError] = useState<string | null>(null);
  const [settingsSectionTarget, setSettingsSectionTarget] = useState<
    "appearance" | "character" | "models"
  >("appearance");
  const [approvalNavigation, setApprovalNavigation] =
    useState<ApprovalNavigationTarget | null>(null);
  const [territoryCandidateNavigation, setTerritoryCandidateNavigation] =
    useState<string | null>(null);
  const focusedApprovalId = useRef<string | undefined>(undefined);
  const openedVoiceChatId = useRef<string | null>(null);
  const routedTogetherSessionId = useRef<string | null>(null);
  const sendPending = useRef(false);
  const chatStore = useMemo(
    () =>
      new ChatDomainStore(
        window.charaMate.chat,
        window.charaMate.agent,
        window.charaMate.provider,
        window.charaMate.runEvents,
      ),
    [],
  );
  const chatDomain = useSyncExternalStore(
    chatStore.subscribe,
    chatStore.getState,
  );
  const voiceStore = useMemo(() => new VoiceStore(window.charaMate.voice), []);
  const voice = useSyncExternalStore(voiceStore.subscribe, voiceStore.getState);

  useEffect(() => chatStore.start(), [chatStore]);
  useEffect(() => voiceStore.startListening(), [voiceStore]);

  useEffect(() => {
    let active = true;
    let receivedChange = false;
    const unsubscribe = window.charaMate.persona.subscribeChanged(
      (snapshot) => {
        receivedChange = true;
        if (active) {
          setPersonaLibrary(snapshot);
          setPersonaError(null);
        }
      },
    );
    void window.charaMate.persona
      .getLibrary()
      .then((response) => {
        if (!active || receivedChange) return;
        if (response.ok) setPersonaLibrary(response.value);
        else setPersonaError(response.error.message);
      })
      .catch((error: unknown) => {
        if (active) {
          setPersonaError(
            error instanceof Error ? error.message : "无法读取当前 Persona。",
          );
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let receivedChange = false;
    const unsubscribe = window.charaMate.journey.subscribeChanged(
      (snapshot) => {
        receivedChange = true;
        if (active) setJourneySnapshot(snapshot);
      },
    );
    void window.charaMate.journey
      .getSnapshot()
      .then((response) => {
        if (!active || receivedChange) return;
        if (response.ok) setJourneySnapshot(response.value);
        else setJourneyError(response.error.message);
      })
      .catch((error: unknown) => {
        if (active) {
          setJourneyError(
            error instanceof Error ? error.message : "无法读取当前陪伴状态。",
          );
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const activeSession = journeySnapshot.activeSession;
    if (!activeSession) {
      routedTogetherSessionId.current = null;
      return;
    }
    if (routedTogetherSessionId.current === activeSession.id) return;
    routedTogetherSessionId.current = activeSession.id;
    if (activeSession.chatId !== uiState.activeChatId) {
      dispatch({ chatId: activeSession.chatId, type: "chat.selected" });
    }
  }, [journeySnapshot.activeSession, uiState.activeChatId]);

  useEffect(() => {
    let active = true;
    void window.charaMate.settings.getSnapshot().then((response) => {
      if (!active || !response.ok) return;
      dispatch({
        approvalMode: response.value.agent.defaultApprovalMode,
        mode: response.value.agent.defaultMode,
        type: "settings.defaults-loaded",
      });
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(
    () =>
      window.charaMate.pet.subscribeOpenMain((target) => {
        dispatch({
          page: target === "chat" ? "chats" : "settings",
          type: "page.selected",
        });
        if (target === "character") {
          setSettingsSectionTarget("character");
        }
      }),
    [],
  );

  useEffect(
    () =>
      window.charaMate.pet.subscribeOpenTerritoryCandidate(
        ({ candidateId }) => {
          setTerritoryCandidateNavigation(candidateId);
          dispatch({ page: "territory", type: "page.selected" });
        },
      ),
    [],
  );

  useEffect(() => {
    const active = uiState.activePage === "territory";
    window.charaMate.pet.setTerritoryActive({ active });
    return () => {
      if (active) window.charaMate.pet.setTerritoryActive({ active: false });
    };
  }, [uiState.activePage]);

  useEffect(
    () =>
      window.charaMate.pet.subscribeOpenConversation(({ chatId }) => {
        dispatch({ chatId, type: "chat.selected" });
        window.setTimeout(() => {
          document
            .querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')
            ?.focus();
        }, 0);
      }),
    [],
  );

  useEffect(
    () =>
      window.charaMate.pet.subscribeOpenComposerAttachments(
        ({ attachments }) => {
          dispatch({ page: "chats", type: "page.selected" });
          for (const attachment of attachments) {
            dispatch({
              attachment,
              type: "composer.attachment-added",
            });
          }
          window.setTimeout(() => {
            document
              .querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')
              ?.focus();
          }, 0);
        },
      ),
    [],
  );

  useEffect(
    () =>
      window.charaMate.agent.subscribeOpenApproval((target) => {
        setApprovalNavigation(target);
        dispatch({ target, type: "approval.focused" });
      }),
    [],
  );

  useEffect(() => {
    let active = true;
    let receivedChange = false;
    const unsubscribe = window.charaMate.pet.subscribeChanged((snapshot) => {
      receivedChange = true;
      if (active) setPetLibrary(snapshot);
    });

    void window.charaMate.pet
      .getLibrary()
      .then((response) => {
        if (active && !receivedChange && response.ok) {
          setPetLibrary(response.value);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;

    void window.charaMate.foundation
      .getSnapshot()
      .then((snapshot) => {
        if (active) {
          setFoundation({ snapshot, status: "ready" });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setFoundation({
            message: error instanceof Error ? error.message : "Unknown error",
            status: "failed",
          });
        }
      });

    return () => {
      active = false;
    };
  }, [foundationLoadAttempt]);

  useEffect(() => {
    if (foundation.status === "ready") {
      document.documentElement.dataset["foundationReady"] = "true";
      window.charaMate.foundation.markRendererReady();
    }
  }, [foundation.status]);

  useEffect(() => {
    document.documentElement.dataset["backgroundScheme"] = backgroundScheme;
    writeBackgroundScheme(window.localStorage, backgroundScheme);
  }, [backgroundScheme]);

  useEffect(() => {
    const root = document.documentElement;
    const values: ReadonlyArray<[string, string]> = [
      ["--custom-accent", customBackgroundColors.accent],
      ["--custom-canvas", customBackgroundColors.canvas],
      ["--custom-sidebar", customBackgroundColors.sidebar],
      ["--custom-surface", customBackgroundColors.surface],
    ];
    for (const [property, value] of values) {
      if (backgroundScheme === "custom")
        root.style.setProperty(property, value);
      else root.style.removeProperty(property);
    }
    writeCustomBackgroundColors(window.localStorage, customBackgroundColors);
  }, [backgroundScheme, customBackgroundColors]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (event: MediaQueryListEvent) =>
      setSystemPrefersDark(event.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const resolvedTheme = resolveThemePreference(
    themePreference,
    systemPrefersDark,
  );

  useEffect(() => {
    document.documentElement.dataset["theme"] = resolvedTheme;
    writeThemePreference(window.localStorage, themePreference);
  }, [resolvedTheme, themePreference]);

  useEffect(() => {
    writeSidebarCollapsed(window.localStorage, uiState.sidebarCollapsed);
  }, [uiState.sidebarCollapsed]);

  useEffect(() => {
    void chatStore.loadChats(uiState.chatListStatus, uiState.searchQuery);
  }, [chatStore, uiState.chatListStatus, uiState.searchQuery]);

  useEffect(() => {
    void chatStore.loadSnapshot(uiState.activeChatId);
  }, [chatStore, uiState.activeChatId]);

  useEffect(() => {
    if (
      !approvalNavigation ||
      focusedApprovalId.current === approvalNavigation.approvalId ||
      chatDomain.activeSnapshot?.chat.id !== approvalNavigation.chatId
    ) {
      return;
    }
    const target = document.getElementById(
      `approval-${approvalNavigation.approvalId}`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    focusedApprovalId.current = approvalNavigation.approvalId;
  }, [approvalNavigation, chatDomain.activeSnapshot]);

  useEffect(() => {
    const nextChat = chatDomain.chats.find(
      ({ status }) => status === uiState.chatListStatus,
    );
    if (uiState.activeChatId === null && !uiState.isDraftChat && nextChat) {
      dispatch({ chatId: nextChat.id, type: "chat.selected" });
    }
  }, [
    chatDomain.chats,
    uiState.activeChatId,
    uiState.chatListStatus,
    uiState.isDraftChat,
  ]);

  useEffect(() => {
    if (chatDomain.models.some(({ id }) => id === uiState.modelId)) {
      return;
    }
    dispatch({
      modelId:
        chatDomain.models.length === 1 ? chatDomain.models[0]?.id : undefined,
      type: "model.changed",
    });
  }, [chatDomain.models, uiState.modelId]);

  const hasActiveRun = Boolean(
    chatDomain.activeSnapshot?.runs.some(
      ({ status }) =>
        status === "queued" ||
        status === "running" ||
        status === "waiting_approval" ||
        status === "needs_input",
    ),
  );

  useEffect(() => {
    if (hasActiveRun && uiState.composerPhase === "idle") {
      dispatch({ phase: "running", type: "composer.phase-changed" });
    } else if (!hasActiveRun && uiState.composerPhase !== "idle") {
      dispatch({ phase: "idle", type: "composer.phase-changed" });
    }
  }, [hasActiveRun, uiState.composerPhase]);

  useEffect(() => {
    const chatId = voice.snapshot?.chatId;
    if (!chatId) {
      openedVoiceChatId.current = null;
      return;
    }
    if (openedVoiceChatId.current === chatId) return;
    openedVoiceChatId.current = chatId;
    if (chatId !== uiState.activeChatId) {
      dispatch({ chatId, type: "chat.selected" });
    }
  }, [uiState.activeChatId, voice.snapshot?.chatId]);

  if (foundation.status === "loading") {
    return (
      <main className={styles["startup"]} aria-live="polite">
        <span />
        <p>正在打开 CharaMate…</p>
      </main>
    );
  }

  if (foundation.status === "failed") {
    return (
      <main className={styles["startup"]} aria-live="polite">
        <h1>CharaMate 无法启动</h1>
        <p className={styles["error"]} role="alert">
          {foundation.message}
        </p>
        <button
          type="button"
          onClick={() => {
            setFoundation({ status: "loading" });
            setFoundationLoadAttempt((attempt) => attempt + 1);
          }}
        >
          重试启动
        </button>
      </main>
    );
  }

  const activeChat =
    chatDomain.activeSnapshot?.chat.id === uiState.activeChatId
      ? projectChatSnapshot(chatDomain.activeSnapshot)
      : undefined;
  const activePet: PetDescriptor | undefined = petLibrary?.pets.find(
    ({ id }) => id === petLibrary.activePetId,
  );

  const createChat = async () => {
    if (voice.starting || voice.snapshot) {
      const ended = await voiceStore.end();
      if (!ended) return;
    }
    dispatch({ type: "chat.new" });
  };

  const sendRun = async () => {
    const model = chatDomain.models.find(({ id }) => id === uiState.modelId);
    if (!model || sendPending.current) return;
    const content = uiState.draft.trim() || "请处理这些附件。";
    sendPending.current = true;
    dispatch({ phase: "running", type: "composer.phase-changed" });
    try {
      let chatId = uiState.activeChatId;
      if (!chatId) {
        const created = await chatStore.create(content);
        chatId = created.id;
        dispatch({ chatId, type: "chat.selected" });
      }
      await chatStore.submit({
        attachments: uiState.composerAttachments.map((attachment) => ({
          artifactId: attachment.id,
          ...(attachment.byteLength === undefined
            ? {}
            : { byteLength: attachment.byteLength }),
          displayName: attachment.displayName,
          kind:
            attachment.source === "folder"
              ? "directory"
              : attachment.source === "image" ||
                  attachment.source === "screenshot"
                ? "image"
                : "file",
          ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
          storageKey: attachment.storageKey,
        })),
        chatId,
        content,
        execution:
          uiState.mode === "chat"
            ? { mode: "chat" }
            : { approvalMode: uiState.approvalMode, mode: "agent" },
        providerProfileId: model.provider.profileId,
      });
      dispatch({ draft: "", type: "draft.changed" });
      for (const attachment of uiState.composerAttachments) {
        dispatch({
          attachmentId: attachment.id,
          type: "composer.attachment-removed",
        });
      }
    } catch {
      dispatch({ phase: "idle", type: "composer.phase-changed" });
    } finally {
      sendPending.current = false;
    }
  };

  const startVoice = async (retry = false) => {
    if (voice.starting || (voice.snapshot && !retry)) return;
    const model = chatDomain.models.find(({ id }) => id === uiState.modelId);
    if (!model) return;
    voiceStore.preparePlayback();
    let chatId = voice.snapshot?.chatId ?? uiState.activeChatId;
    if (!chatId) {
      const created = await chatStore.create(VOICE_CHAT_FALLBACK_TITLE);
      chatId = created.id;
      dispatch({ chatId, type: "chat.selected" });
    }
    await voiceStore.start({
      chatProviderProfileId: model.provider.profileId,
      chatId,
      execution:
        uiState.mode === "chat"
          ? { mode: "chat" }
          : { approvalMode: uiState.approvalMode, mode: "agent" },
      requestedAt: new Date().toISOString(),
    });
  };

  return (
    <AppShell
      activeChat={activeChat}
      activePet={activePet}
      petAnimationSpeed={petLibrary?.animationSpeed ?? 0.75}
      backgroundScheme={backgroundScheme}
      customBackgroundColors={customBackgroundColors}
      themePreference={themePreference}
      chatDomain={chatDomain}
      dispatch={dispatch}
      foundation={foundation.snapshot}
      focusTerritoryCandidateId={territoryCandidateNavigation}
      journeyError={journeyError}
      journeySnapshot={journeySnapshot}
      personaError={personaError}
      personaLibrary={personaLibrary}
      onChatArchive={(chatId) =>
        void chatStore
          .archive(chatId)
          .then(() => {
            if (uiState.activeChatId === chatId) {
              dispatch({ type: "chat.selection-cleared" });
            }
          })
          .catch(() => undefined)
      }
      onChatCreate={() => void createChat()}
      onChatDelete={(chatId) =>
        void chatStore
          .delete(chatId)
          .then(async () => {
            if (uiState.activeChatId === chatId) {
              dispatch({ type: "chat.selection-cleared" });
            }
            const response = await window.charaMate.journey.getSnapshot();
            if (response.ok) setJourneySnapshot(response.value);
            else setJourneyError(response.error.message);
          })
          .catch(() => undefined)
      }
      onChatRename={(chatId, title) =>
        void chatStore.rename(chatId, title).catch(() => undefined)
      }
      onChatRestore={(chatId) =>
        void chatStore
          .restore(chatId)
          .then((chat) => {
            dispatch({ status: "active", type: "chat-list-status.changed" });
            dispatch({ chatId: chat.id, type: "chat.selected" });
          })
          .catch(() => undefined)
      }
      onChatSetPinned={(chatId, pinned) =>
        void chatStore.setPinned(chatId, pinned).catch(() => undefined)
      }
      onClearChatError={() => chatStore.clearError()}
      onClearVoiceError={() => voiceStore.clearError()}
      onClearJourneyError={() => setJourneyError(null)}
      onClearPersonaError={() => setPersonaError(null)}
      state={uiState}
      onBackgroundSchemeChange={setBackgroundScheme}
      onCustomBackgroundColorsChange={setCustomBackgroundColors}
      onThemePreferenceChange={setThemePreference}
      onConfigureModels={() => {
        setSettingsSectionTarget("models");
        dispatch({ page: "settings", type: "page.selected" });
      }}
      onSettingsOpen={() => setSettingsSectionTarget("appearance")}
      onTerritoryCandidateFocusConsumed={() =>
        setTerritoryCandidateNavigation(null)
      }
      onProvidersChanged={() => void chatStore.refreshModels()}
      onAgentSettingsChanged={(settings) =>
        dispatch({
          approvalMode: settings.defaultApprovalMode,
          mode: settings.defaultMode,
          type: "settings.defaults-loaded",
        })
      }
      onResolveApproval={(approvalId, decision) =>
        void chatStore.resolveApproval(approvalId, decision)
      }
      onResolveUserInput={(runId, itemId, resolution) =>
        chatStore.resolveUserInput(runId, itemId, resolution)
      }
      onRunResume={(runId) =>
        void chatStore.resume(runId).catch(() => undefined)
      }
      onRunSend={() => void sendRun()}
      onRunStop={() => {
        const chatId = uiState.activeChatId;
        if (!chatId) return;
        dispatch({ phase: "stopping", type: "composer.phase-changed" });
        void chatStore.cancelActive(chatId).catch(() => undefined);
      }}
      onVoiceEnd={() => void voiceStore.end()}
      onVoiceMutedChange={(muted) => void voiceStore.setMuted(muted)}
      onVoicePausedChange={(paused) => void voiceStore.setPaused(paused)}
      onVoiceRetry={() => void startVoice(true)}
      onVoiceStart={() => void startVoice()}
      settingsSectionTarget={settingsSectionTarget}
      voiceSnapshot={voice.snapshot}
      voiceStore={voiceStore}
      voiceError={voice.error}
    />
  );
}
