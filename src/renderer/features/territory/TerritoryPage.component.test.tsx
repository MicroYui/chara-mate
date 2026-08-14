import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderApi } from "../../../shared/contracts/provider";
import type {
  TerritoryInstance,
  TerritoryWorldApi,
  TerritoryWorldSnapshot,
} from "../../../shared/contracts/territoryWorld";
import {
  starterTerritoryCandidate,
  starterTerritorySnapshot,
  starterTerritoryZoneView,
  territoryWorldFixtureIds,
} from "../../../../tests/fixtures/territoryWorld";
import { TerritoryPage } from "./TerritoryPage";

vi.mock("./PixiTerritoryWorldCanvas", () => ({
  PixiTerritoryWorldCanvas: ({
    onInstanceMove,
    onPetMove,
    onPlaceCollection,
    onSelectionChange,
    selectedCollectionInstance,
    view,
  }: {
    readonly onInstanceMove: (
      instance: TerritoryInstance,
      point: { readonly x: number; readonly y: number },
    ) => Promise<boolean>;
    readonly onPetMove: (point: {
      readonly x: number;
      readonly y: number;
    }) => void;
    readonly onPlaceCollection: (point: {
      readonly x: number;
      readonly y: number;
    }) => Promise<boolean>;
    readonly onSelectionChange: (
      instanceId: string | null,
      additive: boolean,
    ) => void;
    readonly selectedCollectionInstance: TerritoryInstance | null;
    readonly view: typeof starterTerritoryZoneView;
  }) => (
    <div data-testid="world-canvas">
      <span>{view.zone.name}</span>
      <span>{selectedCollectionInstance?.id ?? "nothing-held"}</span>
      <button
        type="button"
        onClick={() =>
          onSelectionChange(territoryWorldFixtureIds.deskInstance, false)
        }
      >
        选择书桌
      </button>
      <button
        type="button"
        onClick={() => {
          const desk = view.instances.find(
            ({ id }) => id === territoryWorldFixtureIds.deskInstance,
          );
          if (desk) void onInstanceMove(desk, { x: 7, y: 5 });
        }}
      >
        移动书桌
      </button>
      <button
        type="button"
        onClick={() => void onPlaceCollection({ x: 4, y: 6 })}
      >
        放置收藏
      </button>
      <button type="button" onClick={() => onPetMove({ x: 9, y: 7 })}>
        移动桌宠
      </button>
    </div>
  ),
}));

function createApi() {
  const getSnapshot = vi
    .fn<TerritoryWorldApi["getSnapshot"]>()
    .mockResolvedValue({
      ok: true,
      value: structuredClone(starterTerritorySnapshot),
    });
  const getZoneView = vi
    .fn<TerritoryWorldApi["getZoneView"]>()
    .mockResolvedValue({
      ok: true,
      value: structuredClone(starterTerritoryZoneView),
    });
  const commitChangeSet = vi
    .fn<TerritoryWorldApi["commitChangeSet"]>()
    .mockResolvedValue({
      ok: true,
      value: structuredClone(starterTerritorySnapshot),
    });
  const restoreRevision = vi
    .fn<TerritoryWorldApi["restoreRevision"]>()
    .mockResolvedValue({
      ok: true,
      value: structuredClone(starterTerritorySnapshot),
    });
  const purgeInstance = vi
    .fn<TerritoryWorldApi["purgeInstance"]>()
    .mockResolvedValue({
      ok: true,
      value: structuredClone(starterTerritorySnapshot),
    });
  const movePet = vi.fn<TerritoryWorldApi["movePet"]>().mockResolvedValue({
    ok: true,
    value: {
      path: [starterTerritorySnapshot.pet.point, { x: 9, y: 7 }],
      snapshot: structuredClone(starterTerritorySnapshot),
    },
  });
  const createCandidate = vi
    .fn<TerritoryWorldApi["createCandidate"]>()
    .mockResolvedValue({
      ok: true,
      value: {
        candidateId: starterTerritoryCandidate.id,
        snapshot: structuredClone(starterTerritorySnapshot),
      },
    });
  const editCandidate = vi
    .fn<TerritoryWorldApi["editCandidate"]>()
    .mockResolvedValue({
      ok: true,
      value: {
        candidateId: starterTerritoryCandidate.id,
        snapshot: structuredClone(starterTerritorySnapshot),
      },
    });
  const cancelCandidate = vi
    .fn<TerritoryWorldApi["cancelCandidate"]>()
    .mockResolvedValue({
      ok: true,
      value: {
        candidateId: starterTerritoryCandidate.id,
        snapshot: structuredClone(starterTerritorySnapshot),
      },
    });
  const applyCandidate = vi
    .fn<TerritoryWorldApi["applyCandidate"]>()
    .mockResolvedValue({
      ok: true,
      value: {
        candidateId: starterTerritoryCandidate.id,
        snapshot: structuredClone(starterTerritorySnapshot),
      },
    });
  let changedListener:
    Parameters<TerritoryWorldApi["subscribeChanged"]>[0] | null = null;
  const subscribeChanged = vi.fn<TerritoryWorldApi["subscribeChanged"]>(
    (listener) => {
      changedListener = listener;
      return () => {
        changedListener = null;
      };
    },
  );
  const api: TerritoryWorldApi = {
    applyCandidate,
    cancelCandidate,
    commitChangeSet,
    createCandidate,
    createSourceCandidate: vi.fn(),
    editCandidate,
    enterZone: vi.fn(),
    getSnapshot,
    getZoneView,
    movePet,
    purgeInstance,
    restoreRevision,
    subscribeChanged,
  };
  return {
    api,
    applyCandidate,
    cancelCandidate,
    commitChangeSet,
    createCandidate,
    getSnapshot,
    getZoneView,
    movePet,
    purgeInstance,
    restoreRevision,
    publishChanged: (snapshot: TerritoryWorldSnapshot) =>
      changedListener?.(snapshot),
  };
}

const providerApi: Pick<ProviderApi, "listProfiles"> = {
  listProfiles: vi.fn().mockResolvedValue({ ok: true, value: [] }),
};

describe("TerritoryPage World workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("opens one persistent World without fixed-scene or capacity copy", async () => {
    const { api, getZoneView } = createApi();
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={providerApi}
      />,
    );

    expect((await screen.findAllByText("暮色小屋")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /探索/u })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByText(/容量|12 件|场景选择/u)).not.toBeInTheDocument();
    expect(getZoneView).toHaveBeenCalledWith({
      revisionId: territoryWorldFixtureIds.revision,
      zoneId: territoryWorldFixtureIds.zone,
    });
  });

  it("keeps exploration details in a compact expandable story card", async () => {
    const { api } = createApi();
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={providerApi}
      />,
    );
    await screen.findByTestId("world-canvas");
    fireEvent.click(screen.getByRole("button", { name: "选择书桌" }));

    const storyCard = screen.getByLabelText("物件故事卡");
    expect(storyCard).toHaveAttribute("data-presentation", "compact");
    expect(storyCard).toHaveAttribute("data-expanded", "false");
    expect(within(storyCard).getByText("窗边书桌")).toBeInTheDocument();
    expect(within(storyCard).queryByText("定义版本")).not.toBeInTheDocument();

    fireEvent.click(
      within(storyCard).getByRole("button", { name: "展开详情" }),
    );
    expect(storyCard).toHaveAttribute("data-expanded", "true");
    expect(within(storyCard).getByText("定义版本")).toBeInTheDocument();

    fireEvent.click(
      within(storyCard).getByRole("button", { name: "进入建造编辑" }),
    );
    expect(screen.queryByLabelText("物件故事卡")).not.toBeInTheDocument();
    expect(screen.getByText("物件检查器")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
  });

  it("places a collection entity through the same atomic ChangeSet path", async () => {
    const { api, commitChangeSet } = createApi();
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={providerApi}
      />,
    );
    await screen.findByTestId("world-canvas");
    fireEvent.click(screen.getByRole("button", { name: /建造/u }));
    fireEvent.click(screen.getByRole("button", { name: "物件库" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: /星苔软毯/u }).at(-1)!,
    );
    expect(
      screen.getByText(territoryWorldFixtureIds.collectionInstance),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放置收藏" }));

    await waitFor(() => expect(commitChangeSet).toHaveBeenCalledTimes(1));
    const request = commitChangeSet.mock.calls[0]?.[0];
    expect(request?.changeSet.label).toContain("星苔软毯");
    const placementMutation = request?.changeSet.mutations.find(
      (mutation) => mutation.kind === "instance.put",
    );
    expect(placementMutation).toMatchObject({
      instance: {
        id: territoryWorldFixtureIds.collectionInstance,
        placement: { kind: "zone", point: { x: 4, y: 6 } },
      },
      kind: "instance.put",
    });
  });

  it("edits an existing entity and creates an immutable Definition revision", async () => {
    const { api, commitChangeSet } = createApi();
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={providerApi}
      />,
    );
    await screen.findByTestId("world-canvas");
    fireEvent.click(screen.getByRole("button", { name: "选择书桌" }));
    fireEvent.click(screen.getByRole("button", { name: "进入建造编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const name = screen.getByLabelText("名称");
    fireEvent.change(name, { target: { value: "雨夜书桌" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    await waitFor(() => expect(commitChangeSet).toHaveBeenCalledTimes(1));
    const mutations = commitChangeSet.mock.calls[0]?.[0].changeSet.mutations;
    expect(
      mutations?.find((mutation) => mutation.kind === "definition.put"),
    ).toMatchObject({
      definition: {
        id: "starter.cabin-desk",
        name: "雨夜书桌",
        revision: 2,
      },
      kind: "definition.put",
    });
    expect(
      mutations?.find((mutation) => mutation.kind === "instance.put"),
    ).toMatchObject({
      instance: {
        definition: { id: "starter.cabin-desk", revision: 2 },
      },
      kind: "instance.put",
    });
  });

  it("moves, trashes, recovers and permanently purges entities explicitly", async () => {
    const { api, commitChangeSet, purgeInstance } = createApi();
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={providerApi}
      />,
    );
    await screen.findByTestId("world-canvas");
    fireEvent.click(screen.getByRole("button", { name: "移动书桌" }));
    await waitFor(() => expect(commitChangeSet).toHaveBeenCalledTimes(1));
    const moveMutation =
      commitChangeSet.mock.calls[0]?.[0].changeSet.mutations[0];
    expect(moveMutation).toMatchObject({
      instance: { placement: { point: { x: 7, y: 5 } } },
      kind: "instance.put",
    });

    fireEvent.click(screen.getByRole("button", { name: "物件库" }));
    fireEvent.click(screen.getByRole("button", { name: /回收站/u }));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(commitChangeSet).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /回收站/u }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() =>
      expect(purgeInstance).toHaveBeenCalledWith({
        instanceId: territoryWorldFixtureIds.trashedInstance,
      }),
    );
  });

  it("creates scoped AI previews and applies a ready candidate atomically", async () => {
    const { api, applyCandidate, createCandidate, publishChanged } =
      createApi();
    const generating: TerritoryWorldSnapshot = structuredClone(
      starterTerritorySnapshot,
    );
    generating.candidates[0] = {
      ...generating.candidates[0]!,
      changeSet: null,
      previewGroups: [],
      status: "generating",
    };
    createCandidate.mockResolvedValue({
      ok: true,
      value: {
        candidateId: starterTerritoryCandidate.id,
        snapshot: generating,
      },
    });
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={providerApi}
      />,
    );
    await screen.findByTestId("world-canvas");
    fireEvent.click(screen.getByRole("button", { name: /AI 创作/u }));
    fireEvent.change(screen.getByLabelText("创作指令"), {
      target: { value: "把窗边改成雨夜植物角，保留书桌。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成可审阅预览" }));
    await waitFor(() => expect(createCandidate).toHaveBeenCalledTimes(1));
    expect(createCandidate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        baseRevisionId: territoryWorldFixtureIds.revision,
        intent: "item",
        scope: { kind: "zone", zoneId: territoryWorldFixtureIds.zone },
      }),
    );

    expect(await screen.findByText("正在生成")).toBeInTheDocument();
    publishChanged(structuredClone(starterTerritorySnapshot));
    expect(await screen.findByText("正在预览 AI 变更")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "修改后" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "修改前" }));
    expect(screen.getByRole("button", { name: "修改前" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "应用到领地" }));
    await waitFor(() =>
      expect(applyCandidate).toHaveBeenCalledWith({
        candidateId: starterTerritoryCandidate.id,
      }),
    );
  });

  it("keeps a background generation cancellable after the immediate response", async () => {
    const { api, cancelCandidate, createCandidate } = createApi();
    const generating: TerritoryWorldSnapshot = structuredClone(
      starterTerritorySnapshot,
    );
    generating.candidates[0] = {
      ...generating.candidates[0]!,
      changeSet: null,
      previewGroups: [],
      status: "generating",
    };
    createCandidate.mockResolvedValue({
      ok: true,
      value: {
        candidateId: starterTerritoryCandidate.id,
        snapshot: generating,
      },
    });
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={providerApi}
      />,
    );
    await screen.findByTestId("world-canvas");
    fireEvent.click(screen.getByRole("button", { name: /AI 创作/u }));
    fireEvent.change(screen.getByLabelText("创作指令"), {
      target: { value: "生成一盏月光吊灯" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成可审阅预览" }));
    const cancel = await screen.findByRole("button", { name: "取消预览" });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(cancelCandidate).toHaveBeenCalledWith({
        candidateId: starterTerritoryCandidate.id,
      }),
    );
  });

  it("opens a focused Memory candidate directly in review", async () => {
    const { api } = createApi();
    const onFocusConsumed = vi.fn();
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        focusCandidateId={starterTerritoryCandidate.id}
        onFocusConsumed={onFocusConsumed}
        providerApi={providerApi}
      />,
    );
    expect(await screen.findByText("AI 创作台")).toBeInTheDocument();
    expect(screen.getByText("正在预览 AI 变更")).toBeInTheDocument();
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
  });

  it("shows a skippable source reveal after applying a Memory item", async () => {
    const { api, getSnapshot } = createApi();
    const snapshot: TerritoryWorldSnapshot = structuredClone(
      starterTerritorySnapshot,
    );
    snapshot.candidates[0] = {
      ...snapshot.candidates[0]!,
      sources: [
        {
          id: "70000000-0000-4000-8000-000000000001",
          kind: "memory",
          label: "第一次一起完成长项目",
          occurredAt: "2026-08-12T08:00:00.000Z",
          revisionId: "70000000-0000-4000-8000-000000000002",
        },
      ],
    };
    getSnapshot.mockResolvedValue({ ok: true, value: snapshot });
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        focusCandidateId={starterTerritoryCandidate.id}
        providerApi={providerApi}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "应用到领地" }));
    expect(
      await screen.findByText("一段共同经历落进了领地"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "跳过演出" }));
    expect(
      screen.queryByText("一段共同经历落进了领地"),
    ).not.toBeInTheDocument();
  });

  it("restores immutable history and offers session undo", async () => {
    const snapshot: TerritoryWorldSnapshot = structuredClone(
      starterTerritorySnapshot,
    );
    snapshot.revisions.push({
      ...snapshot.revisions[0]!,
      createdAt: "2026-08-13T09:00:00.000Z",
      id: "10000000-0000-4000-8000-000000000002",
      label: "布置阅读角",
      parentRevisionId: territoryWorldFixtureIds.revision,
      reason: "direct",
      sequence: 2,
    });
    snapshot.world.currentRevision = snapshot.revisions[1]!;
    const { api, getSnapshot, restoreRevision } = createApi();
    getSnapshot.mockResolvedValue({ ok: true, value: snapshot });
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={providerApi}
      />,
    );
    await screen.findByTestId("world-canvas");
    fireEvent.click(screen.getByRole("button", { name: "版本历史" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(restoreRevision).toHaveBeenCalledWith({
        revisionId: territoryWorldFixtureIds.revision,
      }),
    );
  });

  it("selects an entity without moving the pet or invoking pathfinding", async () => {
    const { api, movePet } = createApi();
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={providerApi}
      />,
    );
    await screen.findByTestId("world-canvas");
    fireEvent.click(screen.getByRole("button", { name: "选择书桌" }));
    expect(await screen.findByText("窗边书桌")).toBeVisible();
    expect(movePet).not.toHaveBeenCalled();
  });
});
