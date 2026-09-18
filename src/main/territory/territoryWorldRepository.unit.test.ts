import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { EntityId } from "../../shared/contracts/primitives";
import type {
  TerritoryChatMomentSourceSnapshot,
  TerritoryCreateChangeCandidateRequest,
} from "../../shared/contracts/territoryWorld";
import type { IdGenerator } from "../../shared/pure/id";
import { openApplicationDatabase } from "../db/database";
import {
  STARTER_TERRITORY_REVISION_ID,
  STARTER_TERRITORY_ZONE_ID,
  createStarterTerritoryWorldSeed,
} from "./territoryStarterWorld";
import { TerritoryWorldRepository } from "./territoryWorldRepository";

const NOW = "2026-09-01T08:00:00.000Z";
const CANDIDATE_IDS = [
  "81000000-0000-4000-8000-000000000001",
  "81000000-0000-4000-8000-000000000002",
  "81000000-0000-4000-8000-000000000003",
  "81000000-0000-4000-8000-000000000004",
] as EntityId[];

class QueueIds implements IdGenerator {
  constructor(private readonly ids: EntityId[]) {}

  generate(): EntityId {
    const id = this.ids.shift();
    if (!id) throw new Error("No queued ID");
    return id;
  }
}

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function createRepository(): TerritoryWorldRepository {
  database = openApplicationDatabase(":memory:");
  const repository = new TerritoryWorldRepository(
    database,
    new QueueIds([...CANDIDATE_IDS]),
  );
  repository.ensureInitialized(createStarterTerritoryWorldSeed(NOW));
  return repository;
}

function momentSource(momentKey: string): TerritoryChatMomentSourceSnapshot {
  return {
    attachments: [
      {
        attachmentId: "82000000-0000-4000-8000-000000000001",
        displayName: "分享结束后的夕阳.png",
        mediaType: "image/png",
        sha256: "b".repeat(64),
      },
    ],
    chatId: "82000000-0000-4000-8000-000000000002",
    id: momentKey,
    kind: "chat_moment",
    label: "分享结束后拍下的一张夕阳",
    memoryRevisions: [
      {
        memoryId: "82000000-0000-4000-8000-000000000003",
        revisionId: "82000000-0000-4000-8000-000000000004",
        use: "current",
      },
    ],
    messageId: "82000000-0000-4000-8000-000000000005",
    momentKey,
    occurredAt: NOW,
    personaRef: {
      personaId: "82000000-0000-4000-8000-000000000006",
      revision: 3,
    },
    runId: "82000000-0000-4000-8000-000000000007",
  };
}

function momentRequest(
  source: TerritoryChatMomentSourceSnapshot,
): TerritoryCreateChangeCandidateRequest {
  return {
    baseRevisionId: STARTER_TERRITORY_REVISION_ID,
    intent: "item",
    itemContent: {
      description: "晚霞在一天结束后留下一点松弛的余温。",
      name: "收工后的晚霞",
    },
    lockedInstanceIds: [],
    prompt: "暖橙色晚霞凝成的轻盈玻璃摆件",
    providerProfileId: null,
    scope: { kind: "zone", zoneId: STARTER_TERRITORY_ZONE_ID },
    sources: [source],
  };
}

describe("TerritoryWorldRepository chat moments", () => {
  it.each([
    "draft",
    "generating",
    "ready",
    "failed",
    "stale",
    "cancelled",
    "applied",
  ] as const)(
    "returns the same candidate for a %s moment instead of duplicating it",
    (status) => {
      const repository = createRepository();
      const momentKey =
        status === "draft"
          ? "1".repeat(64)
          : status === "cancelled"
            ? "2".repeat(64)
            : "3".repeat(64);
      const request = momentRequest(momentSource(momentKey));

      const created = repository.createMomentCandidate(momentKey, request, NOW);
      expect(created.created).toBe(true);
      expect(created.snapshot.world.currentRevision.id).toBe(
        STARTER_TERRITORY_REVISION_ID,
      );
      if (status !== "draft") {
        database!
          .prepare(
            "UPDATE territory_change_candidates SET status = ? WHERE candidate_id = ?",
          )
          .run(status, created.candidateId);
      }

      const repeated = repository.createMomentCandidate(
        momentKey,
        request,
        "2026-09-01T08:01:00.000Z",
      );
      expect(repeated).toMatchObject({
        candidateId: created.candidateId,
        created: false,
      });
      expect(repository.findCandidateByMomentKey(momentKey)).toMatchObject({
        id: created.candidateId,
        status,
      });
      expect(
        database!
          .prepare(
            "SELECT moment_key FROM territory_change_candidates WHERE candidate_id = ?",
          )
          .get(created.candidateId),
      ).toEqual({ moment_key: momentKey });
      expect(repeated.snapshot.world.currentRevision.id).toBe(
        STARTER_TERRITORY_REVISION_ID,
      );
    },
  );

  it("rebases the same candidate before regenerating after the World advances", () => {
    const repository = createRepository();
    const created = repository.createCandidate(
      {
        baseRevisionId: STARTER_TERRITORY_REVISION_ID,
        intent: "item",
        lockedInstanceIds: [],
        prompt: "一盏新的阅读灯",
        providerProfileId: null,
        scope: { kind: "zone", zoneId: STARTER_TERRITORY_ZONE_ID },
        sources: [],
      },
      NOW,
    );
    const before = repository.getSnapshot();
    const instance = before.collection[0]!;
    const advanced = repository.commitChangeSet({
      changeSet: {
        baseRevisionId: before.world.currentRevision.id,
        id: "83000000-0000-4000-8000-000000000001",
        label: "收藏一个物件",
        mutations: [
          {
            changeId: "83000000-0000-4000-8000-000000000002",
            instance: {
              ...instance,
              favorite: !instance.favorite,
              updatedAt: NOW,
            },
            kind: "instance.put",
          },
        ],
      },
      now: "2026-09-01T08:02:00.000Z",
      reason: "direct",
    });

    const edited = repository.editCandidate(
      {
        candidateId: created.candidateId,
        excludedChangeIds: [],
        instruction: "换成更轻盈的表达",
        lockedInstanceIds: [],
      },
      "2026-09-01T08:03:00.000Z",
    );

    expect(edited.candidateId).toBe(created.candidateId);
    expect(edited.snapshot.candidates[0]).toMatchObject({
      baseRevisionId: advanced.world.currentRevision.id,
      id: created.candidateId,
      status: "draft",
    });
    expect(
      repository.getCandidateWork(created.candidateId).request,
    ).toMatchObject({ baseRevisionId: advanced.world.currentRevision.id });
  });
});
