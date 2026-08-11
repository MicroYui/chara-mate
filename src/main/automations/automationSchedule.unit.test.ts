import { describe, expect, it } from "vitest";

import type { AutomationSchedule } from "../../shared/contracts/automation";
import { AutomationError } from "./automationError";
import {
  nextAutomationOccurrence,
  validatePosixCronExpression,
} from "./automationSchedule";

function daily(localTime: string, timeZone: string): AutomationSchedule {
  return { kind: "daily", localTime, timeZone };
}

describe("automation schedule", () => {
  it("calculates one-time, daily and weekly occurrences as UTC projections", () => {
    expect(
      nextAutomationOccurrence(
        { kind: "once", runAt: "2026-08-12T02:00:00.000Z" },
        "2026-08-11T02:00:00.000Z",
      ),
    ).toBe("2026-08-12T02:00:00.000Z");
    expect(
      nextAutomationOccurrence(
        daily("18:30", "Asia/Shanghai"),
        "2026-08-11T11:00:00.000Z",
      ),
    ).toBe("2026-08-12T10:30:00.000Z");
    expect(
      nextAutomationOccurrence(
        {
          kind: "weekly",
          localTime: "18:30",
          timeZone: "Asia/Shanghai",
          weekdays: [5],
        },
        "2026-08-11T11:00:00.000Z",
      ),
    ).toBe("2026-08-14T10:30:00.000Z");
  });

  it("shifts a DST gap to the next existing wall time", () => {
    expect(
      nextAutomationOccurrence(
        daily("02:30", "America/New_York"),
        "2026-03-08T05:00:00.000Z",
      ),
    ).toBe("2026-03-08T07:30:00.000Z");
  });

  it("runs a DST fold occurrence once, using the first instant", () => {
    const schedule = daily("01:30", "America/New_York");
    const first = nextAutomationOccurrence(
      schedule,
      "2026-11-01T04:00:00.000Z",
    );
    expect(first).toBe("2026-11-01T05:30:00.000Z");
    expect(nextAutomationOccurrence(schedule, first!)).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });

  it("implements POSIX day-of-month/day-of-week OR matching", () => {
    expect(
      nextAutomationOccurrence(
        {
          dialect: "posix-5-field",
          expression: "0 9 15 * 1",
          kind: "cron",
          timeZone: "UTC",
        },
        "2026-06-14T10:00:00.000Z",
      ),
    ).toBe("2026-06-15T09:00:00.000Z");
  });

  it.each([
    "*/5 * * * *",
    "0 0 * JAN *",
    "0 0 * * 7",
    "0 24 * * *",
    "0 0 10-2 * *",
    "0 0 * * * command",
  ])("rejects non-POSIX or out-of-range expression %s", (expression) => {
    expect(() => validatePosixCronExpression(expression)).toThrow(
      AutomationError,
    );
  });
});
