import { useEffect, useReducer, useState } from "react";

import type { FoundationSnapshot } from "../../shared/contracts/foundation";
import {
  chatsFixtureUiReducer,
  initialChatsFixtureUiState,
} from "../features/chats/state";
import styles from "./App.module.css";
import { AppShell } from "./AppShell";
import {
  readBackgroundScheme,
  writeBackgroundScheme,
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
  const [uiState, dispatch] = useReducer(
    chatsFixtureUiReducer,
    initialChatsFixtureUiState,
  );
  const [backgroundScheme, setBackgroundScheme] = useState<BackgroundScheme>(
    () => readBackgroundScheme(window.localStorage),
  );

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

  return (
    <AppShell
      backgroundScheme={backgroundScheme}
      dispatch={dispatch}
      foundation={foundation.snapshot}
      state={uiState}
      onBackgroundSchemeChange={setBackgroundScheme}
    />
  );
}
