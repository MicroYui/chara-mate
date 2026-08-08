import { useCallback, useEffect, useState } from "react";

import type {
  BrowserComputerSettings,
  SettingsApi,
} from "../../../shared/contracts/settings";
import styles from "./CapabilitySettingsPanel.module.css";

const labels = {
  denied: "未授权",
  granted: "已授权",
  not_determined: "尚未决定",
  restricted: "受系统限制",
  unavailable: "当前平台不可用",
} as const;

export function BrowserComputerSettingsPanel({
  api = window.charaMate.settings,
}: {
  readonly api?: SettingsApi;
}) {
  const [snapshot, setSnapshot] = useState<BrowserComputerSettings>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const response = await api.getSnapshot();
    if (response.ok) setSnapshot(response.value.browserComputer);
    else setError(response.error.message);
  }, [api]);

  useEffect(() => {
    let active = true;
    void api.getSnapshot().then((response) => {
      if (!active) return;
      if (response.ok) setSnapshot(response.value.browserComputer);
      else setError(response.error.message);
    });
    return () => {
      active = false;
    };
  }, [api]);

  const run = async (
    operation: () => ReturnType<SettingsApi["openManagedBrowser"]>,
  ) => {
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const response = await operation();
      if (response.ok) {
        setFeedback(response.value.message);
        await refresh();
      } else setError(response.error.message);
    } catch {
      setError("浏览器操作没有完成。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles["panel"]}>
      <header className={styles["header"]}>
        <p className={styles["eyebrow"]}>Browser &amp; Computer</p>
        <h2>受管浏览器与系统能力</h2>
        <p>浏览器使用独立 Profile；系统权限仍由 macOS 原生设置管理。</p>
      </header>
      <div className={styles["section"]}>
        <div className={styles["statusRow"]}>
          <div>
            <h3>Managed Chromium</h3>
            <p>{snapshot?.profileDirectory ?? "正在读取 Profile…"}</p>
          </div>
          <span className={styles["status"]}>
            {snapshot?.browser === "open"
              ? "已打开"
              : snapshot?.browser === "ready"
                ? "可用"
                : "尚未安装"}
          </span>
        </div>
        <div className={styles["actions"]}>
          <button
            disabled={busy || snapshot?.browser === "not_installed"}
            type="button"
            onClick={() => void run(() => api.openManagedBrowser())}
          >
            打开浏览器
          </button>
          <button
            disabled={busy || snapshot?.browser === "not_installed"}
            type="button"
            onClick={() => void run(() => api.importBrowserCookies())}
          >
            导入 Cookie JSON
          </button>
        </div>
      </div>
      <div className={styles["section"]}>
        <h3>macOS 权限状态</h3>
        <p>
          Accessibility：{snapshot ? labels[snapshot.accessibility] : "读取中"}
        </p>
        <p>
          Screen Recording：
          {snapshot ? labels[snapshot.screenRecording] : "读取中"}
        </p>
      </div>
      <p className={styles["form"]} role={error ? "alert" : "status"}>
        {error ?? feedback}
      </p>
    </section>
  );
}
