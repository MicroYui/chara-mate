import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import type {
  ProviderApi,
  ProviderConnection,
  ProviderProfile,
  ProviderProfileDraft,
  ProviderTestCapability,
} from "../../../shared/contracts/provider";
import styles from "./ProviderSettingsPanel.module.css";

interface ProviderFormState {
  apiKey: string;
  apiStyle: "openai-compatible" | "azure-openai";
  apiVersion: string;
  baseUrl: string;
  chatModel: string;
  imageEditEndpoint: string;
  imageModel: string;
  name: string;
  realtimeEndpoint: string;
  realtimeModel: string;
  removeStoredKey: boolean;
}

const emptyForm: ProviderFormState = {
  apiKey: "",
  apiStyle: "openai-compatible",
  apiVersion: "",
  baseUrl: "https://api.openai.com/v1",
  chatModel: "",
  imageEditEndpoint: "",
  imageModel: "",
  name: "",
  realtimeEndpoint: "",
  realtimeModel: "",
  removeStoredKey: false,
};

const unexpectedRequestMessage = "Provider 请求失败，请稍后重试。";

function optionalText(value: string): string | undefined {
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function profileToForm(profile: ProviderProfile): ProviderFormState {
  return {
    apiKey: "",
    apiStyle: profile.apiStyle,
    apiVersion: profile.apiStyle === "azure-openai" ? profile.apiVersion : "",
    baseUrl: profile.baseUrl,
    chatModel: profile.chatModel ?? "",
    imageEditEndpoint: profile.imageEditEndpoint ?? "",
    imageModel: profile.imageModel ?? "",
    name: profile.name,
    realtimeEndpoint: profile.realtimeEndpoint ?? "",
    realtimeModel: profile.realtimeModel ?? "",
    removeStoredKey: false,
  };
}

function formToDraft(
  form: ProviderFormState,
  profileId?: string,
): ProviderProfileDraft {
  const chatModel = optionalText(form.chatModel);
  const imageEditEndpoint = optionalText(form.imageEditEndpoint);
  const imageModel = optionalText(form.imageModel);
  const realtimeEndpoint = optionalText(form.realtimeEndpoint);
  const realtimeModel = optionalText(form.realtimeModel);
  const common = {
    ...(profileId ? { id: profileId } : {}),
    baseUrl: form.baseUrl,
    ...(chatModel ? { chatModel } : {}),
    ...(imageEditEndpoint ? { imageEditEndpoint } : {}),
    ...(imageModel ? { imageModel } : {}),
    name: form.name,
    ...(realtimeEndpoint ? { realtimeEndpoint } : {}),
    ...(realtimeModel ? { realtimeModel } : {}),
  };
  return form.apiStyle === "azure-openai"
    ? {
        ...common,
        apiStyle: "azure-openai",
        apiVersion: form.apiVersion,
      }
    : { ...common, apiStyle: "openai-compatible" };
}

function resultError(result: {
  error: { message: string };
  ok: false;
}): string {
  return result.error.message;
}

export interface ProviderSettingsPanelProps {
  api?: ProviderApi;
}

export function ProviderSettingsPanel({
  api = window.charaMate.provider,
}: ProviderSettingsPanelProps) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [form, setForm] = useState<ProviderFormState>(emptyForm);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedId),
    [profiles, selectedId],
  );

  useEffect(() => {
    let active = true;
    void api
      .listProfiles()
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setError(resultError(result));
        } else {
          setProfiles(result.value);
        }
      })
      .catch(() => {
        if (active) setError(unexpectedRequestMessage);
      });
    return () => {
      active = false;
    };
  }, [api]);

  function updateField<TKey extends keyof ProviderFormState>(
    key: TKey,
    value: ProviderFormState[TKey],
  ): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function selectProfile(profile: ProviderProfile): void {
    setSelectedId(profile.id);
    setForm(profileToForm(profile));
    setModels([]);
    setError(undefined);
    setStatus(undefined);
  }

  function startNewProfile(): void {
    setSelectedId(undefined);
    setForm(emptyForm);
    setModels([]);
    setError(undefined);
    setStatus(undefined);
  }

  function connectionForCurrentForm(): ProviderConnection | undefined {
    if (form.apiKey.trim()) {
      return {
        apiKey: form.apiKey,
        profile: formToDraft(form, selectedId),
        source: "draft",
      };
    }
    if (selectedId && selectedProfile?.hasApiKey) {
      return {
        profile: formToDraft(form, selectedId),
        profileId: selectedId,
        source: "saved_profile",
      };
    }
    setError("请先填写 API Key，或选择一个已保存密钥的 Provider。");
    return undefined;
  }

  async function runConnectionTest(
    capability: ProviderTestCapability,
  ): Promise<void> {
    const connection = connectionForCurrentForm();
    if (!connection) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await api.testConnection({ capability, connection });
      if (!result.ok) {
        setError(resultError(result));
      } else if (
        result.value.capability === "chat" &&
        result.value.status === "connected"
      ) {
        setStatus(
          `Chat 连接成功，发现 ${String(result.value.modelCount)} 个模型。`,
        );
      } else if (
        result.value.capability === "realtime" &&
        result.value.status === "connected"
      ) {
        setStatus("Realtime 握手成功，测试连接已关闭。");
      } else if (result.value.status === "connected") {
        setStatus("Image 配置可用：凭据与模型验证成功，未发起生图。");
      } else if (result.value.capability === "image") {
        setStatus("该 Provider 不支持无生成验证，请手动确认 Image 配置。");
      } else {
        setStatus("连接端点未提供标准模型列表，请手动填写 Model ID。");
      }
    } catch {
      setError(unexpectedRequestMessage);
    } finally {
      setBusy(false);
    }
  }

  async function discoverModels(): Promise<void> {
    const connection = connectionForCurrentForm();
    if (!connection) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await api.discoverModels({ connection });
      if (!result.ok) {
        setError(resultError(result));
      } else if (result.value.status === "available") {
        const ids = result.value.models.map((model) => model.id);
        setModels(ids);
        setStatus(`已加载 ${String(ids.length)} 个模型，也可以继续手填。`);
      } else {
        setModels([]);
        setStatus("该 Provider 不支持模型发现，请手动填写 Model ID。");
      }
    } catch {
      setError(unexpectedRequestMessage);
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const credential = form.apiKey.trim()
        ? { mode: "replace" as const, value: form.apiKey }
        : form.removeStoredKey
          ? { mode: "remove" as const }
          : { mode: "keep" as const };
      const result = await api.saveProfile({
        credential,
        profile: formToDraft(form, selectedId),
      });
      if (!result.ok) {
        setError(resultError(result));
        return;
      }
      setSelectedId(result.value.id);
      setForm(profileToForm(result.value));
      setProfiles((current) => [
        result.value,
        ...current.filter((profile) => profile.id !== result.value.id),
      ]);
      setStatus("Provider 已保存，API Key 不会回传到 Renderer。");
    } catch {
      setError(unexpectedRequestMessage);
    } finally {
      setBusy(false);
    }
  }

  async function deleteProfile(): Promise<void> {
    if (!selectedId) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await api.deleteProfile({ profileId: selectedId });
      if (!result.ok) {
        setError(resultError(result));
        return;
      }
      setProfiles((current) =>
        current.filter((profile) => profile.id !== result.value.profileId),
      );
      startNewProfile();
      setStatus("Provider 已删除。关联的加密密钥也已清理。");
    } catch {
      setError(unexpectedRequestMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={styles["panel"]}
      aria-labelledby="provider-settings-title"
    >
      <header className={styles["header"]}>
        <div>
          <p className={styles["eyebrow"]}>Settings · Models</p>
          <h2 id="provider-settings-title">Provider 与模型</h2>
          <p>
            配置 OpenAI-compatible 或 Azure OpenAI。密钥只写入系统密钥存储。
          </p>
        </div>
        <button
          aria-label="新建 Provider"
          type="button"
          onClick={startNewProfile}
          disabled={busy}
        >
          新建
        </button>
      </header>

      <div className={styles["layout"]}>
        <nav className={styles["profileList"]} aria-label="Provider Profiles">
          {profiles.length === 0 ? (
            <p className={styles["empty"]}>还没有 Provider。</p>
          ) : (
            profiles.map((profile) => (
              <button
                aria-current={profile.id === selectedId ? "page" : undefined}
                className={
                  profile.id === selectedId ? styles["selected"] : undefined
                }
                key={profile.id}
                onClick={() => selectProfile(profile)}
                type="button"
              >
                <span>{profile.name}</span>
                <small>
                  {profile.apiStyle === "azure-openai" ? "Azure" : "Compatible"}
                  {profile.hasApiKey ? " · Key 已保存" : " · 无 Key"}
                </small>
              </button>
            ))
          )}
        </nav>

        <form
          className={styles["form"]}
          onSubmit={(event) => void saveProfile(event)}
        >
          <div className={styles["twoColumns"]}>
            <label>
              名称
              <input
                onChange={(event) => updateField("name", event.target.value)}
                required
                value={form.name}
              />
            </label>
            <label>
              API 类型
              <select
                onChange={(event) =>
                  updateField(
                    "apiStyle",
                    event.target.value as ProviderFormState["apiStyle"],
                  )
                }
                value={form.apiStyle}
              >
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="azure-openai">Azure OpenAI</option>
              </select>
            </label>
          </div>

          <label>
            Base URL
            <input
              inputMode="url"
              onChange={(event) => updateField("baseUrl", event.target.value)}
              required
              value={form.baseUrl}
            />
          </label>

          {form.apiStyle === "azure-openai" ? (
            <label>
              Azure API Version
              <input
                onChange={(event) =>
                  updateField("apiVersion", event.target.value)
                }
                placeholder="2025-04-01-preview"
                required
                value={form.apiVersion}
              />
            </label>
          ) : null}

          <label>
            API Key
            <input
              autoComplete="off"
              onChange={(event) => {
                updateField("apiKey", event.target.value);
                updateField("removeStoredKey", false);
              }}
              placeholder={
                selectedProfile?.hasApiKey
                  ? "已安全保存；留空则保持"
                  : "输入 API Key"
              }
              type="password"
              value={form.apiKey}
            />
          </label>

          {selectedProfile?.hasApiKey ? (
            <label className={styles["checkbox"]}>
              <input
                checked={form.removeStoredKey}
                onChange={(event) =>
                  updateField("removeStoredKey", event.target.checked)
                }
                type="checkbox"
              />
              保存时删除现有 API Key
            </label>
          ) : null}

          <label>
            Chat Model
            <input
              list="provider-model-options"
              onChange={(event) => updateField("chatModel", event.target.value)}
              placeholder="选择或手动填写 Model ID"
              value={form.chatModel}
            />
            <datalist id="provider-model-options">
              {models.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>

          <div className={styles["actions"]}>
            <button
              disabled={busy}
              onClick={() => void runConnectionTest("chat")}
              type="button"
            >
              测试连接
            </button>
            <button
              disabled={busy}
              onClick={() => void discoverModels()}
              type="button"
            >
              加载模型
            </button>
          </div>

          <details className={styles["advanced"]}>
            <summary>
              <span>Realtime 与 Image</span>
              <small>可选能力</small>
            </summary>
            <div className={styles["advancedContent"]}>
              <section
                aria-labelledby="provider-realtime-title"
                className={styles["capabilitySection"]}
              >
                <header className={styles["capabilityHeader"]}>
                  <div>
                    <h3 id="provider-realtime-title">Realtime</h3>
                    <p>使用上方 API Key；Azure Model 填 deployment 名称。</p>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => void runConnectionTest("realtime")}
                    type="button"
                  >
                    测试 Realtime
                  </button>
                </header>
                <div className={styles["detailsGrid"]}>
                  <label>
                    Realtime Endpoint
                    <input
                      inputMode="url"
                      onChange={(event) =>
                        updateField("realtimeEndpoint", event.target.value)
                      }
                      placeholder={
                        form.apiStyle === "azure-openai"
                          ? "https://resource.openai.azure.com/openai/v1/realtime"
                          : "https://api.openai.com/v1/realtime"
                      }
                      value={form.realtimeEndpoint}
                    />
                  </label>
                  <label>
                    Realtime Model
                    <input
                      onChange={(event) =>
                        updateField("realtimeModel", event.target.value)
                      }
                      placeholder={
                        form.apiStyle === "azure-openai"
                          ? "Azure deployment 名称"
                          : "gpt-realtime"
                      }
                      value={form.realtimeModel}
                    />
                  </label>
                </div>
              </section>

              <section
                aria-labelledby="provider-image-title"
                className={styles["capabilitySection"]}
              >
                <header className={styles["capabilityHeader"]}>
                  <div>
                    <h3 id="provider-image-title">Image</h3>
                    <p>使用上方 API Key；验证 URL 与模型，不发起生图。</p>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => void runConnectionTest("image")}
                    type="button"
                  >
                    测试 Image
                  </button>
                </header>
                <div className={styles["detailsGrid"]}>
                  <label>
                    Image Edit Endpoint
                    <input
                      inputMode="url"
                      onChange={(event) =>
                        updateField("imageEditEndpoint", event.target.value)
                      }
                      placeholder="https://api.openai.com/v1/images/edits"
                      value={form.imageEditEndpoint}
                    />
                  </label>
                  <label>
                    Image Model
                    <input
                      onChange={(event) =>
                        updateField("imageModel", event.target.value)
                      }
                      placeholder="gpt-image-1"
                      value={form.imageModel}
                    />
                  </label>
                </div>
              </section>
            </div>
          </details>

          <div aria-live="polite" className={styles["feedback"]}>
            {error ? <p role="alert">{error}</p> : null}
            {status ? <p>{status}</p> : null}
          </div>

          <footer className={styles["footer"]}>
            {selectedId ? (
              <button
                className={styles["danger"]}
                disabled={busy}
                onClick={() => void deleteProfile()}
                type="button"
              >
                删除
              </button>
            ) : (
              <span />
            )}
            <button
              aria-label="保存 Provider"
              className={styles["primary"]}
              disabled={busy}
              type="submit"
            >
              保存
            </button>
          </footer>
        </form>
      </div>
    </section>
  );
}
