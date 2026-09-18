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
import {
  visualFrameFixture,
  visualSurfaceFixture,
} from "./activityVisual.fixture";
import type { ActivityVisualFrame } from "./activityVisualEvidence";
import type { ActivitySystemSource } from "./activitySystemSource";

async function flushQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness() {
  let current = Date.parse("2026-08-08T10:00:00.000Z");
  let nextId = 0;
  let idle = false;
  let paused = false;
  let pauseListener: ((paused: boolean) => void) | undefined;
  const started: Array<{
    actor: "agent" | "user" | "unknown";
    source: string;
  }> = [];
  const recorded: Array<{
    actor: "agent" | "system" | "user" | "unknown";
    source: string;
  }> = [];
  const screenshots: string[] = [];
  const observations: ForegroundActivityObservation[] = [];
  let activeApplication: ActiveApplication | undefined;
  let applicationListener:
    ((application: ActiveApplication) => void) | undefined;
  const recordEvent = vi.fn(
    (
      details: ActivityEventDetails,
      actor: "agent" | "system" | "user" | "unknown",
    ) => {
      recorded.push({ actor, source: details.source });
      nextId += 1;
      return `recorded-${String(nextId)}`;
    },
  );
  const finishEvent = vi.fn();
  const setVisualContext = vi.fn();
  const startEvent = vi.fn(
    (details: ActivityEventDetails, actor: "agent" | "user" | "unknown") => {
      started.push({ actor, source: details.source });
      nextId += 1;
      return `event-${String(nextId)}`;
    },
  );
  const activity = {
    setVisualContext,
    setVisualFrameSupplier: vi.fn(),
    notifyVisualChanged: vi.fn(),
    stopVisualCapture: vi.fn(() => Promise.resolve(undefined)),
    recordVisualFrame: vi.fn((frame: ActivityVisualFrame) => {
      screenshots.push(frame.actor);
      return Promise.resolve(undefined);
    }),
    finishEvent,
    isPaused: () => paused,
    onPauseChanged: (listener: (paused: boolean) => void) => {
      pauseListener = listener;
      return () => {
        pauseListener = undefined;
      };
    },
    recordEvent,
    startEvent,
  } as unknown as ActivityService;
  const applications = {
    subscribeVisualChanges: vi.fn(() => () => undefined),
    setPaused: vi.fn(),
    pullVisual: vi.fn(async () => visualFrameFixture()),
    subscribe(listener: (application: ActiveApplication) => void) {
      applicationListener = listener;
      if (activeApplication) listener(activeApplication);
      return () => Promise.resolve();
    },
  } satisfies ActiveApplicationSource;
  const system = {
    isIdle: () => idle,
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
    applications,
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
    setVisualContext,
    observations,
    recorded,
    recordEvent,
    screenshots,
    setActiveApplication(value: typeof activeApplication) {
      activeApplication = value;
      if (value) applicationListener?.(value);
    },
    setIdle(value: boolean) {
      idle = value;
    },
    setPaused(value: boolean) {
      paused = value;
      pauseListener?.(value);
    },
    started,
    startEvent,
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
  it("keeps initial idle capture paused when Activity is later unpaused", async () => {
    const fixture = harness();
    fixture.setIdle(true);
    fixture.setActiveApplication({ appName: "Synthetic fixture" });
    fixture.coordinator.start();
    expect(fixture.applications.setPaused).toHaveBeenNthCalledWith(1, true);
    await flushQueue();
    fixture.setPaused(true);
    await flushQueue();
    fixture.setPaused(false);
    await flushQueue();
    expect(fixture.applications.setPaused).toHaveBeenLastCalledWith(true);
    expect(fixture.applications.pullVisual).not.toHaveBeenCalled();
    await fixture.coordinator.stop();
  });

  it("publishes a typed unattributed foreground observation without assigning companionship state", async () => {
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
        actor: "unknown",
        appId: "com.example.editor",
        appName: "Editor",
        eventId: "event-1",
        observedAt: "2026-08-08T10:00:00.000Z",
        windowTitle: "thesis-outline.md",
      },
    ]);
    expect(fixture.started).toEqual([
      { actor: "unknown", source: "active_app" },
    ]);
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
      { actor: "unknown", source: "active_app" },
      { actor: "unknown", source: "active_app" },
    ]);
    expect(fixture.finishEvent).toHaveBeenCalledWith("event-1");
  });

  it("upgrades an activation event when its focused-window title arrives later", async () => {
    const fixture = harness();
    fixture.setActiveApplication({
      appId: "com.example.editor",
      appName: "Editor",
    });
    fixture.coordinator.start();
    await flushQueue();

    fixture.setActiveApplication({
      appId: "com.example.editor",
      appName: "Editor",
      windowTitle: "late-title.md",
    });
    await flushQueue();
    await fixture.coordinator.stop();

    expect(fixture.observations).toEqual([
      {
        actor: "unknown",
        appId: "com.example.editor",
        appName: "Editor",
        eventId: "event-1",
        observedAt: "2026-08-08T10:00:00.000Z",
      },
      {
        actor: "unknown",
        appId: "com.example.editor",
        appName: "Editor",
        eventId: "event-2",
        observedAt: "2026-08-08T10:00:00.000Z",
        windowTitle: "late-title.md",
      },
    ]);
    expect(fixture.finishEvent).toHaveBeenCalledWith("event-1");
  });

  it("keeps meaningful transitions as context without OCR or PNG before attention consumes them", async () => {
    const fixture = harness();
    const { coordinator, screenshots } = fixture;
    fixture.applications.pullVisual.mockResolvedValue(
      await visualFrameFixture(),
    );
    for (const pathname of ["one", "two", "three"]) {
      await coordinator.observeBrowser({
        url: `https://example.com/${pathname}`,
        surface: visualSurfaceFixture,
      });
      await flushQueue();
    }
    expect(screenshots).toEqual([]);
    expect(fixture.applications.pullVisual).not.toHaveBeenCalled();
    expect(fixture.setVisualContext).toHaveBeenCalledTimes(3);
    await coordinator.stop();
  });

  it("records Agent browser transitions separately without Activity screenshots", async () => {
    const { coordinator, recorded, screenshots } = harness();
    coordinator.observeRun(runEnvelope("run.started"));
    coordinator.observeRun(toolEnvelope("item.started", "browser.navigate"));
    const agentObservation = coordinator.observeBrowser({
      actor: "agent",
      url: "https://example.com/agent",
    });
    coordinator.observeRun(toolEnvelope("item.completed", "browser.navigate"));
    await agentObservation;

    expect(recorded).toContainEqual({
      actor: "agent",
      source: "managed_browser",
    });
    expect(screenshots).toEqual([]);

    await coordinator.observeBrowser({
      actor: "agent",
      url: "https://example.com/agent",
    });
    expect(
      recorded.filter(({ source }) => source === "managed_browser"),
    ).toEqual([{ actor: "agent", source: "managed_browser" }]);

    await coordinator.observeBrowser({
      actor: "user",
      url: "https://example.com/user",
    });
    expect(recorded.at(-1)).toEqual({
      actor: "user",
      source: "managed_browser",
    });
    expect(screenshots).toEqual([]);
  });

  it("keeps non-network browser observations schema-valid and bounded", async () => {
    const { coordinator, recordEvent } = harness();

    await coordinator.observeBrowser({
      actor: "user",
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
    await coordinator.observeBrowser({
      actor: "user",
      url: "https://example.com/user",
    });

    expect(recorded.at(-1)).toEqual({
      actor: "user",
      source: "managed_browser",
    });
  });

  it("waits for the native source stop before shutdown completes", async () => {
    const { applications, coordinator } = harness();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(applications, "subscribe").mockImplementation(() => () => pending);
    coordinator.start();
    const stop = coordinator.stop();
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await flushQueue();
    expect(stopped).toBe(false);
    finish();
    await stop;
    expect(stopped).toBe(true);
  });
});

describe("fine-grained Activity capture", () => {
  it("records same-app content changes and bounds a synchronous input flood before persistence", async () => {
    const fixture = harness();
    fixture.coordinator.start();
    fixture.setActiveApplication({
      appName: "Editor",
      windowTitle: "draft.md",
      boundary: "application",
    });
    await flushQueue();
    for (let index = 0; index < 10_000; index += 1)
      fixture.setActiveApplication({
        appName: "Editor",
        windowTitle: "draft.md",
        boundary: "interaction",
        content: {
          source: "accessibility",
          scope: "focused_element",
          text: `Document revision ${String(index)}`,
        },
        interaction: { clicks: 0, keystrokes: 1, scrolls: 0 },
      });
    await flushQueue();
    expect(fixture.started).toHaveLength(2);
    expect(fixture.observations.at(-1)).toMatchObject({
      content: { text: "Document revision 9999" },
      interaction: { keystrokes: 10_000 },
    });
    await fixture.coordinator.stop();
    fixture.setActiveApplication({ appName: "Editor", windowTitle: "late.md" });
    await flushQueue();
    expect(fixture.started).toHaveLength(2);
  });

  it("records lifecycle facts as system events without replacing the foreground", async () => {
    const fixture = harness();
    fixture.coordinator.start();
    fixture.setActiveApplication({
      appName: "Editor",
      windowTitle: "draft.md",
    });
    await flushQueue();
    fixture.setActiveApplication({
      appName: "Browser",
      lifecycle: "launched",
      boundary: "application",
    });
    fixture.setActiveApplication({
      appName: "Browser",
      lifecycle: "terminated",
      boundary: "application",
    });
    await flushQueue();
    expect(fixture.recorded).toEqual([
      { actor: "system", source: "active_app" },
      { actor: "system", source: "active_app" },
    ]);
    expect(fixture.observations).toHaveLength(1);
    await fixture.coordinator.stop();
  });

  it("keeps delayed native Agent observations attributed to the Agent", async () => {
    const fixture = harness();
    fixture.coordinator.start();
    fixture.setActiveApplication({
      actor: "agent",
      appName: "Editor",
      boundary: "interaction",
      interaction: { clicks: 2, keystrokes: 50, scrolls: 0 },
    });
    await flushQueue();
    expect(fixture.started).toEqual([{ actor: "agent", source: "active_app" }]);
    expect(fixture.observations).toEqual([
      expect.objectContaining({ actor: "agent" }),
    ]);
    await fixture.coordinator.stop();
  });

  it("records changed DOM content at the same URL and only forwards user activity", async () => {
    const fixture = harness();
    await fixture.coordinator.observeBrowser({
      actor: "user",
      url: "https://example.com/docs",
      content: { source: "dom", scope: "viewport", text: "First section" },
      boundary: "content",
    });
    await fixture.coordinator.observeBrowser({
      actor: "user",
      url: "https://example.com/docs",
      content: { source: "dom", scope: "viewport", text: "Second section" },
      boundary: "content",
    });
    await fixture.coordinator.observeBrowser({
      actor: "system",
      url: "https://example.com/docs",
      content: { source: "dom", scope: "viewport", text: "Automatic refresh" },
      boundary: "content",
    });
    expect(fixture.recorded).toHaveLength(3);
    expect(fixture.observations).toHaveLength(2);
    expect(fixture.observations.at(-1)).toMatchObject({
      content: { text: "Second section" },
    });
    await fixture.coordinator.stop();
  });
});

it("keeps delayed Agent content as Agent across an idle sampling tick", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const fixture = harness();
    fixture.coordinator.start();
    fixture.setActiveApplication({
      actor: "agent",
      appName: "Editor",
      boundary: "content",
      content: {
        source: "accessibility",
        scope: "focused_element",
        text: "Agent-generated text",
      },
    });
    await flushQueue();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushQueue();
    expect(fixture.observations).toEqual([
      expect.objectContaining({ actor: "agent" }),
    ]);
    expect(fixture.started).toEqual([{ actor: "agent", source: "active_app" }]);
    await fixture.coordinator.stop();
    expect(vi.getTimerCount()).toBe(0);
    await fixture.coordinator.observeBrowser({
      actor: "user",
      url: "https://example.com/late",
    });
    expect(fixture.recorded).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

describe("unattributed source continuity", () => {
  it("does not let a running UI tool override explicit user or unknown browser provenance", async () => {
    const fixture = harness();
    fixture.coordinator.observeRun(
      toolEnvelope("item.started", "computer.click"),
    );
    await fixture.coordinator.observeBrowser({
      actor: "user",
      url: "https://example.com/same",
    });
    await fixture.coordinator.observeBrowser({
      url: "https://example.com/same",
    });
    expect(fixture.recorded).toEqual([
      { actor: "user", source: "managed_browser" },
      { actor: "unknown", source: "managed_browser" },
    ]);
  });

  it("preserves native collection time and separates input origin buckets", async () => {
    const fixture = harness();
    fixture.coordinator.start();
    const observedAt = "2026-08-08T09:59:59.123Z";
    fixture.setActiveApplication({
      appName: "Fixture",
      observedAt,
      boundary: "interaction",
      inputOrigin: "hid_reported",
      interaction: { clicks: 1, keystrokes: 0, scrolls: 0 },
    });
    fixture.setActiveApplication({
      appName: "Fixture",
      observedAt,
      boundary: "interaction",
      inputOrigin: "synthetic_reported",
      interaction: { clicks: 0, keystrokes: 2, scrolls: 0 },
    });
    await flushQueue();
    expect(fixture.startEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        inputOrigin: "hid_reported",
        interaction: { clicks: 1, keystrokes: 0, scrolls: 0 },
      }),
      "unknown",
      observedAt,
    );
    expect(fixture.startEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        inputOrigin: "synthetic_reported",
        interaction: { clicks: 0, keystrokes: 2, scrolls: 0 },
      }),
      "unknown",
      observedAt,
    );
    expect(
      fixture.observations.every((event) => event.observedAt === observedAt),
    ).toBe(true);
    await fixture.coordinator.stop();
  });

  it("does not replay cached foreground content after pause or treat launch as foreground", async () => {
    const fixture = harness();
    fixture.coordinator.start();
    fixture.setActiveApplication({ appName: "Old fixture" });
    await flushQueue();
    fixture.setPaused(true);
    await flushQueue();
    fixture.setPaused(false);
    await flushQueue();
    expect(fixture.observations).toHaveLength(1);
    fixture.setActiveApplication({
      appName: "Background fixture",
      lifecycle: "launched",
      observedAt: "2026-08-08T09:59:59.000Z",
    });
    await flushQueue();
    expect(fixture.recordEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: "launched" }),
      "system",
      "2026-08-08T09:59:59.000Z",
    );
    expect(fixture.observations).toHaveLength(1);
    fixture.setActiveApplication({ appName: "Current fixture" });
    await flushQueue();
    expect(fixture.observations.at(-1)?.appName).toBe("Current fixture");
    await fixture.coordinator.stop();
  });
});
