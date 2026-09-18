import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityApi } from "../../../shared/contracts/activity";
import type { SettingsApi } from "../../../shared/contracts/settings";
import { DataSettingsPanel, formatByteLength } from "./DataSettingsPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const snapshot = {
  categories: [
    { byteLength: 4096, id: "database" as const, label: "对话与应用数据库" },
    { byteLength: 2048, id: "activity" as const, label: "Activity 记录与截图" },
  ],
  dataDirectory: "/tmp/chara-mate-data",
  totalByteLength: 6144,
};

function createApis() {
  const getDataSnapshot = vi
    .fn<SettingsApi["getDataSnapshot"]>()
    .mockResolvedValue({ ok: true, value: snapshot });
  const openDataDirectory = vi
    .fn<SettingsApi["openDataDirectory"]>()
    .mockResolvedValue({
      ok: true,
      value: { message: "数据目录已在 Finder 中打开。" },
    });
  const settingsApi = {
    getDataSnapshot,
    getSnapshot: vi.fn(),
    importBrowserCookies: vi.fn(),
    openDataDirectory,
    openManagedBrowser: vi.fn(),
    saveAgent: vi.fn(),
    saveCompanionInitiative: vi.fn(),
    saveVoice: vi.fn(),
  } satisfies SettingsApi;
  const cleanupActivity = vi.fn<ActivityApi["cleanup"]>().mockResolvedValue({
    ok: true,
    value: {
      deletedAssets: 2,
      deletedEvents: 3,
      finishedAt: "2026-08-14T08:00:00.000Z",
    },
  });
  const activityApi = {
    cleanup: cleanupActivity,
    deleteEpisode: vi.fn(),
    resolveEventReference: vi.fn(),
    getEpisode: vi.fn(),
    getSnapshot: vi.fn(),
    setPaused: vi.fn(),
    updateEpisode: vi.fn(),
  } satisfies ActivityApi;
  return {
    activityApi,
    cleanupActivity,
    getDataSnapshot,
    openDataDirectory,
    settingsApi,
  };
}

describe("Data Settings panel", () => {
  it("formats byte lengths at useful scales", () => {
    expect(formatByteLength(0)).toBe("0 B");
    expect(formatByteLength(1536)).toBe("1.5 KB");
    expect(formatByteLength(12 * 1024 * 1024)).toBe("12 MB");
  });

  it("shows usage, opens the directory and runs bounded cleanup", async () => {
    const apis = createApis();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <DataSettingsPanel
        activityApi={apis.activityApi}
        settingsApi={apis.settingsApi}
      />,
    );

    expect(await screen.findByText("6.0 KB")).toBeVisible();
    expect(screen.getByText("/tmp/chara-mate-data")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /在 Finder 中打开/u }));
    await waitFor(() => expect(apis.openDataDirectory).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "清理可移除数据" }));
    await waitFor(() => expect(apis.cleanupActivity).toHaveBeenCalledWith({}));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已清理 3 条原始事件和 2 个截图资产。",
    );
    expect(apis.getDataSnapshot).toHaveBeenCalledTimes(2);
  });
});
