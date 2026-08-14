import { Container, Graphics, Sprite, type Texture } from "pixi.js";

import type {
  TerritoryDefinition,
  TerritoryStyleProfile,
} from "../../../shared/contracts/territoryWorld";

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

function roundedRectangle(
  parent: Container,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
  alpha = 1,
): Graphics {
  const graphic = new Graphics()
    .roundRect(
      Math.round(x),
      Math.round(y),
      Math.round(width),
      Math.round(height),
      radius,
    )
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

function canonicalVisualKey(definition: TerritoryDefinition): string {
  return definition.visual.assetId.split(".").at(-1) ?? definition.id;
}

function drawFloorTile(
  art: Container,
  style: TerritoryStyleProfile,
  variant: number,
): void {
  const base = variant % 2 === 0 ? "#6f4d42" : "#765347";
  rectangle(art, 0, 0, 48, 48, base);
  rectangle(art, 0, 0, 48, 3, style.palette.light, 0.09);
  rectangle(art, 0, 45, 48, 3, style.palette.dark, 0.2);
  rectangle(art, 0, 0, 2, 48, style.palette.dark, 0.11);
  rectangle(art, 46, 0, 2, 48, style.palette.light, 0.05);
  if (variant % 3 === 0) {
    rectangle(art, 11, 10, 21, 2, style.palette.light, 0.045);
    rectangle(art, 30, 31, 13, 2, style.palette.dark, 0.08);
  }
}

function drawCabinWall(
  art: Container,
  style: TerritoryStyleProfile,
  width: number,
  height: number,
): void {
  rectangle(art, 0, 0, width, height, "#35394b");
  rectangle(art, 0, 0, width, 18, "#252a39");
  for (let y = 22; y < height; y += 27) {
    rectangle(art, 0, y, width, 2, style.palette.light, 0.045);
  }
  for (let x = 0; x < width; x += 96) {
    rectangle(art, x, 0, 8, height, "#242936", 0.72);
    rectangle(art, x + 8, 0, 3, height, style.palette.light, 0.055);
  }

  const windowX = Math.round(width * 0.35);
  const windowWidth = Math.round(width * 0.3);
  roundedRectangle(
    art,
    windowX - 8,
    24,
    windowWidth + 16,
    height - 44,
    4,
    "#202332",
  );
  rectangle(art, windowX, 32, windowWidth, height - 60, "#212d47");
  rectangle(art, windowX, 32, windowWidth, 35, "#324968");
  circle(art, windowX + windowWidth - 35, 54, 17, "#f0d4a0", 0.9);
  circle(art, windowX + 31, 58, 2, "#e8f1ff", 0.75);
  circle(art, windowX + 64, 44, 2, "#e8f1ff", 0.6);
  circle(art, windowX + 98, 61, 1.5, "#e8f1ff", 0.65);
  const treeColor = "#172d35";
  for (let x = windowX + 8; x < windowX + windowWidth; x += 26) {
    const treeHeight = 36 + ((x / 13) % 3) * 8;
    const tree = new Graphics()
      .poly([
        x,
        height - 28,
        x + 13,
        height - 28 - treeHeight,
        x + 26,
        height - 28,
      ])
      .fill({ color: treeColor });
    art.addChild(tree);
  }
  rectangle(art, windowX + windowWidth / 2 - 4, 32, 8, height - 60, "#262b38");
  rectangle(art, windowX, 92, windowWidth, 7, "#262b38");
  rectangle(art, windowX - 4, height - 28, windowWidth + 8, 8, "#675040");

  roundedRectangle(art, 42, 51, 104, 65, 4, "#252936");
  rectangle(art, 50, 59, 88, 49, "#765b48", 0.55);
  rectangle(art, 57, 66, 74, 35, "#2b3040");
  circle(art, 73, 83, 9, style.palette.accent, 0.68);
  circle(art, 91, 78, 3, style.palette.light, 0.75);
  circle(art, 112, 91, 4, "#9fc2c4", 0.6);

  for (const x of [width - 138, width - 105, width - 72]) {
    rectangle(art, x, 65, 22, 72, "#2a2e3c");
    roundedRectangle(art, x + 4, 72, 14, 58, 7, "#49516b", 0.62);
  }
  rectangle(art, 0, height - 10, width, 10, "#292b38");
}

function drawDesk(art: Container, width: number, height: number): void {
  rectangle(art, 5, 33, width - 10, 18, "#875e43");
  rectangle(art, 9, 27, width - 18, 7, "#c59a67", 0.68);
  rectangle(art, 14, 51, 14, height - 57, "#4f3a35");
  rectangle(art, width - 28, 51, 14, height - 57, "#4f3a35");
  rectangle(art, 31, 54, width - 62, 31, "#684738");
  rectangle(art, 37, 59, width - 74, 4, "#a47450", 0.65);
  circle(art, width / 2, 72, 3, "#d8b878", 0.75);
}

function drawHearth(art: Container, width: number, height: number): void {
  roundedRectangle(art, 5, 6, width - 10, height - 10, 7, "#5c5a58");
  for (let y = 12; y < height - 13; y += 18) {
    for (let x = 11 + (Math.floor(y / 18) % 2) * 13; x < width - 17; x += 29) {
      roundedRectangle(art, x, y, 22, 11, 2, "#86837d", 0.78);
    }
  }
  roundedRectangle(art, 37, 39, width - 74, height - 42, 13, "#28252a");
  circle(art, width / 2, height - 24, 22, "#b84932", 0.48);
  circle(art, width / 2 - 7, height - 22, 13, "#e96f3f", 0.92);
  circle(art, width / 2 + 8, height - 24, 12, "#f3a244", 0.92);
  circle(art, width / 2 + 1, height - 31, 8, "#ffe08a", 0.95);
  rectangle(art, 3, 4, width - 6, 10, "#454449");
}

function drawBookshelf(art: Container, width: number, height: number): void {
  roundedRectangle(art, 3, 2, width - 6, height - 5, 4, "#473a58");
  rectangle(art, 9, 8, width - 18, height - 17, "#29293c");
  const colors = ["#c76670", "#6e9ea2", "#d3a85e", "#756bab", "#8aaf72"];
  for (let row = 0; row < 3; row += 1) {
    const shelfY = 30 + row * 28;
    rectangle(art, 8, shelfY, width - 16, 5, "#554263");
    for (let x = 13; x < width - 15; x += 11) {
      rectangle(
        art,
        x,
        shelfY - 17 - ((x + row) % 5),
        8,
        17 + ((x + row) % 5),
        colors[(x + row) % colors.length] ?? colors[0]!,
      );
    }
  }
  circle(art, width - 21, 15, 4, "#d9d1f2", 0.72);
}

function drawRug(art: Container, width: number, height: number): void {
  roundedRectangle(art, 4, 6, width - 8, height - 12, 20, "#365b58", 0.93);
  roundedRectangle(art, 11, 13, width - 22, height - 26, 15, "#4d7470", 0.8);
  roundedRectangle(art, 20, 22, width - 40, height - 44, 12, "#294b4b", 0.32);
  for (let y = 32; y < height - 24; y += 42) {
    for (let x = 34 + ((y / 42) % 2) * 18; x < width - 24; x += 56) {
      circle(art, x, y, 2, "#d7d89b", 0.72);
      rectangle(art, x - 5, y, 10, 1, "#d7d89b", 0.32);
      rectangle(art, x, y - 5, 1, 10, "#d7d89b", 0.24);
    }
  }
  for (let x = 16; x < width - 15; x += 18) {
    rectangle(art, x, 5, 8, 3, "#9ab08c", 0.45);
    rectangle(art, x, height - 8, 8, 3, "#203c3d", 0.5);
  }
}

function drawRunner(art: Container, width: number, height: number): void {
  roundedRectangle(art, 3, 8, width - 6, height - 16, 13, "#785455", 0.94);
  roundedRectangle(art, 10, 15, width - 20, height - 30, 9, "#a06d62", 0.55);
  for (let x = 19; x < width - 18; x += 28) {
    const color = x % 56 === 19 ? "#d1a565" : "#667f73";
    rectangle(art, x, 24, 14, height - 48, color, 0.65);
  }
  for (let x = 8; x < width - 8; x += 13) {
    rectangle(art, x, 3, 6, 8, "#d2b58a", 0.55);
    rectangle(art, x, height - 11, 6, 8, "#d2b58a", 0.42);
  }
}

function drawCanopyBed(art: Container, width: number, height: number): void {
  rectangle(art, 12, 13, 9, height - 18, "#49382f");
  rectangle(art, width - 21, 13, 9, height - 18, "#49382f");
  rectangle(art, 16, 10, width - 32, 8, "#6e503b");
  roundedRectangle(art, 23, 43, width - 46, height - 57, 18, "#8a9b83");
  roundedRectangle(art, 31, 53, width - 62, height - 76, 14, "#b9b08f");
  roundedRectangle(art, 39, 55, width * 0.34, 43, 13, "#d7ceb0");
  roundedRectangle(art, width * 0.56, 56, width * 0.27, 39, 12, "#839c91");
  rectangle(art, 23, height - 36, width - 46, 27, "#5c4539");
  rectangle(art, 32, height - 32, width - 64, 8, "#8b6748", 0.74);
  for (const [x, y, color] of [
    [18, 34, "#c78a5e"],
    [width - 18, 49, "#7fa19b"],
    [18, 67, "#d7b467"],
  ] as const) {
    circle(art, x, y, 5, color, 0.9);
  }
}

function drawSmallTable(
  art: Container,
  width: number,
  height: number,
  variant: "bedside" | "side",
): void {
  roundedRectangle(art, 4, 25, width - 8, height - 30, 5, "#654838");
  rectangle(art, 8, 20, width - 16, 12, "#9a6a49");
  rectangle(art, 11, 41, width - 22, 4, "#b07b51", 0.55);
  circle(art, width / 2, 53, 3, "#d8b777", 0.85);
  rectangle(art, 10, height - 12, 9, 10, "#3f3330");
  rectangle(art, width - 19, height - 12, 9, 10, "#3f3330");
  if (variant === "side") {
    rectangle(art, 13, 63, width - 26, 13, "#302c32");
    circle(art, width - 17, 69, 4, "#b86459", 0.9);
    circle(art, width - 10, 72, 4, "#6d9b7b", 0.9);
  } else {
    rectangle(art, 15, 67, width - 30, 4, "#d6c79f", 0.28);
  }
}

function drawLogBasket(art: Container, width: number, height: number): void {
  for (const [x, y, rotation] of [
    [19, 30, -0.18],
    [44, 20, 0.12],
    [68, 28, -0.08],
  ] as const) {
    const log = new Graphics()
      .roundRect(-8, -26, 16, 52, 7)
      .fill({ color: "#74513a" });
    log.position.set(x, y + 20);
    log.rotation = rotation;
    art.addChild(log);
    circle(art, x, y - 6, 5, "#b17a4e", 0.82);
  }
  roundedRectangle(art, 8, height - 47, width - 16, 40, 14, "#876947");
  for (let x = 15; x < width - 12; x += 13) {
    rectangle(art, x, height - 43, 5, 32, "#b28c59", 0.62);
  }
  const handle = new Graphics()
    .moveTo(17, height - 38)
    .bezierCurveTo(24, 25, width - 24, 25, width - 17, height - 38)
    .stroke({ color: "#5a4635", width: 6 });
  art.addChild(handle);
}

function drawDivider(art: Container, width: number, height: number): void {
  rectangle(art, 4, 0, width - 8, height, "#4b3d35");
  for (let y = 14; y < height - 14; y += 36) {
    rectangle(art, 9, y, width - 18, 7, "#866344");
  }
  rectangle(art, width / 2 - 3, 4, 6, height - 8, "#916c49", 0.8);
  circle(art, 14, 32, 5, "#d5ae62");
  rectangle(art, 12, 35, 4, 21, "#b96959");
  circle(art, width - 14, 93, 6, "#729b83");
  rectangle(art, width - 16, 98, 5, 28, "#d7c5a0");
  circle(art, 15, 152, 4, "#86a4a3");
}

function drawSofa(art: Container, width: number, height: number): void {
  roundedRectangle(art, 12, 28, width - 24, height - 45, 24, "#536f68");
  roundedRectangle(art, 22, 38, width - 44, 67, 18, "#708b7c");
  roundedRectangle(art, 18, 95, width - 36, 50, 18, "#7e927f");
  rectangle(art, width / 2 - 2, 100, 4, 41, "#405d58", 0.55);
  roundedRectangle(art, 2, 71, 30, 69, 13, "#46635f");
  roundedRectangle(art, width - 32, 71, 30, 69, 13, "#46635f");
  rectangle(art, 31, height - 26, 17, 22, "#40352f");
  rectangle(art, width - 48, height - 26, 17, 22, "#40352f");
  rectangle(art, width - 84, 110, 58, 7, "#d0a76c", 0.36);
}

function drawCoffeeTable(art: Container, width: number, height: number): void {
  roundedRectangle(art, 4, 26, width - 8, 30, 8, "#875e43");
  rectangle(art, 13, 22, width - 26, 8, "#c09666", 0.66);
  rectangle(art, 22, 55, 13, height - 61, "#4b3932");
  rectangle(art, width - 35, 55, 13, height - 61, "#4b3932");
  rectangle(art, 35, 62, width - 70, 10, "#5f4538");
  circle(art, width * 0.34, 38, 15, "#563e37", 0.22);
  rectangle(art, width * 0.62, 35, 39, 2, "#2e3036", 0.45);
}

function drawReadingChair(art: Container, width: number, height: number): void {
  roundedRectangle(art, 20, 24, width - 40, 91, 27, "#765d78");
  roundedRectangle(art, 28, 37, width - 56, 66, 21, "#9a7890");
  roundedRectangle(art, 13, 92, width - 26, 47, 18, "#896c80");
  roundedRectangle(art, 2, 74, 30, 69, 15, "#624f69");
  roundedRectangle(art, width - 32, 74, 30, 69, 15, "#624f69");
  rectangle(art, 28, height - 25, 15, 21, "#40342f");
  rectangle(art, width - 43, height - 25, 15, 21, "#40342f");
  const cardigan = new Graphics()
    .poly([width - 56, 29, width - 19, 47, width - 32, 122, width - 71, 99])
    .fill({ alpha: 0.8, color: "#b4a06f" });
  art.addChild(cardigan);
}

function drawFloorLamp(art: Container, width: number, height: number): void {
  circle(art, width / 2 + 7, 35, 31, "#e6b66e", 0.12);
  const shade = new Graphics()
    .poly([10, 46, width / 2 + 7, 13, width - 1, 49])
    .fill({ color: "#c69257" });
  art.addChild(shade);
  circle(art, width / 2 + 7, 33, 7, "#fff0a9", 0.95);
  rectangle(art, width / 2 + 3, 48, 7, height - 68, "#8b714f");
  roundedRectangle(art, 9, height - 25, width - 18, 18, 9, "#665544");
  rectangle(art, width / 2 - 1, 48, 2, height - 70, "#d9bd7a", 0.46);
}

function drawTeaCart(art: Container, width: number): void {
  roundedRectangle(art, 7, 28, width - 14, 21, 6, "#9a704c");
  rectangle(art, 12, 24, width - 24, 7, "#d1a66d", 0.62);
  rectangle(art, 15, 50, 7, 49, "#5d4638");
  rectangle(art, width - 22, 50, 7, 49, "#5d4638");
  roundedRectangle(art, 14, 73, width - 28, 16, 5, "#71513f");
  for (const x of [23, width - 23]) circle(art, x, 106, 9, "#30343b");
  circle(art, 28, 39, 9, "#7d9d93");
  rectangle(art, 46, 32, 16, 14, "#d7c399");
  circle(art, 81, 38, 10, "#b66b59");
  roundedRectangle(art, 34, 76, 31, 11, 4, "#c19d61");
}

function drawTallFern(art: Container, width: number, height: number): void {
  roundedRectangle(art, 17, height - 49, width - 34, 43, 10, "#9d624b");
  rectangle(art, 23, height - 44, width - 46, 7, "#d28b69", 0.5);
  for (const [offset, tilt, leafColor] of [
    [-25, -0.32, "#628f68"],
    [-10, -0.15, "#779e70"],
    [5, 0.08, "#527b5e"],
    [22, 0.27, "#6f9b70"],
  ] as const) {
    const stem = new Graphics()
      .moveTo(0, 0)
      .bezierCurveTo(offset * 0.2, -42, offset * 0.65, -87, offset, -121)
      .stroke({ color: "#405f4c", width: 4 });
    stem.position.set(width / 2, height - 42);
    art.addChild(stem);
    for (let y = 35; y < 112; y += 18) {
      const x = width / 2 + (offset * y) / 121;
      circle(art, x - 11 + tilt * y * 0.2, height - 42 - y, 10, leafColor, 0.9);
      circle(art, x + 10 + tilt * y * 0.2, height - 48 - y, 9, leafColor, 0.82);
    }
  }
  rectangle(art, width - 28, height - 33, 17, 12, "#d7c590");
}

function drawChest(art: Container, width: number, height: number): void {
  roundedRectangle(art, 5, 19, width - 10, height - 25, 10, "#6e4d3b");
  roundedRectangle(art, 9, 11, width - 18, 37, 13, "#916344");
  rectangle(art, 5, 38, width - 10, 8, "#3c3536");
  rectangle(art, 22, 12, 8, height - 22, "#b18357", 0.62);
  rectangle(art, width - 30, 12, 8, height - 22, "#b18357", 0.62);
  roundedRectangle(art, width / 2 - 13, 38, 26, 24, 5, "#c29456");
  circle(art, width / 2, 49, 4, "#453932");
  for (const [x, y, color] of [
    [39, 25, "#6e9d91"],
    [67, 57, "#c36d5d"],
    [width - 52, 28, "#d3ae62"],
    [width - 75, 67, "#8293ad"],
  ] as const) {
    roundedRectangle(art, x, y, 26, 14, 3, color, 0.82);
  }
}

function drawPetBed(art: Container, width: number, height: number): void {
  roundedRectangle(art, 5, 16, width - 10, height - 20, 27, "#6b7e72");
  roundedRectangle(art, 18, 24, width - 36, height - 36, 20, "#ac9f7d");
  circle(art, width * 0.35, 39, 12, "#c78469");
  circle(art, width * 0.68, 43, 10, "#739b93");
  rectangle(art, width * 0.7, 27, 25, 8, "#d3bc8c");
  circle(art, width * 0.7, 31, 7, "#d3bc8c");
}

function drawSewingTable(art: Container, width: number, height: number): void {
  rectangle(art, 5, 37, width - 10, 20, "#7d5742");
  rectangle(art, 12, 31, width - 24, 8, "#bd8b5e", 0.68);
  rectangle(art, 16, 57, 13, height - 63, "#493832");
  rectangle(art, width - 29, 57, 13, height - 63, "#493832");
  roundedRectangle(art, 53, 3, 65, 39, 7, "#3f454d");
  rectangle(art, 65, 9, 41, 7, "#aab0aa");
  rectangle(art, 83, 15, 6, 20, "#c7ae75");
  circle(art, 119, 28, 15, "#232931");
  circle(art, 119, 28, 8, "#9c7c54");
  const cloth = new Graphics()
    .poly([104, 43, 151, 35, 158, 75, 117, 83])
    .fill({ alpha: 0.88, color: "#866b86" });
  art.addChild(cloth);
  rectangle(art, 119, 57, 3, 22, "#d2ad68", 0.7);
}

function drawStool(art: Container, width: number, height: number): void {
  roundedRectangle(art, 7, 17, width - 14, 26, 12, "#8a6449");
  roundedRectangle(art, 13, 21, width - 26, 14, 7, "#a98a68");
  rectangle(art, 15, 42, 10, height - 46, "#493a33");
  rectangle(art, width - 25, 42, 10, height - 46, "#493a33");
  rectangle(art, 20, 52, width - 40, 4, "#d0b16e", 0.63);
  rectangle(art, width - 22, 44, 4, 18, "#b96f5f", 0.7);
}

function drawFloorBooks(art: Container, width: number): void {
  const map = new Graphics()
    .poly([2, 14, 34, 7, 69, 18, 60, 45, 24, 39])
    .fill({ color: "#d1c19a" });
  art.addChild(map);
  rectangle(art, 11, 21, 47, 2, "#8f7557", 0.52);
  rectangle(art, 25, 13, 2, 27, "#8f7557", 0.4);
  roundedRectangle(art, 27, 18, width - 31, 23, 3, "#6d667f");
  rectangle(art, 32, 22, width - 41, 3, "#d3b46d", 0.68);
  roundedRectangle(art, 8, 30, 42, 15, 3, "#657e78");
}

function drawBoots(art: Container): void {
  for (const [x, tilt] of [
    [11, -0.09],
    [40, 0.12],
  ] as const) {
    const boot = new Container();
    roundedRectangle(boot, 0, 2, 24, 31, 6, "#5c685b");
    roundedRectangle(boot, 2, 27, 32, 15, 6, "#465046");
    rectangle(boot, 4, 4, 16, 4, "#9b8c62", 0.42);
    circle(boot, 19, 37, 3, "#795f43", 0.7);
    boot.position.set(x, 3);
    boot.rotation = tilt;
    art.addChild(boot);
  }
}

function drawTeaSet(art: Container, width: number, height: number): void {
  roundedRectangle(art, 3, height - 11, width - 6, 8, 4, "#7d5b43", 0.68);
  circle(art, 46, 25, 15, "#88a19a");
  rectangle(art, 35, 15, 23, 18, "#88a19a");
  circle(art, 47, 12, 7, "#d3c6a1");
  circle(art, 67, 24, 8, "#88a19a", 0.92);
  for (const [x, color] of [
    [15, "#d0ba8e"],
    [79, "#a56b62"],
  ] as const) {
    roundedRectangle(art, x, 21, 13, 14, 5, color);
    circle(art, x + 14, 27, 5, color, 0.9);
  }
  roundedRectangle(art, 22, 33, 19, 8, 4, "#c99a63");
}

function drawBookStack(art: Container, width: number): void {
  const books = [
    { color: "#6c7f79", inset: 2, y: 31 },
    { color: "#9b665c", inset: 8, y: 20 },
    { color: "#786b8f", inset: 3, y: 9 },
  ];
  for (const book of books) {
    roundedRectangle(
      art,
      book.inset,
      book.y,
      width - book.inset * 2,
      12,
      3,
      book.color,
    );
    rectangle(art, book.inset + 6, book.y + 3, width - 24, 2, "#e0cfaa", 0.38);
  }
  rectangle(art, width - 20, 4, 5, 23, "#d8aa5e");
  rectangle(art, width - 12, 14, 4, 20, "#7fa4a0");
}

function drawPhotoFrame(art: Container, width: number, height: number): void {
  roundedRectangle(art, 3, 2, width - 6, height - 10, 4, "#8c6849");
  rectangle(art, 8, 8, width - 16, height - 23, "#cdbf9b");
  rectangle(art, 11, 11, width - 22, height - 29, "#6f8290");
  circle(art, width * 0.42, 24, 8, "#d5a377");
  circle(art, width * 0.64, 27, 7, "#88a17f");
  rectangle(art, 15, 36, width - 30, 11, "#40505a", 0.64);
  const stand = new Graphics()
    .poly([
      width * 0.46,
      height - 10,
      width * 0.74,
      height,
      width * 0.55,
      height - 24,
    ])
    .fill({ color: "#5d4838" });
  art.addChild(stand);
}

function drawPillow(art: Container, width: number, height: number): void {
  roundedRectangle(art, 3, 5, width - 6, height - 10, 15, "#bb806e");
  roundedRectangle(art, 9, 10, width - 18, height - 20, 11, "#c99a78", 0.72);
  rectangle(art, width / 2 - 2, 7, 4, height - 14, "#73988c", 0.82);
  rectangle(art, 7, height / 2 - 2, width - 14, 4, "#73988c", 0.58);
  for (let y = 10; y < height - 8; y += 9) {
    rectangle(art, width / 2 - 5, y, 10, 2, "#e4c98f", 0.72);
  }
}

function drawBlanket(art: Container, width: number, height: number): void {
  const colors = ["#67857d", "#a66e67", "#c29a63", "#7e7191"];
  roundedRectangle(art, 3, 3, width - 6, height - 11, 10, "#d0b789");
  const patchWidth = (width - 16) / 4;
  const patchHeight = (height - 21) / 3;
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      rectangle(
        art,
        8 + column * patchWidth,
        8 + row * patchHeight,
        patchWidth - 2,
        patchHeight - 2,
        colors[(row * 3 + column) % colors.length]!,
        row === 1 && column === 2 ? 0.56 : 0.84,
      );
    }
  }
  for (let x = 8; x < width - 7; x += 12) {
    rectangle(art, x, height - 10, 5, 8, "#d8c399", 0.72);
  }
}

function drawIvy(art: Container, width: number, height: number): void {
  const stem = new Graphics()
    .moveTo(width / 2, 0)
    .bezierCurveTo(9, 35, width - 14, 72, width / 2 - 8, height)
    .stroke({ color: "#395b48", width: 4 });
  art.addChild(stem);
  for (let y = 13; y < height - 5; y += 17) {
    const x = width / 2 + Math.sin(y / 17) * 18;
    circle(art, x - 9, y, 9, "#5c8663", 0.94);
    circle(art, x + 8, y + 5, 8, "#71966b", 0.86);
    circle(art, x - 8, y - 2, 3, "#9eb181", 0.38);
  }
  rectangle(art, width / 2 - 12, height * 0.55, 22, 5, "#d3ad60", 0.7);
}

function drawWallMap(art: Container, width: number, height: number): void {
  roundedRectangle(art, 5, 6, width - 10, height - 12, 5, "#d0bf95");
  rectangle(art, 10, 11, width - 20, height - 22, "#b6a87f");
  const path = new Graphics()
    .moveTo(23, height - 25)
    .bezierCurveTo(51, 54, 79, 82, 104, 39)
    .bezierCurveTo(123, 9, 142, 63, width - 20, 21)
    .stroke({ color: "#805d4d", width: 3 });
  art.addChild(path);
  for (const [x, y, color] of [
    [31, 31, "#6f8d72"],
    [68, 72, "#7a879c"],
    [119, 47, "#b26b58"],
    [144, 83, "#d0a55d"],
  ] as const) {
    circle(art, x, y, 7, color, 0.85);
    circle(art, x, y, 2, "#efe3be");
  }
  for (const x of [18, width - 18]) {
    circle(art, x, 14, 3, "#8d6c4a");
  }
}

function drawClock(art: Container, width: number, height: number): void {
  circle(art, width / 2, height / 2, width / 2 - 3, "#8c704e");
  circle(art, width / 2, height / 2, width / 2 - 9, "#d5c7a0");
  for (let index = 0; index < 12; index += 1) {
    const angle = (index / 12) * Math.PI * 2;
    circle(
      art,
      width / 2 + Math.sin(angle) * 23,
      height / 2 - Math.cos(angle) * 23,
      index % 3 === 0 ? 2.5 : 1.5,
      "#5b4b43",
    );
  }
  rectangle(art, width / 2 - 1, 18, 2, 20, "#4a4240");
  const hand = new Graphics()
    .moveTo(width / 2, height / 2)
    .lineTo(width / 2 + 17, height / 2 + 8)
    .stroke({ color: "#9c5f55", width: 3 });
  art.addChild(hand);
  circle(art, width / 2, height / 2, 4, "#b77c59");
}

function drawMemoBoard(art: Container, width: number, height: number): void {
  roundedRectangle(art, 3, 4, width - 6, height - 8, 6, "#755442");
  rectangle(art, 10, 11, width - 20, height - 22, "#967458");
  const notes = [
    [15, 18, 33, 24, "#d8c77f"],
    [56, 13, 28, 35, "#8eaaa0"],
    [91, 21, 39, 22, "#c98272"],
    [28, 53, 46, 28, "#d8c49e"],
    [82, 52, 32, 31, "#7f8dac"],
  ] as const;
  for (const [x, y, noteWidth, noteHeight, color] of notes) {
    rectangle(art, x, y, noteWidth, noteHeight, color, 0.92);
    rectangle(art, x + 6, y + 8, noteWidth - 12, 2, "#4c4a49", 0.3);
    circle(art, x + noteWidth / 2, y + 3, 2, "#d7ad5e");
  }
  const flower = new Graphics()
    .moveTo(121, 72)
    .lineTo(127, 51)
    .stroke({ color: "#526e57", width: 2 });
  art.addChild(flower);
  circle(art, 129, 47, 6, "#bc766c", 0.8);
}

function drawMobile(art: Container, width: number): void {
  rectangle(art, 17, 7, width - 34, 5, "#796044");
  for (const [x, length, color, kind] of [
    [24, 61, "#7e9e9a", "shell"],
    [49, 94, "#d2ad62", "star"],
    [73, 69, "#b6756c", "glass"],
    [99, 111, "#8a80a0", "shell"],
  ] as const) {
    rectangle(art, x, 10, 1, length, "#c8b58e", 0.62);
    if (kind === "star") {
      const star = new Graphics()
        .star(x, length + 17, 5, 11, 5)
        .fill({ color });
      art.addChild(star);
    } else if (kind === "glass") {
      const glass = new Graphics()
        .poly([
          x,
          length + 7,
          x + 10,
          length + 17,
          x,
          length + 28,
          x - 10,
          length + 17,
        ])
        .fill({ alpha: 0.8, color });
      art.addChild(glass);
    } else {
      roundedRectangle(art, x - 9, length + 7, 18, 20, 9, color, 0.88);
    }
  }
}

function drawMug(art: Container, width: number, height: number): void {
  roundedRectangle(art, 3, 8, width - 12, height - 11, 7, "#8b9b83");
  circle(art, width - 8, 21, 9, "#8b9b83");
  circle(art, width - 8, 21, 5, "#28323a");
  rectangle(art, 8, 11, width - 22, 4, "#c4b98e", 0.68);
  const chip = new Graphics()
    .poly([7, 7, 14, 7, 10, 13])
    .fill({ color: "#28323a" });
  art.addChild(chip);
  for (const x of [12, 18]) {
    const steam = new Graphics()
      .moveTo(x, 7)
      .bezierCurveTo(x - 4, 1, x + 5, -3, x + 1, -9)
      .stroke({ alpha: 0.32, color: "#f2dfbd", width: 2 });
    art.addChild(steam);
  }
}

function drawSewingBasket(art: Container, width: number, height: number): void {
  roundedRectangle(art, 6, 17, width - 12, height - 20, 11, "#9a784f");
  for (let x = 12; x < width - 10; x += 11) {
    rectangle(art, x, 20, 4, height - 28, "#d0a66b", 0.6);
  }
  circle(art, 22, 18, 12, "#a46c75");
  circle(art, 39, 13, 11, "#708f86");
  circle(art, 55, 20, 10, "#c4985d");
  rectangle(art, 48, 2, 3, 23, "#cbd0c8");
  const scissors = new Graphics()
    .circle(58, 7, 4)
    .circle(64, 7, 4)
    .moveTo(61, 10)
    .lineTo(54, 28)
    .moveTo(61, 10)
    .lineTo(68, 28)
    .stroke({ color: "#666b70", width: 2 });
  art.addChild(scissors);
}

function drawCurtain(art: Container, width: number, height: number): void {
  const curtain = new Graphics()
    .moveTo(0, 0)
    .lineTo(width, 0)
    .bezierCurveTo(width - 20, 76, width - 78, 145, width - 24, height)
    .lineTo(0, height)
    .closePath()
    .fill({ color: "#3f405b" });
  art.addChild(curtain);
  for (let x = 16; x < width - 8; x += 29) {
    const fold = new Graphics()
      .moveTo(x, 0)
      .bezierCurveTo(x + 8, 82, x - 15, 168, x + 5, height)
      .stroke({ alpha: 0.34, color: "#8a7890", width: 7 });
    art.addChild(fold);
  }
  roundedRectangle(art, width - 63, height * 0.53, 55, 13, 6, "#c09a59");
  circle(art, width - 8, height * 0.53 + 7, 8, "#d1b56c");
}

function drawCeilingVines(art: Container, width: number): void {
  const vine = new Graphics()
    .moveTo(0, 20)
    .bezierCurveTo(width * 0.25, 77, width * 0.72, 14, width, 54)
    .stroke({ color: "#345043", width: 6 });
  art.addChild(vine);
  for (let x = 20; x < width; x += 43) {
    const y = 34 + Math.sin(x / 88) * 20;
    circle(art, x, y, 10, x % 86 === 20 ? "#55765c" : "#6b8d67", 0.9);
    circle(art, x + 12, y + 8, 8, "#789c70", 0.76);
    rectangle(art, x + 2, y + 4, 1, 31, "#526b54", 0.62);
    circle(art, x + 2, y + 38, 3, "#f0c66d", 0.97);
    circle(art, x + 2, y + 38, 10, "#f0c66d", 0.1);
  }
}

function drawFern(art: Container, width: number, height: number): void {
  roundedRectangle(art, 10, height - 38, width - 20, 33, 7, "#a8614d");
  rectangle(art, 14, height - 34, width - 28, 5, "#d18969", 0.55);
  rectangle(art, width / 2 - 2, 27, 4, height - 57, "#436d52");
  const leaf = "#5e8f68";
  for (const [x, y, radius] of [
    [24, 38, 13],
    [12, 49, 11],
    [35, 52, 12],
    [20, 25, 12],
    [34, 18, 10],
    [13, 14, 9],
  ] as const) {
    circle(art, x, y, radius, leaf, 0.96);
    circle(art, x + 2, y - 2, Math.max(2, radius - 5), "#82aa76", 0.48);
  }
}

function drawLamp(art: Container, width: number, height: number): void {
  circle(art, width / 2, 14, 15, "#e6a75d", 0.17);
  const shade = new Graphics()
    .poly([4, 19, width / 2, 3, width - 4, 19])
    .fill({ color: "#e8ae62" });
  art.addChild(shade);
  rectangle(art, width / 2 - 2, 18, 4, height - 25, "#6c5749");
  roundedRectangle(art, 5, height - 8, width - 10, 6, 3, "#70594a");
  circle(art, width / 2, 14, 4, "#fff1ac", 0.95);
}

function drawWindowGlow(art: Container, width: number, height: number): void {
  const glow = new Graphics()
    .poly([
      width * 0.36,
      55,
      width * 0.64,
      55,
      width * 0.8,
      height,
      width * 0.2,
      height,
    ])
    .fill({ alpha: 0.055, color: "#b8d9e8" });
  art.addChild(glow);
  for (const [x, y, radius, alpha] of [
    [width * 0.42, 105, 3, 0.36],
    [width * 0.56, 151, 2, 0.3],
    [width * 0.49, 228, 3, 0.22],
    [width * 0.67, 314, 2, 0.2],
    [width * 0.32, 349, 2, 0.18],
  ] as const) {
    circle(art, x, y, radius, "#fff4c3", alpha);
  }
}

function drawFallback(
  art: Container,
  definition: TerritoryDefinition,
  style: TerritoryStyleProfile,
  width: number,
  height: number,
): void {
  roundedRectangle(
    art,
    2,
    2,
    width - 4,
    height - 4,
    8,
    style.palette.mid,
    0.92,
  );
  roundedRectangle(
    art,
    7,
    7,
    width - 14,
    height - 14,
    6,
    style.palette.dark,
    0.36,
  );
  circle(
    art,
    width / 2,
    height / 2,
    Math.max(5, Math.min(width, height) / 5),
    style.palette.accent,
    0.82,
  );
  if (definition.capabilities.includes("light")) {
    circle(
      art,
      width / 2,
      height / 2,
      Math.min(width, height) / 2.2,
      style.palette.light,
      0.14,
    );
  }
}

export function createTerritoryWorldDefinitionGraphic(
  definition: TerritoryDefinition,
  style: TerritoryStyleProfile,
  options: {
    readonly texture?: Texture;
    readonly variant?: number;
  } = {},
): Container {
  const art = new Container();
  const { height, width } = definition.visual.sizePx;
  if (options.texture) {
    const sprite = new Sprite(options.texture);
    sprite.width = width;
    sprite.height = height;
    art.addChild(sprite);
    return art;
  }

  const key = canonicalVisualKey(definition);
  switch (key) {
    case "cabin-floor":
      drawFloorTile(art, style, options.variant ?? 0);
      break;
    case "cabin-wall":
      drawCabinWall(art, style, width, height);
      break;
    case "great-moss-rug":
      drawRug(art, width, height);
      break;
    case "worn-runner":
      drawRunner(art, width, height);
      break;
    case "canopy-bed":
      drawCanopyBed(art, width, height);
      break;
    case "bedside-table":
      drawSmallTable(art, width, height, "bedside");
      break;
    case "cabin-desk":
    case "writing-desk":
      drawDesk(art, width, height);
      break;
    case "cabin-hearth":
      drawHearth(art, width, height);
      break;
    case "astral-bookshelf":
      drawBookshelf(art, width, height);
      break;
    case "log-basket":
      drawLogBasket(art, width, height);
      break;
    case "memory-divider":
      drawDivider(art, width, height);
      break;
    case "lived-sofa":
      drawSofa(art, width, height);
      break;
    case "coffee-table":
      drawCoffeeTable(art, width, height);
      break;
    case "reading-chair":
      drawReadingChair(art, width, height);
      break;
    case "floor-lamp":
      drawFloorLamp(art, width, height);
      break;
    case "side-table":
      drawSmallTable(art, width, height, "side");
      break;
    case "tea-cart":
      drawTeaCart(art, width);
      break;
    case "tall-fern":
      drawTallFern(art, width, height);
      break;
    case "travel-chest":
      drawChest(art, width, height);
      break;
    case "pet-bed":
      drawPetBed(art, width, height);
      break;
    case "sewing-table":
      drawSewingTable(art, width, height);
      break;
    case "work-stool":
      drawStool(art, width, height);
      break;
    case "floor-books":
      drawFloorBooks(art, width);
      break;
    case "muddy-boots":
      drawBoots(art);
      break;
    case "moss-rug":
      drawRug(art, width, height);
      break;
    case "fern-pot":
      drawFern(art, width, height);
      break;
    case "amber-lamp":
      drawLamp(art, width, height);
      break;
    case "tea-set":
      drawTeaSet(art, width, height);
      break;
    case "book-stack":
      drawBookStack(art, width);
      break;
    case "photo-frame":
      drawPhotoFrame(art, width, height);
      break;
    case "patch-pillow":
      drawPillow(art, width, height);
      break;
    case "patchwork-blanket":
      drawBlanket(art, width, height);
      break;
    case "hanging-ivy":
      drawIvy(art, width, height);
      break;
    case "wall-map":
      drawWallMap(art, width, height);
      break;
    case "slow-clock":
      drawClock(art, width, height);
      break;
    case "memo-board":
      drawMemoBoard(art, width, height);
      break;
    case "memory-mobile":
      drawMobile(art, width);
      break;
    case "chipped-mug":
      drawMug(art, width, height);
      break;
    case "sewing-basket":
      drawSewingBasket(art, width, height);
      break;
    case "window-curtain":
      drawCurtain(art, width, height);
      break;
    case "ceiling-vines":
      drawCeilingVines(art, width);
      break;
    case "window-glow":
      drawWindowGlow(art, width, height);
      break;
    default:
      drawFallback(art, definition, style, width, height);
      break;
  }
  return art;
}
