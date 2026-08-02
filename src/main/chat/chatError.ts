import type { AppError } from "../../shared/contracts/run";

export type ChatErrorCode =
  | "CHAT.ARCHIVED"
  | "CHAT.NOT_FOUND"
  | "CHAT.STORAGE_FAILED"
  | "CHAT.TURN_ACTIVE";

export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export function toChatAppError(error: unknown): AppError {
  if (error instanceof ChatError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    code: "CHAT.STORAGE_FAILED",
    message: "会话操作失败，请重试。",
    retryable: true,
  };
}
