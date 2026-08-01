import { useEffect, useState } from "react";

import type { FoundationSnapshot } from "../../shared/contracts/foundation";
import styles from "./App.module.css";

type FoundationState =
  | { status: "loading" }
  | { status: "ready"; snapshot: FoundationSnapshot }
  | { status: "failed"; message: string };

export function App() {
  const [foundation, setFoundation] = useState<FoundationState>({
    status: "loading",
  });

  useEffect(() => {
    let active = true;

    void window.charaMate.foundation
      .getSnapshot()
      .then((snapshot) => {
        if (active) {
          setFoundation({ status: "ready", snapshot });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setFoundation({
            status: "failed",
            message: error instanceof Error ? error.message : "Unknown error",
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

  return (
    <main className={styles["canvas"]}>
      <section className={styles["card"]} aria-live="polite">
        <div className={styles["avatar"]} aria-hidden="true">
          C
        </div>
        <p className={styles["eyebrow"]}>CharaMate Greenfield</p>
        <h1>工程基线{foundation.status === "ready" ? "已就绪" : "启动中"}</h1>
        {foundation.status === "ready" ? (
          <p data-testid="foundation-status">
            Electron {foundation.snapshot.electronVersion} · SQLite
            已完成事务与重开读取
          </p>
        ) : null}
        {foundation.status === "failed" ? (
          <p className={styles["error"]} role="alert">
            {foundation.message}
          </p>
        ) : null}
      </section>
    </main>
  );
}
