import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FilePenLine,
  ListChecks,
  LoaderCircle,
  ShieldAlert,
  Terminal,
  Wrench,
} from "lucide-react";
import type { Dispatch } from "react";

import type { Approval, RunItem } from "../../../../shared/contracts";
import type { ChatRunView, ChatsUiAction, ChatsUiState } from "../types";
import { CopyButton } from "./CopyButton";
import styles from "./RunProcess.module.css";

interface RunProcessProps {
  readonly dispatch: Dispatch<ChatsUiAction>;
  readonly onResume: (runId: string) => void;
  readonly onResolveApproval: (
    approvalId: string,
    decision: "approved" | "rejected",
  ) => void;
  readonly run: ChatRunView;
  readonly state: ChatsUiState;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) {
    return `${seconds}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`;
}

function runDuration(run: ChatRunView): number {
  if (run.record.startedAt && run.record.endedAt) {
    return Date.parse(run.record.endedAt) - Date.parse(run.record.startedAt);
  }
  return run.items.reduce((total, item) => total + (item.durationMs ?? 0), 0);
}

function runSummary(status: ChatRunView["record"]["status"]): string {
  switch (status) {
    case "queued":
      return "等待开始";
    case "running":
      return "正在处理";
    case "waiting_approval":
      return "等待确认";
    case "completed":
      return "已处理";
    case "needs_input":
      return "需要补充信息";
    case "interrupted":
      return "已中断";
    case "failed":
      return "处理失败";
    case "cancelled":
      return "已停止";
  }
}

function itemTitle(item: RunItem): string {
  switch (item.kind) {
    case "plan":
      return "已更新计划";
    case "tool_call":
      return "已调用工具";
    case "command":
      return "已运行命令";
    case "file_change":
      return "已修改文件";
    case "context_compaction":
      return "已整理较早上下文";
    case "error":
      return item.error?.message ?? "执行遇到问题";
    case "approval":
      return "等待你确认";
    case "user_message":
      return "已收到消息";
    case "assistant_message":
      return "已生成回答";
  }
}

function ItemIcon({ item }: { readonly item: RunItem }) {
  if (item.status === "running") {
    return (
      <LoaderCircle className={styles["spin"]} aria-hidden="true" size={14} />
    );
  }
  if (item.status === "failed") {
    return <AlertCircle aria-hidden="true" size={14} />;
  }
  if (item.status === "completed") {
    return <Check aria-hidden="true" size={14} />;
  }

  const Icon =
    item.kind === "command"
      ? Terminal
      : item.kind === "file_change"
        ? FilePenLine
        : item.kind === "plan"
          ? ListChecks
          : item.kind === "approval"
            ? ShieldAlert
            : item.kind === "tool_call"
              ? Wrench
              : CircleDot;
  return <Icon aria-hidden="true" size={14} />;
}

function hasDetails(item: RunItem): boolean {
  return Boolean(
    item.input ?? item.displayOutput ?? item.error ?? item.artifacts.length,
  );
}

function ItemDetails({ item }: { readonly item: RunItem }) {
  const input =
    item.input === undefined ? undefined : JSON.stringify(item.input, null, 2);
  return (
    <div className={styles["itemDetails"]}>
      {input ? (
        <div className={styles["detailBlock"]}>
          <header>
            <span>输入</span>
            <CopyButton value={input} />
          </header>
          <pre>{input}</pre>
        </div>
      ) : null}
      {item.displayOutput ? (
        <div className={styles["detailBlock"]}>
          <header>
            <span>结果</span>
            <CopyButton value={item.displayOutput} />
          </header>
          <pre>{item.displayOutput}</pre>
        </div>
      ) : null}
      {item.error ? (
        <p className={styles["itemError"]}>{item.error.message}</p>
      ) : null}
      {item.artifacts.length > 0 ? (
        <div className={styles["artifacts"]}>
          <strong>产物</strong>
          <ul>
            {item.artifacts.map((artifact) => (
              <li key={artifact.artifactId}>
                {artifact.displayName}
                <small>{artifact.kind}</small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

interface ApprovalCardProps {
  readonly approval: Approval;
  readonly dispatch: Dispatch<ChatsUiAction>;
  readonly expanded: boolean;
  readonly item: RunItem;
  readonly onResolveApproval: RunProcessProps["onResolveApproval"];
}

function ApprovalCard({
  approval,
  dispatch,
  expanded,
  item,
  onResolveApproval,
}: ApprovalCardProps) {
  if (approval.status !== "pending") {
    const label =
      approval.status === "approved"
        ? "已允许一次"
        : approval.status === "rejected"
          ? "已拒绝"
          : approval.status === "expired"
            ? "审批已结束"
            : "审批已取消";
    return (
      <div className={styles["approvalResolved"]} role="status">
        <Check aria-hidden="true" size={14} />
        <span>{label}</span>
      </div>
    );
  }

  return (
    <section
      className={styles["approvalCard"]}
      id={`approval-${approval.id}`}
      aria-label="需要你的确认"
      tabIndex={-1}
    >
      <div className={styles["approvalIcon"]}>
        <ShieldAlert aria-hidden="true" size={15} />
      </div>
      <div className={styles["approvalContent"]}>
        <strong>需要你的确认</strong>
        <p>{approval.parameterSummary}</p>
        {expanded ? (
          <dl>
            <div>
              <dt>工具</dt>
              <dd>{approval.toolName}</dd>
            </div>
            <div>
              <dt>本次权限</dt>
              <dd>只允许这一次</dd>
            </div>
          </dl>
        ) : null}
        <div className={styles["approvalActions"]}>
          <button
            type="button"
            onClick={() => onResolveApproval(approval.id, "rejected")}
          >
            拒绝
          </button>
          <button
            type="button"
            onClick={() => dispatch({ itemId: item.id, type: "item.toggled" })}
          >
            {expanded ? "收起详情" : "查看详情"}
          </button>
          <button
            className={styles["approveButton"]}
            type="button"
            onClick={() => onResolveApproval(approval.id, "approved")}
          >
            允许一次
          </button>
        </div>
      </div>
    </section>
  );
}

function RunItemRow({
  dispatch,
  item,
  state,
}: {
  readonly dispatch: Dispatch<ChatsUiAction>;
  readonly item: RunItem;
  readonly state: ChatsUiState;
}) {
  const forcedOpen = item.status === "running";
  const expanded = forcedOpen || state.expandedItemIds.includes(item.id);
  const expandable = hasDetails(item);
  return (
    <div className={styles["item"]} data-status={item.status}>
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? expanded : undefined}
        onClick={() => dispatch({ itemId: item.id, type: "item.toggled" })}
      >
        <span className={styles["itemIcon"]}>
          <ItemIcon item={item} />
        </span>
        <span>{itemTitle(item)}</span>
        {item.durationMs ? (
          <small>{formatDuration(item.durationMs)}</small>
        ) : null}
        {expandable ? (
          expanded ? (
            <ChevronDown aria-hidden="true" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" size={14} />
          )
        ) : null}
      </button>
      {expanded ? <ItemDetails item={item} /> : null}
    </div>
  );
}

export function RunProcess({
  dispatch,
  onResume,
  onResolveApproval,
  run,
  state,
}: RunProcessProps) {
  const forcedOpen = run.record.status !== "completed";
  const expanded = forcedOpen || state.expandedRunIds.includes(run.record.id);
  const visibleItems = run.items.filter(
    ({ kind }) => kind !== "user_message" && kind !== "assistant_message",
  );
  const summaryLead = runSummary(run.record.status);

  return (
    <section className={styles["run"]} data-status={run.record.status}>
      <button
        className={styles["summary"]}
        type="button"
        aria-expanded={expanded}
        onClick={() => dispatch({ runId: run.record.id, type: "run.toggled" })}
      >
        <span>{summaryLead}</span>
        <small>
          {formatDuration(runDuration(run))} · {run.items.length} 项
        </small>
        {expanded ? (
          <ChevronDown aria-hidden="true" size={14} />
        ) : (
          <ChevronRight aria-hidden="true" size={14} />
        )}
      </button>
      {expanded ? (
        <div className={styles["items"]}>
          {run.record.error ? (
            <div className={styles["runError"]} role="alert">
              <AlertCircle aria-hidden="true" size={14} />
              <span>{run.record.error.message}</span>
              {run.record.status === "interrupted" &&
              run.record.error.retryable ? (
                <button type="button" onClick={() => onResume(run.record.id)}>
                  继续运行
                </button>
              ) : null}
            </div>
          ) : null}
          {visibleItems.map((item) => {
            if (item.kind === "approval") {
              const approval = run.approvals.find(
                (candidate) => candidate.itemId === item.id,
              );
              return approval ? (
                <ApprovalCard
                  key={item.id}
                  approval={approval}
                  dispatch={dispatch}
                  expanded={state.expandedItemIds.includes(item.id)}
                  item={item}
                  onResolveApproval={onResolveApproval}
                />
              ) : null;
            }
            return (
              <RunItemRow
                key={item.id}
                dispatch={dispatch}
                item={item}
                state={state}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
