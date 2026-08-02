import {
  useEffect,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";

import type { FoundationSnapshot } from "../../shared/contracts/foundation";
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
  const chatStore = useMemo(
    () =>
      new ChatDomainStore(
        window.charaMate.chat,
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
    const nextChat = chatDomain.chats.find(
      ({ status }) => status === uiState.chatListStatus,
    );
    if (uiState.activeChatId === null && nextChat) {
      dispatch({ chatId: nextChat.id, type: "chat.selected" });
    }
  }, [chatDomain.chats, uiState.activeChatId, uiState.chatListStatus]);

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

  const createChat = () => {
    dispatch({ type: "chat.new" });
    dispatch({ status: "active", type: "chat-list-status.changed" });
    dispatch({ query: "", type: "search.changed" });
    void chatStore
      .create()
      .then((chat) => dispatch({ chatId: chat.id, type: "chat.selected" }))
      .catch(() => undefined);
  };

  return (
    <AppShell
      activeChat={activeChat}
      backgroundScheme={backgroundScheme}
      chatDomain={chatDomain}
      dispatch={dispatch}
      foundation={foundation.snapshot}
      onChatArchive={(chatId) =>
        void chatStore
          .archive(chatId)
          .then(() => dispatch({ type: "chat.new" }))
          .catch(() => undefined)
      }
      onChatCreate={createChat}
      onChatDelete={(chatId) =>
        void chatStore
          .delete(chatId)
          .then(() => dispatch({ type: "chat.new" }))
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
    />
  );
}
