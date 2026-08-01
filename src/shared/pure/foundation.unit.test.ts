import { describe, expect, it, vi } from "vitest";

import {
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
} from "../../../tests/fixtures/foundationContracts";
import { FakeClock } from "../../../tests/fixtures/fakeClock";
import { parseSchema } from "../schemas/validation";
import { EntityIdSchema, TimestampSchema } from "../schemas/primitives";
import { createLinkedAbortController } from "./abort";
import {
  decideRunCancellation,
  RunCancellationController,
  RunCancelledError,
} from "./cancellation";
import { SystemClock } from "./clock";
import { CryptoIdGenerator } from "./id";
import { replayInSequence, SequenceReplayError } from "./replay";

describe("Phase 0 correctness primitives", () => {
  it("uses one valid ID generator", () => {
    const generator = new CryptoIdGenerator();
    const first = generator.generate();
    const second = generator.generate();

    expect(parseSchema(EntityIdSchema, first)).toBe(first);
    expect(first).not.toBe(second);
  });

  it("uses injectable UTC clocks", () => {
    const fakeClock = new FakeClock(FIXTURE_TIMESTAMPS.created);
    fakeClock.advance(1_000);

    expect(fakeClock.now()).toBe("2026-08-01T08:00:01.000Z");
    expect(() =>
      parseSchema(TimestampSchema, new SystemClock().now()),
    ).not.toThrow();
  });

  it("propagates AbortSignal reasons and supports listener cleanup", () => {
    const parent = new AbortController();
    const linked = createLinkedAbortController(parent.signal);
    const reason = new Error("user stopped the Run");
    parent.abort(reason);

    expect(linked.controller.signal.aborted).toBe(true);
    expect(linked.controller.signal.reason).toBe(reason);

    const disposableParent = new AbortController();
    const disposableLinked = createLinkedAbortController(
      disposableParent.signal,
    );
    disposableLinked.dispose();
    disposableParent.abort();
    expect(disposableLinked.controller.signal.aborted).toBe(false);
  });

  it("makes cancellation accepted for active Runs and idempotent for terminal Runs", () => {
    expect(decideRunCancellation(FIXTURE_IDS.run, "running")).toEqual({
      outcome: "accepted",
      runId: FIXTURE_IDS.run,
    });
    expect(decideRunCancellation(FIXTURE_IDS.run, "completed")).toEqual({
      outcome: "already_terminal",
      runId: FIXTURE_IDS.run,
      status: "completed",
    });
    expect(decideRunCancellation(FIXTURE_IDS.run, "cancelled")).toEqual({
      outcome: "already_terminal",
      runId: FIXTURE_IDS.run,
      status: "cancelled",
    });
  });

  it("turns an accepted cancellation into the shared AbortSignal", () => {
    const cancellation = new RunCancellationController();
    const linked = createLinkedAbortController(cancellation.signal);

    expect(cancellation.request(FIXTURE_IDS.run, "waiting_approval")).toEqual({
      outcome: "accepted",
      runId: FIXTURE_IDS.run,
    });
    expect(cancellation.signal.aborted).toBe(true);
    expect(cancellation.signal.reason).toBeInstanceOf(RunCancelledError);
    expect(linked.controller.signal.reason).toBe(cancellation.signal.reason);

    linked.dispose();
  });

  it("applies only contiguous events from the requested sequence", () => {
    const apply = vi.fn();
    const latestSequence = replayInSequence(
      FIXTURE_IDS.run,
      0,
      [
        { sequence: 1, streamId: FIXTURE_IDS.run },
        { sequence: 2, streamId: FIXTURE_IDS.run },
      ],
      apply,
    );

    expect(latestSequence).toBe(2);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("rejects gaps, duplicates, stale events and cross-stream events atomically", () => {
    for (const events of [
      [{ sequence: 2, streamId: FIXTURE_IDS.run }],
      [
        { sequence: 1, streamId: FIXTURE_IDS.run },
        { sequence: 1, streamId: FIXTURE_IDS.run },
      ],
      [{ sequence: 0, streamId: FIXTURE_IDS.run }],
      [{ sequence: 1, streamId: FIXTURE_IDS.chat }],
    ]) {
      const apply = vi.fn();
      expect(() => replayInSequence(FIXTURE_IDS.run, 0, events, apply)).toThrow(
        SequenceReplayError,
      );
      expect(apply).not.toHaveBeenCalled();
    }
  });
});
