import { describe, expect, it, vi } from "vitest";

import {
  MacOsActiveApplicationSource,
  normalizeActiveApplicationEvent,
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
      { appName: "Editor" },
      { appName: "Browser" },
    ]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("辅助功能权限");

    await stop();
    await stop();
    expect(nativeStop).toHaveBeenCalledOnce();
  });
});
