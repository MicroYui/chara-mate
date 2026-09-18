import {
  Accessibility,
  MonitorUp,
  PanelsTopLeft,
  RefreshCw,
} from "lucide-react";
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

type PermissionStatus = BrowserComputerSettings["accessibility"];

function statusTone(status: PermissionStatus | undefined): string {
  if (status === "granted") return "positive";
  if (status === "denied" || status === "restricted") return "attention";
  return "neutral";
}

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
        <div className={styles["capabilityRow"]}>
          <span className={styles["capabilityIcon"]}>
            <PanelsTopLeft aria-hidden="true" size={17} />
          </span>
          <div>
            <h3>Managed Chromium</h3>
            <p>独立 Profile，不影响日常浏览器会话</p>
          </div>
          <span
            className={styles["status"]}
            data-tone={
              snapshot?.browser === "ready" || snapshot?.browser === "open"
                ? "positive"
                : "neutral"
            }
          >
            {!snapshot
              ? "读取中"
              : snapshot.browser === "open"
                ? "已打开"
                : snapshot.browser === "ready"
                  ? "可用"
                  : "尚未安装"}
          </span>
        </div>
        <div className={styles["profilePath"]}>
          <span>Profile</span>
          <code title={snapshot?.profileDirectory}>
            {snapshot?.profileDirectory ?? "正在读取…"}
          </code>
        </div>
        <div className={styles["compactActions"]}>
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
        <div className={styles["sectionHeading"]}>
          <div>
            <h3>macOS 权限</h3>
            <p>状态由系统设置管理，CharaMate 只读取当前结果。</p>
          </div>
          <button disabled={busy} type="button" onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" size={13} />
            刷新
          </button>
        </div>
        <div className={styles["permissionList"]}>
          <div className={styles["permissionRow"]}>
            <span className={styles["permissionIcon"]}>
              <Accessibility aria-hidden="true" size={15} />
            </span>
            <div>
              <strong>辅助功能</strong>
              <small>操作其他 macOS 应用</small>
            </div>
            <span
              className={styles["status"]}
              data-tone={statusTone(snapshot?.accessibility)}
            >
              {snapshot ? labels[snapshot.accessibility] : "读取中"}
            </span>
          </div>
          <div className={styles["permissionRow"]}>
            <span className={styles["permissionIcon"]}>
              <MonitorUp aria-hidden="true" size={15} />
            </span>
            <div>
              <strong>屏幕录制</strong>
              <small>感知当前屏幕内容与完成 Computer 操作</small>
            </div>
            <span
              className={styles["status"]}
              data-tone={statusTone(snapshot?.screenRecording)}
            >
              {snapshot ? labels[snapshot.screenRecording] : "读取中"}
            </span>
          </div>
        </div>
      </div>
      {error || feedback ? (
        <p
          className={styles["panelFeedback"]}
          role={error ? "alert" : "status"}
        >
          {error ?? feedback}
        </p>
      ) : null}
    </section>
  );
}
