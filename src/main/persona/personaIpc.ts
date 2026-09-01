import { ipcMain } from "electron";

import { PERSONA_CHANNELS } from "../../shared/contracts/persona";
import {
  PersonaCopyRequestSchema,
  PersonaEmptyRequestSchema,
  PersonaLibraryResponseSchema,
  PersonaSelectRequestSchema,
  PersonaUpdateRequestSchema,
} from "../../shared/schemas/persona";
import { parseSchema } from "../../shared/schemas/validation";
import type { PersonaService } from "./personaService";

function appError(error: unknown) {
  return {
    code: "PERSONA.OPERATION_FAILED",
    message: error instanceof Error ? error.message : "Persona 操作没有完成。",
    retryable: false,
  };
}

export function registerPersonaIpc(service: PersonaService): () => void {
  ipcMain.handle(PERSONA_CHANNELS.getLibrary, (_event, input) => {
    try {
      parseSchema(PersonaEmptyRequestSchema, input);
      return parseSchema(PersonaLibraryResponseSchema, {
        ok: true,
        value: service.getLibrary(),
      });
    } catch (error) {
      return parseSchema(PersonaLibraryResponseSchema, {
        error: appError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(PERSONA_CHANNELS.copy, (_event, input) => {
    try {
      return parseSchema(PersonaLibraryResponseSchema, {
        ok: true,
        value: service.copy(parseSchema(PersonaCopyRequestSchema, input)),
      });
    } catch (error) {
      return parseSchema(PersonaLibraryResponseSchema, {
        error: appError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(PERSONA_CHANNELS.select, (_event, input) => {
    try {
      return parseSchema(PersonaLibraryResponseSchema, {
        ok: true,
        value: service.select(parseSchema(PersonaSelectRequestSchema, input)),
      });
    } catch (error) {
      return parseSchema(PersonaLibraryResponseSchema, {
        error: appError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(PERSONA_CHANNELS.update, (_event, input) => {
    try {
      return parseSchema(PersonaLibraryResponseSchema, {
        ok: true,
        value: service.update(parseSchema(PersonaUpdateRequestSchema, input)),
      });
    } catch (error) {
      return parseSchema(PersonaLibraryResponseSchema, {
        error: appError(error),
        ok: false,
      });
    }
  });

  return () => {
    ipcMain.removeHandler(PERSONA_CHANNELS.getLibrary);
    ipcMain.removeHandler(PERSONA_CHANNELS.copy);
    ipcMain.removeHandler(PERSONA_CHANNELS.select);
    ipcMain.removeHandler(PERSONA_CHANNELS.update);
  };
}
