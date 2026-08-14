import { ipcMain } from "electron";

import { JOURNEY_CHANNELS } from "../../shared/contracts/journey";
import {
  JourneySnapshotRequestSchema,
  JourneySnapshotResponseSchema,
} from "../../shared/schemas/journey";
import { parseSchema } from "../../shared/schemas/validation";
import { toJourneyAppError } from "./journeyError";
import type { JourneyService } from "./journeyService";

export function registerJourneyIpc(service: JourneyService): () => void {
  ipcMain.handle(JOURNEY_CHANNELS.getSnapshot, (_event, input) => {
    try {
      parseSchema(JourneySnapshotRequestSchema, input);
      return parseSchema(JourneySnapshotResponseSchema, {
        ok: true,
        value: service.getSnapshot(),
      });
    } catch (error) {
      return parseSchema(JourneySnapshotResponseSchema, {
        error: toJourneyAppError(error),
        ok: false,
      });
    }
  });
  return () => {
    ipcMain.removeHandler(JOURNEY_CHANNELS.getSnapshot);
  };
}
