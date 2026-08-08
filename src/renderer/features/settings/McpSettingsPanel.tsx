import { useCallback, useEffect, useState } from "react";

import type {
  ExtensionsApi,
  McpServer,
  McpServerDraft,
} from "../../../shared/contracts/extensions";
import styles from "./CapabilitySettingsPanel.module.css";

interface McpForm {
  args: string;
  command: string;
  cwd: string;
  enabled: boolean;
  fields: string;
  name: string;
  type: "stdio" | "streamable_http";
  url: string;
}

const empty: McpForm = {
  args: "",
  command: "",
  cwd: "",
  enabled: true,
  fields: "",
  name: "",
  type: "stdio",
  url: "",
};

function serverForm(server: McpServer): McpForm {
  return server.transport.type === "stdio"
    ? {
        args: server.transport.args.join("\n"),
        command: server.transport.command,
        cwd: server.transport.cwd ?? "",
        enabled: server.enabled,
        fields: server.transport.environment.map(({ name }) => name).join("\n"),
        name: server.name,
        type: "stdio",
        url: "",
      }
    : {
        ...empty,
        enabled: server.enabled,
        fields: server.transport.headers.map(({ name }) => name).join("\n"),
        name: server.name,
        type: "streamable_http",
        url: server.transport.url,
      };
}

function secretFields(value: string) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator < 0
        ? { name: line }
        : { name: line.slice(0, separator), value: line.slice(separator + 1) };
    });
}

function draft(form: McpForm, id?: string): McpServerDraft {
  const common = {
    enabled: form.enabled,
    ...(id ? { id } : {}),
    name: form.name,
  };
  return form.type === "stdio"
    ? {
        ...common,
        transport: {
          args: form.args.split(/\r?\n/u).filter(Boolean),
          command: form.command,
          ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
          environment: secretFields(form.fields),
          type: "stdio",
        },
      }
    : {
        ...common,
        transport: {
          headers: secretFields(form.fields),
          type: "streamable_http",
          url: form.url,
        },
      };
}

export function McpSettingsPanel({
  api = window.charaMate.extensions,
}: {
  readonly api?: ExtensionsApi;
}) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [form, setForm] = useState<McpForm>(empty);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const selected = servers.find(({ id }) => id === selectedId);

  const refresh = useCallback(async () => {
    const response = await api.mcpList({});
    if (response.ok) setServers(response.value);
    else setError(response.error.message);
  }, [api]);

  useEffect(() => {
    let active = true;
    void api.mcpList({}).then((response) => {
      if (!active) return;
      if (response.ok) setServers(response.value);
      else setError(response.error.message);
    });
    return () => {
      active = false;
    };
  }, [api]);

  const execute = async (operation: () => Promise<McpServer | undefined>) => {
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const server = await operation();
      await refresh();
      if (server) {
        setSelectedId(server.id);
        setForm(serverForm(server));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "MCP 操作没有完成。");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    execute(async () => {
      const response = await api.mcpSave({ server: draft(form, selectedId) });
      if (!response.ok) throw new Error(response.error.message);
      setFeedback(
        response.value.status === "connected"
          ? "配置已保存并连接。"
          : "配置已保存；当前未连接，可查看错误后重试。",
      );
      return response.value;
    });

  return (
    <section className={styles["panel"]}>
      <header className={styles["header"]}>
        <p className={styles["eyebrow"]}>MCP</p>
        <h2>MCP Servers</h2>
        <p>stdio 与 Streamable HTTP 都映射到同一个 Tool Registry。</p>
      </header>
      <div className={styles["columns"]}>
        <aside className={styles["list"]} aria-label="MCP Servers">
          {servers.map((server) => (
            <button
              aria-current={server.id === selectedId ? "true" : undefined}
              key={server.id}
              type="button"
              onClick={() => {
                setSelectedId(server.id);
                setForm(serverForm(server));
                setError(undefined);
                setFeedback(undefined);
              }}
            >
              <span>{server.name}</span>
              <small>{server.status}</small>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setSelectedId(undefined);
              setForm(empty);
            }}
          >
            添加 Server
          </button>
        </aside>
        <div className={styles["form"]}>
          <label>
            名称
            <input
              value={form.name}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  name: event.currentTarget.value,
                }))
              }
            />
          </label>
          <label>
            传输
            <select
              value={form.type}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  type: event.currentTarget.value as McpForm["type"],
                }))
              }
            >
              <option value="stdio">stdio</option>
              <option value="streamable_http">Streamable HTTP</option>
            </select>
          </label>
          {form.type === "stdio" ? (
            <>
              <label>
                Command
                <input
                  value={form.command}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      command: event.currentTarget.value,
                    }))
                  }
                />
              </label>
              <label>
                Args（每行一个）
                <textarea
                  value={form.args}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      args: event.currentTarget.value,
                    }))
                  }
                />
              </label>
              <label>
                工作目录（可选）
                <input
                  value={form.cwd}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      cwd: event.currentTarget.value,
                    }))
                  }
                />
              </label>
            </>
          ) : (
            <label>
              URL
              <input
                value={form.url}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    url: event.currentTarget.value,
                  }))
                }
              />
            </label>
          )}
          <label>
            {form.type === "stdio" ? "环境变量" : "Headers"}（每行 NAME=VALUE）
            <textarea
              value={form.fields}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  fields: event.currentTarget.value,
                }))
              }
            />
          </label>
          <label className={styles["checkbox"]}>
            <input
              checked={form.enabled}
              type="checkbox"
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  enabled: event.currentTarget.checked,
                }))
              }
            />
            启用
          </label>
          {selected ? (
            <div>
              <span className={styles["status"]}>{selected.status}</span>
              {selected.error ? (
                <p className={styles["meta"]}>{selected.error.message}</p>
              ) : null}
              <ul className={styles["toolList"]}>
                {selected.toolNames.map((tool) => (
                  <li key={tool}>{tool}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className={styles["feedback"]} role={error ? "alert" : "status"}>
            {error ?? feedback}
          </p>
          <div className={styles["actions"]}>
            {selected ? (
              <>
                <button
                  disabled={busy || !selected.enabled}
                  type="button"
                  onClick={() =>
                    void execute(async () => {
                      const response = await api.mcpRefresh({
                        serverId: selected.id,
                      });
                      if (!response.ok) throw new Error(response.error.message);
                      setFeedback("连接测试完成。");
                      return response.value;
                    })
                  }
                >
                  测试并刷新工具
                </button>
                <button
                  className={styles["danger"]}
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void execute(async () => {
                      const response = await api.mcpDelete({
                        serverId: selected.id,
                      });
                      if (!response.ok) throw new Error(response.error.message);
                      setSelectedId(undefined);
                      setForm(empty);
                      return undefined;
                    })
                  }
                >
                  删除
                </button>
              </>
            ) : null}
            <button
              className={styles["primary"]}
              disabled={busy}
              type="button"
              onClick={() => void save()}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
