import type { AppError } from "../../shared/contracts/run";

export type JourneyErrorCode =
  | "JOURNEY.CONFLICT"
  | "JOURNEY.INVALID_STATE"
  | "JOURNEY.NOT_FOUND"
  | "JOURNEY.SESSION_NOT_FOUND"
  | "JOURNEY.STORAGE_FAILED";

export class JourneyError extends Error {
  constructor(
    readonly code: JourneyErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "JourneyError";
  }
}

export function toJourneyAppError(error: unknown): AppError {
  if (error instanceof JourneyError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "JOURNEY.STORAGE_FAILED",
    message: "当前陪伴状态更新失败，请重试。",
    retryable: true,
  };
}
