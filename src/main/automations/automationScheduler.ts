import type { Clock } from "../../shared/pure/clock";

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

interface AutomationScheduleRunner {
  earliestNextRunAt(): string | undefined;
  runDue(now?: string): Promise<void>;
}

export interface ResumeEventSource {
  on(event: "resume", listener: () => void): unknown;
  removeListener(event: "resume", listener: () => void): unknown;
}

export class AutomationScheduler {
  #checking: Promise<void> | undefined;
  #checkRequested = false;
  #started = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  readonly #onResume = (): void => {
    this.refresh();
  };

  constructor(
    private readonly service: AutomationScheduleRunner,
    private readonly clock: Clock,
    private readonly resumeEvents?: ResumeEventSource,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.resumeEvents?.on("resume", this.#onResume);
    this.refresh();
  }

  refresh(): void {
    if (!this.#started) return;
    this.#checkRequested = true;
    this.#clearTimer();
    if (!this.#checking) {
      this.#checking = this.#runChecks().finally(() => {
        this.#checking = undefined;
        if (this.#started && this.#checkRequested) this.refresh();
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.#checkRequested = false;
    this.#clearTimer();
    this.resumeEvents?.removeListener("resume", this.#onResume);
    await this.#checking;
  }

  async #runChecks(): Promise<void> {
    while (this.#started && this.#checkRequested) {
      this.#checkRequested = false;
      try {
        await this.service.runDue(this.clock.now());
      } catch (error) {
        this.onError(error);
        return;
      }
    }
    if (this.#started) this.#armNext();
  }

  #armNext(): void {
    this.#clearTimer();
    const nextRunAt = this.service.earliestNextRunAt();
    if (!nextRunAt) return;
    const delay = Math.max(
      0,
      Date.parse(nextRunAt) - Date.parse(this.clock.now()),
    );
    this.#timer = setTimeout(
      () => this.refresh(),
      Math.min(delay, MAX_NODE_TIMER_DELAY_MS),
    );
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
