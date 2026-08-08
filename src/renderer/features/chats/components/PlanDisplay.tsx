import {
  Check,
  ChevronUp,
  Circle,
  ListChecks,
  LoaderCircle,
} from "lucide-react";
import { useId, useState } from "react";

import type {
  PlanStepStatus,
  PlanUpdate,
  RunItem,
} from "../../../../shared/contracts";
import { PlanUpdateSchema } from "../../../../shared/schemas/run";
import { parseSchemaWithoutCodeGeneration } from "../../../../shared/schemas/valueValidation";
import type { ChatRunView } from "../types";
import styles from "./PlanDisplay.module.css";

export function planUpdateFromItem(item: RunItem): PlanUpdate | undefined {
  if (item.kind !== "plan" || item.input === undefined) return undefined;
  try {
    return parseSchemaWithoutCodeGeneration(PlanUpdateSchema, item.input);
  } catch {
    return undefined;
  }
}

export function latestPlanItem(run: ChatRunView): RunItem | undefined {
  return [...run.items]
    .reverse()
    .find((item) => planUpdateFromItem(item) !== undefined);
}

function completedStepCount(update: PlanUpdate): number {
  return update.plan.filter(({ status }) => status === "completed").length;
}

function currentStepPosition(update: PlanUpdate): number {
  const current = update.plan.findIndex(
    ({ status }) => status === "in_progress",
  );
  if (current >= 0) return current + 1;
  const completed = completedStepCount(update);
  return completed >= update.plan.length ? update.plan.length : completed + 1;
}

function planStatusLabel(status: PlanStepStatus): string {
  if (status === "completed") return "已完成";
  if (status === "in_progress") return "进行中";
  return "待处理";
}

function PlanStepIcon({ status }: { readonly status: PlanStepStatus }) {
  if (status === "completed") {
    return <Check aria-hidden="true" size={13} />;
  }
  if (status === "in_progress") {
    return (
      <LoaderCircle className={styles["spin"]} aria-hidden="true" size={13} />
    );
  }
  return <Circle aria-hidden="true" size={11} />;
}

function PlanContent({
  title,
  update,
}: {
  readonly title: string;
  readonly update: PlanUpdate;
}) {
  const completed = completedStepCount(update);
  return (
    <>
      <header className={styles["header"]}>
        <span className={styles["planIcon"]}>
          <ListChecks aria-hidden="true" size={15} />
        </span>
        <div>
          <strong>{title}</strong>
          {update.explanation ? <p>{update.explanation}</p> : null}
        </div>
        <small>
          已完成 {completed}/{update.plan.length}
        </small>
      </header>
      <ol className={styles["steps"]}>
        {update.plan.map((step, index) => (
          <li key={`${String(index)}:${step.step}`} data-status={step.status}>
            <span>
              <PlanStepIcon status={step.status} />
            </span>
            <p>{step.step}</p>
            <small>{planStatusLabel(step.status)}</small>
          </li>
        ))}
      </ol>
    </>
  );
}

export function ArchivedPlan({ item }: { readonly item: RunItem }) {
  const update = planUpdateFromItem(item);
  if (!update) return null;
  return (
    <section className={styles["archiveCard"]} aria-label="计划记录">
      <PlanContent title="执行计划" update={update} />
    </section>
  );
}

export function ActivePlan({ run }: { readonly run: ChatRunView }) {
  const item = latestPlanItem(run);
  const update = item ? planUpdateFromItem(item) : undefined;
  const panelId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  if (!update) return null;

  const position = currentStepPosition(update);
  const open = hovered || focused || pinned;
  return (
    <section
      className={styles["activePlan"]}
      data-open={open ? "" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        setPinned(false);
        setHovered(false);
        setFocused(false);
        (
          event.currentTarget.querySelector("button") as HTMLElement | null
        )?.blur();
      }}
      aria-label="活跃计划"
    >
      <button
        className={styles["trigger"]}
        type="button"
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={`计划 ${String(position)}/${String(update.plan.length)}`}
        onClick={(event) => {
          if (!pinned) {
            setPinned(true);
            return;
          }
          setPinned(false);
          setHovered(false);
          setFocused(false);
          event.currentTarget.blur();
        }}
      >
        <ListChecks aria-hidden="true" size={14} />
        <span>计划</span>
        <strong>
          {position}/{update.plan.length}
        </strong>
        <ChevronUp aria-hidden="true" size={13} />
      </button>
      <div
        id={panelId}
        className={styles["floatingPanel"]}
        aria-hidden={!open}
        aria-label="当前计划"
      >
        <PlanContent title="当前计划" update={update} />
      </div>
    </section>
  );
}
