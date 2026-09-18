import {
  modelTimeContext,
  type ModelTimeContext,
} from "../agent/modelTimeContext";
import type { ProviderSnapshot } from "../../shared/contracts/provider";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { ModelUsage } from "../agent/modelProvider";
import type { RunRepository } from "../agent/runRepository";
import {
  MEMORY_FORMATION_VERSION,
  ModelMemoryFormation,
  type MemoryFormationRuntime,
} from "../memory/memoryModels";
import type { ProviderService } from "../providers/providerService";
import type { MemoryProviderRecovery } from "../memory/memoryService";
import { memoryConsolidationProcessorVersion } from "./memoryConsolidationRuntime";

type FormationProviders = Pick<
  ProviderService,
  "getDefaultChatProfileId" | "createSnapshot" | "createChatModelRuntime"
>;

export function memoryFormationProcessorVersion(
  snapshot: ProviderSnapshot,
): string {
  return `${MEMORY_FORMATION_VERSION}:${snapshot.profileId}:${snapshot.apiStyle}:${snapshot.modelId}`;
}

/** Called only by the publisher of newly committed Run events. Replays do not
 * publish. Background Life responses cannot drive formation retry loops. */
export function memoryModelRecovery(
  envelope: RunEventEnvelope,
  runs: Pick<RunRepository, "getRun" | "isFirstCompletedModelResponse">,
  ownLifeRun: boolean,
): MemoryProviderRecovery | undefined {
  const event = envelope.event;
  if (
    ownLifeRun ||
    event.type !== "item.completed" ||
    event.item.kind !== "assistant_message" ||
    event.item.status !== "completed" ||
    event.item.runId !== envelope.streamId
  )
    return undefined;
  const run = runs.getRun(envelope.streamId);
  if (
    run?.source !== "text" ||
    !runs.isFirstCompletedModelResponse(run.id, event.item.id)
  )
    return undefined;
  return {
    formationProcessorVersion: memoryFormationProcessorVersion(run.provider),
    consolidationProcessorVersion: memoryConsolidationProcessorVersion(
      run.provider,
    ),
    requestIdentity: {
      profileId: run.provider.profileId,
      apiStyle: run.provider.apiStyle,
      modelId: run.provider.modelId,
    },
  };
}

/** Bind a formation request to the actual Provider snapshot before asynchronous
 * preparation. A later default selection cannot relabel the returned model. */
export function createMemoryFormationRuntime(
  providers: FormationProviders,
  onUsage: (usage: ModelUsage) => void,
  getTimeContext: () => ModelTimeContext = modelTimeContext,
): MemoryFormationRuntime {
  return {
    get version() {
      return memoryFormationProcessorVersion(
        providers.createSnapshot(providers.getDefaultChatProfileId()),
      );
    },
    async bind(execution, signal) {
      const check = (rejectedCause?: unknown) => {
        signal.throwIfAborted();
        execution.assertInputCurrent(rejectedCause);
      };
      check();
      const snapshot = providers.createSnapshot(
        providers.getDefaultChatProfileId(),
      );
      if (
        memoryFormationProcessorVersion(snapshot) !==
        execution.expectedProcessorVersion
      )
        throw new Error(
          "Memory formation configuration changed before runtime binding",
        );
      const awaitCurrent = async <T>(operation: Promise<T>): Promise<T> => {
        try {
          const value = await operation;
          check();
          return value;
        } catch (error) {
          check(error);
          throw error;
        }
      };
      const runtime = await awaitCurrent(
        providers.createChatModelRuntime(snapshot.profileId, snapshot.modelId),
      );
      if (
        memoryFormationProcessorVersion(runtime.snapshot) !==
        execution.expectedProcessorVersion
      )
        throw new Error(
          "Memory formation runtime does not match its expected processor",
        );
      const limits = await awaitCurrent(
        runtime.provider.resolveContextLimits(runtime.snapshot.modelId, signal),
      );
      const model = new ModelMemoryFormation(
        runtime.provider,
        runtime.snapshot.modelId,
        limits,
        onUsage,
        getTimeContext,
      );
      return {
        version: execution.expectedProcessorVersion,
        prepare(input) {
          check();
          const prepared = model.prepare(input);
          const before = (callSignal: AbortSignal) => {
            callSignal.throwIfAborted();
            check();
            if (callSignal !== signal)
              throw new Error(
                "Formation request must use its bound execution signal",
              );
          };
          return {
            estimateInput() {
              check();
              return prepared.estimateInput();
            },
            measureInput(callSignal) {
              before(callSignal);
              return awaitCurrent(prepared.measureInput(signal));
            },
            form(callSignal) {
              before(callSignal);
              return awaitCurrent(prepared.form(signal));
            },
          };
        },
      };
    },
  };
}
