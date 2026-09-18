import type { ActivityPerception } from "../../shared/contracts/activity";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { Clock } from "../../shared/pure/clock";
import { redactText } from "../../shared/pure/redaction";
import type { AppLogger } from "../observability/logger";
import {
  mergeActivityInteractions,
  normalizeActivityPerception,
  type ActiveApplication,
  type ActiveApplicationSource,
} from "./activeApplicationSource";
import type { ForegroundActivityObserver } from "./activityObservation";
import type { ActivityService } from "./activityService";
import type {
  ActivitySystemBoundary,
  ActivitySystemSource,
} from "./activitySystemSource";

const IDLE_SAMPLE_INTERVAL_MS = 15_000;

export interface ManagedBrowserActivity extends ActivityPerception {
  readonly actor?: "agent" | "system" | "user" | "unknown";
  readonly action?: string;
  readonly title?: string;
  readonly url: string;
}

interface OpenEvent {
  readonly actor: "agent" | "user" | "unknown";
  readonly id: string;
  readonly key: string;
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
    ...normalizeActivityPerception(input),
    ...(input.action ? { action: redactText(input.action) } : {}),
    domain: parsed.hostname || protocol,
    source: "managed_browser" as const,
    ...(input.title ? { title: redactText(input.title) } : {}),
    url,
  };
}

export class ActivityCaptureCoordinator {
  #activeApplication: OpenEvent | undefined;
  #browserKey: string | undefined;
  #currentApplication: ActiveApplication | undefined;
  #appliedApplication: ActiveApplication | undefined;
  #pendingApplication:
    | { application: ActiveApplication; actor: "agent" | "user" | "unknown" }
    | undefined;
  #idle = false;
  #idleInterval: ReturnType<typeof setInterval> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #started = false;
  #sourceGeneration = 0;
  #stopped = false;
  #stopVisualSubscription: (() => void) | undefined;
  #stopApplicationSubscription: (() => Promise<void>) | undefined;
  #stopPauseSubscription: (() => void) | undefined;
  #stopSystemSubscription: (() => void) | undefined;

  constructor(
    private readonly activity: ActivityService,
    private readonly applications: ActiveApplicationSource,
    private readonly system: ActivitySystemSource,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly foregroundObserver?: ForegroundActivityObserver,
  ) {}

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    this.applications.setPaused(
      this.activity.isPaused() || this.system.isIdle(),
    );
    this.activity.setVisualFrameSupplier((signal) =>
      this.applications.pullVisual(signal),
    );
    this.#stopVisualSubscription = this.applications.subscribeVisualChanges(
      (change) => {
        if (!this.#stopped && !this.#idle)
          this.activity.notifyVisualChanged(change);
      },
    );
    this.#stopPauseSubscription = this.activity.onPauseChanged((paused) => {
      this.#sourceGeneration += 1;
      this.applications.setPaused(paused || this.#idle);
      void this.#enqueue(() => {
        if (paused) {
          this.#currentApplication = undefined;
          this.#closeOpenEvents();
        } else this.#refreshSystemState();
      });
    });
    this.#stopSystemSubscription = this.system.subscribe((boundary) => {
      this.#sourceGeneration += 1;
      this.applications.setPaused(
        boundary === "inactive" ||
          this.system.isIdle() ||
          this.activity.isPaused(),
      );
      void this.#enqueue(() => this.#handleSystemBoundary(boundary));
    });
    this.#stopApplicationSubscription = this.applications.subscribe(
      (application) => {
        if (!this.#started) return;
        this.#queueApplication(application);
      },
      (error) => {
        this.logger.warn("ACTIVITY_ACTIVE_APP_SOURCE_ERROR", { error });
      },
    );
    this.#idleInterval = setInterval(
      () => void this.#enqueue(() => this.#refreshSystemState()),
      IDLE_SAMPLE_INTERVAL_MS,
    );
    this.#idleInterval.unref?.();
    void this.#enqueue(() => this.#refreshSystemState());
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#stopped = true;
    this.#sourceGeneration += 1;
    this.activity.setVisualFrameSupplier(undefined);
    this.activity.setVisualContext(undefined);
    if (this.#idleInterval) clearInterval(this.#idleInterval);
    this.#idleInterval = undefined;
    this.#stopPauseSubscription?.();
    this.#stopPauseSubscription = undefined;
    this.#stopSystemSubscription?.();
    this.#stopSystemSubscription = undefined;
    this.#stopVisualSubscription?.();
    this.#stopVisualSubscription = undefined;
    const stopApplicationSubscription = this.#stopApplicationSubscription;
    this.#stopApplicationSubscription = undefined;
    await stopApplicationSubscription?.();
    await this.#queue;
    await this.activity.stopVisualCapture();
    this.#closeOpenEvents();
  }

  observeBrowser(input: ManagedBrowserActivity): Promise<void> {
    return this.#enqueue(() => {
      if (this.#stopped || this.activity.isPaused() || this.#idle) return;
      const details = browserDetails(input);
      const actor = input.actor ?? "unknown";
      const key = JSON.stringify({ actor, details });
      if (this.#browserKey === key && !details.interaction) return;
      this.#browserKey = key;
      const eventId = this.activity.recordEvent(details, actor);
      if (eventId && actor !== "system")
        this.#publishForeground({
          actor,
          appName: "Managed Chromium",
          eventId,
          observedAt: this.clock.now(),
          ...(details.title ? { windowTitle: details.title } : {}),
          ...normalizeActivityPerception(details),
        });
      if (eventId && actor !== "system" && details.surface) {
        this.activity.setVisualContext({
          actor,
          surface: details.surface,
          eventId,
        });
      }
    });
  }

  observeRun(envelope: RunEventEnvelope): void {
    if (this.#stopped) return;
    const event = envelope.event;
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
    }
  }

  #refreshSystemState(): void {
    if (this.activity.isPaused()) {
      this.#closeOpenEvents();
      return;
    }
    const idle = this.system.isIdle();
    if (idle !== this.#idle) {
      this.#handleSystemBoundary(idle ? "inactive" : "active");
    }
    if (this.#idle) return;
    this.#applyCurrentApplication();
  }

  #queueApplication(application: ActiveApplication): void {
    const actor = application.actor ?? "unknown";
    const pending = this.#pendingApplication;
    const sameObject =
      pending &&
      pending.actor === actor &&
      pending.application.inputOrigin === application.inputOrigin &&
      pending.application.appId === application.appId &&
      pending.application.appName === application.appName &&
      pending.application.windowTitle === application.windowTitle &&
      pending.application.surface?.id === application.surface?.id &&
      pending.application.surface?.epoch === application.surface?.epoch;
    if (
      (application.boundary === "content" ||
        application.boundary === "interaction") &&
      sameObject
    ) {
      const interaction = mergeActivityInteractions(
        pending.application.interaction,
        application.interaction,
      );
      pending.application = {
        ...application,
        ...(interaction ? { interaction } : {}),
      };
      return;
    }
    const captured = { application, actor };
    const generation = this.#sourceGeneration;
    this.#pendingApplication = captured;
    void this.#enqueue(() => {
      if (this.#pendingApplication === captured)
        this.#pendingApplication = undefined;
      const current = captured.application;
      if (
        !this.#started ||
        generation !== this.#sourceGeneration ||
        this.activity.isPaused()
      )
        return;
      if (
        current.lifecycle === "launched" ||
        current.lifecycle === "terminated"
      ) {
        this.activity.recordEvent(
          {
            appName: current.appName,
            ...(current.appId ? { appId: current.appId } : {}),
            lifecycle: current.lifecycle,
            boundary: "application",
            source: "active_app",
          },
          "system",
          current.observedAt,
        );
        return;
      }
      this.#currentApplication = current;
      this.#applyCurrentApplication(captured.actor);
    });
  }

  #applyCurrentApplication(
    actor = this.#currentApplication?.actor ?? "unknown",
    publish = true,
  ): void {
    if (this.activity.isPaused() || this.#idle) return;
    const current = this.#currentApplication;
    if (!current) return;
    const perception = normalizeActivityPerception(current);
    const key = JSON.stringify({
      actor,
      appId: current.appId,
      appName: current.appName,
      windowTitle: current.windowTitle,
      content: perception.content,
      contentStatus: perception.contentStatus,
      surface: perception.surface,
      visualStatus: perception.visualStatus,
    });
    if (
      this.#activeApplication?.key === key &&
      (this.#appliedApplication === current || !current.interaction)
    )
      return;
    this.#appliedApplication = current;
    if (this.#activeApplication)
      this.activity.finishEvent(this.#activeApplication.id);
    const id = this.activity.startEvent(
      {
        ...(current.appId ? { appId: current.appId } : {}),
        appName: current.appName,
        source: "active_app",
        ...perception,
        ...(current.lifecycle ? { lifecycle: current.lifecycle } : {}),
        ...(current.windowTitle ? { windowTitle: current.windowTitle } : {}),
      },
      actor,
      current.observedAt,
    );
    this.#activeApplication = id ? { actor, id, key } : undefined;
    if (id && publish)
      this.#publishForeground({
        actor,
        ...(current.appId ? { appId: redactText(current.appId) } : {}),
        appName: redactText(current.appName),
        eventId: id,
        observedAt: current.observedAt ?? this.clock.now(),
        ...perception,
        ...(current.lifecycle ? { lifecycle: current.lifecycle } : {}),
        ...(current.windowTitle
          ? { windowTitle: redactText(current.windowTitle) }
          : {}),
      });
    this.activity.setVisualContext(
      id && perception.surface && perception.visualStatus === "available"
        ? { actor, eventId: id, surface: perception.surface }
        : undefined,
    );
  }

  #publishForeground(
    observation: Parameters<ForegroundActivityObserver["observeForeground"]>[0],
  ): void {
    try {
      this.foregroundObserver?.observeForeground(observation);
    } catch (error) {
      this.logger.warn("ACTIVITY_FOREGROUND_OBSERVER_ERROR", {
        error,
        eventId: observation.eventId,
      });
    }
  }

  #handleSystemBoundary(boundary: ActivitySystemBoundary): void {
    const nextIdle = boundary === "inactive" || this.system.isIdle();
    if (nextIdle === this.#idle) return;
    this.#idle = nextIdle;
    this.#sourceGeneration += 1;
    this.#currentApplication = undefined;
    this.applications.setPaused(nextIdle || this.activity.isPaused());
    this.#closeOpenEvents();
    this.activity.recordEvent(
      { source: "idle", state: nextIdle ? "started" : "ended" },
      "system",
    );
    // Resume waits for the native owner to observe the current source again.
  }

  #closeOpenEvents(resetBrowserObservation = true): void {
    this.activity.setVisualContext(undefined);
    if (this.#activeApplication) {
      this.activity.finishEvent(this.#activeApplication.id);
      this.#activeApplication = undefined;
    }
    if (resetBrowserObservation) this.#browserKey = undefined;
  }

  #enqueue(task: () => Promise<void> | void): Promise<void> {
    const queued = this.#queue.then(task, task).catch((error: unknown) => {
      this.logger.warn("ACTIVITY_CAPTURE_ERROR", { error });
    });
    this.#queue = queued;
    return queued;
  }
}
