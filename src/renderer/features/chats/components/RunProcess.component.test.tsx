import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useReducer, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chatsFixture, chatsFixtureIds } from "../fixtures";
import { chatsFixtureUiReducer, initialChatsFixtureUiState } from "../state";
import type { FixtureRun } from "../types";
import { RunProcess } from "./RunProcess";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function runByChatId(chatId: string): FixtureRun {
  const run = chatsFixture.chats.find(({ record }) => record.id === chatId)
    ?.runs[0];
  if (!run) {
    throw new Error(`Missing fixture Run for ${chatId}`);
  }
  return run;
}

function RunHarness({
  onResume = vi.fn(),
  onResolveApproval = vi.fn(),
  onResolveUserInput = vi.fn(() => Promise.resolve()),
  run,
}: {
  readonly onResume?: (runId: string) => void;
  readonly onResolveApproval?: (
    approvalId: string,
    decision: "approved" | "rejected",
  ) => void;
  readonly onResolveUserInput?: ComponentProps<
    typeof RunProcess
  >["onResolveUserInput"];
  readonly run: FixtureRun;
}) {
  const [state, dispatch] = useReducer(
    chatsFixtureUiReducer,
    initialChatsFixtureUiState,
  );
  return (
    <RunProcess
      dispatch={dispatch}
      onResume={onResume}
      onResolveApproval={onResolveApproval}
      onResolveUserInput={onResolveUserInput}
      run={run}
      state={state}
    />
  );
}

describe("RunProcess", () => {
  it("keeps a completed Run compact until the reader expands real items", () => {
    render(<RunHarness run={runByChatId(chatsFixtureIds.designChat)} />);

    const summary = screen.getByRole("button", { name: /已处理/u });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("当前计划")).not.toBeInTheDocument();

    fireEvent.click(summary);
    expect(screen.getByLabelText("计划记录")).toBeVisible();
    expect(screen.getByText("整理组件边界")).toBeVisible();
    expect(screen.getAllByText("未完成").length).toBeGreaterThan(0);
    expect(screen.queryByText("进行中")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /已运行命令/u }));
    expect(screen.getByText(/npm run test:focused/u)).toBeVisible();
  });

  it("renders an unfinished Plan as failed history without a live spinner", () => {
    const base = runByChatId(chatsFixtureIds.designChat);
    const failed: FixtureRun = {
      ...base,
      record: {
        ...base.record,
        error: {
          code: "PROVIDER.REQUEST_FAILED",
          message: "Provider 请求失败，请检查配置后重试。",
          retryable: false,
        },
        status: "failed",
      },
    };

    render(<RunHarness run={failed} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Provider 请求失败");
    expect(screen.getByText("执行计划 · 已失败")).toBeVisible();
    expect(screen.getAllByText("未完成").length).toBeGreaterThan(0);
    expect(screen.queryByText("进行中")).not.toBeInTheDocument();
  });

  it("leaves the latest Plan out of an active Run process", () => {
    const base = runByChatId(chatsFixtureIds.designChat);
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
      record: { ...base.record, status: "running" },
    };

    render(<RunHarness run={updated} />);

    expect(screen.queryByLabelText("计划记录")).not.toBeInTheDocument();
    expect(screen.queryByText("运行最终验收")).not.toBeInTheDocument();
    expect(screen.queryByText("验证 fixture")).not.toBeInTheDocument();
  });

  it("keeps an Approval visible and resolves the same fixture decision", () => {
    const onResolveApproval = vi.fn();
    render(
      <RunHarness
        onResolveApproval={onResolveApproval}
        run={runByChatId(chatsFixtureIds.approvalChat)}
      />,
    );

    expect(screen.getByLabelText("需要你的确认")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
    expect(screen.getByText("file.apply_patch")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(onResolveApproval).toHaveBeenCalledWith(
      chatsFixtureIds.approval,
      "approved",
    );
  });

  it("keeps the current running Item expanded so streamed output stays visible", () => {
    const base = runByChatId(chatsFixtureIds.designChat);
    const processItem = base.items.find(({ kind }) => kind === "command");
    if (!processItem) throw new Error("Missing process Item fixture");
    const running: FixtureRun = {
      ...base,
      items: [
        {
          ...processItem,
          displayOutput: "正在追加输出",
          status: "running",
        },
      ],
      record: { ...base.record, status: "running" },
    };

    render(<RunHarness run={running} />);

    expect(screen.getByText("正在追加输出")).toBeVisible();
  });

  it("advances the elapsed time before the first token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T09:00:32.900Z"));
    const base = runByChatId(chatsFixtureIds.designChat);
    const assistantItem = base.items.find(
      ({ kind }) => kind === "assistant_message",
    );
    if (!assistantItem) throw new Error("Missing assistant Item fixture");
    const { endedAt: assistantEndedAt, ...assistantWithoutEndedAt } =
      assistantItem;
    const { endedAt: runEndedAt, ...recordWithoutEndedAt } = base.record;
    expect(assistantEndedAt).toBeDefined();
    expect(runEndedAt).toBeDefined();
    const waiting: FixtureRun = {
      ...base,
      items: [
        {
          ...assistantWithoutEndedAt,
          startedAt: "2026-08-08T09:00:32.762Z",
          status: "running",
        },
      ],
      record: {
        ...recordWithoutEndedAt,
        startedAt: "2026-08-08T09:00:32.751Z",
        status: "running",
      },
    };

    render(<RunHarness run={waiting} />);

    expect(screen.getByRole("button", { name: /正在处理/u })).toHaveTextContent(
      "0秒",
    );

    await act(() => vi.advanceTimersByTime(2_000));

    expect(screen.getByRole("button", { name: /正在处理/u })).toHaveTextContent(
      "2秒",
    );
  });

  it("shows an interrupted Run error and resumes only from the explicit action", () => {
    const onResume = vi.fn();
    const base = runByChatId(chatsFixtureIds.designChat);
    const interrupted: FixtureRun = {
      ...base,
      record: {
        ...base.record,
        error: {
          code: "AGENT.APP_INTERRUPTED",
          message: "上次运行被应用退出中断，可从最近边界继续。",
          retryable: true,
        },
        status: "interrupted",
      },
    };

    render(<RunHarness onResume={onResume} run={interrupted} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "上次运行被应用退出中断",
    );
    fireEvent.click(screen.getByRole("button", { name: "继续运行" }));
    expect(onResume).toHaveBeenCalledWith(interrupted.record.id);
  });
});
