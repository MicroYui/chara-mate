import { Type, type Static } from "@sinclair/typebox";

import type { CompanionInitiativeSettings } from "../../shared/contracts/settings";
import type { JsonValue } from "../../shared/contracts/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";

export const IMPORTANT_MOMENT_OUTREACH_TOOL_NAME =
  "companion.important_moment_outreach";

const ImportantMomentOutreachInputSchema = Type.Object(
  {
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

type ImportantMomentOutreachInput = Static<
  typeof ImportantMomentOutreachInputSchema
>;

export interface ImportantMomentOutreachSettings {
  getCompanionInitiative(): CompanionInitiativeSettings;
  saveCompanionInitiative(
    value: CompanionInitiativeSettings,
  ): CompanionInitiativeSettings;
}

export function registerImportantMomentOutreachTool(
  registry: ToolRegistry,
  settings: ImportantMomentOutreachSettings,
): void {
  registry.register({
    descriptor: {
      description:
        "Persist the user's explicit category-level choice about whether CharaMate may sometimes initiate one conversation around clearly stated future important moments. Call enabled=true only after the user directly agrees to that specific permission or explicitly asks to turn it on. Call enabled=false when the user declines, revokes, or asks to turn it off. Never infer consent from mentioning an event, a Journey, silence, or a general preference for companionship. This is not a reminder and does not guarantee a message.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: ImportantMomentOutreachInputSchema,
      itemKind: "tool_call",
      name: IMPORTANT_MOMENT_OUTREACH_TOOL_NAME,
      namespace: "companion",
      source: "builtin",
      summary: "更新重要时刻主动联系许可",
    },
    execute: (input) => {
      const request: ImportantMomentOutreachInput = parseSchema(
        ImportantMomentOutreachInputSchema,
        input,
      );
      const current = settings.getCompanionInitiative();
      const saved = settings.saveCompanionInitiative({
        ...current,
        importantMomentOutreachEnabled: request.enabled,
        importantMomentOutreachPrompted: true,
      });
      const modelContent = {
        enabled: saved.importantMomentOutreachEnabled,
      } satisfies JsonValue;
      return Promise.resolve({
        artifacts: [],
        evidenceHash: toolEvidenceHash(modelContent),
        modelContent,
        retryable: false,
        status: "success" as const,
        summary: request.enabled
          ? "已允许重要时刻主动联系"
          : "已关闭重要时刻主动联系",
      });
    },
    summarize: (input) =>
      input["enabled"] === true
        ? "允许重要时刻主动联系"
        : "关闭重要时刻主动联系",
  });
}
