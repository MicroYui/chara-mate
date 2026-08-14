import type { AppError } from "../../shared/contracts/run";

export type TerritoryErrorCode =
  | "TERRITORY.ASSET_CONFLICT"
  | "TERRITORY.CANDIDATE_NOT_FOUND"
  | "TERRITORY.CHANGESET_INVALID"
  | "TERRITORY.GENERATION_INTERRUPTED"
  | "TERRITORY.IMAGE_PROCESSING_FAILED"
  | "TERRITORY.INVALID_CANDIDATE_STATE"
  | "TERRITORY.INVALID_ASSET"
  | "TERRITORY.INVALID_PLACEMENT"
  | "TERRITORY.INSTANCE_NOT_TRASHED"
  | "TERRITORY.NO_PATH"
  | "TERRITORY.REVISION_CONFLICT"
  | "TERRITORY.REVISION_NOT_FOUND"
  | "TERRITORY.SOURCE_NOT_FOUND"
  | "TERRITORY.STORAGE_FAILED"
  | "TERRITORY.WORLD_NOT_FOUND"
  | "TERRITORY.ZONE_NOT_FOUND";

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
