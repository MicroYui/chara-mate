import type {
  TerritoryImageCandidate,
  TerritorySceneId,
} from "../../shared/contracts/territory";
import { getTerritoryScene } from "./catalog";
import { TerritoryError } from "./territoryError";

const PROVIDER_PROMPT_LIMIT = 32_000;

const sceneStyle: Record<TerritorySceneId, string> = {
  "city-rooftop":
    "quiet evening rooftop life-sim pixel art, warm window light, muted slate blue and amber accents",
  "forest-cabin":
    "warm woodland cabin life-sim pixel art, tactile timber, moss green and soft amber light",
  "seaside-room":
    "bright seaside room life-sim pixel art, sun-washed wood, pale aqua and gentle coral accents",
  "star-workshop":
    "cozy astral workshop life-sim pixel art, brass details, deep indigo and restrained violet glow",
};

function placementInstruction(candidate: TerritoryImageCandidate): string {
  const placement = candidate.structure?.placement ?? "ground_object";
  if (placement === "surface") {
    return "Make it a compact tabletop accessory with a clear bottom attachment point.";
  }
  if (placement === "ground_underlay") {
    return "Make it a flat ground decoration viewed from the same 2.5D angle, without raised furniture or props.";
  }
  const slots = candidate.structure?.surfaceSlots?.length ?? 0;
  return slots > 0
    ? `Make it a stable floor-standing object with a clearly visible upper surface that can hold ${String(slots)} small decoration${slots === 1 ? "" : "s"}.`
    : "Make it a stable floor-standing object with a clear foot point.";
}

export function buildTerritoryImagePrompt(
  candidate: TerritoryImageCandidate,
): string {
  const scene = getTerritoryScene(candidate.sceneId).definition;
  const palette = Object.values(scene.palette).join(", ");
  const action =
    candidate.operation === "generate"
      ? `Create this object: ${candidate.visualPrompt}`
      : `Edit only the provided object. Original intent: ${candidate.visualPrompt}. Requested change: ${candidate.editInstruction ?? "Keep the object unchanged."}`;
  const prompt = [
    action,
    `Style: ${sceneStyle[candidate.sceneId]}. Use the scene palette as guidance: ${palette}.`,
    placementInstruction(candidate),
    "Draw one complete, centered 2.5D pixel-art decoration for a 48 px tile grid. Keep crisp readable clusters, a clear foot point, generous empty margin, and consistent top-left lighting.",
    "Do not draw a room, floor, character, text, UI, frame, cast shadow, or multiple objects.",
    "Fill the entire background with one flat pure magenta (#ff00ff) color, with no texture or gradient. Do not use magenta on the object.",
  ].join("\n");
  if (prompt.length > PROVIDER_PROMPT_LIMIT) {
    throw new TerritoryError(
      "TERRITORY.IMAGE_PROCESSING_FAILED",
      "图片描述超过 Image Provider 的长度限制。",
      false,
    );
  }
  return prompt;
}
