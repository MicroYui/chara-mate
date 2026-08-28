import { createHash } from "node:crypto";

import type { Timestamp } from "../../shared/contracts/primitives";
import type {
  TerritoryAsset,
  TerritoryAnchorKind,
  TerritoryDefinition,
  TerritoryDepthMode,
  TerritoryGridPoint,
  TerritoryInstance,
  TerritoryStyleProfile,
  TerritoryWorldState,
  TerritoryZone,
} from "../../shared/contracts/territoryWorld";
import type { TerritoryWorldSeed } from "./territoryWorldRepository";
import { applyStarterTerritoryNarratives } from "./territoryWorldNarrative";

export const STARTER_TERRITORY_ZONE_ID = "20000000-0000-4000-8000-000000000001";
export const STARTER_TERRITORY_REVISION_ID =
  "10000000-0000-4000-8000-000000000001";

const styleId = "starter.twilight-cabin";
const zoneWidth = 48;
const zoneHeight = 30;

function rectangle(width: number, height: number): TerritoryGridPoint[] {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
  }));
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

function packagedAsset(
  id: string,
  width: number,
  height: number,
  createdAt: Timestamp,
): TerritoryAsset {
  const descriptor = JSON.stringify({
    height,
    id,
    renderer: "pixi-code",
    version: 2,
    width,
  });
  return {
    byteLength: Buffer.byteLength(descriptor),
    createdAt,
    height,
    id,
    mediaType: "application/vnd.charamate.pixi",
    origin: "packaged",
    sha256: createHash("sha256").update(descriptor).digest("hex"),
    width,
  };
}

function gridDefinition(input: {
  anchors?: TerritoryDefinition["anchors"];
  capabilities?: TerritoryDefinition["capabilities"];
  collisionCells?: TerritoryGridPoint[];
  createdAt: Timestamp;
  depthAnchorPx?: { x: number; y: number };
  depthMode?: TerritoryDepthMode;
  description: string;
  footprint: { height: number; width: number };
  id: string;
  layer: "object" | "structure" | "underlay";
  name: string;
  sizePx: { height: number; width: number };
  tags: string[];
}): TerritoryDefinition {
  return {
    anchors: input.anchors ?? [],
    capabilities: input.capabilities ?? ["inspectable"],
    createdAt: input.createdAt,
    description: input.description,
    id: input.id,
    layer: input.layer,
    name: input.name,
    placement: {
      collisionCells: input.collisionCells ?? [],
      footprintCells: rectangle(input.footprint.width, input.footprint.height),
      mode: "grid",
    },
    revision: 1,
    schemaVersion: 3,
    tags: input.tags,
    transforms: {
      flippable: input.layer !== "structure",
      rotations: input.layer === "structure" ? [0] : [0, 90, 180, 270],
    },
    visual: {
      assetId: input.id,
      depthAnchorPx: input.depthAnchorPx ?? {
        x: Math.round(input.sizePx.width / 2),
        y: input.sizePx.height,
      },
      depthMode:
        input.depthMode ?? (input.layer === "object" ? "sorted" : "flat"),
      frame: null,
      sizePx: input.sizePx,
    },
  };
}

function attachmentDefinition(input: {
  allowedAnchors: readonly TerritoryAnchorKind[];
  anchorPx: { x: number; y: number };
  capabilities?: TerritoryDefinition["capabilities"];
  createdAt: Timestamp;
  description: string;
  id: string;
  name: string;
  sizePx: { height: number; width: number };
  tags: string[];
}): TerritoryDefinition {
  return {
    anchors: [],
    capabilities: input.capabilities ?? ["inspectable"],
    createdAt: input.createdAt,
    description: input.description,
    id: input.id,
    layer: "attachment",
    name: input.name,
    placement: {
      allowedAnchors: [...input.allowedAnchors],
      attachmentAnchorPx: input.anchorPx,
      mode: "attachment",
    },
    revision: 1,
    schemaVersion: 3,
    tags: input.tags,
    transforms: { flippable: true, rotations: [0] },
    visual: {
      assetId: input.id,
      depthAnchorPx: input.anchorPx,
      depthMode: "sorted",
      frame: null,
      sizePx: input.sizePx,
    },
  };
}

function freeDefinition(input: {
  createdAt: Timestamp;
  depthMode: "flat" | "overlay";
  description: string;
  id: string;
  layer: "effect" | "foreground";
  name: string;
  sizePx: { height: number; width: number };
  tags: string[];
}): TerritoryDefinition {
  return {
    anchors: [],
    capabilities: input.layer === "effect" ? ["ambient-animation"] : [],
    createdAt: input.createdAt,
    description: input.description,
    id: input.id,
    layer: input.layer,
    name: input.name,
    placement: { mode: "free" },
    revision: 1,
    schemaVersion: 3,
    tags: input.tags,
    transforms: { flippable: true, rotations: [0] },
    visual: {
      assetId: input.id,
      depthAnchorPx: {
        x: Math.round(input.sizePx.width / 2),
        y: input.sizePx.height,
      },
      depthMode: input.depthMode,
      frame: null,
      sizePx: input.sizePx,
    },
  };
}

function zoneInstance(input: {
  definitionId: string;
  id: string;
  point: TerritoryGridPoint;
  timestamp: Timestamp;
}): TerritoryInstance {
  return {
    createdAt: input.timestamp,
    definition: { id: input.definitionId, revision: 1 },
    favorite: false,
    groupId: null,
    id: input.id,
    locked: false,
    placement: {
      flipped: false,
      kind: "zone",
      offsetPx: { x: 0, y: 0 },
      point: input.point,
      rotation: 0,
      zoneId: STARTER_TERRITORY_ZONE_ID,
    },
    sources: [],
    status: "active",
    trashedAt: null,
    updatedAt: input.timestamp,
  };
}

function attachmentInstance(input: {
  anchorId: string;
  definitionId: string;
  id: string;
  offsetPx?: { x: number; y: number };
  parent: TerritoryInstance;
  timestamp: Timestamp;
}): TerritoryInstance {
  return {
    ...zoneInstance({
      definitionId: input.definitionId,
      id: input.id,
      point: { x: 0, y: 0 },
      timestamp: input.timestamp,
    }),
    placement: {
      anchorId: input.anchorId,
      flipped: false,
      kind: "attachment",
      offsetPx: input.offsetPx ?? { x: 0, y: 0 },
      parentInstanceId: input.parent.id,
      rotation: 0,
      zoneId: STARTER_TERRITORY_ZONE_ID,
    },
  };
}

export function createStarterTerritoryWorldSeed(
  createdAt: Timestamp,
): TerritoryWorldSeed {
  const style: TerritoryStyleProfile = {
    id: styleId,
    lightingDirection: "左上窗光、中央壁炉暖光与桌面局部灯光",
    materialLanguage: "温暖深木、苔石、旧黄铜、亚麻、陶器与手工纸张",
    name: "住了很久的暮色林间小屋",
    outlineLanguage: "细深蓝灰轮廓，边缘保留手绘像素起伏",
    palette: {
      accent: "#e2b66f",
      ambient: "#8097a6",
      dark: "#27323d",
      light: "#f1dfb9",
      mid: "#78896b",
    },
    pixelScale: 3,
    referenceAssetIds: [
      "starter.cabin-wall",
      "starter.canopy-bed",
      "starter.writing-desk",
      "starter.lived-sofa",
    ],
    revision: 1,
    seasonTone: "初秋，雨后",
    shadowLanguage: "右下柔和接触阴影，家具底部有明确压地感",
    timeTone: "日落后蓝调时刻，室内灯火刚亮",
  };
  const zone: TerritoryZone = {
    bounds: { height: zoneHeight, width: zoneWidth, x: 0, y: 0 },
    createdAt,
    id: STARTER_TERRITORY_ZONE_ID,
    kind: "room",
    name: "住了很久的暮色小屋",
    status: "active",
    styleProfile: { id: style.id, revision: style.revision },
    trashedAt: null,
    updatedAt: createdAt,
  };

  const wallAnchors: TerritoryDefinition["anchors"] = [
    {
      anchorPx: { x: 180, y: 136 },
      id: "left-gallery",
      kind: "wall",
      maxItemSizePx: { height: 120, width: 180 },
    },
    {
      anchorPx: { x: 575, y: 196 },
      id: "windowsill",
      kind: "windowsill",
      maxItemSizePx: { height: 96, width: 192 },
    },
    {
      anchorPx: { x: 878, y: 132 },
      id: "right-gallery",
      kind: "wall",
      maxItemSizePx: { height: 120, width: 192 },
    },
    {
      anchorPx: { x: 574, y: 28 },
      id: "ceiling-center",
      kind: "ceiling",
      maxItemSizePx: { height: 160, width: 144 },
    },
  ];

  let definitions: TerritoryDefinition[] = [
    {
      anchors: [],
      capabilities: [],
      createdAt,
      description:
        "由 48px 宏块铺成、但可以在 24px 原子空间上组合家具的旧木地板。",
      id: "starter.cabin-floor",
      layer: "terrain",
      name: "有生活痕迹的暖木地板",
      placement: {
        collision: false,
        mode: "tile",
        span: { height: 2, width: 2 },
      },
      revision: 1,
      schemaVersion: 3,
      tags: ["floor", "wood", "lived-in"],
      transforms: { flippable: false, rotations: [0] },
      visual: {
        assetId: "starter.cabin-floor",
        depthAnchorPx: { x: 24, y: 48 },
        depthMode: "flat",
        frame: null,
        sizePx: { height: 48, width: 48 },
      },
    },
    gridDefinition({
      anchors: wallAnchors,
      capabilities: [],
      createdAt,
      description: "整面可替换墙体，包含雨夜窗景、木梁、挂画区与窗台锚点。",
      footprint: { height: 10, width: zoneWidth },
      id: "starter.cabin-wall",
      layer: "structure",
      name: "雨夜窗景木墙",
      sizePx: { height: 240, width: 1152 },
      tags: ["wall", "window", "wood", "environment"],
    }),
    gridDefinition({
      capabilities: ["inspectable", "seatable", "sleepable"],
      createdAt,
      description:
        "边缘已经磨软的巨大苔色地毯，划出一家人最常停留的中央生活区。",
      footprint: { height: 13, width: 21 },
      id: "starter.great-moss-rug",
      layer: "underlay",
      name: "旧星苔大地毯",
      sizePx: { height: 312, width: 504 },
      tags: ["rug", "moss", "lived-in"],
    }),
    gridDefinition({
      createdAt,
      description: "床脚到壁炉之间被走亮的窄织毯。",
      footprint: { height: 3, width: 14 },
      id: "starter.worn-runner",
      layer: "underlay",
      name: "磨旧的织纹长毯",
      sizePx: { height: 72, width: 336 },
      tags: ["rug", "runner", "worn"],
    }),
    gridDefinition({
      anchors: [
        {
          anchorPx: { x: 130, y: 116 },
          id: "sleep-center",
          kind: "sleep",
          maxItemSizePx: { height: 120, width: 200 },
        },
      ],
      capabilities: ["inspectable", "sleepable"],
      collisionCells: rows(11, 6, 2),
      createdAt,
      description: "被子叠得不完全整齐，床柱挂着旅行留下的小徽章。",
      footprint: { height: 8, width: 11 },
      id: "starter.canopy-bed",
      layer: "object",
      name: "住了很久的林间床",
      sizePx: { height: 192, width: 264 },
      tags: ["bed", "sleep", "wood", "lived-in"],
    }),
    gridDefinition({
      anchors: [
        {
          anchorPx: { x: 36, y: 48 },
          id: "top",
          kind: "tabletop",
          maxItemSizePx: { height: 80, width: 68 },
        },
      ],
      collisionCells: rows(3, 3),
      createdAt,
      description: "抽屉里塞着便签，桌面留有一圈常用杯子的浅印。",
      footprint: { height: 4, width: 3 },
      id: "starter.bedside-table",
      layer: "object",
      name: "贴满便签的床头柜",
      sizePx: { height: 96, width: 72 },
      tags: ["table", "bedside", "wood"],
    }),
    gridDefinition({
      capabilities: ["light", "ambient-animation", "inspectable"],
      collisionCells: rows(8, 5, 2),
      createdAt,
      description: "炉台积着几片松针，火边永远温着一只小水壶。",
      footprint: { height: 7, width: 8 },
      id: "starter.cabin-hearth",
      layer: "object",
      name: "一直燃着的苔石壁炉",
      sizePx: { height: 168, width: 192 },
      tags: ["hearth", "stone", "light", "lived-in"],
    }),
    gridDefinition({
      collisionCells: rows(4, 3),
      createdAt,
      description: "劈柴、火钳和几张揉皱的引火纸都留在手边。",
      footprint: { height: 4, width: 4 },
      id: "starter.log-basket",
      layer: "object",
      name: "装满劈柴的旧藤篮",
      sizePx: { height: 96, width: 96 },
      tags: ["basket", "logs", "hearth"],
    }),
    gridDefinition({
      anchors: [
        {
          anchorPx: { x: 64, y: 67 },
          id: "left-top",
          kind: "tabletop",
          maxItemSizePx: { height: 90, width: 100 },
        },
        {
          anchorPx: { x: 176, y: 67 },
          id: "right-top",
          kind: "tabletop",
          maxItemSizePx: { height: 90, width: 112 },
        },
      ],
      collisionCells: rows(10, 5),
      createdAt,
      description:
        "摊着未写完的手稿、地图边角和修补工具，是每天都在使用的工作台。",
      footprint: { height: 6, width: 10 },
      id: "starter.writing-desk",
      layer: "object",
      name: "堆满半成品的写作桌",
      sizePx: { height: 144, width: 240 },
      tags: ["desk", "work", "wood", "clutter"],
    }),
    gridDefinition({
      anchors: [
        {
          anchorPx: { x: 84, y: 72 },
          id: "upper-shelf",
          kind: "bookshelf",
          maxItemSizePx: { height: 150, width: 142 },
        },
      ],
      collisionCells: rows(7, 8, 2),
      createdAt,
      description:
        "书本不按颜色排列，夹着标本、信封、线轴和从旅途中带回的小东西。",
      footprint: { height: 10, width: 7 },
      id: "starter.astral-bookshelf",
      layer: "object",
      name: "塞得满满的星图书架",
      sizePx: { height: 240, width: 168 },
      tags: ["bookshelf", "books", "clutter", "memory"],
    }),
    gridDefinition({
      collisionCells: rows(2, 7),
      createdAt,
      depthMode: "sorted",
      description: "挂着围巾、钥匙和干花的小隔断，让空间不完全一眼望到底。",
      footprint: { height: 8, width: 2 },
      id: "starter.memory-divider",
      layer: "structure",
      name: "挂满小物的木格隔断",
      sizePx: { height: 192, width: 48 },
      tags: ["divider", "wood", "memory"],
    }),
    gridDefinition({
      anchors: [
        {
          anchorPx: { x: 132, y: 88 },
          id: "seat-center",
          kind: "seat",
          maxItemSizePx: { height: 100, width: 210 },
        },
      ],
      capabilities: ["inspectable", "seatable"],
      collisionCells: rows(11, 5, 2),
      createdAt,
      description: "靠垫已经坐出凹陷，扶手上常搭着读到一半的毯子。",
      footprint: { height: 7, width: 11 },
      id: "starter.lived-sofa",
      layer: "object",
      name: "坐出凹陷的长沙发",
      sizePx: { height: 168, width: 264 },
      tags: ["sofa", "seat", "fabric", "lived-in"],
    }),
    gridDefinition({
      anchors: [
        {
          anchorPx: { x: 96, y: 43 },
          id: "top",
          kind: "tabletop",
          maxItemSizePx: { height: 70, width: 150 },
        },
      ],
      collisionCells: rows(8, 2, 2),
      createdAt,
      description: "边角有杯痕和铅笔印，下面塞着三本一直没收回书架的书。",
      footprint: { height: 4, width: 8 },
      id: "starter.coffee-table",
      layer: "object",
      name: "有杯痕的矮茶桌",
      sizePx: { height: 96, width: 192 },
      tags: ["table", "tea", "clutter"],
    }),
    gridDefinition({
      capabilities: ["inspectable", "seatable"],
      collisionCells: rows(6, 5, 2),
      createdAt,
      description: "扶手上搭着常穿的开衫，坐垫旁卡着一张旧车票。",
      footprint: { height: 7, width: 6 },
      id: "starter.reading-chair",
      layer: "object",
      name: "搭着开衫的阅读椅",
      sizePx: { height: 168, width: 144 },
      tags: ["chair", "reading", "fabric"],
    }),
    gridDefinition({
      capabilities: ["inspectable", "light"],
      collisionCells: rows(3, 6),
      createdAt,
      description: "旧黄铜灯杆微微倾斜，灯罩下是一小圈适合读书的暖光。",
      footprint: { height: 7, width: 3 },
      id: "starter.floor-lamp",
      layer: "object",
      name: "倾斜的旧黄铜落地灯",
      sizePx: { height: 168, width: 72 },
      tags: ["lamp", "brass", "light"],
    }),
    gridDefinition({
      anchors: [
        {
          anchorPx: { x: 36, y: 48 },
          id: "top",
          kind: "tabletop",
          maxItemSizePx: { height: 70, width: 66 },
        },
      ],
      collisionCells: rows(3, 3),
      createdAt,
      description: "抽屉没有完全关严，露出一角编织中的毛线。",
      footprint: { height: 4, width: 3 },
      id: "starter.side-table",
      layer: "object",
      name: "没关严抽屉的边桌",
      sizePx: { height: 96, width: 72 },
      tags: ["table", "drawer", "clutter"],
    }),
    gridDefinition({
      anchors: [
        {
          anchorPx: { x: 60, y: 58 },
          id: "top",
          kind: "tabletop",
          maxItemSizePx: { height: 72, width: 108 },
        },
      ],
      collisionCells: rows(5, 4),
      createdAt,
      description: "轮子边粘着地毯绒毛，上下两层都是随手取用的茶具与点心罐。",
      footprint: { height: 5, width: 5 },
      id: "starter.tea-cart",
      layer: "object",
      name: "总停在沙发边的茶车",
      sizePx: { height: 120, width: 120 },
      tags: ["cart", "tea", "clutter"],
    }),
    gridDefinition({
      collisionCells: rows(4, 5, 2),
      createdAt,
      description: "新芽与枯叶同时存在，花盆边插着一块手写浇水日期牌。",
      footprint: { height: 7, width: 4 },
      id: "starter.tall-fern",
      layer: "object",
      name: "长得有点过头的蕨叶",
      sizePx: { height: 168, width: 96 },
      tags: ["plant", "fern", "lived-in"],
    }),
    gridDefinition({
      collisionCells: rows(7, 2, 2),
      createdAt,
      description: "铜扣已经暗了，箱盖上贴着几张不同季节的旅行标签。",
      footprint: { height: 4, width: 7 },
      id: "starter.travel-chest",
      layer: "object",
      name: "贴满旅行标签的储物箱",
      sizePx: { height: 96, width: 168 },
      tags: ["chest", "storage", "travel", "memory"],
    }),
    gridDefinition({
      capabilities: ["inspectable", "sleepable"],
      createdAt,
      description: "小窝里埋着最喜欢的布偶和一只失踪很久的袜子。",
      footprint: { height: 3, width: 6 },
      id: "starter.pet-bed",
      layer: "object",
      name: "藏着袜子的桌宠小窝",
      sizePx: { height: 72, width: 144 },
      tags: ["pet", "bed", "toy"],
    }),
    gridDefinition({
      anchors: [
        {
          anchorPx: { x: 84, y: 66 },
          id: "worktop",
          kind: "tabletop",
          maxItemSizePx: { height: 80, width: 140 },
        },
      ],
      collisionCells: rows(7, 5),
      createdAt,
      description: "针线、布样和修到一半的旧衣服构成了另一个真实工作的角落。",
      footprint: { height: 6, width: 7 },
      id: "starter.sewing-table",
      layer: "object",
      name: "正在使用的缝纫桌",
      sizePx: { height: 144, width: 168 },
      tags: ["sewing", "work", "craft", "clutter"],
    }),
    gridDefinition({
      capabilities: ["inspectable", "seatable"],
      collisionCells: rows(3, 2),
      createdAt,
      description: "坐垫补过两次，木腿上缠着防止晃动的细绳。",
      footprint: { height: 3, width: 3 },
      id: "starter.work-stool",
      layer: "object",
      name: "修补过的工作圆凳",
      sizePx: { height: 72, width: 72 },
      tags: ["stool", "seat", "repaired"],
    }),
    gridDefinition({
      createdAt,
      description: "还没放回去的两本书和夹在中间的一张手绘地图。",
      footprint: { height: 2, width: 3 },
      id: "starter.floor-books",
      layer: "object",
      name: "摊在地上的书与地图",
      sizePx: { height: 48, width: 72 },
      tags: ["books", "map", "clutter"],
    }),
    gridDefinition({
      createdAt,
      description: "总是随意踢在门边的一双雨靴，鞋面还沾着一点泥。",
      footprint: { height: 2, width: 3 },
      id: "starter.muddy-boots",
      layer: "object",
      name: "没摆整齐的雨靴",
      sizePx: { height: 48, width: 72 },
      tags: ["boots", "rain", "clutter"],
    }),
    attachmentDefinition({
      allowedAnchors: ["tabletop"],
      anchorPx: { x: 24, y: 68 },
      capabilities: ["light", "inspectable"],
      createdAt,
      description: "灯绳上系着一颗很小的木珠。",
      id: "starter.amber-lamp",
      name: "琥珀桌灯",
      sizePx: { height: 72, width: 48 },
      tags: ["lamp", "amber", "light"],
    }),
    attachmentDefinition({
      allowedAnchors: ["tabletop"],
      anchorPx: { x: 48, y: 43 },
      createdAt,
      description: "两只不同款式的杯子、一把茶匙和吃剩半块的小点心。",
      id: "starter.tea-set",
      name: "每天都在用的茶具",
      sizePx: { height: 48, width: 96 },
      tags: ["tea", "cups", "clutter"],
    }),
    attachmentDefinition({
      allowedAnchors: ["tabletop", "bookshelf"],
      anchorPx: { x: 36, y: 43 },
      createdAt,
      description: "书页里夹满颜色不同的纸签。",
      id: "starter.book-stack",
      name: "夹满纸签的书堆",
      sizePx: { height: 48, width: 72 },
      tags: ["books", "notes", "clutter"],
    }),
    attachmentDefinition({
      allowedAnchors: ["tabletop", "wall"],
      anchorPx: { x: 24, y: 60 },
      createdAt,
      description: "相框边缘被经常拿起触摸的位置磨得发亮。",
      id: "starter.photo-frame",
      name: "常被拿起的旧相框",
      sizePx: { height: 64, width: 48 },
      tags: ["photo", "memory", "frame"],
    }),
    attachmentDefinition({
      allowedAnchors: ["seat"],
      anchorPx: { x: 36, y: 48 },
      createdAt,
      description: "被抱得有点扁，角落还留着一次不太成功的缝补。",
      id: "starter.patch-pillow",
      name: "缝补过的抱枕",
      sizePx: { height: 56, width: 72 },
      tags: ["pillow", "fabric", "repaired"],
    }),
    attachmentDefinition({
      allowedAnchors: ["sleep", "seat"],
      anchorPx: { x: 80, y: 94 },
      createdAt,
      description: "织到一半改过配色，所以中间有一条很可爱的错色。",
      id: "starter.patchwork-blanket",
      name: "有错色的拼布毯",
      sizePx: { height: 110, width: 160 },
      tags: ["blanket", "fabric", "handmade"],
    }),
    attachmentDefinition({
      allowedAnchors: ["bookshelf", "windowsill"],
      anchorPx: { x: 36, y: 132 },
      createdAt,
      description: "藤蔓顺着书架垂下来，叶片之间夹着一张忘记取下的书签。",
      id: "starter.hanging-ivy",
      name: "垂过一整层书架的常春藤",
      sizePx: { height: 144, width: 72 },
      tags: ["plant", "ivy", "bookshelf"],
    }),
    attachmentDefinition({
      allowedAnchors: ["wall"],
      anchorPx: { x: 84, y: 56 },
      createdAt,
      description: "一幅画了许多次仍没完全画准的林间地图。",
      id: "starter.wall-map",
      name: "反复修改的手绘地图",
      sizePx: { height: 112, width: 168 },
      tags: ["map", "wall", "memory"],
    }),
    attachmentDefinition({
      allowedAnchors: ["wall"],
      anchorPx: { x: 36, y: 36 },
      createdAt,
      description: "每天慢三分钟，但已经习惯按它安排泡茶时间。",
      id: "starter.slow-clock",
      name: "总慢三分钟的圆钟",
      sizePx: { height: 72, width: 72 },
      tags: ["clock", "wall", "brass"],
    }),
    attachmentDefinition({
      allowedAnchors: ["wall"],
      anchorPx: { x: 72, y: 48 },
      createdAt,
      description: "便签、票根、干花和一张写着今天要做什么的清单。",
      id: "starter.memo-board",
      name: "越来越挤的记事板",
      sizePx: { height: 96, width: 144 },
      tags: ["memo", "wall", "clutter"],
    }),
    attachmentDefinition({
      allowedAnchors: ["ceiling"],
      anchorPx: { x: 60, y: 8 },
      capabilities: ["ambient-animation", "inspectable"],
      createdAt,
      description: "贝壳、玻璃片和星形木片会在空气流动时轻轻晃动。",
      id: "starter.memory-mobile",
      name: "会轻轻转动的记忆吊饰",
      sizePx: { height: 140, width: 120 },
      tags: ["mobile", "ceiling", "memory"],
    }),
    attachmentDefinition({
      allowedAnchors: ["tabletop"],
      anchorPx: { x: 20, y: 33 },
      createdAt,
      description: "杯沿缺了很小一角，却一直没有舍得换掉。",
      id: "starter.chipped-mug",
      name: "缺了一角的常用杯",
      sizePx: { height: 36, width: 40 },
      tags: ["mug", "tea", "lived-in"],
    }),
    attachmentDefinition({
      allowedAnchors: ["tabletop"],
      anchorPx: { x: 36, y: 43 },
      createdAt,
      description: "线团、剪刀、顶针和一小块等待拼上的布。",
      id: "starter.sewing-basket",
      name: "摊开的针线篮",
      sizePx: { height: 48, width: 72 },
      tags: ["sewing", "basket", "craft"],
    }),
    freeDefinition({
      createdAt,
      depthMode: "overlay",
      description: "窗边厚帘垂在画面前景，让桌宠经过时会自然被帘角遮住。",
      id: "starter.window-curtain",
      layer: "foreground",
      name: "垂入前景的厚窗帘",
      sizePx: { height: 264, width: 168 },
      tags: ["curtain", "foreground", "fabric"],
    }),
    freeDefinition({
      createdAt,
      depthMode: "overlay",
      description: "从顶梁垂下的藤叶和小灯串，形成可见的前景层次。",
      id: "starter.ceiling-vines",
      layer: "foreground",
      name: "顶梁藤叶与灯串",
      sizePx: { height: 112, width: 1152 },
      tags: ["vines", "lights", "foreground"],
    }),
    freeDefinition({
      createdAt,
      depthMode: "flat",
      description: "窗外蓝光、壁炉暖光和悬浮尘埃叠出的暮色空气。",
      id: "starter.window-glow",
      layer: "effect",
      name: "雨夜暮色浮光",
      sizePx: { height: 720, width: 1152 },
      tags: ["glow", "dust", "rain"],
    }),
  ];
  definitions = applyStarterTerritoryNarratives(definitions);

  const assetSizes = new Map(
    definitions.map((definition) => [
      definition.visual.assetId,
      definition.visual.sizePx,
    ]),
  );
  const assets = [...assetSizes].map(([id, size]) =>
    packagedAsset(id, size.width, size.height, createdAt),
  );

  const floorPoints = Array.from(
    { length: (zoneWidth / 2) * (zoneHeight / 2) },
    (_, index) => ({
      x: (index % (zoneWidth / 2)) * 2,
      y: Math.floor(index / (zoneWidth / 2)) * 2,
    }),
  );
  const floorInstances = floorPoints.map((point, index) =>
    zoneInstance({
      definitionId: "starter.cabin-floor",
      id: `41000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      point,
      timestamp: createdAt,
    }),
  );
  let instanceSequence = 0;
  const place = (
    definitionId: string,
    point: TerritoryGridPoint,
  ): TerritoryInstance =>
    zoneInstance({
      definitionId,
      id: `42000000-0000-4000-8000-${String(++instanceSequence).padStart(12, "0")}`,
      point,
      timestamp: createdAt,
    });
  const attach = (
    definitionId: string,
    parent: TerritoryInstance,
    anchorId: string,
    offsetPx?: { x: number; y: number },
  ): TerritoryInstance =>
    attachmentInstance({
      anchorId,
      definitionId,
      id: `43000000-0000-4000-8000-${String(++instanceSequence).padStart(12, "0")}`,
      ...(offsetPx ? { offsetPx } : {}),
      parent,
      timestamp: createdAt,
    });

  const wall = place("starter.cabin-wall", { x: 0, y: 0 });
  const bed = place("starter.canopy-bed", { x: 2, y: 7 });
  const bedside = place("starter.bedside-table", { x: 13, y: 10 });
  const hearth = place("starter.cabin-hearth", { x: 18, y: 6 });
  const desk = place("starter.writing-desk", { x: 31, y: 7 });
  const bookshelf = place("starter.astral-bookshelf", { x: 41, y: 4 });
  const sofa = place("starter.lived-sofa", { x: 16, y: 15 });
  const coffeeTable = place("starter.coffee-table", { x: 18, y: 23 });
  const sideTable = place("starter.side-table", { x: 13, y: 21 });
  const sewingTable = place("starter.sewing-table", { x: 33, y: 16 });

  const instances: TerritoryInstance[] = [
    ...floorInstances,
    wall,
    place("starter.window-glow", { x: 0, y: 0 }),
    place("starter.great-moss-rug", { x: 14, y: 15 }),
    place("starter.worn-runner", { x: 1, y: 15 }),
    bed,
    bedside,
    hearth,
    place("starter.log-basket", { x: 26, y: 9 }),
    desk,
    bookshelf,
    place("starter.memory-divider", { x: 29, y: 10 }),
    sofa,
    coffeeTable,
    place("starter.reading-chair", { x: 7, y: 19 }),
    place("starter.floor-lamp", { x: 4, y: 18 }),
    sideTable,
    place("starter.tea-cart", { x: 27, y: 22 }),
    place("starter.tall-fern", { x: 43, y: 18 }),
    place("starter.travel-chest", { x: 37, y: 24 }),
    place("starter.pet-bed", { x: 30, y: 26 }),
    sewingTable,
    place("starter.work-stool", { x: 37, y: 22 }),
    place("starter.floor-books", { x: 32, y: 23 }),
    place("starter.muddy-boots", { x: 2, y: 27 }),
    attach("starter.amber-lamp", bedside, "top", { x: 5, y: 0 }),
    attach("starter.patchwork-blanket", bed, "sleep-center", {
      x: -6,
      y: 7,
    }),
    attach("starter.photo-frame", wall, "left-gallery", { x: -18, y: 0 }),
    attach("starter.wall-map", wall, "left-gallery", { x: 66, y: -7 }),
    attach("starter.slow-clock", wall, "right-gallery", { x: -96, y: -8 }),
    attach("starter.memo-board", wall, "right-gallery", { x: 45, y: 4 }),
    attach("starter.memory-mobile", wall, "ceiling-center"),
    attach("starter.hanging-ivy", bookshelf, "upper-shelf", { x: 45, y: 0 }),
    attach("starter.book-stack", desk, "left-top", { x: -16, y: 0 }),
    attach("starter.chipped-mug", desk, "right-top", { x: -26, y: 2 }),
    attach("starter.photo-frame", desk, "right-top", { x: 32, y: -1 }),
    attach("starter.patch-pillow", sofa, "seat-center", { x: -72, y: 2 }),
    attach("starter.patch-pillow", sofa, "seat-center", { x: 64, y: 4 }),
    attach("starter.tea-set", coffeeTable, "top", { x: -2, y: 0 }),
    attach("starter.book-stack", sideTable, "top", { x: 0, y: 0 }),
    attach("starter.sewing-basket", sewingTable, "worktop", {
      x: -20,
      y: 0,
    }),
    place("starter.window-curtain", { x: 0, y: 0 }),
    {
      ...place("starter.window-curtain", { x: 41, y: 0 }),
      placement: {
        flipped: true,
        kind: "zone",
        offsetPx: { x: 0, y: 0 },
        point: { x: 41, y: 0 },
        rotation: 0,
        zoneId: STARTER_TERRITORY_ZONE_ID,
      },
    },
    place("starter.ceiling-vines", { x: 0, y: 0 }),
    {
      ...place("starter.great-moss-rug", { x: 0, y: 0 }),
      id: "44000000-0000-4000-8000-000000000001",
      placement: { kind: "collection" },
    },
  ];

  const state: TerritoryWorldState = {
    activeZoneId: zone.id,
    connections: [],
    groups: [],
    instances,
    styles: [style],
    zones: [zone],
  };
  return {
    assetPacks: [
      {
        assets: definitions.map((definition) => ({
          assetId: definition.visual.assetId,
          key: definition.id,
          layer: definition.layer,
        })),
        createdAt,
        id: "starter.twilight-cabin",
        name: "住了很久的暮色林间小屋素材包",
        revision: 1,
        styleProfile: { id: style.id, revision: style.revision },
      },
    ],
    assets: assets.map((asset) => ({
      asset,
      storageKey: `packaged/${asset.id}.png`,
    })),
    definitions,
    name: "我和小家伙住了很久的领地",
    pet: {
      behavior: "idle",
      facing: "right",
      point: { x: 28, y: 27 },
      updatedAt: createdAt,
      zoneId: zone.id,
    },
    revision: {
      createdAt,
      id: STARTER_TERRITORY_REVISION_ID,
      label: "创建住了很久的暮色小屋",
      parentRevisionId: null,
      reason: "initial",
      sequence: 1,
    },
    state,
  };
}
