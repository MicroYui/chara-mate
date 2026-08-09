import type { AppError } from "../../shared/contracts/run";

export type ActivityErrorCode =
  "ACTIVITY.EPISODE_NOT_FOUND" | "ACTIVITY.STORAGE_FAILED";

export class ActivityError extends Error {
  constructor(
    readonly code: ActivityErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ActivityError";
  }
}

export function toActivityAppError(error: unknown): AppError {
  if (error instanceof ActivityError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "ACTIVITY.STORAGE_FAILED",
    message: "活动记录操作失败，请重试。",
    retryable: true,
  };
}
