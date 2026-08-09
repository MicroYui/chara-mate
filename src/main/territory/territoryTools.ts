import { Type } from "@sinclair/typebox";

import type { JsonValue } from "../../shared/contracts/primitives";
import type {
  TerritoryGenerateImageRequest,
  TerritoryImageCandidate,
  TerritorySceneId,
} from "../../shared/contracts/territory";
import type { TerritoryItemManifestV1 } from "../../shared/contracts/territoryItemManifest";
import { TerritoryGeneratedItemStructureSchema } from "../../shared/schemas/territory";
import { parseSchema } from "../../shared/schemas/validation";
import { ProviderError, toProviderAppError } from "../providers/providerError";
import type { ToolResult } from "../../shared/contracts/tool";
import type { ToolRegistry } from "../tools/toolRegistry";
import { TerritoryError } from "./territoryError";
import { createGeneratedTerritoryItemManifest } from "./territoryGeneratedItem";

const TerritoryGenerateItemToolInputSchema = Type.Object(
  {
    description: Type.String({
      description: "Why this item matters in the Territory.",
      minLength: 1,
      pattern: "\\S",
    }),
    name: Type.String({
      description: "Short user-visible item name.",
      minLength: 1,
      pattern: "\\S",
    }),
    structure: Type.Optional(TerritoryGeneratedItemStructureSchema),
    visualPrompt: Type.String({
      description: "Concise appearance and material description.",
      minLength: 1,
      pattern: "\\S",
    }),
  },
  { additionalProperties: false },
);

interface TerritoryToolDependencies {
  readonly images: {
    generate(
      input: TerritoryGenerateImageRequest,
      signal?: AbortSignal,
    ): Promise<{
      readonly candidateId: string;
      readonly snapshot: {
        readonly imageCandidates: readonly TerritoryImageCandidate[];
      };
    }>;
  };
  readonly providers: {
    resolveImageProfileId(preferredProfileId?: string): string;
  };
  readonly territory: {
    getSnapshot(): {
      readonly activeScene: {
        readonly definition: { readonly id: TerritorySceneId };
      } | null;
    };
  };
}

function structuredError(
  error: ProviderError | TerritoryError,
  status: "error" | "needs_input",
): ToolResult {
  const appError =
    error instanceof ProviderError
      ? toProviderAppError(error)
      : {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        };
  return {
    artifacts: [],
    error: appError,
    modelContent: appError,
    retryable: appError.retryable,
    status,
    summary: appError.message,
  };
}

function resolvedStructure(manifest: TerritoryItemManifestV1): JsonValue {
  const placement =
    manifest.placement.mode === "surface"
      ? {
          attachmentAnchorPx: manifest.placement.attachmentAnchorPx,
          kind: "surface",
        }
      : {
          depthAnchorPx: manifest.placement.depthAnchorPx,
          footprintTiles: manifest.placement.gridSize,
          kind:
            manifest.placement.plane === "underlay"
              ? "ground_underlay"
              : "ground_object",
        };
  return {
    flippable: manifest.transforms.flippable,
    placement,
    rotations: manifest.transforms.rotations,
    slotCount: manifest.surfaceSlots.length,
    surfaceSlots: manifest.surfaceSlots.map(
      ({ anchorPx, id, maxItemSizePx }) => ({
        anchorPx,
        id,
        maxItemSizePx,
      }),
    ),
    visualSizePx: manifest.visual.sizePx,
  };
}

function summarizeInput(input: Readonly<Record<string, JsonValue>>): string {
  const name = input["name"];
  return typeof name === "string" && name.trim()
    ? `生成领地物件候选“${name.trim()}”`
    : "生成领地物件候选";
}

export function registerTerritoryTools(
  registry: ToolRegistry,
  dependencies: TerritoryToolDependencies,
): void {
  registry.register({
    descriptor: {
      description:
        "Generate one transparent 2.5D Territory item candidate from a name, meaning and visual intent. CharaMate selects the active scene and configured Azure image provider. Optional structure exposes final pixel size, tile footprint, placement, depth or attachment anchor, rotations, flipping, and tabletop slot positions; omit it to use product defaults. The result remains a candidate until the user confirms it in Territory.",
      effect: "write",
      idempotency: "non_idempotent",
      inputSchema: TerritoryGenerateItemToolInputSchema,
      itemKind: "tool_call",
      name: "territory.generate_item",
      namespace: "territory",
      source: "builtin",
      summary: "生成领地物件候选",
    },
    execute: async (input, context) => {
      const request = parseSchema(TerritoryGenerateItemToolInputSchema, input);
      const sceneId =
        dependencies.territory.getSnapshot().activeScene?.definition.id;
      if (!sceneId) {
        return structuredError(
          new TerritoryError(
            "TERRITORY.SCENE_NOT_ACTIVE",
            "请先在 Territory 中选择一个场景。",
            false,
          ),
          "needs_input",
        );
      }

      let providerProfileId: string;
      try {
        providerProfileId = dependencies.providers.resolveImageProfileId(
          context.providerProfileId,
        );
      } catch (error) {
        if (error instanceof ProviderError) {
          return structuredError(
            error,
            error.retryable ? "error" : "needs_input",
          );
        }
        throw error;
      }

      context.onDelta(`正在生成“${request.name.trim()}”的领地预览…`);
      let generated: Awaited<
        ReturnType<TerritoryToolDependencies["images"]["generate"]>
      >;
      try {
        generated = await dependencies.images.generate(
          {
            description: request.description,
            name: request.name,
            providerProfileId,
            sceneId,
            ...(request.structure ? { structure: request.structure } : {}),
            visualPrompt: request.visualPrompt,
          },
          context.signal,
        );
      } catch (error) {
        if (error instanceof ProviderError || error instanceof TerritoryError) {
          return structuredError(error, "error");
        }
        throw error;
      }

      const candidate = generated.snapshot.imageCandidates.find(
        ({ id }) => id === generated.candidateId,
      );
      if (!candidate) {
        throw new Error("Generated Territory candidate is missing");
      }
      if (candidate.status === "failed") {
        const error = candidate.error ?? {
          code: "TERRITORY.IMAGE_PROCESSING_FAILED",
          message: "图片生成失败，请在 Territory 中重试。",
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
          status: "error",
          summary: `“${candidate.name}”生成失败，候选已保留`,
        };
      }
      if (candidate.status !== "ready") {
        throw new Error(
          `Unexpected Territory candidate status: ${candidate.status}`,
        );
      }

      const manifest = createGeneratedTerritoryItemManifest(candidate);
      return {
        artifacts: [],
        modelContent: {
          candidateId: candidate.id,
          name: candidate.name,
          nextAction: "Ask the user to review and confirm it in Territory.",
          status: "awaiting_confirmation",
          structure: resolvedStructure(manifest),
        },
        retryable: false,
        status: "success",
        summary: `“${candidate.name}”预览已生成，等待确认`,
      };
    },
    summarize: summarizeInput,
  });
}
