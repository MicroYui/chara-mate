import type { TerritoryItemManifestV1 } from "../../src/shared/contracts/territoryItemManifest";

export const territoryDeskManifest = {
  definitionId: "builtin.cabin-desk",
  description: "窗边的小桌留着一页写到一半的信。",
  name: "窗边书桌",
  placement: {
    collisionCells: [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    depthAnchorPx: { x: 72, y: 96 },
    gridSize: { height: 2, width: 3 },
    mode: "ground",
    occupancyCells: [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    plane: "object",
  },
  revision: 1,
  schemaVersion: 1,
  surfaceSlots: [
    {
      anchorPx: { x: 36, y: 32 },
      id: "left",
      kind: "tabletop",
      maxItemSizePx: { height: 36, width: 32 },
    },
    {
      anchorPx: { x: 108, y: 32 },
      id: "right",
      kind: "tabletop",
      maxItemSizePx: { height: 36, width: 32 },
    },
  ],
  transforms: {
    flippable: true,
    rotations: [0, 90, 180, 270],
  },
  visual: {
    sizePx: { height: 96, width: 144 },
    source: { key: "cabin-desk", kind: "builtin" },
  },
} satisfies TerritoryItemManifestV1;

export const territoryHearthManifest = {
  definitionId: "builtin.cabin-hearth",
  description: "炉火不急不缓，给木屋留下一圈暖光。",
  name: "苔石壁炉",
  placement: {
    collisionCells: [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    depthAnchorPx: { x: 72, y: 96 },
    gridSize: { height: 2, width: 3 },
    mode: "ground",
    occupancyCells: [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    plane: "object",
  },
  revision: 1,
  schemaVersion: 1,
  surfaceSlots: [],
  transforms: { flippable: false, rotations: [0] },
  visual: {
    sizePx: { height: 96, width: 144 },
    source: { key: "cabin-hearth", kind: "builtin" },
  },
} satisfies TerritoryItemManifestV1;

export const territoryRugManifest = {
  definitionId: "builtin.moss-rug",
  description: "像把林间一小块柔软青苔带进了屋。",
  name: "青苔软毯",
  placement: {
    collisionCells: [],
    depthAnchorPx: { x: 96, y: 96 },
    gridSize: { height: 2, width: 4 },
    mode: "ground",
    occupancyCells: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ],
    plane: "underlay",
  },
  revision: 1,
  schemaVersion: 1,
  surfaceSlots: [],
  transforms: {
    flippable: true,
    rotations: [0, 90, 180, 270],
  },
  visual: {
    sizePx: { height: 96, width: 192 },
    source: { key: "moss-rug", kind: "builtin" },
  },
} satisfies TerritoryItemManifestV1;

export const territoryCupManifest = {
  definitionId: "generated.ceramic-cup",
  description: "一只留着暖意的小陶杯。",
  name: "暖陶杯",
  placement: {
    allowedSurfaceKinds: ["tabletop"],
    attachmentAnchorPx: { x: 12, y: 28 },
    mode: "surface",
  },
  revision: 1,
  schemaVersion: 1,
  surfaceSlots: [],
  transforms: { flippable: true, rotations: [0] },
  visual: {
    sizePx: { height: 28, width: 24 },
    source: { assetId: "asset.ceramic-cup.v1", kind: "asset" },
  },
} satisfies TerritoryItemManifestV1;
