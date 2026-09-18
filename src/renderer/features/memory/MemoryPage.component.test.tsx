import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MemoryApi,
  MemoryDetail,
  MemoryHit,
  MemoryHistoryStatus,
  MemorySnapshot,
} from "../../../shared/contracts/memory";
import { starterTerritorySnapshot } from "../../../../tests/fixtures/territoryWorld";
import { MemoryPage } from "./MemoryPage";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 78,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 78,
        start: index * 78,
      })),
  }),
}));

const MEMORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVISION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CANDIDATE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2026-08-08T12:00:00.000Z";

const hit: MemoryHit = {
  memory: {
    confidence: 1,
    createdAt: NOW,
    currentRevisionId: REVISION_ID,
    id: MEMORY_ID,
    importance: 0.8,
    status: "active",
    type: "preference",
    updatedAt: NOW,
  },
  rank: 1,
  revision: {
    content: "用户偏爱安静且有插座的咖啡馆。",
    createdAt: NOW,
    id: REVISION_ID,
    historyStatus: "current",
    priorDispositions: [],
    memoryId: MEMORY_ID,
    reason: "用户明确说明",
    sourceIds: [],
    sourceType: "user_edit",
  },
  sources: [],
};

const detail: MemoryDetail = {
  memory: hit.memory,
  revisions: [hit.revision],
  sources: [],
  usages: [],
};

const snapshot: MemorySnapshot = {
  candidates: [
    {
      confidence: 0.7,
      content: "用户多日使用 Visual Studio Code。",
      createdAt: NOW,
      id: CANDIDATE_ID,
      importance: 0.5,
      novelty: 1,
      reason: "Activity 跨日证据归纳",
      sourceIds: [MEMORY_ID],
      sourceLabels: ["Visual Studio Code Episode"],
      sourceType: "activity",
      status: "pending",
      type: "activity_digest",
      updatedAt: NOW,
    },
  ],
  memories: [hit],
  profile: [],
};

afterEach(cleanup);

function makeApi() {
  const list = vi.fn<MemoryApi["list"]>().mockResolvedValue({
    ok: true,
    value: snapshot,
  });
  const get = vi.fn<MemoryApi["get"]>().mockResolvedValue({
    ok: true,
    value: detail,
  });
  const revise = vi.fn<MemoryApi["revise"]>().mockResolvedValue({
    ok: true,
    value: detail,
  });
  const create = vi.fn<MemoryApi["create"]>().mockResolvedValue({
    ok: true,
    value: detail,
  });
  const acceptCandidate = vi
    .fn<MemoryApi["acceptCandidate"]>()
    .mockResolvedValue({
      ok: true,
      value: detail,
    });
  const restore = vi.fn<MemoryApi["restore"]>().mockResolvedValue({
    ok: true,
    value: detail,
  });

  const api: MemoryApi = {
    acceptCandidate,
    archive: vi.fn().mockResolvedValue({ ok: true, value: detail }),
    create,
    delete: vi.fn().mockResolvedValue({ ok: true, value: detail }),
    get,
    list,
    purge: vi
      .fn()
      .mockResolvedValue({ ok: true, value: { memoryId: MEMORY_ID } }),
    rejectCandidate: vi.fn().mockResolvedValue({
      ok: true,
      value: { ...snapshot.candidates[0]!, status: "rejected" as const },
    }),
    restore,
    revise,
    setPinned: vi.fn().mockResolvedValue({ ok: true, value: detail }),
  };
  return {
    acceptCandidate,
    api,
    create,
    get,
    list,
    restore,
    revise,
  };
}

describe("MemoryPage", () => {
  it("creates a preference from its content without requiring internal fields", async () => {
    const { api, create } = makeApi();
    render(<MemoryPage api={api} onOpenTerritory={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "新记忆" }));
    expect(screen.getByLabelText("新记忆类型")).toHaveValue("preference");
    expect(screen.queryByLabelText("新记忆稳定字段")).toBeNull();
    fireEvent.change(screen.getByLabelText("新记忆内容"), {
      target: { value: "用户喜欢科幻电影。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      content: "用户喜欢科幻电影。",
      type: "preference",
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("claimSlot");
  });

  it("shows a formed preference as an editable memory without a binding task", async () => {
    const { api } = makeApi();
    render(<MemoryPage api={api} onOpenTerritory={() => undefined} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /用户偏爱安静且有插座/u }),
    );
    expect(await screen.findByLabelText("编辑记忆内容")).toHaveValue(
      hit.revision.content,
    );
    expect(screen.queryByText(/旧版未绑定记录/u)).toBeNull();
    expect(screen.queryByRole("heading", { name: "绑定稳定字段" })).toBeNull();
  });

  it("creates an idempotent Territory candidate from the selected Memory", async () => {
    const { api } = makeApi();
    const territoryCandidateId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const createSourceCandidate = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        candidateId: territoryCandidateId,
        snapshot: starterTerritorySnapshot,
      },
    });
    const onOpenTerritory = vi.fn();
    render(
      <MemoryPage
        api={api}
        onOpenTerritory={onOpenTerritory}
        territoryApi={{ createSourceCandidate }}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /用户偏爱安静且有插座/u }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "放入领地" }));

    await waitFor(() =>
      expect(createSourceCandidate).toHaveBeenCalledWith({
        source: { kind: "memory", memoryId: MEMORY_ID },
      }),
    );
    expect(onOpenTerritory).toHaveBeenCalledWith(territoryCandidateId);
  });

  it("shows candidates, unified results and revision details", async () => {
    const { acceptCandidate, api, revise } = makeApi();
    render(<MemoryPage api={api} onOpenTerritory={() => undefined} />);

    expect(
      await screen.findByText("用户多日使用 Visual Studio Code。"),
    ).toBeVisible();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "SMALL" &&
          element.textContent === "来源：Activity · Visual Studio Code Episode",
      ),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: /用户偏爱安静且有插座/ }),
    );
    expect(
      await screen.findByRole("heading", { name: hit.revision.content }),
    ).toBeVisible();
    expect(screen.getByText("Revision 时间线")).toBeVisible();

    const editor = screen.getByRole("textbox", { name: "编辑记忆内容" });
    fireEvent.change(editor, {
      target: { value: "用户偏爱安静的独立咖啡馆。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存为新 Revision" }));
    await waitFor(() => {
      expect(revise).toHaveBeenCalledWith(
        expect.objectContaining({ content: "用户偏爱安静的独立咖啡馆。" }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "接受" }));
    await waitFor(() =>
      expect(acceptCandidate).toHaveBeenCalledWith({
        candidateId: CANDIDATE_ID,
      }),
    );
  });

  it("explains a guarded cross-Chat update candidate", async () => {
    const { api, list } = makeApi();
    list.mockResolvedValue({
      ok: true,
      value: {
        ...snapshot,
        candidates: [
          {
            ...snapshot.candidates[0]!,
            claimOperation: "replace",
            claimSlot: "preference.hobbies",
            content: "用户现在的爱好是游泳。",
            reason: "跨 Chat 更新未取得本轮合法目标，等待用户确认",
            sourceLabels: ["用户消息"],
            sourceType: "chat",
            supersedesMemoryId: MEMORY_ID,
            type: "preference",
          },
        ],
      },
    });
    render(<MemoryPage api={api} onOpenTerritory={() => undefined} />);

    expect(
      await screen.findByText("处理：替换 · 字段：爱好 · 更新现有记忆"),
    ).toBeVisible();
    expect(
      screen.getByText("跨 Chat 更新未取得本轮合法目标，等待用户确认"),
    ).toBeVisible();
  });

  it("lets an archived memory return to the active list", async () => {
    const { api, get, list, restore } = makeApi();
    const archivedHit: MemoryHit = {
      ...hit,
      memory: { ...hit.memory, status: "archived" },
    };
    const archivedDetail: MemoryDetail = {
      ...detail,
      memory: archivedHit.memory,
    };
    list.mockResolvedValue({
      ok: true,
      value: { ...snapshot, memories: [archivedHit] },
    });
    get.mockResolvedValue({ ok: true, value: archivedDetail });
    render(<MemoryPage api={api} onOpenTerritory={() => undefined} />);

    fireEvent.click(
      await screen.findByRole("button", { name: /用户偏爱安静且有插座/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));

    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith({ memoryId: MEMORY_ID }),
    );
  });

  it("keeps sources attached to their own Revision", async () => {
    const { api, get } = makeApi();
    const sourceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const oldRevision = {
      ...hit.revision,
      content: "用户过去偏爱热闹的咖啡馆。",
      historyStatus: "retained_history" as const,
      historyStatusRevisionId: REVISION_ID,
      createdAt: "2026-08-07T12:00:00.000Z",
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sourceIds: [sourceId],
      sourceType: "chat" as const,
    };
    get.mockResolvedValue({
      ok: true,
      value: {
        ...detail,
        revisions: [hit.revision, oldRevision],
        sources: [
          {
            createdAt: oldRevision.createdAt,
            id: sourceId,
            label: "旧聊天消息",
            referenceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            type: "chat",
          },
        ],
      },
    });
    render(<MemoryPage api={api} onOpenTerritory={() => undefined} />);

    fireEvent.click(
      await screen.findByRole("button", { name: /用户偏爱安静且有插座/ }),
    );
    expect(await screen.findByText(/旧聊天消息/u)).toBeVisible();
    const currentSources = screen
      .getByRole("heading", { name: "当前 Revision 来源" })
      .closest("section");
    if (!currentSources) throw new Error("Missing current Revision sources");
    expect(within(currentSources).queryByText("旧聊天消息")).toBeNull();
    expect(
      within(currentSources).getByText("这条 Revision 由用户直接编辑。"),
    ).toBeVisible();
  });

  it("opens a navigable Activity source", async () => {
    const { api, get } = makeApi();
    const source = {
      createdAt: NOW,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      label: "Visual Studio Code Episode",
      referenceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      type: "activity" as const,
    };
    get.mockResolvedValue({
      ok: true,
      value: {
        ...detail,
        revisions: [
          {
            ...hit.revision,
            sourceIds: [source.id],
            sourceType: "activity",
          },
        ],
        sources: [source],
      },
    });
    const onOpenSource = vi.fn();
    render(
      <MemoryPage
        api={api}
        onOpenSource={onOpenSource}
        onOpenTerritory={() => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /用户偏爱安静且有插座/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Activity Visual Studio Code Episode/u,
      }),
    );
    expect(onOpenSource).toHaveBeenCalledWith(source);
  });

  it("distinguishes retrieval from context references in a Revision history", async () => {
    const { api, get } = makeApi();
    get.mockResolvedValue({
      ok: true,
      value: {
        ...detail,
        usages: [
          {
            consumer: "tool",
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            memoryId: MEMORY_ID,
            revisionId: REVISION_ID,
            usedAt: NOW,
          },
          {
            consumer: "context",
            id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            memoryId: MEMORY_ID,
            revisionId: REVISION_ID,
            usedAt: NOW,
          },
        ],
      },
    });
    render(<MemoryPage api={api} onOpenTerritory={() => undefined} />);

    fireEvent.click(
      await screen.findByRole("button", { name: /用户偏爱安静且有插座/ }),
    );
    expect(await screen.findByText("检索返回")).toBeVisible();
    expect(screen.getByText("提供给回答上下文")).toBeVisible();
    const usages = screen
      .getByRole("heading", { name: "检索与上下文引用记录" })
      .closest("section");
    if (!usages) throw new Error("Missing Memory usage section");
    expect(
      within(usages).getAllByText(/用户偏爱安静且有插座的咖啡馆/u),
    ).toHaveLength(2);
  });

  it.each([
    ["retained_history", "当时的记录，后来发生了变化。"],
    ["corrected", "这条旧记录后来被纠正，不作为真实经历使用。"],
    ["unresolved", "这条旧记录尚不能确认为真实经历，仅供回看。"],
  ] as const)("explains %s in a revision timeline", async (status, label) => {
    const { api, get } = makeApi();
    const historyStatus: MemoryHistoryStatus = status;
    get.mockResolvedValue({
      ok: true,
      value: {
        ...detail,
        revisions: [
          hit.revision,
          {
            ...hit.revision,
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            content: "原先记录用户喜欢热闹的咖啡馆。",
            historyStatus,
            historyStatusRevisionId: REVISION_ID,
          },
        ],
      },
    });
    render(<MemoryPage api={api} onOpenTerritory={() => undefined} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /用户偏爱安静/ }),
    );
    const timeline = (
      await screen.findByRole("heading", { name: "Revision 时间线" })
    ).closest("section");
    if (!timeline) throw new Error("Missing revision timeline");
    expect(within(timeline).getByText(label)).toBeVisible();
    expect(
      within(timeline).getByText(`后续说明：${hit.revision.content}`),
    ).toBeVisible();
    expect(
      within(timeline).getByText("原先记录用户喜欢热闹的咖啡馆。"),
    ).toBeVisible();
  });

  it("uses the shared historical retrieval path for an as-of date", async () => {
    const { api, get, list } = makeApi();
    const historicalRevision = {
      ...hit.revision,
      content: "用户过去偏爱热闹的咖啡馆。",
      historyStatus: "retained_history" as const,
      historyStatusRevisionId: REVISION_ID,
      createdAt: "2026-08-07T12:00:00.000Z",
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    };
    const historicalHit: MemoryHit = {
      ...hit,
      memory: {
        ...hit.memory,
        currentRevisionId: historicalRevision.id,
      },
      revision: historicalRevision,
    };
    list.mockImplementation((request) =>
      Promise.resolve({
        ok: true,
        value: request.asOf
          ? { ...snapshot, memories: [historicalHit] }
          : snapshot,
      }),
    );
    get.mockResolvedValue({
      ok: true,
      value: {
        ...detail,
        revisions: [hit.revision, historicalRevision],
      },
    });
    render(<MemoryPage api={api} onOpenTerritory={() => undefined} />);
    await screen.findByText("用户多日使用 Visual Studio Code。");

    fireEvent.change(screen.getByLabelText("记忆截至日期"), {
      target: { value: "2026-08-07" },
    });

    await waitFor(() =>
      expect(
        list.mock.calls.some(([request]) => typeof request.asOf === "string"),
      ).toBe(true),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /用户过去偏爱热闹/ }),
    );
    expect(
      await screen.findByRole("heading", {
        name: historicalRevision.content,
      }),
    ).toBeVisible();
    expect(screen.getByLabelText("编辑记忆内容")).toBeDisabled();
    expect(screen.getByRole("button", { name: "放入领地" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新记忆" })).toBeDisabled();
    expect(screen.queryByText(hit.revision.content)).not.toBeInTheDocument();
    expect(
      screen.queryByText("用户多日使用 Visual Studio Code。"),
    ).not.toBeInTheDocument();
  });
});
