import { describe, expect, it, vi } from "vitest";

import {
  readBackgroundScheme,
  readCustomBackgroundColors,
  readThemePreference,
  resolveThemePreference,
  writeBackgroundScheme,
  writeCustomBackgroundColors,
  writeThemePreference,
} from "./appearance";

describe("background appearance preference", () => {
  it("uses mist as the deterministic default", () => {
    expect(readBackgroundScheme({ getItem: () => null })).toBe("mist");
    expect(readBackgroundScheme({ getItem: () => "unknown" })).toBe("mist");
  });

  it("round-trips a supported background scheme", () => {
    const setItem = vi.fn();
    writeBackgroundScheme({ setItem }, "warm");
    expect(setItem).toHaveBeenCalledWith(
      "chara-mate.background-scheme",
      "warm",
    );
    expect(readBackgroundScheme({ getItem: () => "warm" })).toBe("warm");
  });

  it("survives storage being unavailable", () => {
    expect(
      readBackgroundScheme({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("mist");
    expect(() =>
      writeBackgroundScheme(
        {
          setItem: () => {
            throw new Error("blocked");
          },
        },
        "paper",
      ),
    ).not.toThrow();
  });
});

describe("color theme preference", () => {
  it("follows the operating system by default", () => {
    expect(readThemePreference({ getItem: () => null })).toBe("system");
    expect(resolveThemePreference("system", false)).toBe("light");
    expect(resolveThemePreference("system", true)).toBe("dark");
  });

  it("keeps an explicit theme independent of the system", () => {
    expect(resolveThemePreference("light", true)).toBe("light");
    expect(resolveThemePreference("dark", false)).toBe("dark");
  });

  it("round-trips supported values and rejects stale values", () => {
    const setItem = vi.fn();
    writeThemePreference({ setItem }, "dark");
    expect(setItem).toHaveBeenCalledWith("chara-mate.theme", "dark");
    expect(readThemePreference({ getItem: () => "dark" })).toBe("dark");
    expect(readThemePreference({ getItem: () => "sepia" })).toBe("system");
  });
});

describe("custom background colors", () => {
  it("round-trips a complete custom palette", () => {
    const palette = {
      accent: "#123456",
      canvas: "#abcdef",
      sidebar: "#fedcba",
      surface: "#ffffff",
    };
    const setItem = vi.fn();
    writeCustomBackgroundColors({ setItem }, palette);
    expect(setItem).toHaveBeenCalledWith(
      "chara-mate.custom-background",
      JSON.stringify(palette),
    );
    expect(
      readCustomBackgroundColors({ getItem: () => JSON.stringify(palette) }),
    ).toEqual(palette);
  });

  it("falls back as a whole when a stored color is malformed", () => {
    expect(
      readCustomBackgroundColors({
        getItem: () =>
          JSON.stringify({
            accent: "red",
            canvas: "#abcdef",
            sidebar: "#fedcba",
            surface: "#ffffff",
          }),
      }),
    ).toEqual({
      accent: "#6959d9",
      canvas: "#f8fafb",
      sidebar: "#eaf3f7",
      surface: "#ffffff",
    });
  });
});
