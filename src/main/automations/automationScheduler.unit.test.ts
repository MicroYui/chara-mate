import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Clock } from "../../shared/pure/clock";
import { AutomationScheduler } from "./automationScheduler";

class MutableClock implements Clock {
  constructor(public value: string) {}

  now(): string {
    return this.value;
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AutomationScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats the timer as a wake-up signal and checks persisted due work", async () => {
    vi.useFakeTimers();
    const clock = new MutableClock("2026-08-11T00:00:00.000Z");
    let next = "2026-08-11T00:01:00.000Z";
    const runDue = vi.fn(() => {
      if (clock.value >= next) next = "2026-08-12T00:01:00.000Z";
      return Promise.resolve();
    });
    const scheduler = new AutomationScheduler(
      { earliestNextRunAt: () => next, runDue },
      clock,
    );

    scheduler.start();
    await settle();
    expect(runDue).toHaveBeenCalledWith("2026-08-11T00:00:00.000Z");

    clock.value = "2026-08-11T00:01:00.000Z";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDue).toHaveBeenLastCalledWith("2026-08-11T00:01:00.000Z");
    await scheduler.stop();
  });

  it("rechecks immediately after system resume", async () => {
    vi.useFakeTimers();
    const resume = new EventEmitter();
    const clock = new MutableClock("2026-08-11T00:00:00.000Z");
    const runDue = vi.fn(() => Promise.resolve());
    const scheduler = new AutomationScheduler(
      {
        earliestNextRunAt: () => "2026-08-20T00:00:00.000Z",
        runDue,
      },
      clock,
      resume,
    );

    scheduler.start();
    await settle();
    clock.value = "2026-08-15T00:00:00.000Z";
    resume.emit("resume");
    await settle();
    expect(runDue).toHaveBeenLastCalledWith("2026-08-15T00:00:00.000Z");
    await scheduler.stop();
  });

  it("caps far-future wakeups at Node's documented timer limit", async () => {
    vi.useFakeTimers();
    const clock = new MutableClock("2026-08-11T00:00:00.000Z");
    const runDue = vi.fn(() => Promise.resolve());
    const scheduler = new AutomationScheduler(
      {
        earliestNextRunAt: () => "2027-08-11T00:00:00.000Z",
        runDue,
      },
      clock,
    );

    scheduler.start();
    await settle();
    clock.value = new Date(
      Date.parse(clock.value) + 2_147_483_647,
    ).toISOString();
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(runDue).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});
