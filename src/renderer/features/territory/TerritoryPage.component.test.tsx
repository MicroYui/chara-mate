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
  const api: TerritoryApi = {
    collectItem,
    getSnapshot,
    movePet,
    placeItem,
    selectScene,
  };
  return {
    api,
    collectItem,
    getSnapshot,
    movePet,
    placeItem,
    selectScene,
  };
}

describe("Territory first experience and editor host", () => {
  it("selects a local scene and moves the pet through the typed API", async () => {
    const { api, movePet, selectScene } = makeApi();
    render(
      <TerritoryPage activePet={undefined} animationSpeed={0.75} api={api} />,
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
      <TerritoryPage activePet={undefined} animationSpeed={0.75} api={api} />,
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
      target: {
        kind: "ground",
        sceneId: "forest-cabin",
        x: 11,
        y: 4,
      },
      updatedAt: "2026-08-06T08:00:00.000Z",
    };
    const cup: TerritoryItem = {
      flipped: false,
      id: "collection.ceramic-cup",
      manifest: territoryCupManifest,
      pinned: false,
      placedAt: null,
      rotation: 0,
      target: { kind: "collection" },
      updatedAt: "2026-08-06T08:00:00.000Z",
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
});
