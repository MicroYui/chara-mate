import path from "node:path";

import { BrowserWindow, screen } from "electron";

import type { Clock } from "../../shared/pure/clock";
import type {
  WindowPlacement,
  WindowPlacementRepository,
} from "./windowPlacementRepository";

const MAIN_WINDOW_ID = "main-panel";
const DEFAULT_WIDTH = 1180;
const DEFAULT_HEIGHT = 800;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 640;

function normalizedBounds(saved: WindowPlacement | undefined) {
  const desired = saved ?? {
    height: DEFAULT_HEIGHT,
    width: DEFAULT_WIDTH,
    x: screen.getPrimaryDisplay().workArea.x,
    y: screen.getPrimaryDisplay().workArea.y,
  };
  const workArea = screen.getDisplayMatching(desired).workArea;
  const width = Math.min(Math.max(desired.width, MIN_WIDTH), workArea.width);
  const height = Math.min(
    Math.max(desired.height, MIN_HEIGHT),
    workArea.height,
  );
  const centeredX = workArea.x + Math.round((workArea.width - width) / 2);
  const centeredY = workArea.y + Math.round((workArea.height - height) / 2);
  const x = saved
    ? Math.min(
        Math.max(saved.x, workArea.x),
        workArea.x + workArea.width - width,
      )
    : centeredX;
  const y = saved
    ? Math.min(
        Math.max(saved.y, workArea.y),
        workArea.y + workArea.height - height,
      )
    : centeredY;
  return { height, width, x, y };
}

export async function createMainWindow(
  placements?: WindowPlacementRepository,
  clock?: Clock,
): Promise<BrowserWindow> {
  const saved = placements?.get(MAIN_WINDOW_ID);
  const bounds = normalizedBounds(saved);
  const window = new BrowserWindow({
    ...bounds,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    minWidth: Math.min(MIN_WIDTH, bounds.width),
    minHeight: Math.min(MIN_HEIGHT, bounds.height),
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
    if (saved?.isMaximized) {
      window.maximize();
    }
    window.show();
  });

  window.on("close", () => {
    if (!placements || !clock) return;
    const normalBounds = window.getNormalBounds();
    placements.save(MAIN_WINDOW_ID, {
      ...normalBounds,
      isMaximized: window.isMaximized(),
      updatedAt: clock.now(),
    });
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
