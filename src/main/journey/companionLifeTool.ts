import { Type } from "@sinclair/typebox";

import {
  NonBlankStringSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { Run } from "../../shared/contracts/run";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { CompanionLifeService } from "./companionLifeService";

const LifePlanSchema = Type.Object(
  {
    intent: NonBlankStringSchema,
    nextWakeAt: TimestampSchema,
    paused: Type.Boolean(),
  },
  { additionalProperties: false },
);

export function registerCompanionLifeTool(
  registry: ToolRegistry,
  service: CompanionLifeService,
  runs: { getRun(runId: string): Run | undefined },
): void {
  registry.register({
    descriptor: {
      name: "companion.life",
      namespace: "companion",
      source: "builtin",
      summary: "安排自己的日常",
      effect: "write",
      idempotency: "idempotent",
      itemKind: "tool_call",
      inputSchema: LifePlanSchema,
      description:
        "Update the character's current Cognition intention in its virtual home, a strictly future UTC time to reconsider it, and whether autonomous life is paused. This updates the same persistent intent used by attention and decisions; it does not start another scheduler. This is not a user reminder, user's Memory, emotion score or Journey. Pause when the user asks you to stop your own activities; resume when they ask to continue. Choose ordinary coherent next steps yourself, without asking the user to manage each one. An intention never proves an action happened. Never schedule messages, external actions or automations here.",
    },
    execute: (input, context) => {
      const plan = parseSchema(LifePlanSchema, input);
      const run = runs.getRun(context.runId);
      if (!run) throw new Error("The current Run is unavailable.");
      if (run.status !== "running")
        throw new Error("The current Run is no longer running.");
      context.signal.throwIfAborted();
      const saved = service.updatePlan(run.persona, plan, run.id);
      const modelContent = {
        intent: saved.intent,
        paused: saved.paused,
        nextWakeAt: saved.nextWakeAt ?? null,
      };
      return Promise.resolve({
        artifacts: [],
        evidenceHash: toolEvidenceHash(modelContent),
        modelContent,
        retryable: false,
        status: "success" as const,
        summary: saved.paused ? "先歇一会儿" : "已安排自己的日常",
      });
    },
    summarize: () => "安排自己的日常",
  });
}
