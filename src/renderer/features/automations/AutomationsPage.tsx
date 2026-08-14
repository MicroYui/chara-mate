import {
  AlertCircle,
  ArrowUpRight,
  Bell,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Automation,
  AutomationApi,
  AutomationDefinition,
  AutomationDetail,
  AutomationListItem,
  AutomationListSnapshot,
  AutomationRun,
  AutomationSchedule,
} from "../../../shared/contracts/automation";
import { runStatusPresentation } from "../../components/runStatus";
import {
  AutomationForm,
  type AutomationModelOption,
  type AutomationPersonaOption,
} from "./AutomationForm";
import styles from "./AutomationsPage.module.css";

interface AutomationsPageProps {
  readonly api?: AutomationApi;
  readonly createRequestToken?: number;
  readonly models?: readonly AutomationModelOption[];
  readonly now?: () => Date;
  readonly onOpenChatRun?: (chatId: string, runId?: string) => void;
  readonly personas?: readonly AutomationPersonaOption[];
}

type PanelState =
  | { readonly kind: "create" }
  | { readonly automationId: string; readonly kind: "detail" | "edit" }
  | null;

const weekdays = new Map<number, string>([
  [1, "周一"],
  [2, "周二"],
  [3, "周三"],
  [4, "周四"],
  [5, "周五"],
  [6, "周六"],
  [7, "周日"],
]);

function dateTimeLabel(timestamp: string, timeZone?: string): string {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) return timestamp;
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
  }).format(value);
}

function scheduleTimeZone(schedule: AutomationSchedule): string | undefined {
  return schedule.kind === "once" ? undefined : schedule.timeZone;
}

function scheduleLabel(schedule: AutomationSchedule): string {
  switch (schedule.kind) {
    case "once":
      return `一次 · ${dateTimeLabel(schedule.runAt)}`;
    case "daily":
      return `每天 ${schedule.localTime} · ${schedule.timeZone}`;
    case "weekly":
      return `${schedule.weekdays
        .map((weekday) => weekdays.get(weekday) ?? String(weekday))
        .join("、")} ${schedule.localTime} · ${schedule.timeZone}`;
    case "cron":
      return `Cron ${schedule.expression} · ${schedule.timeZone}`;
  }
}

function taskLabel(definition: AutomationDefinition): string {
  if (definition.task.kind === "reminder") {
    return definition.task.delivery === "bubble_and_voice"
      ? "提醒 · 气泡与语音"
      : "提醒 · 气泡";
  }
  if (definition.task.execution.mode === "chat") return "Chat Task";
  const approval = {
    auto_approve: "替我审批",
    full_access: "完全访问",
    request_approval: "请求批准",
  }[definition.task.execution.approvalMode];
  return `Agent Task · ${approval}`;
}

function automationStateLabel(automation: Automation): string {
  if (automation.state === "active") return "已启用";
  if (automation.state === "paused") return "已暂停";
  return "已结束";
}

function automationStateTone(
  automation: Automation,
): "accent" | "muted" | "success" {
  if (automation.state === "active") return "accent";
  if (automation.state === "paused") return "muted";
  return "success";
}

function runDescription(run: AutomationRun): string {
  if (run.status === "failed") return run.error.message;
  if (run.summary?.trim()) return run.summary.trim();
  if (run.status === "waiting_approval") return "等待你在 Chat 中确认后继续。";
  if (run.status === "needs_input") return "需要你在 Chat 中补充信息。";
  if (run.status === "running") return "正在对应 Chat 中运行。";
  if (run.status === "queued") return "已经进入运行队列。";
  if (run.status === "cancelled") return "这次运行已停止。";
  if (run.status === "interrupted")
    return "运行中断，可以从对应 Chat 查看边界。";
  return "任务已经完成。";
}

function runNavigation(
  run: AutomationRun,
): { readonly chatId: string; readonly runId?: string } | null {
  if (!("chatId" in run)) return null;
  return {
    chatId: run.chatId,
    ...("runId" in run ? { runId: run.runId } : {}),
  };
}

function RunStatusBadge({ run }: { readonly run: AutomationRun }) {
  const presentation = runStatusPresentation[run.status];
  return (
    <span className={styles["runStatus"]} data-tone={presentation.tone}>
      {run.status === "failed" ? (
        <AlertCircle aria-hidden="true" size={12} />
      ) : run.status === "completed" ? (
        <CheckCircle2 aria-hidden="true" size={12} />
      ) : null}
      {presentation.label}
    </span>
  );
}

function AutomationCard({
  item,
  onEdit,
  onOpen,
  onRunNow,
  onSetPaused,
  pending,
  selected,
}: {
  readonly item: AutomationListItem;
  readonly onEdit: () => void;
  readonly onOpen: () => void;
  readonly onRunNow: () => void;
  readonly onSetPaused: (paused: boolean) => void;
  readonly pending: boolean;
  readonly selected: boolean;
}) {
  const { automation, recentRun } = item;
  const schedule = automation.definition.schedule;
  return (
    <article
      className={styles["automationCard"]}
      data-selected={selected || undefined}
    >
      <button
        className={styles["cardMain"]}
        type="button"
        aria-label={`查看 ${automation.definition.name}`}
        onClick={onOpen}
      >
        <span className={styles["cardIcon"]}>
          {automation.definition.task.kind === "reminder" ? (
            <Bell aria-hidden="true" size={17} />
          ) : (
            <Bot aria-hidden="true" size={17} />
          )}
        </span>
        <span className={styles["cardCopy"]}>
          <span className={styles["cardTitleRow"]}>
            <strong>{automation.definition.name}</strong>
            <span
              className={styles["automationState"]}
              data-tone={automationStateTone(automation)}
            >
              {automationStateLabel(automation)}
            </span>
          </span>
          <small>{taskLabel(automation.definition)}</small>
          <span className={styles["scheduleLabel"]}>
            <CalendarClock aria-hidden="true" size={13} />
            {scheduleLabel(schedule)}
          </span>
          <span className={styles["nextRun"]}>
            {automation.state === "active"
              ? `下次运行 ${dateTimeLabel(
                  automation.nextRunAt,
                  scheduleTimeZone(schedule),
                )}`
              : automation.state === "paused"
                ? "恢复后重新计算下次运行"
                : "一次任务已完成"}
          </span>
        </span>
        <ChevronRight aria-hidden="true" size={16} />
      </button>

      <div className={styles["recentRun"]}>
        {recentRun ? (
          <>
            <RunStatusBadge run={recentRun} />
            <span>{runDescription(recentRun)}</span>
          </>
        ) : (
          <span className={styles["noRun"]}>还没有运行记录</span>
        )}
      </div>

      <div className={styles["cardActions"]}>
        <button
          type="button"
          disabled={pending || automation.state === "completed"}
          aria-label={
            automation.state === "paused"
              ? `恢复 ${automation.definition.name}`
              : `暂停 ${automation.definition.name}`
          }
          title={automation.state === "paused" ? "恢复" : "暂停"}
          onClick={() => onSetPaused(automation.state !== "paused")}
        >
          {automation.state === "paused" ? (
            <Play aria-hidden="true" size={14} />
          ) : (
            <Pause aria-hidden="true" size={14} />
          )}
          {automation.state === "paused" ? "恢复" : "暂停"}
        </button>
        <button
          type="button"
          disabled={pending}
          aria-label={`编辑 ${automation.definition.name}`}
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" size={14} />
          编辑
        </button>
        <button
          className={styles["runNowButton"]}
          type="button"
          disabled={pending}
          aria-label={`立即试跑 ${automation.definition.name}`}
          onClick={onRunNow}
        >
          <Play aria-hidden="true" size={14} />
          立即试跑
        </button>
      </div>
    </article>
  );
}

function DetailPanel({
  actionError,
  automation,
  busy,
  detail,
  detailError,
  loading,
  onClose,
  onEdit,
  onOpenChatRun,
  onRunNow,
  onSetPaused,
}: {
  readonly actionError: string | undefined;
  readonly automation: Automation;
  readonly busy: boolean;
  readonly detail: AutomationDetail | null;
  readonly detailError: string | undefined;
  readonly loading: boolean;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onOpenChatRun:
    ((chatId: string, runId?: string) => void) | undefined;
  readonly onRunNow: () => void;
  readonly onSetPaused: (paused: boolean) => void;
}) {
  const definition = detail?.automation.definition ?? automation.definition;
  const task = definition.task;
  return (
    <section className={styles["detailPanel"]} aria-label="任务详情">
      <header className={styles["panelHeader"]}>
        <div>
          <span>Revision {automation.revision}</span>
          <h2>{definition.name}</h2>
        </div>
        <button type="button" aria-label="关闭任务详情" onClick={onClose}>
          <X aria-hidden="true" size={16} />
        </button>
      </header>

      <div className={styles["detailBody"]}>
        <div className={styles["detailActions"]}>
          <button type="button" disabled={busy} onClick={onEdit}>
            <Pencil aria-hidden="true" size={14} />
            编辑
          </button>
          <button
            type="button"
            disabled={busy || automation.state === "completed"}
            onClick={() => onSetPaused(automation.state !== "paused")}
          >
            {automation.state === "paused" ? (
              <Play aria-hidden="true" size={14} />
            ) : (
              <Pause aria-hidden="true" size={14} />
            )}
            {automation.state === "paused" ? "恢复" : "暂停"}
          </button>
          <button
            className={styles["primaryButton"]}
            type="button"
            disabled={busy}
            onClick={onRunNow}
          >
            <Play aria-hidden="true" size={14} />
            立即试跑
          </button>
        </div>

        {actionError ? (
          <p className={styles["panelError"]} role="alert">
            {actionError}
          </p>
        ) : null}

        <section className={styles["definitionSummary"]}>
          <div>
            <span>状态</span>
            <strong>{automationStateLabel(automation)}</strong>
          </div>
          <div>
            <span>时间</span>
            <strong>{scheduleLabel(definition.schedule)}</strong>
          </div>
          <div>
            <span>类型</span>
            <strong>{taskLabel(definition)}</strong>
          </div>
        </section>

        <section className={styles["goalSummary"]}>
          <span>{task.kind === "reminder" ? "提醒内容" : "目标"}</span>
          <p>{task.kind === "reminder" ? task.message : task.goal}</p>
          {task.kind === "agent_task" ? (
            <small>
              {task.modelId} ·{" "}
              {task.toolScope.mode === "all_allowed"
                ? "可用工具"
                : `${task.toolScope.toolNames.length} 个指定工具`}
            </small>
          ) : null}
        </section>

        <section className={styles["historySection"]}>
          <header>
            <History aria-hidden="true" size={15} />
            <div>
              <strong>运行历史</strong>
              <small>每次运行都保留当时的定义快照</small>
            </div>
          </header>

          {loading && !detail ? (
            <div className={styles["panelLoading"]} role="status">
              <RefreshCw aria-hidden="true" size={14} />
              正在读取历史…
            </div>
          ) : detailError ? (
            <p className={styles["panelError"]} role="alert">
              {detailError}
            </p>
          ) : detail?.runs.length ? (
            <div className={styles["runHistory"]}>
              {detail.runs.map((run) => {
                const navigation = runNavigation(run);
                const canOpen = Boolean(navigation && onOpenChatRun);
                return (
                  <button
                    key={run.id}
                    type="button"
                    disabled={!canOpen}
                    aria-label={`${runStatusPresentation[run.status].label} · ${dateTimeLabel(run.requestedAt)}`}
                    onClick={() => {
                      if (!navigation) return;
                      onOpenChatRun?.(navigation.chatId, navigation.runId);
                    }}
                  >
                    <span className={styles["runHistoryTop"]}>
                      <RunStatusBadge run={run} />
                      <time dateTime={run.requestedAt}>
                        {dateTimeLabel(run.requestedAt)}
                      </time>
                    </span>
                    <span className={styles["runHistoryDescription"]}>
                      {runDescription(run)}
                    </span>
                    <small>
                      {run.trigger.kind === "manual"
                        ? "手动试跑"
                        : "按计划运行"}
                      {canOpen
                        ? " · 打开对应 Chat"
                        : task.kind === "reminder"
                          ? " · 提醒记录"
                          : " · 尚未创建 Chat"}
                    </small>
                    {canOpen ? (
                      <ArrowUpRight aria-hidden="true" size={14} />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className={styles["emptyHistory"]}>还没有运行记录。</p>
          )}
        </section>
      </div>
    </section>
  );
}

export function AutomationsPage({
  api = window.charaMate.automations,
  createRequestToken = 0,
  models = [],
  now = () => new Date(),
  onOpenChatRun,
  personas = [],
}: AutomationsPageProps) {
  const [snapshot, setSnapshot] = useState<AutomationListSnapshot | null>(null);
  const [panel, setPanel] = useState<PanelState>(null);
  const [detail, setDetail] = useState<AutomationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [detailError, setDetailError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [pendingAction, setPendingAction] = useState<string | undefined>();
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const createTokenRef = useRef(createRequestToken);

  const loadList = useCallback(() => {
    const sequence = ++listSequence.current;
    return api
      .list()
      .then((response) => {
        if (sequence !== listSequence.current) return;
        if (response.ok) {
          setSnapshot(response.value);
          setLoadError(undefined);
        } else {
          setLoadError(response.error.message);
        }
      })
      .catch(() => {
        if (sequence === listSequence.current) {
          setLoadError("无法读取定时任务，请重试。");
        }
      });
  }, [api]);

  const loadDetail = useCallback(
    async (automationId: string) => {
      const sequence = ++detailSequence.current;
      setDetailLoading(true);
      try {
        const response = await api.get({ automationId });
        if (sequence !== detailSequence.current) return;
        if (response.ok) {
          setDetail(response.value);
          setDetailError(undefined);
        } else {
          setDetailError(response.error.message);
        }
      } catch {
        if (sequence === detailSequence.current) {
          setDetailError("无法读取运行历史，请重试。");
        }
      } finally {
        if (sequence === detailSequence.current) setDetailLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    const unsubscribe = api.subscribe(() => {
      void loadList();
      if (panel && panel.kind !== "create") {
        void loadDetail(panel.automationId);
      }
    });
    return unsubscribe;
  }, [api, loadDetail, loadList, panel]);

  useEffect(() => {
    if (createTokenRef.current === createRequestToken) return;
    createTokenRef.current = createRequestToken;
    setActionError(undefined);
    setDetailError(undefined);
    setDetail(null);
    setPanel({ kind: "create" });
  }, [createRequestToken]);

  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const selectedId =
    panel && panel.kind !== "create" ? panel.automationId : null;
  const selectedItem = useMemo(
    () => items.find(({ automation }) => automation.id === selectedId),
    [items, selectedId],
  );
  const selectedAutomation = detail?.automation ?? selectedItem?.automation;

  const upsertAutomation = (automation: Automation) => {
    setSnapshot((current) => {
      const existing = current?.items.find(
        (item) => item.automation.id === automation.id,
      );
      const item = {
        automation,
        ...(existing?.recentRun ? { recentRun: existing.recentRun } : {}),
      };
      return {
        items: existing
          ? (current?.items.map((candidate) =>
              candidate.automation.id === automation.id ? item : candidate,
            ) ?? [item])
          : [item, ...(current?.items ?? [])],
      };
    });
    setDetail((current) =>
      current?.automation.id === automation.id
        ? { ...current, automation }
        : current,
    );
  };

  const upsertRun = (run: AutomationRun) => {
    setSnapshot((current) =>
      current
        ? {
            items: current.items.map((item) =>
              item.automation.id === run.automationId
                ? { ...item, recentRun: run }
                : item,
            ),
          }
        : current,
    );
    setDetail((current) => {
      if (current?.automation.id !== run.automationId) return current;
      const exists = current.runs.some(({ id }) => id === run.id);
      return {
        ...current,
        runs: exists
          ? current.runs.map((candidate) =>
              candidate.id === run.id ? run : candidate,
            )
          : [run, ...current.runs],
      };
    });
  };

  const openDetail = (automationId: string) => {
    setActionError(undefined);
    setDetailError(undefined);
    setDetail(null);
    setPanel({ automationId, kind: "detail" });
    void loadDetail(automationId);
  };

  const saveDefinition = async (definition: AutomationDefinition) => {
    if (pendingAction) return;
    const currentPanel = panel;
    setPendingAction("save");
    setActionError(undefined);
    setNotice(undefined);
    try {
      const requestedAt = now().toISOString();
      const response =
        currentPanel?.kind === "edit" && selectedAutomation
          ? await api.update({
              automationId: selectedAutomation.id,
              definition,
              expectedRevision: selectedAutomation.revision,
              requestedAt,
            })
          : await api.create({ definition, requestedAt });
      if (!response.ok) {
        setActionError(response.error.message);
        return;
      }
      upsertAutomation(response.value);
      setDetailError(undefined);
      setDetail((current) => ({
        automation: response.value,
        runs: current?.automation.id === response.value.id ? current.runs : [],
      }));
      setPanel({ automationId: response.value.id, kind: "detail" });
      setNotice(
        currentPanel?.kind === "edit" ? "任务修改已保存。" : "任务已创建。",
      );
      void loadDetail(response.value.id);
    } catch {
      setActionError("任务没有保存，请重试。");
    } finally {
      setPendingAction(undefined);
    }
  };

  const setPaused = async (automation: Automation, paused: boolean) => {
    if (pendingAction) return;
    setPendingAction(`pause:${automation.id}`);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const response = await api.setPaused({
        automationId: automation.id,
        expectedRevision: automation.revision,
        paused,
        requestedAt: now().toISOString(),
      });
      if (!response.ok) {
        setActionError(response.error.message);
        return;
      }
      upsertAutomation(response.value);
      setNotice(paused ? "任务已暂停。" : "任务已恢复。");
    } catch {
      setActionError(
        paused ? "无法暂停任务，请重试。" : "无法恢复任务，请重试。",
      );
    } finally {
      setPendingAction(undefined);
    }
  };

  const runNow = async (automation: Automation) => {
    if (pendingAction) return;
    setPendingAction(`run:${automation.id}`);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const response = await api.runNow({
        automationId: automation.id,
        requestedAt: now().toISOString(),
      });
      if (!response.ok) {
        setActionError(response.error.message);
        return;
      }
      upsertRun(response.value);
      setNotice(
        automation.definition.task.kind === "reminder"
          ? "提醒试跑已开始，结果会出现在运行历史中。"
          : "试跑已开始，可在运行历史中打开对应 Chat。",
      );
    } catch {
      setActionError("无法开始试跑，请重试。");
    } finally {
      setPendingAction(undefined);
    }
  };

  const closePanel = () => {
    detailSequence.current += 1;
    setActionError(undefined);
    setDetailError(undefined);
    setDetail(null);
    setPanel(null);
  };

  return (
    <section className={styles["page"]}>
      <div
        className={styles["workspace"]}
        data-panel-open={Boolean(panel) || undefined}
      >
        <div className={styles["listPane"]}>
          <header className={styles["listHeader"]}>
            <div>
              <span>Automation</span>
              <h2>按时提醒，也按时完成</h2>
              <p>
                每次运行都保留定义快照；Agent Task 进入普通 Chat
                Run，过程、批准与结果保持可追溯。
              </p>
            </div>
            <div className={styles["listHeaderActions"]}>
              {items.length > 0 ? <strong>{items.length} 个任务</strong> : null}
              <button
                className={styles["createButton"]}
                type="button"
                onClick={() => {
                  setActionError(undefined);
                  setPanel({ kind: "create" });
                }}
              >
                <Plus aria-hidden="true" size={14} />
                新建任务
              </button>
            </div>
          </header>

          {notice ? (
            <div className={styles["notice"]} role="status">
              <CheckCircle2 aria-hidden="true" size={14} />
              <span>{notice}</span>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => setNotice(undefined)}
              >
                <X aria-hidden="true" size={13} />
              </button>
            </div>
          ) : null}
          {actionError && !panel ? (
            <div className={styles["actionError"]} role="alert">
              <AlertCircle aria-hidden="true" size={14} />
              <span>{actionError}</span>
              <button type="button" onClick={() => setActionError(undefined)}>
                关闭
              </button>
            </div>
          ) : null}

          {!snapshot && !loadError ? (
            <div className={styles["loadingState"]} role="status">
              <RefreshCw aria-hidden="true" size={17} />
              <span>正在读取定时任务…</span>
            </div>
          ) : loadError && !snapshot ? (
            <div className={styles["errorState"]} role="alert">
              <AlertCircle aria-hidden="true" size={22} />
              <strong>暂时无法读取 Automations</strong>
              <span>{loadError}</span>
              <button
                type="button"
                onClick={() => {
                  setLoadError(undefined);
                  void loadList();
                }}
              >
                <RefreshCw aria-hidden="true" size={14} />
                重试
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className={styles["emptyState"]}>
              <span className={styles["emptyIcon"]}>
                <CalendarClock aria-hidden="true" size={24} />
              </span>
              <h3>还没有定时任务</h3>
              <p>创建一次提醒，或让 CharaMate 在指定时间运行一个目标。</p>
            </div>
          ) : (
            <div className={styles["cardList"]} aria-label="定时任务列表">
              {loadError ? (
                <div className={styles["inlineWarning"]} role="status">
                  <AlertCircle aria-hidden="true" size={13} />
                  列表刷新失败，正在显示上次结果。
                </div>
              ) : null}
              {items.map((item) => (
                <AutomationCard
                  key={item.automation.id}
                  item={item}
                  selected={selectedId === item.automation.id}
                  pending={Boolean(pendingAction)}
                  onEdit={() => {
                    setActionError(undefined);
                    setDetailError(undefined);
                    setDetail((current) =>
                      current?.automation.id === item.automation.id
                        ? current
                        : { automation: item.automation, runs: [] },
                    );
                    setPanel({
                      automationId: item.automation.id,
                      kind: "edit",
                    });
                  }}
                  onOpen={() => openDetail(item.automation.id)}
                  onRunNow={() => void runNow(item.automation)}
                  onSetPaused={(paused) =>
                    void setPaused(item.automation, paused)
                  }
                />
              ))}
            </div>
          )}
        </div>

        <aside
          className={styles["panel"]}
          data-open={Boolean(panel) || undefined}
        >
          {panel?.kind === "create" ? (
            <AutomationForm
              key={`create-${createRequestToken}`}
              busy={pendingAction === "save"}
              error={actionError}
              models={models}
              personas={personas}
              onCancel={closePanel}
              onSubmit={(definition) => void saveDefinition(definition)}
            />
          ) : panel?.kind === "edit" && selectedAutomation ? (
            <AutomationForm
              key={`edit-${selectedAutomation.id}-${selectedAutomation.revision}`}
              automation={selectedAutomation}
              busy={pendingAction === "save"}
              error={actionError}
              models={models}
              personas={personas}
              onCancel={() =>
                setPanel({
                  automationId: selectedAutomation.id,
                  kind: "detail",
                })
              }
              onSubmit={(definition) => void saveDefinition(definition)}
            />
          ) : panel?.kind === "detail" && selectedAutomation ? (
            <DetailPanel
              actionError={actionError}
              automation={selectedAutomation}
              busy={Boolean(pendingAction)}
              detail={detail}
              detailError={detailError}
              loading={detailLoading}
              onClose={closePanel}
              onEdit={() =>
                setPanel({
                  automationId: selectedAutomation.id,
                  kind: "edit",
                })
              }
              onOpenChatRun={onOpenChatRun}
              onRunNow={() => void runNow(selectedAutomation)}
              onSetPaused={(paused) =>
                void setPaused(selectedAutomation, paused)
              }
            />
          ) : panel ? (
            <div className={styles["panelLoading"]} role="status">
              <RefreshCw aria-hidden="true" size={14} />
              正在读取任务…
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

export type {
  AutomationModelOption,
  AutomationPersonaOption,
} from "./AutomationForm";
