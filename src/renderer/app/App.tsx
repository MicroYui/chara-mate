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
import type {
  PetDescriptor,
  PetLibrarySnapshot,
} from "../../shared/contracts/pet";
import { chatsUiReducer, initialChatsUiState } from "../features/chats/state";
import { ChatDomainStore } from "../features/chats/chatStore";
import { projectChatSnapshot } from "../features/chats/projection";
import styles from "./App.module.css";
import { AppShell } from "./AppShell";
import {
  readBackgroundScheme,
  readSidebarCollapsed,
  writeBackgroundScheme,
  writeSidebarCollapsed,
  type BackgroundScheme,
} from "./appearance";

type FoundationState =
  | { readonly status: "loading" }
  | { readonly snapshot: FoundationSnapshot; readonly status: "ready" }
  | { readonly message: string; readonly status: "failed" };

export function App() {
  const [foundation, setFoundation] = useState<FoundationState>({
    status: "loading",
  });
  const [uiState, dispatch] = useReducer(chatsUiReducer, undefined, () => ({
    ...initialChatsUiState,
    sidebarCollapsed: readSidebarCollapsed(window.localStorage),
  }));
  const [backgroundScheme, setBackgroundScheme] = useState<BackgroundScheme>(
    () => readBackgroundScheme(window.localStorage),
  );
  const [petLibrary, setPetLibrary] = useState<PetLibrarySnapshot | null>(null);
  const [openCharacterSettingsToken, setOpenCharacterSettingsToken] =
    useState(0);
  const [approvalNavigation, setApprovalNavigation] =
    useState<ApprovalNavigationTarget | null>(null);
  const focusedApprovalId = useRef<string | undefined>(undefined);
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

  useEffect(() => chatStore.start(), [chatStore]);

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
          setOpenCharacterSettingsToken((token) => token + 1);
        }
      }),
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
  }, []);

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

  const createChat = () => {
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

  return (
    <AppShell
      activeChat={activeChat}
      activePet={activePet}
      petAnimationSpeed={petLibrary?.animationSpeed ?? 0.75}
      backgroundScheme={backgroundScheme}
      chatDomain={chatDomain}
      dispatch={dispatch}
      foundation={foundation.snapshot}
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
      onChatCreate={createChat}
      onChatDelete={(chatId) =>
        void chatStore
          .delete(chatId)
          .then(() => {
            if (uiState.activeChatId === chatId) {
              dispatch({ type: "chat.selection-cleared" });
            }
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
      state={uiState}
      onBackgroundSchemeChange={setBackgroundScheme}
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
      openCharacterSettingsToken={openCharacterSettingsToken}
    />
  );
}
