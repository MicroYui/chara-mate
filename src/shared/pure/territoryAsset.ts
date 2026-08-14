export const TERRITORY_ASSET_SCHEME = "chara-mate-territory";
export const TERRITORY_ASSET_FILE_NAME = "sprite.png";

export function territoryAssetUrl(assetId: string): string {
  return `${TERRITORY_ASSET_SCHEME}://asset/${encodeURIComponent(assetId)}/${TERRITORY_ASSET_FILE_NAME}`;
}
