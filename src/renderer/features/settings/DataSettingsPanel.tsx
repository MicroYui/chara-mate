import { Database, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { ActivityApi } from "../../../shared/contracts/activity";
import type {
  DataSettingsSnapshot,
  SettingsApi,
} from "../../../shared/contracts/settings";
import styles from "./DataSettingsPanel.module.css";

export function formatByteLength(byteLength: number): string {
  if (byteLength < 1024) return `${String(byteLength)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = byteLength / 1024;
  let unit: (typeof units)[number] = units[0];
  for (const nextUnit of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = nextUnit;
  }
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ${unit}`;
}

export function DataSettingsPanel({
  activityApi = window.charaMate.activity,
  settingsApi = window.charaMate.settings,
}: {
  readonly activityApi?: ActivityApi;
  readonly settingsApi?: SettingsApi;
}) {
  const [snapshot, setSnapshot] = useState<DataSettingsSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();

  const load = useCallback(async () => {
    const response = await settingsApi.getDataSnapshot();
    if (response.ok) {
      setSnapshot(response.value);
      setError(undefined);
    } else {
      setError(response.error.message);
    }
  }, [settingsApi]);

  useEffect(() => {
    let active = true;
    void settingsApi
      .getDataSnapshot()
      .then((response) => {
        if (!active) return;
        if (response.ok) setSnapshot(response.value);
        else setError(response.error.message);
      })
      .catch(() => {
        if (active) setError("无法读取本地数据占用。");
      });
    return () => {
      active = false;
    };
  }, [settingsApi]);

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      await operation();
    } catch {
      setError("数据操作没有完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const openDirectory = () =>
    run(async () => {
      const response = await settingsApi.openDataDirectory();
      if (response.ok) setFeedback(response.value.message);
      else setError(response.error.message);
    });

  const refresh = () =>
    run(async () => {
      await load();
      setFeedback("占用信息已刷新。");
    });

  const cleanup = () => {
    if (
      !window.confirm(
        "只会删除已经蒸馏完成的 Activity 原始事件、截图和孤立的 Activity 资产。对话、记忆、领地与设置不会被删除。继续吗？",
      )
    ) {
      return;
    }
    void run(async () => {
      const response = await activityApi.cleanup({});
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      await load();
      setFeedback(
        `已清理 ${String(response.value.deletedEvents)} 条原始事件和 ${String(response.value.deletedAssets)} 个截图资产。`,
      );
    });
  };

  return (
    <section className={styles["panel"]}>
      <header className={styles["header"]}>
        <p className={styles["eyebrow"]}>Data</p>
        <h2>本地数据</h2>
        <p>
          查看 CharaMate 的真实本地占用，打开数据目录并清理可安全移除的 Activity
          原始数据。
        </p>
      </header>

      <div className={styles["summary"]}>
        <span className={styles["summaryIcon"]}>
          <Database aria-hidden="true" size={20} />
        </span>
        <div>
          <small>当前占用</small>
          <strong>
            {snapshot
              ? formatByteLength(snapshot.totalByteLength)
              : "正在读取…"}
          </strong>
        </div>
        <button disabled={busy} type="button" onClick={() => void refresh()}>
          <RefreshCw aria-hidden="true" size={14} />
          刷新
        </button>
      </div>

      <div className={styles["usageList"]} aria-label="数据占用明细">
        {snapshot?.categories.map((category) => (
          <div className={styles["usageRow"]} key={category.id}>
            <div>
              <strong>{category.label}</strong>
              <span>{formatByteLength(category.byteLength)}</span>
            </div>
            <meter
              aria-label={`${category.label}占用`}
              max={Math.max(snapshot.totalByteLength, 1)}
              value={category.byteLength}
            />
          </div>
        )) ?? <p className={styles["loading"]}>正在统计各类数据…</p>}
      </div>

      <div className={styles["directory"]}>
        <div>
          <strong>数据目录</strong>
          <code title={snapshot?.dataDirectory}>
            {snapshot?.dataDirectory ?? "正在读取…"}
          </code>
        </div>
        <button
          disabled={busy || !snapshot}
          type="button"
          onClick={() => void openDirectory()}
        >
          <FolderOpen aria-hidden="true" size={14} />在 Finder 中打开
        </button>
      </div>

      <div className={styles["cleanup"]}>
        <div>
          <strong>安全清理</strong>
          <p>
            只清理已完成蒸馏的 Activity
            原始事件、截图与孤立资产，不会删除对话、记忆、领地或设置。
          </p>
        </div>
        <button disabled={busy} type="button" onClick={cleanup}>
          <Trash2 aria-hidden="true" size={14} />
          清理可移除数据
        </button>
      </div>

      {error || feedback ? (
        <p className={styles["feedback"]} role={error ? "alert" : "status"}>
          {error ?? feedback}
        </p>
      ) : null}
    </section>
  );
}
