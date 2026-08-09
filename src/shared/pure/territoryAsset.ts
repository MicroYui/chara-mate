export const TERRITORY_ASSET_SCHEME = "chara-mate-territory";
export const TERRITORY_ASSET_FILE_NAME = "sprite.png";
export const TERRITORY_CANDIDATE_FILE_NAME = "preview.png";

export function territoryAssetUrl(assetId: string): string {
  return `${TERRITORY_ASSET_SCHEME}://asset/${encodeURIComponent(assetId)}/${TERRITORY_ASSET_FILE_NAME}`;
}

export function territoryCandidateUrl(
  candidateId: string,
  revision: string,
): string {
  const url = `${TERRITORY_ASSET_SCHEME}://candidate/${encodeURIComponent(candidateId)}/${TERRITORY_CANDIDATE_FILE_NAME}`;
  return `${url}?v=${encodeURIComponent(revision)}`;
}
