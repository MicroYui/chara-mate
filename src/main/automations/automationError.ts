import type { AppError } from "../../shared/contracts/run";

export type AutomationErrorCode =
  | "AUTOMATION.INVALID_SCHEDULE"
  | "AUTOMATION.INVALID_STATE"
  | "AUTOMATION.NOT_FOUND"
  | "AUTOMATION.REVISION_CONFLICT"
  | "AUTOMATION.STORAGE_FAILED";

export class AutomationError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AutomationError";
  }
}

export function toAutomationAppError(error: unknown): AppError {
  if (error instanceof AutomationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "AUTOMATION.STORAGE_FAILED",
    message: "定时任务操作失败，请重试。",
    retryable: true,
  };
}
