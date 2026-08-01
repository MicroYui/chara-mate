import type { AppError } from "../../shared/contracts/run";

export type ProviderErrorCode =
  | "PROVIDER.AUTHENTICATION_FAILED"
  | "PROVIDER.CREDENTIAL_REQUIRED"
  | "PROVIDER.INVALID_CONFIGURATION"
  | "PROVIDER.MODEL_DISCOVERY_UNAVAILABLE"
  | "PROVIDER.PERMISSION_DENIED"
  | "PROVIDER.PROFILE_NOT_FOUND"
  | "PROVIDER.RATE_LIMITED"
  | "PROVIDER.REQUEST_FAILED"
  | "PROVIDER.SECRET_STORAGE_UNAVAILABLE"
  | "PROVIDER.STORAGE_FAILED"
  | "PROVIDER.TIMEOUT"
  | "PROVIDER.UNREACHABLE";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function toProviderAppError(error: unknown): AppError {
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    code: "PROVIDER.REQUEST_FAILED",
    message: "Provider 操作失败，请重试。",
    retryable: false,
  };
}
