import { protocol } from "electron";

import { TERRITORY_ASSET_SCHEME } from "../../shared/pure/territoryAsset";
import { ACTIVITY_ASSET_SCHEME } from "../../shared/pure/activityAsset";
import { PET_SCHEME } from "../pet/petProtocol";

export function registerApplicationSchemes(): void {
  const privileges = {
    corsEnabled: true,
    secure: true,
    standard: true,
    supportFetchAPI: true,
  } as const;
  protocol.registerSchemesAsPrivileged([
    { privileges, scheme: ACTIVITY_ASSET_SCHEME },
    { privileges, scheme: PET_SCHEME },
    { privileges, scheme: TERRITORY_ASSET_SCHEME },
  ]);
}
