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
  {
    description: "自行配色；深色主题会自动保留色调并压低亮度",
    id: "custom",
    label: "自定义",
  },
] as const;

export type BackgroundScheme = (typeof backgroundSchemes)[number]["id"];

export const themePreferences = [
  {
    description: "随 macOS 外观自动切换",
    id: "system",
    label: "跟随系统",
  },
  {
    description: "始终使用明亮、清晰的内容面",
    id: "light",
    label: "浅色",
  },
  {
    description: "始终使用低亮度的深色内容面",
    id: "dark",
    label: "深色",
  },
] as const;

export type ThemePreference = (typeof themePreferences)[number]["id"];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export interface CustomBackgroundColors {
  readonly accent: string;
  readonly canvas: string;
  readonly sidebar: string;
  readonly surface: string;
}

export const defaultCustomBackgroundColors: CustomBackgroundColors = {
  accent: "#6959d9",
  canvas: "#f8fafb",
  sidebar: "#eaf3f7",
  surface: "#ffffff",
};

const storageKey = "chara-mate.background-scheme";
const sidebarStorageKey = "chara-mate.sidebar-collapsed";
const themeStorageKey = "chara-mate.theme";
const customBackgroundStorageKey = "chara-mate.custom-background";
const hexColorPattern = /^#[0-9a-f]{6}$/iu;

function isBackgroundScheme(value: string | null): value is BackgroundScheme {
  return backgroundSchemes.some(({ id }) => id === value);
}

function isThemePreference(value: string | null): value is ThemePreference {
  return themePreferences.some(({ id }) => id === value);
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

export function readThemePreference(
  storage: Pick<Storage, "getItem">,
): ThemePreference {
  try {
    const stored = storage.getItem(themeStorageKey);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  return preference === "system"
    ? systemPrefersDark
      ? "dark"
      : "light"
    : preference;
}

export function writeThemePreference(
  storage: Pick<Storage, "setItem">,
  preference: ThemePreference,
): void {
  try {
    storage.setItem(themeStorageKey, preference);
  } catch {
    // The visual choice still applies for this session when storage is blocked.
  }
}

export function readCustomBackgroundColors(
  storage: Pick<Storage, "getItem">,
): CustomBackgroundColors {
  try {
    const value = JSON.parse(
      storage.getItem(customBackgroundStorageKey) ?? "null",
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return defaultCustomBackgroundColors;
    }
    const record = value as Record<string, unknown>;
    const color = (key: keyof CustomBackgroundColors) => {
      const candidate = record[key];
      return typeof candidate === "string" && hexColorPattern.test(candidate)
        ? candidate.toLowerCase()
        : undefined;
    };
    const accent = color("accent");
    const canvas = color("canvas");
    const sidebar = color("sidebar");
    const surface = color("surface");
    if (!accent || !canvas || !sidebar || !surface) {
      return defaultCustomBackgroundColors;
    }
    return { accent, canvas, sidebar, surface };
  } catch {
    return defaultCustomBackgroundColors;
  }
}

export function writeCustomBackgroundColors(
  storage: Pick<Storage, "setItem">,
  colors: CustomBackgroundColors,
): void {
  try {
    storage.setItem(customBackgroundStorageKey, JSON.stringify(colors));
  } catch {
    // The visual choice still applies for this session when storage is blocked.
  }
}

export function readSidebarCollapsed(
  storage: Pick<Storage, "getItem">,
): boolean {
  try {
    return storage.getItem(sidebarStorageKey) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(
  storage: Pick<Storage, "setItem">,
  collapsed: boolean,
): void {
  try {
    storage.setItem(sidebarStorageKey, String(collapsed));
  } catch {
    // The layout choice still applies for this session when storage is blocked.
  }
}
