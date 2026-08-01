import path from "node:path";

import { BrowserWindow } from "electron";

export async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: "CharaMate",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Electron requires unsandboxed renderers for a native ESM preload.
      sandbox: false,
      preload: path.join(import.meta.dirname, "preload.mjs"),
    },
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  if (process.env["CHARAMATE_SMOKE_TEST"] === "1") {
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.error(
        `CHARAMATE_PRELOAD_ERROR ${JSON.stringify({
          message: error.message,
          preloadPath,
        })}`,
      );
    });
    window.webContents.on("did-fail-load", (_event, code, description) => {
      console.error(
        `CHARAMATE_LOAD_ERROR ${JSON.stringify({ code, description })}`,
      );
    });
    window.webContents.on("console-message", (details) => {
      console.error(
        `CHARAMATE_RENDERER_CONSOLE ${JSON.stringify({
          level: details.level,
          message: details.message,
        })}`,
      );
    });
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(
      path.join(
        import.meta.dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    );
  }

  return window;
}
