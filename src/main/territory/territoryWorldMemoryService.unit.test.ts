import { describe, expect, it, vi } from "vitest";

import type { TerritoryCreateChangeCandidateRequest } from "../../shared/contracts/territoryWorld";
import { starterTerritorySnapshot } from "../../../tests/fixtures/territoryWorld";
import { FakeClock } from "../../../tests/fixtures/fakeClock";
import { TerritoryWorldMemoryService } from "./territoryWorldMemoryService";
import type { TerritoryWorldRepository } from "./territoryWorldRepository";
import type {
  TerritoryWorldCandidateJob,
  TerritoryWorldCandidateService,
} from "./territoryWorldCandidateService";

describe("Territory source narratives", () => {
  it("keeps an Activity source compact and separate from the poetic item story", () => {
    const candidateId = "90000000-0000-4000-8000-000000000001";
    const initial = {
      candidateId,
      snapshot: starterTerritorySnapshot,
    };
    let capturedRequest: TerritoryCreateChangeCandidateRequest | undefined;
    const beginCreate = vi.fn(
      (
        request: TerritoryCreateChangeCandidateRequest,
      ): TerritoryWorldCandidateJob => {
        capturedRequest = request;
        return {
          completion: Promise.resolve(initial),
          initial,
        };
      },
    );
    const repository = {
      findInstanceBySource: () => undefined,
      findOpenCandidateBySource: () => undefined,
      getSnapshot: () => starterTerritorySnapshot,
    } as unknown as TerritoryWorldRepository;
    const service = new TerritoryWorldMemoryService(
      repository,
      { get: () => missingMemory(), validateEvidenceReferences: () => [] },
      {
        getDigest: () => ({
          candidateIds: [],
          createdAt: "2026-08-24T00:00:00.000Z",
          evidenceDays: 5,
          episodeIds: ["91000000-0000-4000-8000-000000000001"],
          id: "92000000-0000-4000-8000-000000000001",
          kind: "weekly",
          periodEnd: "2026-08-24T00:00:00.000Z",
          periodStart: "2026-08-17T00:00:00.000Z",
          summary: `iTerm2 160 分钟；${"Visual Studio Code private window title ".repeat(20)}`,
          title: "2026-08-17 起一周趋势",
        }),
      },
      new FakeClock("2026-08-28T08:00:00.000Z"),
      () => "93000000-0000-4000-8000-000000000001",
      { beginCreate } as unknown as TerritoryWorldCandidateService,
    );

    service.beginSourceCandidate({
      source: {
        digestId: "92000000-0000-4000-8000-000000000001",
        kind: "activity_digest",
      },
    });

    if (!capturedRequest) throw new Error("Candidate request was not captured");
    const request = capturedRequest;
    expect(request).toMatchObject({
      itemContent: {
        name: "iTerm2 的流光",
      },
      sources: [
        {
          kind: "activity_digest",
          label: "2026-08-17 起一周趋势",
        },
      ],
    });
    if (!request.itemContent) throw new Error("Item story was not generated");
    expect(request.itemContent.description).toContain("不替你把习惯说成偏爱");
    expect(request.itemContent.description).not.toContain("160");
    expect(request.prompt.length).toBeLessThan(400);
  });
});

function missingMemory(): never {
  throw new Error("Memory should not be read in this test");
}
