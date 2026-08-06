import { Container, Graphics, Sprite, type Texture } from "pixi.js";

import type {
  TerritoryItem,
  TerritorySceneDefinition,
} from "../../../shared/contracts/territory";

export const TERRITORY_TILE_SIZE = 48;
export const TERRITORY_SCENE_WIDTH = 16 * TERRITORY_TILE_SIZE;
export const TERRITORY_SCENE_HEIGHT = 10 * TERRITORY_TILE_SIZE;

function rectangle(
  parent: Container,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  alpha = 1,
): Graphics {
  const graphic = new Graphics()
    .rect(Math.round(x), Math.round(y), Math.round(width), Math.round(height))
    .fill({ alpha, color });
  parent.addChild(graphic);
  return graphic;
}

function circle(
  parent: Container,
  x: number,
  y: number,
  radius: number,
  color: string,
  alpha = 1,
): Graphics {
  const graphic = new Graphics()
    .circle(Math.round(x), Math.round(y), Math.round(radius))
    .fill({ alpha, color });
  parent.addChild(graphic);
  return graphic;
}

function drawFloor(
  parent: Container,
  definition: TerritorySceneDefinition,
): void {
  const { palette } = definition;
  rectangle(parent, 0, 192, TERRITORY_SCENE_WIDTH, 288, palette.floor);
  for (let y = 4; y < 10; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      if ((x + y) % 2 === 0) {
        rectangle(
          parent,
          x * TERRITORY_TILE_SIZE,
          y * TERRITORY_TILE_SIZE,
          TERRITORY_TILE_SIZE,
          TERRITORY_TILE_SIZE,
          palette.floorAlt,
          0.42,
        );
      }
      rectangle(
        parent,
        x * TERRITORY_TILE_SIZE,
        y * TERRITORY_TILE_SIZE,
        TERRITORY_TILE_SIZE,
        2,
        palette.shadow,
        0.16,
      );
    }
  }
  rectangle(parent, 0, 190, TERRITORY_SCENE_WIDTH, 6, palette.shadow, 0.52);
}

function drawForestCabin(
  parent: Container,
  definition: TerritorySceneDefinition,
): void {
  const { palette } = definition;
  rectangle(parent, 0, 0, TERRITORY_SCENE_WIDTH, 192, palette.wall);
  for (let x = 0; x < TERRITORY_SCENE_WIDTH; x += 96) {
    rectangle(parent, x, 0, 8, 192, palette.shadow, 0.2);
  }
  rectangle(parent, 268, 30, 232, 132, palette.shadow);
  rectangle(parent, 278, 40, 212, 112, palette.sky);
  rectangle(parent, 379, 40, 10, 112, palette.shadow, 0.75);
  rectangle(parent, 278, 91, 212, 9, palette.shadow, 0.65);
  for (const [x, y, radius] of [
    [305, 64, 28],
    [347, 52, 34],
    [430, 61, 36],
    [473, 51, 25],
  ] as const) {
    circle(parent, x, y, radius, palette.ambient, 0.76);
  }
  rectangle(parent, 0, 168, TERRITORY_SCENE_WIDTH, 24, palette.shadow, 0.24);
}

function drawSeasideRoom(
  parent: Container,
  definition: TerritorySceneDefinition,
): void {
  const { palette } = definition;
  rectangle(parent, 0, 0, TERRITORY_SCENE_WIDTH, 192, palette.wall);
  rectangle(parent, 168, 22, 432, 148, palette.shadow);
  rectangle(parent, 178, 32, 412, 128, palette.sky);
  rectangle(parent, 178, 104, 412, 56, palette.ambient, 0.82);
  rectangle(parent, 178, 126, 412, 34, "#4ea8bf", 0.62);
  for (const y of [118, 137, 151]) {
    for (let x = 190 + ((y / 3) % 18); x < 580; x += 62) {
      rectangle(parent, x, y, 34, 3, "#e9fbf5", 0.68);
    }
  }
  rectangle(parent, 378, 32, 10, 128, palette.shadow, 0.62);
  rectangle(parent, 178, 91, 412, 8, palette.shadow, 0.5);
  circle(parent, 520, 62, 22, palette.accent, 0.88);
}

function drawCityRooftop(
  parent: Container,
  definition: TerritorySceneDefinition,
): void {
  const { palette } = definition;
  rectangle(parent, 0, 0, TERRITORY_SCENE_WIDTH, 192, palette.sky);
  circle(parent, 620, 58, 32, palette.accent, 0.75);
  const buildings = [
    [0, 84, 92, 108],
    [80, 112, 84, 80],
    [150, 68, 104, 124],
    [242, 103, 70, 89],
    [298, 54, 118, 138],
    [402, 96, 86, 96],
    [474, 74, 126, 118],
    [590, 110, 78, 82],
    [650, 58, 118, 134],
  ] as const;
  for (const [x, y, width, height] of buildings) {
    rectangle(parent, x, y, width, height, palette.shadow, 0.9);
    for (let wx = x + 14; wx < x + width - 10; wx += 24) {
      for (let wy = y + 18; wy < y + height - 8; wy += 24) {
        if ((wx + wy) % 3 !== 0) {
          rectangle(parent, wx, wy, 7, 9, palette.accent, 0.64);
        }
      }
    }
  }
  rectangle(parent, 0, 164, TERRITORY_SCENE_WIDTH, 28, palette.wall);
  rectangle(parent, 0, 164, TERRITORY_SCENE_WIDTH, 5, palette.accent, 0.42);
}

function drawStarWorkshop(
  parent: Container,
  definition: TerritorySceneDefinition,
): void {
  const { palette } = definition;
  rectangle(parent, 0, 0, TERRITORY_SCENE_WIDTH, 192, palette.wall);
  rectangle(parent, 186, 22, 396, 148, palette.shadow);
  rectangle(parent, 196, 32, 376, 128, palette.sky);
  const stars = [
    [218, 54],
    [259, 87],
    [304, 49],
    [344, 121],
    [393, 72],
    [438, 46],
    [476, 108],
    [526, 65],
    [548, 132],
  ] as const;
  for (const [x, y] of stars) {
    rectangle(parent, x, y, 5, 5, palette.accent, 0.9);
    rectangle(parent, x + 2, y - 3, 1, 11, palette.accent, 0.5);
  }
  circle(parent, 314, 92, 22, palette.ambient, 0.38);
  circle(parent, 469, 87, 14, palette.accent, 0.32);
  rectangle(parent, 379, 32, 9, 128, palette.shadow, 0.7);
  rectangle(parent, 196, 93, 376, 7, palette.shadow, 0.58);
  for (const x of [48, 690]) {
    circle(parent, x, 118, 35, palette.shadow, 0.52);
    circle(parent, x, 118, 21, palette.ambient, 0.48);
  }
}

export function createTerritoryEnvironment(
  definition: TerritorySceneDefinition,
): Container {
  const environment = new Container();
  rectangle(
    environment,
    0,
    0,
    TERRITORY_SCENE_WIDTH,
    TERRITORY_SCENE_HEIGHT,
    definition.palette.sky,
  );
  switch (definition.id) {
    case "forest-cabin":
      drawForestCabin(environment, definition);
      break;
    case "seaside-room":
      drawSeasideRoom(environment, definition);
      break;
    case "city-rooftop":
      drawCityRooftop(environment, definition);
      break;
    case "star-workshop":
      drawStarWorkshop(environment, definition);
      break;
  }
  drawFloor(environment, definition);
  return environment;
}

function drawRug(
  parent: Container,
  width: number,
  height: number,
  color: string,
) {
  rectangle(parent, 4, 10, width - 8, height - 16, "#2c3045", 0.3);
  rectangle(parent, 7, 7, width - 14, height - 16, color, 0.92);
  rectangle(parent, 15, 16, width - 30, 4, "#f5e0a5", 0.62);
  rectangle(parent, 15, height - 22, width - 30, 4, "#f5e0a5", 0.46);
}

export function createTerritoryItemGraphic(
  item: TerritoryItem,
  assetTexture?: Texture,
): Container {
  const graphic = new Container();
  const art = new Container();
  graphic.addChild(art);
  const { height, width } = item.manifest.visual.sizePx;
  const source = item.manifest.visual.source;
  const visualKey = source.kind === "builtin" ? source.key : source.assetId;
  const shadow = "#293143";

  if (visualKey.endsWith("rug")) {
    drawRug(
      art,
      width,
      height,
      visualKey === "moss-rug"
        ? "#69875f"
        : visualKey === "wave-rug"
          ? "#61aab9"
          : "#5b4f91",
    );
    return graphic;
  }

  if (visualKey === "ceramic-cup") {
    rectangle(art, 4, 9, 16, 16, "#c47759");
    rectangle(art, 7, 11, 10, 11, "#e5a77f");
    circle(art, 20, 15, 5, "#c47759");
    circle(art, 20, 15, 2, "#845744");
    rectangle(art, 4, 24, 16, 3, shadow, 0.25);
    return graphic;
  }
  if (visualKey === "folded-letter") {
    rectangle(art, 1, 2, 28, 13, "#f2dfad");
    const fold = new Graphics()
      .poly([2, 3, 15, 11, 28, 3])
      .stroke({ alpha: 0.55, color: "#b68d61", width: 1 });
    art.addChild(fold);
    rectangle(art, 3, 14, 24, 2, shadow, 0.2);
    return graphic;
  }
  if (visualKey === "tiny-succulent") {
    rectangle(art, 6, 21, 14, 11, "#b76f52");
    rectangle(art, 8, 30, 10, 3, shadow, 0.26);
    for (const [x, y, radius] of [
      [13, 17, 7],
      [8, 13, 6],
      [18, 12, 6],
      [13, 7, 7],
    ] as const) {
      circle(art, x, y, radius, "#6e9a72");
    }
    return graphic;
  }

  if (source.kind === "asset") {
    if (assetTexture) {
      const sprite = new Sprite(assetTexture);
      sprite.width = width;
      sprite.height = height;
      art.addChild(sprite);
      return graphic;
    }
    rectangle(art, 1, 1, width - 2, height - 2, "#7669a9", 0.32);
    rectangle(art, 5, 5, width - 10, height - 10, "#e7ddff", 0.34);
    circle(
      art,
      width / 2,
      height / 2,
      Math.min(width, height) / 5,
      "#f2d883",
      0.8,
    );
    return graphic;
  }

  rectangle(art, 6, height - 12, width - 12, 9, shadow, 0.28);
  switch (visualKey) {
    case "cabin-hearth": {
      rectangle(art, 10, 14, width - 20, height - 18, "#6c6258");
      for (let y = 19; y < height - 8; y += 19) {
        for (let x = 15 + ((y / 19) % 2) * 10; x < width - 15; x += 31) {
          rectangle(art, x, y, 22, 11, "#a59a85", 0.78);
        }
      }
      rectangle(art, 42, 45, width - 84, height - 48, "#3a2e2d");
      circle(art, width / 2, height - 25, 17, "#e56f3b");
      circle(art, width / 2, height - 30, 9, "#ffd56a");
      break;
    }
    case "cabin-desk":
    case "star-workbench": {
      const top = visualKey === "star-workbench" ? "#5d527b" : "#865d40";
      rectangle(art, 6, 34, width - 12, 19, top);
      rectangle(art, 14, 51, 13, height - 56, shadow, 0.82);
      rectangle(art, width - 27, 51, 13, height - 56, shadow, 0.82);
      rectangle(art, 10, 28, width - 20, 6, "#d5b57a", 0.35);
      break;
    }
    case "fern-pot":
    case "potted-palm": {
      const leaf = visualKey === "fern-pot" ? "#64895d" : "#4f9a82";
      rectangle(art, 13, 56, width - 26, height - 62, "#b76f52");
      for (const [x, y, radius] of [
        [24, 46, 16],
        [13, 37, 13],
        [35, 31, 14],
        [22, 18, 15],
      ] as const) {
        circle(art, x, y, radius, leaf);
      }
      rectangle(art, 21, 27, 5, 35, "#45694f");
      break;
    }
    case "seaside-bed": {
      rectangle(art, 5, 32, width - 10, height - 37, "#8f725c");
      rectangle(art, 10, 18, width - 15, 57, "#dfe8df");
      rectangle(art, 18, 24, 43, 23, "#f7f0d9");
      rectangle(art, 65, 22, width - 75, 49, "#7fb8c5", 0.8);
      rectangle(art, 10, 70, width - 15, 8, "#efcc88", 0.7);
      break;
    }
    case "shell-table": {
      rectangle(art, 7, 22, width - 14, 18, "#c28a64");
      rectangle(art, 19, 40, 12, height - 44, "#795c52");
      rectangle(art, width - 31, 40, 12, height - 44, "#795c52");
      rectangle(art, 12, 17, width - 24, 5, "#f2d6bc", 0.45);
      break;
    }
    case "rooftop-bench": {
      rectangle(art, 5, 11, width - 10, 13, "#986e56");
      rectangle(art, 10, 29, width - 20, 11, "#b88662");
      rectangle(art, 17, 39, 11, height - 43, shadow, 0.8);
      rectangle(art, width - 28, 39, 11, height - 43, shadow, 0.8);
      break;
    }
    case "sunset-planter": {
      rectangle(art, 7, 20, width - 14, height - 24, "#91634f");
      for (let x = 17; x < width - 10; x += 18) {
        circle(art, x, 17, 9, x % 3 === 0 ? "#f0ae6d" : "#d86e78");
        rectangle(art, x - 2, 19, 4, 12, "#5d865e");
      }
      break;
    }
    case "brass-telescope": {
      rectangle(art, 27, 17, width - 38, 18, "#d6a650");
      circle(art, 26, 26, 15, "#6b5361");
      rectangle(art, 46, 37, 8, height - 42, "#8f6e4d");
      rectangle(art, 26, height - 12, 55, 6, shadow, 0.7);
      break;
    }
    case "roof-lantern": {
      rectangle(art, 13, 9, width - 26, height - 14, "#5a4450");
      rectangle(art, 18, 14, width - 36, height - 24, "#f5b85d");
      rectangle(art, 20, 2, width - 40, 8, "#3c3b4a");
      break;
    }
    case "astral-bookshelf": {
      rectangle(art, 7, 5, width - 14, height - 10, "#4e4164");
      for (const y of [31, 60]) {
        rectangle(art, 12, y, width - 24, 6, "#2d2946");
      }
      const bookColors = ["#d06b71", "#6aa2a8", "#d5af64", "#7a70b5"];
      for (let row = 0; row < 3; row += 1) {
        for (let x = 14; x < width - 16; x += 13) {
          rectangle(
            art,
            x,
            12 + row * 29,
            9,
            16 + ((x + row) % 8),
            bookColors[(x + row) % bookColors.length] ?? "#d5af64",
          );
        }
      }
      break;
    }
    case "moon-crystal": {
      const crystal = new Graphics()
        .poly([24, 3, 41, 20, 33, 43, 15, 43, 7, 20])
        .fill("#b9e7e4");
      art.addChild(crystal);
      rectangle(art, 21, 8, 6, 27, "#ffffff", 0.54);
      circle(art, 24, 27, 25, "#8c7bd4", 0.16);
      break;
    }
  }
  return graphic;
}
