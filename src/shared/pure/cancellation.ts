import type {
  RunCancelResult,
  RunStatus,
  TerminalRunStatus,
} from "../contracts/run";
import type { EntityId } from "../contracts/primitives";

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "needs_input",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalRunStatus(
  status: RunStatus,
): status is TerminalRunStatus {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function decideRunCancellation(
  runId: EntityId,
  status: RunStatus,
): RunCancelResult {
  if (isTerminalRunStatus(status)) {
    return {
      outcome: "already_terminal",
      runId,
      status,
    };
  }

  return {
    outcome: "accepted",
    runId,
  };
}

export class RunCancelledError extends Error {
  constructor(readonly runId: EntityId) {
    super(`Run ${runId} was cancelled by the user`);
    this.name = "RunCancelledError";
  }
}

export class RunCancellationController {
  readonly #controller = new AbortController();

  constructor(readonly runId: EntityId) {}

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  request(status: RunStatus): RunCancelResult {
    const result = decideRunCancellation(this.runId, status);
    if (result.outcome === "accepted" && !this.signal.aborted) {
      this.#controller.abort(new RunCancelledError(this.runId));
    }
    return result;
  }
}
