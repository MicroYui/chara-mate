import path from "node:path";

import { app, BrowserWindow } from "electron";

import type { FoundationSnapshot } from "../shared/contracts/foundation";
import { registerFoundationIpc } from "./app/foundationIpc";
import { createMainWindow } from "./app/windows";
import { verifyDatabaseRoundTrip } from "./db/database";

const userDataOverride = process.env["CHARAMATE_USER_DATA_DIR"];
if (process.env["CHARAMATE_SMOKE_TEST"] === "1") {
  console.error("CHARAMATE_MAIN_STAGE module-loaded");
}
if (userDataOverride) {
  app.setPath("userData", path.resolve(userDataOverride));
}

function getSupportedPlatform(): FoundationSnapshot["platform"] {
  if (
    process.platform !== "darwin" &&
    process.platform !== "linux" &&
    process.platform !== "win32"
  ) {
    throw new Error(`Unsupported desktop platform: ${process.platform}`);
  }

  return process.platform;
}

let mainWindow: BrowserWindow | null = null;
let unregisterFoundationIpc: (() => void) | undefined;

async function startApplication(): Promise<void> {
  if (process.env["CHARAMATE_SMOKE_TEST"] === "1") {
    console.error("CHARAMATE_MAIN_STAGE app-ready");
  }

  const databaseRoundTrip = verifyDatabaseRoundTrip(
    path.join(app.getPath("userData"), "charamate.sqlite"),
  );
  if (process.env["CHARAMATE_SMOKE_TEST"] === "1") {
    console.error("CHARAMATE_MAIN_STAGE database-ready");
  }

  const snapshot: FoundationSnapshot = {
    appName: "CharaMate",
    appVersion: app.getVersion(),
    databaseRoundTrip,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: getSupportedPlatform(),
  };

  let resolveRendererReady: (() => void) | undefined;
  const rendererReady = new Promise<void>((resolve) => {
    resolveRendererReady = resolve;
  });
  unregisterFoundationIpc = registerFoundationIpc(snapshot, (sender) => {
    if (mainWindow && sender.id === mainWindow.webContents.id) {
      resolveRendererReady?.();
    }
  });

  mainWindow = await createMainWindow();
  if (process.env["CHARAMATE_SMOKE_TEST"] === "1") {
    console.error("CHARAMATE_MAIN_STAGE window-loaded");
    await rendererReady;
    console.log(
      `CHARAMATE_SMOKE_RESULT ${JSON.stringify({
        databaseRoundTrip,
        mode: process.env["CHARAMATE_SMOKE_KIND"],
        rendererReady: true,
      })}`,
    );
    app.quit();
  }
}

void app
  .whenReady()
  .then(startApplication)
  .catch((error: unknown) => {
    console.error(
      "CHARAMATE_STARTUP_ERROR",
      error instanceof Error ? error.message : "Unknown startup error",
    );
    app.exit(1);
  });

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow().then((window) => {
      mainWindow = window;
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  unregisterFoundationIpc?.();
});
