import { Type } from "@sinclair/typebox";

import type { JsonValue } from "../../shared/contracts/primitives";
import type {
  TerritoryCandidateMutationResult,
  TerritoryCreateChangeCandidateRequest,
  TerritoryPetActionObservation,
  TerritoryPerformPetActionRequest,
} from "../../shared/contracts/territoryWorld";
import type { ToolResult } from "../../shared/contracts/tool";
import {
  TerritoryEmptyRequestSchema,
  TerritoryPerformPetActionRequestSchema,
} from "../../shared/schemas/territoryWorld";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import type { RunRepository } from "../agent/runRepository";
import { TerritoryError, toTerritoryAppError } from "./territoryError";
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
  readonly candidates: Pick<
    TerritoryWorldCandidateService,
    "createAutonomousItem"
  >;
  readonly runs: Pick<
    RunRepository,
    "getRun" | "getRunItem" | "latestUserMessageId"
  >;
  readonly territory: Pick<
    TerritoryWorldService,
    "getSnapshot" | "observePetActions" | "performPetAction"
  >;
}

function observationModelContent(observation: TerritoryPetActionObservation) {
  // Adjacent instances may share a tile definition and layout dimensions.
  // Keep every instance and its order while sending those identical fields once.
  const { nodes, ...context } = observation;
  const projected = nodes.map(
    ({ instanceId, definition, content, placement, layout }) => {
      const { point, ...sharedPlacement } =
        placement.kind === "zone"
          ? placement
          : { ...placement, point: undefined };
      const { rootInstanceId, rootGridPoint, originPx, ...sharedLayout } =
        layout.status === "available"
          ? layout
          : {
              ...layout,
              rootInstanceId: undefined,
              rootGridPoint: undefined,
              originPx: undefined,
            };
      return {
        shared: {
          definition,
          content,
          placement: sharedPlacement,
          layout: sharedLayout,
        },
        node: {
          instanceId,
          placement: point === undefined ? {} : { point },
          layout:
            rootInstanceId === undefined
              ? {}
              : { rootInstanceId, rootGridPoint, originPx },
        },
      };
    },
  );
  const nodeGroups: {
    shared: (typeof projected)[number]["shared"];
    nodes: (typeof projected)[number]["node"][];
  }[] = [];
  let previousShared: string | undefined;
  for (const { shared, node } of projected) {
    const key = JSON.stringify(shared);
    const previous = nodeGroups.at(-1);
    if (previous && key === previousShared) previous.nodes.push(node);
    else nodeGroups.push({ shared, nodes: [node] });
    previousShared = key;
  }
  return { ...context, nodeGroups };
}

function summarizeInput(input: Readonly<Record<string, JsonValue>>): string {
  const name = input["name"];
  return typeof name === "string" && name.trim()
    ? `生成领地物件“${name.trim()}”`
    : "生成领地物件";
}

export function territoryCreationToolResult(
  generated: TerritoryCandidateMutationResult,
): ToolResult {
  const candidate = generated.snapshot.candidates.find(
    ({ id }) => id === generated.candidateId,
  );
  if (!candidate)
    throw new TerritoryError(
      "TERRITORY.CANDIDATE_NOT_FOUND",
      "没有找到这次创作的结果。",
      false,
    );
  if (
    candidate.status === "applied" &&
    candidate.changeSet &&
    candidate.appliedRevisionId
  ) {
    const definition = candidate.changeSet.mutations.find(
      (mutation) => mutation.kind === "definition.put",
    );
    const instance = candidate.changeSet.mutations.find(
      (mutation) => mutation.kind === "instance.put",
    );
    if (
      definition?.kind !== "definition.put" ||
      instance?.kind !== "instance.put"
    ) {
      throw new TerritoryError(
        "TERRITORY.CHANGESET_INVALID",
        "创作结果缺少物件。",
        false,
      );
    }
    const inCollection = instance.instance.placement.kind === "collection";
    const worldRevisionChangedSinceCreation =
      generated.snapshot.world.currentRevision.id !==
      candidate.appliedRevisionId;
    return {
      artifacts: [],
      modelContent: {
        candidateId: candidate.id,
        worldRevisionChangedSinceCreation,
        instanceId: instance.instance.id,
        name: definition.definition.name,
        placement: worldRevisionChangedSinceCreation
          ? null
          : instance.instance.placement,
        revisionId: candidate.appliedRevisionId,
        status: "applied",
        nextAction: worldRevisionChangedSinceCreation
          ? "This is the result of an earlier completed creation. The World has changed since then, so the current placement is unknown. Do not create it again; observe the current Territory before describing where it is."
          : inCollection
            ? "The object was created and saved in the collection because no placement was available. Do not claim it is in the room."
            : "The object was created and placed. Describe only the actual result if useful to the conversation.",
      },
      retryable: false,
      status: "success",
      summary: worldRevisionChangedSinceCreation
        ? `“${definition.definition.name}”此前已完成，领地后来有了新变化`
        : `“${definition.definition.name}”已${inCollection ? "放入收藏" : "放进领地"}`,
    };
  }
  const error = candidate.error ?? {
    code:
      candidate.status === "stale"
        ? "TERRITORY.REVISION_CONFLICT"
        : "TERRITORY.INVALID_CANDIDATE_STATE",
    message:
      candidate.status === "stale"
        ? "领地已有新变化，这次创作没有应用。"
        : candidate.status === "cancelled"
          ? "这次领地创作已取消。"
          : "这次创作还没有应用到领地。",
    retryable: false,
  };
  return {
    artifacts: [],
    error,
    modelContent: {
      candidateId: candidate.id,
      error,
      status: candidate.status,
      retryAvailableInTerritory: error.retryable,
      nextAction:
        "Continue the conversation using the actual result. Do not claim the World changed or automatically retry a stale, cancelled, or failed creation.",
    },
    retryable: false,
    status: candidate.status === "cancelled" ? "cancelled" : "error",
    summary: error.message,
  };
}

export function territoryCreationFailure(
  error: unknown,
  signal?: AbortSignal,
): ToolResult {
  if (signal?.aborted) {
    return {
      artifacts: [],
      modelContent: {
        status: "cancelled",
        nextAction:
          "This creation was cancelled. Do not claim it succeeded or automatically retry it.",
      },
      retryable: false,
      status: "cancelled",
      summary: "这次领地创作已取消。",
    };
  }
  const appError = toTerritoryAppError(error);
  return {
    artifacts: [],
    error: appError,
    modelContent: {
      error: appError,
      status: "failed",
      nextAction:
        "Continue the conversation without claiming the creation succeeded.",
    },
    retryable: false,
    status: "error",
    summary: `领地创作未完成：${appError.message}`,
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
        "Create one new editable transparent 2.5D object in the Territory during this Run, either for the user or as your own creative activity. Supply a short user-visible name and one or two poetic, sensory story sentences separately from the visualPrompt. Keep the story faithful to known evidence; never expose prompts, model/provider terms, dimensions, or internal IDs, and never infer user preferences from observed Activity. The current Zone and its Style Profile are frozen automatically. When the source and current World revision remain valid, the host places the new object automatically or saves it to the collection if there is no space. It never moves or replaces existing content. Wait for the actual result before describing it as created. Use the Territory editor Preview for large changes.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: TerritoryGenerateItemToolInputSchema,
      itemKind: "tool_call",
      name: "territory.generate_item",
      namespace: "territory",
      source: "builtin",
      summary: "创作领地小物件",
    },
    execute: async (input, context) => {
      const request = parseSchema(TerritoryGenerateItemToolInputSchema, input);
      context.signal.throwIfAborted();
      const run = dependencies.runs.getRun(context.runId);
      const item = dependencies.runs.getRunItem(context.itemId);
      if (
        !run ||
        run.status !== "running" ||
        !item ||
        item.runId !== run.id ||
        item.kind !== "tool_call" ||
        item.status !== "running"
      ) {
        return territoryCreationFailure(
          new TerritoryError(
            "TERRITORY.SOURCE_NOT_FOUND",
            "这次创作没有有效的运行来源。",
            false,
          ),
        );
      }
      const sourceMessageId = dependencies.runs.latestUserMessageId(
        run.id,
        item.sequence,
      );
      const assertSourceValid = () => {
        const current = dependencies.runs.getRun(context.runId);
        if (
          !current ||
          current.status !== "running" ||
          current.persona.personaId !== run.persona.personaId ||
          current.persona.revision !== run.persona.revision ||
          dependencies.runs.latestUserMessageId(run.id) !== sourceMessageId
        ) {
          throw new TerritoryError(
            "TERRITORY.SOURCE_NOT_FOUND",
            "这次创作的运行来源已失效。",
            false,
          );
        }
      };
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
        sources: [
          {
            id: context.itemId,
            kind: "character_creation",
            label: request.name.trim(),
            occurredAt: run.startedAt ?? run.createdAt,
            personaRef: {
              personaId: run.persona.personaId,
              revision: run.persona.revision,
            },
            runId: run.id,
          },
        ],
      };
      context.onDelta(`正在创作“${request.name.trim()}”…`);
      try {
        return territoryCreationToolResult(
          await dependencies.candidates.createAutonomousItem(
            candidateRequest,
            assertSourceValid,
            context.signal,
          ),
        );
      } catch (error) {
        return territoryCreationFailure(error, context.signal);
      }
    },
    summarize: summarizeInput,
  });

  registry.register({
    descriptor: {
      description:
        "Read the current active Territory zone and its placed display before choosing a pet action. nodeGroups preserve every placed instance in order: each node inherits its group's shared fields; merge the shared and node placement/layout subobjects. Shared content includes the Definition name, description, anchors and visual dimensions. targets refer to the actionable instance IDs. A layout originPx and sizePx describe a rectangle in Zone world pixels, including possible transparent margins, not a screenshot or proof of visibility. rootGridPoint is the placed ancestor grid origin, neither an attachment position nor the pet destination. Unavailable references remain unavailable. Collection items and other zones are outside this observation. Use it when an in-world action or display is relevant to the conversation or your own current activity; do not inspect merely to answer ordinary conversation.",
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
          modelContent: observationModelContent(observation),
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
      context.signal.throwIfAborted();
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
