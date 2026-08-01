import path from "node:path";

import { app, BrowserWindow } from "electron";
import type Database from "better-sqlite3";

import type { FoundationSnapshot } from "../shared/contracts/foundation";
import { RUN_EVENT_CHANNELS } from "../shared/contracts/ipc";
import { RunEventService } from "./agent/runEventService";
import { RunRepository } from "./agent/runRepository";
import { registerChatDataIpc } from "./app/chatDataIpc";
import { registerFoundationIpc } from "./app/foundationIpc";
import { createMainWindow } from "./app/windows";
import { ChatDataService } from "./chat/chatDataService";
import { ChatRepository } from "./chat/chatRepository";
import {
  openApplicationDatabase,
  verifyDatabaseRoundTrip,
} from "./db/database";
import { createAppLogger } from "./observability/logger";

const logger = createAppLogger();

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
let applicationDatabase: Database.Database | undefined;
let unregisterChatDataIpc: (() => void) | undefined;
let unregisterFoundationIpc: (() => void) | undefined;

function stopApplicationInfrastructure(): void {
  unregisterChatDataIpc?.();
  unregisterChatDataIpc = undefined;
  unregisterFoundationIpc?.();
  unregisterFoundationIpc = undefined;
  applicationDatabase?.close();
  applicationDatabase = undefined;
}

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

  applicationDatabase = openApplicationDatabase(
    path.join(app.getPath("userData"), "charamate.sqlite"),
  );
  const chatRepository = new ChatRepository(applicationDatabase);
  const runRepository = new RunRepository(applicationDatabase);
  const runEventService = new RunEventService(runRepository, {
    publish(envelope) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.isDestroyed()) {
          continue;
        }
        try {
          window.webContents.send(RUN_EVENT_CHANNELS.subscribe, envelope);
        } catch (error) {
          logger.warn("RUN_EVENT_BROADCAST_ERROR", {
            error,
            runId: envelope.streamId,
            sequence: envelope.sequence,
          });
        }
      }
    },
  });
  unregisterChatDataIpc = registerChatDataIpc(
    new ChatDataService(chatRepository, runRepository),
    runEventService,
  );

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
    logger.error(
      "CHARAMATE_STARTUP_ERROR",
      error instanceof Error ? error : { error },
    );
    stopApplicationInfrastructure();
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
  stopApplicationInfrastructure();
});
