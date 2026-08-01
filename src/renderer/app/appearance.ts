export const backgroundSchemes = [
  {
    description: "低饱和蓝灰侧栏与安静的浅色内容面",
    id: "mist",
    label: "雾蓝",
  },
  {
    description: "接近纸张的中性白与浅灰层级",
    id: "paper",
    label: "中性白",
  },
  {
    description: "偏暖的米灰背景，适合长时间阅读",
    id: "warm",
    label: "暖灰",
  },
] as const;

export type BackgroundScheme = (typeof backgroundSchemes)[number]["id"];

const storageKey = "chara-mate.background-scheme";

function isBackgroundScheme(value: string | null): value is BackgroundScheme {
  return backgroundSchemes.some(({ id }) => id === value);
}

export function readBackgroundScheme(
  storage: Pick<Storage, "getItem">,
): BackgroundScheme {
  try {
    const stored = storage.getItem(storageKey);
    return isBackgroundScheme(stored) ? stored : "mist";
  } catch {
    return "mist";
  }
}

export function writeBackgroundScheme(
  storage: Pick<Storage, "setItem">,
  scheme: BackgroundScheme,
): void {
  try {
    storage.setItem(storageKey, scheme);
  } catch {
    // The visual choice still applies for this session when storage is blocked.
  }
}
