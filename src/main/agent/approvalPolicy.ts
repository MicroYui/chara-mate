import type { RunExecution } from "../../shared/contracts/run";
import type { ToolDescriptor } from "../../shared/contracts/tool";
import { VOICE_END_TOOL_NAME } from "../../shared/contracts/voice";
import { MEMORY_FORMATION_TOOL_NAME } from "../memory/memoryTool";
import { COMPANIONSHIP_UPDATE_TOOL_NAME } from "../journey/companionshipTool";
import { IMPORTANT_MOMENT_OUTREACH_TOOL_NAME } from "../journey/importantMomentOutreachTool";
import { COLLABORATION_DISPATCH_TOOL_NAME } from "./collaborationTool";

export function toolAllowedInExecution(
  execution: RunExecution,
  descriptor: ToolDescriptor,
): boolean {
  if (descriptor.name === VOICE_END_TOOL_NAME) return false;
  if (descriptor.name === COLLABORATION_DISPATCH_TOOL_NAME) {
    return execution.mode === "agent";
  }
  return (
    descriptor.name === MEMORY_FORMATION_TOOL_NAME ||
    descriptor.name === COMPANIONSHIP_UPDATE_TOOL_NAME ||
    descriptor.name === IMPORTANT_MOMENT_OUTREACH_TOOL_NAME ||
    execution.mode === "agent" ||
    (descriptor.effect === "read" && descriptor.idempotency === "idempotent")
  );
}

export function requiresApproval(
  execution: RunExecution,
  descriptor: ToolDescriptor,
): boolean {
  if (descriptor.name === VOICE_END_TOOL_NAME) return false;
  if (
    descriptor.name === MEMORY_FORMATION_TOOL_NAME ||
    descriptor.name === COMPANIONSHIP_UPDATE_TOOL_NAME ||
    descriptor.name === IMPORTANT_MOMENT_OUTREACH_TOOL_NAME
  ) {
    return false;
  }
  if (execution.mode === "chat" || descriptor.effect === "read") return false;
  if (execution.approvalMode === "full_access") return false;
  if (execution.approvalMode === "auto_approve") {
    return descriptor.effect === "critical";
  }
  return true;
}
