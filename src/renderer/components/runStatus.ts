import type { Run } from "../../shared/contracts/run";

export type RunStatusTone =
  "accent" | "danger" | "muted" | "success" | "warning";

export interface RunStatusPresentation {
  readonly label: string;
  readonly tone: RunStatusTone;
}

export const runStatusPresentation: Readonly<
  Record<Run["status"], RunStatusPresentation>
> = {
  cancelled: { label: "已停止", tone: "muted" },
  completed: { label: "已处理", tone: "success" },
  failed: { label: "处理失败", tone: "danger" },
  interrupted: { label: "已中断", tone: "danger" },
  needs_input: { label: "需要补充信息", tone: "warning" },
  queued: { label: "等待开始", tone: "muted" },
  running: { label: "正在处理", tone: "accent" },
  waiting_approval: { label: "等待确认", tone: "warning" },
};
