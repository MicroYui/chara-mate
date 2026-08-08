import type { AppError } from "../../shared/contracts/run";

export class ExtensionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ExtensionError";
  }
}

export function toExtensionAppError(error: unknown): AppError {
  if (error instanceof ExtensionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "EXTENSION.FAILED",
    message: error instanceof Error ? error.message : "扩展操作失败。",
    retryable: false,
  };
}
