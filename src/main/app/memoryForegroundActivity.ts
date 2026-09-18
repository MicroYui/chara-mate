import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { VoiceSessionSnapshot } from "../../shared/contracts/voice";
import type { RunRepository } from "../agent/runRepository";
import type { MemoryMaintenance } from "../memory/memoryMaintenance";

/** App-owned projection of current execution, never another durable Run state.
 * Called after committed Run events and from the current Voice snapshot. */
export class MemoryForegroundActivity {
  readonly #running = new Set<string>();
  #voiceActive = false;
  #active = false;

  constructor(
    private readonly runs: Pick<RunRepository, "getRun">,
    private readonly maintenance: Pick<
      MemoryMaintenance,
      "setForegroundActive"
    >,
  ) {}

  observeRun(envelope: RunEventEnvelope): void {
    // Streaming text cannot change execution state. Read the actual projection
    // for other events: approvals and user-message takeover also change it.
    if (envelope.event.type === "item.delta") return;
    const run = this.runs.getRun(envelope.streamId);
    if (run?.status === "running") this.#running.add(run.id);
    else this.#running.delete(envelope.streamId);
    this.#publish();
  }

  observeVoice(snapshot: VoiceSessionSnapshot | null): void {
    this.#voiceActive = Boolean(
      snapshot &&
      snapshot.phase !== "paused" &&
      snapshot.phase !== "failed" &&
      snapshot.phase !== "interrupted",
    );
    this.#publish();
  }

  #publish(): void {
    const active = this.#voiceActive || this.#running.size > 0;
    if (active === this.#active) return;
    this.#active = active;
    this.maintenance.setForegroundActive(active);
  }
}
