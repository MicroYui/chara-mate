import {
  BellRing,
  Copy,
  FolderInput,
  LoaderCircle,
  Save,
  UserRound,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";

import type {
  PersonaApi,
  PersonaLibrarySnapshot,
  PersonaRevisionInput,
  PersonaSnapshot,
  PersonaVoice,
} from "../../../shared/contracts/persona";
import type {
  PetDescriptor,
  PetLibrarySnapshot,
  PetManagementApi,
} from "../../../shared/contracts/pet";
import type {
  CompanionInitiativeSettings,
  SettingsApi,
} from "../../../shared/contracts/settings";
import styles from "./CharacterSettingsPanel.module.css";

interface CharacterSettingsPanelProps {
  readonly api?: PetManagementApi;
  readonly personaApi?: PersonaApi;
  readonly settingsApi?: SettingsApi;
}

const voices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const satisfies readonly PersonaVoice[];

function sliderStyle(value: number, minimum: number): CSSProperties {
  const progress = Math.min(
    100,
    Math.max(0, ((value - minimum) / (1.5 - minimum)) * 100),
  );
  return {
    "--range-progress": `${String(progress)}%`,
  } as CSSProperties;
}

function revisionInput(snapshot: PersonaSnapshot): PersonaRevisionInput {
  return {
    addressStyle: snapshot.addressStyle,
    background: snapshot.background,
    defaultVoice: snapshot.defaultVoice,
    disabledExpressions: snapshot.disabledExpressions,
    displayName: snapshot.displayName,
    identity: snapshot.identity,
    initiativeStyle: snapshot.initiativeStyle,
    knowledgeBoundary: snapshot.knowledgeBoundary,
    motivations: snapshot.motivations,
    speechStyle: snapshot.speechStyle,
    styleName: snapshot.styleName,
    values: snapshot.values,
    voiceInstructions: snapshot.voiceInstructions,
  };
}

function minuteToTime(value: number): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function timeToMinute(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function PetPreview({ pet }: { readonly pet: PetDescriptor }) {
  const rows = pet.spriteVersionNumber === 2 ? 11 : 9;
  const style = {
    backgroundImage: `url("${pet.spriteUrl}")`,
    backgroundSize: `800% ${String(rows * 100)}%`,
  } satisfies CSSProperties;
  return (
    <span aria-hidden="true" className={styles["preview"]} style={style} />
  );
}

export function CharacterSettingsPanel({
  api = window.charaMate.pet,
  personaApi = window.charaMate.persona,
  settingsApi = window.charaMate.settings,
}: CharacterSettingsPanelProps) {
  const [library, setLibrary] = useState<PetLibrarySnapshot | null>(null);
  const [personaLibrary, setPersonaLibrary] =
    useState<PersonaLibrarySnapshot | null>(null);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>();
  const [personaDraft, setPersonaDraft] = useState<PersonaRevisionInput | null>(
    null,
  );
  const [petError, setPetError] = useState<string | null>(null);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const [personaFeedback, setPersonaFeedback] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [personaBusy, setPersonaBusy] = useState(false);
  const [initiativeDraft, setInitiativeDraft] =
    useState<CompanionInitiativeSettings | null>(null);
  const [initiativeBusy, setInitiativeBusy] = useState(false);
  const [initiativeError, setInitiativeError] = useState<string | null>(null);
  const [initiativeFeedback, setInitiativeFeedback] = useState<string>();
  const selectedPersonaIdRef = useRef<string | undefined>(undefined);
  const scaleRequest = useRef(0);
  const speedRequest = useRef(0);

  const receivePersonaLibrary = useCallback(
    (snapshot: PersonaLibrarySnapshot, preferredPersonaId?: string) => {
      const candidateId = preferredPersonaId ?? selectedPersonaIdRef.current;
      const nextPersonaId =
        candidateId &&
        snapshot.personas.some(
          ({ snapshot: persona }) => persona.personaId === candidateId,
        )
          ? candidateId
          : snapshot.activePersonaId;
      const nextPersona = snapshot.personas.find(
        ({ snapshot: persona }) => persona.personaId === nextPersonaId,
      );
      selectedPersonaIdRef.current = nextPersonaId;
      setPersonaLibrary(snapshot);
      setSelectedPersonaId(nextPersonaId);
      setPersonaDraft(nextPersona ? revisionInput(nextPersona.snapshot) : null);
      setPersonaError(null);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const receive = (snapshot: PersonaLibrarySnapshot) => {
      if (!active) return;
      receivePersonaLibrary(snapshot);
    };
    const unsubscribe = personaApi.subscribeChanged(receive);
    void personaApi
      .getLibrary()
      .then((response) => {
        if (!active) return;
        if (response.ok) receive(response.value);
        else setPersonaError(response.error.message);
      })
      .catch((cause: unknown) => {
        if (active) {
          setPersonaError(
            cause instanceof Error ? cause.message : "无法读取 Persona 列表。",
          );
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [personaApi, receivePersonaLibrary]);

  const selectedPersona = personaLibrary?.personas.find(
    ({ snapshot }) => snapshot.personaId === selectedPersonaId,
  );

  useEffect(() => {
    let active = true;
    const unsubscribe = api.subscribeChanged((snapshot) => {
      if (active) {
        setLibrary(snapshot);
        setPetError(null);
      }
    });
    void api
      .getLibrary()
      .then((response) => {
        if (!active) return;
        if (response.ok) setLibrary(response.value);
        else setPetError(response.error.message);
      })
      .catch((cause: unknown) => {
        if (active) {
          setPetError(
            cause instanceof Error ? cause.message : "无法读取桌宠列表。",
          );
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    let active = true;
    void settingsApi
      .getSnapshot()
      .then((response) => {
        if (!active) return;
        if (response.ok) setInitiativeDraft(response.value.companionInitiative);
        else setInitiativeError(response.error.message);
      })
      .catch((cause: unknown) => {
        if (active) {
          setInitiativeError(
            cause instanceof Error ? cause.message : "无法读取主动陪伴设置。",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [settingsApi]);

  const selectPersona = async (personaId: string) => {
    setPersonaBusy(true);
    setPersonaError(null);
    setPersonaFeedback(undefined);
    try {
      const response = await personaApi.select({ personaId });
      if (!response.ok) setPersonaError(response.error.message);
      else {
        receivePersonaLibrary(response.value, personaId);
        setPersonaFeedback("新回答将使用这个 Persona，历史内容保持不变。");
      }
    } catch (cause: unknown) {
      setPersonaError(
        cause instanceof Error ? cause.message : "切换 Persona 失败。",
      );
    } finally {
      setPersonaBusy(false);
    }
  };

  const copyPersona = async (source: PersonaSnapshot) => {
    if (!personaLibrary) return;
    setPersonaBusy(true);
    setPersonaError(null);
    setPersonaFeedback(undefined);
    const existingIds = new Set(
      personaLibrary.personas.map(({ snapshot }) => snapshot.personaId),
    );
    try {
      const copied = await personaApi.copy({
        displayName: `${source.displayName} 自定义`,
        sourcePersonaId: source.personaId,
        styleName: `${source.styleName} 自定义`,
      });
      if (!copied.ok) {
        setPersonaError(copied.error.message);
        return;
      }
      const created = copied.value.personas.find(
        ({ kind, snapshot }) =>
          kind === "custom" && !existingIds.has(snapshot.personaId),
      );
      receivePersonaLibrary(
        copied.value,
        created?.snapshot.personaId ?? selectedPersonaId,
      );
      if (!created) {
        setPersonaFeedback("已创建自定义 Persona。");
        return;
      }
      const selected = await personaApi.select({
        personaId: created.snapshot.personaId,
      });
      if (selected.ok) {
        receivePersonaLibrary(selected.value, created.snapshot.personaId);
        setPersonaFeedback("已创建副本，可以直接编辑。");
      } else setPersonaError(selected.error.message);
    } catch (cause: unknown) {
      setPersonaError(
        cause instanceof Error ? cause.message : "复制 Persona 失败。",
      );
    } finally {
      setPersonaBusy(false);
    }
  };

  const savePersona = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPersona || !personaDraft || selectedPersona.kind !== "custom")
      return;
    setPersonaBusy(true);
    setPersonaError(null);
    setPersonaFeedback(undefined);
    try {
      const response = await personaApi.update({
        expectedRevision: selectedPersona.snapshot.revision,
        personaId: selectedPersona.snapshot.personaId,
        value: personaDraft,
      });
      if (!response.ok) setPersonaError(response.error.message);
      else {
        receivePersonaLibrary(
          response.value,
          selectedPersona.snapshot.personaId,
        );
        setPersonaFeedback("Persona 已保存；正在进行的回答仍使用启动时快照。");
      }
    } catch (cause: unknown) {
      setPersonaError(
        cause instanceof Error ? cause.message : "保存 Persona 失败。",
      );
    } finally {
      setPersonaBusy(false);
    }
  };

  const importPet = () => {
    setImporting(true);
    setPetError(null);
    void api
      .importFromFolder()
      .then((response) => {
        if (!response.ok) setPetError(response.error.message);
      })
      .catch((cause: unknown) => {
        setPetError(cause instanceof Error ? cause.message : "导入桌宠失败。");
      })
      .finally(() => setImporting(false));
  };

  const selectPet = (petId: string) => {
    setPetError(null);
    void api
      .select({ petId })
      .then((response) => {
        if (response.ok) setLibrary(response.value);
        else setPetError(response.error.message);
      })
      .catch((cause: unknown) => {
        setPetError(cause instanceof Error ? cause.message : "切换桌宠失败。");
      });
  };

  const setScale = (scale: number) => {
    const request = ++scaleRequest.current;
    setLibrary((current) => (current ? { ...current, scale } : current));
    setPetError(null);
    void api
      .setScale({ scale })
      .then((response) => {
        if (request !== scaleRequest.current) return;
        if (response.ok) setLibrary(response.value);
        else setPetError(response.error.message);
      })
      .catch((cause: unknown) => {
        if (request === scaleRequest.current) {
          setPetError(
            cause instanceof Error ? cause.message : "调整桌宠大小失败。",
          );
        }
      });
  };

  const setAnimationSpeed = (animationSpeed: number) => {
    const request = ++speedRequest.current;
    setLibrary((current) =>
      current ? { ...current, animationSpeed } : current,
    );
    setPetError(null);
    void api
      .setAnimationSpeed({ animationSpeed })
      .then((response) => {
        if (request !== speedRequest.current) return;
        if (response.ok) setLibrary(response.value);
        else setPetError(response.error.message);
      })
      .catch((cause: unknown) => {
        if (request === speedRequest.current) {
          setPetError(
            cause instanceof Error ? cause.message : "调整动画速度失败。",
          );
        }
      });
  };

  const saveInitiativeSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!initiativeDraft) return;
    setInitiativeBusy(true);
    setInitiativeError(null);
    setInitiativeFeedback(undefined);
    try {
      const response = await settingsApi.saveCompanionInitiative({
        companionInitiative: initiativeDraft,
      });
      if (response.ok) {
        setInitiativeDraft(response.value);
        setInitiativeFeedback("主动陪伴设置已保存。");
      } else setInitiativeError(response.error.message);
    } catch (cause: unknown) {
      setInitiativeError(
        cause instanceof Error ? cause.message : "保存主动陪伴设置失败。",
      );
    } finally {
      setInitiativeBusy(false);
    }
  };

  return (
    <section className={styles["panel"]}>
      <div className={styles["personaSection"]}>
        <div className={styles["sectionHeading"]}>
          <span className={styles["sectionIcon"]}>
            <UserRound aria-hidden="true" size={17} />
          </span>
          <div>
            <p className={styles["eyebrow"]}>Persona</p>
            <h2>角色人格</h2>
            <p className={styles["summary"]}>
              选择预设，或复制后调整表达、主动方式与默认语音。
            </p>
          </div>
        </div>

        {personaError ? (
          <div className={styles["error"]} role="alert">
            {personaError}
          </div>
        ) : null}

        {!personaLibrary ? (
          <p className={styles["loading"]}>正在读取 Persona…</p>
        ) : (
          <div className={styles["personaWorkspace"]}>
            <ul className={styles["personaList"]} aria-label="Persona 列表">
              {personaLibrary.personas.map((record) => {
                const active =
                  personaLibrary.activePersonaId === record.snapshot.personaId;
                const selected =
                  selectedPersonaId === record.snapshot.personaId;
                return (
                  <li key={record.snapshot.personaId}>
                    <button
                      aria-current={selected ? "true" : undefined}
                      className={styles["personaChoice"]}
                      data-active={active || undefined}
                      type="button"
                      onClick={() => {
                        selectedPersonaIdRef.current =
                          record.snapshot.personaId;
                        setSelectedPersonaId(record.snapshot.personaId);
                        setPersonaDraft(revisionInput(record.snapshot));
                      }}
                    >
                      <strong>{record.snapshot.displayName}</strong>
                      <span>{record.snapshot.styleName}</span>
                      <small>
                        {active
                          ? "正在使用"
                          : record.kind === "preset"
                            ? "预设"
                            : "自定义"}
                      </small>
                    </button>
                  </li>
                );
              })}
            </ul>

            {selectedPersona && personaDraft ? (
              <div className={styles["personaEditor"]}>
                <div className={styles["personaEditorHeader"]}>
                  <div>
                    <strong>{selectedPersona.snapshot.displayName}</strong>
                    <span>{selectedPersona.snapshot.styleName}</span>
                  </div>
                  <div className={styles["personaActions"]}>
                    {personaLibrary.activePersonaId !==
                    selectedPersona.snapshot.personaId ? (
                      <button
                        disabled={personaBusy}
                        type="button"
                        onClick={() =>
                          void selectPersona(selectedPersona.snapshot.personaId)
                        }
                      >
                        使用这个 Persona
                      </button>
                    ) : null}
                    {selectedPersona.kind === "preset" ? (
                      <button
                        disabled={personaBusy}
                        type="button"
                        onClick={() =>
                          void copyPersona(selectedPersona.snapshot)
                        }
                      >
                        <Copy aria-hidden="true" size={14} />
                        复制并编辑
                      </button>
                    ) : null}
                  </div>
                </div>

                {selectedPersona.kind === "preset" ? (
                  <div className={styles["personaPreview"]}>
                    <p>{selectedPersona.snapshot.identity}</p>
                    <dl>
                      <div>
                        <dt>表达</dt>
                        <dd>{selectedPersona.snapshot.speechStyle}</dd>
                      </div>
                      <div>
                        <dt>主动方式</dt>
                        <dd>{selectedPersona.snapshot.initiativeStyle}</dd>
                      </div>
                      <div>
                        <dt>默认音色</dt>
                        <dd>{selectedPersona.snapshot.defaultVoice}</dd>
                      </div>
                    </dl>
                    <small>预设保持只读；复制后可完整调整。</small>
                  </div>
                ) : (
                  <form
                    className={styles["personaForm"]}
                    onSubmit={(event) => void savePersona(event)}
                  >
                    <div className={styles["personaGrid"]}>
                      <label>
                        名称
                        <input
                          required
                          value={personaDraft.displayName}
                          onChange={(event) => {
                            const displayName = event.currentTarget.value;
                            setPersonaDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    displayName,
                                  }
                                : current,
                            );
                          }}
                        />
                      </label>
                      <label>
                        风格名称
                        <input
                          required
                          value={personaDraft.styleName}
                          onChange={(event) => {
                            const styleName = event.currentTarget.value;
                            setPersonaDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    styleName,
                                  }
                                : current,
                            );
                          }}
                        />
                      </label>
                      <label>
                        默认音色
                        <select
                          value={personaDraft.defaultVoice}
                          onChange={(event) => {
                            const defaultVoice = event.currentTarget
                              .value as PersonaVoice;
                            setPersonaDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    defaultVoice,
                                  }
                                : current,
                            );
                          }}
                        >
                          {voices.map((voice) => (
                            <option key={voice} value={voice}>
                              {voice}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {(
                      [
                        ["identity", "角色定位"],
                        ["background", "背景"],
                        ["motivations", "动机"],
                        ["values", "价值观"],
                        ["speechStyle", "说话风格"],
                        ["addressStyle", "称呼方式"],
                        ["initiativeStyle", "主动方式"],
                        ["knowledgeBoundary", "事实边界"],
                        ["voiceInstructions", "语音 instructions"],
                      ] as const
                    ).map(([field, label]) => (
                      <label key={field}>
                        {label}
                        <textarea
                          required
                          value={personaDraft[field]}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setPersonaDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    [field]: value,
                                  }
                                : current,
                            );
                          }}
                        />
                      </label>
                    ))}
                    <label>
                      禁用表达（每行一条）
                      <textarea
                        value={personaDraft.disabledExpressions.join("\n")}
                        onChange={(event) => {
                          const disabledExpressions = event.currentTarget.value
                            .split("\n")
                            .map((value) => value.trim())
                            .filter(Boolean);
                          setPersonaDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  disabledExpressions,
                                }
                              : current,
                          );
                        }}
                      />
                    </label>
                    <button
                      className={styles["savePersona"]}
                      disabled={personaBusy}
                      type="submit"
                    >
                      <Save aria-hidden="true" size={14} />
                      {personaBusy ? "保存中…" : "保存 Persona"}
                    </button>
                  </form>
                )}
              </div>
            ) : null}
          </div>
        )}
        {personaFeedback ? (
          <p className={styles["feedback"]} role="status">
            {personaFeedback}
          </p>
        ) : null}
      </div>

      <div className={styles["initiativeSection"]}>
        <div className={styles["sectionHeading"]}>
          <span className={styles["sectionIcon"]}>
            <BellRing aria-hidden="true" size={17} />
          </span>
          <div>
            <p className={styles["eyebrow"]}>Initiative</p>
            <h2>主动陪伴</h2>
            <p className={styles["summary"]}>
              主动程度控制未请求搭话的频率；安静时段也适用于重要时刻联系。你明确约定的跟进不受影响。
            </p>
          </div>
        </div>

        {initiativeError ? (
          <div className={styles["error"]} role="alert">
            {initiativeError}
          </div>
        ) : null}

        {!initiativeDraft ? (
          <p className={styles["loading"]}>正在读取主动陪伴设置…</p>
        ) : (
          <form
            className={styles["initiativeForm"]}
            onSubmit={(event) => void saveInitiativeSettings(event)}
          >
            <label>
              主动程度
              <select
                aria-label="主动程度"
                value={initiativeDraft.level}
                onChange={(event) => {
                  const level = event.currentTarget
                    .value as CompanionInitiativeSettings["level"];
                  setInitiativeDraft((current) =>
                    current ? { ...current, level } : current,
                  );
                }}
              >
                <option value="off">关闭</option>
                <option value="quiet">安静</option>
                <option value="balanced">平衡</option>
                <option value="lively">活跃</option>
              </select>
            </label>
            <label className={styles["initiativeToggle"]}>
              <input
                aria-label="重要时刻主动联系我"
                checked={initiativeDraft.importantMomentOutreachEnabled}
                type="checkbox"
                onChange={(event) => {
                  const importantMomentOutreachEnabled =
                    event.currentTarget.checked;
                  setInitiativeDraft((current) =>
                    current
                      ? {
                          ...current,
                          importantMomentOutreachEnabled,
                          importantMomentOutreachPrompted: true,
                        }
                      : current,
                  );
                }}
              />
              <span>重要时刻主动联系我</span>
            </label>
            <p className={styles["initiativeHint"]}>
              只对你明确说过、时间明确且尚未发生的重要事情形成一次重新判断的机会；不保证发送，也不会创建闹钟。
            </p>
            <label className={styles["initiativeToggle"]}>
              <input
                aria-label="偶尔为重要时刻准备领地惊喜"
                checked={initiativeDraft.territoryMomentSurprisesEnabled}
                type="checkbox"
                onChange={(event) => {
                  const territoryMomentSurprisesEnabled =
                    event.currentTarget.checked;
                  setInitiativeDraft((current) =>
                    current
                      ? {
                          ...current,
                          territoryMomentSurprisesEnabled,
                          territoryMomentSurprisesPrompted: true,
                        }
                      : current,
                  );
                }}
              />
              <span>偶尔为重要时刻准备领地惊喜</span>
            </label>
            <p className={styles["initiativeHint"]}>
              只会准备一个待你确认的领地预览；表达形式由桌宠根据经历判断，不会自动修改领地。
            </p>
            <label className={styles["initiativeToggle"]}>
              <input
                aria-label="启用安静时段"
                checked={initiativeDraft.quietHours.enabled}
                type="checkbox"
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  setInitiativeDraft((current) =>
                    current
                      ? {
                          ...current,
                          quietHours: { ...current.quietHours, enabled },
                        }
                      : current,
                  );
                }}
              />
              <span>启用安静时段</span>
            </label>
            <div className={styles["initiativeTimes"]}>
              <label>
                从
                <input
                  aria-label="安静时段开始"
                  disabled={!initiativeDraft.quietHours.enabled}
                  type="time"
                  value={minuteToTime(initiativeDraft.quietHours.startMinute)}
                  onChange={(event) => {
                    const startMinute = timeToMinute(event.currentTarget.value);
                    setInitiativeDraft((current) =>
                      current
                        ? {
                            ...current,
                            quietHours: {
                              ...current.quietHours,
                              startMinute,
                            },
                          }
                        : current,
                    );
                  }}
                />
              </label>
              <label>
                到
                <input
                  aria-label="安静时段结束"
                  disabled={!initiativeDraft.quietHours.enabled}
                  type="time"
                  value={minuteToTime(initiativeDraft.quietHours.endMinute)}
                  onChange={(event) => {
                    const endMinute = timeToMinute(event.currentTarget.value);
                    setInitiativeDraft((current) =>
                      current
                        ? {
                            ...current,
                            quietHours: {
                              ...current.quietHours,
                              endMinute,
                            },
                          }
                        : current,
                    );
                  }}
                />
              </label>
            </div>
            <p className={styles["initiativeHint"]}>
              关闭或忽略邀请后，下一次会自动更晚；回复后恢复当前档位。
            </p>
            <button
              className={styles["savePersona"]}
              disabled={
                initiativeBusy ||
                (initiativeDraft.quietHours.enabled &&
                  initiativeDraft.quietHours.startMinute ===
                    initiativeDraft.quietHours.endMinute)
              }
              type="submit"
            >
              <Save aria-hidden="true" size={14} />
              {initiativeBusy ? "保存中…" : "保存主动陪伴"}
            </button>
          </form>
        )}
        {initiativeFeedback ? (
          <p className={styles["feedback"]} role="status">
            {initiativeFeedback}
          </p>
        ) : null}
      </div>

      <div className={styles["petSection"]}>
        <div className={styles["headingRow"]}>
          <div>
            <p className={styles["eyebrow"]}>Desktop Pet</p>
            <h2>桌面形象</h2>
            <p className={styles["summary"]}>
              选择当前桌宠，或导入 Codex v1/v2 角色资源。
            </p>
          </div>
          <button type="button" disabled={importing} onClick={importPet}>
            {importing ? (
              <LoaderCircle aria-hidden="true" className={styles["spinner"]} />
            ) : (
              <FolderInput aria-hidden="true" />
            )}
            {importing ? "正在导入…" : "导入 Codex 桌宠"}
          </button>
        </div>

        {petError ? (
          <div className={styles["error"]} role="alert">
            {petError}
          </div>
        ) : null}

        {!library ? (
          <p className={styles["loading"]}>正在读取桌宠…</p>
        ) : library.pets.length === 0 ? (
          <div className={styles["empty"]}>
            <strong>还没有导入桌宠</strong>
            <span>选择一个包含 pet.json 与 spritesheet 的目录开始。</span>
          </div>
        ) : (
          <ul className={styles["petList"]} aria-label="已导入桌宠">
            {library.pets.map((pet) => {
              const selected = library.activePetId === pet.id;
              return (
                <li className={styles["petRow"]} key={pet.id}>
                  <PetPreview pet={pet} />
                  <div className={styles["petDetails"]}>
                    <div className={styles["petTitle"]}>
                      <strong>{pet.displayName}</strong>
                      <span>v{pet.spriteVersionNumber}</span>
                    </div>
                    <p>{pet.description}</p>
                    <small>
                      {pet.spriteWidth}×{pet.spriteHeight}
                    </small>
                  </div>
                  <button
                    aria-label={
                      selected
                        ? `${pet.displayName} 已选`
                        : `选择 ${pet.displayName}`
                    }
                    className={styles["selectButton"]}
                    disabled={selected}
                    type="button"
                    onClick={() => selectPet(pet.id)}
                  >
                    {selected ? "已选" : "选择"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {library ? (
          <div className={styles["controls"]}>
            <label className={styles["rangeField"]}>
              <span>桌宠大小</span>
              <input
                aria-label="桌宠大小"
                max="1.5"
                min="0.3"
                step="0.01"
                style={sliderStyle(library.scale, 0.3)}
                type="range"
                value={library.scale}
                onChange={(event) =>
                  setScale(Number(event.currentTarget.value))
                }
              />
            </label>
            <label className={styles["rangeField"]}>
              <span>动画速度</span>
              <input
                aria-label="动画速度"
                max="1.5"
                min="0.1"
                step="0.01"
                style={sliderStyle(library.animationSpeed, 0.1)}
                type="range"
                value={library.animationSpeed}
                onChange={(event) =>
                  setAnimationSpeed(Number(event.currentTarget.value))
                }
              />
            </label>
          </div>
        ) : null}
      </div>
    </section>
  );
}
