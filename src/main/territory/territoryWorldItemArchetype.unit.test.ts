import { describe, expect, it } from "vitest";

import { classifyTerritoryWorldItem } from "./territoryWorldItemArchetype";

describe("Territory generated item archetypes", () => {
  it.each([
    ["一张磨旧的星图地毯", "floor-textile", "underlay", 192, 120],
    ["挂在墙上的旅行相框", "wall-decor", "attachment", 168, 112],
    ["一只缺口陶杯", "tabletop-decor", "attachment", 72, 72],
    ["能坐两个人的苔绿色沙发", "large-furniture", "object", 192, 144],
    ["塞满旧信件的书架", "storage", "object", 144, 168],
    ["长到窗边的巨大盆栽", "tall-decor", "object", 96, 168],
    ["会发光的月相徽章", "default-decor", "object", 72, 72],
  ] as const)("classifies %s", (prompt, id, layer, width, height) => {
    const archetype = classifyTerritoryWorldItem(prompt);
    expect(archetype).toMatchObject({
      id,
      layer,
      sizePx: { height, width },
    });
  });
});
