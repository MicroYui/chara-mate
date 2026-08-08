import { useEffect, useState, type FormEvent } from "react";

import type {
  AgentSettings,
  SettingsApi,
} from "../../../shared/contracts/settings";
import styles from "./CapabilitySettingsPanel.module.css";

export interface AgentSettingsPanelProps {
  api?: SettingsApi;
  onChanged?: (settings: AgentSettings) => void;
}

const initial: AgentSettings = {
  defaultApprovalMode: "request_approval",
  defaultMode: "chat",
  workingDirectory: "",
};

export function AgentSettingsPanel({
  api = window.charaMate.settings,
  onChanged,
}: AgentSettingsPanelProps) {
  const [settings, setSettings] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void api.getSnapshot().then((response) => {
      if (!active) return;
      if (response.ok) setSettings(response.value.agent);
      else setError(response.error.message);
    });
    return () => {
      active = false;
    };
  }, [api]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const response = await api.saveAgent({ agent: settings });
      if (!response.ok) setError(response.error.message);
      else {
        setSettings(response.value);
        setFeedback("Agent 默认设置已保存。");
        onChanged?.(response.value);
      }
    } catch {
      setError("无法保存 Agent 设置。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles["panel"]}>
      <header className={styles["header"]}>
        <p className={styles["eyebrow"]}>Agent</p>
        <h2>默认执行方式</h2>
        <p>这些值只决定新 Composer 的默认选择；每一轮仍可直接改动。</p>
      </header>
      <form className={styles["form"]} onSubmit={(event) => void save(event)}>
        <label>
          默认模式
          <select
            value={settings.defaultMode}
            onChange={(event) => {
              const defaultMode = event.currentTarget.value as "chat" | "agent";
              setSettings((current) => ({
                ...current,
                defaultMode,
              }));
            }}
          >
            <option value="chat">Chat</option>
            <option value="agent">Agent</option>
          </select>
        </label>
        <label>
          Agent 默认权限
          <select
            value={settings.defaultApprovalMode}
            onChange={(event) => {
              const defaultApprovalMode = event.currentTarget
                .value as AgentSettings["defaultApprovalMode"];
              setSettings((current) => ({
                ...current,
                defaultApprovalMode,
              }));
            }}
          >
            <option value="request_approval">请求批准</option>
            <option value="auto_approve">替我审批</option>
            <option value="full_access">完全访问</option>
          </select>
        </label>
        <label>
          工作目录
          <input
            value={settings.workingDirectory}
            onChange={(event) => {
              const workingDirectory = event.currentTarget.value;
              setSettings((current) => ({
                ...current,
                workingDirectory,
              }));
            }}
          />
        </label>
        <p className={styles["meta"]}>
          相对文件路径、命令默认 cwd 与项目 Skills 都从此目录解析。
        </p>
        <p className={styles["feedback"]} role={error ? "alert" : "status"}>
          {error ?? feedback}
        </p>
        <div className={styles["actions"]}>
          <button className={styles["primary"]} disabled={busy} type="submit">
            保存
          </button>
        </div>
      </form>
    </section>
  );
}
