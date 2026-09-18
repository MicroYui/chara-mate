import type {
  TerritoryDefinition,
  TerritoryInstance,
  TerritorySourceSnapshot,
} from "../../shared/contracts/territoryWorld";

export interface TerritoryItemContent {
  readonly description: string;
  readonly name: string;
}

const STORY_MAX_CHARACTERS = 180;
const technicalNarrativePattern =
  /AI 生成|生成主题|外观修改|视觉：|Territory art direction|Use case:|pixel art|silhouette|transparent background|magenta background|\b(?:OpenAI|Azure|GPT-?\d*|prompt)\b/iu;
const internalIdPattern =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const pixelDimensionPattern = /\b\d+(?:\.\d+)?\s*(?:px|pixels?)\b/iu;

const starterDescriptions: Readonly<Record<string, string>> = {
  "starter.cabin-floor":
    "暖木纹里藏着细小划痕与被岁月磨亮的脚步，雨夜的灯光落下来时，整间小屋像仍有余温。",
  "starter.cabin-wall":
    "深色木梁托住一扇长长的雨夜窗，挂画与窗台之间留着许多可以慢慢添满的空白。",
  "starter.ceiling-vines":
    "藤叶从旧木梁间垂下，小灯一颗颗藏在叶影里，像把傍晚遗落的星光接回了屋内。",
  "starter.window-curtain":
    "厚重帘角垂进前景，带着雨后的微凉；有人从旁经过时，布面会像呼吸一样轻轻掠过。",
  "starter.window-glow":
    "窗外的蓝、壁炉的金与空气里的微尘慢慢叠在一起，让整间小屋停在雨后最柔软的暮色里。",
};

const zonePieceDescriptions: Readonly<Record<string, string>> = {
  "bar-cart":
    "旧黄铜车轮停在地毯边，杯盏与果香挤在两层小架上，像随时会有人推来一场迟到的夜茶。",
  "botanical-console":
    "藤叶、标本瓶与远行带回的小物在窄桌上层层生长，把一段漫长旅途安静地留在门边。",
  "central-table":
    "茶水、花与翻到一半的书围在矮桌中央，灯影落下时，这里便成了房间最愿意停留的地方。",
  "display-storage":
    "高柜像一只半开的珠宝匣，书脊、玻璃瓶与旧相框在暖灯里各自守着一点微光。",
  "focal-rest":
    "层层软毯与枕边的小茶盘把疲惫轻轻接住，帘穗垂下时，仿佛连夜色也愿意在这里歇一会儿。",
  "floor-cushions":
    "错落的坐垫与软毯围成低低的巢，靠近地面的暖意让闲谈和发呆都有了安放之处。",
  "foreground-botanical":
    "枝叶与织物从画面边缘探进来，把远处的灯火框成一幅会随风轻动的生活小景。",
  "garden-divider":
    "通透的枝架托着垂落花叶，让两个生活角落若即若离，也让经过的人总能闻到一点潮湿绿意。",
  "grand-rug":
    "繁复纹样在脚下铺开，边缘已有温柔磨损，像许多次相聚都悄悄留在了同一片织纹里。",
  landmark:
    "火光与收藏沿着建筑轮廓层层亮起，壁龛里的书与小物让这里成为整间屋子最醒目的心脏。",
  "lounge-seat":
    "不成套的靠枕、读到一半的书和随手搭下的毯子，把华丽座椅变成真正有人生活的角落。",
  "luggage-trunk":
    "旧箱上的铜角已经黯淡，贴纸与叠好的披肩却仍带着远方的颜色，像旅途刚刚在此落脚。",
  "overhead-light":
    "顶灯与细小垂饰在高处排出缓慢的光之节奏，抬头时，仿佛能看见一片室内的星空。",
  "reading-chair-nest":
    "雕花木椅被软毯与书页围成小小的巢，眼镜搁在一旁，像主人只是暂时离开了一会儿。",
  "sculptural-light":
    "玻璃与金属托住一团温暖微光，灯影在地面缓缓散开，像一朵只在夜里开放的花。",
  "side-table-vignette":
    "花、旧相框与一盏彩色小灯挤在边几上，把寻常的一角照得像一封没有寄出的短笺。",
  "standing-mirror":
    "藤蔓绕过旧黄铜镜框，镜中只收留窗光与灯火，让每次经过都像与另一个暮色擦肩。",
  "studio-desk":
    "纸张、墨水与未完成的手作在桌面保持着忙碌的秩序，烛光照见一件事正被认真做下去。",
  "wall-tapestry-gallery":
    "星图织毯与大小不一的旧框在墙上慢慢相遇，票根、干花和小饰物把空白变成可阅读的岁月。",
  "window-drapery":
    "丝绒、薄纱与珠链从拱窗两侧垂落，雨夜的微光穿过层层织物，像一场安静展开的帷幕。",
};

function compact(value: string): string {
  return value.normalize("NFC").replaceAll(/\s+/gu, " ").trim();
}

function finishSentence(value: string): string {
  return /[.!?。！？…]$/u.test(value) ? value : `${value}。`;
}

function firstTwoSentences(value: string): string {
  const normalized = compact(value);
  const sentences = normalized.match(/[^。！？.!?]+[。！？.!?]?/gu) ?? [];
  let result = compact(sentences.slice(0, 2).join("")) || normalized;
  const characters = [...result];
  if (characters.length > STORY_MAX_CHARACTERS) {
    result = `${characters.slice(0, STORY_MAX_CHARACTERS - 1).join("")}…`;
  }
  return finishSentence(result);
}

function shortTheme(value: string): string {
  const normalized = compact(value)
    .replace(/^把[“"]?/u, "")
    .replace(/^[请为我帮生成创建做]+/u, "")
    .replace(/[”"]$/u, "");
  const head =
    normalized.split(/[：:\n。！？!?，,；;]/u)[0]?.trim() || "新创作物件";
  const characters = [...head];
  return characters.length > 18 ? `${characters.slice(0, 18).join("")}…` : head;
}

function sourceExcerpt(value: string): string {
  const first = compact(value).split(/[；;\n]/u)[0] ?? "";
  const characters = [...first];
  return characters.length > 42
    ? `${characters.slice(0, 41).join("")}…`
    : first;
}

function containsTechnicalNarrative(value: string): boolean {
  return (
    technicalNarrativePattern.test(value) ||
    internalIdPattern.test(value) ||
    pixelDimensionPattern.test(value)
  );
}

function safeItemName(value: string): string {
  const name = shortTheme(value);
  return containsTechnicalNarrative(name) ? "新生小物" : name;
}

function poeticFallback(name: string): string {
  return `“${name}”在这里化作一件安静的小物，收住经过窗边的光，也给日常留下一处可以停靠的角落。`;
}

function activitySubject(value: string): string {
  return sourceExcerpt(value)
    .replace(/\s+\d+\s*分钟.*$/u, "")
    .replace(/^\d{4}-\d{2}-\d{2}\s*起一周趋势[：:]?/u, "")
    .trim();
}

export function territorySourceItemContent(input: {
  readonly kind: TerritorySourceSnapshot["kind"];
  readonly name: string;
  readonly sourceText: string;
}): TerritoryItemContent {
  if (input.kind === "character_creation") {
    return {
      name: shortTheme(input.name),
      description: poeticFallback(shortTheme(input.name)),
    };
  }
  if (input.kind === "activity_digest") {
    const subject = activitySubject(input.sourceText);
    return {
      description:
        "散落在不同窗口里的专注被收拢成一束安静的流光；它记得日常曾怎样经过，却不替你把习惯说成偏爱。",
      name: subject ? shortTheme(`${subject} 的流光`) : "一周流光",
    };
  }
  const excerpt = sourceExcerpt(input.sourceText);
  return {
    description: firstTwoSentences(
      excerpt
        ? `“${excerpt}”被折进一件温暖的小物里；靠近它时，那段值得记住的事会在灯影中轻轻亮起。`
        : "一段值得记住的事被折进温暖的小物里；靠近它时，旧日微光会重新亮起。",
    ),
    name: shortTheme(input.name),
  };
}

export function territoryGeneratedItemContent(input: {
  readonly nameHint?: string;
  readonly prompt: string;
  readonly provided?: TerritoryItemContent;
  readonly sources: readonly TerritorySourceSnapshot[];
}): TerritoryItemContent {
  if (input.provided) {
    const name = safeItemName(input.provided.name);
    const description = firstTwoSentences(input.provided.description);
    return {
      description: containsTechnicalNarrative(description)
        ? poeticFallback(name)
        : description,
      name,
    };
  }
  const source = input.sources[0];
  if (source) {
    return territorySourceItemContent({
      kind: source.kind,
      name: input.nameHint ?? "被记住的微光",
      sourceText: source.label,
    });
  }
  const name = safeItemName(input.nameHint ?? input.prompt);
  return {
    description: poeticFallback(name),
    name,
  };
}

export function territoryBackgroundDescription(name: string): string {
  const subject = shortTheme(name.replace(/\s*·\s*新环境$/u, ""));
  return `${subject}的光线、材质与远景在这里缓缓相接，像一段可以继续添写的天气与时光。`;
}

export function territoryZonePieceDescription(
  key: string,
  fallback = "它在光影与日常之间安静落脚，让这个角落多了一点可停留、也可慢慢讲述的温度。",
): string {
  return zonePieceDescriptions[key] ?? fallback;
}

export function applyStarterTerritoryNarratives(
  definitions: readonly TerritoryDefinition[],
): TerritoryDefinition[] {
  return definitions.map((definition) => {
    const description = starterDescriptions[definition.id];
    return description ? { ...definition, description } : definition;
  });
}

function hasNarrativeEnding(description: string): boolean {
  return /[。！？.!?…]$/u.test(description.trim());
}

function looksLikeLegacyPrompt(description: string): boolean {
  return (
    !hasNarrativeEnding(description) ||
    [...description].length > STORY_MAX_CHARACTERS ||
    containsTechnicalNarrative(description)
  );
}

export function legacyTerritoryNarrativeUpgrade(
  definition: TerritoryDefinition,
  instances: readonly TerritoryInstance[],
): TerritoryItemContent | undefined {
  const starter = starterDescriptions[definition.id];
  if (starter && definition.revision === 1) {
    return definition.description === starter
      ? undefined
      : { description: starter, name: definition.name };
  }

  if (definition.id.startsWith("generated.zone-piece.")) {
    const key = definition.id.split(".").at(-1) ?? "";
    const description = territoryZonePieceDescription(key);
    if (
      definition.description !== description &&
      (definition.revision === 1 ||
        looksLikeLegacyPrompt(definition.description))
    ) {
      return { description, name: definition.name };
    }
    return undefined;
  }

  if (definition.id.startsWith("generated.background.")) {
    const description = territoryBackgroundDescription(definition.name);
    if (
      definition.description !== description &&
      (definition.revision === 1 ||
        looksLikeLegacyPrompt(definition.description))
    ) {
      return { description, name: definition.name };
    }
    return undefined;
  }

  if (
    definition.id.startsWith("generated.item.") &&
    !definition.tags.includes("narrative-v1") &&
    (definition.revision === 1 || looksLikeLegacyPrompt(definition.description))
  ) {
    return territoryGeneratedItemContent({
      nameHint: definition.name,
      prompt: definition.description,
      sources: instances.flatMap(({ sources }) => sources),
    });
  }
  return undefined;
}
