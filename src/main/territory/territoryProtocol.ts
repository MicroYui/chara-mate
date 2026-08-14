import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";

import {
  TERRITORY_ASSET_FILE_NAME,
  TERRITORY_ASSET_SCHEME,
} from "../../shared/pure/territoryAsset";
import type { TerritoryWorldAssetStore } from "./territoryWorldAssetStore";
import type { TerritoryWorldRepository } from "./territoryWorldRepository";

const ASSET_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

export function registerTerritoryProtocol(
  repository: TerritoryWorldRepository,
  assets: TerritoryWorldAssetStore,
): () => void {
  protocol.handle(TERRITORY_ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean);
      if (url.host === "asset") {
        if (
          segments.length !== 2 ||
          segments[1] !== TERRITORY_ASSET_FILE_NAME
        ) {
          return new Response("Not found", { status: 404 });
        }
        const assetId = decodeURIComponent(segments[0] ?? "");
        if (!ASSET_ID_PATTERN.test(assetId)) {
          return new Response("Not found", { status: 404 });
        }
        const record = repository.getStoredAsset(assetId);
        if (!record || record.asset.origin === "packaged") {
          return new Response("Not found", { status: 404 });
        }
        const assetPath = await assets.resolve(record);
        return net.fetch(pathToFileURL(assetPath).toString());
      }
      return new Response("Not found", { status: 404 });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  return () => {
    protocol.unhandle(TERRITORY_ASSET_SCHEME);
  };
}
