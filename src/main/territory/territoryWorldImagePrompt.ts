import type {
  TerritoryChangeCandidate,
  TerritoryDefinition,
  TerritoryStyleProfile,
  TerritoryZone,
} from "../../shared/contracts/territoryWorld";
import { TerritoryError } from "./territoryError";

const PROVIDER_PROMPT_LIMIT = 32_000;

function styleInstruction(style: TerritoryStyleProfile): string {
  return [
    `Visual system: ${style.name}.`,
    `Palette: ${Object.values(style.palette).join(", ")}.`,
    `Materials: ${style.materialLanguage}.`,
    `Outlines: ${style.outlineLanguage}.`,
    `Shadows: ${style.shadowLanguage}.`,
    `Lighting direction: ${style.lightingDirection}.`,
    `Season and time: ${style.seasonTone}; ${style.timeTone}.`,
    `Pixel scale: ${String(style.pixelScale)}.`,
  ].join(" ");
}

export function buildTerritoryWorldImagePrompt(input: {
  readonly candidate: TerritoryChangeCandidate;
  readonly definition?: TerritoryDefinition;
  readonly editInstruction?: string | null;
  readonly style: TerritoryStyleProfile;
  readonly zone: TerritoryZone;
}): string {
  const { candidate, definition, editInstruction, style, zone } = input;
  const request = editInstruction
    ? `${candidate.prompt}\nRevision request: ${editInstruction}`
    : candidate.prompt;
  let composition: string;
  switch (candidate.intent) {
    case "item":
      composition = [
        `Create one complete object inspired by: ${request}`,
        definition
          ? `Structured slot: ${String(definition.visual.sizePx.width)} by ${String(definition.visual.sizePx.height)} px; semantic layer ${definition.layer}; placement mode ${definition.placement.mode}. Keep the object scale and ground or attachment contact consistent with this slot.`
          : "Use a compact decorative-object scale.",
        "Draw a single centered 2.5D life-sim pixel-art asset for a 24 px atomic placement grid; major surfaces align to 48 px macro tiles.",
        "Use one flat solid #ff00ff magenta background with no gradient or texture. Keep generous empty margin, a readable silhouette, a clear ground contact point, and no baked cast shadow.",
        "Do not draw a room, floor, character, text, UI, frame, duplicate object, or scenery behind the object.",
      ].join(" ");
      break;
    case "selection":
      composition = [
        `Redesign only this existing entity: ${definition?.name ?? "selected object"}. Current meaning: ${definition?.description ?? "Territory entity"}. Requested change: ${request}`,
        "Return one complete centered 2.5D life-sim pixel-art asset with the same visual footprint on one flat solid #ff00ff magenta background with no gradient or texture.",
        "Preserve its functional reading and attachment orientation. Do not add a room, floor, character, text, UI, frame, or unrelated props.",
      ].join(" ");
      break;
    case "zone":
      composition = [
        `Create an editable base environment for the Zone named “${zone.name}”: ${request}`,
        `The composition is a ${String(zone.bounds.width)} by ${String(zone.bounds.height)} tile 2.5D life-sim space, viewed from a stable elevated angle without perspective rotation.`,
        "Make an opaque full-bleed background layer with coherent walls or landscape, floor transition, depth, atmospheric lighting, and a clearly walkable central area.",
        "Do not bake in freestanding furniture, collectible props, pets, people, text, UI, borders, or labels; those remain separate editable entities.",
      ].join(" ");
      break;
    case "expansion":
      composition = [
        `Create the base environment for a new connected Territory Zone extending from “${zone.name}”: ${request}`,
        `The new space uses a ${String(zone.bounds.width)} by ${String(zone.bounds.height)} tile 2.5D life-sim composition with an obvious connection edge and a walkable center.`,
        "Make an opaque full-bleed background layer. Keep the visual language continuous with the source Zone while giving the new place a distinct landmark.",
        "Do not bake in freestanding furniture, collectible props, pets, people, text, UI, borders, or labels.",
      ].join(" ");
      break;
  }
  const prompt = [
    composition,
    styleInstruction(style),
    "Use crisp pixel clusters, deliberate material edges, consistent top-left lighting, restrained texture, and production-quality game asset readability.",
  ].join("\n");
  if (prompt.length > PROVIDER_PROMPT_LIMIT) {
    throw new TerritoryError(
      "TERRITORY.IMAGE_PROCESSING_FAILED",
      "领地创作描述超过 Image Provider 的长度限制。",
      false,
    );
  }
  return prompt;
}
