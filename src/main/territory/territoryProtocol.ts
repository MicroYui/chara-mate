import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";

import {
  TERRITORY_ASSET_FILE_NAME,
  TERRITORY_ASSET_SCHEME,
  TERRITORY_CANDIDATE_FILE_NAME,
} from "../../shared/pure/territoryAsset";
import type { TerritoryAssetStore } from "./territoryAssetStore";
import type { TerritoryCandidateStore } from "./territoryCandidateStore";
import type { TerritoryRepository } from "./territoryRepository";

const ASSET_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

export function registerTerritoryProtocol(
  repository: TerritoryRepository,
  assets: TerritoryAssetStore,
  candidates: TerritoryCandidateStore,
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
        const record = repository.getAsset(assetId);
        if (!record) return new Response("Not found", { status: 404 });
        const assetPath = await assets.resolveAssetPath(record);
        return net.fetch(pathToFileURL(assetPath).toString());
      }
      if (
        url.host !== "candidate" ||
        segments.length !== 2 ||
        segments[1] !== TERRITORY_CANDIDATE_FILE_NAME
      ) {
        return new Response("Not found", { status: 404 });
      }
      const candidateId = decodeURIComponent(segments[0] ?? "");
      const candidate = repository.getImageCandidate(candidateId);
      if (
        !candidate ||
        (candidate.status !== "ready" && candidate.status !== "accepted")
      ) {
        return new Response("Not found", { status: 404 });
      }
      const candidatePath = await candidates.resolve(candidate.id);
      return net.fetch(pathToFileURL(candidatePath).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  return () => {
    protocol.unhandle(TERRITORY_ASSET_SCHEME);
  };
}
