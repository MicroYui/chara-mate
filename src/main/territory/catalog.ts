import type {
  TerritoryRotation,
  TerritorySceneDefinition,
  TerritorySceneId,
  TerritorySceneSummary,
} from "../../shared/contracts/territory";
import type {
  TerritoryGridCell,
  TerritoryItemManifestV1,
  TerritorySurfaceSlot,
} from "../../shared/contracts/territoryItemManifest";

export interface TerritoryDefaultItem {
  readonly definitionId: string;
  readonly flipped?: boolean;
  readonly id: string;
  readonly rotation?: TerritoryRotation;
  readonly x: number;
  readonly y: number;
}

export interface TerritoryCollectionDefault {
  readonly definitionId: string;
  readonly id: string;
}

export interface TerritorySceneCatalogEntry {
  readonly defaults: readonly TerritoryDefaultItem[];
  readonly definition: TerritorySceneDefinition;
}

const walkableRows = [
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
  "0111111111111110",
  "0111111111111110",
  "0111111111111110",
  "0111111111111110",
  "0111111111111110",
  "0011111111111100",
];

const placeableRows = [...walkableRows];

function rowCells(width: number, y: number): TerritoryGridCell[] {
  return Array.from({ length: width }, (_, x) => ({ x, y }));
}

function rectangleCells(width: number, height: number): TerritoryGridCell[] {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
  }));
}

function groundManifest(input: {
  readonly description: string;
  readonly flippable: boolean;
  readonly height: number;
  readonly key: string;
  readonly name: string;
  readonly plane?: "object" | "underlay";
  readonly rotatable: boolean;
  readonly surfaceSlots?: TerritorySurfaceSlot[];
  readonly width: number;
}): TerritoryItemManifestV1 {
  const plane = input.plane ?? "object";
  const occupancyCells =
    plane === "underlay"
      ? rectangleCells(input.width, input.height)
      : rowCells(input.width, input.height - 1);
  return {
    definitionId: `builtin.${input.key}`,
    description: input.description,
    name: input.name,
    placement: {
      collisionCells: plane === "underlay" ? [] : [...occupancyCells],
      depthAnchorPx: {
        x: Math.round((input.width * 48) / 2),
        y: input.height * 48,
      },
      gridSize: { height: input.height, width: input.width },
      mode: "ground",
      occupancyCells,
      plane,
    },
    revision: 1,
    schemaVersion: 1,
    surfaceSlots: input.surfaceSlots ?? [],
    transforms: {
      flippable: input.flippable,
      rotations: input.rotatable ? [0, 90, 180, 270] : [0],
    },
    visual: {
      sizePx: { height: input.height * 48, width: input.width * 48 },
      source: { key: input.key, kind: "builtin" },
    },
  };
}

function surfaceManifest(input: {
  readonly description: string;
  readonly height: number;
  readonly key: string;
  readonly name: string;
  readonly width: number;
}): TerritoryItemManifestV1 {
  return {
    definitionId: `builtin.${input.key}`,
    description: input.description,
    name: input.name,
    placement: {
      allowedSurfaceKinds: ["tabletop"],
      attachmentAnchorPx: {
        x: Math.round(input.width / 2),
        y: input.height,
      },
      mode: "surface",
    },
    revision: 1,
    schemaVersion: 1,
    surfaceSlots: [],
    transforms: { flippable: false, rotations: [0] },
    visual: {
      sizePx: { height: input.height, width: input.width },
      source: { key: input.key, kind: "builtin" },
    },
  };
}

const itemDefinitions = [
  groundManifest({
    description: "收着尚未写完的星图与几册旧手记。",
    flippable: true,
    height: 2,
    key: "astral-bookshelf",
    name: "星图书架",
    rotatable: false,
    width: 2,
  }),
  groundManifest({
    description: "黄铜镜筒安静朝着城市上方的夜空。",
    flippable: true,
    height: 2,
    key: "brass-telescope",
    name: "黄铜望远镜",
    rotatable: true,
    width: 2,
  }),
  groundManifest({
    description: "窗边的小桌空着两处位置，正好摆下喜欢的小东西。",
    flippable: true,
    height: 2,
    key: "cabin-desk",
    name: "窗边书桌",
    rotatable: true,
    surfaceSlots: [
      {
        anchorPx: { x: 36, y: 34 },
        id: "left",
        kind: "tabletop",
        maxItemSizePx: { height: 36, width: 34 },
      },
      {
        anchorPx: { x: 108, y: 34 },
        id: "right",
        kind: "tabletop",
        maxItemSizePx: { height: 36, width: 34 },
      },
    ],
    width: 3,
  }),
  groundManifest({
    description: "炉火不急不缓，给木屋留下一圈暖光。",
    flippable: false,
    height: 2,
    key: "cabin-hearth",
    name: "苔石壁炉",
    rotatable: false,
    width: 3,
  }),
  groundManifest({
    description: "细小星点在深蓝织面上连成一条回家路。",
    flippable: true,
    height: 2,
    key: "constellation-rug",
    name: "星座软毯",
    plane: "underlay",
    rotatable: true,
    width: 4,
  }),
  groundManifest({
    description: "新叶在木窗透进的光里慢慢舒展。",
    flippable: false,
    height: 2,
    key: "fern-pot",
    name: "蕨叶陶盆",
    rotatable: false,
    width: 1,
  }),
  groundManifest({
    description: "一枚像月光凝成的小晶体，呼吸般明暗。",
    flippable: false,
    height: 1,
    key: "moon-crystal",
    name: "月光晶体",
    rotatable: false,
    width: 1,
  }),
  groundManifest({
    description: "像把林间一小块柔软青苔带进了屋。",
    flippable: true,
    height: 2,
    key: "moss-rug",
    name: "青苔软毯",
    plane: "underlay",
    rotatable: true,
    width: 4,
  }),
  groundManifest({
    description: "叶影随着看不见的海风轻轻偏向窗边。",
    flippable: true,
    height: 2,
    key: "potted-palm",
    name: "海风棕榈",
    rotatable: false,
    width: 1,
  }),
  groundManifest({
    description: "天色暗下来时，它替屋顶留一盏灯。",
    flippable: false,
    height: 1,
    key: "roof-lantern",
    name: "屋顶灯笼",
    rotatable: false,
    width: 1,
  }),
  groundManifest({
    description: "坐下就能看见远处一排亮起来的窗。",
    flippable: true,
    height: 1,
    key: "rooftop-bench",
    name: "晚风长椅",
    rotatable: true,
    width: 3,
  }),
  groundManifest({
    description: "浅色床单里留着海盐与清晨的气息。",
    flippable: true,
    height: 2,
    key: "seaside-bed",
    name: "潮汐小床",
    rotatable: true,
    width: 3,
  }),
  groundManifest({
    description: "一张小边桌，桌面中央可以放一件小物。",
    flippable: true,
    height: 1,
    key: "shell-table",
    name: "贝壳边桌",
    rotatable: true,
    surfaceSlots: [
      {
        anchorPx: { x: 48, y: 20 },
        id: "center",
        kind: "tabletop",
        maxItemSizePx: { height: 36, width: 34 },
      },
    ],
    width: 2,
  }),
  groundManifest({
    description: "齿轮、纸页和一束星光都能在宽阔桌面找到位置。",
    flippable: true,
    height: 2,
    key: "star-workbench",
    name: "星尘工作台",
    rotatable: true,
    surfaceSlots: [
      {
        anchorPx: { x: 36, y: 34 },
        id: "left",
        kind: "tabletop",
        maxItemSizePx: { height: 36, width: 34 },
      },
      {
        anchorPx: { x: 96, y: 34 },
        id: "center",
        kind: "tabletop",
        maxItemSizePx: { height: 36, width: 34 },
      },
      {
        anchorPx: { x: 156, y: 34 },
        id: "right",
        kind: "tabletop",
        maxItemSizePx: { height: 36, width: 34 },
      },
    ],
    width: 4,
  }),
  groundManifest({
    description: "耐风的小花在落日里显得格外明亮。",
    flippable: true,
    height: 1,
    key: "sunset-planter",
    name: "落日花箱",
    rotatable: true,
    width: 2,
  }),
  groundManifest({
    description: "浅蓝纹路一层层铺开，像安静的浪。",
    flippable: true,
    height: 2,
    key: "wave-rug",
    name: "细浪软毯",
    plane: "underlay",
    rotatable: true,
    width: 4,
  }),
  surfaceManifest({
    description: "一只留着暖意的小陶杯，可以摆在带插槽的桌面上。",
    height: 28,
    key: "ceramic-cup",
    name: "暖陶杯",
    width: 24,
  }),
  surfaceManifest({
    description: "折好的短笺压着一角微光，适合留在书桌边。",
    height: 16,
    key: "folded-letter",
    name: "折叠短笺",
    width: 30,
  }),
  surfaceManifest({
    description: "一小盆安静生长的多肉，为桌面添一点绿色。",
    height: 34,
    key: "tiny-succulent",
    name: "袖珍多肉",
    width: 26,
  }),
] satisfies TerritoryItemManifestV1[];

export const TERRITORY_ITEM_DEFINITIONS: Readonly<
  Record<string, TerritoryItemManifestV1>
> = Object.fromEntries(
  itemDefinitions.map((definition) => [definition.definitionId, definition]),
);

export const TERRITORY_COLLECTION_DEFAULTS: readonly TerritoryCollectionDefault[] =
  [
    {
      definitionId: "builtin.ceramic-cup",
      id: "collection.ceramic-cup",
    },
    {
      definitionId: "builtin.folded-letter",
      id: "collection.folded-letter",
    },
    {
      definitionId: "builtin.tiny-succulent",
      id: "collection.tiny-succulent",
    },
  ];

export const TERRITORY_SCENES: Readonly<
  Record<TerritorySceneId, TerritorySceneCatalogEntry>
> = {
  "city-rooftop": {
    defaults: [
      {
        definitionId: "builtin.rooftop-bench",
        id: "city-rooftop.bench",
        x: 2,
        y: 5,
      },
      {
        definitionId: "builtin.sunset-planter",
        id: "city-rooftop.planter",
        x: 12,
        y: 4,
      },
      {
        definitionId: "builtin.brass-telescope",
        id: "city-rooftop.telescope",
        x: 9,
        y: 4,
      },
      {
        definitionId: "builtin.roof-lantern",
        id: "city-rooftop.lantern",
        x: 13,
        y: 7,
      },
    ],
    definition: {
      description: "晚风越过低矮天台，城市灯火从脚下一盏盏亮起。",
      entry: { x: 7, y: 6 },
      height: 10,
      id: "city-rooftop",
      name: "城市天台",
      palette: {
        accent: "#ffb45f",
        ambient: "#f27b74",
        floor: "#59657f",
        floorAlt: "#68758e",
        shadow: "#29354e",
        sky: "#424d72",
        wall: "#38455f",
      },
      placeableRows: [...placeableRows],
      poem: "让晚风替我们，把今天轻轻收好。",
      walkableRows: [...walkableRows],
      width: 16,
    },
  },
  "forest-cabin": {
    defaults: [
      {
        definitionId: "builtin.cabin-hearth",
        id: "forest-cabin.hearth",
        x: 1,
        y: 4,
      },
      {
        definitionId: "builtin.cabin-desk",
        id: "forest-cabin.desk",
        x: 11,
        y: 4,
      },
      {
        definitionId: "builtin.fern-pot",
        id: "forest-cabin.fern",
        x: 5,
        y: 4,
      },
      {
        definitionId: "builtin.moss-rug",
        id: "forest-cabin.rug",
        x: 6,
        y: 7,
      },
    ],
    definition: {
      description: "木墙、炉火和潮湿青苔围成一间安静的小屋。",
      entry: { x: 8, y: 6 },
      height: 10,
      id: "forest-cabin",
      name: "林间小屋",
      palette: {
        accent: "#e8bb67",
        ambient: "#89a56f",
        floor: "#8a6849",
        floorAlt: "#987555",
        shadow: "#314936",
        sky: "#55745c",
        wall: "#c49a6c",
      },
      placeableRows: [...placeableRows],
      poem: "这里会慢慢装下，我们一起走过的日子。",
      walkableRows: [...walkableRows],
      width: 16,
    },
  },
  "seaside-room": {
    defaults: [
      {
        definitionId: "builtin.seaside-bed",
        id: "seaside-room.bed",
        x: 1,
        y: 4,
      },
      {
        definitionId: "builtin.shell-table",
        id: "seaside-room.table",
        x: 12,
        y: 5,
      },
      {
        definitionId: "builtin.potted-palm",
        id: "seaside-room.palm",
        x: 10,
        y: 4,
      },
      {
        definitionId: "builtin.wave-rug",
        id: "seaside-room.rug",
        x: 5,
        y: 7,
      },
    ],
    definition: {
      description: "窗外总有缓慢潮声，浅色房间盛着一整片晴朗。",
      entry: { x: 8, y: 6 },
      height: 10,
      id: "seaside-room",
      name: "海边房间",
      palette: {
        accent: "#f3c979",
        ambient: "#72c8ce",
        floor: "#d7bd93",
        floorAlt: "#e2cba5",
        shadow: "#457c8b",
        sky: "#75c9df",
        wall: "#f1e2c1",
      },
      placeableRows: [...placeableRows],
      poem: "潮汐来去，留下值得记住的微光。",
      walkableRows: [...walkableRows],
      width: 16,
    },
  },
  "star-workshop": {
    defaults: [
      {
        definitionId: "builtin.star-workbench",
        id: "star-workshop.workbench",
        x: 1,
        y: 4,
      },
      {
        definitionId: "builtin.astral-bookshelf",
        id: "star-workshop.bookshelf",
        x: 12,
        y: 4,
      },
      {
        definitionId: "builtin.moon-crystal",
        id: "star-workshop.crystal",
        x: 9,
        y: 5,
      },
      {
        definitionId: "builtin.constellation-rug",
        id: "star-workshop.rug",
        x: 5,
        y: 7,
      },
    ],
    definition: {
      description: "星图、齿轮与蓝紫微光，把夜晚变成一间小工坊。",
      entry: { x: 8, y: 6 },
      height: 10,
      id: "star-workshop",
      name: "星空工坊",
      palette: {
        accent: "#f0c66f",
        ambient: "#8f78d7",
        floor: "#4b466c",
        floorAlt: "#5a537b",
        shadow: "#24233d",
        sky: "#292846",
        wall: "#56517a",
      },
      placeableRows: [...placeableRows],
      poem: "每一点微光，都在等一个属于它的故事。",
      walkableRows: [...walkableRows],
      width: 16,
    },
  },
};

export const TERRITORY_SCENE_ORDER: readonly TerritorySceneId[] = [
  "forest-cabin",
  "seaside-room",
  "city-rooftop",
  "star-workshop",
];

export const TERRITORY_SCENE_ITEM_CAPACITY = 12;

export function getTerritoryItemDefinition(
  definitionId: string,
): TerritoryItemManifestV1 {
  const definition = TERRITORY_ITEM_DEFINITIONS[definitionId];
  if (!definition) {
    throw new Error(`Missing Territory item definition: ${definitionId}`);
  }
  return definition;
}

export function getTerritoryScene(
  sceneId: TerritorySceneId,
): TerritorySceneCatalogEntry {
  return TERRITORY_SCENES[sceneId];
}

export function listTerritorySceneSummaries(): TerritorySceneSummary[] {
  return TERRITORY_SCENE_ORDER.map((sceneId) => {
    const { description, id, name, palette, poem } =
      TERRITORY_SCENES[sceneId].definition;
    return { description, id, name, palette, poem };
  });
}
