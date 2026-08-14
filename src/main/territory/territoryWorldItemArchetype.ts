import type {
  TerritoryAnchorKind,
  TerritoryDepthMode,
  TerritoryGridPoint,
  TerritoryLayer,
} from "../../shared/contracts/territoryWorld";

interface GridArchetypePlacement {
  readonly collisionCells: readonly TerritoryGridPoint[];
  readonly footprint: { readonly height: number; readonly width: number };
  readonly kind: "grid";
}

interface AttachmentArchetypePlacement {
  readonly allowedAnchors: readonly TerritoryAnchorKind[];
  readonly attachmentAnchorPx: { readonly x: number; readonly y: number };
  readonly kind: "attachment";
}

export interface TerritoryWorldItemArchetype {
  readonly depthMode: TerritoryDepthMode;
  readonly id:
    | "default-decor"
    | "floor-textile"
    | "large-furniture"
    | "storage"
    | "tabletop-decor"
    | "tall-decor"
    | "wall-decor";
  readonly layer: TerritoryLayer;
  readonly placement: GridArchetypePlacement | AttachmentArchetypePlacement;
  readonly sizePx: { readonly height: number; readonly width: number };
  readonly tags: readonly string[];
}

function rows(
  width: number,
  firstRow: number,
  rowCount = 1,
): TerritoryGridPoint[] {
  return Array.from({ length: width * rowCount }, (_, index) => ({
    x: index % width,
    y: firstRow + Math.floor(index / width),
  }));
}

function includesAny(prompt: string, words: readonly string[]): boolean {
  return words.some((word) => prompt.includes(word));
}

export function classifyTerritoryWorldItem(
  prompt: string,
): TerritoryWorldItemArchetype {
  const normalized = prompt.toLocaleLowerCase();
  if (
    includesAny(normalized, [
      "地毯",
      "地垫",
      "织毯",
      "毯子",
      "runner rug",
      "rug",
      "mat",
    ])
  ) {
    return {
      depthMode: "flat",
      id: "floor-textile",
      layer: "underlay",
      placement: {
        collisionCells: [],
        footprint: { height: 5, width: 8 },
        kind: "grid",
      },
      sizePx: { height: 120, width: 192 },
      tags: ["textile", "floor-decor"],
    };
  }
  if (
    includesAny(normalized, [
      "挂画",
      "壁画",
      "墙饰",
      "海报",
      "相框",
      "wall art",
      "poster",
      "painting",
      "wall clock",
    ])
  ) {
    return {
      depthMode: "sorted",
      id: "wall-decor",
      layer: "attachment",
      placement: {
        allowedAnchors: ["wall"],
        attachmentAnchorPx: { x: 84, y: 112 },
        kind: "attachment",
      },
      sizePx: { height: 112, width: 168 },
      tags: ["wall-decor"],
    };
  }
  if (
    includesAny(normalized, [
      "台灯",
      "杯",
      "茶壶",
      "花瓶",
      "书堆",
      "摆件",
      "desk lamp",
      "mug",
      "teapot",
      "vase",
      "book stack",
      "tabletop",
    ])
  ) {
    return {
      depthMode: "sorted",
      id: "tabletop-decor",
      layer: "attachment",
      placement: {
        allowedAnchors: ["tabletop", "bookshelf", "windowsill"],
        attachmentAnchorPx: { x: 36, y: 68 },
        kind: "attachment",
      },
      sizePx: { height: 72, width: 72 },
      tags: ["tabletop-decor"],
    };
  }
  if (
    includesAny(normalized, [
      "沙发",
      "椅",
      "床",
      "长凳",
      "凳",
      "sofa",
      "chair",
      "bed",
      "bench",
      "stool",
    ])
  ) {
    return {
      depthMode: "sorted",
      id: "large-furniture",
      layer: "object",
      placement: {
        collisionCells: rows(8, 4, 2),
        footprint: { height: 6, width: 8 },
        kind: "grid",
      },
      sizePx: { height: 144, width: 192 },
      tags: ["furniture", "seatable"],
    };
  }
  if (
    includesAny(normalized, [
      "书架",
      "柜",
      "箱",
      "储物",
      "shelf",
      "cabinet",
      "chest",
      "dresser",
      "wardrobe",
      "storage",
    ])
  ) {
    return {
      depthMode: "sorted",
      id: "storage",
      layer: "object",
      placement: {
        collisionCells: rows(6, 6),
        footprint: { height: 7, width: 6 },
        kind: "grid",
      },
      sizePx: { height: 168, width: 144 },
      tags: ["furniture", "storage"],
    };
  }
  if (
    includesAny(normalized, [
      "植物",
      "盆栽",
      "小树",
      "落地灯",
      "屏风",
      "plant",
      "tree",
      "floor lamp",
      "screen",
    ])
  ) {
    return {
      depthMode: "sorted",
      id: "tall-decor",
      layer: "object",
      placement: {
        collisionCells: rows(4, 5, 2),
        footprint: { height: 7, width: 4 },
        kind: "grid",
      },
      sizePx: { height: 168, width: 96 },
      tags: ["tall-decor"],
    };
  }
  return {
    depthMode: "sorted",
    id: "default-decor",
    layer: "object",
    placement: {
      collisionCells: rows(3, 2),
      footprint: { height: 3, width: 3 },
      kind: "grid",
    },
    sizePx: { height: 72, width: 72 },
    tags: ["decor"],
  };
}
