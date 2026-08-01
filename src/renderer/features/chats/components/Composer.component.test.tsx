import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { chatsFixture } from "../fixtures";
import { chatsFixtureUiReducer, initialChatsFixtureUiState } from "../state";
import type { ChatsFixtureUiState } from "../types";
import { Composer } from "./Composer";

afterEach(cleanup);

function ComposerHarness({
  initial,
}: {
  readonly initial?: Partial<ChatsFixtureUiState>;
}) {
  const [state, dispatch] = useReducer(chatsFixtureUiReducer, {
    ...initialChatsFixtureUiState,
    ...initial,
  });
  return (
    <Composer dispatch={dispatch} models={chatsFixture.models} state={state} />
  );
}

describe("Composer", () => {
  it("keeps the draft when switching from Agent to Chat and hides permission", async () => {
    render(
      <ComposerHarness initial={{ draft: "保留这段内容", mode: "agent" }} />,
    );

    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(
      "保留这段内容",
    );
    expect(screen.getByRole("button", { name: /请求批准/u })).toBeVisible();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Agent/u }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Chat/u }));

    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(
      "保留这段内容",
    );
    expect(
      screen.queryByRole("button", { name: /请求批准/u }),
    ).not.toBeInTheDocument();
  });

  it("adds and removes a fixture attachment from the composer", async () => {
    render(<ComposerHarness />);

    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加文件" }));

    expect(screen.getByText("phase-1-ui-notes.md")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "移除 phase-1-ui-notes.md" }),
    );
    expect(screen.queryByText("phase-1-ui-notes.md")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始语音对话" })).toBeVisible();
  });

  it("sends with Enter, keeps Shift+Enter for multiline, and exposes Stop", () => {
    render(<ComposerHarness />);
    const editor = screen.getByRole("textbox", { name: "消息" });

    fireEvent.change(editor, { target: { value: "第一行" } });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(screen.getByRole("button", { name: "发送" })).toBeVisible();

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(screen.getByRole("button", { name: "停止" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(screen.getByRole("button", { name: "正在停止" })).toBeDisabled();
  });
});
