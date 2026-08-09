import { Mic, Volume2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type {
  ProviderApi,
  ProviderProfile,
} from "../../../shared/contracts/provider";
import type {
  SettingsApi,
  VoiceSettingsConfig,
} from "../../../shared/contracts/settings";
import type { VoiceName } from "../../../shared/contracts/voice";
import type { VoiceStore } from "../voice/voiceStore";
import styles from "./CapabilitySettingsPanel.module.css";

const voices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const satisfies readonly VoiceName[];

const permissionLabel = {
  denied: "未授权",
  granted: "已授权",
  not_determined: "首次使用时询问",
  restricted: "受系统限制",
  unavailable: "当前平台不可用",
} as const;

const initial: VoiceSettingsConfig = {
  inputMode: "hands_free",
  instructions: "使用自然、简洁的中文口语。",
  providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
  voice: "verse",
};

interface VoiceSettingsPanelProps {
  readonly providerApi?: ProviderApi;
  readonly settingsApi?: SettingsApi;
  readonly voiceStore: VoiceStore;
}

function realtimeProfiles(profiles: readonly ProviderProfile[]) {
  return profiles.filter(
    (profile) =>
      profile.apiStyle === "azure-openai" &&
      profile.realtimeEndpoint &&
      profile.realtimeModel,
  );
}

export function VoiceSettingsPanel({
  providerApi = window.charaMate.provider,
  settingsApi = window.charaMate.settings,
  voiceStore,
}: VoiceSettingsPanelProps) {
  const [settings, setSettings] = useState<VoiceSettingsConfig>(initial);
  const [profiles, setProfiles] = useState<readonly ProviderProfile[]>([]);
  const [microphone, setMicrophone] = useState<keyof typeof permissionLabel>();
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const hasSelectedProfile = profiles.some(
    (profile) => profile.id === settings.providerProfileId,
  );

  useEffect(() => {
    let active = true;
    void Promise.all([
      settingsApi.getSnapshot(),
      providerApi.listProfiles(),
    ]).then(([settingsResponse, profilesResponse]) => {
      if (!active) return;
      if (settingsResponse.ok) {
        const { microphone: status, ...config } = settingsResponse.value.voice;
        setMicrophone(status);
        setSettings(config);
      } else setError(settingsResponse.error.message);
      if (profilesResponse.ok)
        setProfiles(realtimeProfiles(profilesResponse.value));
      else setError(profilesResponse.error.message);
    });
    return () => {
      active = false;
    };
  }, [providerApi, settingsApi]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const response = await settingsApi.saveVoice({
        voice: { ...settings, instructions: settings.instructions.trim() },
      });
      if (!response.ok) setError(response.error.message);
      else {
        const { microphone: status, ...config } = response.value;
        setMicrophone(status);
        setSettings(config);
        setFeedback("Voice 设置已保存。");
      }
    } catch {
      setError("无法保存 Voice 设置。");
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    setPreviewing(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      await voiceStore.preview({
        instructions: settings.instructions.trim(),
        providerProfileId: settings.providerProfileId,
        voice: settings.voice,
      });
      setFeedback("试听完成。");
    } catch (previewError) {
      setError(
        previewError instanceof Error ? previewError.message : "音色试听失败。",
      );
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <section className={styles["panel"]}>
      <header className={styles["header"]}>
        <p className={styles["eyebrow"]}>Voice</p>
        <h2>Realtime 语音</h2>
        <p>选择 Azure Realtime Profile、音色与自然说话方式。</p>
      </header>
      <div className={styles["section"]}>
        <div className={styles["capabilityRow"]}>
          <span className={styles["capabilityIcon"]}>
            <Mic aria-hidden="true" size={17} />
          </span>
          <div>
            <h3>麦克风</h3>
            <p>权限由 macOS 管理，首次开始语音时会出现系统询问。</p>
          </div>
          <span
            className={styles["status"]}
            data-tone={microphone === "granted" ? "positive" : "attention"}
          >
            {microphone ? permissionLabel[microphone] : "读取中"}
          </span>
        </div>
      </div>
      <form className={styles["form"]} onSubmit={(event) => void save(event)}>
        <label>
          Realtime Provider
          <select
            value={settings.providerProfileId}
            onChange={(event) => {
              const providerProfileId = event.currentTarget.value;
              setSettings((current) => ({
                ...current,
                providerProfileId,
              }));
            }}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.realtimeModel}
              </option>
            ))}
          </select>
        </label>
        {profiles.length === 0 ? (
          <p className={styles["meta"]}>
            请先在 Models 中配置带凭据、Realtime Endpoint 与 deployment 的 Azure
            Profile。
          </p>
        ) : null}
        <div className={styles["fieldActionRow"]}>
          <label>
            音色
            <select
              value={settings.voice}
              onChange={(event) => {
                const voice = event.currentTarget.value as VoiceName;
                setSettings((current) => ({
                  ...current,
                  voice,
                }));
              }}
            >
              {voices.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </select>
          </label>
          <button
            className={styles["button"]}
            disabled={
              previewing || !hasSelectedProfile || !settings.instructions.trim()
            }
            type="button"
            onClick={() => void preview()}
          >
            <Volume2 aria-hidden="true" size={14} />
            {previewing ? "试听中…" : "试听"}
          </button>
        </div>
        <label>
          输入方式
          <select
            value={settings.inputMode}
            onChange={(event) => {
              const inputMode = event.currentTarget
                .value as VoiceSettingsConfig["inputMode"];
              setSettings((current) => ({
                ...current,
                inputMode,
              }));
            }}
          >
            <option value="hands_free">免手持，可自然插话</option>
            <option value="push_to_talk">按住说话</option>
          </select>
        </label>
        <label>
          Realtime instructions
          <textarea
            value={settings.instructions}
            onChange={(event) => {
              const instructions = event.currentTarget.value;
              setSettings((current) => ({
                ...current,
                instructions,
              }));
            }}
          />
        </label>
        <p className={styles["meta"]}>
          可描述语气、语言和角色表达；命令、代码、JSON 与日志不会逐字朗读。
        </p>
        <p className={styles["feedback"]} role={error ? "alert" : "status"}>
          {error ?? feedback}
        </p>
        <div className={styles["actions"]}>
          <button
            className={styles["primary"]}
            disabled={
              busy || !hasSelectedProfile || !settings.instructions.trim()
            }
            type="submit"
          >
            保存
          </button>
        </div>
      </form>
    </section>
  );
}
