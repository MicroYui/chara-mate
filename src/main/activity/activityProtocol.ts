import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";

import { ACTIVITY_ASSET_SCHEME } from "../../shared/pure/activityAsset";
import type { ActivityAssetStore } from "./activityAssetStore";
import type { ActivityRepository } from "./activityRepository";

const ASSET_FILE_PATTERN = /^([0-9a-f-]{36})\.png$/u;

export function registerActivityProtocol(
  repository: ActivityRepository,
  assets: ActivityAssetStore,
): () => void {
  protocol.handle(ACTIVITY_ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const match = ASSET_FILE_PATTERN.exec(
        decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? ""),
      );
      if (url.host !== "asset" || !match?.[1]) {
        return new Response("Not found", { status: 404 });
      }
      const record = repository.getAsset(match[1]);
      if (!record) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(assets.resolve(record)).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  return () => protocol.unhandle(ACTIVITY_ASSET_SCHEME);
}
