import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUTOMATION_CHANNELS } from "../../shared/contracts/automation";
import {
  automationDefinitionFixture,
  automationFixture,
  AUTOMATION_FIXTURE_IDS,
  automationRunFixture,
} from "../../../tests/fixtures/automations";
import { FIXTURE_TIMESTAMPS } from "../../../tests/fixtures/foundationContracts";
import { AutomationError } from "./automationError";
import {
  registerAutomationIpc,
  type AutomationIpcService,
} from "./automationIpc";

type IpcHandler = (event: unknown, input: unknown) => unknown;

const electron = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
  };
});

vi.mock("electron", () => ({ ipcMain: electron.ipcMain }));

function createService(): AutomationIpcService {
  return {
    create: vi.fn(() => automationFixture),
    get: vi.fn(() => ({ automation: automationFixture, runs: [] })),
    list: vi.fn(() => ({ items: [{ automation: automationFixture }] })),
    runNow: vi.fn(() => automationRunFixture),
    setPaused: vi.fn(() => ({
      createdAt: automationFixture.createdAt,
      definition: automationFixture.definition,
      id: automationFixture.id,
      revision: automationFixture.revision + 1,
      state: "paused" as const,
      updatedAt: automationFixture.updatedAt,
    })),
    update: vi.fn(() => automationFixture),
  };
}

async function invoke(channel: string, input: unknown): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler ${channel}`);
  return await handler({}, input);
}

beforeEach(() => {
  electron.handlers.clear();
  vi.clearAllMocks();
});

describe("Automation Main IPC contract", () => {
  it("validates requests and response projections for every operation", async () => {
    const service = createService();
    registerAutomationIpc(service);

    await expect(invoke(AUTOMATION_CHANNELS.list, {})).resolves.toEqual({
      ok: true,
      value: { items: [{ automation: automationFixture }] },
    });
    await expect(
      invoke(AUTOMATION_CHANNELS.get, {
        automationId: AUTOMATION_FIXTURE_IDS.automation,
      }),
    ).resolves.toEqual({
      ok: true,
      value: { automation: automationFixture, runs: [] },
    });
    await expect(
      invoke(AUTOMATION_CHANNELS.create, {
        definition: automationDefinitionFixture,
        requestedAt: FIXTURE_TIMESTAMPS.updated,
      }),
    ).resolves.toEqual({ ok: true, value: automationFixture });
    await expect(
      invoke(AUTOMATION_CHANNELS.update, {
        automationId: AUTOMATION_FIXTURE_IDS.automation,
        definition: automationDefinitionFixture,
        expectedRevision: automationFixture.revision,
        requestedAt: FIXTURE_TIMESTAMPS.updated,
      }),
    ).resolves.toEqual({ ok: true, value: automationFixture });
    await expect(
      invoke(AUTOMATION_CHANNELS.setPaused, {
        automationId: AUTOMATION_FIXTURE_IDS.automation,
        expectedRevision: automationFixture.revision,
        paused: true,
        requestedAt: FIXTURE_TIMESTAMPS.updated,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        createdAt: automationFixture.createdAt,
        definition: automationFixture.definition,
        id: automationFixture.id,
        revision: automationFixture.revision + 1,
        state: "paused",
        updatedAt: automationFixture.updatedAt,
      },
    });
    await expect(
      invoke(AUTOMATION_CHANNELS.runNow, {
        automationId: AUTOMATION_FIXTURE_IDS.automation,
        requestedAt: FIXTURE_TIMESTAMPS.updated,
      }),
    ).resolves.toEqual({ ok: true, value: automationRunFixture });
  });

  it("does not pass malformed input to the service", async () => {
    let createCalled = false;
    const service: AutomationIpcService = {
      ...createService(),
      create: () => {
        createCalled = true;
        return automationFixture;
      },
    };
    registerAutomationIpc(service);

    await expect(
      invoke(AUTOMATION_CHANNELS.create, {
        definition: automationDefinitionFixture,
        requestedAt: "tomorrow",
      }),
    ).resolves.toMatchObject({
      error: { code: "AUTOMATION.STORAGE_FAILED" },
      ok: false,
    });
    expect(createCalled).toBe(false);
  });

  it("preserves typed domain errors and unregisters request handlers", async () => {
    const service = createService();
    service.update = vi.fn(() => {
      throw new AutomationError(
        "AUTOMATION.REVISION_CONFLICT",
        "任务已在其他窗口更新。",
        false,
      );
    });
    const unregister = registerAutomationIpc(service);

    await expect(
      invoke(AUTOMATION_CHANNELS.update, {
        automationId: AUTOMATION_FIXTURE_IDS.automation,
        definition: automationDefinitionFixture,
        expectedRevision: automationFixture.revision,
        requestedAt: FIXTURE_TIMESTAMPS.updated,
      }),
    ).resolves.toEqual({
      error: {
        code: "AUTOMATION.REVISION_CONFLICT",
        message: "任务已在其他窗口更新。",
        retryable: false,
      },
      ok: false,
    });

    unregister();
    for (const channel of [
      AUTOMATION_CHANNELS.create,
      AUTOMATION_CHANNELS.get,
      AUTOMATION_CHANNELS.list,
      AUTOMATION_CHANNELS.runNow,
      AUTOMATION_CHANNELS.setPaused,
      AUTOMATION_CHANNELS.update,
    ]) {
      expect(electron.ipcMain.removeHandler).toHaveBeenCalledWith(channel);
      expect(electron.handlers.has(channel)).toBe(false);
    }
  });
});
