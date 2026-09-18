import { estimateInputBudget } from "../providers/inputBudget";
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  ModelContextLimits,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../agent/modelProvider";
import type { ProviderService } from "../providers/providerService";
import { ProviderError } from "../providers/providerError";
import { CryptoIdGenerator } from "../../shared/pure/id";
import {
  FIXTURE_IDS,
  messageFixture,
  providerSnapshotFixture,
  runFixture,
  runItemFixture,
} from "../../../tests/fixtures/foundationContracts";
import {
  EvolutionReviewSkippedError,
  ModelEvolutionReviewer,
  type EvolutionReviewEvidence,
} from "./evolutionReviewer";

class TextQueueProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: string[]) {}

  measureInput(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    return Promise.resolve(this.estimateInput(request));
  }
  estimateInput(request: ModelRequest) {
    return estimateInputBudget(request, request.modelId);
  }

  resolveContextLimits(): Promise<ModelContextLimits> {
    return Promise.resolve({});
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    await Promise.resolve();
    signal.throwIfAborted();
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No model response remains");
    yield { delta: response, type: "text.delta" };
    yield {
      responseId: `response-${String(this.requests.length)}`,
      status: "completed",
      type: "response.completed",
      usage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 10 },
    };
  }
}

function reviewerFor(provider: ModelProvider): ModelEvolutionReviewer {
  const providers = {
    createChatModelRuntime: () =>
      Promise.resolve({ provider, snapshot: providerSnapshotFixture }),
  } as unknown as ProviderService;
  return new ModelEvolutionReviewer(providers, new CryptoIdGenerator());
}

function evidence(): EvolutionReviewEvidence {
  return {
    items: [
      {
        ...runItemFixture,
        displayOutput: "构建与校验全部通过",
        endedAt: runItemFixture.startedAt,
        status: "completed",
      },
    ],
    loadedSkillContents: [],
    messages: [
      {
        ...messageFixture,
        content: "以后按这套发布流程做，请记住。",
      },
    ],
    run: {
      ...runFixture,
      endedAt: runFixture.startedAt,
      status: "completed",
    },
    skills: [],
    triggers: ["explicit_teaching", "verified_success"],
  };
}

const skillMarkdown = `---
name: release-flow
description: Run the verified release workflow.
---

# Workflow

1. Build.
2. Verify.
`;

const patchMarkdown = skillMarkdown.replace(
  "2. Verify.",
  "2. Verify and smoke test.",
);
const skillSha256 = createHash("sha256").update(skillMarkdown).digest("hex");

function evidenceWithLoadedSkill(): EvolutionReviewEvidence {
  const descriptor = {
    archived: false,
    contentSha256: skillSha256,
    description: "Run the verified release workflow.",
    enabled: true,
    id: "user:release-flow",
    lifecycle: "active" as const,
    name: "release-flow",
    patchCount: 0,
    pinned: false,
    readOnly: false,
    revision: 3,
    source: "user" as const,
    successCount: 2,
    useCount: 2,
  };
  return {
    ...evidence(),
    loadedSkillContents: [{ content: skillMarkdown, descriptor }],
    skills: [descriptor],
  };
}

describe("ModelEvolutionReviewer", () => {
  it("uses a configured Chat runtime for Voice evidence instead of the Realtime deployment", async () => {
    const provider = new TextQueueProvider([
      JSON.stringify({ candidates: [] }),
    ]);
    const createChatModelRuntime = vi.fn(() =>
      Promise.resolve({
        provider,
        snapshot: { ...providerSnapshotFixture, modelId: "chat-model" },
      }),
    );
    const getDefaultChatProfileId = vi.fn(() => "chat-profile");
    const providers = {
      createChatModelRuntime,
      getDefaultChatProfileId,
    } as unknown as ProviderService;
    const voiceEvidence: EvolutionReviewEvidence = {
      ...evidence(),
      run: {
        ...evidence().run,
        provider: {
          ...evidence().run.provider,
          modelId: "gpt-realtime-2.1",
        },
        source: "voice",
      },
    };

    await expect(
      new ModelEvolutionReviewer(providers, new CryptoIdGenerator()).review(
        voiceEvidence,
        new AbortController().signal,
      ),
    ).resolves.toEqual([]);
    expect(getDefaultChatProfileId).toHaveBeenCalledOnce();
    expect(createChatModelRuntime).toHaveBeenCalledWith("chat-profile");
    expect(createChatModelRuntime).not.toHaveBeenCalledWith(
      voiceEvidence.run.provider.profileId,
      "gpt-realtime-2.1",
    );
    expect(provider.requests[0]?.modelId).toBe("chat-model");
  });

  it("marks Voice Review as unavailable before any Provider call when no Chat Model is configured", async () => {
    const createChatModelRuntime = vi.fn();
    const providers = {
      createChatModelRuntime,
      getDefaultChatProfileId: () => {
        throw new ProviderError(
          "PROVIDER.INVALID_CONFIGURATION",
          "请先配置一个可用的 Chat Provider 与模型。",
          false,
        );
      },
    } as unknown as ProviderService;
    const voiceEvidence: EvolutionReviewEvidence = {
      ...evidence(),
      run: { ...evidence().run, source: "voice" },
    };

    await expect(
      new ModelEvolutionReviewer(providers, new CryptoIdGenerator()).review(
        voiceEvidence,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(EvolutionReviewSkippedError);
    expect(createChatModelRuntime).not.toHaveBeenCalled();
  });

  it("uses one tool-free structured review call and grounds the candidate", async () => {
    const provider = new TextQueueProvider([
      JSON.stringify({
        candidates: [
          {
            evidence: ["构建与校验全部通过"],
            proposal: {
              content: skillMarkdown,
              kind: "new_skill",
              name: "release-flow",
            },
            rationale: "客观验证过的可复用流程",
            replayCases: [
              {
                expectedOutcome: "执行发布流程",
                input: "正式发布",
                scope: "in_scope",
              },
              {
                expectedOutcome: "不执行发布流程",
                input: "本地单元测试",
                scope: "out_of_scope",
              },
            ],
            sourceItemIds: [FIXTURE_IDS.item],
          },
        ],
      }),
    ]);

    const candidates = await reviewerFor(provider).review(
      evidence(),
      new AbortController().signal,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      proposal: { kind: "new_skill", name: "release-flow" },
      sourceItemIds: [FIXTURE_IDS.item],
    });
    expect(candidates[0]?.replayCases.map(({ scope }) => scope)).toEqual([
      "in_scope",
      "out_of_scope",
    ]);
    expect(
      candidates[0]?.replayCases.every(({ id }) => typeof id === "string"),
    ).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.toolNamespaces).toEqual([]);
    expect(provider.requests[0]?.structuredOutput).toMatchObject({
      name: "charamate_evolution_review",
      schema: {
        additionalProperties: false,
        required: ["candidates"],
        type: "object",
      },
    });
    expect(provider.requests[0]?.instructions).toContain('"memoryType"');
    expect(provider.requests[0]?.instructions).toContain('"claimSlot"');
    expect(provider.requests[0]?.instructions).toContain(
      "successful memory.record",
    );
    expect(provider.requests[0]).not.toHaveProperty("maxOutputTokens");
  });

  it("rejects unknown evidence IDs and malformed Skill documents", async () => {
    const unknownItemProvider = new TextQueueProvider([
      JSON.stringify({
        candidates: [
          {
            evidence: ["构建与校验全部通过"],
            proposal: {
              content: skillMarkdown,
              kind: "new_skill",
              name: "release-flow",
            },
            rationale: "unsupported source",
            replayCases: [
              {
                expectedOutcome: "yes",
                input: "release",
                scope: "in_scope",
              },
              {
                expectedOutcome: "no",
                input: "test",
                scope: "out_of_scope",
              },
            ],
            sourceItemIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
          },
        ],
      }),
    ]);
    await expect(
      reviewerFor(unknownItemProvider).review(
        evidence(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("unknown Run Item");

    const malformedSkillProvider = new TextQueueProvider([
      JSON.stringify({
        candidates: [
          {
            evidence: ["构建与校验全部通过"],
            proposal: {
              content: "# Missing frontmatter",
              kind: "new_skill",
              name: "release-flow",
            },
            rationale: "invalid document",
            replayCases: [
              {
                expectedOutcome: "yes",
                input: "release",
                scope: "in_scope",
              },
              {
                expectedOutcome: "no",
                input: "test",
                scope: "out_of_scope",
              },
            ],
            sourceItemIds: [FIXTURE_IDS.item],
          },
        ],
      }),
    ]);
    await expect(
      reviewerFor(malformedSkillProvider).review(
        evidence(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("YAML frontmatter");
  });

  it("binds a patch to the exact loaded Skill revision", async () => {
    const candidate = (targetContentSha256: string) =>
      JSON.stringify({
        candidates: [
          {
            evidence: ["构建与校验全部通过"],
            proposal: {
              content: patchMarkdown,
              kind: "skill_patch",
              name: "release-flow",
              targetContentSha256,
              targetRevision: 3,
              targetSkillId: "user:release-flow",
            },
            rationale: "已验证流程需要补充冒烟测试",
            replayCases: [
              {
                expectedOutcome: "执行完整发布流程",
                input: "正式发布",
                scope: "in_scope",
              },
              {
                expectedOutcome: "不执行发布流程",
                input: "只跑单元测试",
                scope: "out_of_scope",
              },
            ],
            sourceItemIds: [FIXTURE_IDS.item],
          },
        ],
      });
    const validProvider = new TextQueueProvider([candidate(skillSha256)]);
    await expect(
      reviewerFor(validProvider).review(
        evidenceWithLoadedSkill(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject([
      {
        proposal: {
          kind: "skill_patch",
          targetContentSha256: skillSha256,
          targetRevision: 3,
          targetSkillId: "user:release-flow",
        },
      },
    ]);

    const staleProvider = new TextQueueProvider([candidate("0".repeat(64))]);
    await expect(
      reviewerFor(staleProvider).review(
        evidenceWithLoadedSkill(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("unavailable or protected");

    const racedProvider = new TextQueueProvider([candidate(skillSha256)]);
    const racedEvidence = evidenceWithLoadedSkill();
    await expect(
      reviewerFor(racedProvider).review(
        {
          ...racedEvidence,
          loadedSkillContents: racedEvidence.loadedSkillContents.map(
            ({ descriptor }) => ({ content: patchMarkdown, descriptor }),
          ),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("unavailable or protected");
  });

  it("fails replay when the model omits a case", async () => {
    const provider = new TextQueueProvider([
      JSON.stringify({
        results: [
          {
            actualOutcome: "执行发布流程",
            caseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            passed: true,
          },
        ],
      }),
    ]);
    const result = await reviewerFor(provider).replay(
      {
        proposal: {
          content: skillMarkdown,
          kind: "new_skill",
          name: "release-flow",
        },
        replayCases: [
          {
            expectedOutcome: "执行发布流程",
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            input: "正式发布",
            scope: "in_scope",
          },
          {
            expectedOutcome: "不执行发布流程",
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            input: "本地单元测试",
            scope: "out_of_scope",
          },
        ],
      },
      { ...runFixture, status: "completed" },
      new AbortController().signal,
    );
    expect(result).toEqual({
      failureReason: "Replay 返回的 case 不完整。",
      passed: false,
    });
    expect(provider.requests[0]?.structuredOutput).toMatchObject({
      name: "charamate_evolution_replay",
      schema: {
        additionalProperties: false,
        required: ["results"],
        type: "object",
      },
    });
  });

  it("fails replay when the model duplicates a case", async () => {
    const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const provider = new TextQueueProvider([
      JSON.stringify({
        results: [
          { actualOutcome: "执行发布流程", caseId: firstId, passed: true },
          {
            actualOutcome: "不执行发布流程",
            caseId: secondId,
            passed: true,
          },
          { actualOutcome: "重复结果", caseId: firstId, passed: true },
        ],
      }),
    ]);
    const result = await reviewerFor(provider).replay(
      {
        proposal: {
          content: skillMarkdown,
          kind: "new_skill",
          name: "release-flow",
        },
        replayCases: [
          {
            expectedOutcome: "执行发布流程",
            id: firstId,
            input: "正式发布",
            scope: "in_scope",
          },
          {
            expectedOutcome: "不执行发布流程",
            id: secondId,
            input: "本地单元测试",
            scope: "out_of_scope",
          },
        ],
      },
      { ...runFixture, status: "completed" },
      new AbortController().signal,
    );
    expect(result).toEqual({
      failureReason: "Replay 返回的 case 不完整。",
      passed: false,
    });
  });
});
