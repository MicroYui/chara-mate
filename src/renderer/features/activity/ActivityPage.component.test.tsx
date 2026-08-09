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
import { ActivityPage } from "./ActivityPage";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 106,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 106,
        start: index * 106,
      })),
    measureElement: undefined,
  }),
}));

const EPISODE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DIGEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "2026-08-08T12:00:00.000Z";

const snapshot: ActivitySnapshot = {
  date: "2026-08-08",
  digests: [
    {
      candidateIds: [],
      createdAt: NOW,
      evidenceDays: 1,
      episodeIds: [EPISODE_ID],
      id: DIGEST_ID,
      kind: "daily",
      periodEnd: "2026-08-09T00:00:00.000Z",
      periodStart: "2026-08-08T00:00:00.000Z",
      summary: "Visual Studio Code 60 分钟",
      title: "2026-08-08 活动摘要",
    },
  ],
  episodes: [
    {
      actor: "user",
      appNames: ["Visual Studio Code"],
      createdAt: NOW,
      domains: [],
      endedAt: "2026-08-08T11:00:00.000Z",
      eventCount: 2,
      id: EPISODE_ID,
      screenshotStorageKeys: [],
      sourceTypes: ["active_app"],
      startedAt: "2026-08-08T10:00:00.000Z",
      summary: "Visual Studio Code：CharaMate",
      title: "Visual Studio Code",
      updatedAt: NOW,
    },
  ],
  paused: false,
  rawBytes: 1_048_576,
};

afterEach(cleanup);

describe("ActivityPage", () => {
  it("shows distilled activity and keeps pause, edit and cleanup explicit", async () => {
    const setPaused = vi.fn<ActivityApi["setPaused"]>().mockResolvedValue({
      ok: true,
      value: { ...snapshot, paused: true },
    });
    const updateEpisode = vi
      .fn<ActivityApi["updateEpisode"]>()
      .mockResolvedValue({
        ok: true,
        value: snapshot.episodes[0]!,
      });
    const cleanupActivity = vi.fn<ActivityApi["cleanup"]>().mockResolvedValue({
      ok: true,
      value: { deletedAssets: 2, deletedEvents: 5, finishedAt: NOW },
    });
    const api: ActivityApi = {
      cleanup: cleanupActivity,
      deleteEpisode: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
      getEpisode: vi.fn().mockResolvedValue({
        ok: true,
        value: snapshot.episodes[0]!,
      }),
      getSnapshot: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
      setPaused,
      updateEpisode,
    };
    render(<ActivityPage api={api} />);

    expect(await screen.findByText("Visual Studio Code 60 分钟")).toBeVisible();
    fireEvent.change(screen.getByLabelText("搜索 Activity"), {
      target: { value: "不存在的活动" },
    });
    expect(screen.getByText("没有符合搜索条件的活动。")).toBeVisible();
    fireEvent.change(screen.getByLabelText("搜索 Activity"), {
      target: { value: "CharaMate" },
    });
    expect(
      screen.getByRole("button", { name: /Visual Studio Code：CharaMate/ }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "暂停采集" }));
    await waitFor(() =>
      expect(setPaused).toHaveBeenCalledWith({ paused: true }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Visual Studio Code：CharaMate/ }),
    );
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "编码 CharaMate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(updateEpisode).toHaveBeenCalledWith(
        expect.objectContaining({ title: "编码 CharaMate" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "立即清理" }));
    expect(await screen.findByText(/已清理 5 条原始事件/)).toBeVisible();

    fireEvent.change(screen.getByLabelText("Activity 日期"), {
      target: { value: "2026-08-07" },
    });
    expect(screen.queryByLabelText("标题")).not.toBeInTheDocument();
  });

  it("opens an Episode selected from a Memory source", async () => {
    const getEpisode = vi.fn<ActivityApi["getEpisode"]>().mockResolvedValue({
      ok: true,
      value: snapshot.episodes[0]!,
    });
    const api: ActivityApi = {
      cleanup: vi.fn(),
      deleteEpisode: vi.fn(),
      getEpisode,
      getSnapshot: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
      setPaused: vi.fn(),
      updateEpisode: vi.fn(),
    };

    render(<ActivityPage api={api} focusEpisodeId={EPISODE_ID} />);

    await waitFor(() =>
      expect(getEpisode).toHaveBeenCalledWith({ episodeId: EPISODE_ID }),
    );
    expect(await screen.findByLabelText("标题")).toHaveValue(
      "Visual Studio Code",
    );
  });
});
