import { Type, type Static } from "@sinclair/typebox";

import type { CompanionInitiativeSettings } from "../../shared/contracts/settings";
import type { JsonValue } from "../../shared/contracts/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";

export const TERRITORY_MOMENT_SURPRISES_TOOL_NAME =
  "companion.territory_moment_surprises";

const TerritoryMomentSurprisesInputSchema = Type.Object(
  { enabled: Type.Boolean() },
  { additionalProperties: false },
);

type TerritoryMomentSurprisesInput = Static<
  typeof TerritoryMomentSurprisesInputSchema
>;

export interface TerritoryMomentSurprisesSettings {
  getCompanionInitiative(): CompanionInitiativeSettings;
  saveCompanionInitiative(
    value: CompanionInitiativeSettings,
  ): CompanionInitiativeSettings;
}

export function registerTerritoryMomentSurprisesTool(
  registry: ToolRegistry,
  settings: TerritoryMomentSurprisesSettings,
): void {
  registry.register({
    descriptor: {
      description:
        "Persist the user's explicit category-level choice about whether CharaMate may occasionally prepare one Territory preview inspired by a clearly significant shared moment. Call enabled=true only after the user directly agrees to that specific permission or explicitly asks to turn it on. Call enabled=false when the user declines, revokes, or asks to turn it off. Never infer consent from an attachment, an important event, or permission for proactive messages. This only permits preparing a preview; it never changes the Territory until the user applies it.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: TerritoryMomentSurprisesInputSchema,
      itemKind: "tool_call",
      name: TERRITORY_MOMENT_SURPRISES_TOOL_NAME,
      namespace: "companion",
      source: "builtin",
      summary: "更新重要时刻领地惊喜许可",
    },
    execute: (input) => {
      const request: TerritoryMomentSurprisesInput = parseSchema(
        TerritoryMomentSurprisesInputSchema,
        input,
      );
      const current = settings.getCompanionInitiative();
      const saved = settings.saveCompanionInitiative({
        ...current,
        territoryMomentSurprisesEnabled: request.enabled,
        territoryMomentSurprisesPrompted: true,
      });
      const modelContent = {
        enabled: saved.territoryMomentSurprisesEnabled,
      } satisfies JsonValue;
      return Promise.resolve({
        artifacts: [],
        evidenceHash: toolEvidenceHash(modelContent),
        modelContent,
        retryable: false,
        status: "success" as const,
        summary: request.enabled
          ? "已允许准备重要时刻领地惊喜"
          : "已关闭重要时刻领地惊喜",
      });
    },
    summarize: (input) =>
      input["enabled"] === true
        ? "允许准备重要时刻领地惊喜"
        : "关闭重要时刻领地惊喜",
  });
}
