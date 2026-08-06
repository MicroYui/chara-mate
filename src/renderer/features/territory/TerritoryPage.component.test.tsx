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
} from "../../../shared/contracts/territory";
import {
  activeTerritorySnapshot,
  emptyTerritorySnapshot,
} from "../../../../tests/fixtures/territory";
import { TerritoryPage } from "./TerritoryPage";

vi.mock("./PixiTerritoryCanvas", () => ({
  PixiTerritoryCanvas: ({
    onMoveRequest,
    onPetPositionChange,
    onPlaceRequest,
    selectedItem,
    selectedTransform,
  }: {
    onMoveRequest: (point: TerritoryPoint) => void;
    onPetPositionChange: (point: { x: number; y: number }) => void;
    onPlaceRequest: (
      item: TerritoryItem,
      point: TerritoryPoint,
      transform: { flipped: boolean; rotation: TerritoryRotation },
    ) => Promise<boolean>;
    selectedItem: TerritoryItem | null;
    selectedTransform: { flipped: boolean; rotation: TerritoryRotation };
  }) => (
    <div role="img" aria-label="测试领地画布">
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
          onMoveRequest({ x: 2, y: 6 });
        }}
      >
        行走中改目标
      </button>
      {selectedItem ? (
        <button
          type="button"
          onClick={() =>
            void onPlaceRequest(selectedItem, { x: 6, y: 6 }, selectedTransform)
          }
        >
          放到网格
        </button>
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
        location: "collection" as const,
        sceneId: null,
        x: null,
        y: null,
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
      x: 2,
      y: 6,
    });
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
        sceneId: "forest-cabin",
        x: 6,
        y: 6,
      }),
    );
  });
});
