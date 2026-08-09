import { ipcMain } from "electron";

import { MEMORY_CHANNELS } from "../../shared/contracts/memory";
import {
  MemoryCandidateIdRequestSchema,
  MemoryCandidateMutationResponseSchema,
  MemoryCreateRequestSchema,
  MemoryDetailResponseSchema,
  MemoryIdRequestSchema,
  MemoryListRequestSchema,
  MemoryListResponseSchema,
  MemoryMutationResponseSchema,
  MemoryPurgeResponseSchema,
  MemoryReviseRequestSchema,
  MemorySetPinnedRequestSchema,
} from "../../shared/schemas/memory";
import { parseSchema } from "../../shared/schemas/validation";
import { toMemoryAppError } from "./memoryError";
import type { MemoryService } from "./memoryService";

export function registerMemoryIpc(service: MemoryService): () => void {
  ipcMain.handle(MEMORY_CHANNELS.list, (_event, input) => {
    try {
      const request = parseSchema(MemoryListRequestSchema, input);
      return parseSchema(MemoryListResponseSchema, {
        ok: true,
        value: service.list(request),
      });
    } catch (error) {
      return parseSchema(MemoryListResponseSchema, {
        error: toMemoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(MEMORY_CHANNELS.get, (_event, input) => {
    try {
      const request = parseSchema(MemoryIdRequestSchema, input);
      return parseSchema(MemoryDetailResponseSchema, {
        ok: true,
        value: service.get(request.memoryId),
      });
    } catch (error) {
      return parseSchema(MemoryDetailResponseSchema, {
        error: toMemoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(MEMORY_CHANNELS.create, (_event, input) => {
    try {
      const request = parseSchema(MemoryCreateRequestSchema, input);
      return parseSchema(MemoryMutationResponseSchema, {
        ok: true,
        value: service.create(request),
      });
    } catch (error) {
      return parseSchema(MemoryMutationResponseSchema, {
        error: toMemoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(MEMORY_CHANNELS.revise, (_event, input) => {
    try {
      const request = parseSchema(MemoryReviseRequestSchema, input);
      return parseSchema(MemoryMutationResponseSchema, {
        ok: true,
        value: service.revise(request),
      });
    } catch (error) {
      return parseSchema(MemoryMutationResponseSchema, {
        error: toMemoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(MEMORY_CHANNELS.setPinned, (_event, input) => {
    try {
      const request = parseSchema(MemorySetPinnedRequestSchema, input);
      return parseSchema(MemoryMutationResponseSchema, {
        ok: true,
        value: service.setPinned(request.memoryId, request.pinned),
      });
    } catch (error) {
      return parseSchema(MemoryMutationResponseSchema, {
        error: toMemoryAppError(error),
        ok: false,
      });
    }
  });

  const mutation = (
    channel:
      | typeof MEMORY_CHANNELS.archive
      | typeof MEMORY_CHANNELS.delete
      | typeof MEMORY_CHANNELS.restore,
    operation: (memoryId: string) => ReturnType<MemoryService["archive"]>,
  ) => {
    ipcMain.handle(channel, (_event, input) => {
      try {
        const request = parseSchema(MemoryIdRequestSchema, input);
        return parseSchema(MemoryMutationResponseSchema, {
          ok: true,
          value: operation(request.memoryId),
        });
      } catch (error) {
        return parseSchema(MemoryMutationResponseSchema, {
          error: toMemoryAppError(error),
          ok: false,
        });
      }
    });
  };
  mutation(MEMORY_CHANNELS.archive, (memoryId) => service.archive(memoryId));
  mutation(MEMORY_CHANNELS.delete, (memoryId) => service.delete(memoryId));
  mutation(MEMORY_CHANNELS.restore, (memoryId) => service.restore(memoryId));

  ipcMain.handle(MEMORY_CHANNELS.purge, (_event, input) => {
    try {
      const request = parseSchema(MemoryIdRequestSchema, input);
      service.purge(request.memoryId);
      return parseSchema(MemoryPurgeResponseSchema, {
        ok: true,
        value: { memoryId: request.memoryId },
      });
    } catch (error) {
      return parseSchema(MemoryPurgeResponseSchema, {
        error: toMemoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(MEMORY_CHANNELS.acceptCandidate, (_event, input) => {
    try {
      const request = parseSchema(MemoryCandidateIdRequestSchema, input);
      return parseSchema(MemoryMutationResponseSchema, {
        ok: true,
        value: service.acceptCandidate(request.candidateId),
      });
    } catch (error) {
      return parseSchema(MemoryMutationResponseSchema, {
        error: toMemoryAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(MEMORY_CHANNELS.rejectCandidate, (_event, input) => {
    try {
      const request = parseSchema(MemoryCandidateIdRequestSchema, input);
      return parseSchema(MemoryCandidateMutationResponseSchema, {
        ok: true,
        value: service.rejectCandidate(request.candidateId),
      });
    } catch (error) {
      return parseSchema(MemoryCandidateMutationResponseSchema, {
        error: toMemoryAppError(error),
        ok: false,
      });
    }
  });

  return () => {
    for (const channel of Object.values(MEMORY_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
