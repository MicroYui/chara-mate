import type {
  ModelContextLimits,
  ModelProvider,
  ModelRequest,
} from "../../src/main/agent/modelProvider";
import { estimateInputBudget } from "../../src/main/providers/inputBudget";
import {
  ModelMemoryFormation,
  type MemoryFormationBatch,
  type MemoryFormationInput,
  type MemoryFormationRuntime,
  type MemoryFormationModel,
} from "../../src/main/memory/memoryModels";

export interface FormationModelMock {
  readonly version: string;
  form: (
    input: MemoryFormationInput,
    execution: { expectedProcessorVersion: string },
    signal?: AbortSignal,
  ) => Promise<MemoryFormationBatch>;
}
export const formationResourceBudget = { maxReadBytes: 16 * 1024 * 1024 };

/** Deterministic generation double; allocation uses the real Formation request
 * builder and complete input estimate, never the old evidence-only estimate. */
export function formationRuntime(
  model: FormationModelMock | MemoryFormationRuntime | MemoryFormationModel,
  options: {
    limits?: ModelContextLimits;
    measureInput?: ModelProvider["measureInput"];
    onRequest?: (request: ModelRequest) => void;
  } = {},
): MemoryFormationRuntime {
  if ("bind" in model) return model;
  if ("prepare" in model)
    return { version: model.version, bind: () => Promise.resolve(model) };
  const limits = options.limits ?? { effectiveInputTokens: 258_000 };
  const provider: ModelProvider = {
    estimateInput: estimateInputBudget,
    measureInput:
      options.measureInput ??
      ((request) => {
        options.onRequest?.(request);
        return Promise.resolve(estimateInputBudget(request));
      }),
    resolveContextLimits: () => Promise.resolve(limits),
    stream: () => {
      throw new Error("Generation must use this fixture's supplied callback");
    },
  };
  return {
    get version() {
      return model.version;
    },
    bind(execution, signal) {
      signal.throwIfAborted();
      execution.assertInputCurrent();
      const actual = new ModelMemoryFormation(
        provider,
        "formation-fixture",
        limits,
      );
      return Promise.resolve({
        version: execution.expectedProcessorVersion,
        prepare(input) {
          const prepared = actual.prepare(input);
          return {
            estimateInput: () => prepared.estimateInput(),
            measureInput: (callSignal) => prepared.measureInput(callSignal),
            async form(callSignal) {
              callSignal.throwIfAborted();
              execution.assertInputCurrent();
              return model.form(
                input,
                {
                  expectedProcessorVersion: execution.expectedProcessorVersion,
                },
                callSignal,
              );
            },
          };
        },
      });
    },
  };
}
