import { ipcMain } from "electron";

import { TERRITORY_WORLD_CHANNELS } from "../../shared/contracts/territoryWorld";
import {
  TerritoryCandidateIdRequestSchema,
  TerritoryCandidateMutationResponseSchema,
  TerritoryCommitChangeSetRequestSchema,
  TerritoryCreateChangeCandidateRequestSchema,
  TerritoryCreateSourceCandidateRequestSchema,
  TerritoryEditChangeCandidateRequestSchema,
  TerritoryEnterZoneRequestSchema,
  TerritoryEmptyRequestSchema,
  TerritoryGetZoneViewRequestSchema,
  TerritoryMovePetRequestSchema,
  TerritoryMovePetResponseSchema,
  TerritoryPurgeInstanceRequestSchema,
  TerritoryRestoreRevisionRequestSchema,
  TerritoryWorldSnapshotResponseSchema,
  TerritoryZoneViewResponseSchema,
} from "../../shared/schemas/territoryWorld";
import { parseSchema } from "../../shared/schemas/validation";
import { toTerritoryAppError } from "./territoryError";
import type { TerritoryWorldService } from "./territoryWorldService";
import type { TerritoryWorldMemoryService } from "./territoryWorldMemoryService";

function launchCandidateJob<
  T extends {
    readonly completion: Promise<unknown>;
    readonly initial: unknown;
  },
>(job: T): T["initial"] {
  void job.completion.catch(() => undefined);
  return job.initial;
}

export function registerTerritoryWorldIpc(
  service: TerritoryWorldService,
  memory: TerritoryWorldMemoryService,
): () => void {
  ipcMain.handle(TERRITORY_WORLD_CHANNELS.getSnapshot, (_event, input) => {
    try {
      parseSchema(TerritoryEmptyRequestSchema, input);
      return parseSchema(TerritoryWorldSnapshotResponseSchema, {
        ok: true,
        value: service.getSnapshot(),
      });
    } catch (error) {
      return parseSchema(TerritoryWorldSnapshotResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(TERRITORY_WORLD_CHANNELS.getZoneView, (_event, input) => {
    try {
      const request = parseSchema(TerritoryGetZoneViewRequestSchema, input);
      return parseSchema(TerritoryZoneViewResponseSchema, {
        ok: true,
        value: service.getZoneView(request),
      });
    } catch (error) {
      return parseSchema(TerritoryZoneViewResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(TERRITORY_WORLD_CHANNELS.commitChangeSet, (_event, input) => {
    try {
      const request = parseSchema(TerritoryCommitChangeSetRequestSchema, input);
      return parseSchema(TerritoryWorldSnapshotResponseSchema, {
        ok: true,
        value: service.commitChangeSet(request),
      });
    } catch (error) {
      return parseSchema(TerritoryWorldSnapshotResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(TERRITORY_WORLD_CHANNELS.restoreRevision, (_event, input) => {
    try {
      const request = parseSchema(TerritoryRestoreRevisionRequestSchema, input);
      return parseSchema(TerritoryWorldSnapshotResponseSchema, {
        ok: true,
        value: service.restoreRevision(request),
      });
    } catch (error) {
      return parseSchema(TerritoryWorldSnapshotResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(TERRITORY_WORLD_CHANNELS.movePet, (_event, input) => {
    try {
      const request = parseSchema(TerritoryMovePetRequestSchema, input);
      return parseSchema(TerritoryMovePetResponseSchema, {
        ok: true,
        value: service.movePet(request),
      });
    } catch (error) {
      return parseSchema(TerritoryMovePetResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(TERRITORY_WORLD_CHANNELS.enterZone, (_event, input) => {
    try {
      const request = parseSchema(TerritoryEnterZoneRequestSchema, input);
      return parseSchema(TerritoryWorldSnapshotResponseSchema, {
        ok: true,
        value: service.enterZone(request),
      });
    } catch (error) {
      return parseSchema(TerritoryWorldSnapshotResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(
    TERRITORY_WORLD_CHANNELS.purgeInstance,
    async (_event, input) => {
      try {
        const request = parseSchema(TerritoryPurgeInstanceRequestSchema, input);
        return parseSchema(TerritoryWorldSnapshotResponseSchema, {
          ok: true,
          value: await service.purgeInstance(request),
        });
      } catch (error) {
        return parseSchema(TerritoryWorldSnapshotResponseSchema, {
          error: toTerritoryAppError(error),
          ok: false,
        });
      }
    },
  );

  ipcMain.handle(TERRITORY_WORLD_CHANNELS.createCandidate, (_event, input) => {
    try {
      const request = parseSchema(
        TerritoryCreateChangeCandidateRequestSchema,
        input,
      );
      return parseSchema(TerritoryCandidateMutationResponseSchema, {
        ok: true,
        value: launchCandidateJob(service.beginCreateCandidate(request)),
      });
    } catch (error) {
      return parseSchema(TerritoryCandidateMutationResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(
    TERRITORY_WORLD_CHANNELS.createSourceCandidate,
    (_event, input) => {
      try {
        const request = parseSchema(
          TerritoryCreateSourceCandidateRequestSchema,
          input,
        );
        return parseSchema(TerritoryCandidateMutationResponseSchema, {
          ok: true,
          value: launchCandidateJob(memory.beginSourceCandidate(request)),
        });
      } catch (error) {
        return parseSchema(TerritoryCandidateMutationResponseSchema, {
          error: toTerritoryAppError(error),
          ok: false,
        });
      }
    },
  );

  ipcMain.handle(TERRITORY_WORLD_CHANNELS.editCandidate, (_event, input) => {
    try {
      const request = parseSchema(
        TerritoryEditChangeCandidateRequestSchema,
        input,
      );
      return parseSchema(TerritoryCandidateMutationResponseSchema, {
        ok: true,
        value: launchCandidateJob(service.beginEditCandidate(request)),
      });
    } catch (error) {
      return parseSchema(TerritoryCandidateMutationResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  for (const [channel, action] of [
    [
      TERRITORY_WORLD_CHANNELS.cancelCandidate,
      service.cancelCandidate.bind(service),
    ],
    [
      TERRITORY_WORLD_CHANNELS.applyCandidate,
      service.applyCandidate.bind(service),
    ],
  ] as const) {
    ipcMain.handle(channel, async (_event, input) => {
      try {
        const request = parseSchema(TerritoryCandidateIdRequestSchema, input);
        return parseSchema(TerritoryCandidateMutationResponseSchema, {
          ok: true,
          value: await action(request),
        });
      } catch (error) {
        return parseSchema(TerritoryCandidateMutationResponseSchema, {
          error: toTerritoryAppError(error),
          ok: false,
        });
      }
    });
  }

  return () => {
    for (const channel of Object.values(TERRITORY_WORLD_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
