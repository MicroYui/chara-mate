import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chatsFixture, chatsFixtureIds } from "../fixtures";
import { chatsFixtureUiReducer, initialChatsFixtureUiState } from "../state";
import type { FixtureRun } from "../types";
import { RunProcess } from "./RunProcess";

afterEach(cleanup);

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
  run,
}: {
  readonly onResume?: (runId: string) => void;
  readonly onResolveApproval?: (
    approvalId: string,
    decision: "approved" | "rejected",
  ) => void;
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
    expect(screen.queryByText("已更新计划")).not.toBeInTheDocument();

    fireEvent.click(summary);
    expect(screen.getByText("已更新计划")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /已运行命令/u }));
    expect(screen.getByText(/npm run test:focused/u)).toBeVisible();
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
    const processItem = base.items.find(
      ({ kind }) => kind !== "user_message" && kind !== "assistant_message",
    );
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
