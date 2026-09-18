import { modelTimeContext } from "./agent/modelTimeContext";
import { reclaimMemorySources } from "./app/memorySourceReclamation";
import { referencedCognitionState } from "./app/canonicalCognitionSources";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { MemoryVectorSearchWorker } from "./memory/memoryVectorSearchWorker";
import { CognitionMemoryBridge } from "./app/cognitionMemoryBridge";
import {
  cognitionMemorySource,
  cognitionMemorySourceReference,
} from "./app/memoryFormationSources";
import type { CognitionEvidence } from "./cognition/cognitionTypes";
import { createHash } from "node:crypto";
import path from "node:path";
import { access, mkdir, readFile } from "node:fs/promises";

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
import {
  PET_CHANNELS,
  type PetTerritoryMomentNotice,
} from "../shared/contracts/pet";
import { PERSONA_CHANNELS } from "../shared/contracts/persona";
import {
  TERRITORY_WORLD_CHANNELS,
  type TerritoryWorldSnapshot,
} from "../shared/contracts/territoryWorld";
import { VOICE_CHANNELS } from "../shared/contracts/voice";
import { VOICE_WAKE_CHANNELS } from "../shared/contracts/voiceWake";
import { SystemClock } from "../shared/pure/clock";
import { CryptoIdGenerator } from "../shared/pure/id";
import {
  PetComposerAttachmentsSchema,
  PetConversationNavigationSchema,
  PetMainNavigationSchema,
  PetTerritoryCandidateNavigationSchema,
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
import { LocalAttachmentInputProvider } from "./agent/attachmentInput";
import { ElectronImageInputProvider } from "./agent/imageInput";
import { CheckpointRepository } from "./agent/checkpointRepository";
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
import { CompanionChatTargetsProjectionService } from "./companion/companionChatTargetsProjectionService";
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
import { CognitionRepository } from "./cognition/cognitionRepository";
import { CognitionService } from "./cognition/cognitionService";
import { ModelCognitionDriver } from "./cognition/cognitionDriver";
import {
  CognitionRuntime,
  projectCognitionMessage,
} from "./app/cognitionRuntime";
import { runMemoryIntake } from "./app/runMemoryIntake";
import {
  createMemoryFormationRuntime,
  memoryModelRecovery,
} from "./app/memoryFormationRuntime";
import { MemoryMaintenance } from "./memory/memoryMaintenance";
import { MemoryForegroundActivity } from "./app/memoryForegroundActivity";
import { ModelMemoryEvidenceSelector } from "./memory/memoryModels";
import { createMemoryConsolidationRuntime } from "./app/memoryConsolidationRuntime";
import { LocalEmbedding } from "./providers/localEmbedding";
import { localEmbeddingResources } from "./providers/localEmbeddingResources";
import {
  registerMemoryFormationTool,
  registerMemoryTool,
} from "./memory/memoryTool";
import { registerCompanionshipTool } from "./journey/companionshipTool";
import { CompanionInitiativeRepository } from "./journey/companionInitiativeRepository";
import { stepDownCompanionInitiativeLevel } from "./journey/companionInitiativePolicy";
import { registerJourneyIpc } from "./journey/journeyIpc";
import { JourneyRepository } from "./journey/journeyRepository";
import { JourneyService } from "./journey/journeyService";
import { ProactiveConversationSurface } from "./journey/proactiveConversationSurface";
import { registerImportantMomentOutreachTool } from "./journey/importantMomentOutreachTool";
import { registerTerritoryMomentSurprisesTool } from "./journey/territoryMomentSurprisesTool";
import { registerTerritoryMomentTool } from "./territory/territoryMomentTool";
import { TerritoryMomentService } from "./territory/territoryMomentService";
import { CompanionLifeService } from "./journey/companionLifeService";
import { registerCompanionLifeTool } from "./journey/companionLifeTool";
import { ProactiveOpportunityRepository } from "./journey/proactiveOpportunityRepository";
import { ProactiveOpportunityService } from "./journey/proactiveOpportunityService";
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
import {
  assertTerritoryMemorySources,
  TerritoryWorldMemoryService,
} from "./territory/territoryWorldMemoryService";
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
let companionLifeService: CompanionLifeService | undefined;
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
let cognitionService: CognitionService | undefined;
let cognitionRuntime: CognitionRuntime | undefined;
let localEmbedding: LocalEmbedding | undefined;
let memoryMaintenance: MemoryMaintenance | undefined;
let cognitionMemoryBridge: CognitionMemoryBridge | undefined;
let memoryVectorSearch: MemoryVectorSearchWorker | undefined;
let proactiveOpportunityService: ProactiveOpportunityService | undefined;
let proactiveConversationSurface: ProactiveConversationSurface | undefined;
let companionBridgeService: CompanionBridgeService | undefined;
let companionMailboxProcessor: CompanionMailboxProcessor | undefined;
let companionMessageProjectionService:
  CompanionMessageProjectionService | undefined;
let companionChatTargetsProjectionService:
  CompanionChatTargetsProjectionService | undefined;
let stopPromise: Promise<void> | undefined;
let shutdownComplete = false;

function openMainWindow(target?: MainWindowTarget): void {
  companionMailboxProcessor?.start();
  companionMessageProjectionService?.start();
  companionChatTargetsProjectionService?.start();
  const controller = mainWindowController;
  if (!controller) return;
  void controller.open(target).catch((error: unknown) => {
    logger.error(
      "CHARAMATE_MAIN_WINDOW_OPEN_ERROR",
      error instanceof Error ? error : { error },
    );
  });
}

function latestTerritoryMomentNotice(
  snapshot: TerritoryWorldSnapshot,
): PetTerritoryMomentNotice | null {
  const candidate = snapshot.candidates
    .filter((entry) =>
      entry.sources.some((source) => source.kind === "chat_moment"),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!candidate || !["failed", "ready"].includes(candidate.status)) {
    return null;
  }
  const source = candidate.sources.find(
    (entry) => entry.kind === "chat_moment",
  );
  if (!source || source.kind !== "chat_moment") return null;
  return {
    candidateId: candidate.id,
    createdAt: candidate.createdAt,
    name: source.label,
    status: candidate.status as "failed" | "ready",
    updatedAt: candidate.updatedAt,
  };
}

function syncTerritoryMomentNotice(snapshot: TerritoryWorldSnapshot): void {
  const notice = latestTerritoryMomentNotice(snapshot);
  if (notice) characterWindowController?.showTerritoryMomentNotice(notice);
  else characterWindowController?.clearTerritoryMomentNotice();
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
    // Close Agent admission before awaiting producers. Its actual preparation
    // Promises must settle while their domain dependencies and database exist.
    const agentStopping = agentRuntime?.interruptAll();
    const voiceStopping = voiceService?.shutdown();
    companionBridgeService?.dispose();
    companionBridgeService = undefined;
    await companionMailboxProcessor?.shutdown();
    companionMailboxProcessor = undefined;
    await companionMessageProjectionService?.shutdown();
    companionMessageProjectionService = undefined;
    await companionChatTargetsProjectionService?.shutdown();
    companionChatTargetsProjectionService = undefined;
    companionLifeService = undefined;
    proactiveOpportunityService?.shutdown();
    const cognitionShutdown = cognitionService?.shutdown();
    await automationScheduler?.stop();
    await cognitionShutdown;
    automationScheduler = undefined;
    await agentStopping;
    await evolutionService?.shutdown();
    evolutionService = undefined;
    await voiceStopping;
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
    await cognitionService?.shutdown();
    cognitionService = undefined;
    cognitionRuntime = undefined;
    await cognitionMemoryBridge?.shutdown();
    cognitionMemoryBridge = undefined;
    await memoryMaintenance?.shutdown();
    memoryMaintenance = undefined;
    proactiveOpportunityService = undefined;
    proactiveConversationSurface?.shutdown();
    proactiveConversationSurface = undefined;
    journeyService?.pauseForShutdown();
    // Stop callers while their tools still own working dependencies. Closing an
    // encoder first can turn shutdown into a failed tool and a completed Run.
    await memoryVectorSearch?.close();
    memoryVectorSearch = undefined;
    await localEmbedding?.shutdown();
    localEmbedding = undefined;
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
  const getTimeContext = () => modelTimeContext(clock.now());
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
        try {
          cognitionRuntime?.control("persona_changed");
          companionLifeService?.initialize();
        } catch (error) {
          logger.warn("COMPANION_LIFE_PERSONA_CHANGE_ERROR", { error });
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
  const memoryRepository = new MemoryRepository(applicationDatabase);
  const localEmbeddingInstance = new LocalEmbedding(
    await localEmbeddingResources({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    }),
  );
  localEmbedding = localEmbeddingInstance;
  const memoryVectorSearchInstance = new MemoryVectorSearchWorker(
    databasePath,
    () =>
      new Worker(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "memory-vector-search.mjs",
        ),
      ),
  );
  memoryVectorSearch = memoryVectorSearchInstance;
  const memoryServiceInstance = new MemoryService(
    memoryRepository,
    new LexicalRetrievalPipeline(applicationDatabase, memoryRepository, clock),
    idGenerator,
    clock,
    {
      embedding: localEmbeddingInstance,
      vectorSearch: memoryVectorSearchInstance,
      selector: {
        select: async (input, signal) => {
          const runtime = await providerService!.createChatModelRuntime(
            providerService!.getDefaultChatProfileId(),
          );
          return new ModelMemoryEvidenceSelector(
            runtime.provider,
            runtime.snapshot.modelId,
            (usage) => logger.info("MEMORY_SELECTOR_USAGE", { usage }),
            getTimeContext,
          ).select(input, signal);
        },
      },
      formation: createMemoryFormationRuntime(
        providerService,
        (usage) => logger.info("MEMORY_FORMATION_USAGE", { usage }),
        getTimeContext,
      ),
      consolidation: createMemoryConsolidationRuntime(
        providerService,
        (usage) => logger.info("MEMORY_CONSOLIDATION_USAGE", { usage }),
      ),
      // This retains original source-window/optional Recall allocation only.
      formationContextBudget: () => ({ maxTokens: 16_384 }),
      formationResourceBudget: { maxReadBytes: 16 * 1024 * 1024 },
    },
  );
  const sourceReclamationDatabase = applicationDatabase;
  memoryMaintenance = new MemoryMaintenance(memoryServiceInstance, {
    reclaimSources: async (signal) => {
      const result = await reclaimMemorySources(
        {
          database: sourceReclamationDatabase,
          clock,
          memory: memoryServiceInstance,
          cognition: cognitionRepository,
          chats: chatRepository,
          runs: runRepository,
        },
        signal,
      );
      if (result.scanned || result.cognition.scanned)
        logger.info("MEMORY_SOURCE_RECLAMATION", { ...result });
    },
    onError: (error, operation) =>
      logger.warn("MEMORY_MAINTENANCE_ERROR", { error, operation }),
  });
  unregisterMemoryIpc = registerMemoryIpc(memoryServiceInstance);
  const runRepository = new RunRepository(applicationDatabase);
  const memoryForegroundActivity = new MemoryForegroundActivity(
    runRepository,
    memoryMaintenance,
  );
  const checkpointRepository = new CheckpointRepository(applicationDatabase);
  const runtimeObservability = new RuntimeObservability(runRepository, logger);
  const automationServiceReference: { current?: AutomationService } = {};
  const proactiveOpportunityReference: {
    current?: ProactiveOpportunityService;
  } = {};
  const companionMessageProjectionReference: {
    current?: CompanionMessageProjectionService;
  } = {};
  memoryServiceInstance.setChangedListener((memoryId) => {
    memoryMaintenance?.wake();
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
        memoryForegroundActivity.observeRun(envelope);
      } catch (error) {
        logger.warn("MEMORY_FOREGROUND_ACTIVITY_ERROR", {
          error,
          runId: envelope.streamId,
        });
      }
      const ownLifeRun =
        companionLifeService?.isLifeRun(envelope.streamId) ?? false;
      try {
        const processor = memoryModelRecovery(
          envelope,
          runRepository,
          ownLifeRun,
        );
        if (processor !== undefined)
          memoryMaintenance?.recoverProviderFailures(processor);
      } catch (error) {
        logger.warn("MEMORY_PROVIDER_RECOVERY_ERROR", {
          error,
          runId: envelope.streamId,
          sequence: envelope.sequence,
        });
      }
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
        cognitionRuntime?.observeRun(envelope);
      } catch (error) {
        logger.warn("COMPANION_INITIATIVE_RUN_OBSERVER_ERROR", {
          error,
          runId: envelope.streamId,
          sequence: envelope.sequence,
        });
      }
      try {
        if (!ownLifeRun)
          companionMessageProjectionReference.current?.observeRun(envelope);
      } catch (error) {
        logger.warn("COMPANION_MESSAGE_PROJECTION_RUN_OBSERVER_ERROR", {
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
        companionChatTargetsProjectionService?.wake();
      }
    },
  });
  if (!app.isPackaged && process.env["CHARAMATE_DEV_DASHBOARD"] !== "0") {
    voiceMetrics = new VoiceMetrics();
    devDashboard = new DevDashboard(
      runtimeObservability,
      voiceMetrics,
      new ProductMetrics(applicationDatabase, memoryServiceInstance),
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
    () => companionChatTargetsProjectionService?.wake(),
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

  const toolRegistry = new ToolRegistry();
  const resolveMemoryIntake = (runId: string, itemId?: string) => {
    const run = runRepository.getRun(runId);
    return run
      ? runMemoryIntake(run, runRepository, chatRepository, itemId)
      : undefined;
  };
  registerMemoryTool(toolRegistry, memoryServiceInstance, (runId) => {
    const run = runRepository.getRun(runId);
    if (!run) throw new Error("Memory recall Run is unavailable");
    const situationId = cognitionService?.getSnapshot(run.persona.personaId)
      .attention.currentSituationId;
    return {
      personaId: run.persona.personaId,
      ...(situationId ? { situationId } : {}),
    };
  });
  registerMemoryFormationTool(
    toolRegistry,
    memoryServiceInstance,
    resolveMemoryIntake,
    ({ changes, runId }) => {
      memoryMaintenance?.wake();
      for (const { memoryId } of changes) {
        try {
          const detail = memoryServiceInstance.get(memoryId);
          journeyServiceInstance.linkMemoryForRun(
            runId,
            memoryId,
            detail.revisions.find(
              ({ id }) => id === detail.memory.currentRevisionId,
            )!.content,
          );
        } catch (error) {
          logger.warn("JOURNEY_MEMORY_PROJECTION_ERROR", {
            error,
            memoryId,
            runId,
          });
        }
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
  const ownedWorkspaceDirectory = path.join(userDataPath, "workspace");
  const workspaceDirectory = path.resolve(
    process.env["CHARAMATE_WORKSPACE_DIR"] ?? ownedWorkspaceDirectory,
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
  if (initialAgentSettings.workingDirectory === ownedWorkspaceDirectory) {
    await mkdir(ownedWorkspaceDirectory, { recursive: true });
  }
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
  providerService.setChangedListener(() => {
    memoryMaintenance?.retry();
    cognitionService?.retryAfterConfigurationChange();
  });
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
    idGenerator,
    clock,
  );
  // Initial retention reads the same persisted consumers as later maintenance.
  const cognitionRepository = new CognitionRepository(applicationDatabase, {
    readBudgetBytes: 32_768,
  });
  activityService.setSourceRetentionGuard((eventIds) => {
    const savedSources =
      memoryServiceInstance.snapshottedActivitySourceIds(eventIds);
    const protectedSources = new Set(
      cognitionRepository.protectedActivitySourceIds(eventIds, savedSources),
    );
    for (const id of memoryServiceInstance.protectedActivitySourceIds(eventIds))
      protectedSources.add(id);
    return protectedSources;
  });
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
  );
  activityService.setVisualChangeListener(() => {
    cognitionService?.notifyVisualChange();
  });
  activityService.setEventListener((event) => {
    try {
      cognitionRuntime?.observeActivity(event);
    } catch (error) {
      logger.warn("COGNITION_ACTIVITY_RECEIPT_ERROR", {
        error,
        eventId: event.id,
      });
    }
  });
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
  registerTerritoryMomentSurprisesTool(toolRegistry, settingsService);
  const resolveLocalInputSource = async (source: string): Promise<string> => {
    if (path.isAbsolute(source)) return path.resolve(source);
    try {
      const artifactPath = artifactStore.resolvePath(source);
      await access(artifactPath);
      return artifactPath;
    } catch {
      return settingsService.resolveWorkingPath(source);
    }
  };
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
    (sources) =>
      assertTerritoryMemorySources(
        memoryServiceInstance,
        personaService.getActiveSnapshot().personaId,
        sources,
      ),
    (snapshot) => {
      syncTerritoryMomentNotice(snapshot);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(
            TERRITORY_WORLD_CHANNELS.snapshotChanged,
            snapshot,
          );
        }
      }
    },
    async (request) => {
      const moment = request.sources.find(
        (source) => source.kind === "chat_moment",
      );
      const image = moment?.attachments.find((attachment) =>
        attachment.mediaType?.toLowerCase().startsWith("image/"),
      );
      if (!image) return undefined;
      const attachment = chatRepository.getAttachment(image.attachmentId);
      if (!attachment || attachment.sha256 !== image.sha256) {
        throw new Error("经历回响引用的原图已经变化或不可用。");
      }
      const bytes = await readFile(
        await resolveLocalInputSource(attachment.storageKey),
      );
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== image.sha256) {
        throw new Error("经历回响引用的原图摘要校验失败。");
      }
      return bytes;
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
    () => personaService.getActiveSnapshot().personaId,
    territoryWorldCandidates,
  );
  const territoryMomentService = new TerritoryMomentService(
    runRepository,
    chatRepository,
    territoryWorldRepository,
    territoryWorldCandidates,
    settingsService,
    memoryServiceInstance,
  );
  registerTerritoryMomentTool(
    toolRegistry,
    settingsService,
    territoryMomentService,
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
    runs: runRepository,
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
  const imageInput = new ElectronImageInputProvider(resolveLocalInputSource, {
    lookup: (request, resourceBudget, signal) =>
      activityService!.lookupVisualEvidence(request, resourceBudget, signal),
    current: async (signal) => {
      const latest = await activityService!.consumeLatestVisualEvidence(signal);
      signal?.throwIfAborted();
      if (!latest) return undefined;
      cognitionRuntime?.observeActivity(latest.event);
      return {
        reference: latest.reference,
        actor: latest.event.actor,
        position: {
          startedAt: latest.event.startedAt,
          eventId: latest.event.id,
        },
      };
    },
    resolve: (reference, signal) =>
      activityService!.resolveVisualEvidence(reference, signal),
  });
  const attachmentInput = new LocalAttachmentInputProvider(
    resolveLocalInputSource,
  );
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
      const territoryMomentState = initiative.territoryMomentSurprisesEnabled
        ? "enabled"
        : initiative.territoryMomentSurprisesPrompted
          ? "declined"
          : "not_asked";
      return [
        skillService.instructions(),
        `Important-moment outreach setting: ${outreachState}.`,
        `Territory moment surprise setting: ${territoryMomentState}.`,
        journeyServiceInstance.agentContextInstructions(run.chatId),
        companionLifeService?.context(run.persona.personaId),
      ]
        .filter(Boolean)
        .join("\n\n");
    },
    chatTitleService,
    imageInput,
    { prepareTurn: (input) => cognitionService!.prepareTurn(input) },
    undefined,
    attachmentInput,
    (continuingRunId) =>
      cognitionService?.yieldToUser(
        personaService.getActiveSnapshot().personaId,
        continuingRunId,
      ) ?? Promise.resolve(),
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
          cognitionRuntime?.observeBubbleOutcome(bubbleId, outcome);
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
  const resolveCognitionMemorySource = (evidence: CognitionEvidence) =>
    cognitionMemorySource(evidence, {
      getRun: (id) => runRepository.getRun(id),
      getRunItem: (id) => runRepository.getRunItem(id),
      getMessage: (id) => chatRepository.getMessage(id),
      getActivityEvent: (id) => activityService!.getEvent(id),
      getActivitySourceSnapshot: (id) =>
        memoryServiceInstance.getFormationSource("activity_event", id),
    });
  const cognitionMemoryBridgeInstance = new CognitionMemoryBridge({
    database: applicationDatabase,
    cognition: cognitionRepository,
    memory: memoryServiceInstance,
    describeSource: (evidence) =>
      cognitionMemorySourceReference(evidence, {
        hasChat: (id) => Boolean(chatRepository.getChat(id)),
        getCanonicalSource: (id) =>
          memoryServiceInstance.getFormationSourceMetadata(id),
        getRunSource: (id) => runRepository.getRunSourceReference(id),
        getRunItemSource: (id) => runRepository.getRunItemSourceReference(id),
        getMessageSource: (id) => chatRepository.getMessageSourceReference(id),
        getActivitySource: (id) => activityService!.getEventSourceReference(id),
      }),
    resolveSource: resolveCognitionMemorySource,
    wakeMemory: () => memoryMaintenance?.wake(),
    onError: (error, handoffId) =>
      logger.warn("COGNITION_MEMORY_HANDOFF_ERROR", { error, handoffId }),
  });
  cognitionMemoryBridge = cognitionMemoryBridgeInstance;
  const cognitionRuntimeInstance = new CognitionRuntime({
    cognition: () => cognitionService!,
    repository: cognitionRepository,
    runs: runRepository,
    agent: agentRuntime,
    chats: chatService,
    messages: chatRepository,
    memory: memoryServiceInstance,
    journeys: journeyServiceInstance,
    providers: providerService,
    tools: toolRegistry,
    persona: () => personaService.getActiveSnapshot(),
    surface: proactiveConversationSurfaceInstance,
    initiativeHistory: companionInitiativeRepository,
    settings: settingsRepository,
    activeVoice: () => Boolean(voiceService?.getActive()),
    lifePaused: () => companionLifeService?.isPaused() ?? false,
    isCurrentVisualSource: (source) =>
      activityService!.isCurrentVisualSource(source),
    clock,
    logger,
    projectMessage: (bubble, sourceKind) =>
      projectCognitionMessage(
        {
          surface: proactiveConversationSurfaceInstance,
          ...(companionMessageProjectionReference.current
            ? { projector: companionMessageProjectionReference.current }
            : {}),
          isIdle: () => activitySystemSource.isIdle(),
        },
        bubble,
        sourceKind,
      ),
  });
  const cognitionServiceInstance = new CognitionService({
    repository: cognitionRepository,
    resolveMemoryStateReferences: (personaId, items, maxBytes) =>
      referencedCognitionState(personaId, items, maxBytes, {
        cognition: cognitionRepository,
        chats: chatRepository,
        runs: runRepository,
      }),
    beforeAnalysis: async (signal) => {
      const latest = await activityService!.consumeLatestVisualEvidence(signal);
      if (latest) cognitionRuntimeInstance.observeActivity(latest.event);
    },
    driver: new ModelCognitionDriver({
      getTimeContext,
      resolveVisual: (reference, signal) =>
        activityService!.resolveVisualEvidence(reference, signal),
      getPersona: (personaId) => personaService.getSnapshot(personaId),
      createRuntime: async () => {
        const runtime = await providerService!.createChatModelRuntime(
          providerService!.getDefaultChatProfileId(),
        );
        return {
          provider: runtime.provider,
          modelId: runtime.snapshot.modelId,
        };
      },
      onUsage: (usage, attemptId) =>
        logger.info("COGNITION_MODEL_USAGE", { usage, attemptId }),
    }),
    memory: memoryServiceInstance,
    runtime: cognitionRuntimeInstance,
    clock,
    activePersonaId: () => personaService.getActiveSnapshot().personaId,
    analysisReadBudgetBytes: 131_072,
    analysisBudgetTokens: 32_768,
    batchWindowMs: 1_000,
    onScheduleChanged: () => automationScheduler?.refresh(),
    onError: (error) => logger.warn("COGNITION_ANALYSIS_ERROR", { error }),
    onMemoryHandoffPending: () => cognitionMemoryBridgeInstance.wake(),
    onSourceConsumersChanged: () => memoryMaintenance?.wake(),
  });
  cognitionService = cognitionServiceInstance;
  cognitionRuntime = cognitionRuntimeInstance;
  companionLifeService = new CompanionLifeService({
    cognition: cognitionServiceInstance,
    personas: personaService,
    clock,
  });
  registerCompanionLifeTool(toolRegistry, companionLifeService, runRepository);
  const proactiveOpportunityServiceInstance = new ProactiveOpportunityService({
    repository: new ProactiveOpportunityRepository(applicationDatabase),
    memory: memoryServiceInstance,
    chats: { getChat: (chatId) => chatRepository.getChat(chatId) },
    cognition: cognitionServiceInstance,
    policy: settingsRepository,
    personas: personaService,
    ids: idGenerator,
    clock,
    logger,
  });
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
  const companionChatTargetsProjectionServiceInstance =
    new CompanionChatTargetsProjectionService({
      bridge: companionBridgeRepository,
      chats: chatRepository,
      clock,
      idGenerator,
      onBackgroundError(error) {
        logger.warn("COMPANION_CHAT_TARGETS_PROJECTION_ERROR", { error });
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
      secretStore,
    });
  companionChatTargetsProjectionService =
    companionChatTargetsProjectionServiceInstance;
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
          companionChatTargetsProjectionServiceInstance.pause(),
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
        companionChatTargetsProjectionServiceInstance.reset();
      },
      onUnpairFailed: () => {
        companionMailboxProcessorInstance.resume();
        companionMessageProjectionServiceInstance.resume();
        companionChatTargetsProjectionServiceInstance.resume();
      },
      onUnpaired: () =>
        Promise.all([
          companionMailboxProcessorInstance.stop(),
          companionMessageProjectionServiceInstance.pause(),
          companionChatTargetsProjectionServiceInstance.pause(),
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
  const suspendCognition = () => cognitionRuntimeInstance.control("sleep");
  const wakeCompanionWork = () => {
    cognitionRuntimeInstance.control("wake");
    companionMailboxProcessor?.wake();
    companionMessageProjectionService?.wake();
    companionChatTargetsProjectionService?.wake();
  };
  const startCompanionWork = () => {
    companionMailboxProcessor?.start();
    companionMessageProjectionService?.start();
    companionChatTargetsProjectionService?.start();
  };
  powerMonitor.on("suspend", suspendCognition);
  powerMonitor.on("lock-screen", suspendCognition);
  powerMonitor.on("resume", wakeCompanionWork);
  powerMonitor.on("unlock-screen", wakeCompanionWork);
  powerMonitor.on("user-did-become-active", startCompanionWork);
  unregisterCompanionPowerEvents = () => {
    powerMonitor.off("suspend", suspendCognition);
    powerMonitor.off("lock-screen", suspendCognition);
    powerMonitor.off("resume", wakeCompanionWork);
    powerMonitor.off("unlock-screen", wakeCompanionWork);
    powerMonitor.off("user-did-become-active", startCompanionWork);
  };
  await agentRuntime.initialize();
  cognitionServiceInstance.initialize();
  companionLifeService.initialize();
  cognitionRuntimeInstance.restoreSurfaces();
  memoryMaintenance?.start();
  cognitionMemoryBridgeInstance.start();
  companionMailboxProcessorInstance.start();
  companionMessageProjectionServiceInstance.start();
  companionChatTargetsProjectionServiceInstance.start();
  proactiveOpportunityServiceInstance.initialize();

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
        memoryForegroundActivity.observeVoice(value);
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
      const territoryMomentState = initiative.territoryMomentSurprisesEnabled
        ? "enabled"
        : initiative.territoryMomentSurprisesPrompted
          ? "declined"
          : "not_asked";
      return [
        skillService.instructions(),
        `Important-moment outreach setting: ${outreachState}.`,
        `Territory moment surprise setting: ${territoryMomentState}.`,
        journeyServiceInstance.agentContextInstructions(chatId),
        companionLifeService?.context(
          personaService.getActiveSnapshot().personaId,
        ),
      ]
        .filter(Boolean)
        .join("\n\n");
    },
    chatTitleService,
    { prepareTurn: (input) => cognitionServiceInstance.prepareTurn(input) },
    (phase) => {
      if (phase === "listening") {
        void cognitionServiceInstance
          .yieldToUser(personaService.getActiveSnapshot().personaId)
          .catch((error: unknown) =>
            logger.warn("COGNITION_VOICE_YIELD_ERROR", { error }),
          );
      }
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
    cancelStart: (request) => {
      cognitionRuntimeInstance.control(
        "user_stop",
        "The user explicitly stopped the current submission.",
      );
      return agentRuntime!.cancelStart(request);
    },
    cancel: (request) => {
      cognitionRuntimeInstance.control(
        "user_stop",
        "The user explicitly stopped the current Run.",
      );
      const run = runRepository.getRun(request.runId);
      return run?.source === "voice"
        ? voiceRuntime.cancelRun(request)
        : agentRuntime!.cancel(request);
    },
    getPendingApproval: () => runRepository.getLatestPendingApproval() ?? null,
    resolveApproval: async (request) => {
      const approval = runRepository.getApproval(request.approvalId);
      const run = approval ? runRepository.getRun(approval.runId) : undefined;
      return await (run?.source === "voice"
        ? voiceRuntime.resolveApproval(request)
        : agentRuntime!.resolveApproval(request));
    },
    resolveUserInput: (request) => agentRuntime!.resolveUserInput(request),
    resume: (request) => agentRuntime!.resume(request),
    start: (request, options) => agentRuntime!.start(request, options),
    steer: (request) => agentRuntime!.steer(request),
  });
  await automationServiceInstance.initialize();
  automationScheduler = new AutomationScheduler(
    [
      automationServiceInstance,
      proactiveOpportunityServiceInstance,
      cognitionServiceInstance,
    ],
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
        return Boolean(
          voiceService?.hasPendingConnection() ||
          (phase && phase !== "failed" && phase !== "interrupted"),
        );
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
  syncTerritoryMomentNotice(territoryWorldRepository.getSnapshot());
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
    (request) => {
      void (async () => {
        const window = await mainWindows.open("chat");
        window.webContents.send(
          PET_CHANNELS.openComposerAttachments,
          parseSchema(PetComposerAttachmentsSchema, request),
        );
      })().catch((error: unknown) => {
        logger.warn("PET_ATTACHMENT_NAVIGATION_ERROR", {
          error,
        });
      });
    },
    (candidateId) => {
      void (async () => {
        const window = await mainWindows.open("territory");
        window.webContents.send(
          PET_CHANNELS.openTerritoryCandidate,
          parseSchema(PetTerritoryCandidateNavigationSchema, { candidateId }),
        );
      })().catch((error: unknown) => {
        logger.warn("TERRITORY_MOMENT_NAVIGATION_ERROR", {
          candidateId,
          error,
        });
      });
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
    const smokeVector = await localEmbeddingInstance.embedQuery(
      "Find evidence about a remembered shared activity.",
    );
    if (
      smokeVector.length !== localEmbeddingInstance.dimensions ||
      !smokeVector.every(Number.isFinite)
    )
      throw new Error("Packaged local encoder did not return a valid vector");
    const smokeMatches = await memoryVectorSearchInstance.search({
      query: smokeVector,
      modelKey: localEmbeddingInstance.modelKey,
      limit: 1,
      now: clock.now(),
      plan: {
        purpose: "recollection",
        query: "Remembered shared activity",
        questions: [{ id: "smoke", text: "Remembered shared activity" }],
        contextBudget: { maxTokens: 1_024 },
      },
    });
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
        localEmbeddingDimensions: smokeVector.length,
        memoryWorkerReady: smokeMatches.length === 0,
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
