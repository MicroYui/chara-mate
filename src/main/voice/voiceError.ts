import type { AppError } from "../../shared/contracts/run";
import { ProviderError, toProviderAppError } from "../providers/providerError";

export type VoiceErrorCode =
  | "VOICE.ALREADY_ACTIVE"
  | "VOICE.END_NOT_AVAILABLE"
  | "VOICE.NOT_ACTIVE"
  | "VOICE.NOT_READY"
  | "VOICE.RUN_ACTIVE"
  | "VOICE.SESSION_MISMATCH"
  | "VOICE.TOOL_ALIAS_COLLISION"
  | "VOICE.UNSUPPORTED_TOOL_SCHEMA";

export class VoiceError extends Error {
  constructor(
    readonly code: VoiceErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

export function toVoiceAppError(error: unknown): AppError {
  if (error instanceof VoiceError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof ProviderError) return toProviderAppError(error);
  return {
    code: "VOICE.OPERATION_FAILED",
    message: error instanceof Error ? error.message : "语音操作没有完成。",
    retryable: false,
  };
}
