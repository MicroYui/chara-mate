import type { Clock } from "../../shared/pure/clock";

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export interface PersistentScheduleRunner {
  earliestNextRunAt(): string | undefined;
  runDue(now?: string): Promise<void>;
}

export interface ResumeEventSource {
  on(event: "resume", listener: () => void): unknown;
  removeListener(event: "resume", listener: () => void): unknown;
}

function isScheduleRunnerList(
  value: PersistentScheduleRunner | readonly PersistentScheduleRunner[],
): value is readonly PersistentScheduleRunner[] {
  return Array.isArray(value);
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
    service: PersistentScheduleRunner | readonly PersistentScheduleRunner[],
    private readonly clock: Clock,
    private readonly resumeEvents?: ResumeEventSource,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.services = isScheduleRunnerList(service) ? [...service] : [service];
  }

  private readonly services: readonly PersistentScheduleRunner[];

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
    let failedServices = new Set<PersistentScheduleRunner>();
    while (this.#started && this.#checkRequested) {
      this.#checkRequested = false;
      failedServices = new Set<PersistentScheduleRunner>();
      const now = this.clock.now();
      for (const service of this.services) {
        try {
          await service.runDue(now);
        } catch (error) {
          failedServices.add(service);
          this.onError(error);
        }
      }
    }
    if (this.#started) this.#armNext(failedServices);
  }

  #armNext(failedServices: ReadonlySet<PersistentScheduleRunner>): void {
    this.#clearTimer();
    const nextRunAt = this.services
      .flatMap((service) => {
        if (failedServices.has(service)) return [];
        try {
          const value = service.earliestNextRunAt();
          return value ? [value] : [];
        } catch (error) {
          this.onError(error);
          return [];
        }
      })
      .sort()[0];
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
