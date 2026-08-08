import type { RunExecution } from "../../shared/contracts/run";
import type { ToolDescriptor } from "../../shared/contracts/tool";

export function requiresApproval(
  execution: RunExecution,
  descriptor: ToolDescriptor,
): boolean {
  if (execution.mode === "chat" || descriptor.effect === "read") return false;
  if (execution.approvalMode === "full_access") return false;
  if (execution.approvalMode === "auto_approve") {
    return descriptor.effect === "critical";
  }
  return true;
}
