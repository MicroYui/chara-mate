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
import type {
  PersonaApi,
  PersonaLibrarySnapshot,
} from "../../../shared/contracts/persona";
import type { SettingsApi } from "../../../shared/contracts/settings";
import {
  FIXTURE_TIMESTAMPS,
  personaSnapshotFixture,
} from "../../../../tests/fixtures/foundationContracts";
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

const personaLibrary: PersonaLibrarySnapshot = {
  activePersonaId: personaSnapshotFixture.personaId,
  personas: [
    {
      createdAt: FIXTURE_TIMESTAMPS.created,
      kind: "preset",
      snapshot: personaSnapshotFixture,
      updatedAt: FIXTURE_TIMESTAMPS.updated,
    },
  ],
};

function createPersonaApi() {
  const getLibrary = vi
    .fn<PersonaApi["getLibrary"]>()
    .mockResolvedValue({ ok: true, value: personaLibrary });
  const api: PersonaApi = {
    copy: vi.fn(),
    getLibrary,
    select: vi.fn(),
    subscribeChanged: () => () => undefined,
    update: vi.fn(),
  };
  return api;
}

function createSettingsApi() {
  const saveCompanionInitiative = vi
    .fn<SettingsApi["saveCompanionInitiative"]>()
    .mockImplementation(({ companionInitiative }) =>
      Promise.resolve({ ok: true, value: companionInitiative }),
    );
  const api = {
    getDataSnapshot: vi.fn(),
    getSnapshot: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        agent: {
          defaultApprovalMode: "request_approval",
          defaultMode: "chat",
          workingDirectory: "/workspace",
        },
        browserComputer: {
          accessibility: "granted",
          browser: "ready",
          profileDirectory: "/profile",
          screenRecording: "granted",
        },
        companionInitiative: {
          importantMomentOutreachEnabled: false,
          importantMomentOutreachPrompted: false,
          level: "balanced",
          quietHours: {
            enabled: true,
            endMinute: 8 * 60,
            startMinute: 22 * 60,
          },
          territoryMomentSurprisesEnabled: false,
          territoryMomentSurprisesPrompted: false,
        },
        voice: {
          inputMode: "hands_free",
          microphone: "granted",
          providerProfileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      },
    }),
    importBrowserCookies: vi.fn(),
    openDataDirectory: vi.fn(),
    openManagedBrowser: vi.fn(),
    saveAgent: vi.fn(),
    saveCompanionInitiative,
    saveVoice: vi.fn(),
  } satisfies SettingsApi;
  return { api, saveCompanionInitiative };
}

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
    setTerritoryActive: vi.fn(),
    subscribeChanged: () => () => undefined,
    subscribeOpenComposerAttachments: () => () => undefined,
    subscribeOpenMain: () => () => undefined,
    subscribeOpenConversation: () => () => undefined,
    subscribeOpenTerritoryCandidate: () => () => undefined,
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
  it("copies a preset, selects the new Persona and saves editable fields", async () => {
    const customId = "90000000-0000-4000-8000-000000000001";
    let current = personaLibrary;
    const copy = vi.fn<PersonaApi["copy"]>().mockImplementation((request) => {
      current = {
        ...current,
        personas: [
          ...current.personas,
          {
            createdAt: FIXTURE_TIMESTAMPS.updated,
            kind: "custom",
            snapshot: {
              ...personaSnapshotFixture,
              displayName: request.displayName,
              personaId: customId,
              styleName: request.styleName,
            },
            updatedAt: FIXTURE_TIMESTAMPS.updated,
          },
        ],
      };
      return Promise.resolve({ ok: true, value: current });
    });
    const select = vi
      .fn<PersonaApi["select"]>()
      .mockImplementation(({ personaId }) => {
        current = { ...current, activePersonaId: personaId };
        return Promise.resolve({ ok: true, value: current });
      });
    const update = vi
      .fn<PersonaApi["update"]>()
      .mockImplementation((request) => {
        current = {
          ...current,
          personas: current.personas.map((record) =>
            record.snapshot.personaId === request.personaId
              ? {
                  ...record,
                  snapshot: {
                    ...request.value,
                    personaId: request.personaId,
                    revision: request.expectedRevision + 1,
                    revisionCreatedAt: FIXTURE_TIMESTAMPS.updated,
                  },
                }
              : record,
          ),
        };
        return Promise.resolve({ ok: true, value: current });
      });
    const personaApi: PersonaApi = {
      copy,
      getLibrary: vi.fn().mockResolvedValue({ ok: true, value: current }),
      select,
      subscribeChanged: () => () => undefined,
      update,
    };
    const petApi = createApi({
      activePetId: null,
      animationSpeed: 0.75,
      pets: [],
      scale: 1,
    }).api;
    render(
      <CharacterSettingsPanel
        api={petApi}
        personaApi={personaApi}
        settingsApi={createSettingsApi().api}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "复制并编辑" }));
    await waitFor(() =>
      expect(select).toHaveBeenCalledWith({ personaId: customId }),
    );
    const displayName = await screen.findByLabelText("名称");
    fireEvent.change(displayName, { target: { value: "Lumi" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Persona" }));

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 1,
      personaId: customId,
      value: { displayName: "Lumi" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Persona 已保存");
  });

  it("lists v1/v2 pets and changes the active pet and scale", async () => {
    const initial: PetLibrarySnapshot = {
      activePetId: "columbinya",
      animationSpeed: 0.75,
      pets,
      scale: 1,
    };
    const { api, select, setAnimationSpeed, setScale } = createApi(initial);
    render(
      <CharacterSettingsPanel
        api={api}
        personaApi={createPersonaApi()}
        settingsApi={createSettingsApi().api}
      />,
    );

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
    render(
      <CharacterSettingsPanel
        api={api}
        personaApi={createPersonaApi()}
        settingsApi={createSettingsApi().api}
      />,
    );

    await screen.findByText("还没有导入桌宠");
    fireEvent.click(screen.getByRole("button", { name: "导入 Codex 桌宠" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("v2 spritesheet 应为 1536×2288。");
  });

  it("edits proactive level and quiet hours through the settings boundary", async () => {
    const petApi = createApi({
      activePetId: null,
      animationSpeed: 0.75,
      pets: [],
      scale: 1,
    }).api;
    const settings = createSettingsApi();
    render(
      <CharacterSettingsPanel
        api={petApi}
        personaApi={createPersonaApi()}
        settingsApi={settings.api}
      />,
    );

    const level = await screen.findByLabelText("主动程度");
    fireEvent.change(level, { target: { value: "quiet" } });
    fireEvent.click(screen.getByLabelText("重要时刻主动联系我"));
    fireEvent.click(screen.getByLabelText("偶尔为重要时刻准备领地惊喜"));
    fireEvent.change(screen.getByLabelText("安静时段开始"), {
      target: { value: "21:30" },
    });
    fireEvent.change(screen.getByLabelText("安静时段结束"), {
      target: { value: "07:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存主动陪伴" }));

    await waitFor(() =>
      expect(settings.saveCompanionInitiative).toHaveBeenCalledWith({
        companionInitiative: {
          importantMomentOutreachEnabled: true,
          importantMomentOutreachPrompted: true,
          level: "quiet",
          quietHours: {
            enabled: true,
            endMinute: 7 * 60 + 30,
            startMinute: 21 * 60 + 30,
          },
          territoryMomentSurprisesEnabled: true,
          territoryMomentSurprisesPrompted: true,
        },
      }),
    );
    expect(await screen.findByText("主动陪伴设置已保存。")).toBeVisible();
  });

  it("does not treat saving unrelated initiative settings as an outreach refusal", async () => {
    const petApi = createApi({
      activePetId: null,
      animationSpeed: 0.75,
      pets: [],
      scale: 1,
    }).api;
    const settings = createSettingsApi();
    render(
      <CharacterSettingsPanel
        api={petApi}
        personaApi={createPersonaApi()}
        settingsApi={settings.api}
      />,
    );

    expect(
      await screen.findByLabelText("重要时刻主动联系我"),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "保存主动陪伴" }));

    await waitFor(() =>
      expect(settings.saveCompanionInitiative).toHaveBeenCalledWith({
        companionInitiative: {
          importantMomentOutreachEnabled: false,
          importantMomentOutreachPrompted: false,
          level: "balanced",
          quietHours: {
            enabled: true,
            endMinute: 8 * 60,
            startMinute: 22 * 60,
          },
          territoryMomentSurprisesEnabled: false,
          territoryMomentSurprisesPrompted: false,
        },
      }),
    );
  });
});
