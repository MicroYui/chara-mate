import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { chatsFixture, chatsFixtureIds } from "../fixtures";
import type { FixtureRun } from "../types";
import { ActivePlan } from "./PlanDisplay";

afterEach(cleanup);

function activeRun(): FixtureRun {
  const base = chatsFixture.chats.find(
    ({ record }) => record.id === chatsFixtureIds.designChat,
  )?.runs[0];
  if (!base) throw new Error("Missing Plan fixture Run");
  return { ...base, record: { ...base.record, status: "running" } };
}

describe("ActivePlan", () => {
  it("shows only the current step ratio until hover or click expands it", () => {
    render(<ActivePlan run={activeRun()} />);

    const trigger = screen.getByRole("button", { name: "计划 2/3" });
    const panel = screen.getByLabelText("当前计划");
    expect(trigger).toHaveTextContent("计划2/3");
    expect(panel).toHaveAttribute("aria-hidden", "true");

    fireEvent.mouseEnter(screen.getByLabelText("活跃计划"));
    expect(panel).toHaveAttribute("aria-hidden", "false");
    expect(panel).toHaveTextContent("整理组件边界");

    fireEvent.click(trigger);
    fireEvent.mouseLeave(screen.getByLabelText("活跃计划"));
    expect(panel).toHaveAttribute("aria-hidden", "false");

    fireEvent.click(trigger);
    expect(panel).toHaveAttribute("aria-hidden", "true");
  });

  it("uses the newest complete snapshot and updates the step position", () => {
    const base = activeRun();
    const firstPlan = base.items.find(({ kind }) => kind === "plan");
    if (!firstPlan) throw new Error("Missing Plan fixture");
    const updated: FixtureRun = {
      ...base,
      items: [
        ...base.items,
        {
          ...firstPlan,
          id: "00000000-0000-4000-8000-000000000499",
          input: {
            explanation: "实现完成，正在验证。",
            plan: [
              { status: "completed", step: "读取设计" },
              { status: "completed", step: "整理组件边界" },
              { status: "in_progress", step: "运行最终验收" },
            ],
          },
          sequence: 99,
        },
      ],
    };

    render(<ActivePlan run={updated} />);

    expect(screen.getByRole("button", { name: "计划 3/3" })).toBeVisible();
    fireEvent.mouseEnter(screen.getByLabelText("活跃计划"));
    expect(screen.getByLabelText("当前计划")).toHaveTextContent("运行最终验收");
    expect(screen.queryByText("验证 fixture")).not.toBeInTheDocument();
  });
});
