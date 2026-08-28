import { Type } from "@sinclair/typebox";

import type { JsonValue } from "../../shared/contracts/primitives";
import type {
  TerritoryCandidateMutationResult,
  TerritoryCreateChangeCandidateRequest,
} from "../../shared/contracts/territoryWorld";
import type { ToolResult } from "../../shared/contracts/tool";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import type { TerritoryWorldCandidateService } from "./territoryWorldCandidateService";
import type { TerritoryWorldService } from "./territoryWorldService";

const TerritoryGenerateItemToolInputSchema = Type.Object(
  {
    description: Type.String({
      description:
        "One or two concise, poetic user-visible sentences grounded in what is actually known. Use concrete sensory imagery; do not include image prompts, model/provider terms, dimensions, internal IDs, or invent facts about the user.",
      minLength: 1,
      pattern: "\\S",
    }),
    name: Type.String({
      description: "Short user-visible object name.",
      minLength: 1,
      pattern: "\\S",
    }),
    visualPrompt: Type.String({
      description: "Appearance, material, light and recognizable silhouette.",
      minLength: 1,
      pattern: "\\S",
    }),
  },
  { additionalProperties: false },
);

interface TerritoryToolDependencies {
  readonly candidates: Pick<TerritoryWorldCandidateService, "create">;
  readonly territory: Pick<TerritoryWorldService, "getSnapshot">;
}

function summarizeInput(input: Readonly<Record<string, JsonValue>>): string {
  const name = input["name"];
  return typeof name === "string" && name.trim()
    ? `生成领地物件候选“${name.trim()}”`
    : "生成领地物件候选";
}

function failedResult(
  generated: TerritoryCandidateMutationResult,
): ToolResult | undefined {
  const candidate = generated.snapshot.candidates.find(
    ({ id }) => id === generated.candidateId,
  );
  if (!candidate) throw new Error("Generated Territory candidate is missing");
  if (candidate.status !== "failed") return undefined;
  const error = candidate.error ?? {
    code: "TERRITORY.IMAGE_PROCESSING_FAILED",
    message: "领地图片生成失败，请在 Territory 中重试。",
    retryable: true,
  };
  return {
    artifacts: [],
    error,
    modelContent: {
      candidateId: candidate.id,
      error,
      retryAvailableInTerritory: error.retryable,
      status: "failed",
    },
    retryable: error.retryable,
    status: error.retryable ? "error" : "needs_input",
    summary: `领地候选生成失败：${error.message}`,
  };
}

export function registerTerritoryTools(
  registry: ToolRegistry,
  dependencies: TerritoryToolDependencies,
): void {
  registry.register({
    descriptor: {
      description:
        "Generate one editable transparent 2.5D object as a Territory World candidate. Supply a short user-visible name and one or two poetic, sensory story sentences separately from the visualPrompt. Keep the story faithful to known evidence; never expose prompts, model/provider terms, dimensions, or internal IDs, and never infer user preferences from observed Activity. The current Zone and its Style Profile are frozen automatically. The current World is never changed until the user reviews and applies the candidate in Territory.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: TerritoryGenerateItemToolInputSchema,
      itemKind: "tool_call",
      name: "territory.generate_item",
      namespace: "territory",
      source: "builtin",
      summary: "生成可编辑领地物件候选",
    },
    execute: async (input, context) => {
      const request = parseSchema(TerritoryGenerateItemToolInputSchema, input);
      const snapshot = dependencies.territory.getSnapshot();
      const candidateRequest: TerritoryCreateChangeCandidateRequest = {
        baseRevisionId: snapshot.world.currentRevision.id,
        intent: "item",
        itemContent: {
          description: request.description.trim(),
          name: request.name.trim(),
        },
        lockedInstanceIds: [],
        prompt: `${request.name.trim()}：${request.visualPrompt.trim()}`,
        providerProfileId: context.providerProfileId ?? null,
        scope: { kind: "zone", zoneId: snapshot.world.activeZoneId },
        sources: [],
      };
      context.onDelta(`正在生成“${request.name.trim()}”的领地预览…`);
      const generated = await dependencies.candidates.create(
        candidateRequest,
        context.signal,
      );
      const failed = failedResult(generated);
      if (failed) return failed;
      const candidate = generated.snapshot.candidates.find(
        ({ id }) => id === generated.candidateId,
      );
      if (!candidate || candidate.status !== "ready" || !candidate.changeSet) {
        throw new Error("Unexpected Territory candidate state");
      }
      const definition = candidate.changeSet.mutations.find(
        (mutation) => mutation.kind === "definition.put",
      );
      return {
        artifacts: [],
        modelContent: {
          candidateId: candidate.id,
          name:
            definition?.kind === "definition.put"
              ? definition.definition.name
              : request.name.trim(),
          nextAction: "Ask the user to review and apply it in Territory.",
          previewGroups: candidate.previewGroups,
          status: "awaiting_confirmation",
        },
        retryable: false,
        status: "success",
        summary: `“${request.name.trim()}”预览已生成，等待确认`,
      };
    },
    summarize: summarizeInput,
  });
}
