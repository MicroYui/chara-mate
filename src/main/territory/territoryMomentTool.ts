import { Type, type Static } from "@sinclair/typebox";

import type { CompanionInitiativeSettings } from "../../shared/contracts/settings";
import type { JsonValue } from "../../shared/contracts/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import type { TerritoryMomentService } from "./territoryMomentService";
import {
  territoryCreationFailure,
  territoryCreationToolResult,
} from "./territoryTools";

export const TERRITORY_PROPOSE_MOMENT_TOOL_NAME = "territory.propose_moment";

export const TerritoryMomentProposalSchema = Type.Object(
  {
    description: Type.String({ minLength: 1, pattern: "\\S" }),
    name: Type.String({ minLength: 1, pattern: "\\S" }),
    visualPrompt: Type.String({ minLength: 1, pattern: "\\S" }),
  },
  { additionalProperties: false },
);

export type TerritoryMomentProposal = Static<
  typeof TerritoryMomentProposalSchema
>;

export function parseTerritoryMomentProposal(
  input: Readonly<Record<string, JsonValue>>,
): TerritoryMomentProposal {
  const proposal = parseSchema(TerritoryMomentProposalSchema, input);
  return {
    description: proposal.description.trim(),
    name: proposal.name.trim(),
    visualPrompt: proposal.visualPrompt.trim(),
  };
}

export function registerTerritoryMomentTool(
  registry: ToolRegistry,
  settings: { getCompanionInitiative(): CompanionInitiativeSettings },
  moments: Pick<TerritoryMomentService, "createForRun">,
): void {
  registry.register({
    descriptor: {
      description:
        "Create at most one new Territory object for an unusually meaningful current exchange when the supplied Territory surprise setting is enabled. Ground the name and short experiential description in the current user message, actual attachment content, and supplied memory only. visualPrompt describes an open-ended object, plant, light, small environmental detail, or other fitting Territory expression; do not force a polaroid, trophy, souvenir, rarity, or fixed template. Most conversations need no call. This waits for real image generation in the current Run. The host places the object automatically or saves it in the collection only while the original World revision, sources and permission remain valid. Report only the actual result; failures must not interrupt your ordinary reply. Your own invented activities are not user chat moments; use territory.generate_item for your own creative work.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: TerritoryMomentProposalSchema,
      itemKind: "tool_call",
      name: TERRITORY_PROPOSE_MOMENT_TOOL_NAME,
      namespace: "territory",
      source: "builtin",
      summary: "为共同经历创作小物件",
    },
    execute: async (input, context) => {
      const proposal = parseTerritoryMomentProposal(input);
      if (!settings.getCompanionInitiative().territoryMomentSurprisesEnabled) {
        return Promise.resolve({
          artifacts: [],
          modelContent: {
            accepted: false,
            reason: "territory_moment_surprises_disabled",
          },
          retryable: false,
          status: "rejected" as const,
          summary: "未获得准备领地惊喜的许可",
        });
      }
      context.onDelta(`正在为这段经历创作“${proposal.name}”…`);
      try {
        return territoryCreationToolResult(
          await moments.createForRun(
            context.runId,
            context.itemId,
            proposal,
            context.signal,
          ),
        );
      } catch (error) {
        return territoryCreationFailure(error, context.signal);
      }
    },
    summarize: (input) => {
      const name = input["name"];
      return typeof name === "string" && name.trim()
        ? `为共同经历创作“${name.trim()}”`
        : "为共同经历创作小物件";
    },
  });
}
