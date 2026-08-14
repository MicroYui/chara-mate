import { describe, expect, it, vi } from "vitest";

import {
  initializeSingleInstance,
  type SingleInstanceApplication,
} from "./singleInstance";

function fakeApplication(acquired: boolean) {
  let secondInstanceListener: (() => void) | undefined;
  const on = vi.fn((_event: "second-instance", listener: () => void) => {
    secondInstanceListener = listener;
  });
  const quit = vi.fn();
  const application = {
    on,
    quit,
    requestSingleInstanceLock: vi.fn(() => acquired),
  } as unknown as SingleInstanceApplication;
  return {
    application,
    emitSecondInstance: () => secondInstanceListener?.(),
    on,
    quit,
  };
}

describe("initializeSingleInstance", () => {
  it("keeps the primary instance and activates it when another launch arrives", () => {
    const { application, emitSecondInstance, quit } = fakeApplication(true);
    const activatePrimary = vi.fn();

    expect(initializeSingleInstance(application, activatePrimary)).toBe(true);
    expect(quit).not.toHaveBeenCalled();

    emitSecondInstance();
    expect(activatePrimary).toHaveBeenCalledOnce();
  });

  it("quits before startup when another instance already owns the lock", () => {
    const { application, on, quit } = fakeApplication(false);

    expect(initializeSingleInstance(application, vi.fn())).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(on).not.toHaveBeenCalled();
  });
});
