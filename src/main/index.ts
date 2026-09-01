import path from "node:path";
import { access } from "node:fs/promises";

import {
  app,
  BrowserWindow,
  powerMonitor,
  session,
  shell,
  systemPreferences,
} from "electron";
import type Database from "better-sqlite3";

import type { FoundationSnapshot } from "../shared/contracts/foundation";
import { AGENT_CHANNELS } from "../shared/contracts/agent";
import { AUTOMATION_CHANNELS } from "../shared/contracts/automation";
import { CHAT_EVENT_CHANNELS } from "../shared/contracts/chat";
import { COMPANION_DESKTOP_CHANNELS } from "../shared/contracts/companion";
import { EVOLUTION_CHANNELS } from "../shared/contracts/evolution";
import { RUN_EVENT_CHANNELS } from "../shared/contracts/ipc";
import { JOURNEY_CHANNELS } from "../shared/contracts/journey";
import { PET_CHANNELS } from "../shared/contracts/pet";
import { PERSONA_CHANNELS } from "../shared/contracts/persona";
import { TERRITORY_WORLD_CHANNELS } from "../shared/contracts/territoryWorld";
import { VOICE_CHANNELS } from "../shared/contracts/voice";
import { VOICE_WAKE_CHANNELS } from "../shared/contracts/voiceWake";
import { SystemClock } from "../shared/pure/clock";
import { CryptoIdGenerator } from "../shared/pure/id";
import {
  PetConversationNavigationSchema,
  PetMainNavigationSchema,
  ProactiveConversationBubbleReplyResponseSchema,
} from "../shared/schemas/pet";
import { ApprovalNavigationTargetSchema } from "../shared/schemas/agent";
import { PersonaLibrarySnapshotSchema } from "../shared/schemas/persona";
import { CompanionDesktopSnapshotSchema } from "../shared/schemas/companion";
import { parseSchema } from "../shared/schemas/validation";
import {
  VoiceClientCommandSchema,
  VoiceSessionSnapshotSchema,
} from "../shared/schemas/voice";
import { registerAgentIpc } from "./agent/agentIpc";
import { AgentRuntime } from "./agent/agentRuntime";
import { toAgentAppError } from "./agent/agentError";
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
import { initializeSingleInstance } from "./app/singleInstance";
import { TrayController } from "./app/trayController";
import { WindowPlacementRepository } from "./app/windowPlacementRepository";
import { createMainWindow } from "./app/windows";
import { registerSettingsIpc } from "./app/settingsIpc";
import { SettingsRepository } from "./app/settingsRepository";
import { SettingsService } from "./app/settingsService";
import { MacOsActiveApplicationSource } from "./activity/activeApplicationSource";
import { ActivityAssetStore } from "./activity/activityAssetStore";
import { ActivityCaptureCoordinator } from "./activity/activityCaptureCoordinator";
import { registerActivityIpc } from "./activity/activityIpc";
import { registerActivityProtocol } from "./activity/activityProtocol";
import { ActivityRepository } from "./activity/activityRepository";
import { ActivityService } from "./activity/activityService";
import { ElectronActivitySystemSource } from "./activity/activitySystemSource";
import { registerActivityTool } from "./activity/activityTool";
import { ChatRepository } from "./chat/chatRepository";
import { ChatService } from "./chat/chatService";
import { ChatTitleService } from "./chat/chatTitleService";
import { CompanionBridgeRepository } from "./companion/companionBridgeRepository";
import { CompanionBridgeService } from "./companion/companionBridgeService";
import {
  CompanionError,
  toCompanionAppError,
} from "./companion/companionError";
import { registerCompanionIpc } from "./companion/companionIpc";
import { CompanionMailboxProcessor } from "./companion/companionMailboxProcessor";
import { CompanionMessageProjectionService } from "./companion/companionMessageProjectionService";
import { HttpsCompanionRelayClient } from "./companion/companionRelayClient";
import { CompanionShareIngress } from "./companion/companionShareIngress";
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
import { ProductMetrics } from "./observability/productMetrics";
import { registerExtensionIpc } from "./extensions/extensionIpc";
import { McpRepository } from "./extensions/mcpRepository";
import { McpService } from "./extensions/mcpService";
import { SkillRepository } from "./extensions/skillRepository";
import { SkillService } from "./extensions/skillService";
import { registerEvolutionIpc } from "./evolution/evolutionIpc";
import { EvolutionRepository } from "./evolution/evolutionRepository";
import { ModelEvolutionReviewer } from "./evolution/evolutionReviewer";
import { EvolutionService } from "./evolution/evolutionService";
import { LexicalRetrievalPipeline } from "./memory/lexicalRetrievalPipeline";
import { registerMemoryIpc } from "./memory/memoryIpc";
import { MemoryRepository } from "./memory/memoryRepository";
import { MemoryService } from "./memory/memoryService";
import {
  memoryContextQueryTargetIds,
  memoryContextTargetIds,
} from "./agent/memoryContext";
import {
  registerMemoryFormationTool,
  registerMemoryTool,
} from "./memory/memoryTool";
import { registerCompanionshipTool } from "./journey/companionshipTool";
import {
  CompanionInitiativeService,
  ModelCompanionInitiativeDecider,
} from "./journey/companionInitiative";
import { CompanionInitiativeRepository } from "./journey/companionInitiativeRepository";
import { stepDownCompanionInitiativeLevel } from "./journey/companionInitiativePolicy";
import { registerJourneyIpc } from "./journey/journeyIpc";
import { JourneyRepository } from "./journey/journeyRepository";
import { JourneyService } from "./journey/journeyService";
import { ProactiveConversationSurface } from "./journey/proactiveConversationSurface";
import { registerImportantMomentOutreachTool } from "./journey/importantMomentOutreachTool";
import { ProactiveOpportunityRepository } from "./journey/proactiveOpportunityRepository";
import {
  ModelProactiveOpportunityDecider,
  ProactiveOpportunityService,
} from "./journey/proactiveOpportunityService";
import { CharacterWindowController } from "./pet/characterWindowController";
import { bundledPetsDirectory, installBundledPets } from "./pet/bundledPets";
import { registerPetIpc } from "./pet/petIpc";
import { PetLibraryRepository } from "./pet/petLibraryRepository";
import { registerPetProtocol } from "./pet/petProtocol";
import { PetService } from "./pet/petService";
import { PetStateRepository } from "./pet/petStateRepository";
import { CharacterContextCompiler } from "./persona/characterContext";
import { registerPersonaIpc } from "./persona/personaIpc";
import { PersonaRepository } from "./persona/personaRepository";
import { PersonaService } from "./persona/personaService";
import { ElectronSafeStorageEncryption } from "./providers/electronSecretEncryption";
import { registerProviderIpc } from "./providers/providerIpc";
import { ProviderRepository } from "./providers/providerRepository";
import { ProviderService } from "./providers/providerService";
import { SafeStorageSecretStore } from "./providers/secretStore";
import { registerPlanTool } from "./agent/planTool";
import { registerCollaborationTool } from "./agent/collaborationTool";
import { ArtifactStore } from "./tools/artifactStore";
import { registerLocalTools } from "./tools/localTools";
import { ToolRegistry } from "./tools/toolRegistry";
import { registerTerritoryProtocol } from "./territory/territoryProtocol";
import { registerTerritoryTools } from "./territory/territoryTools";
import { createStarterTerritoryWorldSeed } from "./territory/territoryStarterWorld";
import { registerTerritoryWorldIpc } from "./territory/territoryWorldIpc";
import { TerritoryWorldMemoryService } from "./territory/territoryWorldMemoryService";
import { TerritoryWorldRepository } from "./territory/territoryWorldRepository";
import { TerritoryWorldService } from "./territory/territoryWorldService";
import { TerritoryWorldAssetStore } from "./territory/territoryWorldAssetStore";
import { ElectronTerritoryWorldImageNormalizer } from "./territory/electronTerritoryWorldImageNormalizer";
import { TerritoryWorldCandidateService } from "./territory/territoryWorldCandidateService";
import { AzureWebRtcSessionIssuer } from "./voice/azureWebRtcSession";
import { registerVoiceIpc } from "./voice/voiceIpc";
import { VoiceRepository } from "./voice/voiceRepository";
import { VoiceService } from "./voice/voiceService";
import { registerVoiceTools } from "./voice/voiceTool";
import { VoiceMetrics } from "./voice/voiceMetrics";
import { registerVoiceWakeIpc } from "./voice/voiceWakeIpc";
import { VoiceWakeService } from "./voice/voiceWakeService";

const logger = createAppLogger();
const backgroundTest = process.env["CHARAMATE_TEST_BACKGROUND"] === "1";

registerApplicationSchemes();
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const userDataOverride = process.env["CHARAMATE_USER_DATA_DIR"];
if (process.env["CHARAMATE_SMOKE_TEST"] === "1") {
  console.error("CHARAMATE_MAIN_STAGE module-loaded");
}
if (userDataOverride) {
  app.setPath("userData", path.resolve(userDataOverride));
}

const primaryInstance = initializeSingleInstance(app, () =>
  openMainWindow("chat"),
);

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

function readMicrophonePermission() {
  if (process.platform !== "darwin") return "unavailable" as const;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "not-determined") return "not_determined" as const;
  return status === "unknown" ? ("unavailable" as const) : status;
}

let mainWindowController: MainWindowController | undefined;
let applicationDatabase: Database.Database | undefined;
let unregisterChatIpc: (() => void) | undefined;
let unregisterCompanionIpc: (() => void) | undefined;
let unregisterCompanionPowerEvents: (() => void) | undefined;
let unregisterActivityIpc: (() => void) | undefined;
let unregisterActivityProtocol: (() => void) | undefined;
let unregisterAgentIpc: (() => void) | undefined;
let unregisterAutomationIpc: (() => void) | undefined;
let unregisterExtensionIpc: (() => void) | undefined;
let unregisterEvolutionIpc: (() => void) | undefined;
let unregisterFoundationIpc: (() => void) | undefined;
let unregisterJourneyIpc: (() => void) | undefined;
let unregisterMemoryIpc: (() => void) | undefined;
let unregisterPersonaIpc: (() => void) | undefined;
let unregisterProviderIpc: (() => void) | undefined;
let unregisterSettingsIpc: (() => void) | undefined;
let unregisterPetIpc: (() => void) | undefined;
let unregisterPetProtocol: (() => void) | undefined;
let unregisterTerritoryWorldIpc: (() => void) | undefined;
let unregisterTerritoryProtocol: (() => void) | undefined;
let unregisterVoiceIpc: (() => void) | undefined;
let unregisterVoiceWakeIpc: (() => void) | undefined;
let providerService: ProviderService | undefined;
let characterWindowController: CharacterWindowController | undefined;
let trayController: TrayController | undefined;
let agentRuntime: AgentRuntime | undefined;
let evolutionService: EvolutionService | undefined;
let automationScheduler: AutomationScheduler | undefined;
let activityCapture: ActivityCaptureCoordinator | undefined;
let activityService: ActivityService | undefined;
let managedBrowser: ManagedBrowser | undefined;
let mcpService: McpService | undefined;
let devDashboard: DevDashboard | undefined;
let voiceService: VoiceService | undefined;
let voiceWakeService: VoiceWakeService | undefined;
let journeyService: JourneyService | undefined;
let companionInitiativeService: CompanionInitiativeService | undefined;
let proactiveOpportunityService: ProactiveOpportunityService | undefined;
let proactiveConversationSurface: ProactiveConversationSurface | undefined;
let companionBridgeService: CompanionBridgeService | undefined;
let companionMailboxProcessor: CompanionMailboxProcessor | undefined;
let companionMessageProjectionService:
  CompanionMessageProjectionService | undefined;
let stopPromise: Promise<void> | undefined;
let shutdownComplete = false;

function openMainWindow(target?: MainWindowTarget): void {
  companionMailboxProcessor?.start();
  companionMessageProjectionService?.start();
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
    trayController?.destroy();
    trayController = undefined;
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
    unregisterEvolutionIpc?.();
    unregisterEvolutionIpc = undefined;
    unregisterChatIpc?.();
    unregisterChatIpc = undefined;
    unregisterCompanionIpc?.();
    unregisterCompanionIpc = undefined;
    unregisterCompanionPowerEvents?.();
    unregisterCompanionPowerEvents = undefined;
    unregisterFoundationIpc?.();
    unregisterFoundationIpc = undefined;
    unregisterJourneyIpc?.();
    unregisterJourneyIpc = undefined;
    unregisterMemoryIpc?.();
    unregisterMemoryIpc = undefined;
    unregisterPersonaIpc?.();
    unregisterPersonaIpc = undefined;
    unregisterProviderIpc?.();
    unregisterProviderIpc = undefined;
    unregisterSettingsIpc?.();
    unregisterSettingsIpc = undefined;
    unregisterPetIpc?.();
    unregisterPetIpc = undefined;
    unregisterPetProtocol?.();
    unregisterPetProtocol = undefined;
    unregisterTerritoryWorldIpc?.();
    unregisterTerritoryWorldIpc = undefined;
    unregisterTerritoryProtocol?.();
    unregisterTerritoryProtocol = undefined;
    unregisterVoiceIpc?.();
    unregisterVoiceIpc = undefined;
    unregisterVoiceWakeIpc?.();
    unregisterVoiceWakeIpc = undefined;
    session.defaultSession.setPermissionCheckHandler(null);
    session.defaultSession.setPermissionRequestHandler(null);
    companionBridgeService?.dispose();
    companionBridgeService = undefined;
    await companionMailboxProcessor?.shutdown();
    companionMailboxProcessor = undefined;
    await companionMessageProjectionService?.shutdown();
    companionMessageProjectionService = undefined;
    proactiveOpportunityService?.shutdown();
    await automationScheduler?.stop();
    automationScheduler = undefined;
    await evolutionService?.shutdown();
    evolutionService = undefined;
    voiceService?.shutdown();
    voiceWakeService?.shutdown();
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
    await companionInitiativeService?.shutdown();
    companionInitiativeService = undefined;
    proactiveOpportunityService = undefined;
    proactiveConversationSurface?.shutdown();
    proactiveConversationSurface = undefined;
    journeyService?.pauseForShutdown();
    await agentRuntime?.interruptAll();
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
    voiceWakeService = undefined;
    journeyService = undefined;
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
  const personaService = new PersonaService(
    new PersonaRepository(applicationDatabase),
    idGenerator,
    clock,
    {
      publish(personaSnapshot) {
        const value = parseSchema(
          PersonaLibrarySnapshotSchema,
          personaSnapshot,
        );
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) {
            window.webContents.send(PERSONA_CHANNELS.changed, value);
          }
        }
        void trayController?.refresh();
      },
    },
  );
  personaService.initialize();
  unregisterPersonaIpc = registerPersonaIpc(personaService);
  const characterContextCompiler = new CharacterContextCompiler();
  const chatRepository = new ChatRepository(applicationDatabase);
  const companionBridgeRepository = new CompanionBridgeRepository(
    applicationDatabase,
  );
  const companionInitiativeRepository = new CompanionInitiativeRepository(
    applicationDatabase,
  );
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
  const companionInitiativeReference: {
    current?: CompanionInitiativeService;
  } = {};
  const proactiveOpportunityReference: {
    current?: ProactiveOpportunityService;
  } = {};
  const companionMessageProjectionReference: {
    current?: CompanionMessageProjectionService;
  } = {};
  memoryServiceInstance.setChangedListener((memoryId) => {
    try {
      proactiveOpportunityReference.current?.handleMemoryChanged(memoryId);
    } catch (error) {
      logger.warn("PROACTIVE_OPPORTUNITY_MEMORY_RECONCILE_ERROR", {
        error,
        memoryId,
      });
    }
  });
  const evolutionServiceReference: { current?: EvolutionService } = {};
  const proactiveConversationSurfaceReference: {
    current?: ProactiveConversationSurface;
  } = {};
  const synchronizeEvolutionSkill = (skillId: string): void => {
    try {
      evolutionServiceReference.current?.synchronizeSkill(skillId);
    } catch (error) {
      logger.warn("EVOLUTION_SKILL_SYNC_ERROR", { error, skillId });
    }
  };
  const detachEvolutionSkill = (skillId: string): void => {
    try {
      evolutionServiceReference.current?.detachDeletedSkill(skillId);
    } catch (error) {
      logger.warn("EVOLUTION_SKILL_DETACH_ERROR", { error, skillId });
    }
  };
  let voiceMetrics: VoiceMetrics | undefined;
  const windowPlacementRepository = new WindowPlacementRepository(
    applicationDatabase,
  );
  const runEventService = new RunEventService(runRepository, {
    publish(envelope) {
      try {
        proactiveConversationSurfaceReference.current?.observeRun(envelope);
      } catch (error) {
        logger.warn("PROACTIVE_CONVERSATION_RUN_OBSERVER_ERROR", {
          error,
          runId: envelope.streamId,
          sequence: envelope.sequence,
        });
      }
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
        companionInitiativeReference.current?.observeRun(envelope);
      } catch (error) {
        logger.warn("COMPANION_INITIATIVE_RUN_OBSERVER_ERROR", {
          error,
          runId: envelope.streamId,
          sequence: envelope.sequence,
        });
      }
      try {
        companionMessageProjectionReference.current?.observeRun(envelope);
      } catch (error) {
        logger.warn("COMPANION_MESSAGE_PROJECTION_RUN_OBSERVER_ERROR", {
          error,
          runId: envelope.streamId,
          sequence: envelope.sequence,
        });
      }
      try {
        proactiveOpportunityReference.current?.observeRun(envelope);
      } catch (error) {
        logger.warn("PROACTIVE_OPPORTUNITY_RUN_OBSERVER_ERROR", {
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
      try {
        evolutionServiceReference.current?.observeRun(envelope);
      } catch (error) {
        logger.warn("EVOLUTION_RUN_OBSERVER_ERROR", {
          error,
          runId: envelope.streamId,
          sequence: envelope.sequence,
        });
      }
      if (
        envelope.event.type === "run.completed" ||
        envelope.event.type === "run.failed" ||
        envelope.event.type === "run.cancelled" ||
        envelope.event.type === "run.interrupted"
      ) {
        companionMailboxProcessor?.start();
        companionMessageProjectionService?.start();
      }
    },
  });
  if (!app.isPackaged && process.env["CHARAMATE_DEV_DASHBOARD"] !== "0") {
    voiceMetrics = new VoiceMetrics();
    devDashboard = new DevDashboard(
      runtimeObservability,
      voiceMetrics,
      new ProductMetrics(applicationDatabase),
    );
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
  chatService.discardAllProvisional();
  unregisterChatIpc = registerChatIpc(chatService, runEventService);
  const journeyServiceInstance = new JourneyService(
    new JourneyRepository(applicationDatabase),
    chatService,
    { getRun: (runId) => runRepository.getRun(runId) },
    idGenerator,
    clock,
    {
      publish(value) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.webContents.isDestroyed()) continue;
          window.webContents.send(JOURNEY_CHANNELS.changed, value);
        }
      },
    },
  );
  journeyService = journeyServiceInstance;
  journeyServiceInstance.initialize();
  unregisterJourneyIpc = registerJourneyIpc(journeyServiceInstance);

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
      const ambiguityMemoryIds =
        run.source === "voice"
          ? [...(voiceService?.getMemoryContextQueryIds(runId) ?? [])]
          : checkpoint
            ? [
                ...new Set(
                  decodeRuntimeCheckpoint(checkpoint.context).input.flatMap(
                    memoryContextQueryTargetIds,
                  ),
                ),
              ]
            : [];
      if (basis === "run_observation") {
        return {
          allowedMemoryIds,
          ambiguityMemoryIds,
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
        ambiguityMemoryIds,
        label:
          evidenceItem.kind === "user_message"
            ? `用户消息 ${evidenceId}`
            : `结构化回答 ${evidenceId}`,
        referenceId: run.chatId,
        sourceType: run.source === "voice" ? "voice" : "chat",
      };
    },
    ({ content, memoryId, runId }) => {
      try {
        journeyServiceInstance.linkMemoryForRun(runId, memoryId, content);
      } catch (error) {
        logger.warn("JOURNEY_MEMORY_PROJECTION_ERROR", {
          error,
          memoryId,
          runId,
        });
      }
    },
  );
  registerCompanionshipTool(toolRegistry, {
    getRun: (runId) => runRepository.getRun(runId),
    journeys: journeyServiceInstance,
  });
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
  voiceWakeService = new VoiceWakeService(
    settingsRepository,
    {
      read: readMicrophonePermission,
      request: () =>
        process.platform === "darwin"
          ? systemPreferences.askForMediaAccess("microphone")
          : Promise.resolve(true),
    },
    clock,
    {
      snapshot(wakeSnapshot) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) {
            window.webContents.send(VOICE_WAKE_CHANNELS.changed, wakeSnapshot);
          }
        }
        void trayController?.refresh();
      },
    },
  );
  voiceWakeService.initialize(powerMonitor);
  const initialAgentSettings = settingsRepository.getAgent();
  const skillService = new SkillService(
    path.join(initialAgentSettings.workingDirectory, ".agents", "skills"),
    path.join(userDataPath, "skills"),
    new SkillRepository(applicationDatabase),
    idGenerator,
    clock,
  );
  await skillService.initialize();
  skillService.registerTools(toolRegistry, synchronizeEvolutionSkill);

  mcpService = new McpService(
    new McpRepository(applicationDatabase),
    secretStore,
    toolRegistry,
    artifactStore,
    idGenerator,
    clock,
  );
  await providerService.initialize(
    new Set([
      ...mcpService.listSecretReferences(),
      ...companionBridgeRepository.listCredentialReferences(),
    ]),
  );
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
  registerActivityTool(toolRegistry, activityService);
  unregisterActivityProtocol = registerActivityProtocol(
    activityRepository,
    activityAssets,
  );
  unregisterActivityIpc = registerActivityIpc(activityService);
  const activitySystemSource = new ElectronActivitySystemSource(60);
  activityCapture = new ActivityCaptureCoordinator(
    activityService,
    new MacOsActiveApplicationSource(
      app.isPackaged
        ? path.join(
            process.resourcesPath,
            "native-helpers",
            "active-application-observer.node",
          )
        : path.join(
            app.getAppPath(),
            "resources",
            "generated",
            "native-helpers",
            "active-application-observer.node",
          ),
    ),
    activitySystemSource,
    clock,
    logger,
    {
      observeForeground(observation) {
        companionInitiativeReference.current?.observeForeground(observation);
      },
    },
  );
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
        return readMicrophonePermission();
      },
    },
    clock,
    (directory) => skillService.setWorkspaceDirectory(directory),
    userDataPath,
    (target) => shell.openPath(target),
    (current, previous) => {
      try {
        if (
          current.importantMomentOutreachEnabled !==
          previous.importantMomentOutreachEnabled
        ) {
          proactiveOpportunityReference.current?.handlePermissionChanged(
            current.importantMomentOutreachEnabled,
          );
        } else {
          automationScheduler?.refresh();
        }
      } catch (error) {
        logger.warn("COMPANION_INITIATIVE_RECONCILE_ERROR", { error });
      }
    },
  );
  registerImportantMomentOutreachTool(toolRegistry, settingsService);
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
  unregisterExtensionIpc = registerExtensionIpc(
    mcpService,
    skillService,
    synchronizeEvolutionSkill,
    detachEvolutionSkill,
  );

  const territoryWorldRepository = new TerritoryWorldRepository(
    applicationDatabase,
    idGenerator,
  );
  territoryWorldRepository.ensureInitialized(
    createStarterTerritoryWorldSeed(clock.now()),
  );
  territoryWorldRepository.ensurePoeticDescriptions(clock.now());
  const territoryWorldAssets = new TerritoryWorldAssetStore(
    path.join(userDataPath, "territory", "world-assets"),
    new ElectronTerritoryWorldImageNormalizer(),
  );
  const territoryWorldCandidates = new TerritoryWorldCandidateService(
    territoryWorldRepository,
    territoryWorldAssets,
    providerService,
    idGenerator,
    clock,
    (snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(
            TERRITORY_WORLD_CHANNELS.snapshotChanged,
            snapshot,
          );
        }
      }
    },
  );
  territoryWorldCandidates.recoverInterruptedCandidates();
  const territoryWorldService = new TerritoryWorldService(
    territoryWorldRepository,
    clock,
    territoryWorldCandidates,
    territoryWorldAssets,
    (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(
            TERRITORY_WORLD_CHANNELS.petActionPerformed,
            event,
          );
        }
      }
    },
  );
  const territoryWorldMemoryService = new TerritoryWorldMemoryService(
    territoryWorldRepository,
    memoryServiceInstance,
    activityService,
    clock,
    territoryWorldCandidates,
  );
  const collaborationProviderService = providerService;
  registerCollaborationTool(toolRegistry, {
    createChatModelRuntime: (profileId, modelId) =>
      collaborationProviderService.createChatModelRuntime(profileId, modelId),
    getRun: (runId) => runRepository.getRun(runId),
  });
  unregisterTerritoryProtocol = registerTerritoryProtocol(
    territoryWorldRepository,
    territoryWorldAssets,
  );
  unregisterTerritoryWorldIpc = registerTerritoryWorldIpc(
    territoryWorldService,
    territoryWorldMemoryService,
  );
  registerTerritoryTools(toolRegistry, {
    candidates: territoryWorldCandidates,
    territory: territoryWorldService,
  });

  const writer = new RunEventWriter(
    runRepository,
    runEventService,
    idGenerator,
    clock,
  );
  const evolutionReviewer = new ModelEvolutionReviewer(
    providerService,
    idGenerator,
  );
  evolutionService = new EvolutionService(
    new EvolutionRepository(applicationDatabase),
    runRepository,
    chatRepository,
    skillService,
    memoryServiceInstance,
    evolutionReviewer,
    evolutionReviewer,
    idGenerator,
    clock,
    logger,
    {
      publish(event) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.webContents.isDestroyed()) continue;
          try {
            window.webContents.send(EVOLUTION_CHANNELS.changed, event);
          } catch (error) {
            logger.warn("EVOLUTION_EVENT_BROADCAST_ERROR", { error });
          }
        }
      },
    },
  );
  evolutionServiceReference.current = evolutionService;
  unregisterEvolutionIpc = registerEvolutionIpc(evolutionService);
  evolutionService.initialize();
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
    personaService,
    undefined,
    (run) => {
      const initiative = settingsRepository.getCompanionInitiative();
      const outreachState = initiative.importantMomentOutreachEnabled
        ? "enabled"
        : initiative.importantMomentOutreachPrompted
          ? "declined"
          : "not_asked";
      return [
        skillService.instructions(),
        `Important-moment outreach setting: ${outreachState}.`,
        journeyServiceInstance.agentContextInstructions(run.chatId),
      ]
        .filter(Boolean)
        .join("\n\n");
    },
    chatTitleService,
    imageInput,
    memoryServiceInstance,
  );
  const proactiveConversationSurfaceInstance = new ProactiveConversationSurface(
    {
      discardProvisional: (chatId) => chatService.discardProvisional(chatId),
      establishProvisional: (chatId) => {
        chatService.establishProvisional(chatId);
      },
      getStatus: (chatId) => chatRepository.getChat(chatId)?.status,
      restore: (chatId) => {
        chatService.restore({ chatId });
      },
    },
    agentRuntime,
    providerService,
    {
      getRun: (runId) => runRepository.getRun(runId),
      readCompletedAssistantMessage: (runId) =>
        chatRepository
          .listRunMessages(runId)
          .findLast(
            ({ role, status }) =>
              role === "assistant" && status === "completed",
          )?.content,
    },
    {
      clear: (bubbleId) => {
        characterWindowController?.clearProactiveBubble(bubbleId);
      },
      show: (bubble) => {
        characterWindowController?.showProactiveBubble(bubble);
      },
    },
    {
      recordOutcome: (bubbleId, outcome) => {
        try {
          companionInitiativeRepository.updateOutcome(
            bubbleId,
            outcome,
            clock.now(),
          );
        } catch (error) {
          logger.warn("COMPANION_INITIATIVE_OUTCOME_WRITE_ERROR", {
            bubbleId,
            error,
            outcome,
          });
        }
      },
    },
  );
  proactiveConversationSurfaceReference.current =
    proactiveConversationSurfaceInstance;
  proactiveConversationSurface = proactiveConversationSurfaceInstance;
  const companionInitiativeServiceInstance = new CompanionInitiativeService(
    new ModelCompanionInitiativeDecider(providerService),
    journeyServiceInstance,
    chatService,
    agentRuntime,
    {
      readCompletedAssistantMessage: (runId) =>
        chatRepository
          .listRunMessages(runId)
          .findLast(
            ({ role, status }) =>
              role === "assistant" && status === "completed",
          )?.content,
    },
    {
      hasOutstandingBubble: () =>
        proactiveConversationSurfaceInstance.hasOutstandingBubble(),
      publishBubble: (bubble) =>
        proactiveConversationSurfaceInstance.publish(bubble),
    },
    companionInitiativeRepository,
    settingsRepository,
    clock,
    logger,
    personaService,
    () => personaService.getActiveSnapshot().displayName,
    () => proactiveOpportunityReference.current?.isBusy() ?? false,
  );
  companionInitiativeService = companionInitiativeServiceInstance;
  const proactiveOpportunityServiceInstance = new ProactiveOpportunityService(
    new ProactiveOpportunityRepository(applicationDatabase),
    memoryServiceInstance,
    {
      getChat: (chatId) => chatRepository.getChat(chatId),
      listMessages: (chatId) => chatRepository.listMessages(chatId),
    },
    {
      getRun: (runId) => runRepository.getRun(runId),
      readCompletedAssistantMessage: (runId) => {
        const message = chatRepository
          .listRunMessages(runId)
          .findLast(
            ({ role, status }) =>
              role === "assistant" && status === "completed",
          );
        return message
          ? { content: message.content, id: message.id }
          : undefined;
      },
    },
    new ModelProactiveOpportunityDecider(providerService),
    agentRuntime,
    {
      hasOutstandingBubble: () =>
        proactiveConversationSurfaceInstance.hasOutstandingBubble(),
      projectMessage: (bubble) => {
        const projector = companionMessageProjectionReference.current;
        if (!bubble.messageId || !projector) {
          return proactiveConversationSurfaceInstance.publish(bubble);
        }
        const selection = projector.selectImportantMoment(
          bubble.messageId,
          activitySystemSource.isIdle(),
        );
        if (selection.surface === "android_notification") {
          return selection.acceptedBySelectedSurface;
        }
        if (!selection.shouldProjectDesktop) {
          return selection.acceptedBySelectedSurface;
        }
        const shown = proactiveConversationSurfaceInstance.publish(bubble);
        if (shown) projector.markDesktopProjected(bubble.messageId);
        else {
          projector.markDesktopFailed(
            bubble.messageId,
            "Desktop proactive bubble was unavailable.",
          );
        }
        return shown;
      },
    },
    companionInitiativeRepository,
    settingsRepository,
    {
      hasActiveSession: () =>
        Boolean(journeyServiceInstance.getSnapshot().activeSession),
    },
    personaService,
    idGenerator,
    clock,
    logger,
    () => companionInitiativeServiceInstance.isBusy(),
    (excludeRunId) =>
      runRepository
        .listRunsByStatus([
          "queued",
          "running",
          "waiting_approval",
          "needs_input",
        ])
        .some(({ id }) => id !== excludeRunId),
    () => activitySystemSource.isIdle(),
  );
  proactiveOpportunityReference.current = proactiveOpportunityServiceInstance;
  proactiveOpportunityService = proactiveOpportunityServiceInstance;
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
        try {
          const bubble = journeyServiceInstance.observeAutomation(
            envelope.event,
          );
          if (bubble) {
            proactiveConversationSurfaceInstance.publish(bubble, {
              replace: true,
            });
          }
        } catch (error) {
          logger.warn("JOURNEY_AUTOMATION_PROJECTION_ERROR", {
            automationEventId: envelope.eventId,
            error,
          });
        }
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
    personaService,
  );
  automationServiceReference.current = automationServiceInstance;
  journeyServiceInstance.setFollowUpScheduler({
    cancel(automationId) {
      try {
        const { automation } = automationServiceInstance.get({ automationId });
        if (automation.state !== "active") return;
        automationServiceInstance.setPaused({
          automationId,
          expectedRevision: automation.revision,
          paused: true,
          requestedAt: clock.now(),
        });
      } catch (error) {
        logger.warn("JOURNEY_FOLLOW_UP_CANCEL_ERROR", {
          automationId,
          error,
        });
      }
    },
    schedule({ journey, message, run, runAt }) {
      const automation = automationServiceInstance.create({
        definition: {
          name: `约好再聊：${journey.title}`,
          schedule: { kind: "once", runAt },
          task: {
            delivery: "assistant_message",
            execution: { mode: "chat" },
            goal: [
              "This is a one-time Journey follow-up that the user explicitly agreed to.",
              "Send the agreed check-in below as your complete conversational response.",
              "Do not mention scheduling, call tools, or start/resume a Together Session.",
              JSON.stringify(message),
            ].join("\n"),
            kind: "agent_task",
            modelId: run.provider.modelId,
            personaId: run.persona.personaId,
            providerProfileId: run.provider.profileId,
            targetChatId: journey.homeChatId,
            toolScope: { mode: "selected", toolNames: [] },
          },
        },
        requestedAt: clock.now(),
      });
      return automation.id;
    },
  });
  const companionRelayOrigin = process.env["CHARAMATE_COMPANION_RELAY_ORIGIN"];
  const companionRelay = new HttpsCompanionRelayClient({
    ...(companionRelayOrigin ? { pairingOrigin: companionRelayOrigin } : {}),
  });
  const companionBridgeServiceReference: {
    current?: CompanionBridgeService;
  } = {};
  const companionMessageProjectionServiceInstance =
    new CompanionMessageProjectionService({
      bridge: companionBridgeRepository,
      chats: chatRepository,
      clock,
      idGenerator,
      onBackgroundError(error) {
        logger.warn("COMPANION_MESSAGE_PROJECTION_ERROR", { error });
      },
      onStatusChange(deviceId, status) {
        try {
          companionBridgeServiceReference.current?.updateDeviceStatus(
            deviceId,
            status,
          );
        } catch (error) {
          const mapped = toCompanionAppError(error);
          logger.warn("COMPANION_STATUS_UPDATE_ERROR", {
            code: mapped.code,
            retryable: mapped.retryable,
          });
        }
      },
      relay: companionRelay,
      runs: runRepository,
      secretStore,
    });
  companionMessageProjectionReference.current =
    companionMessageProjectionServiceInstance;
  companionMessageProjectionService = companionMessageProjectionServiceInstance;
  const companionShareIngress = new CompanionShareIngress({
    agent: agentRuntime,
    artifacts: artifactStore,
    bridge: companionBridgeRepository,
    chatRepository,
    chats: chatService,
    clock,
    providers: providerService,
    readRelayAsset: async (asset, signal) => {
      const paired = companionBridgeRepository.getPairedDevice();
      if (!paired) {
        throw new CompanionError(
          "COMPANION.NOT_PAIRED",
          "当前没有已配对的 Android 手机。",
          false,
        );
      }
      return companionRelay.readAsset({
        asset,
        credential: await secretStore.get(paired.credentialRef),
        relayOrigin: paired.relayOrigin,
        ...(signal ? { signal } : {}),
      });
    },
    runs: runRepository,
  });
  const companionMailboxProcessorInstance = new CompanionMailboxProcessor({
    bridge: companionBridgeRepository,
    clock,
    ingress: companionShareIngress,
    onStatusChange(deviceId, status) {
      try {
        companionBridgeServiceReference.current?.updateDeviceStatus(
          deviceId,
          status,
        );
      } catch (error) {
        const mapped = toCompanionAppError(error);
        logger.warn("COMPANION_STATUS_UPDATE_ERROR", {
          code: mapped.code,
          retryable: mapped.retryable,
        });
      }
    },
    relay: companionRelay,
    secretStore,
  });
  const companionBridgeServiceInstance = new CompanionBridgeService({
    clock,
    hooks: {
      beforeUnpair: () =>
        Promise.all([
          companionMailboxProcessorInstance.pause(),
          companionMessageProjectionServiceInstance.pause(),
        ]).then(() => undefined),
      onBackgroundError(error) {
        const mapped = toCompanionAppError(error);
        logger.warn("COMPANION_BACKGROUND_ERROR", {
          code: mapped.code,
          retryable: mapped.retryable,
        });
      },
      onPaired: () => {
        companionMailboxProcessorInstance.reset();
        companionMessageProjectionServiceInstance.reset();
      },
      onUnpairFailed: () => {
        companionMailboxProcessorInstance.resume();
        companionMessageProjectionServiceInstance.resume();
      },
      onUnpaired: () =>
        Promise.all([
          companionMailboxProcessorInstance.stop(),
          companionMessageProjectionServiceInstance.pause(),
        ]).then(() => undefined),
    },
    publisher: {
      publish(companionSnapshot) {
        const value = parseSchema(
          CompanionDesktopSnapshotSchema,
          companionSnapshot,
        );
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.webContents.isDestroyed()) continue;
          try {
            window.webContents.send(COMPANION_DESKTOP_CHANNELS.changed, value);
          } catch (error) {
            logger.warn("COMPANION_SNAPSHOT_BROADCAST_ERROR", {
              error: error instanceof Error ? error.message : "unknown",
            });
          }
        }
      },
    },
    relay: companionRelay,
    repository: companionBridgeRepository,
    secrets: secretStore,
  });
  companionBridgeServiceReference.current = companionBridgeServiceInstance;
  companionBridgeService = companionBridgeServiceInstance;
  companionMailboxProcessor = companionMailboxProcessorInstance;
  unregisterCompanionIpc = registerCompanionIpc(companionBridgeServiceInstance);
  const wakeCompanionWork = () => {
    companionMailboxProcessor?.wake();
    companionMessageProjectionService?.wake();
  };
  const startCompanionWork = () => {
    companionMailboxProcessor?.start();
    companionMessageProjectionService?.start();
  };
  powerMonitor.on("resume", wakeCompanionWork);
  powerMonitor.on("unlock-screen", wakeCompanionWork);
  powerMonitor.on("user-did-become-active", startCompanionWork);
  unregisterCompanionPowerEvents = () => {
    powerMonitor.off("resume", wakeCompanionWork);
    powerMonitor.off("unlock-screen", wakeCompanionWork);
    powerMonitor.off("user-did-become-active", startCompanionWork);
  };
  await agentRuntime.initialize();
  companionMailboxProcessorInstance.start();
  companionMessageProjectionServiceInstance.start();
  proactiveOpportunityServiceInstance.initialize();
  companionInitiativeReference.current = companionInitiativeServiceInstance;

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
        voiceWakeService?.setVoiceActive(
          Boolean(
            value &&
            value.phase !== "paused" &&
            value.phase !== "failed" &&
            value.phase !== "interrupted",
          ),
        );
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) {
            window.webContents.send(VOICE_CHANNELS.changed, value);
          }
        }
        void trayController?.refresh();
      },
    },
    personaService,
    (chatId) => {
      const initiative = settingsRepository.getCompanionInitiative();
      const outreachState = initiative.importantMomentOutreachEnabled
        ? "enabled"
        : initiative.importantMomentOutreachPrompted
          ? "declined"
          : "not_asked";
      return [
        skillService.instructions(),
        `Important-moment outreach setting: ${outreachState}.`,
        journeyServiceInstance.agentContextInstructions(chatId),
      ]
        .filter(Boolean)
        .join("\n\n");
    },
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
    undefined,
    undefined,
    characterContextCompiler,
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
    [automationServiceInstance, proactiveOpportunityServiceInstance],
    clock,
    powerMonitor,
    (error) => logger.warn("AUTOMATION_SCHEDULER_ERROR", { error }),
  );
  automationServiceInstance.setScheduleChangedListener(() =>
    automationScheduler?.refresh(),
  );
  proactiveOpportunityServiceInstance.setScheduleChangedListener(() =>
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
      onVisibilityChanged: (visible) =>
        characterWindowController?.setMainWindowVisible(visible),
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
    (sender) => characterWindowController?.ownsSender(sender) ?? false,
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
  const wakeRuntime = voiceWakeService;
  if (!wakeRuntime) throw new Error("Voice Wake runtime was not initialized.");
  unregisterVoiceWakeIpc = registerVoiceWakeIpc(
    wakeRuntime,
    () => mainWindows.getWindow(),
    (sender) => characterWindowController?.ownsSender(sender) ?? false,
  );
  const ownsApplicationRenderer = (
    sender: Electron.WebContents | null,
  ): boolean => {
    if (!sender) return false;
    const mainWindow = mainWindows.getWindow();
    return Boolean(
      (mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.webContents.id === sender.id) ||
      characterWindowController?.ownsSender(sender),
    );
  };
  session.defaultSession.setPermissionCheckHandler(
    (sender, permission, _requestingOrigin, details) =>
      permission === "media" &&
      details.mediaType === "audio" &&
      ownsApplicationRenderer(sender),
  );
  session.defaultSession.setPermissionRequestHandler(
    (sender, permission, callback, details) => {
      const mediaTypes =
        "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
      callback(
        permission === "media" &&
          ownsApplicationRenderer(sender) &&
          mediaTypes.length > 0 &&
          mediaTypes.every((mediaType: string) => mediaType === "audio"),
      );
    },
  );
  const proactiveBubble = proactiveConversationSurfaceInstance.current();
  if (proactiveBubble) {
    characterWindowController.showProactiveBubble(proactiveBubble);
  }
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
    (chatId) => {
      void (async () => {
        const window = await mainWindows.open("chat");
        window.webContents.send(
          PET_CHANNELS.openConversation,
          parseSchema(PetConversationNavigationSchema, { chatId }),
        );
      })().catch((error: unknown) => {
        logger.warn("PROACTIVE_CONVERSATION_NAVIGATION_ERROR", {
          chatId,
          error,
        });
      });
    },
    (bubbleId) => {
      return proactiveConversationSurfaceInstance.clear(bubbleId);
    },
    (bubbleId) => {
      if (proactiveConversationSurfaceInstance.current()?.id !== bubbleId) {
        throw new Error("The proactive conversation is no longer available");
      }
      const current = settingsService.getCompanionInitiative();
      const saved = settingsService.saveCompanionInitiative({
        ...current,
        level: stepDownCompanionInitiativeLevel(current.level),
      });
      if (!proactiveConversationSurfaceInstance.clear(bubbleId)) {
        throw new Error("The proactive conversation is no longer available");
      }
      return { ok: true, value: { level: saved.level } };
    },
    async (request) => {
      try {
        const run = await proactiveConversationSurfaceInstance.reply(request);
        return parseSchema(ProactiveConversationBubbleReplyResponseSchema, {
          ok: true,
          value: { runId: run.id },
        });
      } catch (error) {
        characterWindowController?.flushProactiveBubble();
        return parseSchema(ProactiveConversationBubbleReplyResponseSchema, {
          error: toAgentAppError(error),
          ok: false,
        });
      }
    },
  );
  await mainWindows.open();
  await characterWindowController.create();
  if (!backgroundTest && activityCapture) {
    const capture = activityCapture;
    managedBrowser.setActivityObserver((state) =>
      capture.observeBrowser(state),
    );
    capture.start();
  }
  const trayActivity = activityService;
  const trayCharacter = characterWindowController;
  const trayVoice = voiceService;
  const trayWake = voiceWakeService;
  if (!trayActivity || !trayCharacter || !trayVoice || !trayWake) {
    throw new Error("Tray dependencies were not initialized.");
  }
  trayController = new TrayController(
    {
      activity: trayActivity,
      character: trayCharacter,
      logger,
      openMainWindow,
      pet: petService,
      persona: personaService,
      quit: () => app.quit(),
      voice: trayVoice,
      wake: trayWake,
    },
    {
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    },
  );
  await trayController.create();
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
    const wakeAssetsDirectory = app.isPackaged
      ? path.join(app.getAppPath(), ".vite/renderer/character_window/wake-word")
      : path.join(app.getAppPath(), "src/renderer/character/public/wake-word");
    const wakeAssetsReady = (
      await Promise.all(
        [
          "NOTICE.md",
          "sherpa-onnx-kws.js",
          "sherpa-onnx-wasm-kws-main.data",
          "sherpa-onnx-wasm-kws-main.js",
          "sherpa-onnx-wasm-kws-main.wasm",
        ].map((filename) =>
          access(path.join(wakeAssetsDirectory, filename)).then(
            () => true,
            () => false,
          ),
        ),
      )
    ).every(Boolean);
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
        singleInstance: app.hasSingleInstanceLock(),
        trayReady: trayController.isCreated(),
        visibleWindowCount: BrowserWindow.getAllWindows().filter((window) =>
          window.isVisible(),
        ).length,
        wakeAssetsReady,
      })}`,
    );
    app.quit();
  }
}

if (primaryInstance) {
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
}
