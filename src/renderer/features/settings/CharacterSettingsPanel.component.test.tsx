import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PetLibrarySnapshot,
  PetManagementApi,
} from "../../../shared/contracts/pet";
import { CharacterSettingsPanel } from "./CharacterSettingsPanel";

afterEach(cleanup);

const pets = [
  {
    description: "Legacy v1 pet",
    displayName: "Linnea",
    id: "linnea",
    spriteHeight: 1872,
    spriteUrl: "chara-mate-pet://asset/linnea/spritesheet.webp",
    spriteVersionNumber: 1 as const,
    spriteWidth: 1536,
  },
  {
    description: "Directional v2 pet",
    displayName: "Columbinya",
    id: "columbinya",
    spriteHeight: 2288,
    spriteUrl: "chara-mate-pet://asset/columbinya/spritesheet.webp",
    spriteVersionNumber: 2 as const,
    spriteWidth: 1536,
  },
];

function createApi(initial: PetLibrarySnapshot) {
  const getLibrary = vi
    .fn<PetManagementApi["getLibrary"]>()
    .mockResolvedValue({ ok: true, value: initial });
  const importFromFolder = vi
    .fn<PetManagementApi["importFromFolder"]>()
    .mockResolvedValue({ ok: true, value: pets[1] ?? null });
  const select = vi
    .fn<PetManagementApi["select"]>()
    .mockImplementation(({ petId }) =>
      Promise.resolve({ ok: true, value: { ...initial, activePetId: petId } }),
    );
  const setScale = vi
    .fn<PetManagementApi["setScale"]>()
    .mockImplementation(({ scale }) =>
      Promise.resolve({ ok: true, value: { ...initial, scale } }),
    );
  const setAnimationSpeed = vi
    .fn<PetManagementApi["setAnimationSpeed"]>()
    .mockImplementation(({ animationSpeed }) =>
      Promise.resolve({
        ok: true,
        value: { ...initial, animationSpeed },
      }),
    );
  const api: PetManagementApi = {
    getLibrary,
    importFromFolder,
    select,
    setAnimationSpeed,
    setScale,
    subscribeChanged: () => () => undefined,
    subscribeOpenMain: () => () => undefined,
    subscribeOpenConversation: () => () => undefined,
  };
  return {
    api,
    importFromFolder,
    select,
    setAnimationSpeed,
    setScale,
  };
}

describe("Character Settings", () => {
  it("lists v1/v2 pets and changes the active pet and scale", async () => {
    const initial: PetLibrarySnapshot = {
      activePetId: "columbinya",
      animationSpeed: 0.75,
      pets,
      scale: 1,
    };
    const { api, select, setAnimationSpeed, setScale } = createApi(initial);
    render(<CharacterSettingsPanel api={api} />);

    expect(await screen.findByText("Legacy v1 pet")).toBeVisible();
    expect(screen.getByText("1536×1872")).toBeVisible();
    expect(screen.getByText("1536×2288")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Columbinya 已选" }),
    ).toBeDisabled();

    expect(screen.getAllByText(/^v[12]$/u)).toHaveLength(2);
    expect(screen.getByLabelText("桌宠大小")).toHaveAttribute("min", "0.3");
    expect(screen.getByLabelText("动画速度")).toHaveAttribute("min", "0.1");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择 Linnea" }));
    await waitFor(() =>
      expect(select).toHaveBeenCalledWith({ petId: "linnea" }),
    );
    fireEvent.change(screen.getByLabelText("桌宠大小"), {
      target: { value: "1.25" },
    });
    await waitFor(() => expect(setScale).toHaveBeenCalledWith({ scale: 1.25 }));
    fireEvent.change(screen.getByLabelText("动画速度"), {
      target: { value: "0.6" },
    });
    await waitFor(() =>
      expect(setAnimationSpeed).toHaveBeenCalledWith({ animationSpeed: 0.6 }),
    );
    expect(screen.queryByText("60%")).not.toBeInTheDocument();
  });

  it("opens the native folder import and renders bounded errors", async () => {
    const initial: PetLibrarySnapshot = {
      activePetId: null,
      animationSpeed: 0.75,
      pets: [],
      scale: 1,
    };
    const { api, importFromFolder } = createApi(initial);
    importFromFolder.mockResolvedValueOnce({
      error: {
        code: "PET.INVALID_FORMAT",
        message: "v2 spritesheet 应为 1536×2288。",
        retryable: false,
      },
      ok: false,
    });
    render(<CharacterSettingsPanel api={api} />);

    await screen.findByText("还没有导入桌宠");
    fireEvent.click(screen.getByRole("button", { name: "导入 Codex 桌宠" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("v2 spritesheet 应为 1536×2288。");
  });
});
