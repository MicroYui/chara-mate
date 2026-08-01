import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it } from "vitest";

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

function RunHarness({ run }: { readonly run: FixtureRun }) {
  const [state, dispatch] = useReducer(
    chatsFixtureUiReducer,
    initialChatsFixtureUiState,
  );
  return <RunProcess dispatch={dispatch} run={run} state={state} />;
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
    render(<RunHarness run={runByChatId(chatsFixtureIds.approvalChat)} />);

    expect(screen.getByLabelText("需要你的确认")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
    expect(screen.getByText("file.apply_patch")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(screen.getByRole("status")).toHaveTextContent("已允许一次");
  });
});
