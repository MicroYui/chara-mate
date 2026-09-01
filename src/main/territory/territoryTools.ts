import { Type } from "@sinclair/typebox";

import type { JsonValue } from "../../shared/contracts/primitives";
import type {
  TerritoryCandidateMutationResult,
  TerritoryCreateChangeCandidateRequest,
  TerritoryPerformPetActionRequest,
} from "../../shared/contracts/territoryWorld";
import type { ToolResult } from "../../shared/contracts/tool";
import {
  TerritoryEmptyRequestSchema,
  TerritoryPerformPetActionRequestSchema,
} from "../../shared/schemas/territoryWorld";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toTerritoryAppError } from "./territoryError";
import type { TerritoryWorldCandidateService } from "./territoryWorldCandidateService";
import type { TerritoryWorldService } from "./territoryWorldService";

export const TERRITORY_OBSERVE_TOOL_NAME = "territory.observe";
export const TERRITORY_ACT_TOOL_NAME = "territory.act";

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
  readonly territory: Pick<
    TerritoryWorldService,
    "getSnapshot" | "observePetActions" | "performPetAction"
  >;
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

function actionLabel(
  action: TerritoryPerformPetActionRequest["action"],
): string {
  const labels: Record<TerritoryPerformPetActionRequest["action"], string> = {
    move: "移动",
    observe: "观察",
    react: "回应",
    sit: "坐下",
    sleep: "睡下",
  };
  return labels[action];
}

function actionFailure(error: unknown): ToolResult {
  const appError = toTerritoryAppError(error);
  return {
    artifacts: [],
    error: appError,
    modelContent: {
      error: appError,
      nextAction:
        appError.code === "TERRITORY.REVISION_CONFLICT"
          ? `Call ${TERRITORY_OBSERVE_TOOL_NAME} again before choosing another action.`
          : "Use the reported Territory result; do not claim that the action succeeded.",
      status: "failed",
    },
    retryable: appError.retryable,
    status: "error",
    summary: `领地动作未完成：${appError.message}`,
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

  registry.register({
    descriptor: {
      description:
        "Read the current active Territory zone before choosing a pet action. Returns the current World revision, pet state, and compact typed affordances for reachable and unreachable objects. Call this only when the user asks about or invites an in-world Territory action; do not use it for ordinary conversation.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: TerritoryEmptyRequestSchema,
      itemKind: "tool_call",
      name: TERRITORY_OBSERVE_TOOL_NAME,
      namespace: "territory",
      source: "builtin",
      summary: "观察当前领地与可行动作",
    },
    execute: (input) => {
      parseSchema(TerritoryEmptyRequestSchema, input);
      try {
        const observation = dependencies.territory.observePetActions();
        return Promise.resolve({
          artifacts: [],
          modelContent: observation,
          retryable: false,
          status: "success",
          summary: `已观察「${observation.zone.name}」的 ${String(observation.targets.length)} 个可互动目标`,
        });
      } catch (error) {
        return Promise.resolve(actionFailure(error));
      }
    },
    summarize: () => "观察当前领地",
  });

  registry.register({
    descriptor: {
      description: `Perform one explicit pet action in the active Territory using a revision and target returned by ${TERRITORY_OBSERVE_TOOL_NAME}. For sit, sleep, observe, or react, pass the object directly: the host action already includes walking to it, so never call move first. The Territory host validates the current revision, capability, collision and exact reachable path; report success only from this Tool result.`,
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: TerritoryPerformPetActionRequestSchema,
      itemKind: "tool_call",
      name: TERRITORY_ACT_TOOL_NAME,
      namespace: "territory",
      source: "builtin",
      summary: "让角色在领地中行动",
    },
    execute: (input, context) => {
      const request = parseSchema(
        TerritoryPerformPetActionRequestSchema,
        input,
      );
      context.onDelta(`正在领地中${actionLabel(request.action)}…`);
      try {
        const performed = dependencies.territory.performPetAction(request);
        return Promise.resolve({
          artifacts: [],
          modelContent: {
            action: performed.action,
            destination: performed.snapshot.pet.point,
            petBehavior: performed.snapshot.pet.behavior,
            revisionId: performed.snapshot.world.currentRevision.id,
            status: "performed",
            targetInstanceId: performed.targetInstanceId,
          },
          retryable: false,
          status: "success",
          summary: `角色已在领地中${actionLabel(request.action)}`,
        });
      } catch (error) {
        return Promise.resolve(actionFailure(error));
      }
    },
    summarize: (input) => {
      const action = input["action"];
      return typeof action === "string" &&
        ["move", "observe", "sit", "sleep", "react"].includes(action)
        ? `领地动作：${action}`
        : "执行领地动作";
    },
  });
}
