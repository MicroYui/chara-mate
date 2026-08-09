import { HardDrive, Pause, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  ActivityApi,
  ActivitySnapshot,
} from "../../../shared/contracts/activity";
import styles from "./CapabilitySettingsPanel.module.css";

function today(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ActivitySettingsPanel({
  api = window.charaMate.activity,
}: {
  readonly api?: ActivityApi;
}) {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const response = await api.getSnapshot({ date: today() });
    if (response.ok) {
      setSnapshot(response.value);
      setError(undefined);
    } else setError(response.error.message);
  }, [api]);

  useEffect(() => {
    let active = true;
    void api
      .getSnapshot({ date: today() })
      .then((response) => {
        if (!active) return;
        if (response.ok) setSnapshot(response.value);
        else setError(response.error.message);
      })
      .catch(() => {
        if (active) setError("无法读取 Activity 状态。");
      });
    return () => {
      active = false;
    };
  }, [api]);

  const togglePaused = async () => {
    if (!snapshot || busy) return;
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const response = await api.setPaused({ paused: !snapshot.paused });
      if (response.ok) {
        setSnapshot(response.value);
        setFeedback(
          response.value.paused ? "Activity 已暂停。" : "Activity 已恢复。",
        );
      } else setError(response.error.message);
    } catch {
      setError("无法更新 Activity 采集状态。");
    } finally {
      setBusy(false);
    }
  };

  const cleanup = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const response = await api.cleanup({});
      if (response.ok) {
        setFeedback(
          `已清理 ${String(response.value.deletedEvents)} 条原始事件和 ${String(response.value.deletedAssets)} 个截图资产。`,
        );
        await load();
      } else setError(response.error.message);
    } catch {
      setError("Activity 清理没有完成。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles["panel"]}>
      <header className={styles["header"]}>
        <p className={styles["eyebrow"]}>Activity</p>
        <h2>行为记录</h2>
        <p>只保留一个采集开关；采集节奏与保留策略由产品固定。</p>
      </header>
      <div className={styles["section"]}>
        <div className={styles["capabilityRow"]}>
          <span className={styles["capabilityIcon"]}>
            {snapshot?.paused ? (
              <Pause aria-hidden="true" size={17} />
            ) : (
              <Play aria-hidden="true" size={17} />
            )}
          </span>
          <div>
            <h3>Activity 采集</h3>
            <p>记录应用与受管浏览器的变化，并蒸馏为 Episode。</p>
          </div>
          <button
            disabled={busy || !snapshot}
            type="button"
            onClick={() => void togglePaused()}
          >
            {snapshot?.paused ? "恢复采集" : "暂停采集"}
          </button>
        </div>
      </div>
      <div className={styles["section"]}>
        <div className={styles["capabilityRow"]}>
          <span className={styles["capabilityIcon"]}>
            <HardDrive aria-hidden="true" size={17} />
          </span>
          <div>
            <h3>原始截图资产</h3>
            <p>{snapshot ? bytesLabel(snapshot.rawBytes) : "正在读取…"}</p>
          </div>
          <button
            disabled={busy || !snapshot}
            type="button"
            onClick={() => void cleanup()}
          >
            <Trash2 aria-hidden="true" size={13} />
            立即清理
          </button>
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
