import type { JsonValue, Timestamp } from "../../shared/contracts/primitives";
import type { Approval, Run, RunItem } from "../../shared/contracts/run";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import type { RunEvent } from "../../shared/contracts/ipc";
import type { RunEventService } from "./runEventService";
import type { RunRepository } from "./runRepository";

export interface CompleteItemPatch {
  readonly artifacts?: RunItem["artifacts"];
  readonly displayOutput?: string;
  readonly error?: RunItem["error"];
  readonly output?: JsonValue;
  readonly status: Extract<
    RunItem["status"],
    "completed" | "failed" | "cancelled" | "interrupted"
  >;
}

export class RunEventWriter {
  constructor(
    private readonly runs: RunRepository,
    private readonly events: RunEventService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  appendDelta(runId: string, itemId: string, delta: JsonValue): void {
    this.#append(runId, { delta, itemId, type: "item.delta" });
  }

  completeItem(itemId: string, patch: CompleteItemPatch): RunItem {
    const current = this.runs.getRunItem(itemId);
    if (!current) throw new Error(`Run item ${itemId} does not exist`);
    const endedAt = this.clock.now();
    const started = current.startedAt
      ? Date.parse(current.startedAt)
      : Date.parse(endedAt);
    const ended = Date.parse(endedAt);
    const item: RunItem = {
      ...current,
      artifacts: patch.artifacts ?? current.artifacts,
      ...(patch.displayOutput === undefined
        ? {}
        : { displayOutput: patch.displayOutput }),
      durationMs: Math.max(0, ended - started),
      endedAt,
      ...(patch.error === undefined ? {} : { error: patch.error }),
      ...(patch.output === undefined ? {} : { output: patch.output }),
      status: patch.status,
    };
    this.#append(current.runId, { item, type: "item.completed" }, endedAt);
    return item;
  }

  requestApproval(approval: Approval): Approval {
    this.#append(approval.runId, {
      approval,
      type: "approval.requested",
    });
    return approval;
  }

  resolveApproval(approval: Approval): Approval {
    this.#append(approval.runId, {
      approval,
      type: "approval.resolved",
    });
    return approval;
  }

  resume(runId: string): Run {
    const current = this.#requireRun(runId);
    const nextSequence = current.latestSequence + 1;
    const identity = { ...current };
    delete identity.endedAt;
    delete identity.error;
    const run: Run = {
      ...identity,
      latestSequence: nextSequence,
      status: "running",
    };
    this.events.append({
      event: { run, type: "run.resumed" },
      occurredAt: this.clock.now(),
      sequence: nextSequence,
      streamId: runId,
    });
    return run;
  }

  startItem(runId: string, kind: RunItem["kind"], input?: JsonValue): RunItem {
    const run = this.#requireRun(runId);
    const now = this.clock.now();
    const item: RunItem = {
      artifacts: [],
      id: this.ids.generate(),
      ...(input === undefined ? {} : { input }),
      kind,
      runId,
      sequence: run.latestSequence + 1,
      startedAt: now,
      status: "running",
    };
    this.events.append({
      event: { item, type: "item.started" },
      occurredAt: now,
      sequence: item.sequence,
      streamId: runId,
    });
    return item;
  }

  startRun(run: Run): Run {
    this.events.append({
      event: { run, type: "run.started" },
      occurredAt: run.startedAt ?? run.createdAt,
      sequence: 1,
      streamId: run.id,
    });
    return run;
  }

  transition(
    runId: string,
    status: Extract<
      Run["status"],
      "needs_input" | "interrupted" | "completed" | "failed" | "cancelled"
    >,
    error?: Run["error"],
  ): Run {
    const current = this.#requireRun(runId);
    const now = this.clock.now();
    const run: Run = {
      ...current,
      endedAt: now,
      ...(error === undefined ? {} : { error }),
      latestSequence: current.latestSequence + 1,
      status,
    };
    const event = { run, type: `run.${status}` } as RunEvent;
    this.events.append({
      event,
      occurredAt: now,
      sequence: run.latestSequence,
      streamId: runId,
    });
    return run;
  }

  #append(runId: string, event: RunEvent, occurredAt?: Timestamp): void {
    const run = this.#requireRun(runId);
    this.events.append({
      event,
      occurredAt: occurredAt ?? this.clock.now(),
      sequence: run.latestSequence + 1,
      streamId: runId,
    });
  }

  #requireRun(runId: string): Run {
    const run = this.runs.getRun(runId);
    if (!run) throw new Error(`Run ${runId} does not exist`);
    return run;
  }
}
