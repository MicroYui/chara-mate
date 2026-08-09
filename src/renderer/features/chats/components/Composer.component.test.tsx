import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatsFixture } from "../fixtures";
import { chatsFixtureUiReducer, initialChatsFixtureUiState } from "../state";
import type { ChatsFixtureUiState } from "../types";
import { Composer } from "./Composer";

beforeEach(() => {
  vi.stubGlobal("charaMate", {
    files: { getPathForFile: (file: File) => `/tmp/${file.name}` },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ComposerHarness({
  initial,
  onSend,
  onStop,
  onVoiceStart,
}: {
  readonly initial?: Partial<ChatsFixtureUiState>;
  readonly onSend?: () => void;
  readonly onStop?: () => void;
  readonly onVoiceStart?: () => void;
}) {
  const [state, dispatch] = useReducer(chatsFixtureUiReducer, {
    ...initialChatsFixtureUiState,
    ...initial,
  });
  return (
    <Composer
      dispatch={dispatch}
      models={chatsFixture.models}
      {...(onSend ? { onSend } : {})}
      {...(onStop ? { onStop } : {})}
      {...(onVoiceStart ? { onVoiceStart } : {})}
      state={state}
    />
  );
}

describe("Composer", () => {
  it("requires an explicit choice when several Provider models are available", async () => {
    render(<ComposerHarness />);

    const modelButton = screen.getByRole("button", { name: "Model" });
    expect(modelButton).toBeVisible();
    fireEvent.pointerDown(modelButton, { button: 0, ctrlKey: false });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "GPT-5OpenAI" }),
    );

    expect(screen.getByRole("button", { name: "GPT-5" })).toBeVisible();
  });

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

  it("adds and removes a selected local file from the composer", () => {
    const { container } = render(<ComposerHarness />);
    const fileInput = container.querySelector(
      'input[type="file"]:not([accept])',
    );
    if (!(fileInput instanceof HTMLInputElement)) {
      throw new Error("Missing file input");
    }
    const file = new File(["phase one"], "phase-1-ui-notes.md", {
      type: "text/markdown",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(screen.getByText(file.name)).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: `移除 ${file.name}` }));
    expect(screen.queryByText(file.name)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始语音对话" })).toBeVisible();
  });

  it("uses the same settings-driven Voice start from both entry buttons", () => {
    const onVoiceStart = vi.fn();
    render(<ComposerHarness onVoiceStart={onVoiceStart} />);

    fireEvent.click(screen.getByRole("button", { name: "录入语音" }));
    fireEvent.click(screen.getByRole("button", { name: "开始语音对话" }));

    expect(onVoiceStart).toHaveBeenCalledTimes(2);
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

  it("keeps text steering and Stop available while the current Run is active", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(
      <ComposerHarness
        initial={{ composerPhase: "running", draft: "先改用更简单的方案" }}
        onSend={onSend}
        onStop={onStop}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "消息" });
    expect(screen.getByRole("button", { name: "停止" })).toBeVisible();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "发送追加消息" }));
    expect(onSend).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
