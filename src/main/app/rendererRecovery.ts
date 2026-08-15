import type { RenderProcessGoneDetails } from "electron";

const RECOVERABLE_REASONS = new Set<RenderProcessGoneDetails["reason"]>([
  "abnormal-exit",
  "crashed",
  "killed",
  "memory-eviction",
  "oom",
]);

export function shouldRecoverRenderer(
  reason: RenderProcessGoneDetails["reason"],
): boolean {
  return RECOVERABLE_REASONS.has(reason);
}
