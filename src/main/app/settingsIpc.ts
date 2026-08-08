import { dialog, ipcMain, type BrowserWindow } from "electron";

import { SETTINGS_CHANNELS } from "../../shared/contracts/settings";
import {
  AgentSettingsSaveRequestSchema,
  AgentSettingsSaveResponseSchema,
  BrowserActionResponseSchema,
  SettingsEmptyRequestSchema,
  SettingsSnapshotResponseSchema,
} from "../../shared/schemas/settings";
import { parseSchema } from "../../shared/schemas/validation";
import type { SettingsService } from "./settingsService";

function appError(error: unknown) {
  return {
    code: "SETTINGS.OPERATION_FAILED",
    message: error instanceof Error ? error.message : "设置操作没有完成。",
    retryable: false,
  };
}

export function registerSettingsIpc(
  service: SettingsService,
  getMainWindow: () => BrowserWindow | null,
): () => void {
  ipcMain.handle(SETTINGS_CHANNELS.getSnapshot, async (_event, input) => {
    try {
      parseSchema(SettingsEmptyRequestSchema, input);
      return parseSchema(SettingsSnapshotResponseSchema, {
        ok: true,
        value: await service.getSnapshot(),
      });
    } catch (error) {
      return parseSchema(SettingsSnapshotResponseSchema, {
        error: appError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(SETTINGS_CHANNELS.saveAgent, async (_event, input) => {
    try {
      const request = parseSchema(AgentSettingsSaveRequestSchema, input);
      return parseSchema(AgentSettingsSaveResponseSchema, {
        ok: true,
        value: await service.saveAgent(request.agent),
      });
    } catch (error) {
      return parseSchema(AgentSettingsSaveResponseSchema, {
        error: appError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(
    SETTINGS_CHANNELS.openManagedBrowser,
    async (_event, input) => {
      try {
        parseSchema(SettingsEmptyRequestSchema, input);
        return parseSchema(BrowserActionResponseSchema, {
          ok: true,
          value: await service.openManagedBrowser(),
        });
      } catch (error) {
        return parseSchema(BrowserActionResponseSchema, {
          error: appError(error),
          ok: false,
        });
      }
    },
  );
  ipcMain.handle(
    SETTINGS_CHANNELS.importBrowserCookies,
    async (_event, input) => {
      try {
        parseSchema(SettingsEmptyRequestSchema, input);
        const window = getMainWindow();
        if (!window || window.isDestroyed()) {
          throw new Error("主窗口当前不可用。");
        }
        const selection = await dialog.showOpenDialog(window, {
          buttonLabel: "导入 Cookie",
          filters: [{ extensions: ["json"], name: "Cookie JSON" }],
          properties: ["openFile"],
          title: "导入受管浏览器 Cookie",
        });
        const sourcePath = selection.filePaths[0];
        return parseSchema(
          BrowserActionResponseSchema,
          selection.canceled || !sourcePath
            ? { ok: true, value: { message: "已取消导入。" } }
            : {
                ok: true,
                value: await service.importBrowserCookies(sourcePath),
              },
        );
      } catch (error) {
        return parseSchema(BrowserActionResponseSchema, {
          error: appError(error),
          ok: false,
        });
      }
    },
  );

  return () => {
    for (const channel of Object.values(SETTINGS_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
