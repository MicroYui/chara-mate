import type { AppError } from "../../shared/contracts/run";

export type MemoryErrorCode =
  | "MEMORY.CANDIDATE_NOT_FOUND"
  | "MEMORY.CONFLICT"
  | "MEMORY.INVALID_STATE"
  | "MEMORY.NOT_FOUND"
  | "MEMORY.STORAGE_FAILED";

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export function toMemoryAppError(error: unknown): AppError {
  if (error instanceof MemoryError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "MEMORY.STORAGE_FAILED",
    message: "记忆操作失败，请重试。",
    retryable: true,
  };
}
