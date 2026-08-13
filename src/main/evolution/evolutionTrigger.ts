import { createHash } from "node:crypto";

import type { Message } from "../../shared/contracts/chat";
import type { EvolutionTrigger } from "../../shared/contracts/evolution";
import type { RunItem } from "../../shared/contracts/run";

const CORRECTION_PATTERN =
  /(?:\b(?:wrong|incorrect|instead|correct(?:ion)?|must not|do not)\b|不对|不是这样|改成|应该先|不要再|必须先|以后别)/iu;
const TEACHING_PATTERN =
  /(?:\b(?:remember|from now on|learn this|save this workflow|in the future)\b|记住|以后这样|以后按|学会|保存这套流程|每次都|以后用)/iu;
const VERIFICATION_PATTERN =
  /(?:\b(?:pass(?:ed)?|verified|all green|succeeded|checksum matched)\b|验证通过|全部通过|校验成功|结果一致|成功完成)/iu;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function itemToolName(item: RunItem): string | undefined {
  const input = record(item.input);
  for (const name of ["toolName", "name", "command"]) {
    const value = input?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return item.kind === "command" || item.kind === "file_change"
    ? item.kind
    : undefined;
}

function itemText(item: RunItem): string {
  return [item.displayOutput, JSON.stringify(item.output ?? "")]
    .filter(Boolean)
    .join("\n");
}

export interface EvolutionTriggerDecision {
  readonly toolSignature?: string;
  readonly triggers: readonly EvolutionTrigger[];
}

export function evolutionToolSignature(
  items: readonly RunItem[],
): string | undefined {
  const steps = items
    .filter(
      ({ kind, status }) =>
        status === "completed" &&
        (kind === "tool_call" || kind === "command" || kind === "file_change"),
    )
    .map((item) => `${item.kind}:${itemToolName(item) ?? "unknown"}`);
  if (steps.length === 0) return undefined;
  return createHash("sha256").update(steps.join("\n")).digest("hex");
}

export function detectEvolutionTriggers(input: {
  readonly hasPriorToolSignature: (signature: string) => boolean;
  readonly items: readonly RunItem[];
  readonly messages: readonly Message[];
}): EvolutionTriggerDecision {
  const userText = input.messages
    .filter(({ role, status }) => role === "user" && status === "completed")
    .map(({ content }) => content)
    .join("\n");
  const triggers: EvolutionTrigger[] = [];
  if (CORRECTION_PATTERN.test(userText)) triggers.push("explicit_correction");
  if (TEACHING_PATTERN.test(userText)) triggers.push("explicit_teaching");

  const completedEffects = input.items.filter(
    ({ kind, status }) =>
      status === "completed" && (kind === "command" || kind === "file_change"),
  );
  const verified = input.items.some(
    (item) =>
      item.status === "completed" && VERIFICATION_PATTERN.test(itemText(item)),
  );
  if (completedEffects.length > 0 && verified) {
    triggers.push("verified_success");
  }

  const toolSignature = evolutionToolSignature(input.items);
  if (toolSignature && input.hasPriorToolSignature(toolSignature)) {
    triggers.push("repeated_pattern");
  }
  return {
    ...(toolSignature ? { toolSignature } : {}),
    triggers: [...new Set(triggers)],
  };
}
