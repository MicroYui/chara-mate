import type { RunExecution } from "../../shared/contracts/run";
import type { ToolDescriptor } from "../../shared/contracts/tool";
import { MEMORY_FORMATION_TOOL_NAME } from "../memory/memoryTool";

export function toolAllowedInExecution(
  execution: RunExecution,
  descriptor: ToolDescriptor,
): boolean {
  return (
    descriptor.name === MEMORY_FORMATION_TOOL_NAME ||
    execution.mode === "agent" ||
    (descriptor.effect === "read" && descriptor.idempotency === "idempotent")
  );
}

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
