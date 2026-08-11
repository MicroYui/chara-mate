import { ipcMain } from "electron";

import {
  AUTOMATION_CHANNELS,
  type Automation,
  type AutomationCreateRequest,
  type AutomationDetail,
  type AutomationIdRequest,
  type AutomationListSnapshot,
  type AutomationRun,
  type AutomationRunNowRequest,
  type AutomationSetPausedRequest,
  type AutomationUpdateRequest,
} from "../../shared/contracts/automation";
import {
  AutomationCreateRequestSchema,
  AutomationDetailResponseSchema,
  AutomationEmptyRequestSchema,
  AutomationIdRequestSchema,
  AutomationListResponseSchema,
  AutomationMutationResponseSchema,
  AutomationRunNowRequestSchema,
  AutomationRunNowResponseSchema,
  AutomationSetPausedRequestSchema,
  AutomationUpdateRequestSchema,
} from "../../shared/schemas/automation";
import { parseSchema } from "../../shared/schemas/validation";
import { toAutomationAppError } from "./automationError";

export interface AutomationIpcService {
  create(request: AutomationCreateRequest): Automation | Promise<Automation>;
  get(
    request: AutomationIdRequest,
  ): AutomationDetail | Promise<AutomationDetail>;
  list(): AutomationListSnapshot | Promise<AutomationListSnapshot>;
  runNow(
    request: AutomationRunNowRequest,
  ): AutomationRun | Promise<AutomationRun>;
  setPaused(
    request: AutomationSetPausedRequest,
  ): Automation | Promise<Automation>;
  update(request: AutomationUpdateRequest): Automation | Promise<Automation>;
}

const requestChannels = [
  AUTOMATION_CHANNELS.create,
  AUTOMATION_CHANNELS.get,
  AUTOMATION_CHANNELS.list,
  AUTOMATION_CHANNELS.runNow,
  AUTOMATION_CHANNELS.setPaused,
  AUTOMATION_CHANNELS.update,
] as const;

export function registerAutomationIpc(
  service: AutomationIpcService,
): () => void {
  ipcMain.handle(AUTOMATION_CHANNELS.list, async (_event, input) => {
    try {
      parseSchema(AutomationEmptyRequestSchema, input);
      return parseSchema(AutomationListResponseSchema, {
        ok: true,
        value: await service.list(),
      });
    } catch (error) {
      return parseSchema(AutomationListResponseSchema, {
        error: toAutomationAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(AUTOMATION_CHANNELS.get, async (_event, input) => {
    try {
      const request = parseSchema(AutomationIdRequestSchema, input);
      return parseSchema(AutomationDetailResponseSchema, {
        ok: true,
        value: await service.get(request),
      });
    } catch (error) {
      return parseSchema(AutomationDetailResponseSchema, {
        error: toAutomationAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(AUTOMATION_CHANNELS.create, async (_event, input) => {
    try {
      const request = parseSchema(AutomationCreateRequestSchema, input);
      return parseSchema(AutomationMutationResponseSchema, {
        ok: true,
        value: await service.create(request),
      });
    } catch (error) {
      return parseSchema(AutomationMutationResponseSchema, {
        error: toAutomationAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(AUTOMATION_CHANNELS.update, async (_event, input) => {
    try {
      const request = parseSchema(AutomationUpdateRequestSchema, input);
      return parseSchema(AutomationMutationResponseSchema, {
        ok: true,
        value: await service.update(request),
      });
    } catch (error) {
      return parseSchema(AutomationMutationResponseSchema, {
        error: toAutomationAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(AUTOMATION_CHANNELS.setPaused, async (_event, input) => {
    try {
      const request = parseSchema(AutomationSetPausedRequestSchema, input);
      return parseSchema(AutomationMutationResponseSchema, {
        ok: true,
        value: await service.setPaused(request),
      });
    } catch (error) {
      return parseSchema(AutomationMutationResponseSchema, {
        error: toAutomationAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(AUTOMATION_CHANNELS.runNow, async (_event, input) => {
    try {
      const request = parseSchema(AutomationRunNowRequestSchema, input);
      return parseSchema(AutomationRunNowResponseSchema, {
        ok: true,
        value: await service.runNow(request),
      });
    } catch (error) {
      return parseSchema(AutomationRunNowResponseSchema, {
        error: toAutomationAppError(error),
        ok: false,
      });
    }
  });

  return () => {
    for (const channel of requestChannels) ipcMain.removeHandler(channel);
  };
}
