import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SettingsApi } from "../../../shared/contracts/settings";
import { BrowserComputerSettingsPanel } from "./BrowserComputerSettingsPanel";

afterEach(cleanup);

function createApi() {
  const snapshot = {
    agent: {
      defaultApprovalMode: "request_approval" as const,
      defaultMode: "chat" as const,
      workingDirectory: "/workspace",
    },
    browserComputer: {
      accessibility: "granted" as const,
      browser: "ready" as const,
      profileDirectory: "/browser/profile",
      screenRecording: "denied" as const,
    },
    voice: {
      inputMode: "hands_free" as const,
      instructions: "使用自然、简洁的中文口语。",
      microphone: "granted" as const,
      providerProfileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      voice: "verse" as const,
    },
  };
  const getSnapshot = vi
    .fn<SettingsApi["getSnapshot"]>()
    .mockResolvedValue({ ok: true, value: snapshot });
  const openManagedBrowser = vi
    .fn<SettingsApi["openManagedBrowser"]>()
    .mockResolvedValue({
      ok: true,
      value: { message: "受管浏览器已打开。" },
    });
  const api: SettingsApi = {
    getDataSnapshot: vi.fn(),
    getSnapshot,
    importBrowserCookies: vi.fn(),
    openDataDirectory: vi.fn(),
    openManagedBrowser,
    saveAgent: vi.fn(),
    saveVoice: vi.fn(),
  };
  return { api, getSnapshot, openManagedBrowser };
}

describe("Browser & Computer Settings panel", () => {
  it("shows compact capability rows and refreshes native permission status", async () => {
    const { api, getSnapshot, openManagedBrowser } = createApi();
    render(<BrowserComputerSettingsPanel api={api} />);

    expect(await screen.findByText("/browser/profile")).toBeVisible();
    expect(screen.getByText("辅助功能")).toBeVisible();
    expect(screen.getByText("屏幕录制")).toBeVisible();
    expect(screen.getByText("已授权")).toBeVisible();
    expect(screen.getByText("未授权")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "打开浏览器" }));
    await waitFor(() => expect(openManagedBrowser).toHaveBeenCalledOnce());
    expect(await screen.findByText("受管浏览器已打开。")).toBeVisible();
  });
});
