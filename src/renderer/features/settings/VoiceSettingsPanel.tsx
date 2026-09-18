import { Mic, Volume2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type {
  PersonaApi,
  PersonaSnapshot,
} from "../../../shared/contracts/persona";
import type {
  ProviderApi,
  ProviderProfile,
} from "../../../shared/contracts/provider";
import type {
  SettingsApi,
  VoiceSettingsConfig,
} from "../../../shared/contracts/settings";
import type {
  VoiceWakeSettingsApi,
  VoiceWakeSnapshot,
} from "../../../shared/contracts/voiceWake";
import type { VoiceStore } from "../voice/voiceStore";
import styles from "./CapabilitySettingsPanel.module.css";

const permissionLabel = {
  denied: "未授权",
  granted: "已授权",
  not_determined: "首次使用时询问",
  restricted: "受系统限制",
  unavailable: "当前平台不可用",
} as const;

const initial: VoiceSettingsConfig = {
  inputMode: "hands_free",
  providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
};

interface VoiceSettingsPanelProps {
  readonly personaApi?: PersonaApi;
  readonly providerApi?: ProviderApi;
  readonly settingsApi?: SettingsApi;
  readonly voiceStore: VoiceStore;
  readonly voiceWakeApi?: VoiceWakeSettingsApi;
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
  personaApi = window.charaMate.persona,
  providerApi = window.charaMate.provider,
  settingsApi = window.charaMate.settings,
  voiceStore,
  voiceWakeApi = window.charaMate.voiceWake,
}: VoiceSettingsPanelProps) {
  const [settings, setSettings] = useState<VoiceSettingsConfig>(initial);
  const [profiles, setProfiles] = useState<readonly ProviderProfile[]>([]);
  const [persona, setPersona] = useState<PersonaSnapshot>();
  const [microphone, setMicrophone] = useState<keyof typeof permissionLabel>();
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const [wake, setWake] = useState<VoiceWakeSnapshot>();
  const [wakeBusy, setWakeBusy] = useState(false);
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

  useEffect(() => {
    let active = true;
    const receive = (
      library: Awaited<ReturnType<PersonaApi["getLibrary"]>>,
    ) => {
      if (!active || !library.ok) return;
      setPersona(
        library.value.personas.find(
          ({ snapshot }) =>
            snapshot.personaId === library.value.activePersonaId,
        )?.snapshot,
      );
    };
    const unsubscribe = personaApi.subscribeChanged((library) => {
      if (!active) return;
      setPersona(
        library.personas.find(
          ({ snapshot }) => snapshot.personaId === library.activePersonaId,
        )?.snapshot,
      );
    });
    void personaApi.getLibrary().then(receive);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [personaApi]);

  useEffect(() => {
    let active = true;
    const unsubscribe = voiceWakeApi.subscribe((snapshot) => {
      if (active) setWake(snapshot);
    });
    void voiceWakeApi.getSnapshot().then((response) => {
      if (!active) return;
      if (response.ok) setWake(response.value);
      else setError(response.error.message);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [voiceWakeApi]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const response = await settingsApi.saveVoice({ voice: settings });
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

  useEffect(
    () => () => {
      void voiceStore.cancelPreview().catch(() => undefined);
    },
    [voiceStore],
  );

  const preview = async () => {
    if (!persona) return;
    setPreviewing(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      await voiceStore.preview({
        instructions: persona.voiceInstructions,
        providerProfileId: settings.providerProfileId,
        voice: persona.defaultVoice,
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

  const toggleWake = async () => {
    if (!wake || wakeBusy) return;
    setWakeBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const response = await voiceWakeApi.setEnabled({
        enabled: !wake.enabled,
      });
      if (!response.ok) setError(response.error.message);
      else {
        setWake(response.value);
        setFeedback(
          response.value.enabled
            ? "已开启 Hi Mika 语音唤醒。"
            : "已关闭语音唤醒。",
        );
      }
    } catch {
      setError("无法更新语音唤醒设置。");
    } finally {
      setWakeBusy(false);
    }
  };

  return (
    <section className={styles["panel"]}>
      <header className={styles["header"]}>
        <p className={styles["eyebrow"]}>Voice</p>
        <h2>Realtime 语音</h2>
        <p>
          选择 Realtime Provider 与输入方式；音色和说话方式跟随当前 Persona。
        </p>
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
        <button
          aria-checked={wake?.enabled ?? false}
          className={styles["wakeToggle"]}
          disabled={!wake || wakeBusy}
          role="switch"
          type="button"
          onClick={() => void toggleWake()}
        >
          <span>
            <strong>说“Hi Mika”自动唤醒</strong>
            <small>
              待机识别仅在本机进行；命中后复用桌宠的 Agent + 完全访问语音模式，
              无需打开主窗口。
            </small>
          </span>
          <span aria-hidden="true" className={styles["wakeSwitch"]} />
        </button>
      </div>
      <form className={styles["form"]} onSubmit={(event) => void save(event)}>
        <label>
          Realtime Provider
          <select
            value={settings.providerProfileId}
            onChange={(event) => {
              const providerProfileId = event.currentTarget.value;
              setSettings((current) => ({ ...current, providerProfileId }));
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
        <div className={styles["voicePersona"]}>
          <span className={styles["capabilityIcon"]}>
            <Volume2 aria-hidden="true" size={17} />
          </span>
          <div>
            <strong>当前 Persona 语音</strong>
            <small>
              {persona
                ? `${persona.displayName} · ${persona.styleName} · ${persona.defaultVoice}`
                : "正在读取 Persona…"}
            </small>
          </div>
          <button
            className={styles["button"]}
            disabled={previewing || !hasSelectedProfile || !persona}
            type="button"
            onClick={() => void preview()}
          >
            {previewing ? "试听中…" : "试听"}
          </button>
        </div>
        <p className={styles["meta"]}>
          如需调整音色或表达方式，请在 Character 中复制并编辑 Persona。
        </p>
        <label>
          输入方式
          <select
            value={settings.inputMode}
            onChange={(event) => {
              const inputMode = event.currentTarget
                .value as VoiceSettingsConfig["inputMode"];
              setSettings((current) => ({ ...current, inputMode }));
            }}
          >
            <option value="hands_free">免手持，可自然插话</option>
            <option value="push_to_talk">按住说话</option>
          </select>
        </label>
        <p className={styles["feedback"]} role={error ? "alert" : "status"}>
          {error ?? feedback}
        </p>
        <div className={styles["actions"]}>
          <button
            className={styles["primary"]}
            disabled={busy || !hasSelectedProfile}
            type="submit"
          >
            保存
          </button>
        </div>
      </form>
    </section>
  );
}
