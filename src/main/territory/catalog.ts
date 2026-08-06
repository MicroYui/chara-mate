import type {
  TerritoryCatalogItemId,
  TerritoryItem,
  TerritoryRotation,
  TerritorySceneDefinition,
  TerritorySceneId,
  TerritorySceneSummary,
} from "../../shared/contracts/territory";

export interface TerritoryCatalogItem {
  readonly blocksMovement: boolean;
  readonly catalogId: TerritoryCatalogItemId;
  readonly description: string;
  readonly flippable: boolean;
  readonly height: number;
  readonly name: string;
  readonly rotatable: boolean;
  readonly width: number;
}

export interface TerritoryDefaultItem {
  readonly catalogId: TerritoryCatalogItemId;
  readonly flipped?: boolean;
  readonly id: string;
  readonly layer: number;
  readonly rotation?: TerritoryRotation;
  readonly x: number;
  readonly y: number;
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

const placeableRows = [
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

export const TERRITORY_ITEMS: Readonly<
  Record<TerritoryCatalogItemId, TerritoryCatalogItem>
> = {
  "astral-bookshelf": {
    blocksMovement: true,
    catalogId: "astral-bookshelf",
    description: "收着尚未写完的星图与几册旧手记。",
    flippable: true,
    height: 2,
    name: "星图书架",
    rotatable: false,
    width: 2,
  },
  "brass-telescope": {
    blocksMovement: true,
    catalogId: "brass-telescope",
    description: "黄铜镜筒安静朝着城市上方的夜空。",
    flippable: true,
    height: 2,
    name: "黄铜望远镜",
    rotatable: true,
    width: 2,
  },
  "cabin-desk": {
    blocksMovement: true,
    catalogId: "cabin-desk",
    description: "窗边的小桌留着一页写到一半的信。",
    flippable: true,
    height: 2,
    name: "窗边书桌",
    rotatable: true,
    width: 3,
  },
  "cabin-hearth": {
    blocksMovement: true,
    catalogId: "cabin-hearth",
    description: "炉火不急不缓，给木屋留下一圈暖光。",
    flippable: false,
    height: 2,
    name: "苔石壁炉",
    rotatable: false,
    width: 3,
  },
  "constellation-rug": {
    blocksMovement: false,
    catalogId: "constellation-rug",
    description: "细小星点在深蓝织面上连成一条回家路。",
    flippable: true,
    height: 2,
    name: "星座软毯",
    rotatable: true,
    width: 4,
  },
  "fern-pot": {
    blocksMovement: true,
    catalogId: "fern-pot",
    description: "新叶在木窗透进的光里慢慢舒展。",
    flippable: false,
    height: 2,
    name: "蕨叶陶盆",
    rotatable: false,
    width: 1,
  },
  "moon-crystal": {
    blocksMovement: true,
    catalogId: "moon-crystal",
    description: "一枚像月光凝成的小晶体，呼吸般明暗。",
    flippable: false,
    height: 1,
    name: "月光晶体",
    rotatable: false,
    width: 1,
  },
  "moss-rug": {
    blocksMovement: false,
    catalogId: "moss-rug",
    description: "像把林间一小块柔软青苔带进了屋。",
    flippable: true,
    height: 2,
    name: "青苔软毯",
    rotatable: true,
    width: 4,
  },
  "potted-palm": {
    blocksMovement: true,
    catalogId: "potted-palm",
    description: "叶影随着看不见的海风轻轻偏向窗边。",
    flippable: true,
    height: 2,
    name: "海风棕榈",
    rotatable: false,
    width: 1,
  },
  "roof-lantern": {
    blocksMovement: true,
    catalogId: "roof-lantern",
    description: "天色暗下来时，它替屋顶留一盏灯。",
    flippable: false,
    height: 1,
    name: "屋顶灯笼",
    rotatable: false,
    width: 1,
  },
  "rooftop-bench": {
    blocksMovement: true,
    catalogId: "rooftop-bench",
    description: "坐下就能看见远处一排亮起来的窗。",
    flippable: true,
    height: 1,
    name: "晚风长椅",
    rotatable: true,
    width: 3,
  },
  "seaside-bed": {
    blocksMovement: true,
    catalogId: "seaside-bed",
    description: "浅色床单里留着海盐与清晨的气息。",
    flippable: true,
    height: 2,
    name: "潮汐小床",
    rotatable: true,
    width: 3,
  },
  "shell-table": {
    blocksMovement: true,
    catalogId: "shell-table",
    description: "桌角摆着一枚会收藏浪声的小海螺。",
    flippable: true,
    height: 1,
    name: "贝壳边桌",
    rotatable: true,
    width: 2,
  },
  "star-workbench": {
    blocksMovement: true,
    catalogId: "star-workbench",
    description: "齿轮、纸页和一束星光都在这里找到位置。",
    flippable: true,
    height: 2,
    name: "星尘工作台",
    rotatable: true,
    width: 4,
  },
  "sunset-planter": {
    blocksMovement: true,
    catalogId: "sunset-planter",
    description: "耐风的小花在落日里显得格外明亮。",
    flippable: true,
    height: 1,
    name: "落日花箱",
    rotatable: true,
    width: 2,
  },
  "wave-rug": {
    blocksMovement: false,
    catalogId: "wave-rug",
    description: "浅蓝纹路一层层铺开，像安静的浪。",
    flippable: true,
    height: 2,
    name: "细浪软毯",
    rotatable: true,
    width: 4,
  },
};

export const TERRITORY_SCENES: Readonly<
  Record<TerritorySceneId, TerritorySceneCatalogEntry>
> = {
  "city-rooftop": {
    defaults: [
      {
        catalogId: "rooftop-bench",
        id: "city-rooftop.bench",
        layer: 2,
        x: 2,
        y: 5,
      },
      {
        catalogId: "sunset-planter",
        id: "city-rooftop.planter",
        layer: 2,
        x: 12,
        y: 4,
      },
      {
        catalogId: "brass-telescope",
        id: "city-rooftop.telescope",
        layer: 2,
        x: 9,
        y: 4,
      },
      {
        catalogId: "roof-lantern",
        id: "city-rooftop.lantern",
        layer: 2,
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
        catalogId: "cabin-hearth",
        id: "forest-cabin.hearth",
        layer: 2,
        x: 1,
        y: 4,
      },
      {
        catalogId: "cabin-desk",
        id: "forest-cabin.desk",
        layer: 2,
        x: 11,
        y: 4,
      },
      { catalogId: "fern-pot", id: "forest-cabin.fern", layer: 2, x: 5, y: 4 },
      { catalogId: "moss-rug", id: "forest-cabin.rug", layer: 1, x: 6, y: 7 },
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
        catalogId: "seaside-bed",
        id: "seaside-room.bed",
        layer: 2,
        x: 1,
        y: 4,
      },
      {
        catalogId: "shell-table",
        id: "seaside-room.table",
        layer: 2,
        x: 12,
        y: 5,
      },
      {
        catalogId: "potted-palm",
        id: "seaside-room.palm",
        layer: 2,
        x: 10,
        y: 4,
      },
      { catalogId: "wave-rug", id: "seaside-room.rug", layer: 1, x: 5, y: 7 },
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
        catalogId: "star-workbench",
        id: "star-workshop.workbench",
        layer: 2,
        x: 1,
        y: 4,
      },
      {
        catalogId: "astral-bookshelf",
        id: "star-workshop.bookshelf",
        layer: 2,
        x: 12,
        y: 4,
      },
      {
        catalogId: "moon-crystal",
        id: "star-workshop.crystal",
        layer: 2,
        x: 9,
        y: 5,
      },
      {
        catalogId: "constellation-rug",
        id: "star-workshop.rug",
        layer: 1,
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

export function describeTerritoryItem(
  item: Pick<
    TerritoryItem,
    | "catalogId"
    | "flipped"
    | "id"
    | "layer"
    | "location"
    | "pinned"
    | "placedAt"
    | "rotation"
    | "sceneId"
    | "updatedAt"
    | "x"
    | "y"
  >,
): TerritoryItem {
  const definition = TERRITORY_ITEMS[item.catalogId];
  return {
    ...item,
    blocksMovement: definition.blocksMovement,
    description: definition.description,
    flippable: definition.flippable,
    height: definition.height,
    name: definition.name,
    rotatable: definition.rotatable,
    visual: definition.catalogId,
    width: definition.width,
  };
}
