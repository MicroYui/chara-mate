import type { RunExecution } from "../../shared/contracts/run";
import type { ToolDescriptor } from "../../shared/contracts/tool";
import { VOICE_END_TOOL_NAME } from "../../shared/contracts/voice";
import { MEMORY_FORMATION_TOOL_NAME } from "../memory/memoryTool";
import { COMPANIONSHIP_UPDATE_TOOL_NAME } from "../journey/companionshipTool";
import { IMPORTANT_MOMENT_OUTREACH_TOOL_NAME } from "../journey/importantMomentOutreachTool";
import { TERRITORY_MOMENT_SURPRISES_TOOL_NAME } from "../journey/territoryMomentSurprisesTool";
import { TERRITORY_PROPOSE_MOMENT_TOOL_NAME } from "../territory/territoryMomentTool";
import { COLLABORATION_DISPATCH_TOOL_NAME } from "./collaborationTool";

export const CHAT_INTERNAL_TOOL_NAMES = new Set([
  MEMORY_FORMATION_TOOL_NAME,
  COMPANIONSHIP_UPDATE_TOOL_NAME,
  IMPORTANT_MOMENT_OUTREACH_TOOL_NAME,
  TERRITORY_MOMENT_SURPRISES_TOOL_NAME,
  TERRITORY_PROPOSE_MOMENT_TOOL_NAME,
  "companion.life",
  "territory.act",
  "territory.generate_item",
]);

export function toolAllowedInExecution(
  execution: RunExecution,
  descriptor: ToolDescriptor,
): boolean {
  if (descriptor.name === VOICE_END_TOOL_NAME) return false;
  if (descriptor.name === COLLABORATION_DISPATCH_TOOL_NAME) {
    return execution.mode === "agent";
  }
  return (
    CHAT_INTERNAL_TOOL_NAMES.has(descriptor.name) ||
    execution.mode === "agent" ||
    (descriptor.effect === "read" && descriptor.idempotency === "idempotent")
  );
}

export function requiresApproval(
  execution: RunExecution,
  descriptor: ToolDescriptor,
): boolean {
  if (descriptor.name === VOICE_END_TOOL_NAME) return false;
  if (CHAT_INTERNAL_TOOL_NAMES.has(descriptor.name)) return false;
  if (execution.mode === "chat" || descriptor.effect === "read") return false;
  if (execution.approvalMode === "full_access") return false;
  if (execution.approvalMode === "auto_approve") {
    return descriptor.effect === "critical";
  }
  return true;
}
