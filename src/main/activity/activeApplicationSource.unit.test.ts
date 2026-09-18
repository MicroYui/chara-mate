import { visualFrameFixture } from "./activityVisual.fixture";

import { describe, expect, it, vi } from "vitest";

import {
  MacOsActiveApplicationSource,
  normalizeActiveApplicationEvent,
  normalizeActivityPerception,
  type NativeActiveApplicationObserver,
} from "./activeApplicationSource";

describe("active application native boundary", () => {
  it("normalizes and redacts a bounded native payload", () => {
    expect(
      normalizeActiveApplicationEvent({
        accessibilityStatus: "available",
        appId: "com.example.editor",
        appName: "Editor",
        windowTitle: "draft.md",
      }),
    ).toEqual({
      accessibilityStatus: "available",
      application: {
        actor: "unknown",
        appId: "com.example.editor",
        appName: "Editor",
        windowTitle: "draft.md",
      },
    });
  });

  it("rejects malformed, nameless, or unbounded payloads", () => {
    expect(normalizeActiveApplicationEvent("not-an-object")).toBeUndefined();
    expect(
      normalizeActiveApplicationEvent({
        accessibilityStatus: "available",
        windowTitle: "draft.md",
      }),
    ).toBeUndefined();
    expect(
      normalizeActiveApplicationEvent({
        accessibilityStatus: "available",
        appName: "x".repeat(17 * 1024),
      }),
    ).toBeUndefined();
  });

  it("loads the in-process addon, reports permission state once, and stops idempotently", async () => {
    let nativeListener: ((event: unknown) => void) | undefined;
    const nativeStop = vi.fn();
    const loadAddon = vi.fn((): NativeActiveApplicationObserver => ({
      subscribeVisualChanges: () => () => undefined,
      pullVisual: vi.fn(() => Promise.resolve(undefined)),
      redactVisual: vi.fn((bytes: Buffer) => Promise.resolve(bytes)),
      setPaused: vi.fn(),
      stopVisual: vi.fn(() => Promise.resolve(undefined)),
      subscribe(listener) {
        nativeListener = listener;
        return nativeStop;
      },
    }));
    const applications: unknown[] = [];
    const errors: unknown[] = [];
    const source = new MacOsActiveApplicationSource("/observer.node", {
      loadAddon,
      platform: "darwin",
    });

    const stop = source.subscribe(
      (application) => applications.push(application),
      (error) => errors.push(error),
    );
    nativeListener?.({
      accessibilityStatus: "permission_required",
      appName: "Editor",
    });
    nativeListener?.({
      accessibilityStatus: "permission_required",
      appName: "Browser",
    });

    expect(loadAddon).toHaveBeenCalledWith("/observer.node");
    expect(applications).toEqual([
      { actor: "unknown", appName: "Editor" },
      { actor: "unknown", appName: "Browser" },
    ]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("辅助功能权限");

    await stop();
    await stop();
    expect(nativeStop).toHaveBeenCalledOnce();
  });
});

describe("native visual cancellation", () => {
  it("applies a saved pause before native subscribe can start first-use capture", async () => {
    const order: string[] = [];
    const source = new MacOsActiveApplicationSource("/synthetic.node", {
      platform: "darwin",
      loadAddon: () => ({
        subscribe: () => {
          order.push("subscribe");
          return () => undefined;
        },
        subscribeVisualChanges: () => () => undefined,
        setPaused: (paused) => order.push(`paused:${String(paused)}`),
        pullVisual: () => Promise.resolve(undefined),
        redactVisual: (bytes: Buffer) => Promise.resolve(bytes),
        stopVisual: () => Promise.resolve(),
      }),
    });
    source.setPaused(true);
    const stop = source.subscribe(vi.fn(), vi.fn());
    expect(order).toEqual(["paused:true", "subscribe"]);
    await stop();
  });

  it("drops a delayed raw frame after pause and shares the stop completion", async () => {
    let resolve!: (raw: unknown) => void;
    const raw = new Promise<unknown>((done) => {
      resolve = done;
    });
    const source = new MacOsActiveApplicationSource("/synthetic.node", {
      platform: "darwin",
      loadAddon: () => ({
        subscribe: () => () => undefined,
        subscribeVisualChanges: () => () => undefined,
        setPaused: vi.fn(),
        pullVisual: () => raw,
        redactVisual: (bytes: Buffer) => Promise.resolve(bytes),
        stopVisual: () => Promise.resolve(),
      }),
    });
    const stop = source.subscribe(vi.fn(), vi.fn());
    const pending = source.pullVisual();
    source.setPaused(true);
    resolve(await visualFrameFixture());
    expect(await pending).toBeUndefined();
    const first = stop();
    expect(stop()).toBe(first);
    await first;
  });
});

describe("fine-grained native observations", () => {
  it("keeps aggregate operation categories while excluding protected content", () => {
    const result = normalizeActiveApplicationEvent({
      accessibilityStatus: "available",
      appName: "Editor",
      boundary: "interaction",
      contentStatus: "protected",
      content: {
        source: "accessibility",
        scope: "focused_element",
        text: "synthetic-password",
      },
      interaction: { clicks: 2, keystrokes: 200, scrolls: 3 },
    });
    expect(result?.application).toMatchObject({
      contentStatus: "protected",
      interaction: { clicks: 2, keystrokes: 200, scrolls: 3 },
    });
    expect(result?.application.content).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("synthetic-password");
  });

  it("preserves partial AX content, lifecycle and actor, with existing credential redaction", () => {
    const result = normalizeActiveApplicationEvent({
      accessibilityStatus: "available",
      appName: "Editor",
      actor: "agent",
      lifecycle: "activated",
      boundary: "content",
      contentStatus: "available",
      content: {
        source: "accessibility",
        scope: "focused_element",
        text: "Draft section: access_token=synthetic-token",
      },
    });
    expect(result?.application).toMatchObject({
      actor: "agent",
      lifecycle: "activated",
      boundary: "content",
      content: { source: "accessibility", scope: "focused_element" },
    });
    expect(result?.application.content?.text).not.toContain("synthetic-token");
  });

  it("ignores late native callbacks after stopping", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const nativeStop = vi.fn();
    const source = new MacOsActiveApplicationSource("/synthetic.node", {
      platform: "darwin",
      loadAddon: () => ({
        subscribeVisualChanges: () => () => undefined,
        pullVisual: vi.fn(() => Promise.resolve(undefined)),
        redactVisual: vi.fn((bytes: Buffer) => Promise.resolve(bytes)),
        setPaused: vi.fn(),
        stopVisual: vi.fn(() => Promise.resolve(undefined)),
        subscribe(callback) {
          listener = callback;
          return nativeStop;
        },
      }),
    });
    const received = vi.fn();
    const stop = source.subscribe(received, vi.fn());
    await stop();
    listener?.({ accessibilityStatus: "available", appName: "Editor" });
    expect(received).not.toHaveBeenCalled();
    expect(nativeStop).toHaveBeenCalledOnce();
  });
});

describe("source lifecycle and provenance", () => {
  it("preserves collection time and origin without asserting a human actor", () => {
    const application = normalizeActiveApplicationEvent({
      appName: "Fixture",
      accessibilityStatus: "available",
      observedAt: "2026-09-16T04:00:00.123Z",
      inputOrigin: "hid_reported",
      interaction: { clicks: 1, keystrokes: 0, scrolls: 0 },
    })?.application;
    expect(application).toMatchObject({
      actor: "unknown",
      inputOrigin: "hid_reported",
      observedAt: "2026-09-16T04:00:00.123Z",
    });
    expect(
      normalizeActiveApplicationEvent({
        appName: "Fixture",
        accessibilityStatus: "available",
        inputOrigin: "hid_reported",
        observedAt: "invalid",
      })?.application,
    ).toEqual({ appName: "Fixture", actor: "unknown" });
  });

  it("drops paused callbacks and does not start visual reads until resumed", async () => {
    let callback: ((value: unknown) => void) | undefined;
    const pullVisual = vi.fn(() => Promise.resolve(undefined));
    const source = new MacOsActiveApplicationSource("/fixture.node", {
      platform: "darwin",
      loadAddon: () => ({
        subscribe: (listener) => {
          callback = listener;
          return () => undefined;
        },
        subscribeVisualChanges: () => () => undefined,
        setPaused: vi.fn(),
        pullVisual,
        redactVisual: (bytes) => Promise.resolve(bytes),
        stopVisual: () => Promise.resolve(undefined),
      }),
    });
    const received = vi.fn();
    const stop = source.subscribe(received, vi.fn());
    source.setPaused(true);
    callback?.({ appName: "Fixture", accessibilityStatus: "available" });
    expect(await source.pullVisual()).toBeUndefined();
    expect(pullVisual).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
    source.setPaused(false);
    callback?.({ appName: "Fixture", accessibilityStatus: "available" });
    expect(received).toHaveBeenCalledOnce();
    await stop();
  });

  it("awaits the AX owner before visual shutdown and shares one stop promise", async () => {
    let resolve!: () => void;
    const owner = new Promise<void>((done) => {
      resolve = done;
    });
    const order: string[] = [];
    const source = new MacOsActiveApplicationSource("/fixture.node", {
      platform: "darwin",
      loadAddon: () => ({
        subscribe: () => () => {
          order.push("stop AX");
          return owner;
        },
        subscribeVisualChanges: () => () => undefined,
        setPaused: vi.fn(),
        pullVisual: () => Promise.resolve(undefined),
        redactVisual: (bytes) => Promise.resolve(bytes),
        stopVisual: () => {
          order.push("stop visual");
          return Promise.resolve();
        },
      }),
    });
    const stop = source.subscribe(vi.fn(), vi.fn());
    const first = stop();
    expect(stop()).toBe(first);
    expect(order).toEqual(["stop AX"]);
    resolve();
    await first;
    expect(order).toEqual(["stop AX", "stop visual"]);
  });
});

describe("observed content coverage", () => {
  it("preserves a long observed document and its final correction without applying the metadata byte limit", () => {
    const text =
      Array.from(
        { length: 300 },
        (_, index) =>
          `第${index + 1}段项目记录：绘图与读书是不同任务，采购预算尚未确认。`,
      ).join("\n") +
      "\n最终更正：总额是1260元，不能沿用前面的1190元。access_token=synthetic-token";
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(16 * 1024);
    const observation = normalizeActivityPerception({
      contentStatus: "available",
      content: { source: "dom", scope: "viewport", text },
    });
    expect(observation.contentStatus).toBe("available");
    expect(observation.content?.text).toContain("最终更正：总额是1260元");
    expect(observation.content?.text).not.toContain("synthetic-token");
    expect(observation.content?.truncated).toBeUndefined();
  });

  it.each([
    undefined,
    { source: "dom", scope: "viewport", text: "   " },
    { source: "unknown", scope: "viewport", text: "真实文字" },
  ])(
    "does not claim available after missing or invalid content is omitted",
    (content) => {
      expect(
        normalizeActivityPerception({ contentStatus: "available", content }),
      ).toEqual({ contentStatus: "unavailable" });
    },
  );

  it("preserves only explicitly reported truncation and keeps protected text absent", () => {
    const content = {
      source: "accessibility",
      scope: "focused_element",
      text: "可见开头",
      truncated: true,
    };
    expect(
      normalizeActivityPerception({ contentStatus: "available", content })
        .content,
    ).toEqual(content);
    expect(
      normalizeActivityPerception({
        contentStatus: "available",
        content: { ...content, truncated: false },
      }).content?.truncated,
    ).toBeUndefined();
    expect(
      normalizeActivityPerception({ contentStatus: "protected", content }),
    ).toEqual({ contentStatus: "protected" });
  });
});
