import type { AppError } from "../../shared/contracts/run";
import { ProviderError } from "../providers/providerError";
import { CompanionBridgePersistenceError } from "./companionBridgeRepository";
import { CompanionRelayClientError } from "./companionRelayClient";

export type CompanionErrorCode =
  | "COMPANION.CREDENTIAL_REQUIRED"
  | "COMPANION.DEVICE_MISMATCH"
  | "COMPANION.DEVICE_SLOT_OCCUPIED"
  | "COMPANION.INVALID_PAIRING_GRANT"
  | "COMPANION.NOT_PAIRED"
  | "COMPANION.OPERATION_FAILED"
  | "COMPANION.PAIRING_EXPIRED"
  | "COMPANION.PROTOCOL_ERROR"
  | "COMPANION.PROTOCOL_MISMATCH"
  | "COMPANION.RELAY_UNAVAILABLE"
  | "COMPANION.SECRET_STORAGE_UNAVAILABLE"
  | "COMPANION.STORAGE_FAILED";

export class CompanionError extends Error {
  constructor(
    readonly code: CompanionErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CompanionError";
  }
}

function providerAppError(error: ProviderError): AppError {
  switch (error.code) {
    case "PROVIDER.CREDENTIAL_REQUIRED":
      return {
        code: "COMPANION.CREDENTIAL_REQUIRED",
        message: "手机 Companion 的连接凭据不可用，请重新配对。",
        retryable: false,
      };
    case "PROVIDER.SECRET_STORAGE_UNAVAILABLE":
      return {
        code: "COMPANION.SECRET_STORAGE_UNAVAILABLE",
        message: error.message,
        retryable: error.retryable,
      };
    case "PROVIDER.STORAGE_FAILED":
      return {
        code: "COMPANION.STORAGE_FAILED",
        message: error.message,
        retryable: error.retryable,
      };
    default:
      return {
        code: "COMPANION.OPERATION_FAILED",
        message: "手机 Companion 操作没有完成，请重试。",
        retryable: error.retryable,
      };
  }
}

export function toCompanionAppError(error: unknown): AppError {
  if (error instanceof CompanionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (error instanceof CompanionBridgePersistenceError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }

  if (error instanceof ProviderError) return providerAppError(error);

  if (error instanceof CompanionRelayClientError) {
    return {
      code:
        error.kind === "network"
          ? "COMPANION.RELAY_UNAVAILABLE"
          : "COMPANION.PROTOCOL_ERROR",
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("COMPANION.") &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim() &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    code: "COMPANION.OPERATION_FAILED",
    message: "手机 Companion 操作没有完成，请重试。",
    retryable: false,
  };
}
