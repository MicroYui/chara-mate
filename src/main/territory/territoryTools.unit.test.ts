import { describe, expect, it, vi } from "vitest";

import type { TerritoryImageCandidate } from "../../shared/contracts/territory";
import { ToolRegistry } from "../tools/toolRegistry";
import { ProviderError } from "../providers/providerError";
import { registerTerritoryTools } from "./territoryTools";

const candidate: TerritoryImageCandidate = {
  acceptedItemId: null,
  createdAt: "2026-08-08T10:00:00.000Z",
  description: "留一盏灯，纪念完成项目的夜晚。",
  editInstruction: null,
  error: null,
  id: "5bc2c1bc-3dbe-49cd-964d-e0f60891f501",
  name: "长夜台灯",
  operation: "generate",
  providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
  sceneId: "forest-cabin",
  sourceCandidateId: null,
  status: "ready",
  structure: null,
  updatedAt: "2026-08-08T10:01:00.000Z",
  visualPrompt: "一盏小巧的黄铜工坊台灯",
};

function snapshot(active = true, imageCandidate = candidate) {
  return {
    activeScene: active
      ? { definition: { id: "forest-cabin" as const } }
      : null,
    imageCandidates: [imageCandidate],
  };
}

function executionContext() {
  return {
    itemId: "tool-item",
    onDelta: vi.fn(),
    providerProfileId: "chat-profile",
    runId: "run",
    signal: new AbortController().signal,
  };
}

describe("Territory Agent Tool", () => {
  it("resolves scene and image profile while keeping model input semantic", async () => {
    const registry = new ToolRegistry();
    const generate = vi.fn().mockResolvedValue({
      candidateId: candidate.id,
      snapshot: snapshot(),
    });
    const resolveImageProfileId = vi.fn().mockReturnValue("image-profile");
    registerTerritoryTools(registry, {
      images: { generate },
      providers: { resolveImageProfileId },
      territory: { getSnapshot: () => snapshot() },
    });
    const context = executionContext();

    const result = await registry.execute(
      "territory.generate_item",
      {
        description: candidate.description,
        name: candidate.name,
        visualPrompt: candidate.visualPrompt,
      },
      context,
    );

    expect(resolveImageProfileId).toHaveBeenCalledWith("chat-profile");
    expect(generate).toHaveBeenCalledWith(
      {
        description: candidate.description,
        name: candidate.name,
        providerProfileId: "image-profile",
        sceneId: "forest-cabin",
        visualPrompt: candidate.visualPrompt,
      },
      context.signal,
    );
    expect(context.onDelta).toHaveBeenCalledWith(
      "正在生成“长夜台灯”的领地预览…",
    );
    expect(result).toMatchObject({
      modelContent: {
        candidateId: candidate.id,
        status: "awaiting_confirmation",
        structure: {
          placement: {
            footprintTiles: { height: 2, width: 2 },
            kind: "ground_object",
          },
          slotCount: 0,
          visualSizePx: { height: 96, width: 96 },
        },
      },
      status: "success",
    });
    expect(
      registry.search("generate a Territory decoration from a memory")[0]
        ?.descriptor.name,
    ).toBe("territory.generate_item");
  });

  it("asks for the product-owned prerequisites instead of model IDs", async () => {
    const registry = new ToolRegistry();
    const generate = vi.fn();
    registerTerritoryTools(registry, {
      images: { generate },
      providers: {
        resolveImageProfileId: () => {
          throw new ProviderError(
            "PROVIDER.INVALID_CONFIGURATION",
            "请先配置 Azure Image Provider。",
            false,
          );
        },
      },
      territory: { getSnapshot: () => snapshot(false) },
    });

    const result = await registry.execute(
      "territory.generate_item",
      {
        description: candidate.description,
        name: candidate.name,
        visualPrompt: candidate.visualPrompt,
      },
      executionContext(),
    );

    expect(result).toMatchObject({
      error: { code: "TERRITORY.SCENE_NOT_ACTIVE" },
      status: "needs_input",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns a persisted failed candidate with its retry signal", async () => {
    const registry = new ToolRegistry();
    const failedCandidate: TerritoryImageCandidate = {
      ...candidate,
      error: {
        code: "PROVIDER.RATE_LIMITED",
        message: "Provider 暂时限制了请求，请稍后重试。",
        retryable: true,
      },
      status: "failed",
    };
    registerTerritoryTools(registry, {
      images: {
        generate: vi.fn().mockResolvedValue({
          candidateId: failedCandidate.id,
          snapshot: snapshot(true, failedCandidate),
        }),
      },
      providers: { resolveImageProfileId: () => "image-profile" },
      territory: { getSnapshot: () => snapshot() },
    });

    const result = await registry.execute(
      "territory.generate_item",
      {
        description: candidate.description,
        name: candidate.name,
        visualPrompt: candidate.visualPrompt,
      },
      executionContext(),
    );

    expect(result).toMatchObject({
      modelContent: {
        candidateId: failedCandidate.id,
        retryAvailableInTerritory: true,
        status: "failed",
      },
      retryable: true,
      status: "error",
    });
  });
});
