import { ipcMain } from "electron";

import {
  COMPANION_DESKTOP_CHANNELS,
  type CompanionDesktopSetNotificationsEnabledRequest,
  type CompanionDesktopSnapshot,
  type CompanionDesktopUnpairRequest,
} from "../../shared/contracts/companion";
import {
  CompanionDesktopEmptyRequestSchema,
  CompanionDesktopSetNotificationsEnabledRequestSchema,
  CompanionDesktopSnapshotResponseSchema,
  CompanionDesktopUnpairRequestSchema,
} from "../../shared/schemas/companion";
import { parseSchema } from "../../shared/schemas/validation";
import { toCompanionAppError } from "./companionError";

export interface CompanionIpcService {
  getSnapshot(): CompanionDesktopSnapshot | Promise<CompanionDesktopSnapshot>;
  setNotificationsEnabled(
    request: CompanionDesktopSetNotificationsEnabledRequest,
  ): CompanionDesktopSnapshot | Promise<CompanionDesktopSnapshot>;
  startPairing(): CompanionDesktopSnapshot | Promise<CompanionDesktopSnapshot>;
  unpair(
    request: CompanionDesktopUnpairRequest,
  ): CompanionDesktopSnapshot | Promise<CompanionDesktopSnapshot>;
}

export function registerCompanionIpc(service: CompanionIpcService): () => void {
  ipcMain.handle(
    COMPANION_DESKTOP_CHANNELS.getSnapshot,
    async (_event, input) => {
      try {
        parseSchema(CompanionDesktopEmptyRequestSchema, input);
        return parseSchema(CompanionDesktopSnapshotResponseSchema, {
          ok: true,
          value: await service.getSnapshot(),
        });
      } catch (error) {
        return parseSchema(CompanionDesktopSnapshotResponseSchema, {
          error: toCompanionAppError(error),
          ok: false,
        });
      }
    },
  );

  ipcMain.handle(
    COMPANION_DESKTOP_CHANNELS.startPairing,
    async (_event, input) => {
      try {
        parseSchema(CompanionDesktopEmptyRequestSchema, input);
        return parseSchema(CompanionDesktopSnapshotResponseSchema, {
          ok: true,
          value: await service.startPairing(),
        });
      } catch (error) {
        return parseSchema(CompanionDesktopSnapshotResponseSchema, {
          error: toCompanionAppError(error),
          ok: false,
        });
      }
    },
  );

  ipcMain.handle(
    COMPANION_DESKTOP_CHANNELS.setNotificationsEnabled,
    async (_event, input) => {
      try {
        const request = parseSchema(
          CompanionDesktopSetNotificationsEnabledRequestSchema,
          input,
        );
        return parseSchema(CompanionDesktopSnapshotResponseSchema, {
          ok: true,
          value: await service.setNotificationsEnabled(request),
        });
      } catch (error) {
        return parseSchema(CompanionDesktopSnapshotResponseSchema, {
          error: toCompanionAppError(error),
          ok: false,
        });
      }
    },
  );

  ipcMain.handle(COMPANION_DESKTOP_CHANNELS.unpair, async (_event, input) => {
    try {
      const request = parseSchema(CompanionDesktopUnpairRequestSchema, input);
      return parseSchema(CompanionDesktopSnapshotResponseSchema, {
        ok: true,
        value: await service.unpair(request),
      });
    } catch (error) {
      return parseSchema(CompanionDesktopSnapshotResponseSchema, {
        error: toCompanionAppError(error),
        ok: false,
      });
    }
  });

  return () => {
    for (const channel of Object.values(COMPANION_DESKTOP_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
