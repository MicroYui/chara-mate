import { describe, expect, it } from "vitest";

import type { TerritoryDefinition } from "../../shared/contracts/territoryWorld";
import { createStarterTerritoryWorldSeed } from "./territoryStarterWorld";
import {
  legacyTerritoryNarrativeUpgrade,
  territoryGeneratedItemContent,
  territorySourceItemContent,
  territoryZonePieceDescription,
} from "./territoryWorldNarrative";

describe("Territory World narrative", () => {
  it("ships every starter definition with display-ready prose", () => {
    const seed = createStarterTerritoryWorldSeed("2026-08-28T08:00:00.000Z");
    const descriptions = seed.definitions.map(({ description }) => description);

    expect(
      descriptions.every((description) => description.trim().length > 0),
    ).toBe(true);
    expect(descriptions.join("\n")).not.toMatch(
      /48px|24px|锚点|AI 生成|生成主题|外观修改/u,
    );
  });

  it("keeps provided story content separate and bounded to two sentences", () => {
    const content = territoryGeneratedItemContent({
      prompt: "opaque pixel art lamp on magenta background",
      provided: {
        description:
          "黄铜灯罩收住雨夜的微光。桌面因它多了一处温暖停靠。第三句不应进入展示。",
        name: "长夜台灯",
      },
      sources: [],
    });

    expect(content).toEqual({
      description: "黄铜灯罩收住雨夜的微光。桌面因它多了一处温暖停靠。",
      name: "长夜台灯",
    });
    expect(content.description).not.toContain("magenta");

    const guarded = territoryGeneratedItemContent({
      prompt: "lamp",
      provided: {
        description:
          "Azure GPT-Image 生成的 48px transparent background asset。",
        name: "opaque pixel art lamp",
      },
      sources: [],
    });
    expect(guarded).toMatchObject({ name: "新生小物" });
    expect(guarded.description).toContain("日常");
    expect(guarded.description).not.toMatch(/Azure|GPT|48px|background/u);
  });

  it("turns Activity evidence into poetry without inventing a preference", () => {
    const content = territorySourceItemContent({
      kind: "activity_digest",
      name: "2026-08-24 起一周趋势",
      sourceText: "iTerm2 160 分钟；Visual Studio Code 90 分钟",
    });

    expect(content.name).toContain("iTerm2");
    expect(content.description).toContain("日常");
    expect(content.description).toContain("不替你把习惯说成偏爱");
    expect(content.description).not.toContain("160");
  });

  it("upgrades only legacy system prose and preserves later user revisions", () => {
    const seed = createStarterTerritoryWorldSeed("2026-08-28T08:00:00.000Z");
    const legacy = {
      ...seed.definitions.find(({ id }) => id === "starter.cabin-wall")!,
      description: "包含窗台锚点的可替换墙体。",
    } satisfies TerritoryDefinition;

    expect(
      legacyTerritoryNarrativeUpgrade(legacy, [])?.description,
    ).not.toContain("锚点");
    expect(
      legacyTerritoryNarrativeUpgrade({ ...legacy, revision: 2 }, []),
    ).toBeUndefined();
    expect(territoryZonePieceDescription("studio-desk")).toContain("认真");

    const generatedBase = seed.definitions[0]!;
    expect(
      legacyTerritoryNarrativeUpgrade(
        {
          ...generatedBase,
          description: "opaque pixel art lamp on magenta background",
          id: "generated.item.legacy",
          tags: ["generated"],
        },
        [],
      )?.description,
    ).not.toContain("magenta");
    expect(
      legacyTerritoryNarrativeUpgrade(
        {
          ...generatedBase,
          description: "黄铜灯罩收住雨夜微光，也给归来的人留下一角温暖。",
          id: "generated.item.current",
          tags: ["generated", "narrative-v1"],
        },
        [],
      ),
    ).toBeUndefined();
  });
});
