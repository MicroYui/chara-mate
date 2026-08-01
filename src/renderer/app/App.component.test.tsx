import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../shared/contracts/foundation";
import { App } from "./App";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-foundation-ready");
  document.documentElement.removeAttribute("data-background-scheme");
  window.localStorage.clear();
});

function renderApp() {
  const markRendererReady = vi.fn();
  const desktopApi: DesktopApi = {
    foundation: {
      getSnapshot: vi.fn().mockResolvedValue({
        appName: "CharaMate",
        appVersion: "0.1.0",
        databaseRoundTrip: true,
        electronVersion: "43.2.0",
        nodeVersion: "24.13.0",
        platform: "darwin",
      }),
      markRendererReady,
    },
  };
  Object.defineProperty(window, "charaMate", {
    configurable: true,
    value: desktopApi,
  });

  render(<App />);
  return { markRendererReady };
}

describe("application shell", () => {
  it("shows Chats after validating the runtime and reports readiness", async () => {
    const { markRendererReady } = renderApp();

    expect(
      await screen.findByRole("heading", { name: "Phase 1 UI" }),
    ).toBeVisible();
    expect(screen.getByTestId("foundation-status")).toHaveTextContent(
      "Electron 43.2.0",
    );
    await waitFor(() => {
      expect(markRendererReady).toHaveBeenCalledOnce();
    });
    const navigation = screen.getByRole("navigation", { name: "主要页面" });
    expect(within(navigation).getAllByRole("button")).toHaveLength(5);
    expect(
      within(navigation).getByRole("button", { name: "Territory" }),
    ).toBeVisible();
    expect(screen.queryByText("领地")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Mika 桌宠" })).toHaveAttribute(
      "src",
    );
    const settingsButton = screen.getByRole("button", { name: "Settings" });
    const collapseButton = screen.getByRole("button", { name: "折叠侧栏" });
    expect(settingsButton).toBeVisible();
    expect(settingsButton.parentElement).toBe(collapseButton.parentElement);
  });

  it("starts a blank chat and fills a suggestion without sending it", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Phase 1 UI" });

    fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
    expect(screen.getByRole("heading", { name: "新对话" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "今天想从哪里开始？" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "聊聊今天发生的事" }));
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue(
      "聊聊今天发生的事",
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeVisible();
  });

  it("switches the user-selected background without changing the page tree", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Phase 1 UI" });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("radio", { name: /暖灰/u }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute(
        "data-background-scheme",
        "warm",
      );
    });
    expect(window.localStorage.getItem("chara-mate.background-scheme")).toBe(
      "warm",
    );
    expect(screen.getByRole("heading", { name: "界面背景" })).toBeVisible();
  });
});
