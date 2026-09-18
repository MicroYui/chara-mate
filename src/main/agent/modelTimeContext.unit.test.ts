import { describe, expect, it, vi } from "vitest";
import { modelTimeContext, modelTimeInstructions } from "./modelTimeContext";

describe("current model calendar anchor", () => {
  it("does not confuse a UTC date change with a Shanghai date change", () => {
    const before = "2026-09-14T23:40:00.000Z";
    const after = "2026-09-15T00:00:00.000Z";
    expect(modelTimeContext(before, "Asia/Shanghai").localDateTime).toBe(
      "2026-09-15T07:40:00.000",
    );
    expect(modelTimeContext(after, "Asia/Shanghai").localDateTime).toBe(
      "2026-09-15T08:00:00.000",
    );
    expect(modelTimeContext(before, "UTC").localDateTime).toBe(
      "2026-09-14T23:40:00.000",
    );
    expect(modelTimeContext(after, "UTC").localDateTime).toBe(
      "2026-09-15T00:00:00.000",
    );
  });

  it("uses the time zone's daylight-saving rules at each instant", () => {
    expect(
      modelTimeContext("2026-03-08T06:59:59.000Z", "America/New_York")
        .localDateTime,
    ).toBe("2026-03-08T01:59:59.000");
    expect(
      modelTimeContext("2026-03-08T07:00:00.000Z", "America/New_York")
        .localDateTime,
    ).toBe("2026-03-08T03:00:00.000");
  });

  it.each([null, "Unknown/Place"])(
    "keeps an unavailable calendar unknown instead of claiming UTC: %s",
    (zone) => {
      const context = modelTimeContext("2026-09-15T00:00:00.000Z", zone);
      expect(context).toEqual({
        now: "2026-09-15T00:00:00.000Z",
        timeZone: null,
        localDateTime: null,
      });
      expect(modelTimeInstructions(context)).toContain(
        "User system time zone: unknown",
      );
    },
  );

  it("keeps the valid step clock when the platform time zone lookup fails", () => {
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("platform unavailable");
    });
    try {
      expect(modelTimeContext("2026-09-15T00:00:00.000Z")).toEqual({
        now: "2026-09-15T00:00:00.000Z",
        timeZone: null,
        localDateTime: null,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
