import type { AppError } from "../../shared/contracts/run";

export type TerritoryErrorCode =
  | "TERRITORY.ASSET_CONFLICT"
  | "TERRITORY.INVALID_ASSET"
  | "TERRITORY.INVALID_MANIFEST"
  | "TERRITORY.INVALID_PLACEMENT"
  | "TERRITORY.ITEM_NOT_FOUND"
  | "TERRITORY.NO_PATH"
  | "TERRITORY.SCENE_NOT_ACTIVE"
  | "TERRITORY.STORAGE_FAILED";

export class TerritoryError extends Error {
  constructor(
    readonly code: TerritoryErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TerritoryError";
  }
}

export function toTerritoryAppError(error: unknown): AppError {
  if (error instanceof TerritoryError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "TERRITORY.STORAGE_FAILED",
    message: "领地状态保存失败，请重试。",
    retryable: false,
  };
}
