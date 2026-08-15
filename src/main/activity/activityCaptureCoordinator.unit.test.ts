import { describe, expect, it, vi } from "vitest";

import type { ActivityEventDetails } from "../../shared/contracts/activity";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { Clock } from "../../shared/pure/clock";
import type { AppLogger } from "../observability/logger";
import type {
  ActiveApplication,
  ActiveApplicationSource,
} from "./activeApplicationSource";
import { ActivityCaptureCoordinator } from "./activityCaptureCoordinator";
import type { ForegroundActivityObservation } from "./activityObservation";
import type { ActivityService } from "./activityService";
import type { ActivitySystemSource } from "./activitySystemSource";

async function flushQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness() {
  let current = Date.parse("2026-08-08T10:00:00.000Z");
  let nextId = 0;
  const started: Array<{ actor: "agent" | "user"; source: string }> = [];
  const recorded: Array<{
    actor: "agent" | "system" | "user";
    source: string;
  }> = [];
  const screenshots: string[] = [];
  const observations: ForegroundActivityObservation[] = [];
  let activeApplication:
    | {
        readonly appId?: string;
        readonly appName: string;
        readonly windowTitle?: string;
      }
    | undefined;
  let applicationListener:
    ((application: ActiveApplication) => void) | undefined;
  const recordEvent = vi.fn(
    (details: ActivityEventDetails, actor: "agent" | "system" | "user") => {
      recorded.push({ actor, source: details.source });
    },
  );
  const finishEvent = vi.fn();
  const activity = {
    captureScreenshot: vi.fn((actor: string) => {
      screenshots.push(actor);
      return Promise.resolve();
    }),
    finishEvent,
    isPaused: () => false,
    onPauseChanged: () => () => undefined,
    recordEvent,
    startEvent: vi.fn(
      (details: ActivityEventDetails, actor: "agent" | "user") => {
        started.push({ actor, source: details.source });
        nextId += 1;
        return `event-${String(nextId)}`;
      },
    ),
  } as unknown as ActivityService;
  const applications = {
    subscribe(listener: (application: ActiveApplication) => void) {
      applicationListener = listener;
      if (activeApplication) listener(activeApplication);
      return () => Promise.resolve();
    },
  } satisfies ActiveApplicationSource;
  const system = {
    isIdle: () => false,
    subscribe: () => () => undefined,
  } satisfies ActivitySystemSource;
  const clock = {
    now: () => new Date(current).toISOString(),
  } satisfies Clock;
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } satisfies AppLogger;
  return {
    activity,
    advance(milliseconds: number) {
      current += milliseconds;
    },
    coordinator: new ActivityCaptureCoordinator(
      activity,
      applications,
      system,
      clock,
      logger,
      { observeForeground: (observation) => observations.push(observation) },
    ),
    finishEvent,
    observations,
    recorded,
    recordEvent,
    screenshots,
    setActiveApplication(value: typeof activeApplication) {
      activeApplication = value;
      if (value) applicationListener?.(value);
    },
    started,
  };
}

function runEnvelope(type: "run.completed" | "run.started"): RunEventEnvelope {
  return {
    event: {
      run: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      type,
    },
    occurredAt: "2026-08-08T10:00:00.000Z",
    sequence: 1,
    streamId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  } as unknown as RunEventEnvelope;
}

function toolEnvelope(
  type: "item.completed" | "item.started",
  name: string,
): RunEventEnvelope {
  return {
    event: {
      item: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        input: { toolName: name },
        kind: "tool_call",
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      type,
    },
    occurredAt: "2026-08-08T10:00:00.000Z",
    sequence: type === "item.started" ? 2 : 3,
    streamId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  } as unknown as RunEventEnvelope;
}

describe("ActivityCaptureCoordinator", () => {
  it("publishes a typed user foreground fact without assigning companionship state", async () => {
    const fixture = harness();
    fixture.setActiveApplication({
      appId: "com.example.editor",
      appName: "Editor",
      windowTitle: "thesis-outline.md",
    });

    fixture.coordinator.start();
    await flushQueue();
    await fixture.coordinator.stop();

    expect(fixture.observations).toEqual([
      {
        appId: "com.example.editor",
        appName: "Editor",
        eventId: "event-1",
        observedAt: "2026-08-08T10:00:00.000Z",
        windowTitle: "thesis-outline.md",
      },
    ]);
    expect(fixture.started).toEqual([{ actor: "user", source: "active_app" }]);
  });

  it("records title changes from the event source without polling", async () => {
    const fixture = harness();
    fixture.setActiveApplication({ appName: "Editor", windowTitle: "one.md" });
    fixture.coordinator.start();
    await flushQueue();

    fixture.setActiveApplication({ appName: "Editor", windowTitle: "two.md" });
    await flushQueue();
    await fixture.coordinator.stop();

    expect(fixture.started).toEqual([
      { actor: "user", source: "active_app" },
      { actor: "user", source: "active_app" },
    ]);
    expect(fixture.finishEvent).toHaveBeenCalledWith("event-1");
  });

  it("captures at a user transition no more than once per 15 minutes", async () => {
    const fixture = harness();
    const { coordinator, screenshots } = fixture;
    await coordinator.observeBrowser({ url: "https://example.com/one" });
    expect(screenshots).toEqual(["user"]);

    fixture.advance(14 * 60_000);
    await coordinator.observeBrowser({ url: "https://example.com/two" });
    expect(screenshots).toHaveLength(1);

    fixture.advance(60_000);
    await coordinator.observeBrowser({ url: "https://example.com/three" });
    expect(screenshots).toEqual(["user", "user"]);
  });

  it("records Agent browser transitions separately without Activity screenshots", async () => {
    const { coordinator, recorded, screenshots } = harness();
    coordinator.observeRun(runEnvelope("run.started"));
    coordinator.observeRun(toolEnvelope("item.started", "browser.navigate"));
    const agentObservation = coordinator.observeBrowser({
      url: "https://example.com/agent",
    });
    coordinator.observeRun(toolEnvelope("item.completed", "browser.navigate"));
    await agentObservation;

    expect(recorded).toContainEqual({
      actor: "agent",
      source: "managed_browser",
    });
    expect(screenshots).toEqual([]);

    await coordinator.observeBrowser({ url: "https://example.com/agent" });
    expect(
      recorded.filter(({ source }) => source === "managed_browser"),
    ).toEqual([{ actor: "agent", source: "managed_browser" }]);

    await coordinator.observeBrowser({ url: "https://example.com/user" });
    expect(recorded.at(-1)).toEqual({
      actor: "user",
      source: "managed_browser",
    });
    expect(screenshots).toEqual(["user"]);
  });

  it("keeps non-network browser observations schema-valid and bounded", async () => {
    const { coordinator, recordEvent } = harness();

    await coordinator.observeBrowser({
      title: "Local reference",
      url: "file:///Users/example/private/reference.html?token=value",
    });

    expect(recordEvent).toHaveBeenCalledWith(
      {
        domain: "file",
        source: "managed_browser",
        title: "Local reference",
        url: "file:",
      },
      "user",
    );
  });

  it("does not attribute the user's foreground activity to a thinking Run", async () => {
    const { coordinator, recorded } = harness();
    coordinator.observeRun(runEnvelope("run.started"));
    await coordinator.observeBrowser({ url: "https://example.com/user" });

    expect(recorded.at(-1)).toEqual({
      actor: "user",
      source: "managed_browser",
    });
  });

  it("waits for an in-flight screenshot before shutdown completes", async () => {
    const { activity, coordinator } = harness();
    let finishScreenshot: () => void = () => undefined;
    vi.spyOn(activity, "captureScreenshot").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishScreenshot = resolve;
        }),
    );

    void coordinator.observeBrowser({ url: "https://example.com/pending" });
    await flushQueue();
    let stopped = false;
    const stop = coordinator.stop().then(() => {
      stopped = true;
    });
    await flushQueue();
    expect(stopped).toBe(false);

    finishScreenshot();
    await stop;
    expect(stopped).toBe(true);
  });
});
