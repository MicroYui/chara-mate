import type { MemoryFormationIntake } from "../../shared/contracts/memoryRecall";
import type { MemoryProviderRecovery, MemoryService } from "./memoryService";

export interface MemoryMaintenanceOptions {
  readonly onError: (
    error: unknown,
    operation: "formation" | "index" | "source_release" | "consolidation",
  ) => void;
  readonly reclaimSources?: (signal: AbortSignal) => Promise<void>;
}

/** One event-driven owner. Episodes are durable before scheduling. A changed
 * processor can resume its predecessor's failures on startup; a failure on the
 * same processor awaits an explicit retry event, never a paid timer loop. */
export class MemoryMaintenance {
  readonly #abort = new AbortController();
  #started = false;
  #closed = false;
  #formationRequested = false;
  #formationRetryRequested = false;
  #indexRequested = false;
  #sourceReleaseRequested = false;
  #forming: Promise<void> | undefined;
  #indexing: Promise<void> | undefined;
  #releasingSources: Promise<void> | undefined;
  #consolidationRequested = false;
  #consolidating: Promise<void> | undefined;
  #consolidationAbort: AbortController | undefined;
  #foregroundActive = false;

  constructor(
    private readonly memory: MemoryService,
    private readonly options: MemoryMaintenanceOptions,
  ) {}

  start(): void {
    if (this.#closed) throw new Error("Memory maintenance is shut down");
    if (this.#started) return;
    this.memory.recoverInterruptedWork();
    this.#started = true;
    this.wake();
  }

  enqueueEpisode(episode: MemoryFormationIntake): void {
    if (this.#closed) throw new Error("Memory maintenance is shut down");
    this.memory.enqueueEpisode(episode);
    this.wake();
  }

  /** Manual CRUD and successful formation both wake the same vector indexer. */
  wake(): void {
    if (this.#closed) return;
    this.#formationRequested = true;
    this.#indexRequested = true;
    this.#sourceReleaseRequested = true;
    this.#consolidationRequested = true;
    this.#schedule();
  }

  /** The host calls this from actual user Run/Voice activity. Background work
   * yields; its durable attempt is resumed only after the foreground is idle. */
  setForegroundActive(active: boolean): void {
    if (this.#closed) return;
    this.#foregroundActive = active;
    if (active) {
      this.#consolidationAbort?.abort();
      this.#consolidationRequested = true;
    } else this.#schedule();
  }

  #schedule(): void {
    if (!this.#started || this.#closed) return;
    if (this.#formationRequested && !this.#forming) {
      this.#forming = this.#drainFormation().finally(() => {
        this.#forming = undefined;
        this.#schedule();
      });
    }
    if (
      this.#consolidationRequested &&
      !this.#consolidating &&
      !this.#forming &&
      !this.#foregroundActive
    ) {
      this.#consolidating = this.#drainConsolidation().finally(() => {
        this.#consolidating = undefined;
        this.#schedule();
      });
    }
    if (this.#indexRequested && !this.#indexing) {
      this.#indexing = this.#drainIndex().finally(() => {
        this.#indexing = undefined;
        this.#schedule();
      });
    }
    if (
      this.#sourceReleaseRequested &&
      !this.#releasingSources &&
      this.options.reclaimSources
    ) {
      this.#releasingSources = this.#drainSourceRelease().finally(() => {
        this.#releasingSources = undefined;
        this.#schedule();
      });
    }
  }

  retry(): void {
    if (this.#closed) return;
    this.memory.retryFailedFormationWork();
    this.memory.retryFailedIndex();
    this.memory.retryFailedConsolidationWork();
    // Rebind an in-flight consolidation to newly saved credentials even when
    // profile/model IDs are unchanged. The existing cancellation path preserves
    // committed members and returns only unfinished work to pending.
    this.#consolidationAbort?.abort();
    // Already failed work is durable pending immediately. An in-flight call
    // may fail after this event, so consume this one request at its boundary.
    if (this.#forming) this.#formationRetryRequested = true;
    this.wake();
  }

  /** A host-owned ordinary Run completion proves availability only for failures
   * that already exist at this event. Do not retain a trigger for in-flight work. */
  recoverProviderFailures(recovery: MemoryProviderRecovery): void {
    if (this.#closed) return;
    if (this.memory.recoverProviderFailures(recovery) > 0) this.wake();
  }

  async #drainFormation(): Promise<void> {
    while (this.#formationRequested && !this.#closed) {
      this.#formationRequested = false;
      for (const episode of this.memory.pendingFormationWork()) {
        if (this.#closed) return;
        try {
          await this.memory.formEpisode(episode.workId, this.#abort.signal);
        } catch (error) {
          if (this.#closed) return;
          this.options.onError(error, "formation");
        }
        // A later episode can spend minutes awaiting its model. Index already
        // committed revisions independently, including partial segment progress.
        this.#indexRequested = true;
        this.#sourceReleaseRequested = true;
        this.#schedule();
        if (this.#formationRetryRequested) {
          this.#formationRetryRequested = false;
          this.memory.retryFailedFormationWork();
          this.#formationRequested = true;
          break;
        }
      }
    }
  }

  async #drainConsolidation(): Promise<void> {
    this.#consolidationRequested = false;
    const controller = new AbortController();
    this.#consolidationAbort = controller;
    try {
      await this.memory.consolidatePending(
        controller.signal,
        (error) => this.options.onError(error, "consolidation"),
        () => {
          this.#consolidationRequested = true;
        },
      );
      this.#indexRequested = true;
    } catch (error) {
      if (!controller.signal.aborted && !this.#closed)
        this.options.onError(error, "consolidation");
    } finally {
      this.#consolidationAbort = undefined;
    }
  }

  async #drainIndex(): Promise<void> {
    while (this.#indexRequested && !this.#closed) {
      this.#indexRequested = false;
      try {
        await this.memory.indexPending(this.#abort.signal);
      } catch (error) {
        if (this.#closed) return;
        this.options.onError(error, "index");
      }
    }
  }

  async #drainSourceRelease(): Promise<void> {
    while (this.#sourceReleaseRequested && !this.#closed) {
      this.#sourceReleaseRequested = false;
      try {
        await this.options.reclaimSources!(this.#abort.signal);
      } catch (error) {
        if (this.#closed) return;
        this.options.onError(error, "source_release");
      }
    }
  }

  async idle(): Promise<void> {
    while (
      this.#forming ||
      this.#indexing ||
      this.#releasingSources ||
      this.#consolidating
    )
      await Promise.all([
        this.#forming,
        this.#indexing,
        this.#releasingSources,
        this.#consolidating,
      ]);
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    this.#formationRequested = false;
    this.#indexRequested = false;
    this.#sourceReleaseRequested = false;
    this.#consolidationRequested = false;
    this.#consolidationAbort?.abort();
    this.#abort.abort();
    await this.idle();
  }
}
