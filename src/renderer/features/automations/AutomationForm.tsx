import { Bell, Bot, CalendarClock, MessageCircle, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import type {
  Automation,
  AutomationDefinition,
  AutomationSchedule,
  AutomationToolScope,
} from "../../../shared/contracts/automation";
import styles from "./AutomationsPage.module.css";

export interface AutomationModelOption {
  readonly label: string;
  readonly modelId: string;
  readonly providerProfileId: string;
}

export interface AutomationPersonaOption {
  readonly id: string;
  readonly label: string;
}

interface AutomationFormProps {
  readonly automation?: Automation;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly models: readonly AutomationModelOption[];
  readonly onCancel: () => void;
  readonly onSubmit: (definition: AutomationDefinition) => void;
  readonly personas: readonly AutomationPersonaOption[];
}

type ScheduleKind = AutomationSchedule["kind"];

interface AutomationDraft {
  readonly approvalMode: "request_approval" | "auto_approve" | "full_access";
  readonly cronExpression: string;
  readonly delivery: "bubble" | "bubble_and_voice";
  readonly executionMode: "chat" | "agent";
  readonly localTime: string;
  readonly modelKey: string;
  readonly name: string;
  readonly personaId: string;
  readonly runAtLocal: string;
  readonly scheduleKind: ScheduleKind;
  readonly taskKind: "reminder" | "agent_task";
  readonly text: string;
  readonly timeZone: string;
  readonly toolScope: AutomationToolScope;
  readonly weekdays: readonly number[];
}

const weekdayOptions = [
  { label: "一", value: 1 },
  { label: "二", value: 2 },
  { label: "三", value: 3 },
  { label: "四", value: 4 },
  { label: "五", value: 5 },
  { label: "六", value: 6 },
  { label: "日", value: 7 },
] as const;

function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function modelKey(option: AutomationModelOption): string {
  return `${option.providerProfileId}\u001f${option.modelId}`;
}

function toLocalDateTime(timestamp: string): string {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) return "";
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function initialDraft(
  automation: Automation | undefined,
  models: readonly AutomationModelOption[],
  personas: readonly AutomationPersonaOption[],
): AutomationDraft {
  const definition = automation?.definition;
  const schedule = definition?.schedule;
  const task = definition?.task;
  const agentTask = task?.kind === "agent_task" ? task : undefined;
  const timeZone =
    schedule && schedule.kind !== "once"
      ? schedule.timeZone
      : currentTimeZone();

  return {
    approvalMode:
      agentTask?.execution.mode === "agent"
        ? agentTask.execution.approvalMode
        : "request_approval",
    cronExpression: schedule?.kind === "cron" ? schedule.expression : "",
    delivery: task?.kind === "reminder" ? task.delivery : "bubble",
    executionMode: agentTask?.execution.mode ?? "chat",
    localTime:
      schedule?.kind === "daily" || schedule?.kind === "weekly"
        ? schedule.localTime
        : "",
    modelKey: agentTask
      ? modelKey({
          label: agentTask.modelId,
          modelId: agentTask.modelId,
          providerProfileId: agentTask.providerProfileId,
        })
      : models[0]
        ? modelKey(models[0])
        : "",
    name: definition?.name ?? "",
    personaId: agentTask?.personaId ?? personas[0]?.id ?? "",
    runAtLocal:
      schedule?.kind === "once" ? toLocalDateTime(schedule.runAt) : "",
    scheduleKind: schedule?.kind ?? "once",
    taskKind: task?.kind ?? "agent_task",
    text:
      task?.kind === "agent_task"
        ? task.goal
        : task?.kind === "reminder"
          ? task.message
          : "",
    timeZone,
    toolScope: agentTask?.toolScope ?? { mode: "all_allowed" },
    weekdays: schedule?.kind === "weekly" ? schedule.weekdays : [],
  };
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function buildDefinition(
  draft: AutomationDraft,
  models: readonly AutomationModelOption[],
): { readonly definition?: AutomationDefinition; readonly error?: string } {
  const name = draft.name.trim();
  const text = draft.text.trim();
  if (!name) return { error: "请为任务填写名称。" };
  if (!text) {
    return {
      error:
        draft.taskKind === "reminder"
          ? "请填写提醒内容。"
          : "请填写要完成的目标。",
    };
  }

  let schedule: AutomationSchedule;
  if (draft.scheduleKind === "once") {
    const runAt = new Date(draft.runAtLocal);
    if (!draft.runAtLocal || !Number.isFinite(runAt.getTime())) {
      return { error: "请选择有效的运行时间。" };
    }
    schedule = { kind: "once", runAt: runAt.toISOString() };
  } else {
    const timeZone = draft.timeZone.trim();
    if (!timeZone || !isTimeZone(timeZone)) {
      return { error: "请输入有效的 IANA 时区，例如 Asia/Shanghai。" };
    }
    if (draft.scheduleKind === "cron") {
      const expression = draft.cronExpression.trim().replace(/\s+/gu, " ");
      if (expression.split(" ").length !== 5) {
        return { error: "Cron 需要且只接受五个调度字段。" };
      }
      schedule = {
        dialect: "posix-5-field",
        expression,
        kind: "cron",
        timeZone,
      };
    } else {
      if (!/^\d{2}:\d{2}$/u.test(draft.localTime)) {
        return { error: "请选择有效的本地时间。" };
      }
      if (draft.scheduleKind === "weekly") {
        if (draft.weekdays.length === 0) {
          return { error: "每周任务至少选择一天。" };
        }
        schedule = {
          kind: "weekly",
          localTime: draft.localTime,
          timeZone,
          weekdays: [...draft.weekdays].sort((left, right) => left - right),
        };
      } else {
        schedule = {
          kind: "daily",
          localTime: draft.localTime,
          timeZone,
        };
      }
    }
  }

  if (draft.taskKind === "reminder") {
    return {
      definition: {
        name,
        schedule,
        task: {
          delivery: draft.delivery,
          kind: "reminder",
          message: text,
        },
      },
    };
  }

  const model = models.find(
    (candidate) => modelKey(candidate) === draft.modelKey,
  );
  if (!model) {
    return { error: "请先在 Settings → Models 配置可用的 Chat 模型。" };
  }
  if (!draft.personaId) {
    return { error: "当前没有可用角色，暂时无法创建 Agent Task。" };
  }

  return {
    definition: {
      name,
      schedule,
      task: {
        execution:
          draft.executionMode === "chat"
            ? { mode: "chat" }
            : {
                approvalMode: draft.approvalMode,
                mode: "agent",
              },
        goal: text,
        kind: "agent_task",
        modelId: model.modelId,
        personaId: draft.personaId,
        providerProfileId: model.providerProfileId,
        toolScope: draft.toolScope,
      },
    },
  };
}

export function AutomationForm({
  automation,
  busy,
  error,
  models,
  onCancel,
  onSubmit,
  personas,
}: AutomationFormProps) {
  const allModels = useMemo(() => {
    const task = automation?.definition.task;
    if (task?.kind !== "agent_task") return models;
    const key = modelKey({
      label: task.modelId,
      modelId: task.modelId,
      providerProfileId: task.providerProfileId,
    });
    if (models.some((option) => modelKey(option) === key)) return models;
    return [
      ...models,
      {
        label: `${task.modelId} · 已保存配置`,
        modelId: task.modelId,
        providerProfileId: task.providerProfileId,
      },
    ];
  }, [automation, models]);
  const allPersonas = useMemo(() => {
    const task = automation?.definition.task;
    if (
      task?.kind !== "agent_task" ||
      personas.some(({ id }) => id === task.personaId)
    ) {
      return personas;
    }
    return [...personas, { id: task.personaId, label: "已保存角色" }];
  }, [automation, personas]);
  const [draft, setDraft] = useState(() =>
    initialDraft(automation, allModels, allPersonas),
  );
  const [validationError, setValidationError] = useState<string | undefined>();

  const update = <TKey extends keyof AutomationDraft>(
    key: TKey,
    value: AutomationDraft[TKey],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setValidationError(undefined);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const result = buildDefinition(draft, allModels);
    if (!result.definition) {
      setValidationError(result.error);
      return;
    }
    onSubmit(result.definition);
  };

  return (
    <section
      aria-label={automation ? "编辑定时任务" : "新建定时任务"}
      className={styles["formPanel"]}
    >
      <header className={styles["panelHeader"]}>
        <div>
          <span>{automation ? `Revision ${automation.revision}` : "New"}</span>
          <h2>{automation ? "编辑任务" : "新建任务"}</h2>
        </div>
        <button type="button" aria-label="关闭表单" onClick={onCancel}>
          <X aria-hidden="true" size={16} />
        </button>
      </header>

      <form className={styles["automationForm"]} onSubmit={submit}>
        <label className={styles["field"]}>
          <span>名称</span>
          <input
            autoFocus
            value={draft.name}
            placeholder="例如：每周项目回顾"
            onChange={(event) => update("name", event.currentTarget.value)}
          />
        </label>

        <fieldset className={styles["choiceGroup"]}>
          <legend>任务类型</legend>
          <label data-selected={draft.taskKind === "agent_task" || undefined}>
            <input
              checked={draft.taskKind === "agent_task"}
              name="automation-task-kind"
              type="radio"
              onChange={() => update("taskKind", "agent_task")}
            />
            <Bot aria-hidden="true" size={16} />
            <span>
              <strong>运行目标</strong>
              <small>创建普通 Chat Run，并保留完整过程</small>
            </span>
          </label>
          <label data-selected={draft.taskKind === "reminder" || undefined}>
            <input
              checked={draft.taskKind === "reminder"}
              name="automation-task-kind"
              type="radio"
              onChange={() => update("taskKind", "reminder")}
            />
            <Bell aria-hidden="true" size={16} />
            <span>
              <strong>提醒</strong>
              <small>到时通过桌宠气泡通知你</small>
            </span>
          </label>
        </fieldset>

        <label className={styles["field"]}>
          <span>{draft.taskKind === "reminder" ? "提醒内容" : "目标"}</span>
          <textarea
            rows={4}
            value={draft.text}
            placeholder={
              draft.taskKind === "reminder"
                ? "到时想收到什么提醒？"
                : "希望 CharaMate 到时完成什么？"
            }
            onChange={(event) => update("text", event.currentTarget.value)}
          />
        </label>

        {draft.taskKind === "reminder" ? (
          <label className={styles["checkboxRow"]}>
            <input
              checked={draft.delivery === "bubble_and_voice"}
              type="checkbox"
              onChange={(event) =>
                update(
                  "delivery",
                  event.currentTarget.checked ? "bubble_and_voice" : "bubble",
                )
              }
            />
            <span>
              <strong>同时语音播报</strong>
              <small>仍会保留桌宠气泡</small>
            </span>
          </label>
        ) : (
          <>
            <fieldset className={styles["modePicker"]}>
              <legend>运行模式</legend>
              <label
                data-selected={draft.executionMode === "chat" || undefined}
              >
                <input
                  checked={draft.executionMode === "chat"}
                  name="automation-execution-mode"
                  type="radio"
                  onChange={() => update("executionMode", "chat")}
                />
                <MessageCircle aria-hidden="true" size={14} />
                Chat
              </label>
              <label
                data-selected={draft.executionMode === "agent" || undefined}
              >
                <input
                  checked={draft.executionMode === "agent"}
                  name="automation-execution-mode"
                  type="radio"
                  onChange={() => update("executionMode", "agent")}
                />
                <Bot aria-hidden="true" size={14} />
                Agent
              </label>
            </fieldset>

            {draft.executionMode === "agent" ? (
              <label className={styles["field"]}>
                <span>执行权限</span>
                <select
                  aria-label="执行权限"
                  value={draft.approvalMode}
                  onChange={(event) =>
                    update(
                      "approvalMode",
                      event.currentTarget
                        .value as AutomationDraft["approvalMode"],
                    )
                  }
                >
                  <option value="request_approval">请求批准</option>
                  <option value="auto_approve">替我审批</option>
                  <option value="full_access">完全访问</option>
                </select>
                <small>每次运行都会保存这一权限快照。</small>
              </label>
            ) : null}

            <div className={styles["fieldGrid"]}>
              <label className={styles["field"]}>
                <span>模型</span>
                <select
                  aria-label="模型"
                  value={draft.modelKey}
                  onChange={(event) =>
                    update("modelKey", event.currentTarget.value)
                  }
                >
                  {allModels.length === 0 ? (
                    <option value="">没有可用模型</option>
                  ) : null}
                  {allModels.map((option) => (
                    <option key={modelKey(option)} value={modelKey(option)}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles["field"]}>
                <span>角色</span>
                <select
                  aria-label="角色"
                  value={draft.personaId}
                  onChange={(event) =>
                    update("personaId", event.currentTarget.value)
                  }
                >
                  {allPersonas.map((persona) => (
                    <option key={persona.id} value={persona.id}>
                      {persona.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </>
        )}

        <section className={styles["scheduleSection"]}>
          <div className={styles["sectionTitle"]}>
            <CalendarClock aria-hidden="true" size={15} />
            <span>
              <strong>时间</strong>
              <small>重复计划始终按显式时区解释</small>
            </span>
          </div>
          <label className={styles["field"]}>
            <span>重复方式</span>
            <select
              aria-label="重复方式"
              value={draft.scheduleKind}
              onChange={(event) =>
                update(
                  "scheduleKind",
                  event.currentTarget.value as ScheduleKind,
                )
              }
            >
              <option value="once">一次</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="cron">Cron</option>
            </select>
          </label>

          {draft.scheduleKind === "once" ? (
            <label className={styles["field"]}>
              <span>运行时间</span>
              <input
                aria-label="运行时间"
                type="datetime-local"
                value={draft.runAtLocal}
                onChange={(event) =>
                  update("runAtLocal", event.currentTarget.value)
                }
              />
            </label>
          ) : draft.scheduleKind === "cron" ? (
            <label className={styles["field"]}>
              <span>POSIX 五段 Cron</span>
              <input
                aria-label="POSIX 五段 Cron"
                spellCheck={false}
                value={draft.cronExpression}
                placeholder="0 9 * * 1-5"
                onChange={(event) =>
                  update("cronExpression", event.currentTarget.value)
                }
              />
              <small>依次为分钟、小时、日、月、星期；不接受命令字段。</small>
            </label>
          ) : (
            <label className={styles["field"]}>
              <span>本地时间</span>
              <input
                aria-label="本地时间"
                type="time"
                value={draft.localTime}
                onChange={(event) =>
                  update("localTime", event.currentTarget.value)
                }
              />
            </label>
          )}

          {draft.scheduleKind === "weekly" ? (
            <fieldset className={styles["weekdayPicker"]}>
              <legend>星期</legend>
              {weekdayOptions.map((weekday) => (
                <label
                  key={weekday.value}
                  data-selected={
                    draft.weekdays.includes(weekday.value) || undefined
                  }
                >
                  <input
                    checked={draft.weekdays.includes(weekday.value)}
                    type="checkbox"
                    onChange={(event) =>
                      update(
                        "weekdays",
                        event.currentTarget.checked
                          ? [...draft.weekdays, weekday.value]
                          : draft.weekdays.filter(
                              (value) => value !== weekday.value,
                            ),
                      )
                    }
                  />
                  {weekday.label}
                </label>
              ))}
            </fieldset>
          ) : null}

          {draft.scheduleKind === "once" ? null : (
            <label className={styles["field"]}>
              <span>时区</span>
              <input
                aria-label="时区"
                spellCheck={false}
                value={draft.timeZone}
                placeholder="Asia/Shanghai"
                onChange={(event) =>
                  update("timeZone", event.currentTarget.value)
                }
              />
            </label>
          )}
        </section>

        {validationError || error ? (
          <p className={styles["formError"]} role="alert">
            {validationError ?? error}
          </p>
        ) : null}

        <footer className={styles["formActions"]}>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className={styles["primaryButton"]}
            disabled={busy}
            type="submit"
          >
            {busy ? "正在保存…" : automation ? "保存修改" : "创建任务"}
          </button>
        </footer>
      </form>
    </section>
  );
}
