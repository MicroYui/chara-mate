import type { AppError } from "../../shared/contracts/run";
import type {
  TerritoryCandidateMutationResult,
  TerritoryAssetPack,
  TerritoryChangeCandidate,
  TerritoryCreateChangeCandidateRequest,
  TerritoryDefinition,
  TerritoryEditChangeCandidateRequest,
  TerritoryGridPoint,
  TerritoryInstance,
  TerritoryStyleProfile,
  TerritoryWorldChangeSet,
  TerritoryWorldMutation,
  TerritoryWorldSnapshot,
  TerritoryZone,
  TerritoryZoneConnection,
  TerritoryZoneView,
} from "../../shared/contracts/territoryWorld";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import {
  territoryInstanceCollisionCells,
  territoryInstanceFootprint,
} from "../../shared/pure/territoryWorldGrid";
import { TERRITORY_WORLD_UNIT_PX } from "../../shared/pure/territoryWorldScale";
import type { TerritoryImageRenderOptions } from "../providers/azureImageProvider";
import { ProviderError, toProviderAppError } from "../providers/providerError";
import { TerritoryError, toTerritoryAppError } from "./territoryError";
import { classifyTerritoryWorldItem } from "./territoryWorldItemArchetype";
import type {
  PreparedTerritoryWorldAsset,
  TerritoryWorldAssetStore,
} from "./territoryWorldAssetStore";
import { buildTerritoryWorldImagePrompt } from "./territoryWorldImagePrompt";
import type { TerritoryWorldRepository } from "./territoryWorldRepository";

const itemRenderOptions: TerritoryImageRenderOptions = {
  background: "opaque",
  quality: "medium",
  size: "1024x1024",
};

const zonePieceRenderOptions: TerritoryImageRenderOptions = {
  background: "opaque",
  quality: "high",
  size: "1024x1024",
};

const zoneRenderOptions: TerritoryImageRenderOptions = {
  background: "opaque",
  quality: "high",
  size: "1536x960",
};

export interface TerritoryWorldImageRuntimeFactory {
  createImageProvider(profileId: string): Promise<{
    edit(
      image: Buffer,
      prompt: string,
      options: TerritoryImageRenderOptions,
      signal?: AbortSignal,
    ): Promise<Buffer>;
    generate(
      prompt: string,
      options: TerritoryImageRenderOptions,
      signal?: AbortSignal,
    ): Promise<Buffer>;
  }>;
  resolveImageProfileId(preferredProfileId?: string): string;
}

interface GeneratedPlan {
  readonly changeSet: TerritoryWorldChangeSet;
  readonly previewGroups: TerritoryChangeCandidate["previewGroups"];
}

export interface TerritoryWorldCandidateJob {
  readonly completion: Promise<TerritoryCandidateMutationResult>;
  readonly initial: TerritoryCandidateMutationResult;
}

interface GenerationContext {
  readonly request: TerritoryCreateChangeCandidateRequest;
  readonly snapshot: TerritoryWorldSnapshot;
  readonly style: TerritoryStyleProfile;
  readonly view: TerritoryZoneView;
  readonly zone: TerritoryZone;
}

function mutationTargetKey(mutation: TerritoryWorldMutation): string {
  switch (mutation.kind) {
    case "active-zone.set":
      return `active-zone:${mutation.zoneId}`;
    case "zone.put":
      return `zone:${mutation.zone.id}`;
    case "zone.remove":
      return `zone:${mutation.zoneId}`;
    case "connection.put":
      return `connection:${mutation.connection.id}`;
    case "connection.remove":
      return `connection:${mutation.connectionId}`;
    case "style.put":
      return `style:${mutation.style.id}`;
    case "asset-pack.put":
      return `asset-pack:${mutation.assetPack.id}`;
    case "definition.put":
      return `definition:${mutation.definition.id}`;
    case "instance.put":
      return `instance:${mutation.instance.id}`;
    case "instance.remove":
      return `instance:${mutation.instanceId}`;
    case "group.put":
      return `group:${mutation.group.id}`;
    case "group.remove":
      return `group:${mutation.groupId}`;
  }
}

function reconcileCandidatePlan(
  plan: GeneratedPlan,
  previous: TerritoryWorldChangeSet | null,
  excludedChangeIds: readonly string[],
): GeneratedPlan {
  if (!previous && excludedChangeIds.length === 0) return plan;
  const previousByTarget = new Map(
    (previous?.mutations ?? []).map((mutation) => [
      mutationTargetKey(mutation),
      mutation,
    ]),
  );
  const remappedIds = new Map<string, string>();
  const reconciled = plan.changeSet.mutations.map((mutation, index) => {
    const sameTarget = previousByTarget.get(mutationTargetKey(mutation));
    const samePosition = previous?.mutations[index];
    const prior =
      sameTarget ??
      (samePosition?.kind === mutation.kind ? samePosition : undefined);
    const changeId = prior?.changeId ?? mutation.changeId;
    remappedIds.set(mutation.changeId, changeId);
    return { ...mutation, changeId };
  });
  const excluded = new Set(excludedChangeIds);
  const mutations = reconciled.filter(
    ({ changeId }) => !excluded.has(changeId),
  );
  if (mutations.length === 0) {
    throw new TerritoryError(
      "TERRITORY.CHANGESET_INVALID",
      "所有候选变更都已排除；请保留至少一个分组或取消预览。",
      false,
    );
  }
  const includedIds = new Set(mutations.map(({ changeId }) => changeId));
  const instanceChangeId = new Map<string, string>();
  for (const mutation of reconciled) {
    if (mutation.kind === "instance.put") {
      instanceChangeId.set(mutation.instance.id, mutation.changeId);
    } else if (mutation.kind === "instance.remove") {
      instanceChangeId.set(mutation.instanceId, mutation.changeId);
    }
  }
  return {
    changeSet: {
      ...plan.changeSet,
      ...(previous ? { id: previous.id } : {}),
      mutations,
    },
    previewGroups: plan.previewGroups.flatMap((group) => {
      const changeIds = group.changeIds
        .map((changeId) => remappedIds.get(changeId) ?? changeId)
        .filter((changeId) => includedIds.has(changeId));
      if (changeIds.length === 0) return [];
      return [
        {
          ...group,
          changeIds,
          instanceIds: group.instanceIds.filter((instanceId) => {
            const changeId = instanceChangeId.get(instanceId);
            return !changeId || includedIds.has(changeId);
          }),
        },
      ];
    }),
  };
}

function failure(error: unknown): AppError {
  if (error instanceof ProviderError) return toProviderAppError(error);
  if (error instanceof TerritoryError) return toTerritoryAppError(error);
  return {
    code: "TERRITORY.IMAGE_PROCESSING_FAILED",
    message: "领地图片生成失败，请重试。",
    retryable: true,
  };
}

function definitionKey(definition: {
  readonly id: string;
  readonly revision: number;
}): string {
  return `${definition.id}@${String(definition.revision)}`;
}

function generatedAssetPack(input: {
  readonly assets: TerritoryAssetPack["assets"];
  readonly candidateId: string;
  readonly createdAt: string;
  readonly name: string;
  readonly style: TerritoryStyleProfile;
}): TerritoryAssetPack {
  return {
    assets: input.assets,
    createdAt: input.createdAt,
    id: `generated.pack.${input.candidateId}`,
    name: input.name,
    revision: 1,
    styleProfile: { id: input.style.id, revision: input.style.revision },
  };
}

function rectangle(width: number, height: number): TerritoryGridPoint[] {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
  }));
}

function bottomRows(
  width: number,
  height: number,
  rows: number,
): TerritoryGridPoint[] {
  return rectangle(width, height).filter(
    ({ y }) => y >= Math.max(0, height - rows),
  );
}

interface GeneratedZonePieceSpec {
  readonly capabilities: TerritoryDefinition["capabilities"];
  readonly collisionCells: readonly TerritoryGridPoint[];
  readonly depthMode: TerritoryDefinition["visual"]["depthMode"];
  readonly description: string;
  readonly footprint: { readonly height: number; readonly width: number };
  readonly key: string;
  readonly layer: TerritoryDefinition["layer"];
  readonly name: string;
  readonly placements: readonly {
    readonly flipped?: boolean;
    readonly point: TerritoryGridPoint;
  }[];
  readonly prompt: string;
  readonly sizePx: { readonly height: number; readonly width: number };
}

const generatedZonePieceSpecs: readonly GeneratedZonePieceSpec[] = [
  {
    capabilities: ["inspectable", "seatable"],
    collisionCells: bottomRows(10, 8, 2),
    depthMode: "sorted",
    description: "区域中的大型主景休憩家具。",
    footprint: { height: 8, width: 10 },
    key: "focal-rest",
    layer: "object",
    name: "华丽主景休憩区",
    placements: [{ point: { x: 2, y: 14 } }],
    prompt:
      "a luxurious canopy daybed or bed piled with patterned pillows, layered quilts, embroidered throws, trailing tassels, an integrated book and tea tray, and visibly cherished bedside details, adapted to the requested territory",
    sizePx: { height: 192, width: 240 },
  },
  {
    capabilities: ["inspectable", "light"],
    collisionCells: bottomRows(10, 9, 2),
    depthMode: "sorted",
    description: "结合建筑感与陈列层次的视觉地标。",
    footprint: { height: 9, width: 10 },
    key: "landmark",
    layer: "object",
    name: "建筑陈列主景",
    placements: [{ point: { x: 16, y: 1 } }],
    prompt:
      "one dramatic fireplace or architectural furnishing landmark with a richly dressed mantel, framed curios, candles, books, botanical garlands, deep display niches, and warm illumination, adapted to the requested territory",
    sizePx: { height: 216, width: 240 },
  },
  {
    capabilities: ["inspectable"],
    collisionCells: bottomRows(6, 8, 2),
    depthMode: "sorted",
    description: "具有收藏感的高柜与陈列家具。",
    footprint: { height: 8, width: 6 },
    key: "display-storage",
    layer: "object",
    name: "珍藏陈列高柜",
    placements: [{ point: { x: 39, y: 2 } }],
    prompt:
      "a tall jewel-box-like display cabinet visibly filled with books, glass vessels, framed keepsakes, folded textiles, drawers, plants, and tiny warm lamps, richly layered but readable, adapted to the requested territory",
    sizePx: { height: 192, width: 144 },
  },
  {
    capabilities: ["inspectable", "light"],
    collisionCells: bottomRows(4, 7, 1),
    depthMode: "sorted",
    description: "雕塑感的落地照明主件。",
    footprint: { height: 7, width: 4 },
    key: "sculptural-light",
    layer: "object",
    name: "雕塑落地灯",
    placements: [{ point: { x: 12, y: 9 } }],
    prompt:
      "a sculptural floor light with layered glass, metal, and magical warm glow, adapted to the requested territory",
    sizePx: { height: 168, width: 96 },
  },
  {
    capabilities: ["inspectable", "seatable"],
    collisionCells: bottomRows(10, 7, 2),
    depthMode: "sorted",
    description: "适合长期生活的会客座椅组合。",
    footprint: { height: 7, width: 10 },
    key: "lounge-seat",
    layer: "object",
    name: "层叠会客座椅",
    placements: [{ point: { x: 17, y: 14 } }],
    prompt:
      "a sumptuous asymmetric sofa with five to seven mismatched embroidered cushions, a draped patterned blanket, an open book, a small cherished plush or travel satchel, tassels, and a clear elegant silhouette, all details resting naturally on the seat, adapted to the requested territory",
    sizePx: { height: 168, width: 240 },
  },
  {
    capabilities: ["inspectable"],
    collisionCells: bottomRows(8, 6, 2),
    depthMode: "sorted",
    description: "细节丰富但保持清晰轮廓的创作工作区。",
    footprint: { height: 6, width: 8 },
    key: "studio-desk",
    layer: "object",
    name: "精致创作工作台",
    placements: [{ point: { x: 35, y: 10 } }],
    prompt:
      "a beautiful ornate working desk densely but deliberately arranged with stacked books, parchment, ink, brass tools, glass vessels, pressed flowers, candles, pinned notes, and an unfinished craft, with the furniture silhouette still readable, adapted to the requested territory",
    sizePx: { height: 144, width: 192 },
  },
  {
    capabilities: ["inspectable"],
    collisionCells: bottomRows(5, 9, 2),
    depthMode: "sorted",
    description: "连接两个生活角落的通透竖向景观。",
    footprint: { height: 9, width: 5 },
    key: "garden-divider",
    layer: "object",
    name: "通透花园隔景",
    placements: [{ point: { x: 30, y: 11 } }],
    prompt:
      "a tall airy room divider or garden arch combining crafted structure and cascading botanical detail, adapted to the requested territory",
    sizePx: { height: 216, width: 120 },
  },
  {
    capabilities: ["inspectable"],
    collisionCells: bottomRows(7, 5, 2),
    depthMode: "sorted",
    description: "作为房间中央生活焦点的矮桌组合。",
    footprint: { height: 5, width: 7 },
    key: "central-table",
    layer: "object",
    name: "中央茶叙矮桌",
    placements: [{ point: { x: 20, y: 22 } }],
    prompt:
      "a gorgeous low central tea table with a lavish integrated tabletop arrangement of a complete tea service, small pastries, stacked books, flowers, candles, gemstones, and personal trinkets, balanced and readable, adapted to the requested territory",
    sizePx: { height: 120, width: 168 },
  },
  {
    capabilities: ["inspectable", "seatable"],
    collisionCells: bottomRows(7, 7, 2),
    depthMode: "sorted",
    description: "靠近主休憩区、被织物和阅读痕迹包围的独立座位。",
    footprint: { height: 7, width: 7 },
    key: "reading-chair-nest",
    layer: "object",
    name: "织物阅读角",
    placements: [{ point: { x: 2, y: 22 } }],
    prompt:
      "one jewel-toned reading chair nest with carved wood, several embroidered cushions, a cascading blanket, an open book, spectacles, a small side pocket, and a tiny footrest integrated into one coherent furnishing cluster",
    sizePx: { height: 168, width: 168 },
  },
  {
    capabilities: ["inspectable", "light"],
    collisionCells: bottomRows(5, 5, 1),
    depthMode: "sorted",
    description: "把小灯、鲜花、书与私人物件组合成一处精致生活切片。",
    footprint: { height: 5, width: 5 },
    key: "side-table-vignette",
    layer: "object",
    name: "繁盛边几小景",
    placements: [{ point: { x: 28, y: 22 } }],
    prompt:
      "one ornate side table vignette carrying a glowing stained-glass lamp, flowers in a patterned vase, stacked books, a framed keepsake, a cup, jewelry dish, and trailing textile, composed as one coherent richly detailed asset",
    sizePx: { height: 120, width: 120 },
  },
  {
    capabilities: ["inspectable"],
    collisionCells: bottomRows(5, 6, 2),
    depthMode: "sorted",
    description: "装满茶具、瓶罐与宴客细节的可移动推车。",
    footprint: { height: 6, width: 5 },
    key: "bar-cart",
    layer: "object",
    name: "黄铜茶饮推车",
    placements: [{ point: { x: 41, y: 18 } }],
    prompt:
      "one elegant old-brass tea and drinks trolley crowded with patterned cups, glass bottles, a teapot, fruit, folded napkins, tiny jars, and hanging utensils, with wheels and silhouette clearly readable",
    sizePx: { height: 144, width: 120 },
  },
  {
    capabilities: ["inspectable", "seatable"],
    collisionCells: bottomRows(7, 4, 1),
    depthMode: "sorted",
    description: "自然散落却配色统一的坐垫、软毯与矮凳组合。",
    footprint: { height: 4, width: 7 },
    key: "floor-cushions",
    layer: "object",
    name: "层叠地垫软巢",
    placements: [{ point: { x: 11, y: 24 } }],
    prompt:
      "one inviting floor-cushion nest made from layered jewel-toned poufs, embroidered pillows, a folded quilt, tasseled throw, and a small tray, richly decorated yet forming one coherent low silhouette",
    sizePx: { height: 96, width: 168 },
  },
  {
    capabilities: ["inspectable", "light"],
    collisionCells: bottomRows(4, 9, 1),
    depthMode: "sorted",
    description: "反射暖灯与雨夜窗光的高挑穿衣镜。",
    footprint: { height: 9, width: 4 },
    key: "standing-mirror",
    layer: "object",
    name: "藤蔓黄铜立镜",
    placements: [{ point: { x: 35, y: 1 } }],
    prompt:
      "one tall ornate standing mirror with aged brass frame, carved celestial motifs, delicate vines, bead strands, a small pinned note, and reflected abstract warm lights only, no person or character",
    sizePx: { height: 216, width: 96 },
  },
  {
    capabilities: ["inspectable"],
    collisionCells: [],
    depthMode: "sorted",
    description: "由织毯、画框、挂盘、照片和小吊饰组成的墙面收藏。",
    footprint: { height: 8, width: 9 },
    key: "wall-tapestry-gallery",
    layer: "object",
    name: "星图织毯收藏墙",
    placements: [{ point: { x: 2, y: 2 } }],
    prompt:
      "one cohesive wall-mounted gallery cluster combining a richly patterned celestial tapestry, mismatched carved frames, decorative plates, pressed flowers, tiny photographs without legible faces, beads, and hanging keepsakes",
    sizePx: { height: 192, width: 216 },
  },
  {
    capabilities: ["inspectable"],
    collisionCells: bottomRows(8, 6, 2),
    depthMode: "sorted",
    description: "铺满植物、标本瓶和旅途纪念物的细长玄关台。",
    footprint: { height: 6, width: 8 },
    key: "botanical-console",
    layer: "object",
    name: "植物标本玄关台",
    placements: [{ point: { x: 32, y: 20 } }],
    prompt:
      "one elegant narrow console table laden with cascading plants, specimen bottles, a terrarium, travel souvenirs, candles, small drawers, folded letters, and a patterned runner, forming a lush but readable composition",
    sizePx: { height: 144, width: 192 },
  },
  {
    capabilities: ["inspectable"],
    collisionCells: bottomRows(6, 4, 2),
    depthMode: "sorted",
    description: "带贴纸、绑带与叠放软物的旧旅行箱组合。",
    footprint: { height: 4, width: 6 },
    key: "luggage-trunk",
    layer: "object",
    name: "旅行箱与收藏软垫",
    placements: [{ point: { x: 35, y: 26 } }],
    prompt:
      "one charming stack of aged travel trunks with brass corners, straps, abstract stickers, a folded embroidered shawl, hat, small parcel, and keepsake box arranged as one coherent low furnishing asset",
    sizePx: { height: 96, width: 144 },
  },
  {
    capabilities: ["inspectable"],
    collisionCells: [],
    depthMode: "flat",
    description: "统一主空间色彩与构图的大型织物铺层。",
    footprint: { height: 14, width: 21 },
    key: "grand-rug",
    layer: "underlay",
    name: "华丽主厅织毯",
    placements: [{ point: { x: 13, y: 13 } }],
    prompt:
      "one magnificent large floor rug with intricate border, subtle wear, and a strong but harmonious pattern, adapted to the requested territory",
    sizePx: { height: 336, width: 504 },
  },
  {
    capabilities: ["ambient-animation", "light"],
    collisionCells: [],
    depthMode: "overlay",
    description: "悬于上方、形成光影节奏的装饰与灯光。",
    footprint: { height: 6, width: 18 },
    key: "overhead-light",
    layer: "effect",
    name: "星辉顶灯与垂饰",
    placements: [{ point: { x: 15, y: 0 } }],
    prompt:
      "one wide overhead chandelier and hanging ornament cluster with elegant luminous rhythm, adapted to the requested territory",
    sizePx: { height: 144, width: 432 },
  },
  {
    capabilities: ["ambient-animation"],
    collisionCells: [],
    depthMode: "overlay",
    description: "从两侧拱形窗垂落的多层帘幕、珠链与流苏。",
    footprint: { height: 12, width: 10 },
    key: "window-drapery",
    layer: "foreground",
    name: "华丽拱窗帘幕",
    placements: [
      { point: { x: 0, y: 0 } },
      { flipped: true, point: { x: 38, y: 0 } },
    ],
    prompt:
      "one luxurious tall window-side drapery cluster with layered velvet and sheer fabric, embroidered celestial borders, bead chains, tassels, leaf garlands, and tiny warm lights, designed to frame either side when mirrored",
    sizePx: { height: 288, width: 240 },
  },
  {
    capabilities: ["ambient-animation"],
    collisionCells: [],
    depthMode: "overlay",
    description: "从画面两侧进入前景的植物与帘幕构图。",
    footprint: { height: 9, width: 7 },
    key: "foreground-botanical",
    layer: "foreground",
    name: "前景植物帘幕",
    placements: [
      { point: { x: 0, y: 20 } },
      { flipped: true, point: { x: 41, y: 20 } },
    ],
    prompt:
      "one lush vertical foreground botanical and textile framing cluster designed to work on either side when mirrored, adapted to the requested territory",
    sizePx: { height: 216, width: 168 },
  },
];

const GENERATED_ZONE_REFERENCE_SIZE = { height: 30, width: 48 } as const;

function scaleZonePlacement(
  point: TerritoryGridPoint,
  footprint: { readonly height: number; readonly width: number },
  zone: TerritoryZone,
): TerritoryGridPoint {
  const referenceMaxX = Math.max(
    1,
    GENERATED_ZONE_REFERENCE_SIZE.width - footprint.width,
  );
  const referenceMaxY = Math.max(
    1,
    GENERATED_ZONE_REFERENCE_SIZE.height - footprint.height,
  );
  const maxX = Math.max(0, zone.bounds.width - footprint.width);
  const maxY = Math.max(0, zone.bounds.height - footprint.height);
  return {
    x: Math.min(
      maxX,
      Math.max(0, Math.round((point.x / referenceMaxX) * maxX)),
    ),
    y: Math.min(
      maxY,
      Math.max(0, Math.round((point.y / referenceMaxY) * maxY)),
    ),
  };
}

function findNearestZonePlacement(input: {
  readonly collisionCells: readonly TerritoryGridPoint[];
  readonly desired: TerritoryGridPoint;
  readonly footprint: { readonly height: number; readonly width: number };
  readonly occupied: ReadonlySet<string>;
  readonly zone: TerritoryZone;
}): TerritoryGridPoint | null {
  const maxX = input.zone.bounds.width - input.footprint.width;
  const maxY = input.zone.bounds.height - input.footprint.height;
  if (maxX < 0 || maxY < 0) return null;
  const candidates = Array.from(
    { length: (maxX + 1) * (maxY + 1) },
    (_, index) => ({
      x: index % (maxX + 1),
      y: Math.floor(index / (maxX + 1)),
    }),
  ).sort((left, right) => {
    const leftDistance =
      Math.abs(left.x - input.desired.x) + Math.abs(left.y - input.desired.y);
    const rightDistance =
      Math.abs(right.x - input.desired.x) + Math.abs(right.y - input.desired.y);
    return leftDistance - rightDistance || left.y - right.y || left.x - right.x;
  });
  return (
    candidates.find((point) =>
      input.collisionCells.every(
        (cell) =>
          !input.occupied.has(
            `${String(point.x + cell.x)},${String(point.y + cell.y)}`,
          ),
      ),
    ) ?? null
  );
}

function generatedZonePieceRequest(
  context: GenerationContext,
  spec: GeneratedZonePieceSpec,
): TerritoryCreateChangeCandidateRequest {
  return {
    ...context.request,
    intent: "item",
    prompt: [
      "Use case: production game asset for an editable 2.5D life-sim Territory.",
      `Primary request: ${spec.prompt}.`,
      `Territory art direction: ${context.request.prompt}`,
      "Composition: one complete, centered furnishing cluster with a clear silhouette and ground contact; keep every named detail physically connected to the main asset.",
      "Style: richly layered, premium pixel art with crisp clusters, coherent elevated viewing angle, and the same lighting and material language as the Territory.",
      "Constraints: generate only this asset; no room, floor, background scenery, character, pet, text, UI, border, watermark, duplicate, or unrelated loose prop.",
    ].join("\n"),
  };
}

function latestRevision(
  definitions: readonly TerritoryDefinition[],
  definitionId: string,
): number {
  return definitions.reduce(
    (latest, definition) =>
      definition.id === definitionId
        ? Math.max(latest, definition.revision)
        : latest,
    0,
  );
}

function instanceName(prompt: string): string {
  const compact = prompt.replace(/\s+/gu, " ").trim();
  return compact.length > 18 ? `${compact.slice(0, 18)}…` : compact;
}

function activeInstance(
  id: string,
  definition: TerritoryDefinition,
  now: string,
  sources: TerritoryInstance["sources"],
  placement: TerritoryInstance["placement"],
): TerritoryInstance {
  return {
    createdAt: now,
    definition: { id: definition.id, revision: definition.revision },
    favorite: false,
    groupId: null,
    id,
    locked: false,
    placement,
    sources,
    status: "active",
    trashedAt: null,
    updatedAt: now,
  };
}

function collectionPlacement(
  instance: TerritoryInstance,
  now: string,
): TerritoryInstance {
  return {
    ...instance,
    groupId: null,
    placement: { kind: "collection" },
    updatedAt: now,
  };
}

function findOpenPoint(
  view: TerritoryZoneView,
  definitions: readonly TerritoryDefinition[],
  width: number,
  height: number,
  collisionCells: readonly TerritoryGridPoint[],
): TerritoryGridPoint | null {
  const byKey = new Map(
    definitions.map((definition) => [definitionKey(definition), definition]),
  );
  const occupied = new Set<string>();
  for (const instance of view.instances) {
    const definition = byKey.get(definitionKey(instance.definition));
    if (!definition) continue;
    for (const point of territoryInstanceCollisionCells(instance, definition)) {
      occupied.add(`${String(point.x)},${String(point.y)}`);
    }
  }
  if (view.pet)
    occupied.add(`${String(view.pet.point.x)},${String(view.pet.point.y)}`);
  for (
    let y = Math.max(0, Math.floor(view.zone.bounds.height / 2));
    y <= view.zone.bounds.height - height;
    y += 1
  ) {
    for (let x = 0; x <= view.zone.bounds.width - width; x += 1) {
      const free = collisionCells.every(
        (cell) => !occupied.has(`${String(x + cell.x)},${String(y + cell.y)}`),
      );
      if (free) return { x, y };
    }
  }
  return null;
}

function findOpenAttachmentPlacement(
  view: TerritoryZoneView,
  definitions: readonly TerritoryDefinition[],
  allowedAnchors: readonly string[],
  size: { readonly height: number; readonly width: number },
): TerritoryInstance["placement"] | null {
  const byKey = new Map(
    definitions.map((definition) => [definitionKey(definition), definition]),
  );
  const occupiedAnchors = new Set(
    view.instances.flatMap((instance) =>
      instance.placement.kind === "attachment"
        ? [
            `${instance.placement.parentInstanceId}:${instance.placement.anchorId}`,
          ]
        : [],
    ),
  );
  for (const parent of view.instances) {
    if (parent.placement.kind === "collection") continue;
    const definition = byKey.get(definitionKey(parent.definition));
    if (!definition) continue;
    const anchor = definition.anchors.find(
      (candidate) =>
        allowedAnchors.includes(candidate.kind) &&
        candidate.maxItemSizePx.width >= size.width &&
        candidate.maxItemSizePx.height >= size.height &&
        !occupiedAnchors.has(`${parent.id}:${candidate.id}`),
    );
    if (!anchor) continue;
    return {
      anchorId: anchor.id,
      flipped: false,
      kind: "attachment",
      offsetPx: { x: 0, y: 0 },
      parentInstanceId: parent.id,
      rotation: 0,
      zoneId: view.zone.id,
    };
  }
  return null;
}

function scopedInstances(
  request: TerritoryCreateChangeCandidateRequest,
  view: TerritoryZoneView,
): TerritoryInstance[] {
  if (request.scope.kind === "entities") {
    const ids = new Set(request.scope.instanceIds);
    return view.instances.filter((instance) => ids.has(instance.id));
  }
  if (request.scope.kind === "selection") {
    const { bounds } = request.scope;
    return view.instances.filter(
      (instance) =>
        instance.placement.kind === "zone" &&
        instance.placement.point.x >= bounds.x &&
        instance.placement.point.y >= bounds.y &&
        instance.placement.point.x < bounds.x + bounds.width &&
        instance.placement.point.y < bounds.y + bounds.height,
    );
  }
  return [];
}

function zoneForRequest(
  request: TerritoryCreateChangeCandidateRequest,
  snapshot: TerritoryWorldSnapshot,
): TerritoryZone {
  const zoneId =
    request.scope.kind === "expansion"
      ? request.scope.fromZoneId
      : request.scope.kind === "world"
        ? snapshot.world.activeZoneId
        : request.scope.zoneId;
  const zone = snapshot.world.zones.find(
    (candidate) => candidate.id === zoneId && candidate.status === "active",
  );
  if (!zone) {
    throw new TerritoryError(
      "TERRITORY.ZONE_NOT_FOUND",
      "找不到候选要修改的领地区域。",
      false,
    );
  }
  return zone;
}

function expansionGeometry(
  source: TerritoryZone,
  direction: "east" | "north" | "south" | "west",
): {
  readonly bounds: TerritoryZone["bounds"];
  readonly from: TerritoryGridPoint;
  readonly to: TerritoryGridPoint;
} {
  const middleX = Math.floor(source.bounds.width / 2);
  const middleY = Math.floor(source.bounds.height / 2);
  switch (direction) {
    case "north":
      return {
        bounds: { ...source.bounds, y: source.bounds.y - source.bounds.height },
        from: { x: middleX, y: 0 },
        to: { x: middleX, y: source.bounds.height - 1 },
      };
    case "east":
      return {
        bounds: { ...source.bounds, x: source.bounds.x + source.bounds.width },
        from: { x: source.bounds.width - 1, y: middleY },
        to: { x: 0, y: middleY },
      };
    case "south":
      return {
        bounds: { ...source.bounds, y: source.bounds.y + source.bounds.height },
        from: { x: middleX, y: source.bounds.height - 1 },
        to: { x: middleX, y: 0 },
      };
    case "west":
      return {
        bounds: { ...source.bounds, x: source.bounds.x - source.bounds.width },
        from: { x: 0, y: middleY },
        to: { x: source.bounds.width - 1, y: middleY },
      };
  }
}

export class TerritoryWorldCandidateService {
  readonly #controllers = new Map<string, AbortController>();

  constructor(
    private readonly repository: TerritoryWorldRepository,
    private readonly assets: TerritoryWorldAssetStore,
    private readonly runtimes: TerritoryWorldImageRuntimeFactory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly onSnapshotChanged: (
      snapshot: TerritoryWorldSnapshot,
    ) => void = () => undefined,
  ) {}

  recoverInterruptedCandidates(): number {
    const recovered = this.repository.recoverInterruptedCandidates(
      {
        code: "TERRITORY.GENERATION_INTERRUPTED",
        message: "上次领地创作被应用退出中断，可以重新生成。",
        retryable: true,
      },
      this.clock.now(),
    );
    if (recovered > 0) this.publish(this.repository.getSnapshot());
    return recovered;
  }

  async create(
    request: TerritoryCreateChangeCandidateRequest,
    signal?: AbortSignal,
  ): Promise<TerritoryCandidateMutationResult> {
    return this.beginCreate(request, signal).completion;
  }

  beginCreate(
    request: TerritoryCreateChangeCandidateRequest,
    signal?: AbortSignal,
  ): TerritoryWorldCandidateJob {
    const created = this.repository.createCandidate(request, this.clock.now());
    return this.beginExecution(created.candidateId, signal);
  }

  private beginExecution(
    candidateId: string,
    externalSignal?: AbortSignal,
    previousChangeSet: TerritoryWorldChangeSet | null = null,
    afterCompletion: () => Promise<void> = () => Promise.resolve(),
  ): TerritoryWorldCandidateJob {
    this.repository.markCandidateGenerating(candidateId, this.clock.now());
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    this.#controllers.set(candidateId, controller);
    const initial = {
      candidateId,
      snapshot: this.repository.getSnapshot(),
    };
    this.publish(initial.snapshot);
    const completion = new Promise<TerritoryCandidateMutationResult>(
      (resolve, reject) => {
        setImmediate(() => {
          void this.execute(candidateId, controller, previousChangeSet).then(
            resolve,
            reject,
          );
        });
      },
    ).finally(async () => {
      externalSignal?.removeEventListener("abort", abort);
      this.#controllers.delete(candidateId);
      await afterCompletion();
    });
    return { completion, initial };
  }

  private async execute(
    candidateId: string,
    controller: AbortController,
    previousChangeSet: TerritoryWorldChangeSet | null,
  ): Promise<TerritoryCandidateMutationResult> {
    const active = this.repository
      .getSnapshot()
      .candidates.find(({ id }) => id === candidateId);
    if (active?.status !== "generating" || controller.signal.aborted) {
      return { candidateId, snapshot: this.repository.getSnapshot() };
    }
    const work = this.repository.getCandidateWork(candidateId);
    const installed: PreparedTerritoryWorldAsset[] = [];
    try {
      const snapshot = this.repository.getSnapshot();
      const zone = zoneForRequest(work.request, snapshot);
      const view = this.repository.getZoneView({
        revisionId: work.request.baseRevisionId,
        zoneId: zone.id,
      });
      const style = view.style;
      const profileId = this.runtimes.resolveImageProfileId(
        work.request.providerProfileId ?? undefined,
      );
      this.repository.setCandidateProviderProfile(
        candidateId,
        profileId,
        this.clock.now(),
      );
      this.publish(this.repository.getSnapshot());
      const provider = await this.runtimes.createImageProvider(profileId);
      const context: GenerationContext = {
        request: { ...work.request, providerProfileId: profileId },
        snapshot,
        style,
        view,
        zone,
      };
      const generatedPlan = await this.generatePlan(
        candidateId,
        context,
        provider,
        work.edit?.instruction ?? null,
        controller.signal,
        installed,
      );
      const plan = reconcileCandidatePlan(
        generatedPlan,
        previousChangeSet,
        work.edit?.excludedChangeIds ?? [],
      );
      const completed = this.repository.completeCandidate(
        candidateId,
        plan.changeSet,
        plan.previewGroups,
        this.clock.now(),
      );
      this.publish(completed);
      return { candidateId, snapshot: completed };
    } catch (error) {
      await this.rollback(installed);
      const candidate = this.repository
        .getSnapshot()
        .candidates.find(({ id }) => id === candidateId);
      if (candidate?.status === "generating") {
        const snapshot = this.repository.failCandidate(
          candidateId,
          failure(error),
          this.clock.now(),
        );
        this.publish(snapshot);
        return {
          candidateId,
          snapshot,
        };
      }
      return { candidateId, snapshot: this.repository.getSnapshot() };
    }
  }

  async edit(
    request: TerritoryEditChangeCandidateRequest,
  ): Promise<TerritoryCandidateMutationResult> {
    return this.beginEdit(request).completion;
  }

  beginEdit(
    request: TerritoryEditChangeCandidateRequest,
  ): TerritoryWorldCandidateJob {
    const previousCandidate = this.repository
      .getSnapshot()
      .candidates.find(({ id }) => id === request.candidateId);
    const previous = this.candidateAssetIds(request.candidateId);
    const edited = this.repository.editCandidate(request, this.clock.now());
    return this.beginExecution(
      edited.candidateId,
      undefined,
      previousCandidate?.changeSet ?? null,
      () => this.removeOrphanAssets(previous),
    );
  }

  async cancelCandidate(
    candidateId: string,
  ): Promise<TerritoryCandidateMutationResult> {
    const previous = this.candidateAssetIds(candidateId);
    this.cancel(candidateId);
    const snapshot = this.repository.cancelCandidate(
      candidateId,
      this.clock.now(),
    );
    await this.removeOrphanAssets(previous);
    this.publish(snapshot);
    return { candidateId, snapshot };
  }

  cancel(candidateId: string): void {
    this.#controllers.get(candidateId)?.abort();
  }

  private async generatePlan(
    candidateId: string,
    context: GenerationContext,
    provider: Awaited<
      ReturnType<TerritoryWorldImageRuntimeFactory["createImageProvider"]>
    >,
    editInstruction: string | null,
    signal: AbortSignal,
    installed: PreparedTerritoryWorldAsset[],
  ): Promise<GeneratedPlan> {
    switch (context.request.intent) {
      case "item":
        return this.generateItem(
          candidateId,
          context,
          provider,
          editInstruction,
          signal,
          installed,
        );
      case "selection":
        return this.generateSelection(
          candidateId,
          context,
          provider,
          editInstruction,
          signal,
          installed,
        );
      case "zone":
        return this.generateZone(
          candidateId,
          context,
          provider,
          editInstruction,
          signal,
          installed,
        );
      case "expansion":
        return this.generateExpansion(
          candidateId,
          context,
          provider,
          editInstruction,
          signal,
          installed,
        );
    }
  }

  private async renderAndInstall(input: {
    readonly assetId: string;
    readonly candidate: TerritoryChangeCandidate;
    readonly context: GenerationContext;
    readonly definition?: TerritoryDefinition;
    readonly editInstruction: string | null;
    readonly options: TerritoryImageRenderOptions;
    readonly origin: "edited" | "generated";
    readonly outputSize: { readonly height: number; readonly width: number };
    readonly removeBackground: boolean;
    readonly provider: Awaited<
      ReturnType<TerritoryWorldImageRuntimeFactory["createImageProvider"]>
    >;
    readonly signal: AbortSignal;
    readonly source?: Buffer;
  }): Promise<PreparedTerritoryWorldAsset> {
    const prompt = buildTerritoryWorldImagePrompt({
      candidate: input.candidate,
      ...(input.definition ? { definition: input.definition } : {}),
      editInstruction: input.editInstruction,
      style: input.context.style,
      zone: input.context.zone,
    });
    const generated = input.source
      ? await input.provider.edit(
          input.source,
          prompt,
          input.options,
          input.signal,
        )
      : await input.provider.generate(prompt, input.options, input.signal);
    const prepared = await this.assets.prepareInstall({
      assetId: input.assetId,
      createdAt: this.clock.now(),
      origin: input.origin,
      removeBackground: input.removeBackground,
      size: input.outputSize,
      source: generated,
    });
    try {
      this.repository.installAsset(prepared);
    } catch (error) {
      await this.assets.rollback(prepared);
      throw error;
    }
    return prepared;
  }

  private candidateModel(
    candidateId: string,
    request: TerritoryCreateChangeCandidateRequest,
  ): TerritoryChangeCandidate {
    const now = this.clock.now();
    return {
      appliedRevisionId: null,
      baseRevisionId: request.baseRevisionId,
      changeSet: null,
      createdAt: now,
      error: null,
      id: candidateId,
      intent: request.intent,
      lockedInstanceIds: request.lockedInstanceIds,
      previewGroups: [],
      prompt: request.prompt,
      providerProfileId: request.providerProfileId,
      scope: request.scope,
      sources: request.sources,
      status: "generating",
      updatedAt: now,
    };
  }

  private async generateItem(
    candidateId: string,
    context: GenerationContext,
    provider: Awaited<
      ReturnType<TerritoryWorldImageRuntimeFactory["createImageProvider"]>
    >,
    editInstruction: string | null,
    signal: AbortSignal,
    installed: PreparedTerritoryWorldAsset[],
  ): Promise<GeneratedPlan> {
    const now = this.clock.now();
    const definitionId = `generated.item.${candidateId}`;
    const assetId = `generated.asset.${this.ids.generate()}`;
    const archetype = classifyTerritoryWorldItem(context.request.prompt);
    const placementRule: TerritoryDefinition["placement"] =
      archetype.placement.kind === "attachment"
        ? {
            allowedAnchors: [...archetype.placement.allowedAnchors],
            attachmentAnchorPx: archetype.placement.attachmentAnchorPx,
            mode: "attachment",
          }
        : {
            collisionCells: [...archetype.placement.collisionCells],
            footprintCells: rectangle(
              archetype.placement.footprint.width,
              archetype.placement.footprint.height,
            ),
            mode: "grid",
          };
    const definition: TerritoryDefinition = {
      anchors: [],
      capabilities: context.request.sources.length
        ? ["inspectable", "memory-reveal"]
        : ["inspectable"],
      createdAt: now,
      description: context.request.prompt,
      id: definitionId,
      layer: archetype.layer,
      name: instanceName(context.request.prompt) || "新创作物件",
      placement: placementRule,
      revision: 1,
      schemaVersion: 3,
      tags: [
        "generated",
        ...archetype.tags,
        ...(context.request.sources.length ? ["memory"] : []),
      ],
      transforms: {
        flippable: true,
        rotations:
          archetype.placement.kind === "attachment" ? [0] : [0, 90, 180, 270],
      },
      visual: {
        assetId,
        depthAnchorPx:
          archetype.placement.kind === "attachment"
            ? archetype.placement.attachmentAnchorPx
            : {
                x: archetype.sizePx.width / 2,
                y: archetype.sizePx.height,
              },
        depthMode: archetype.depthMode,
        frame: null,
        sizePx: archetype.sizePx,
      },
    };
    const prepared = await this.renderAndInstall({
      assetId,
      candidate: this.candidateModel(candidateId, context.request),
      context,
      definition,
      editInstruction,
      options: itemRenderOptions,
      origin: editInstruction ? "edited" : "generated",
      outputSize: definition.visual.sizePx,
      removeBackground: true,
      provider,
      signal,
    });
    installed.push(prepared);
    const pack = generatedAssetPack({
      assets: [{ assetId, key: "item.primary", layer: definition.layer }],
      candidateId,
      createdAt: now,
      name: `${definition.name}素材包`,
      style: context.style,
    });
    const placement =
      archetype.placement.kind === "attachment"
        ? findOpenAttachmentPlacement(
            context.view,
            context.snapshot.definitions,
            archetype.placement.allowedAnchors,
            archetype.sizePx,
          )
        : (() => {
            const point = findOpenPoint(
              context.view,
              context.snapshot.definitions,
              archetype.placement.footprint.width,
              archetype.placement.footprint.height,
              archetype.placement.collisionCells,
            );
            return point
              ? {
                  flipped: false as const,
                  kind: "zone" as const,
                  offsetPx: { x: 0, y: 0 },
                  point,
                  rotation: 0 as const,
                  zoneId: context.zone.id,
                }
              : null;
          })();
    const instance = activeInstance(
      this.ids.generate(),
      definition,
      now,
      context.request.sources,
      placement ?? { kind: "collection" },
    );
    const mutations: TerritoryWorldMutation[] = [
      {
        assetPack: pack,
        changeId: this.ids.generate(),
        kind: "asset-pack.put",
      },
      { changeId: this.ids.generate(), definition, kind: "definition.put" },
      { changeId: this.ids.generate(), instance, kind: "instance.put" },
    ];
    return {
      changeSet: {
        baseRevisionId: context.request.baseRevisionId,
        id: this.ids.generate(),
        label: `创作「${definition.name}」`,
        mutations,
      },
      previewGroups: [
        {
          action: "add",
          changeIds: mutations.map(({ changeId }) => changeId),
          instanceIds: [instance.id],
          label: placement
            ? archetype.placement.kind === "attachment"
              ? "挂到当前区域的可用承载点"
              : "加入当前区域"
            : "加入收藏库（当前区域暂无合适位置）",
        },
      ],
    };
  }

  private async generateSelection(
    candidateId: string,
    context: GenerationContext,
    provider: Awaited<
      ReturnType<TerritoryWorldImageRuntimeFactory["createImageProvider"]>
    >,
    editInstruction: string | null,
    signal: AbortSignal,
    installed: PreparedTerritoryWorldAsset[],
  ): Promise<GeneratedPlan> {
    const extraLocks = new Set(context.request.lockedInstanceIds);
    const selected = scopedInstances(context.request, context.view).filter(
      (instance) => !instance.locked && !extraLocks.has(instance.id),
    );
    if (selected.length === 0) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "当前选择中没有可重绘的物件。",
        false,
      );
    }
    const definitions = new Map(
      context.snapshot.definitions.map((definition) => [
        definitionKey(definition),
        definition,
      ]),
    );
    const selectedByDefinition = new Map<string, TerritoryInstance[]>();
    for (const instance of selected) {
      const key = definitionKey(instance.definition);
      const group = selectedByDefinition.get(key) ?? [];
      group.push(instance);
      selectedByDefinition.set(key, group);
    }
    const mutations: TerritoryWorldMutation[] = [];
    const replacedIds: string[] = [];
    for (const [key, instances] of selectedByDefinition) {
      const sourceDefinition = definitions.get(key);
      if (!sourceDefinition) continue;
      const revision =
        latestRevision(context.snapshot.definitions, sourceDefinition.id) + 1;
      const assetId = `edited.asset.${this.ids.generate()}`;
      const stored = this.repository.getStoredAsset(
        sourceDefinition.visual.assetId,
      );
      const source =
        stored?.asset.origin === "generated" ||
        stored?.asset.origin === "edited"
          ? await this.assets.read(stored)
          : undefined;
      const nextDefinition: TerritoryDefinition = {
        ...sourceDefinition,
        createdAt: this.clock.now(),
        description: `${sourceDefinition.description}；外观修改：${editInstruction ?? context.request.prompt}`,
        revision,
        visual: { ...sourceDefinition.visual, assetId },
      };
      const prepared = await this.renderAndInstall({
        assetId,
        candidate: this.candidateModel(candidateId, context.request),
        context,
        definition: sourceDefinition,
        editInstruction,
        options: itemRenderOptions,
        origin: "edited",
        outputSize: sourceDefinition.visual.sizePx,
        removeBackground: true,
        provider,
        signal,
        ...(source ? { source } : {}),
      });
      installed.push(prepared);
      mutations.push({
        changeId: this.ids.generate(),
        definition: nextDefinition,
        kind: "definition.put",
      });
      for (const instance of instances) {
        replacedIds.push(instance.id);
        mutations.push({
          changeId: this.ids.generate(),
          instance: {
            ...instance,
            definition: {
              id: nextDefinition.id,
              revision: nextDefinition.revision,
            },
            updatedAt: this.clock.now(),
          },
          kind: "instance.put",
        });
      }
    }
    if (!mutations.length) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "选择中的物件缺少可编辑 Definition。",
        false,
      );
    }
    const pack = generatedAssetPack({
      assets: mutations.flatMap((mutation, index) =>
        mutation.kind === "definition.put"
          ? [
              {
                assetId: mutation.definition.visual.assetId,
                key: `selection.${String(index + 1)}`,
                layer: mutation.definition.layer,
              },
            ]
          : [],
      ),
      candidateId,
      createdAt: this.clock.now(),
      name: "选区协调素材包",
      style: context.style,
    });
    mutations.unshift({
      assetPack: pack,
      changeId: this.ids.generate(),
      kind: "asset-pack.put",
    });
    return {
      changeSet: {
        baseRevisionId: context.request.baseRevisionId,
        id: this.ids.generate(),
        label: `重绘 ${String(replacedIds.length)} 件物件`,
        mutations,
      },
      previewGroups: [
        {
          action: "replace",
          changeIds: mutations.map(({ changeId }) => changeId),
          instanceIds: replacedIds,
          label: "替换所选物件外观",
        },
      ],
    };
  }

  private backgroundDefinition(input: {
    readonly assetId: string;
    readonly candidateId: string;
    readonly footprint: TerritoryGridPoint[];
    readonly name: string;
    readonly size: { readonly height: number; readonly width: number };
  }): TerritoryDefinition {
    return {
      anchors: [],
      capabilities: ["inspectable"],
      createdAt: this.clock.now(),
      description: "AI 生成的可编辑区域基础环境。",
      id: `generated.background.${input.candidateId}`,
      layer: "structure",
      name: input.name,
      placement: {
        collisionCells: [],
        footprintCells: input.footprint,
        mode: "grid",
      },
      revision: 1,
      schemaVersion: 3,
      tags: ["generated", "background", "environment"],
      transforms: { flippable: false, rotations: [0] },
      visual: {
        assetId: input.assetId,
        depthAnchorPx: { x: input.size.width / 2, y: input.size.height },
        depthMode: "flat",
        frame: null,
        sizePx: input.size,
      },
    };
  }

  private async generateZone(
    candidateId: string,
    context: GenerationContext,
    provider: Awaited<
      ReturnType<TerritoryWorldImageRuntimeFactory["createImageProvider"]>
    >,
    editInstruction: string | null,
    signal: AbortSignal,
    installed: PreparedTerritoryWorldAsset[],
  ): Promise<GeneratedPlan> {
    const definitions = new Map(
      context.view.definitions.map((definition) => [
        definitionKey(definition),
        definition,
      ]),
    );
    const extraLocks = new Set(context.request.lockedInstanceIds);
    const structures = context.view.instances.filter(
      (instance) =>
        definitions.get(definitionKey(instance.definition))?.layer ===
        "structure",
    );
    const preserved = structures.filter(
      (instance) => instance.locked || extraLocks.has(instance.id),
    );
    const occupied = new Set<string>();
    for (const instance of preserved) {
      const definition = definitions.get(definitionKey(instance.definition));
      if (!definition) continue;
      for (const point of territoryInstanceFootprint(instance, definition)) {
        occupied.add(`${String(point.x)},${String(point.y)}`);
      }
    }
    const footprint = rectangle(
      context.zone.bounds.width,
      context.zone.bounds.height,
    ).filter((point) => !occupied.has(`${String(point.x)},${String(point.y)}`));
    if (!footprint.length) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "锁定的结构已经覆盖整个区域，没有可重绘空间。",
        false,
      );
    }
    const assetId = `generated.asset.${this.ids.generate()}`;
    const size = {
      height: context.zone.bounds.height * TERRITORY_WORLD_UNIT_PX,
      width: context.zone.bounds.width * TERRITORY_WORLD_UNIT_PX,
    };
    const definition = this.backgroundDefinition({
      assetId,
      candidateId,
      footprint,
      name: `${context.zone.name} · 新环境`,
      size,
    });
    const prepared = await this.renderAndInstall({
      assetId,
      candidate: this.candidateModel(candidateId, context.request),
      context,
      editInstruction,
      options: zoneRenderOptions,
      origin: editInstruction ? "edited" : "generated",
      outputSize: size,
      removeBackground: false,
      provider,
      signal,
    });
    installed.push(prepared);
    const now = this.clock.now();
    const background = activeInstance(
      this.ids.generate(),
      definition,
      now,
      context.request.sources,
      {
        flipped: false,
        kind: "zone",
        offsetPx: { x: 0, y: 0 },
        point: { x: 0, y: 0 },
        rotation: 0,
        zoneId: context.zone.id,
      },
    );
    const replaced = context.view.instances.filter((instance) => {
      const sourceDefinition = definitions.get(
        definitionKey(instance.definition),
      );
      return (
        sourceDefinition?.layer !== "terrain" &&
        !instance.locked &&
        !extraLocks.has(instance.id)
      );
    });
    const replacedIds = new Set(replaced.map(({ id }) => id));
    const collisionOccupancy = new Set<string>();
    for (const instance of context.view.instances) {
      if (replacedIds.has(instance.id)) continue;
      const sourceDefinition = definitions.get(
        definitionKey(instance.definition),
      );
      if (!sourceDefinition) continue;
      for (const point of territoryInstanceCollisionCells(
        instance,
        sourceDefinition,
      )) {
        collisionOccupancy.add(`${String(point.x)},${String(point.y)}`);
      }
    }
    if (context.view.pet) {
      collisionOccupancy.add(
        `${String(context.view.pet.point.x)},${String(context.view.pet.point.y)}`,
      );
    }

    const generatedDefinitions: TerritoryDefinition[] = [];
    const generatedInstances: TerritoryInstance[] = [];
    const generatedAssets: TerritoryAssetPack["assets"] = [
      { assetId, key: "zone.background", layer: "structure" },
    ];
    for (const spec of generatedZonePieceSpecs) {
      const pieceAssetId = `generated.asset.${this.ids.generate()}`;
      const pieceDefinition: TerritoryDefinition = {
        anchors: [],
        capabilities: [...spec.capabilities],
        createdAt: now,
        description: `${spec.description}；生成主题：${context.request.prompt}`,
        id: `generated.zone-piece.${candidateId}.${spec.key}`,
        layer: spec.layer,
        name: spec.name,
        placement:
          spec.layer === "foreground" || spec.layer === "effect"
            ? { mode: "free" }
            : {
                collisionCells: [...spec.collisionCells],
                footprintCells: rectangle(
                  spec.footprint.width,
                  spec.footprint.height,
                ),
                mode: "grid",
              },
        revision: 1,
        schemaVersion: 3,
        tags: ["generated", "zone-piece", spec.key],
        transforms: { flippable: true, rotations: [0] },
        visual: {
          assetId: pieceAssetId,
          depthAnchorPx: {
            x: spec.sizePx.width / 2,
            y: spec.sizePx.height,
          },
          depthMode: spec.depthMode,
          frame: null,
          sizePx: spec.sizePx,
        },
      };
      const piecePrepared = await this.renderAndInstall({
        assetId: pieceAssetId,
        candidate: this.candidateModel(
          candidateId,
          generatedZonePieceRequest(context, spec),
        ),
        context,
        definition: pieceDefinition,
        editInstruction,
        options: zonePieceRenderOptions,
        origin: editInstruction ? "edited" : "generated",
        outputSize: spec.sizePx,
        removeBackground: true,
        provider,
        signal,
      });
      installed.push(piecePrepared);
      generatedDefinitions.push(pieceDefinition);
      generatedAssets.push({
        assetId: pieceAssetId,
        key: `zone.piece.${spec.key}`,
        layer: spec.layer,
      });
      for (const desiredPlacement of spec.placements) {
        const desired = scaleZonePlacement(
          desiredPlacement.point,
          spec.footprint,
          context.zone,
        );
        const point = findNearestZonePlacement({
          collisionCells: spec.collisionCells,
          desired,
          footprint: spec.footprint,
          occupied: collisionOccupancy,
          zone: context.zone,
        });
        const instance = activeInstance(
          this.ids.generate(),
          pieceDefinition,
          now,
          context.request.sources,
          point
            ? {
                flipped: desiredPlacement.flipped ?? false,
                kind: "zone",
                offsetPx: { x: 0, y: 0 },
                point,
                rotation: 0,
                zoneId: context.zone.id,
              }
            : { kind: "collection" },
        );
        generatedInstances.push(instance);
        if (point) {
          for (const cell of territoryInstanceCollisionCells(
            instance,
            pieceDefinition,
          )) {
            collisionOccupancy.add(`${String(cell.x)},${String(cell.y)}`);
          }
        }
      }
    }

    const definitionMutation: TerritoryWorldMutation = {
      changeId: this.ids.generate(),
      definition,
      kind: "definition.put",
    };
    const pieceDefinitionMutations: TerritoryWorldMutation[] =
      generatedDefinitions.map((pieceDefinition) => ({
        changeId: this.ids.generate(),
        definition: pieceDefinition,
        kind: "definition.put" as const,
      }));
    const movedMutations: TerritoryWorldMutation[] = replaced.map(
      (instance) => ({
        changeId: this.ids.generate(),
        instance: collectionPlacement(instance, now),
        kind: "instance.put" as const,
      }),
    );
    const backgroundMutation: TerritoryWorldMutation = {
      changeId: this.ids.generate(),
      instance: background,
      kind: "instance.put",
    };
    const pieceInstanceMutations: TerritoryWorldMutation[] =
      generatedInstances.map((instance) => ({
        changeId: this.ids.generate(),
        instance,
        kind: "instance.put" as const,
      }));
    const assetPackMutation: TerritoryWorldMutation = {
      assetPack: generatedAssetPack({
        assets: generatedAssets,
        candidateId,
        createdAt: now,
        name: `${context.zone.name}完整生成素材包`,
        style: context.style,
      }),
      changeId: this.ids.generate(),
      kind: "asset-pack.put",
    };
    const mutations: TerritoryWorldMutation[] = [
      assetPackMutation,
      definitionMutation,
      ...pieceDefinitionMutations,
      ...movedMutations,
      backgroundMutation,
      ...pieceInstanceMutations,
    ];
    const generatedChangeIds = [
      assetPackMutation.changeId,
      definitionMutation.changeId,
      backgroundMutation.changeId,
      ...pieceDefinitionMutations.map(({ changeId }) => changeId),
      ...pieceInstanceMutations.map(({ changeId }) => changeId),
    ];
    return {
      changeSet: {
        baseRevisionId: context.request.baseRevisionId,
        id: this.ids.generate(),
        label: `改造「${context.zone.name}」环境`,
        mutations,
      },
      previewGroups: [
        {
          action: "replace",
          changeIds: generatedChangeIds,
          instanceIds: [
            background.id,
            ...generatedInstances.map(({ id }) => id),
          ],
          label: "完整生成环境与独立可编辑陈设",
        },
        ...(replaced.length
          ? [
              {
                action: "move" as const,
                changeIds: movedMutations.map(({ changeId }) => changeId),
                instanceIds: replaced.map(({ id }) => id),
                label: "原有可替换内容移回收藏库",
              },
            ]
          : []),
      ],
    };
  }

  private async generateExpansion(
    candidateId: string,
    context: GenerationContext,
    provider: Awaited<
      ReturnType<TerritoryWorldImageRuntimeFactory["createImageProvider"]>
    >,
    editInstruction: string | null,
    signal: AbortSignal,
    installed: PreparedTerritoryWorldAsset[],
  ): Promise<GeneratedPlan> {
    if (context.request.scope.kind !== "expansion") {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "扩建候选缺少连接方向。",
        false,
      );
    }
    const geometry = expansionGeometry(
      context.zone,
      context.request.scope.direction,
    );
    const now = this.clock.now();
    const zoneId = this.ids.generate();
    const zone: TerritoryZone = {
      bounds: geometry.bounds,
      createdAt: now,
      id: zoneId,
      kind: context.zone.kind,
      name: instanceName(context.request.prompt) || "新区域",
      status: "active",
      styleProfile: context.zone.styleProfile,
      trashedAt: null,
      updatedAt: now,
    };
    const assetId = `generated.asset.${this.ids.generate()}`;
    const size = {
      height: zone.bounds.height * TERRITORY_WORLD_UNIT_PX,
      width: zone.bounds.width * TERRITORY_WORLD_UNIT_PX,
    };
    const definition = this.backgroundDefinition({
      assetId,
      candidateId,
      footprint: rectangle(zone.bounds.width, zone.bounds.height),
      name: `${zone.name} · 环境`,
      size,
    });
    const prepared = await this.renderAndInstall({
      assetId,
      candidate: this.candidateModel(candidateId, context.request),
      context,
      editInstruction,
      options: zoneRenderOptions,
      origin: editInstruction ? "edited" : "generated",
      outputSize: size,
      removeBackground: false,
      provider,
      signal,
    });
    installed.push(prepared);
    const background = activeInstance(
      this.ids.generate(),
      definition,
      now,
      context.request.sources,
      {
        flipped: false,
        kind: "zone",
        offsetPx: { x: 0, y: 0 },
        point: { x: 0, y: 0 },
        rotation: 0,
        zoneId,
      },
    );
    const connection: TerritoryZoneConnection = {
      from: geometry.from,
      fromZoneId: context.zone.id,
      id: this.ids.generate(),
      kind: "path",
      to: geometry.to,
      toZoneId: zoneId,
    };
    const mutations: TerritoryWorldMutation[] = [
      {
        assetPack: generatedAssetPack({
          assets: [{ assetId, key: "zone.background", layer: "structure" }],
          candidateId,
          createdAt: now,
          name: `${zone.name}环境素材包`,
          style: context.style,
        }),
        changeId: this.ids.generate(),
        kind: "asset-pack.put",
      },
      { changeId: this.ids.generate(), kind: "zone.put", zone },
      { changeId: this.ids.generate(), connection, kind: "connection.put" },
      { changeId: this.ids.generate(), definition, kind: "definition.put" },
      {
        changeId: this.ids.generate(),
        instance: background,
        kind: "instance.put",
      },
    ];
    return {
      changeSet: {
        baseRevisionId: context.request.baseRevisionId,
        id: this.ids.generate(),
        label: `扩建「${zone.name}」`,
        mutations,
      },
      previewGroups: [
        {
          action: "add",
          changeIds: mutations.map(({ changeId }) => changeId),
          instanceIds: [background.id],
          label: `新增区域「${zone.name}」`,
        },
      ],
    };
  }

  private async rollback(
    installed: readonly PreparedTerritoryWorldAsset[],
  ): Promise<void> {
    for (const prepared of [...installed].reverse()) {
      if (this.repository.unregisterUnreferencedAsset(prepared.asset.id)) {
        await this.assets.rollback(prepared);
      }
    }
  }

  private candidateAssetIds(candidateId: string): string[] {
    const candidate = this.repository
      .getSnapshot()
      .candidates.find(({ id }) => id === candidateId);
    if (!candidate?.changeSet) return [];
    return candidate.changeSet.mutations.flatMap((mutation) =>
      mutation.kind === "definition.put"
        ? [mutation.definition.visual.assetId]
        : [],
    );
  }

  private async removeOrphanAssets(assetIds: readonly string[]): Promise<void> {
    for (const assetId of assetIds) {
      if (this.repository.unregisterUnreferencedAsset(assetId)) {
        await this.assets.remove(assetId);
      }
    }
  }

  private publish(snapshot: TerritoryWorldSnapshot): void {
    try {
      this.onSnapshotChanged(snapshot);
    } catch {
      // Renderer delivery is best effort; persisted candidate state remains authoritative.
    }
  }
}
