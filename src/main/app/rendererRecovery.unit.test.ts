import { describe, expect, it } from "vitest";

import { shouldRecoverRenderer } from "./rendererRecovery";

describe("Renderer recovery policy", () => {
  it.each([
    "abnormal-exit",
    "crashed",
    "killed",
    "memory-eviction",
    "oom",
  ] as const)("reloads after a recoverable %s", (reason) => {
    expect(shouldRecoverRenderer(reason)).toBe(true);
  });

  it.each(["clean-exit", "integrity-failure", "launch-failed"] as const)(
    "does not loop on a non-recoverable %s",
    (reason) => {
      expect(shouldRecoverRenderer(reason)).toBe(false);
    },
  );
});
