import { ipcMain } from "electron";

import { TERRITORY_CHANNELS } from "../../shared/contracts/territory";
import {
  TerritoryCollectItemRequestSchema,
  TerritoryEditImageRequestSchema,
  TerritoryEmptyRequestSchema,
  TerritoryGenerateImageRequestSchema,
  TerritoryImageCandidateIdRequestSchema,
  TerritoryImageMutationResponseSchema,
  TerritoryMovePetRequestSchema,
  TerritoryMoveResponseSchema,
  TerritoryPlaceItemRequestSchema,
  TerritorySelectSceneRequestSchema,
  TerritorySnapshotResponseSchema,
} from "../../shared/schemas/territory";
import { parseSchema } from "../../shared/schemas/validation";
import { toTerritoryAppError } from "./territoryError";
import type { TerritoryImageService } from "./territoryImageService";
import type { TerritoryService } from "./territoryService";

export function registerTerritoryIpc(
  service: TerritoryService,
  images: TerritoryImageService,
): () => void {
  ipcMain.handle(TERRITORY_CHANNELS.getSnapshot, (_event, input) => {
    try {
      parseSchema(TerritoryEmptyRequestSchema, input);
      return parseSchema(TerritorySnapshotResponseSchema, {
        ok: true,
        value: service.getSnapshot(),
      });
    } catch (error) {
      return parseSchema(TerritorySnapshotResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(TERRITORY_CHANNELS.selectScene, (_event, input) => {
    try {
      const request = parseSchema(TerritorySelectSceneRequestSchema, input);
      return parseSchema(TerritorySnapshotResponseSchema, {
        ok: true,
        value: service.selectScene(request),
      });
    } catch (error) {
      return parseSchema(TerritorySnapshotResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(TERRITORY_CHANNELS.movePet, (_event, input) => {
    try {
      const request = parseSchema(TerritoryMovePetRequestSchema, input);
      return parseSchema(TerritoryMoveResponseSchema, {
        ok: true,
        value: service.movePet(request),
      });
    } catch (error) {
      return parseSchema(TerritoryMoveResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(TERRITORY_CHANNELS.placeItem, (_event, input) => {
    try {
      const request = parseSchema(TerritoryPlaceItemRequestSchema, input);
      return parseSchema(TerritorySnapshotResponseSchema, {
        ok: true,
        value: service.placeItem(request),
      });
    } catch (error) {
      return parseSchema(TerritorySnapshotResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(TERRITORY_CHANNELS.collectItem, (_event, input) => {
    try {
      const request = parseSchema(TerritoryCollectItemRequestSchema, input);
      return parseSchema(TerritorySnapshotResponseSchema, {
        ok: true,
        value: service.collectItem(request),
      });
    } catch (error) {
      return parseSchema(TerritorySnapshotResponseSchema, {
        error: toTerritoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(
    TERRITORY_CHANNELS.generateImageCandidate,
    async (_event, input) => {
      try {
        const request = parseSchema(TerritoryGenerateImageRequestSchema, input);
        return parseSchema(TerritoryImageMutationResponseSchema, {
          ok: true,
          value: await images.generate(request),
        });
      } catch (error) {
        return parseSchema(TerritoryImageMutationResponseSchema, {
          error: toTerritoryAppError(error),
          ok: false,
        });
      }
    },
  );

  ipcMain.handle(
    TERRITORY_CHANNELS.editImageCandidate,
    async (_event, input) => {
      try {
        const request = parseSchema(TerritoryEditImageRequestSchema, input);
        return parseSchema(TerritoryImageMutationResponseSchema, {
          ok: true,
          value: await images.edit(request),
        });
      } catch (error) {
        return parseSchema(TerritoryImageMutationResponseSchema, {
          error: toTerritoryAppError(error),
          ok: false,
        });
      }
    },
  );

  ipcMain.handle(
    TERRITORY_CHANNELS.retryImageCandidate,
    async (_event, input) => {
      try {
        const request = parseSchema(
          TerritoryImageCandidateIdRequestSchema,
          input,
        );
        return parseSchema(TerritoryImageMutationResponseSchema, {
          ok: true,
          value: await images.retry(request),
        });
      } catch (error) {
        return parseSchema(TerritoryImageMutationResponseSchema, {
          error: toTerritoryAppError(error),
          ok: false,
        });
      }
    },
  );

  ipcMain.handle(
    TERRITORY_CHANNELS.confirmImageCandidate,
    async (_event, input) => {
      try {
        const request = parseSchema(
          TerritoryImageCandidateIdRequestSchema,
          input,
        );
        return parseSchema(TerritoryImageMutationResponseSchema, {
          ok: true,
          value: await images.confirm(request),
        });
      } catch (error) {
        return parseSchema(TerritoryImageMutationResponseSchema, {
          error: toTerritoryAppError(error),
          ok: false,
        });
      }
    },
  );

  return () => {
    for (const channel of Object.values(TERRITORY_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
