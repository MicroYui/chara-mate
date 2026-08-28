import { ipcMain } from "electron";

import { EVOLUTION_CHANNELS } from "../../shared/contracts/evolution";
import {
  EvolutionCandidateIdRequestSchema,
  EvolutionCandidateMutationResponseSchema,
  EvolutionCandidatePinRequestSchema,
  EvolutionCandidateUpdateRequestSchema,
  EvolutionListRequestSchema,
  EvolutionReviewMutationResponseSchema,
  EvolutionRunIdRequestSchema,
  EvolutionSnapshotResponseSchema,
} from "../../shared/schemas/evolution";
import { parseSchema } from "../../shared/schemas/validation";
import { toEvolutionAppError } from "./evolutionError";
import type { EvolutionService } from "./evolutionService";

export function registerEvolutionIpc(service: EvolutionService): () => void {
  ipcMain.handle(EVOLUTION_CHANNELS.list, (_event, input) => {
    try {
      const request = parseSchema(EvolutionListRequestSchema, input);
      return parseSchema(EvolutionSnapshotResponseSchema, {
        ok: true,
        value: service.list(request),
      });
    } catch (error) {
      return parseSchema(EvolutionSnapshotResponseSchema, {
        error: toEvolutionAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(EVOLUTION_CHANNELS.acceptCandidate, (_event, input) => {
    try {
      const request = parseSchema(EvolutionCandidateIdRequestSchema, input);
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        ok: true,
        value: service.acceptCandidate(request.candidateId),
      });
    } catch (error) {
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        error: toEvolutionAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(EVOLUTION_CHANNELS.rejectCandidate, (_event, input) => {
    try {
      const request = parseSchema(EvolutionCandidateIdRequestSchema, input);
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        ok: true,
        value: service.rejectCandidate(request.candidateId),
      });
    } catch (error) {
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        error: toEvolutionAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(EVOLUTION_CHANNELS.updateCandidate, (_event, input) => {
    try {
      const request = parseSchema(EvolutionCandidateUpdateRequestSchema, input);
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        ok: true,
        value: service.updateCandidate(request),
      });
    } catch (error) {
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        error: toEvolutionAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(EVOLUTION_CHANNELS.retryReplay, (_event, input) => {
    try {
      const request = parseSchema(EvolutionCandidateIdRequestSchema, input);
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        ok: true,
        value: service.retryReplay(request.candidateId),
      });
    } catch (error) {
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        error: toEvolutionAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(EVOLUTION_CHANNELS.setCandidatePinned, (_event, input) => {
    try {
      const request = parseSchema(EvolutionCandidatePinRequestSchema, input);
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        ok: true,
        value: service.setCandidatePinned(request.candidateId, request.pinned),
      });
    } catch (error) {
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        error: toEvolutionAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(EVOLUTION_CHANNELS.archiveCandidate, async (_event, input) => {
    try {
      const request = parseSchema(EvolutionCandidateIdRequestSchema, input);
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        ok: true,
        value: await service.archiveCandidate(request.candidateId),
      });
    } catch (error) {
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        error: toEvolutionAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(EVOLUTION_CHANNELS.restoreCandidate, async (_event, input) => {
    try {
      const request = parseSchema(EvolutionCandidateIdRequestSchema, input);
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        ok: true,
        value: await service.restoreCandidate(request.candidateId),
      });
    } catch (error) {
      return parseSchema(EvolutionCandidateMutationResponseSchema, {
        error: toEvolutionAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(EVOLUTION_CHANNELS.retryReview, (_event, input) => {
    try {
      const request = parseSchema(EvolutionRunIdRequestSchema, input);
      return parseSchema(EvolutionReviewMutationResponseSchema, {
        ok: true,
        value: service.retryReview(request.runId),
      });
    } catch (error) {
      return parseSchema(EvolutionReviewMutationResponseSchema, {
        error: toEvolutionAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(EVOLUTION_CHANNELS.dismissReview, (_event, input) => {
    try {
      const request = parseSchema(EvolutionRunIdRequestSchema, input);
      return parseSchema(EvolutionReviewMutationResponseSchema, {
        ok: true,
        value: service.dismissReview(request.runId),
      });
    } catch (error) {
      return parseSchema(EvolutionReviewMutationResponseSchema, {
        error: toEvolutionAppError(error),
        ok: false,
      });
    }
  });

  return () => {
    for (const channel of Object.values(EVOLUTION_CHANNELS)) {
      if (channel !== EVOLUTION_CHANNELS.changed) {
        ipcMain.removeHandler(channel);
      }
    }
  };
}
