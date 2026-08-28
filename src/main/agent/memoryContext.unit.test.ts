import { describe, expect, it } from "vitest";

import type { MemoryHit } from "../../shared/contracts/memory";
import {
  createMemoryContextInput,
  materializeMemoryContextInput,
  memoryContextQueryTargetIds,
  memoryContextTargetIds,
} from "./memoryContext";

const NOW = "2026-08-27T12:00:00.000Z";

function hit(input: {
  readonly claimSlot?: MemoryHit["memory"]["claimSlot"];
  readonly content: string;
  readonly memoryId: string;
  readonly revisionId: string;
  readonly type: MemoryHit["memory"]["type"];
}): MemoryHit {
  return {
    memory: {
      ...(input.claimSlot ? { claimSlot: input.claimSlot } : {}),
      confidence: 1,
      createdAt: NOW,
      currentRevisionId: input.revisionId,
      id: input.memoryId,
      importance: 0.8,
      status: "active",
      type: input.type,
      updatedAt: NOW,
    },
    rank: 1,
    revision: {
      content: input.content,
      createdAt: NOW,
      id: input.revisionId,
      memoryId: input.memoryId,
      reason: "用户明确说明",
      sourceIds: [],
      sourceType: "user_edit",
    },
    sources: [
      {
        createdAt: NOW,
        id: input.memoryId.replace(/^1/u, "3"),
        label: "用户消息中的完整来源标签不应进入模型上下文",
        referenceId: input.memoryId.replace(/^1/u, "4"),
        type: "chat",
      },
    ],
  };
}

describe("Memory context", () => {
  it("separates stable claims from query matches and preserves one allowlist", () => {
    const profile = hit({
      claimSlot: "preference.hobbies",
      content: "用户喜欢玩 CS2。",
      memoryId: "10000000-0000-4000-8000-000000000001",
      revisionId: "20000000-0000-4000-8000-000000000001",
      type: "preference",
    });
    const project = hit({
      content: "Lantern 项目使用 Electron。",
      memoryId: "10000000-0000-4000-8000-000000000002",
      revisionId: "20000000-0000-4000-8000-000000000002",
      type: "project",
    });
    const context = createMemoryContextInput({
      legacyUnkeyedCount: 2,
      queryMatches: [project],
      queryRelevantMemoryIds: [project.memory.id],
      stableProfile: [profile],
    });
    const materialized = materializeMemoryContextInput(context);
    const visible = JSON.stringify(materialized);

    expect(materialized).toMatchObject({ role: "developer", type: "message" });
    expect(visible).toContain("Stable active profile and preference claims");
    expect(visible).toContain("R0 query-matched memories");
    expect(visible).toContain("2 active legacy profile/preference record(s)");
    expect(visible).toContain("stableClaimSlot: preference.hobbies");
    expect(visible).toContain("evidence: 1 source record(s); types: chat");
    expect(visible).toContain("用户喜欢玩 CS2。");
    expect(visible).not.toContain(profile.memory.id);
    expect(visible).not.toContain(profile.revision.id);
    expect(visible).not.toContain(profile.sources[0]?.id);
    expect(visible).not.toContain(profile.sources[0]?.referenceId);
    expect(visible).not.toContain("完整来源标签");
    expect(JSON.stringify(context)).toContain(profile.memory.id);
    expect(memoryContextTargetIds(context)).toEqual([
      profile.memory.id,
      project.memory.id,
    ]);
    expect(memoryContextQueryTargetIds(context)).toEqual([project.memory.id]);
  });
});
