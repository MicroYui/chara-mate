import path from "node:path";
import { access } from "node:fs/promises";

import {
  app,
  BrowserWindow,
  powerMonitor,
  shell,
  systemPreferences,
} from "electron";
import type Database from "better-sqlite3";

import type { FoundationSnapshot } from "../shared/contracts/foundation";
import { AGENT_CHANNELS } from "../shared/contracts/agent";
import { AUTOMATION_CHANNELS } from "../shared/contracts/automation";
import { CHAT_EVENT_CHANNELS } from "../shared/contracts/chat";
import { RUN_EVENT_CHANNELS } from "../shared/contracts/ipc";
import { PET_CHANNELS } from "../shared/contracts/pet";
import { VOICE_CHANNELS } from "../shared/contracts/voice";
import { SystemClock } from "../shared/pure/clock";
import { CryptoIdGenerator } from "../shared/pure/id";
import { PetMainNavigationSchema } from "../shared/schemas/pet";
import { ApprovalNavigationTargetSchema } from "../shared/schemas/agent";
import { parseSchema } from "../shared/schemas/validation";
import {
  VoiceClientCommandSchema,
  VoiceSessionSnapshotSchema,
} from "../shared/schemas/voice";
import { registerAgentIpc } from "./agent/agentIpc";
import { AgentRuntime } from "./agent/agentRuntime";
import { ElectronImageInputProvider } from "./agent/imageInput";
import { CheckpointRepository } from "./agent/checkpointRepository";
import { decodeRuntimeCheckpoint } from "./agent/runtimeCheckpoint";
import { RunEventService } from "./agent/runEventService";
import { RunEventWriter } from "./agent/runEventWriter";
import { RunRepository } from "./agent/runRepository";
import { registerAutomationIpc } from "./automations/automationIpc";
import { AutomationRepository } from "./automations/automationRepository";
import { AutomationScheduler } from "./automations/automationScheduler";
import { AutomationService } from "./automations/automationService";
import { registerChatIpc } from "./app/chatIpc";
import { registerFoundationIpc } from "./app/foundationIpc";
import { registerApplicationSchemes } from "./app/protocolSchemes";
import {
  MainWindowController,
  type MainWindowTarget,
} from "./app/mainWindowController";
import { WindowPlacementRepository } from "./app/windowPlacementRepository";
import { createMainWindow } from "./app/windows";
import { registerSettingsIpc } from "./app/settingsIpc";
import { SettingsRepository } from "./app/settingsRepository";
import { SettingsService } from "./app/settingsService";
import { MacOsActiveApplicationProbe } from "./activity/activeApplicationProbe";
import { ActivityAssetStore } from "./activity/activityAssetStore";
import { ActivityCaptureCoordinator } from "./activity/activityCaptureCoordinator";
import { registerActivityIpc } from "./activity/activityIpc";
import { registerActivityProtocol } from "./activity/activityProtocol";
import { ActivityRepository } from "./activity/activityRepository";
import { ActivityService } from "./activity/activityService";
import { ElectronActivitySystemSource } from "./activity/activitySystemSource";
import { ChatRepository } from "./chat/chatRepository";
import { ChatService } from "./chat/chatService";
import { ChatTitleService } from "./chat/chatTitleService";
import {
  bundledChromiumExecutablePath,
  ManagedBrowser,
  registerBrowserTools,
} from "./browser/managedBrowser";
import { ElectronScreenCapture } from "./computer/electronScreenCapture";
import {
  MacOsComputerAdapter,
  registerComputerTools,
} from "./computer/macosComputer";
import {
  openApplicationDatabase,
  verifyDatabaseRoundTrip,
} from "./db/database";
import { createAppLogger } from "./observability/logger";
import { DevDashboard } from "./observability/devDashboard";
import { RuntimeObservability } from "./observability/runtimeObservability";
import { registerExtensionIpc } from "./extensions/extensionIpc";
import { McpRepository } from "./extensions/mcpRepository";
import { McpService } from "./extensions/mcpService";
import { SkillRepository } from "./extensions/skillRepository";
import { SkillService } from "./extensions/skillService";
import { LexicalRetrievalPipeline } from "./memory/lexicalRetrievalPipeline";
import { registerMemoryIpc } from "./memory/memoryIpc";
import { MemoryRepository } from "./memory/memoryRepository";
import { MemoryService } from "./memory/memoryService";
import { memoryContextTargetIds } from "./agent/memoryContext";
import {
  registerMemoryFormationTool,
  registerMemoryTool,
} from "./memory/memoryTool";
import { CharacterWindowController } from "./pet/characterWindowController";
import { bundledPetsDirectory, installBundledPets } from "./pet/bundledPets";
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
import { registerPlanTool } from "./agent/planTool";
import { ArtifactStore } from "./tools/artifactStore";
import { registerLocalTools } from "./tools/localTools";
import { ToolRegistry } from "./tools/toolRegistry";
import { registerTerritoryIpc } from "./territory/territoryIpc";
import { TerritoryAssetStore } from "./territory/territoryAssetStore";
import { TerritoryCandidateStore } from "./territory/territoryCandidateStore";
import { ElectronTerritoryCandidateProcessor } from "./territory/electronTerritoryCandidateProcessor";
import { ElectronTerritoryImageNormalizer } from "./territory/electronTerritoryImageNormalizer";
import { TerritoryImageService } from "./territory/territoryImageService";
import { registerTerritoryProtocol } from "./territory/territoryProtocol";
import { TerritoryRepository } from "./territory/territoryRepository";
import { TerritoryService } from "./territory/territoryService";
import { registerTerritoryTools } from "./territory/territoryTools";
import { AzureWebRtcSessionIssuer } from "./voice/azureWebRtcSession";
import { registerVoiceIpc } from "./voice/voiceIpc";
import { VoiceRepository } from "./voice/voiceRepository";
import { VoiceService } from "./voice/voiceService";
import { registerVoiceTools } from "./voice/voiceTool";
import { VoiceMetrics } from "./voice/voiceMetrics";

const logger = createAppLogger();
const backgroundTest = process.env["CHARAMATE_TEST_BACKGROUND"] === "1";

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
let unregisterActivityIpc: (() => void) | undefined;
let unregisterActivityProtocol: (() => void) | undefined;
let unregisterAgentIpc: (() => void) | undefined;
let unregisterAutomationIpc: (() => void) | undefined;
let unregisterExtensionIpc: (() => void) | undefined;
let unregisterFoundationIpc: (() => void) | undefined;
let unregisterMemoryIpc: (() => void) | undefined;
let unregisterProviderIpc: (() => void) | undefined;
let unregisterSettingsIpc: (() => void) | undefined;
let unregisterPetIpc: (() => void) | undefined;
let unregisterPetProtocol: (() => void) | undefined;
let unregisterTerritoryIpc: (() => void) | undefined;
let unregisterTerritoryProtocol: (() => void) | undefined;
let unregisterVoiceIpc: (() => void) | undefined;
let providerService: ProviderService | undefined;
let characterWindowController: CharacterWindowController | undefined;
let agentRuntime: AgentRuntime | undefined;
let automationScheduler: AutomationScheduler | undefined;
let activityCapture: ActivityCaptureCoordinator | undefined;
let activityService: ActivityService | undefined;
let managedBrowser: ManagedBrowser | undefined;
let mcpService: McpService | undefined;
let devDashboard: DevDashboard | undefined;
let voiceService: VoiceService | undefined;
let stopPromise: Promise<void> | undefined;
let shutdownComplete = false;

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

async function stopApplicationInfrastructure(): Promise<void> {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    unregisterActivityIpc?.();
    unregisterActivityIpc = undefined;
    unregisterActivityProtocol?.();
    unregisterActivityProtocol = undefined;
    unregisterAgentIpc?.();
    unregisterAgentIpc = undefined;
    unregisterAutomationIpc?.();
    unregisterAutomationIpc = undefined;
    unregisterExtensionIpc?.();
    unregisterExtensionIpc = undefined;
    unregisterChatIpc?.();
    unregisterChatIpc = undefined;
    unregisterFoundationIpc?.();
    unregisterFoundationIpc = undefined;
    unregisterMemoryIpc?.();
    unregisterMemoryIpc = undefined;
    unregisterProviderIpc?.();
    unregisterProviderIpc = undefined;
    unregisterSettingsIpc?.();
    unregisterSettingsIpc = undefined;
    unregisterPetIpc?.();
    unregisterPetIpc = undefined;
    unregisterPetProtocol?.();
    unregisterPetProtocol = undefined;
    unregisterTerritoryIpc?.();
    unregisterTerritoryIpc = undefined;
    unregisterTerritoryProtocol?.();
    unregisterTerritoryProtocol = undefined;
    unregisterVoiceIpc?.();
    unregisterVoiceIpc = undefined;
    await automationScheduler?.stop();
    automationScheduler = undefined;
    voiceService?.shutdown();
    await agentRuntime?.interruptAll();
    managedBrowser?.setActivityObserver(undefined);
    const activityStops = await Promise.allSettled([
      activityCapture?.stop() ?? Promise.resolve(),
      activityService?.stopMaintenance() ?? Promise.resolve(),
    ]);
    for (const result of activityStops) {
      if (result.status === "rejected") {
        logger.warn("ACTIVITY_SHUTDOWN_ERROR", { error: result.reason });
      }
    }
    await Promise.allSettled([
      managedBrowser?.close() ?? Promise.resolve(),
      mcpService?.close() ?? Promise.resolve(),
      devDashboard?.close() ?? Promise.resolve(),
    ]);
    agentRuntime = undefined;
    activityCapture = undefined;
    activityService = undefined;
    managedBrowser = undefined;
    mcpService = undefined;
    devDashboard = undefined;
    voiceService = undefined;
    characterWindowController?.destroy();
    characterWindowController = undefined;
    mainWindowController?.destroy();
    mainWindowController = undefined;
    providerService = undefined;
    applicationDatabase?.close();
    applicationDatabase = undefined;
  })();
  return stopPromise;
}

async function startApplication(): Promise<void> {
  if (backgroundTest && process.platform === "darwin") app.dock?.hide();
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
  const memoryRepository = new MemoryRepository(applicationDatabase);
  const memoryServiceInstance = new MemoryService(
    memoryRepository,
    new LexicalRetrievalPipeline(applicationDatabase, memoryRepository, clock),
    idGenerator,
    clock,
  );
  unregisterMemoryIpc = registerMemoryIpc(memoryServiceInstance);
  const runRepository = new RunRepository(applicationDatabase);
  const checkpointRepository = new CheckpointRepository(applicationDatabase);
  const runtimeObservability = new RuntimeObservability(runRepository, logger);
  const automationServiceReference: { current?: AutomationService } = {};
  let voiceMetrics: VoiceMetrics | undefined;
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
      try {
        runtimeObservability.record(envelope);
      } catch (error) {
        logger.warn("RUNTIME_OBSERVABILITY_ERROR", {
          error,
          runId: envelope.streamId,
          sequence: envelope.sequence,
        });
      }
      try {
        activityCapture?.observeRun(envelope);
      } catch (error) {
        logger.warn("ACTIVITY_RUN_CAPTURE_ERROR", {
          error,
          runId: envelope.streamId,
          sequence: envelope.sequence,
        });
      }
      try {
        automationServiceReference.current?.observeRun(envelope);
      } catch (error) {
        logger.warn("AUTOMATION_RUN_PROJECTION_ERROR", {
          error,
          runId: envelope.streamId,
          sequence: envelope.sequence,
        });
      }
    },
  });
  if (!app.isPackaged && process.env["CHARAMATE_DEV_DASHBOARD"] !== "0") {
    voiceMetrics = new VoiceMetrics();
    devDashboard = new DevDashboard(runtimeObservability, voiceMetrics);
    logger.info("DEV_DASHBOARD_READY", {
      url: await devDashboard.start(),
    });
  }
  const chatService = new ChatService(
    chatRepository,
    runRepository,
    idGenerator,
    clock,
    (chat) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.isDestroyed()) continue;
        try {
          window.webContents.send(CHAT_EVENT_CHANNELS.changed, chat);
        } catch (error) {
          logger.warn("CHAT_CHANGE_BROADCAST_ERROR", {
            chatId: chat.id,
            error,
          });
        }
      }
    },
  );
  unregisterChatIpc = registerChatIpc(chatService, runEventService);

  const secretStore = new SafeStorageSecretStore(
    path.join(userDataPath, "secrets.bin"),
    new ElectronSafeStorageEncryption(),
    idGenerator,
  );
  providerService = new ProviderService(
    new ProviderRepository(applicationDatabase),
    secretStore,
    idGenerator,
    clock,
    logger,
  );
  const toolRegistry = new ToolRegistry();
  registerMemoryTool(toolRegistry, memoryServiceInstance);
  registerMemoryFormationTool(
    toolRegistry,
    memoryServiceInstance,
    (runId, basis) => {
      const run = runRepository.getRun(runId);
      if (!run) throw new TypeError("Memory evidence Run is unavailable");
      const checkpoint = checkpointRepository.get(runId);
      const allowedMemoryIds =
        run.source === "voice"
          ? [...(voiceService?.getMemoryContextIds(runId) ?? [])]
          : checkpoint
            ? [
                ...new Set(
                  decodeRuntimeCheckpoint(checkpoint.context).input.flatMap(
                    memoryContextTargetIds,
                  ),
                ),
              ]
            : [];
      if (basis === "run_observation") {
        return {
          allowedMemoryIds,
          label: `Agent Run ${run.id}`,
          referenceId: run.id,
          sourceType: "tool",
        };
      }
      const evidenceItem = runRepository
        .listRunItems(run.id)
        .filter(
          (item) =>
            item.status === "completed" &&
            (item.kind === "user_message" || item.kind === "input_request"),
        )
        .at(-1);
      if (!evidenceItem) {
        throw new TypeError("Memory evidence user input is unavailable");
      }
      const input = evidenceItem.input;
      const messageId =
        input && typeof input === "object" && !Array.isArray(input)
          ? input["messageId"]
          : undefined;
      const evidenceId =
        typeof messageId === "string" ? messageId : evidenceItem.id;
      return {
        allowedMemoryIds,
        label:
          evidenceItem.kind === "user_message"
            ? `用户消息 ${evidenceId}`
            : `结构化回答 ${evidenceId}`,
        referenceId: run.chatId,
        sourceType: run.source === "voice" ? "voice" : "chat",
      };
    },
  );
  const artifactStore = new ArtifactStore(
    path.join(userDataPath, "artifacts"),
    idGenerator,
  );
  const workspaceDirectory = path.resolve(
    process.env["CHARAMATE_WORKSPACE_DIR"] ?? process.cwd(),
  );
  const settingsRepository = new SettingsRepository(
    applicationDatabase,
    workspaceDirectory,
  );
  const initialAgentSettings = settingsRepository.getAgent();
  const skillService = new SkillService(
    path.join(initialAgentSettings.workingDirectory, ".agents", "skills"),
    path.join(userDataPath, "skills"),
    new SkillRepository(applicationDatabase),
    idGenerator,
    clock,
  );
  await skillService.initialize();
  skillService.registerTools(toolRegistry);

  mcpService = new McpService(
    new McpRepository(applicationDatabase),
    secretStore,
    toolRegistry,
    artifactStore,
    idGenerator,
    clock,
  );
  await providerService.initialize(mcpService.listSecretReferences());
  unregisterProviderIpc = registerProviderIpc(providerService);
  mcpService.registerConfigurationTools();

  managedBrowser = new ManagedBrowser(
    path.join(userDataPath, "browser", "profile"),
    path.join(userDataPath, "browser", "downloads"),
    process.env["CHARAMATE_CHROMIUM_EXECUTABLE_PATH"] ??
      (app.isPackaged
        ? bundledChromiumExecutablePath(process.resourcesPath)
        : undefined),
  );
  const screenCapture = new ElectronScreenCapture();
  const activityRepository = new ActivityRepository(applicationDatabase);
  const activityAssets = new ActivityAssetStore(
    path.join(userDataPath, "activity", "assets"),
  );
  activityService = new ActivityService(
    activityRepository,
    memoryServiceInstance,
    activityAssets,
    screenCapture,
    idGenerator,
    clock,
  );
  await activityService.initialize();
  unregisterActivityProtocol = registerActivityProtocol(
    activityRepository,
    activityAssets,
  );
  unregisterActivityIpc = registerActivityIpc(activityService);
  activityCapture = new ActivityCaptureCoordinator(
    activityService,
    new MacOsActiveApplicationProbe(),
    new ElectronActivitySystemSource(60),
    clock,
    logger,
  );
  if (!backgroundTest) {
    const capture = activityCapture;
    managedBrowser.setActivityObserver((state) =>
      capture.observeBrowser(state),
    );
    capture.start();
  }
  activityService.startMaintenance((error) => {
    logger.warn("ACTIVITY_MAINTENANCE_ERROR", { error });
  });
  const settingsService = new SettingsService(
    settingsRepository,
    managedBrowser,
    {
      read: () =>
        process.platform !== "darwin"
          ? "unavailable"
          : systemPreferences.isTrustedAccessibilityClient(false)
            ? "granted"
            : "denied",
      readScreenRecording: () => {
        if (process.platform !== "darwin") return "unavailable";
        const status = systemPreferences.getMediaAccessStatus("screen");
        if (status === "not-determined") return "not_determined";
        return status === "unknown" ? "unavailable" : status;
      },
      readMicrophone: () => {
        if (process.platform !== "darwin") return "unavailable";
        const status = systemPreferences.getMediaAccessStatus("microphone");
        if (status === "not-determined") return "not_determined";
        return status === "unknown" ? "unavailable" : status;
      },
    },
    clock,
    (directory) => skillService.setWorkspaceDirectory(directory),
  );
  registerLocalTools(toolRegistry, {
    artifacts: artifactStore,
    openPath: (target) => shell.openPath(target),
    openUrl: (url) => shell.openExternal(url),
    resolvePath: (target) => settingsService.resolveWorkingPath(target),
    trashItem: (target) => shell.trashItem(target),
  });
  registerPlanTool(toolRegistry);
  registerBrowserTools(toolRegistry, managedBrowser, artifactStore, (target) =>
    settingsService.resolveWorkingPath(target),
  );
  if (process.platform === "darwin") {
    registerComputerTools(
      toolRegistry,
      new MacOsComputerAdapter(),
      screenCapture,
      artifactStore,
    );
  }
  await mcpService.initialize();
  unregisterExtensionIpc = registerExtensionIpc(mcpService, skillService);

  const territoryRepository = new TerritoryRepository(applicationDatabase);
  const territoryAssets = new TerritoryAssetStore(
    path.join(userDataPath, "territory", "assets"),
    new ElectronTerritoryImageNormalizer(),
  );
  const territoryCandidates = new TerritoryCandidateStore(
    path.join(userDataPath, "territory", "candidates"),
    new ElectronTerritoryCandidateProcessor(),
  );
  const territoryService = new TerritoryService(
    territoryRepository,
    territoryAssets,
    clock,
  );
  const territoryImageService = new TerritoryImageService(
    territoryRepository,
    territoryCandidates,
    territoryService,
    providerService,
    idGenerator,
    clock,
  );
  territoryImageService.recoverInterruptedCandidates();
  registerTerritoryTools(toolRegistry, {
    images: territoryImageService,
    providers: providerService,
    territory: territoryService,
  });
  unregisterTerritoryProtocol = registerTerritoryProtocol(
    territoryRepository,
    territoryAssets,
    territoryCandidates,
  );
  unregisterTerritoryIpc = registerTerritoryIpc(
    territoryService,
    territoryImageService,
  );

  const writer = new RunEventWriter(
    runRepository,
    runEventService,
    idGenerator,
    clock,
  );
  const imageInput = new ElectronImageInputProvider(async (source) => {
    if (path.isAbsolute(source)) return path.resolve(source);
    try {
      const artifactPath = artifactStore.resolvePath(source);
      await access(artifactPath);
      return artifactPath;
    } catch {
      return settingsService.resolveWorkingPath(source);
    }
  });
  const chatTitleService = new ChatTitleService(chatService, logger);
  agentRuntime = new AgentRuntime(
    chatRepository,
    chatService,
    runRepository,
    checkpointRepository,
    writer,
    toolRegistry,
    providerService,
    idGenerator,
    clock,
    undefined,
    () => skillService.instructions(),
    chatTitleService,
    imageInput,
    memoryServiceInstance,
  );
  const automationServiceInstance = new AutomationService(
    new AutomationRepository(applicationDatabase),
    chatService,
    {
      getRun: (runId) => runRepository.getRun(runId),
      listChatRuns: (chatId) => runRepository.getSnapshot(chatId).runs,
      readCompletedAssistantMessage: (runId) =>
        chatRepository
          .listRunMessages(runId)
          .findLast(
            ({ role, status }) =>
              role === "assistant" && status === "completed",
          )?.content,
    },
    agentRuntime,
    idGenerator,
    clock,
    {
      publish(envelope) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.webContents.isDestroyed()) continue;
          try {
            window.webContents.send(AUTOMATION_CHANNELS.subscribe, envelope);
          } catch (error) {
            logger.warn("AUTOMATION_EVENT_BROADCAST_ERROR", {
              automationEventId: envelope.eventId,
              error,
            });
          }
        }
      },
    },
  );
  automationServiceReference.current = automationServiceInstance;
  await agentRuntime.initialize();

  const petLibrary = new PetLibraryRepository(path.join(userDataPath, "pets"));
  await installBundledPets(
    petLibrary,
    bundledPetsDirectory({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    logger,
  );
  const petService = new PetService(
    petLibrary,
    new PetStateRepository(applicationDatabase),
    clock,
  );
  await petService.initialize();
  voiceService = new VoiceService(
    new VoiceRepository(applicationDatabase),
    settingsRepository,
    providerService,
    new AzureWebRtcSessionIssuer(),
    toolRegistry,
    runRepository,
    writer,
    chatService,
    chatRepository,
    idGenerator,
    clock,
    {
      command(command) {
        const value = parseSchema(VoiceClientCommandSchema, command);
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) {
            window.webContents.send(VOICE_CHANNELS.command, value);
          }
        }
      },
      snapshot(voiceSnapshot) {
        const value =
          voiceSnapshot === null
            ? null
            : parseSchema(VoiceSessionSnapshotSchema, voiceSnapshot);
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) {
            window.webContents.send(VOICE_CHANNELS.changed, value);
          }
        }
      },
    },
    () => skillService.instructions(),
    chatTitleService,
    memoryServiceInstance,
    (phase) => {
      petService.setRuntimeAnimation(
        phase === "failed" || phase === "interrupted"
          ? "failed"
          : phase === "thinking" || phase === "waiting_approval"
            ? "waiting"
            : phase === "using_tool"
              ? "running"
              : phase === "speaking"
                ? "waving"
                : phase === "listening"
                  ? "review"
                  : "idle",
      );
    },
    voiceMetrics,
  );
  registerVoiceTools(toolRegistry, {
    requestEndAfterResponse: (runId) => {
      const runtime = voiceService;
      if (!runtime) throw new Error("Voice runtime is unavailable");
      runtime.requestEndAfterResponse(runId);
    },
  });
  voiceService.initialize();
  const voiceRuntime = voiceService;
  unregisterAgentIpc = registerAgentIpc({
    cancel: (request) => {
      const run = runRepository.getRun(request.runId);
      return run?.source === "voice"
        ? voiceRuntime.cancelRun(request)
        : agentRuntime!.cancel(request);
    },
    getPendingApproval: () => runRepository.getLatestPendingApproval() ?? null,
    resolveApproval: (request) => {
      const approval = runRepository.getApproval(request.approvalId);
      const run = approval ? runRepository.getRun(approval.runId) : undefined;
      return run?.source === "voice"
        ? voiceRuntime.resolveApproval(request)
        : agentRuntime!.resolveApproval(request);
    },
    resolveUserInput: (request) => agentRuntime!.resolveUserInput(request),
    resume: (request) => agentRuntime!.resume(request),
    start: (request) => agentRuntime!.start(request),
    steer: (request) => agentRuntime!.steer(request),
  });
  await automationServiceInstance.initialize();
  automationScheduler = new AutomationScheduler(
    automationServiceInstance,
    clock,
    powerMonitor,
    (error) => logger.warn("AUTOMATION_SCHEDULER_ERROR", { error }),
  );
  automationServiceInstance.setScheduleChangedListener(() =>
    automationScheduler?.refresh(),
  );
  unregisterAutomationIpc = registerAutomationIpc(automationServiceInstance);
  automationScheduler.start();
  unregisterPetProtocol = registerPetProtocol(petLibrary);

  const mainWindows = new MainWindowController(
    () => createMainWindow(windowPlacementRepository, clock, !backgroundTest),
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
    {
      reveal: !backgroundTest,
      shouldKeepAliveOnClose: () => {
        const phase = voiceService?.getActive()?.phase;
        return Boolean(phase && phase !== "failed" && phase !== "interrupted");
      },
    },
  );
  mainWindowController = mainWindows;
  unregisterSettingsIpc = registerSettingsIpc(settingsService, () =>
    mainWindows.getWindow(),
  );
  unregisterVoiceIpc = registerVoiceIpc(
    voiceService,
    () => mainWindows.getWindow(),
    () => characterWindowController?.getWindow() ?? null,
  );

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
    !backgroundTest,
  );
  unregisterPetIpc = registerPetIpc(
    petService,
    characterWindowController,
    () => mainWindows.getWindow(),
    () => resolveCharacterRendererReady?.(),
    (approvalId) => {
      const runtime = agentRuntime;
      if (!runtime) return;
      void (async () => {
        const target = parseSchema(
          ApprovalNavigationTargetSchema,
          runtime.getApprovalNavigation(approvalId),
        );
        const window = await mainWindows.open("chat");
        window.webContents.send(AGENT_CHANNELS.openApproval, target);
      })().catch((error: unknown) => {
        logger.warn("APPROVAL_NAVIGATION_ERROR", {
          approvalId,
          error,
        });
      });
    },
  );
  await mainWindows.open();
  await characterWindowController.create();
  if (process.env["CHARAMATE_SMOKE_TEST"] === "1") {
    console.error("CHARAMATE_MAIN_STAGE window-loaded");
    await Promise.all([rendererReady, characterRendererReady]);
    const browser = managedBrowser;
    if (!browser) throw new Error("Managed Browser was not initialized");
    await browser.open();
    await browser.close();
    const petIds = (await petService.getLibrary()).pets.map(({ id }) => id);
    const providerProfileNames =
      providerService?.listProfiles().map(({ name }) => name) ?? [];
    console.log(
      `CHARAMATE_SMOKE_RESULT ${JSON.stringify({
        backgroundTest,
        browserRoundTrip: true,
        characterRendererReady: true,
        databaseRoundTrip,
        dockVisible:
          process.platform === "darwin"
            ? (app.dock?.isVisible() ?? null)
            : null,
        mode: process.env["CHARAMATE_SMOKE_KIND"],
        petIds,
        providerProfileNames,
        rendererReady: true,
        visibleWindowCount: BrowserWindow.getAllWindows().filter((window) =>
          window.isVisible(),
        ).length,
      })}`,
    );
    app.quit();
  }
}

void app
  .whenReady()
  .then(startApplication)
  .catch(async (error: unknown) => {
    logger.error(
      "CHARAMATE_STARTUP_ERROR",
      error instanceof Error ? error : { error },
    );
    await stopApplicationInfrastructure();
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

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  void stopApplicationInfrastructure().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
