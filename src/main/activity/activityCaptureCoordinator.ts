import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { Clock } from "../../shared/pure/clock";
import { redactText } from "../../shared/pure/redaction";
import type { AppLogger } from "../observability/logger";
import type {
  ActiveApplication,
  ActiveApplicationProbe,
} from "./activeApplicationProbe";
import type { ActivityService } from "./activityService";
import type {
  ActivitySystemBoundary,
  ActivitySystemSource,
} from "./activitySystemSource";

const SAMPLE_INTERVAL_MS = 15_000;
const SCREENSHOT_INTERVAL_MS = 15 * 60_000;

export interface ManagedBrowserActivity {
  readonly action?: string;
  readonly title?: string;
  readonly url: string;
}

interface OpenEvent {
  readonly actor: "agent" | "user";
  readonly id: string;
  readonly key: string;
}

function toolName(envelope: RunEventEnvelope): string | undefined {
  const event = envelope.event;
  if (
    (event.type !== "item.started" && event.type !== "item.completed") ||
    (event.item.kind !== "tool_call" &&
      event.item.kind !== "command" &&
      event.item.kind !== "file_change") ||
    typeof event.item.input !== "object" ||
    event.item.input === null ||
    Array.isArray(event.item.input)
  ) {
    return undefined;
  }
  const value = event.item.input["toolName"];
  return typeof value === "string" ? value : undefined;
}

function controlsVisibleApplication(envelope: RunEventEnvelope): boolean {
  const name = toolName(envelope);
  return (
    name?.startsWith("app.") === true ||
    name?.startsWith("browser.") === true ||
    name?.startsWith("computer.") === true
  );
}

function browserDetails(input: ManagedBrowserActivity) {
  const parsed = new URL(input.url);
  const networkUrl =
    parsed.protocol === "http:" || parsed.protocol === "https:";
  const protocol = parsed.protocol.slice(0, -1);
  const url = networkUrl
    ? `${parsed.origin}${parsed.pathname}`
    : parsed.protocol;
  return {
    ...(input.action ? { action: redactText(input.action) } : {}),
    domain: parsed.hostname || protocol,
    source: "managed_browser" as const,
    ...(input.title ? { title: redactText(input.title) } : {}),
    url,
  };
}

export class ActivityCaptureCoordinator {
  #activeApplication: OpenEvent | undefined;
  #agentUiActions = new Map<string, string>();
  #browserKey: string | undefined;
  #cancel = new AbortController();
  #idle = false;
  #interval: ReturnType<typeof setInterval> | undefined;
  #lastScreenshotAt: number | undefined;
  #queue: Promise<void> = Promise.resolve();
  #stopPauseSubscription: (() => void) | undefined;
  #stopSystemSubscription: (() => void) | undefined;

  constructor(
    private readonly activity: ActivityService,
    private readonly applications: ActiveApplicationProbe,
    private readonly system: ActivitySystemSource,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.#interval) return;
    this.#stopPauseSubscription = this.activity.onPauseChanged((paused) => {
      void this.#enqueue(async () => {
        if (paused) this.#closeOpenEvents();
        else await this.#sample();
      });
    });
    this.#stopSystemSubscription = this.system.subscribe((boundary) => {
      void this.#enqueue(() => this.#handleSystemBoundary(boundary));
    });
    this.#interval = setInterval(
      () => void this.#enqueue(() => this.#sample()),
      SAMPLE_INTERVAL_MS,
    );
    this.#interval.unref?.();
    void this.#enqueue(() => this.#sample());
  }

  async stop(): Promise<void> {
    if (this.#interval) clearInterval(this.#interval);
    this.#interval = undefined;
    this.#stopPauseSubscription?.();
    this.#stopPauseSubscription = undefined;
    this.#stopSystemSubscription?.();
    this.#stopSystemSubscription = undefined;
    this.#cancel.abort();
    await this.#queue;
    this.#closeOpenEvents();
  }

  observeBrowser(input: ManagedBrowserActivity): Promise<void> {
    return this.#enqueue(async () => {
      if (this.activity.isPaused() || this.#idle) return;
      const details = browserDetails(input);
      const actor = this.#actor();
      const key = details.url;
      if (this.#browserKey === key) return;
      this.#browserKey = key;
      this.activity.recordEvent(details, actor);
      await this.#captureScreenshot(actor);
    });
  }

  observeRun(envelope: RunEventEnvelope): void {
    const event = envelope.event;
    if (event.type === "item.started" && controlsVisibleApplication(envelope)) {
      this.#agentUiActions.set(event.item.id, event.item.runId);
      void this.#enqueue(() => this.#splitForActorChange());
      return;
    }
    if (event.type === "item.completed") {
      if (this.#agentUiActions.has(event.item.id)) {
        void this.#enqueue(async () => {
          this.#agentUiActions.delete(event.item.id);
          await this.#splitForActorChange();
        });
      }
      return;
    }
    if (event.type === "run.started" || event.type === "run.resumed") {
      this.activity.recordEvent(
        { runId: event.run.id, source: "agent_run", status: "started" },
        "agent",
        envelope.occurredAt,
      );
      return;
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled" ||
      event.type === "run.interrupted"
    ) {
      this.activity.recordEvent(
        {
          runId: event.run.id,
          source: "agent_run",
          status:
            event.type === "run.completed"
              ? "completed"
              : event.type === "run.failed"
                ? "failed"
                : "cancelled",
        },
        "agent",
        envelope.occurredAt,
      );
      if ([...this.#agentUiActions.values()].includes(event.run.id)) {
        void this.#enqueue(async () => {
          for (const [itemId, runId] of this.#agentUiActions) {
            if (runId === event.run.id) this.#agentUiActions.delete(itemId);
          }
          await this.#splitForActorChange();
        });
      }
    }
  }

  #actor(): "agent" | "user" {
    return this.#agentUiActions.size > 0 ? "agent" : "user";
  }

  async #sample(): Promise<void> {
    if (this.activity.isPaused()) {
      this.#closeOpenEvents();
      return;
    }
    const idle = this.system.isIdle();
    if (idle !== this.#idle) {
      await this.#handleSystemBoundary(idle ? "inactive" : "active");
    }
    if (this.#idle) return;
    let current: ActiveApplication | undefined;
    try {
      current = await this.applications.read(this.#cancel.signal);
    } catch (error) {
      if (!this.#cancel.signal.aborted) {
        this.logger.warn("ACTIVITY_ACTIVE_APP_READ_ERROR", { error });
      }
      return;
    }
    if (!current) return;
    const actor = this.#actor();
    const key = `${actor}:${current.appId ?? current.appName}:${current.windowTitle ?? ""}`;
    if (this.#activeApplication?.key === key) return;
    if (this.#activeApplication)
      this.activity.finishEvent(this.#activeApplication.id);
    const id = this.activity.startEvent(
      {
        ...(current.appId ? { appId: current.appId } : {}),
        appName: current.appName,
        source: "active_app",
        ...(current.windowTitle ? { windowTitle: current.windowTitle } : {}),
      },
      actor,
    );
    this.#activeApplication = id ? { actor, id, key } : undefined;
    if (id) await this.#captureScreenshot(actor);
  }

  async #handleSystemBoundary(boundary: ActivitySystemBoundary): Promise<void> {
    const nextIdle = boundary === "inactive" || this.system.isIdle();
    if (nextIdle === this.#idle) return;
    this.#idle = nextIdle;
    this.#closeOpenEvents();
    this.activity.recordEvent(
      { source: "idle", state: nextIdle ? "started" : "ended" },
      "system",
    );
    if (!nextIdle) await this.#sample();
  }

  async #splitForActorChange(): Promise<void> {
    const actor = this.#actor();
    if (this.#activeApplication && this.#activeApplication.actor !== actor) {
      this.#closeOpenEvents(false);
      await this.#sample();
    }
  }

  #closeOpenEvents(resetBrowserObservation = true): void {
    if (this.#activeApplication) {
      this.activity.finishEvent(this.#activeApplication.id);
      this.#activeApplication = undefined;
    }
    if (resetBrowserObservation) this.#browserKey = undefined;
  }

  async #captureScreenshot(actor: "agent" | "user"): Promise<void> {
    if (actor !== "user") return;
    const capturedAt = Date.parse(this.clock.now());
    if (
      this.#lastScreenshotAt !== undefined &&
      capturedAt - this.#lastScreenshotAt < SCREENSHOT_INTERVAL_MS
    ) {
      return;
    }
    this.#lastScreenshotAt = capturedAt;
    await this.activity.captureScreenshot(actor).catch((error: unknown) => {
      if (this.#lastScreenshotAt === capturedAt) {
        this.#lastScreenshotAt = undefined;
      }
      this.logger.warn("ACTIVITY_SCREENSHOT_ERROR", { error });
    });
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const queued = this.#queue.then(task, task).catch((error: unknown) => {
      this.logger.warn("ACTIVITY_CAPTURE_ERROR", { error });
    });
    this.#queue = queued;
    return queued;
  }
}
