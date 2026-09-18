import { ipcMain } from "electron";

import { ACTIVITY_CHANNELS } from "../../shared/contracts/activity";
import {
  ActivityEventReferenceRequestSchema,
  ActivityEventReferenceResponseSchema,
  ActivityCleanupRequestSchema,
  ActivityCleanupResponseSchema,
  ActivityEpisodeIdRequestSchema,
  ActivityEpisodeResponseSchema,
  ActivitySetPausedRequestSchema,
  ActivitySnapshotRequestSchema,
  ActivitySnapshotResponseSchema,
  ActivityUpdateEpisodeRequestSchema,
} from "../../shared/schemas/activity";
import { parseSchema } from "../../shared/schemas/validation";
import { toActivityAppError } from "./activityError";
import type { ActivityService } from "./activityService";

export function registerActivityIpc(service: ActivityService): () => void {
  ipcMain.handle(ACTIVITY_CHANNELS.getSnapshot, (_event, input) => {
    try {
      const request = parseSchema(ActivitySnapshotRequestSchema, input);
      return parseSchema(ActivitySnapshotResponseSchema, {
        ok: true,
        value: service.getSnapshot(request.date),
      });
    } catch (error) {
      return parseSchema(ActivitySnapshotResponseSchema, {
        error: toActivityAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(ACTIVITY_CHANNELS.resolveEventReference, (_event, input) => {
    try {
      const request = parseSchema(ActivityEventReferenceRequestSchema, input);
      return parseSchema(ActivityEventReferenceResponseSchema, {
        ok: true,
        value: service.resolveEventReference(request.eventId),
      });
    } catch (error) {
      return parseSchema(ActivityEventReferenceResponseSchema, {
        ok: false,
        error: toActivityAppError(error),
      });
    }
  });

  ipcMain.handle(ACTIVITY_CHANNELS.getEpisode, (_event, input) => {
    try {
      const request = parseSchema(ActivityEpisodeIdRequestSchema, input);
      return parseSchema(ActivityEpisodeResponseSchema, {
        ok: true,
        value: service.getEpisode(request.episodeId),
      });
    } catch (error) {
      return parseSchema(ActivityEpisodeResponseSchema, {
        error: toActivityAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(ACTIVITY_CHANNELS.setPaused, (_event, input) => {
    try {
      const request = parseSchema(ActivitySetPausedRequestSchema, input);
      return parseSchema(ActivitySnapshotResponseSchema, {
        ok: true,
        value: service.setPaused(request.paused),
      });
    } catch (error) {
      return parseSchema(ActivitySnapshotResponseSchema, {
        error: toActivityAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(ACTIVITY_CHANNELS.updateEpisode, (_event, input) => {
    try {
      const request = parseSchema(ActivityUpdateEpisodeRequestSchema, input);
      return parseSchema(ActivityEpisodeResponseSchema, {
        ok: true,
        value: service.updateEpisode(
          request.episodeId,
          request.title,
          request.summary,
        ),
      });
    } catch (error) {
      return parseSchema(ActivityEpisodeResponseSchema, {
        error: toActivityAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(ACTIVITY_CHANNELS.deleteEpisode, async (_event, input) => {
    try {
      const request = parseSchema(ActivityEpisodeIdRequestSchema, input);
      return parseSchema(ActivitySnapshotResponseSchema, {
        ok: true,
        value: await service.deleteEpisode(request.episodeId),
      });
    } catch (error) {
      return parseSchema(ActivitySnapshotResponseSchema, {
        error: toActivityAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(ACTIVITY_CHANNELS.cleanup, async (_event, input) => {
    try {
      parseSchema(ActivityCleanupRequestSchema, input);
      return parseSchema(ActivityCleanupResponseSchema, {
        ok: true,
        value: await service.cleanup(),
      });
    } catch (error) {
      return parseSchema(ActivityCleanupResponseSchema, {
        error: toActivityAppError(error),
        ok: false,
      });
    }
  });

  return () => {
    for (const channel of Object.values(ACTIVITY_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
