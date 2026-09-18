import type { ProviderSnapshot } from "../../shared/contracts/provider";
import type { ModelContextLimits, ModelUsage } from "../agent/modelProvider";
import {
  ModelMemoryConsolidation,
  type MemoryConsolidationRuntime,
} from "../memory/memoryConsolidation";
import { MEMORY_CONSOLIDATION_PROCESSOR_VERSION } from "../memory/memoryLearningRepository";
import type {
  ChatModelRuntime,
  ProviderService,
} from "../providers/providerService";

type ConsolidationProviders = Pick<
  ProviderService,
  "getDefaultChatProfileId" | "createSnapshot" | "createChatModelRuntime"
>;

export function memoryConsolidationProcessorVersion(
  snapshot: ProviderSnapshot,
): string {
  return `${MEMORY_CONSOLIDATION_PROCESSOR_VERSION}:${snapshot.profileId}:${snapshot.apiStyle}:${snapshot.modelId}`;
}

/** Bind each attempt before asynchronous runtime preparation. This identity is
 * the executing model, separate from the stable derived-memory format. */
export function createMemoryConsolidationRuntime(
  providers: ConsolidationProviders,
  onUsage: (usage: ModelUsage) => void,
): MemoryConsolidationRuntime {
  return {
    get version() {
      return memoryConsolidationProcessorVersion(
        providers.createSnapshot(providers.getDefaultChatProfileId()),
      );
    },
    async bind(execution, signal) {
      const checkInput = (rejectedCause?: unknown) => {
        signal.throwIfAborted();
        execution.assertInputCurrent(rejectedCause);
      };
      checkInput();
      const snapshot = providers.createSnapshot(
        providers.getDefaultChatProfileId(),
      );
      if (
        memoryConsolidationProcessorVersion(snapshot) !==
        execution.expectedProcessorVersion
      )
        throw new Error(
          "Memory consolidation configuration changed before runtime binding",
        );
      let runtime: ChatModelRuntime;
      try {
        runtime = await providers.createChatModelRuntime(
          snapshot.profileId,
          snapshot.modelId,
        );
      } catch (error) {
        checkInput(error);
        throw error;
      }
      checkInput();
      const checkProcessor = (rejectedCause?: unknown) => {
        checkInput(rejectedCause);
        if (
          memoryConsolidationProcessorVersion(runtime.snapshot) !==
          execution.expectedProcessorVersion
        ) {
          const failure =
            rejectedCause ??
            new Error(
              "Memory consolidation runtime does not match its expected processor",
            );
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Preserve the actual rejected value and its identity.
          throw failure;
        }
      };
      checkProcessor();
      let limits: ModelContextLimits;
      try {
        // Once per attempt, on the same Provider whose measure/stream cache
        // consumes these limits. The secret-store await above remains joined.
        limits = await runtime.provider.resolveContextLimits(
          runtime.snapshot.modelId,
          signal,
        );
      } catch (error) {
        checkProcessor(error);
        throw error;
      }
      checkProcessor();
      const model = new ModelMemoryConsolidation(
        runtime.provider,
        runtime.snapshot.modelId,
        limits,
        onUsage,
      );
      const internalExecution = {
        expectedProcessorVersion: model.version,
        assertInputCurrent: checkProcessor,
      };
      const checkCall = (expected: string, callSignal: AbortSignal) => {
        callSignal.throwIfAborted();
        checkProcessor();
        if (expected !== execution.expectedProcessorVersion)
          throw new Error(
            "Memory consolidation call does not match its bound processor",
          );
      };
      return {
        version: execution.expectedProcessorVersion,
        measureInput(input, requested, callSignal) {
          checkCall(requested.expectedProcessorVersion, callSignal);
          return model.measureInput(input, internalExecution, signal);
        },
        consolidate(input, requested, callSignal) {
          checkCall(requested.expectedProcessorVersion, callSignal);
          return model.consolidate(input, internalExecution, signal);
        },
      };
    },
  };
}
