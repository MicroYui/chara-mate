import { ipcMain } from "electron";

import { EXTENSION_CHANNELS } from "../../shared/contracts/extensions";
import {
  McpDeleteResponseSchema,
  McpIdRequestSchema,
  McpListRequestSchema,
  McpListResponseSchema,
  McpMutationResponseSchema,
  McpSaveRequestSchema,
  SkillGetResponseSchema,
  SkillIdRequestSchema,
  SkillListRequestSchema,
  SkillListResponseSchema,
  SkillMutationResponseSchema,
  SkillSaveRequestSchema,
  SkillSetEnabledRequestSchema,
} from "../../shared/schemas/extensions";
import { parseSchema } from "../../shared/schemas/validation";
import { toExtensionAppError } from "./extensionError";
import type { McpService } from "./mcpService";
import type { SkillService } from "./skillService";

export function registerExtensionIpc(
  mcp: McpService,
  skills: SkillService,
): () => void {
  ipcMain.handle(EXTENSION_CHANNELS.mcpList, (_event, input) => {
    try {
      parseSchema(McpListRequestSchema, input);
      return parseSchema(McpListResponseSchema, {
        ok: true,
        value: mcp.list(),
      });
    } catch (error) {
      return parseSchema(McpListResponseSchema, {
        error: toExtensionAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(EXTENSION_CHANNELS.mcpSave, async (_event, input) => {
    try {
      const request = parseSchema(McpSaveRequestSchema, input);
      return parseSchema(McpMutationResponseSchema, {
        ok: true,
        value: await mcp.save(request.server),
      });
    } catch (error) {
      return parseSchema(McpMutationResponseSchema, {
        error: toExtensionAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(EXTENSION_CHANNELS.mcpRefresh, async (_event, input) => {
    try {
      const request = parseSchema(McpIdRequestSchema, input);
      return parseSchema(McpMutationResponseSchema, {
        ok: true,
        value: await mcp.refresh(request.serverId),
      });
    } catch (error) {
      return parseSchema(McpMutationResponseSchema, {
        error: toExtensionAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(EXTENSION_CHANNELS.mcpDelete, async (_event, input) => {
    try {
      const request = parseSchema(McpIdRequestSchema, input);
      return parseSchema(McpDeleteResponseSchema, {
        ok: true,
        value: await mcp.delete(request.serverId),
      });
    } catch (error) {
      return parseSchema(McpDeleteResponseSchema, {
        error: toExtensionAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(EXTENSION_CHANNELS.skillList, (_event, input) => {
    try {
      parseSchema(SkillListRequestSchema, input);
      return parseSchema(SkillListResponseSchema, {
        ok: true,
        value: skills.list(),
      });
    } catch (error) {
      return parseSchema(SkillListResponseSchema, {
        error: toExtensionAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(EXTENSION_CHANNELS.skillRefresh, async (_event, input) => {
    try {
      parseSchema(SkillListRequestSchema, input);
      return parseSchema(SkillListResponseSchema, {
        ok: true,
        value: await skills.refresh(),
      });
    } catch (error) {
      return parseSchema(SkillListResponseSchema, {
        error: toExtensionAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(EXTENSION_CHANNELS.skillGet, async (_event, input) => {
    try {
      const request = parseSchema(SkillIdRequestSchema, input);
      return parseSchema(SkillGetResponseSchema, {
        ok: true,
        value: await skills.get(request.skillId),
      });
    } catch (error) {
      return parseSchema(SkillGetResponseSchema, {
        error: toExtensionAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(EXTENSION_CHANNELS.skillSave, async (_event, input) => {
    try {
      const request = parseSchema(SkillSaveRequestSchema, input);
      return parseSchema(SkillMutationResponseSchema, {
        ok: true,
        value: await skills.save(request.name, request.content),
      });
    } catch (error) {
      return parseSchema(SkillMutationResponseSchema, {
        error: toExtensionAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(EXTENSION_CHANNELS.skillSetEnabled, (_event, input) => {
    try {
      const request = parseSchema(SkillSetEnabledRequestSchema, input);
      return parseSchema(SkillMutationResponseSchema, {
        ok: true,
        value: skills.setEnabled(request.skillId, request.enabled),
      });
    } catch (error) {
      return parseSchema(SkillMutationResponseSchema, {
        error: toExtensionAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(EXTENSION_CHANNELS.skillArchive, async (_event, input) => {
    try {
      const request = parseSchema(SkillIdRequestSchema, input);
      return parseSchema(SkillMutationResponseSchema, {
        ok: true,
        value: await skills.archive(request.skillId),
      });
    } catch (error) {
      return parseSchema(SkillMutationResponseSchema, {
        error: toExtensionAppError(error),
        ok: false,
      });
    }
  });

  return () => {
    for (const channel of Object.values(EXTENSION_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
