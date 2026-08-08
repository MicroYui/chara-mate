import type { JsonValue } from "../../shared/contracts/primitives";
import type { PlanUpdate } from "../../shared/contracts/run";
import { PlanUpdateSchema } from "../../shared/schemas/run";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";

function parseUpdate(input: Readonly<Record<string, JsonValue>>): PlanUpdate {
  const update = parseSchema(PlanUpdateSchema, input);
  if (update.plan.filter(({ status }) => status === "in_progress").length > 1) {
    throw new TypeError("A plan may contain at most one in_progress step");
  }
  return update;
}

export function registerPlanTool(registry: ToolRegistry): void {
  registry.register({
    descriptor: {
      description:
        "Always-available core Tool that creates or replaces the user-visible plan for non-trivial Agent work. Call it directly before other work, send the complete current plan on every update, keep at most one step in_progress, and do not substitute a prose checklist.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: PlanUpdateSchema,
      itemKind: "plan",
      name: "plan.update",
      namespace: "plan",
      source: "builtin",
      summary: "更新当前计划",
    },
    execute: (input) => {
      const update = parseUpdate(input);
      const modelContent: JsonValue = update;
      return Promise.resolve({
        artifacts: [],
        evidenceHash: toolEvidenceHash(modelContent),
        modelContent,
        retryable: false,
        status: "success",
        summary: "计划已更新",
      });
    },
    summarize: (input) => {
      const plan = input["plan"];
      return `更新当前计划${Array.isArray(plan) ? `（${String(plan.length)} 步）` : ""}`;
    },
  });
}
