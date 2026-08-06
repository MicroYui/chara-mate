import type { AppError } from "../../shared/contracts/run";

export type PetErrorCode =
  | "PET.ALREADY_EXISTS"
  | "PET.IMPORT_FAILED"
  | "PET.INVALID_FORMAT"
  | "PET.NOT_FOUND"
  | "PET.STORAGE_FAILED";

export class PetError extends Error {
  constructor(
    readonly code: PetErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PetError";
  }
}

export function toPetAppError(error: unknown): AppError {
  if (error instanceof PetError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    code: "PET.IMPORT_FAILED",
    message: "桌宠操作失败，请重试。",
    retryable: false,
  };
}
