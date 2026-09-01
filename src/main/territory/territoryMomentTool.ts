import { Type, type Static } from "@sinclair/typebox";

import type { CompanionInitiativeSettings } from "../../shared/contracts/settings";
import type { JsonValue } from "../../shared/contracts/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";

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
): void {
  registry.register({
    descriptor: {
      description:
        "Propose at most one optional Territory preview for an unusually meaningful current exchange when the supplied Territory surprise setting is enabled. Ground the name and short experiential description in the current user message, actual attachment content, and supplied memory only. visualPrompt describes an open-ended object, plant, light, small environmental detail, or other fitting Territory expression; do not force a polaroid, trophy, souvenir, rarity, or fixed template. Most conversations need no call. This records a proposal only: generation happens after the Run completes and the World never changes until the user applies the preview.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: TerritoryMomentProposalSchema,
      itemKind: "tool_call",
      name: TERRITORY_PROPOSE_MOMENT_TOOL_NAME,
      namespace: "territory",
      source: "builtin",
      summary: "提议重要时刻领地回响",
    },
    execute: (input) => {
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
      const modelContent = {
        accepted: true,
        proposal,
      } satisfies JsonValue;
      return Promise.resolve({
        artifacts: [],
        evidenceHash: toolEvidenceHash(modelContent),
        modelContent,
        retryable: false,
        status: "success" as const,
        summary: `已记录“${proposal.name}”的领地回响提议`,
      });
    },
    summarize: (input) => {
      const name = input["name"];
      return typeof name === "string" && name.trim()
        ? `提议领地回响“${name.trim()}”`
        : "提议重要时刻领地回响";
    },
  });
}
