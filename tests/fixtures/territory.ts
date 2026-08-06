import type { TerritorySnapshot } from "../../src/shared/contracts/territory";

const basePalette = {
  accent: "#e8bb67",
  ambient: "#89a56f",
  floor: "#8a6849",
  floorAlt: "#987555",
  shadow: "#314936",
  sky: "#55745c",
  wall: "#c49a6c",
};

export const territorySceneSummaries: TerritorySnapshot["availableScenes"] = [
  {
    description: "木墙、炉火和潮湿青苔围成一间安静的小屋。",
    id: "forest-cabin",
    name: "林间小屋",
    palette: basePalette,
    poem: "这里会慢慢装下，我们一起走过的日子。",
  },
  {
    description: "窗外总有缓慢潮声，浅色房间盛着一整片晴朗。",
    id: "seaside-room",
    name: "海边房间",
    palette: { ...basePalette, accent: "#f3c979", sky: "#75c9df" },
    poem: "潮汐来去，留下值得记住的微光。",
  },
  {
    description: "晚风越过低矮天台，城市灯火从脚下一盏盏亮起。",
    id: "city-rooftop",
    name: "城市天台",
    palette: { ...basePalette, accent: "#ffb45f", sky: "#424d72" },
    poem: "让晚风替我们，把今天轻轻收好。",
  },
  {
    description: "星图、齿轮与蓝紫微光，把夜晚变成一间小工坊。",
    id: "star-workshop",
    name: "星空工坊",
    palette: { ...basePalette, accent: "#f0c66f", sky: "#292846" },
    poem: "每一点微光，都在等一个属于它的故事。",
  },
];

export const emptyTerritorySnapshot: TerritorySnapshot = {
  activeScene: null,
  availableScenes: territorySceneSummaries,
  collection: [],
};

export const activeTerritorySnapshot: TerritorySnapshot = {
  activeScene: {
    definition: {
      ...territorySceneSummaries[0]!,
      entry: { x: 8, y: 6 },
      height: 10,
      placeableRows: [
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
      ],
      walkableRows: [
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
      ],
      width: 16,
    },
    pet: { facing: "right", x: 8, y: 6 },
    placements: [
      {
        blocksMovement: true,
        catalogId: "cabin-hearth",
        description: "炉火不急不缓，给木屋留下一圈暖光。",
        flipped: false,
        flippable: false,
        height: 2,
        id: "forest-cabin.hearth",
        layer: 2,
        location: "scene",
        name: "苔石壁炉",
        pinned: false,
        placedAt: "2026-08-06T08:00:00.000Z",
        rotatable: false,
        rotation: 0,
        sceneId: "forest-cabin",
        updatedAt: "2026-08-06T08:00:00.000Z",
        visual: "cabin-hearth",
        width: 3,
        x: 1,
        y: 4,
      },
    ],
  },
  availableScenes: territorySceneSummaries,
  collection: [],
};
