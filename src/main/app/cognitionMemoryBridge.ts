import { setImmediate } from "node:timers/promises";
import type Database from "better-sqlite3";
import type { CognitionEvidence } from "../../shared/contracts/cognition";
import type { MemoryFormationSource } from "../../shared/contracts/memoryRecall";
import type { CognitionRepository } from "../cognition/cognitionRepository";
import type { MemoryService } from "../memory/memoryService";
import { cognitionMemoryIntake } from "./cognitionMemoryIntake";
import type { MemorySourceResolution } from "./memoryFormationSources";

interface CognitionMemoryBridgeOptions {
  database: Database.Database;
  cognition: Pick<
    CognitionRepository,
    | "pendingMemoryHandoffs"
    | "memoryHandoffEvidence"
    | "memoryHandoffContext"
    | "acknowledgeMemoryHandoff"
  >;
  memory: Pick<MemoryService, "enqueueEpisode">;
  describeSource: (evidence: CognitionEvidence) => MemorySourceResolution;
  resolveSource: (
    evidence: CognitionEvidence,
  ) => MemoryFormationSource | undefined;
  wakeMemory: () => void;
  onError: (error: unknown, handoffId?: string) => void;
}

/** One event-driven transfer owner; pending metadata survives either side's failure. */
export class CognitionMemoryBridge {
  #started = false;
  #closed = false;
  #requested = false;
  #running: Promise<void> | undefined;
  constructor(private readonly options: CognitionMemoryBridgeOptions) {}
  start(): void {
    if (this.#closed) throw new Error("Memory bridge is shut down");
    if (this.#started) return;
    this.#started = true;
    this.wake();
  }
  wake(): void {
    if (this.#closed) return;
    this.#requested = true;
    if (!this.#started || this.#running) return;
    this.#running = Promise.resolve()
      .then(() => this.#drain())
      .catch((error) => this.options.onError(error))
      .finally(() => {
        this.#running = undefined;
        if (this.#requested && !this.#closed) this.wake();
      });
  }
  async #drain(): Promise<void> {
    while (this.#requested && !this.#closed) {
      this.#requested = false;
      for (const handoff of this.options.cognition.pendingMemoryHandoffs()) {
        if (this.#closed) return;
        try {
          this.options.database.transaction(() => {
            const intake = cognitionMemoryIntake(
              handoff,
              this.options.cognition,
              this.options.describeSource,
              this.options.resolveSource,
            );
            if (intake) this.options.memory.enqueueEpisode(intake);
            if (!this.options.cognition.acknowledgeMemoryHandoff(handoff.id))
              throw new Error(
                "Memory handoff disappeared before acknowledgement",
              );
          })();
          // Starting asynchronous/paid formation inside the enclosing transaction could run on rolled-back input.
          // Retiring an unsupported handoff can also release an old original.
          this.options.wakeMemory();
        } catch (error) {
          this.options.onError(error, handoff.id);
        }
        await setImmediate();
      }
    }
  }
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }
  async shutdown(): Promise<void> {
    this.#closed = true;
    this.#requested = false;
    await this.idle();
  }
}
