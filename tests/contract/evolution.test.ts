import { describe, expect, it } from "vitest";

import { EVOLUTION_CHANNELS } from "../../src/shared/contracts/evolution";
import {
  EvolutionCandidateSchema,
  EvolutionCandidateUpdateRequestSchema,
  EvolutionChangedEventSchema,
  EvolutionSnapshotResponseSchema,
} from "../../src/shared/schemas/evolution";
import { IpcChannelSchema } from "../../src/shared/schemas/ipc";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";

const candidate = {
  chatId: "00000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-13T00:00:00.000Z",
  evidence: ["用户明确说以后按这个流程"],
  id: "00000000-0000-4000-8000-000000000002",
  kind: "new_skill",
  pinned: false,
  proposal: {
    content:
      "---\nname: release-flow\ndescription: Release workflow.\n---\n\n# Steps",
    kind: "new_skill",
    name: "release-flow",
  },
  rationale: "明确教学且可复用",
  replayCases: [
    {
      expectedOutcome: "执行发布步骤",
      id: "00000000-0000-4000-8000-000000000003",
      input: "正式发布",
      scope: "in_scope",
    },
    {
      expectedOutcome: "不执行发布步骤",
      id: "00000000-0000-4000-8000-000000000004",
      input: "本地测试",
      scope: "out_of_scope",
    },
  ],
  replayResult: { status: "pending" },
  reviewId: "00000000-0000-4000-8000-000000000005",
  sourceItemIds: ["00000000-0000-4000-8000-000000000006"],
  sourceRunIds: ["00000000-0000-4000-8000-000000000007"],
  status: "draft",
  updatedAt: "2026-08-13T00:00:00.000Z",
} as const;

describe("Evolution boundary contracts", () => {
  for (const parser of [parseSchema, parseSchemaWithoutCodeGeneration]) {
    it(`round-trips candidates through ${parser.name}`, () => {
      expect(parser(EvolutionCandidateSchema, candidate)).toEqual(candidate);
      expect(
        parser(EvolutionSnapshotResponseSchema, {
          ok: true,
          value: { candidates: [candidate], reviews: [] },
        }),
      ).toEqual({
        ok: true,
        value: { candidates: [candidate], reviews: [] },
      });
      expect(
        parser(EvolutionChangedEventSchema, {
          candidate,
          type: "candidate.changed",
        }),
      ).toEqual({ candidate, type: "candidate.changed" });
    });

    it(`rejects source-code evolution through ${parser.name}`, () => {
      expect(() =>
        parser(EvolutionCandidateUpdateRequestSchema, {
          candidateId: candidate.id,
          proposal: {
            content: "rewrite src/main/index.ts",
            kind: "source_code",
          },
          rationale: "expand scope",
          replayCases: [],
        }),
      ).toThrow();
    });

    it(`requires an exact base revision for Skill patches through ${parser.name}`, () => {
      const request = {
        candidateId: candidate.id,
        proposal: {
          content: candidate.proposal.content,
          kind: "skill_patch",
          name: "release-flow",
          targetContentSha256: "0".repeat(64),
          targetRevision: 2,
          targetSkillId: "user:release-flow",
        },
        rationale: "patch current workflow",
        replayCases: candidate.replayCases,
      } as const;
      expect(parser(EvolutionCandidateUpdateRequestSchema, request)).toEqual(
        request,
      );
      const { targetRevision, ...withoutRevision } = request.proposal;
      void targetRevision;
      expect(() =>
        parser(EvolutionCandidateUpdateRequestSchema, {
          ...request,
          proposal: withoutRevision,
        }),
      ).toThrow();
    });
  }

  it("keeps every Evolution IPC channel narrow and namespaced", () => {
    for (const channel of Object.values(EVOLUTION_CHANNELS)) {
      expect(parseSchema(IpcChannelSchema, channel)).toBe(channel);
    }
  });
});
