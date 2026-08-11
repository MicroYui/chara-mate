import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderApi } from "../../../shared/contracts/provider";
import type {
  TerritoryApi,
  TerritoryItem,
  TerritoryPoint,
  TerritoryRotation,
  TerritorySceneTarget,
} from "../../../shared/contracts/territory";
import {
  activeTerritorySnapshot,
  emptyTerritorySnapshot,
} from "../../../../tests/fixtures/territory";
import {
  territoryCupManifest,
  territoryDeskManifest,
} from "../../../../tests/fixtures/territoryItemManifests";
import { TerritoryPage } from "./TerritoryPage";

vi.mock("./PixiTerritoryCanvas", () => ({
  PixiTerritoryCanvas: ({
    movement,
    onMoveRequest,
    onPetPositionChange,
    onPlaceRequest,
    selectedItem,
    selectedTransform,
  }: {
    movement: {
      readonly path: readonly { readonly x: number; readonly y: number }[];
    } | null;
    onMoveRequest: (point: TerritoryPoint) => void;
    onPetPositionChange: (point: { x: number; y: number }) => void;
    onPlaceRequest: (
      item: TerritoryItem,
      target: TerritorySceneTarget,
      transform: { flipped: boolean; rotation: TerritoryRotation },
    ) => Promise<boolean>;
    selectedItem: TerritoryItem | null;
    selectedTransform: { flipped: boolean; rotation: TerritoryRotation };
  }) => (
    <div role="img" aria-label="测试领地画布">
      <output data-testid="rendered-movement-path">
        {JSON.stringify(movement?.path ?? [])}
      </output>
      <button type="button" onClick={() => onMoveRequest({ x: 7, y: 6 })}>
        点击地面
      </button>
      <button type="button" onClick={() => onMoveRequest({ x: 8, y: 6 })}>
        点击当前格
      </button>
      <button
        type="button"
        onClick={() => {
          onPetPositionChange({ x: 5.4, y: 6 });
          onMoveRequest({ x: 9, y: 6 });
        }}
      >
        行走中改目标
      </button>
      {selectedItem ? (
        selectedItem.manifest.placement.mode === "surface" ? (
          <button
            type="button"
            onClick={() =>
              void onPlaceRequest(
                selectedItem,
                {
                  kind: "surface",
                  sceneId: "forest-cabin",
                  slotId: "left",
                  supportItemId: "forest-cabin.desk",
                },
                selectedTransform,
              )
            }
          >
            放到桌面插槽
          </button>
        ) : (
          <button
            type="button"
            onClick={() =>
              void onPlaceRequest(
                selectedItem,
                {
                  kind: "ground",
                  sceneId: "forest-cabin",
                  x: 6,
                  y: 6,
                },
                selectedTransform,
              )
            }
          >
            放到网格
          </button>
        )
      ) : null}
    </div>
  ),
}));

afterEach(cleanup);

function makeApi() {
  const candidateId = "5bc2c1bc-3dbe-49cd-964d-e0f60891f501";
  const hearth = activeTerritorySnapshot.activeScene?.placements[0];
  if (!hearth || !activeTerritorySnapshot.activeScene) {
    throw new Error("Missing active Territory fixture");
  }
  const collected = {
    ...activeTerritorySnapshot,
    activeScene: {
      ...activeTerritorySnapshot.activeScene,
      placements: [],
    },
    collection: [
      {
        ...hearth,
        target: { kind: "collection" as const },
      },
    ],
  };
  const moved = {
    ...activeTerritorySnapshot,
    activeScene: {
      ...activeTerritorySnapshot.activeScene,
      pet: { facing: "left" as const, x: 7, y: 6 },
    },
  };
  const collectItem = vi
    .fn<TerritoryApi["collectItem"]>()
    .mockResolvedValue({ ok: true, value: collected });
  const imageMutation = {
    ok: true as const,
    value: { candidateId, snapshot: activeTerritorySnapshot },
  };
  const confirmImageCandidate = vi
    .fn<TerritoryApi["confirmImageCandidate"]>()
    .mockResolvedValue(imageMutation);
  const editImageCandidate = vi
    .fn<TerritoryApi["editImageCandidate"]>()
    .mockResolvedValue(imageMutation);
  const generateImageCandidate = vi
    .fn<TerritoryApi["generateImageCandidate"]>()
    .mockResolvedValue(imageMutation);
  const getSnapshot = vi.fn<TerritoryApi["getSnapshot"]>().mockResolvedValue({
    ok: true,
    value: emptyTerritorySnapshot,
  });
  const movePet = vi.fn<TerritoryApi["movePet"]>().mockResolvedValue({
    ok: true,
    value: {
      path: [
        { x: 8, y: 6 },
        { x: 7, y: 6 },
      ],
      snapshot: moved,
    },
  });
  const placeItem = vi.fn<TerritoryApi["placeItem"]>().mockResolvedValue({
    ok: true,
    value: activeTerritorySnapshot,
  });
  const selectScene = vi.fn<TerritoryApi["selectScene"]>().mockResolvedValue({
    ok: true,
    value: activeTerritorySnapshot,
  });
  const retryImageCandidate = vi
    .fn<TerritoryApi["retryImageCandidate"]>()
    .mockResolvedValue(imageMutation);
  const selectItemVersion = vi
    .fn<TerritoryApi["selectItemVersion"]>()
    .mockResolvedValue({ ok: true, value: activeTerritorySnapshot });
  const setItemPinned = vi
    .fn<TerritoryApi["setItemPinned"]>()
    .mockResolvedValue({ ok: true, value: activeTerritorySnapshot });
  const api: TerritoryApi = {
    collectItem,
    confirmImageCandidate,
    createSourceCandidate: vi.fn().mockResolvedValue({
      ok: true,
      value: { candidateId, snapshot: activeTerritorySnapshot },
    }),
    editImageCandidate,
    generateImageCandidate,
    getSnapshot,
    movePet,
    placeItem,
    retryImageCandidate,
    selectScene,
    selectItemVersion,
    setItemPinned,
  };
  return {
    api,
    collectItem,
    confirmImageCandidate,
    editImageCandidate,
    generateImageCandidate,
    getSnapshot,
    movePet,
    placeItem,
    retryImageCandidate,
    selectScene,
    selectItemVersion,
    setItemPinned,
  };
}

describe("Territory first experience and editor host", () => {
  it("opens a Memory candidate and keeps source, version and pin controls explicit", async () => {
    const candidateId = "6b90bf76-893b-47dc-b9ea-913d0c25c5e6";
    const memoryId = "17bd6914-d46b-44ee-9776-c0aa07ae91cd";
    const baseItem = activeTerritorySnapshot.activeScene?.placements[0];
    if (!baseItem || !activeTerritorySnapshot.activeScene) {
      throw new Error("Missing active Territory fixture");
    }
    const versionOne = {
      ...baseItem.manifest,
      definitionId: `memory.${candidateId}`,
      revision: 1,
    };
    const versionTwo = {
      ...versionOne,
      description: "把共同完成的第一版留成一盏更明亮的灯。",
      revision: 2,
    };
    const sourcedItem: TerritoryItem = {
      ...baseItem,
      id: `memory.${candidateId}`,
      manifest: versionTwo,
      sources: [
        {
          id: memoryId,
          kind: "memory",
          label: "一起完成了第一版 CharaMate。",
          occurredAt: "2026-08-05T08:00:00.000Z",
          revisionId: "a640015a-bb31-4b8a-bf5e-bc95ba3546e7",
        },
      ],
      versions: [
        {
          active: true,
          createdAt: "2026-08-08T10:01:00.000Z",
          manifest: versionTwo,
          revision: 2,
        },
        {
          active: false,
          createdAt: "2026-08-08T10:00:00.000Z",
          manifest: versionOne,
          revision: 1,
        },
      ],
    };
    const sourcedSnapshot = {
      ...activeTerritorySnapshot,
      activeScene: {
        ...activeTerritorySnapshot.activeScene,
        placements: [sourcedItem],
      },
      itemCandidates: [
        {
          createdAt: "2026-08-08T10:00:00.000Z" as const,
          description: "把共同完成的第一版留成一件安静的小纪念。",
          id: candidateId,
          itemId: sourcedItem.id,
          name: "一起完成的项目",
          sources: sourcedItem.sources,
          status: "materialized" as const,
          suggestedSceneId: "forest-cabin" as const,
          updatedAt: "2026-08-08T10:01:00.000Z" as const,
          visualPrompt: "一盏温暖的像素风纪念灯",
        },
      ],
    };
    const { api, getSnapshot, selectItemVersion, setItemPinned } = makeApi();
    getSnapshot.mockResolvedValueOnce({ ok: true, value: sourcedSnapshot });
    selectItemVersion.mockResolvedValue({ ok: true, value: sourcedSnapshot });
    setItemPinned.mockResolvedValue({ ok: true, value: sourcedSnapshot });
    const onFocusConsumed = vi.fn();
    const onOpenMemorySource = vi.fn();
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        focusCandidateId={candidateId}
        onFocusConsumed={onFocusConsumed}
        onOpenMemorySource={onOpenMemorySource}
        providerApi={{
          listProfiles: vi.fn().mockResolvedValue({ ok: true, value: [] }),
        }}
      />,
    );

    expect(await screen.findByDisplayValue("一起完成的项目")).toBeVisible();
    expect(screen.getByText("为这段记忆生成新版本")).toBeVisible();
    await waitFor(() => expect(onFocusConsumed).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "关闭生成面板" }));
    fireEvent.click(screen.getByRole("button", { name: "收藏库" }));
    const drawer = screen.getByRole("complementary", { name: "领地收藏库" });
    expect(
      within(drawer).getByText(
        "场景 1/12 · 超出后最早且未置顶的物件会自动收回",
      ),
    ).toBeVisible();
    fireEvent.click(
      within(drawer).getByRole("button", {
        name: /把共同完成的第一版留成一盏/u,
      }),
    );
    expect(screen.getByText(/Memory 来源/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "在 Memory 中查看" }));
    expect(onOpenMemorySource).toHaveBeenCalledWith(memoryId);

    fireEvent.click(screen.getByRole("button", { name: "置顶" }));
    await waitFor(() =>
      expect(setItemPinned).toHaveBeenCalledWith({
        itemId: sourcedItem.id,
        pinned: true,
      }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "物件版本" }), {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(selectItemVersion).toHaveBeenCalledWith({
        itemId: sourcedItem.id,
        revision: 1,
      }),
    );
  });

  it("selects a local scene and moves the pet through the typed API", async () => {
    const { api, movePet, selectScene } = makeApi();
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={{
          listProfiles: vi.fn().mockResolvedValue({ ok: true, value: [] }),
        }}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "先选一处想停留的地方",
      }),
    ).toBeVisible();
    expect(screen.getAllByRole("button")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /林间小屋/u }));

    await waitFor(() =>
      expect(selectScene).toHaveBeenCalledWith({
        sceneId: "forest-cabin",
      }),
    );
    expect(
      await screen.findByRole("img", { name: "测试领地画布" }),
    ).toBeVisible();
    expect(
      screen.getByText("这里会慢慢装下，我们一起走过的日子。"),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "点击地面" }));
    await waitFor(() =>
      expect(movePet).toHaveBeenCalledWith({
        from: { x: 8, y: 6 },
        sceneId: "forest-cabin",
        x: 7,
        y: 6,
      }),
    );
  });

  it("keeps accepting movement after clicking the current grid cell", async () => {
    const { api, getSnapshot, movePet } = makeApi();
    getSnapshot.mockResolvedValueOnce({
      ok: true,
      value: activeTerritorySnapshot,
    });
    movePet.mockResolvedValue({
      ok: true,
      value: {
        path: [{ x: 8, y: 6 }],
        snapshot: activeTerritorySnapshot,
      },
    });
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={{
          listProfiles: vi.fn().mockResolvedValue({ ok: true, value: [] }),
        }}
      />,
    );
    await screen.findByRole("img", { name: "测试领地画布" });

    fireEvent.click(screen.getByRole("button", { name: "点击当前格" }));
    await waitFor(() => expect(movePet).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "点击当前格" }));
    await waitFor(() => expect(movePet).toHaveBeenCalledTimes(2));
  });

  it("reroutes an active movement from the currently rendered grid", async () => {
    const { api, getSnapshot, movePet } = makeApi();
    getSnapshot.mockResolvedValueOnce({
      ok: true,
      value: activeTerritorySnapshot,
    });
    const reroutedSnapshot = {
      ...activeTerritorySnapshot,
      activeScene: activeTerritorySnapshot.activeScene
        ? {
            ...activeTerritorySnapshot.activeScene,
            pet: { facing: "right" as const, x: 9, y: 6 },
          }
        : null,
    };
    movePet
      .mockResolvedValueOnce({
        ok: true,
        value: {
          path: [
            { x: 8, y: 6 },
            { x: 7, y: 6 },
          ],
          snapshot: activeTerritorySnapshot,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          path: [
            { x: 5, y: 6 },
            { x: 6, y: 6 },
            { x: 7, y: 6 },
            { x: 8, y: 6 },
            { x: 9, y: 6 },
          ],
          snapshot: reroutedSnapshot,
        },
      });
    render(
      <TerritoryPage activePet={undefined} animationSpeed={0.75} api={api} />,
    );
    await screen.findByRole("img", { name: "测试领地画布" });

    fireEvent.click(screen.getByRole("button", { name: "点击地面" }));
    await waitFor(() => expect(movePet).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "行走中改目标" }));

    await waitFor(() => expect(movePet).toHaveBeenCalledTimes(2));
    expect(movePet).toHaveBeenLastCalledWith({
      from: { x: 5, y: 6 },
      sceneId: "forest-cabin",
      x: 9,
      y: 6,
    });
    await waitFor(() =>
      expect(screen.getByTestId("rendered-movement-path")).toHaveTextContent(
        JSON.stringify([
          { x: 5.4, y: 6 },
          { x: 6, y: 6 },
          { x: 7, y: 6 },
          { x: 8, y: 6 },
          { x: 9, y: 6 },
        ]),
      ),
    );
  });

  it("collects an item and places it back from the editor drawer", async () => {
    const { api, collectItem, getSnapshot, placeItem } = makeApi();
    getSnapshot.mockResolvedValueOnce({
      ok: true,
      value: activeTerritorySnapshot,
    });
    render(
      <TerritoryPage activePet={undefined} animationSpeed={0.75} api={api} />,
    );
    await screen.findByRole("img", { name: "测试领地画布" });

    fireEvent.click(screen.getByRole("button", { name: "布置" }));
    const drawer = screen.getByRole("complementary", { name: "领地收藏库" });
    fireEvent.click(within(drawer).getByRole("button", { name: /苔石壁炉/u }));
    fireEvent.click(screen.getByRole("button", { name: "收回" }));

    await waitFor(() =>
      expect(collectItem).toHaveBeenCalledWith({
        itemId: "forest-cabin.hearth",
        sceneId: "forest-cabin",
      }),
    );
    expect(await screen.findByText("选择高亮网格即可放入场景")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "放到网格" }));
    await waitFor(() =>
      expect(placeItem).toHaveBeenCalledWith({
        flipped: false,
        itemId: "forest-cabin.hearth",
        rotation: 0,
        target: {
          kind: "ground",
          sceneId: "forest-cabin",
          x: 6,
          y: 6,
        },
      }),
    );
  });

  it("places a Collection accessory through the same structured surface target", async () => {
    if (!activeTerritorySnapshot.activeScene) {
      throw new Error("Missing active Territory fixture");
    }
    const desk: TerritoryItem = {
      flipped: false,
      id: "forest-cabin.desk",
      manifest: territoryDeskManifest,
      pinned: false,
      placedAt: "2026-08-06T08:00:00.000Z",
      rotation: 0,
      sources: [],
      target: {
        kind: "ground",
        sceneId: "forest-cabin",
        x: 11,
        y: 4,
      },
      updatedAt: "2026-08-06T08:00:00.000Z",
      versions: [
        {
          active: true,
          createdAt: "2026-08-06T08:00:00.000Z",
          manifest: territoryDeskManifest,
          revision: 1,
        },
      ],
    };
    const cup: TerritoryItem = {
      flipped: false,
      id: "collection.ceramic-cup",
      manifest: territoryCupManifest,
      pinned: false,
      placedAt: null,
      rotation: 0,
      sources: [],
      target: { kind: "collection" },
      updatedAt: "2026-08-06T08:00:00.000Z",
      versions: [
        {
          active: true,
          createdAt: "2026-08-06T08:00:00.000Z",
          manifest: territoryCupManifest,
          revision: 1,
        },
      ],
    };
    const withAccessory = {
      ...activeTerritorySnapshot,
      activeScene: {
        ...activeTerritorySnapshot.activeScene,
        placements: [desk],
      },
      collection: [cup],
    };
    const { api, getSnapshot, placeItem } = makeApi();
    getSnapshot.mockResolvedValueOnce({ ok: true, value: withAccessory });
    placeItem.mockResolvedValueOnce({ ok: true, value: withAccessory });
    render(
      <TerritoryPage activePet={undefined} animationSpeed={0.75} api={api} />,
    );
    await screen.findByRole("img", { name: "测试领地画布" });

    fireEvent.click(screen.getByRole("button", { name: "布置" }));
    const drawer = screen.getByRole("complementary", { name: "领地收藏库" });
    fireEvent.click(within(drawer).getByRole("button", { name: /暖陶杯/u }));
    expect(screen.getByText("点击场景中发光的桌面插槽")).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "领地收藏库" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放到桌面插槽" }));

    await waitFor(() =>
      expect(placeItem).toHaveBeenCalledWith({
        flipped: false,
        itemId: "collection.ceramic-cup",
        rotation: 0,
        target: {
          kind: "surface",
          sceneId: "forest-cabin",
          slotId: "left",
          supportItemId: "forest-cabin.desk",
        },
      }),
    );
  });

  it("generates, edits and confirms a persisted image candidate", async () => {
    const profileId = "d0197d17-a231-41e0-afe2-664791a531ec";
    const firstId = "5bc2c1bc-3dbe-49cd-964d-e0f60891f501";
    const editId = "311b6772-af77-48ba-a545-9c1940544154";
    const readyCandidate = {
      acceptedItemId: null,
      createdAt: "2026-08-08T10:00:00.000Z",
      description: "留一盏灯，纪念完成项目的夜晚。",
      editInstruction: null,
      error: null,
      id: firstId,
      itemCandidateId: null,
      name: "长夜台灯",
      operation: "generate" as const,
      providerProfileId: profileId,
      sceneId: "forest-cabin" as const,
      sourceCandidateId: null,
      status: "ready" as const,
      structure: null,
      updatedAt: "2026-08-08T10:01:00.000Z",
      visualPrompt: "一盏小巧的黄铜工坊台灯",
    };
    const generatedSnapshot = {
      ...activeTerritorySnapshot,
      imageCandidates: [readyCandidate],
    };
    const editedCandidate = {
      ...readyCandidate,
      createdAt: "2026-08-08T10:02:00.000Z",
      editInstruction: "把灯罩改成琥珀玻璃",
      id: editId,
      operation: "edit" as const,
      sourceCandidateId: firstId,
      updatedAt: "2026-08-08T10:03:00.000Z",
    };
    const editedSnapshot = {
      ...activeTerritorySnapshot,
      imageCandidates: [editedCandidate, readyCandidate],
    };
    const acceptedSnapshot = {
      ...editedSnapshot,
      imageCandidates: [
        {
          ...editedCandidate,
          acceptedItemId: `generated.${editId}`,
          status: "accepted" as const,
          updatedAt: "2026-08-08T10:04:00.000Z",
        },
        readyCandidate,
      ],
    };
    const {
      api,
      confirmImageCandidate,
      editImageCandidate,
      generateImageCandidate,
      getSnapshot,
    } = makeApi();
    getSnapshot.mockResolvedValueOnce({
      ok: true,
      value: activeTerritorySnapshot,
    });
    generateImageCandidate.mockResolvedValueOnce({
      ok: true,
      value: { candidateId: firstId, snapshot: generatedSnapshot },
    });
    editImageCandidate.mockResolvedValueOnce({
      ok: true,
      value: { candidateId: editId, snapshot: editedSnapshot },
    });
    confirmImageCandidate.mockResolvedValueOnce({
      ok: true,
      value: { candidateId: editId, snapshot: acceptedSnapshot },
    });
    const providerApi: Pick<ProviderApi, "listProfiles"> = {
      listProfiles: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            apiStyle: "azure-openai",
            apiVersion: "2025-04-01-preview",
            baseUrl: "https://azure.example.com",
            createdAt: "2026-08-08T08:00:00.000Z",
            hasApiKey: true,
            id: profileId,
            imageGenerationEndpoint:
              "https://azure.example.com/openai/deployments/gpt-image-2/images/generations",
            imageModel: "gpt-image-2",
            name: "azure",
            updatedAt: "2026-08-08T08:00:00.000Z",
          },
        ],
      }),
    };
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={providerApi}
      />,
    );
    await screen.findByRole("img", { name: "测试领地画布" });

    fireEvent.click(screen.getByRole("button", { name: "生成物件" }));
    expect(await screen.findByText("使用 azure · gpt-image-2")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
      target: { value: "长夜台灯" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "简短描述" }), {
      target: { value: "留一盏灯，纪念完成项目的夜晚。" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "想生成的样子" }), {
      target: { value: "一盏小巧的黄铜工坊台灯" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));

    await waitFor(() =>
      expect(generateImageCandidate).toHaveBeenCalledWith({
        description: "留一盏灯，纪念完成项目的夜晚。",
        name: "长夜台灯",
        providerProfileId: profileId,
        sceneId: "forest-cabin",
        visualPrompt: "一盏小巧的黄铜工坊台灯",
      }),
    );
    expect(
      await screen.findByRole("img", { name: "长夜台灯预览" }),
    ).toBeVisible();

    fireEvent.change(screen.getByRole("textbox", { name: "继续修改" }), {
      target: { value: "把灯罩改成琥珀玻璃" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成修改版" }));
    await waitFor(() =>
      expect(editImageCandidate).toHaveBeenCalledWith({
        candidateId: firstId,
        instruction: "把灯罩改成琥珀玻璃",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "确认加入收藏库" }),
    );
    await waitFor(() =>
      expect(confirmImageCandidate).toHaveBeenCalledWith({
        candidateId: editId,
      }),
    );
    expect(
      await screen.findByRole("complementary", { name: "领地收藏库" }),
    ).toBeVisible();
  });

  it("restores a failed candidate and exposes its retry action", async () => {
    const candidateId = "61e0b15d-a46d-4268-9a2c-6c4bd271a627";
    const failedCandidate = {
      acceptedItemId: null,
      createdAt: "2026-08-08T10:00:00.000Z",
      description: "一枚安静的小纪念。",
      editInstruction: null,
      error: {
        code: "PROVIDER.RATE_LIMITED",
        message: "Provider 暂时限制了请求，请稍后重试。",
        retryable: true,
      },
      id: candidateId,
      itemCandidateId: null,
      name: "微光摆件",
      operation: "generate" as const,
      providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
      sceneId: "forest-cabin" as const,
      sourceCandidateId: null,
      status: "failed" as const,
      structure: null,
      updatedAt: "2026-08-08T10:01:00.000Z",
      visualPrompt: "一枚发出微光的小摆件",
    };
    const failedSnapshot = {
      ...activeTerritorySnapshot,
      imageCandidates: [failedCandidate],
    };
    const readySnapshot = {
      ...failedSnapshot,
      imageCandidates: [
        {
          ...failedCandidate,
          error: null,
          status: "ready" as const,
          updatedAt: "2026-08-08T10:02:00.000Z",
        },
      ],
    };
    const { api, getSnapshot, retryImageCandidate } = makeApi();
    getSnapshot.mockResolvedValueOnce({ ok: true, value: failedSnapshot });
    retryImageCandidate.mockResolvedValueOnce({
      ok: true,
      value: { candidateId, snapshot: readySnapshot },
    });
    render(
      <TerritoryPage
        activePet={undefined}
        animationSpeed={0.75}
        api={api}
        providerApi={{
          listProfiles: vi.fn().mockResolvedValue({ ok: true, value: [] }),
        }}
      />,
    );
    await screen.findByRole("img", { name: "测试领地画布" });

    fireEvent.click(screen.getByRole("button", { name: "生成物件" }));
    expect(
      await screen.findByText("Provider 暂时限制了请求，请稍后重试。"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() =>
      expect(retryImageCandidate).toHaveBeenCalledWith({ candidateId }),
    );
    expect(
      await screen.findByRole("img", { name: "微光摆件预览" }),
    ).toBeVisible();
  });
});
