import { describe, expect, it, vi } from "vitest";

import { readBackgroundScheme, writeBackgroundScheme } from "./appearance";

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
