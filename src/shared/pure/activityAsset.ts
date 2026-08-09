export const ACTIVITY_ASSET_SCHEME = "chara-mate-activity";

export function activityAssetUrl(assetId: string): string {
  return `${ACTIVITY_ASSET_SCHEME}://asset/${encodeURIComponent(assetId)}.png`;
}
