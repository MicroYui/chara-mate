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

  it("uses one timer for the earliest of multiple persistent sources", async () => {
    vi.useFakeTimers();
    let now = "2026-08-13T09:00:00.000Z";
    const first = {
      earliestNextRunAt: () => "2026-08-13T09:30:00.000Z",
      runDue: vi.fn(() => Promise.resolve()),
    };
    let secondNext: string | undefined = "2026-08-13T09:10:00.000Z";
    const second = {
      earliestNextRunAt: () => secondNext,
      runDue: vi.fn(() => {
        if (now >= "2026-08-13T09:10:00.000Z") secondNext = undefined;
        return Promise.resolve();
      }),
    };
    const scheduler = new AutomationScheduler([first, second], {
      now: () => now,
    });

    scheduler.start();
    vi.runAllTicks();
    await settle();
    expect(first.runDue).toHaveBeenCalledTimes(1);
    expect(second.runDue).toHaveBeenCalledTimes(1);

    now = "2026-08-13T09:10:00.000Z";
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(first.runDue).toHaveBeenCalledTimes(2);
    expect(second.runDue).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("isolates one runner failure and still schedules healthy persisted work", async () => {
    vi.useFakeTimers();
    let now = "2026-08-13T09:00:00.000Z";
    const error = new Error("runner unavailable");
    const failing = {
      earliestNextRunAt: () => "2026-08-13T08:59:00.000Z",
      runDue: vi.fn<() => Promise<void>>().mockRejectedValue(error),
    };
    let healthyNext: string | undefined = "2026-08-13T09:01:00.000Z";
    const healthy = {
      earliestNextRunAt: () => healthyNext,
      runDue: vi.fn(() => {
        if (now >= "2026-08-13T09:01:00.000Z") healthyNext = undefined;
        return Promise.resolve();
      }),
    };
    const onError = vi.fn();
    const scheduler = new AutomationScheduler(
      [failing, healthy],
      { now: () => now },
      undefined,
      onError,
    );

    scheduler.start();
    await settle();

    expect(onError).toHaveBeenCalledWith(error);
    expect(failing.runDue).toHaveBeenCalledTimes(1);
    expect(healthy.runDue).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(failing.runDue).toHaveBeenCalledTimes(1);

    now = "2026-08-13T09:01:00.000Z";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing.runDue).toHaveBeenCalledTimes(2);
    expect(healthy.runDue).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.stop();
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
