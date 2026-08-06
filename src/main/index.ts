import path from "node:path";

import { app, BrowserWindow } from "electron";
import type Database from "better-sqlite3";

import type { FoundationSnapshot } from "../shared/contracts/foundation";
import { RUN_EVENT_CHANNELS } from "../shared/contracts/ipc";
import { PET_CHANNELS } from "../shared/contracts/pet";
import { SystemClock } from "../shared/pure/clock";
import { CryptoIdGenerator } from "../shared/pure/id";
import { PetMainNavigationSchema } from "../shared/schemas/pet";
import { parseSchema } from "../shared/schemas/validation";
import { RunEventService } from "./agent/runEventService";
import { RunRepository } from "./agent/runRepository";
import { registerChatIpc } from "./app/chatIpc";
import { registerFoundationIpc } from "./app/foundationIpc";
import { registerApplicationSchemes } from "./app/protocolSchemes";
import {
  MainWindowController,
  type MainWindowTarget,
} from "./app/mainWindowController";
import { WindowPlacementRepository } from "./app/windowPlacementRepository";
import { createMainWindow } from "./app/windows";
import { ChatRepository } from "./chat/chatRepository";
import { ChatService } from "./chat/chatService";
import {
  openApplicationDatabase,
  verifyDatabaseRoundTrip,
} from "./db/database";
import { createAppLogger } from "./observability/logger";
import { CharacterWindowController } from "./pet/characterWindowController";
import { registerPetIpc } from "./pet/petIpc";
import { PetLibraryRepository } from "./pet/petLibraryRepository";
import { registerPetProtocol } from "./pet/petProtocol";
import { PetService } from "./pet/petService";
import { PetStateRepository } from "./pet/petStateRepository";
import { ElectronSafeStorageEncryption } from "./providers/electronSecretEncryption";
import { registerProviderIpc } from "./providers/providerIpc";
import { ProviderRepository } from "./providers/providerRepository";
import { ProviderService } from "./providers/providerService";
import { SafeStorageSecretStore } from "./providers/secretStore";
import { registerTerritoryIpc } from "./territory/territoryIpc";
import { TerritoryAssetStore } from "./territory/territoryAssetStore";
import { ElectronTerritoryImageNormalizer } from "./territory/electronTerritoryImageNormalizer";
import { registerTerritoryProtocol } from "./territory/territoryProtocol";
import { TerritoryRepository } from "./territory/territoryRepository";
import { TerritoryService } from "./territory/territoryService";

const logger = createAppLogger();

registerApplicationSchemes();

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

let mainWindowController: MainWindowController | undefined;
let applicationDatabase: Database.Database | undefined;
let unregisterChatIpc: (() => void) | undefined;
let unregisterFoundationIpc: (() => void) | undefined;
let unregisterProviderIpc: (() => void) | undefined;
let unregisterPetIpc: (() => void) | undefined;
let unregisterPetProtocol: (() => void) | undefined;
let unregisterTerritoryIpc: (() => void) | undefined;
let unregisterTerritoryProtocol: (() => void) | undefined;
let providerService: ProviderService | undefined;
let characterWindowController: CharacterWindowController | undefined;

function openMainWindow(target?: MainWindowTarget): void {
  const controller = mainWindowController;
  if (!controller) return;
  void controller.open(target).catch((error: unknown) => {
    logger.error(
      "CHARAMATE_MAIN_WINDOW_OPEN_ERROR",
      error instanceof Error ? error : { error },
    );
  });
}

function stopApplicationInfrastructure(): void {
  unregisterChatIpc?.();
  unregisterChatIpc = undefined;
  unregisterFoundationIpc?.();
  unregisterFoundationIpc = undefined;
  unregisterProviderIpc?.();
  unregisterProviderIpc = undefined;
  unregisterPetIpc?.();
  unregisterPetIpc = undefined;
  unregisterPetProtocol?.();
  unregisterPetProtocol = undefined;
  unregisterTerritoryIpc?.();
  unregisterTerritoryIpc = undefined;
  unregisterTerritoryProtocol?.();
  unregisterTerritoryProtocol = undefined;
  characterWindowController?.destroy();
  characterWindowController = undefined;
  mainWindowController = undefined;
  providerService = undefined;
  applicationDatabase?.close();
  applicationDatabase = undefined;
}

async function startApplication(): Promise<void> {
  if (process.env["CHARAMATE_SMOKE_TEST"] === "1") {
    console.error("CHARAMATE_MAIN_STAGE app-ready");
  }

  const userDataPath = app.getPath("userData");
  const databasePath = path.join(userDataPath, "charamate.sqlite");
  const databaseRoundTrip = verifyDatabaseRoundTrip(databasePath);
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

  applicationDatabase = openApplicationDatabase(databasePath);
  const idGenerator = new CryptoIdGenerator();
  const clock = new SystemClock();
  const chatRepository = new ChatRepository(applicationDatabase);
  const runRepository = new RunRepository(applicationDatabase);
  const windowPlacementRepository = new WindowPlacementRepository(
    applicationDatabase,
  );
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
  unregisterChatIpc = registerChatIpc(
    new ChatService(chatRepository, runRepository, idGenerator, clock),
    runEventService,
  );

  providerService = new ProviderService(
    new ProviderRepository(applicationDatabase),
    new SafeStorageSecretStore(
      path.join(userDataPath, "secrets.bin"),
      new ElectronSafeStorageEncryption(),
      idGenerator,
    ),
    idGenerator,
    clock,
    logger,
  );
  await providerService.initialize();
  unregisterProviderIpc = registerProviderIpc(providerService);

  const petLibrary = new PetLibraryRepository(path.join(userDataPath, "pets"));
  const petService = new PetService(
    petLibrary,
    new PetStateRepository(applicationDatabase),
    clock,
  );
  await petService.initialize();
  unregisterPetProtocol = registerPetProtocol(petLibrary);
  const territoryRepository = new TerritoryRepository(applicationDatabase);
  const territoryAssets = new TerritoryAssetStore(
    path.join(userDataPath, "territory", "assets"),
    new ElectronTerritoryImageNormalizer(),
  );
  unregisterTerritoryProtocol = registerTerritoryProtocol(
    territoryRepository,
    territoryAssets,
  );
  unregisterTerritoryIpc = registerTerritoryIpc(
    new TerritoryService(territoryRepository, territoryAssets, clock),
  );

  const mainWindows = new MainWindowController(
    () => createMainWindow(windowPlacementRepository, clock),
    () => {
      if (process.platform === "darwin") app.focus({ steal: true });
      else app.focus();
    },
    (window, target) => {
      window.webContents.send(
        PET_CHANNELS.openMain,
        parseSchema(PetMainNavigationSchema, { target }),
      );
    },
  );
  mainWindowController = mainWindows;

  let resolveRendererReady: (() => void) | undefined;
  const rendererReady = new Promise<void>((resolve) => {
    resolveRendererReady = resolve;
  });
  let resolveCharacterRendererReady: (() => void) | undefined;
  const characterRendererReady = new Promise<void>((resolve) => {
    resolveCharacterRendererReady = resolve;
  });
  unregisterFoundationIpc = registerFoundationIpc(snapshot, (sender) => {
    mainWindows.markRendererReady(sender);
    resolveRendererReady?.();
  });
  characterWindowController = new CharacterWindowController(
    petService,
    openMainWindow,
  );
  unregisterPetIpc = registerPetIpc(
    petService,
    characterWindowController,
    () => mainWindows.getWindow(),
    () => resolveCharacterRendererReady?.(),
  );
  await mainWindows.open();
  await characterWindowController.create();
  if (process.env["CHARAMATE_SMOKE_TEST"] === "1") {
    console.error("CHARAMATE_MAIN_STAGE window-loaded");
    await Promise.all([rendererReady, characterRendererReady]);
    console.log(
      `CHARAMATE_SMOKE_RESULT ${JSON.stringify({
        characterRendererReady: true,
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
  openMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  stopApplicationInfrastructure();
});
