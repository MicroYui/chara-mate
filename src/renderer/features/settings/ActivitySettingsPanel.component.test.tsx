import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityApi,
  ActivitySnapshot,
} from "../../../shared/contracts/activity";
import { ActivitySettingsPanel } from "./ActivitySettingsPanel";

const snapshot: ActivitySnapshot = {
  date: "2026-08-08",
  digests: [],
  episodes: [],
  paused: false,
  rawBytes: 1_048_576,
};

afterEach(cleanup);

describe("ActivitySettingsPanel", () => {
  it("keeps pause and bounded cleanup as the only product controls", async () => {
    const setPaused = vi.fn<ActivityApi["setPaused"]>().mockResolvedValue({
      ok: true,
      value: { ...snapshot, paused: true },
    });
    const cleanupActivity = vi.fn<ActivityApi["cleanup"]>().mockResolvedValue({
      ok: true,
      value: {
        deletedAssets: 2,
        deletedEvents: 5,
        finishedAt: "2026-08-08T12:00:00.000Z",
      },
    });
    const api: ActivityApi = {
      cleanup: cleanupActivity,
      deleteEpisode: vi.fn(),
      getEpisode: vi.fn(),
      getSnapshot: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
      setPaused,
      updateEpisode: vi.fn(),
    };

    render(<ActivitySettingsPanel api={api} />);

    expect(await screen.findByText("1.0 MB")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "暂停采集" }));
    await waitFor(() =>
      expect(setPaused).toHaveBeenCalledWith({ paused: true }),
    );

    fireEvent.click(screen.getByRole("button", { name: "立即清理" }));
    expect(await screen.findByText(/已清理 5 条原始事件/)).toBeVisible();
  });
});
