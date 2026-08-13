import type { AppError } from "../../shared/contracts/run";

export class EvolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EvolutionError";
  }
}

export function toEvolutionAppError(error: unknown): AppError {
  if (error instanceof EvolutionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "EVOLUTION.OPERATION_FAILED",
    message: error instanceof Error ? error.message : "成长操作没有完成。",
    retryable: true,
  };
}
