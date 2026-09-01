import { describe, expect, it } from "vitest";

import type {
  TerritoryInstance,
  TerritorySourceSnapshot,
  TerritoryWorldSnapshot,
  TerritoryZoneView,
} from "../../src/shared/contracts/territoryWorld";

import {
  TerritoryCommitChangeSetRequestSchema,
  TerritoryCreateChangeCandidateRequestSchema,
  TerritoryGetZoneViewRequestSchema,
  TerritoryPerformPetActionRequestSchema,
  TerritoryPetActionObservationSchema,
  TerritoryPetActionPerformedSchema,
  TerritoryWorldSnapshotResponseSchema,
  TerritoryWorldSnapshotSchema,
  TerritoryZoneViewResponseSchema,
  TerritoryZoneViewSchema,
} from "../../src/shared/schemas/territoryWorld";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";
import {
  validateTerritoryWorldChangeSet,
  validateTerritoryWorldSnapshot,
  validateTerritoryZoneView,
} from "../../src/shared/pure/territoryWorldValidation";
import {
  starterCandidateChangeSet,
  starterCollectionInstance,
  starterTerritoryAssetPack,
  starterPlacedInstances,
  starterTerritorySnapshot,
  starterTerritoryZoneView,
  territoryWorldFixtureIds,
} from "../fixtures/territoryWorld";

describe("Territory World contracts", () => {
  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts the frozen World and viewport projections through %s",
    (parse) => {
      expect(
        parse(TerritoryWorldSnapshotSchema, starterTerritorySnapshot),
      ).toEqual(starterTerritorySnapshot);
      expect(parse(TerritoryZoneViewSchema, starterTerritoryZoneView)).toEqual(
        starterTerritoryZoneView,
      );
      expect(
        parse(TerritoryWorldSnapshotResponseSchema, {
          ok: true,
          value: starterTerritorySnapshot,
        }),
      ).toMatchObject({ ok: true });
      expect(
        parse(TerritoryZoneViewResponseSchema, {
          ok: true,
          value: starterTerritoryZoneView,
        }),
      ).toMatchObject({ ok: true });
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts typed Territory observations, actions and renderer events through %s",
    (parse) => {
      const observation = {
        pet: starterTerritorySnapshot.pet,
        revisionId: territoryWorldFixtureIds.revision,
        targets: [
          {
            actions: ["move", "observe", "react"],
            capabilities: ["light", "inspectable"],
            description: "会在暮色里留下一圈暖光的小灯。",
            instanceId: territoryWorldFixtureIds.lampInstance,
            name: "琥珀桌灯",
            point: { x: 6, y: 4 },
            reachable: true,
          },
        ],
        zone: {
          bounds: starterTerritoryZoneView.zone.bounds,
          id: territoryWorldFixtureIds.zone,
          name: starterTerritoryZoneView.zone.name,
        },
      };
      expect(parse(TerritoryPetActionObservationSchema, observation)).toEqual(
        observation,
      );
      expect(
        parse(TerritoryPerformPetActionRequestSchema, {
          action: "react",
          expectedRevisionId: territoryWorldFixtureIds.revision,
          target: {
            instanceId: territoryWorldFixtureIds.lampInstance,
            kind: "instance",
          },
        }),
      ).toMatchObject({ action: "react" });
      expect(
        parse(TerritoryPetActionPerformedSchema, {
          action: "react",
          path: [starterTerritorySnapshot.pet.point, { x: 6, y: 6 }],
          snapshot: starterTerritorySnapshot,
          targetInstanceId: territoryWorldFixtureIds.lampInstance,
        }),
      ).toMatchObject({ action: "react" });
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "rejects malformed Territory pet actions through %s",
    (parse) => {
      expect(() =>
        parse(TerritoryPerformPetActionRequestSchema, {
          action: "sleep",
          expectedRevisionId: territoryWorldFixtureIds.revision,
          target: { kind: "point", point: { x: -1, y: 0 } },
        }),
      ).toThrow();
    },
  );

  it("validates references, attachment graphs, lifecycle and candidate state", () => {
    expect(validateTerritoryWorldSnapshot(starterTerritorySnapshot)).toEqual(
      [],
    );
    expect(
      validateTerritoryZoneView(
        starterTerritoryZoneView,
        starterTerritorySnapshot,
      ),
    ).toEqual([]);
    expect(
      validateTerritoryWorldChangeSet(
        starterCandidateChangeSet,
        starterTerritorySnapshot,
        [starterTerritoryZoneView],
      ),
    ).toEqual([]);
  });

  it("accepts sequential Asset Pack revisions and rejects missing asset references", () => {
    const assetPackChangeSet = {
      ...starterCandidateChangeSet,
      mutations: [
        {
          assetPack: { ...starterTerritoryAssetPack, revision: 2 },
          changeId: "90000000-0000-4000-8000-000000000010",
          kind: "asset-pack.put" as const,
        },
      ],
    };
    expect(
      validateTerritoryWorldChangeSet(
        assetPackChangeSet,
        starterTerritorySnapshot,
      ),
    ).toEqual([]);

    assetPackChangeSet.mutations[0]!.assetPack = {
      ...assetPackChangeSet.mutations[0]!.assetPack,
      assets: [
        {
          assetId: "missing.generated-asset",
          key: "missing.primary",
          layer: "object",
        },
      ],
    };
    expect(
      validateTerritoryWorldChangeSet(
        assetPackChangeSet,
        starterTerritorySnapshot,
      ),
    ).toContainEqual(expect.objectContaining({ code: "MISSING_REFERENCE" }));
  });

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts semantic viewport, change-set and AI Preview requests through %s",
    (parse) => {
      expect(
        parse(TerritoryGetZoneViewRequestSchema, {
          revisionId: territoryWorldFixtureIds.revision,
          viewport: { height: 8, width: 10, x: 2, y: 1 },
          zoneId: territoryWorldFixtureIds.zone,
        }),
      ).toMatchObject({
        viewport: { width: 10 },
        zoneId: territoryWorldFixtureIds.zone,
      });
      expect(
        parse(TerritoryCommitChangeSetRequestSchema, {
          changeSet: starterCandidateChangeSet,
        }),
      ).toMatchObject({ changeSet: { mutations: [{ kind: "instance.put" }] } });
      expect(
        parse(TerritoryCreateChangeCandidateRequestSchema, {
          baseRevisionId: territoryWorldFixtureIds.revision,
          intent: "zone",
          itemContent: {
            description: "书页与灯影在这里围成一处安静的停靠。",
            name: "灯下阅读角",
          },
          lockedInstanceIds: [territoryWorldFixtureIds.deskInstance],
          prompt: "保留书桌，把附近整理成阅读角。",
          providerProfileId: territoryWorldFixtureIds.provider,
          scope: { kind: "zone", zoneId: territoryWorldFixtureIds.zone },
          sources: [],
        }),
      ).toMatchObject({
        itemContent: { name: "灯下阅读角" },
        scope: { kind: "zone" },
      });
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "does not retain fixed scenes, capacity or executable mutations through %s",
    (parse) => {
      expect(() =>
        parse(TerritoryWorldSnapshotSchema, {
          ...starterTerritorySnapshot,
          capacity: 12,
        }),
      ).toThrow();
      expect(() =>
        parse(TerritoryGetZoneViewRequestSchema, {
          revisionId: territoryWorldFixtureIds.revision,
          zoneId: "forest-cabin",
        }),
      ).toThrow();
      expect(() =>
        parse(TerritoryCommitChangeSetRequestSchema, {
          changeSet: {
            ...starterCandidateChangeSet,
            mutations: [
              {
                changeId: territoryWorldFixtureIds.candidateChange,
                kind: "sql.execute",
                sql: "DELETE FROM territory_worlds",
              },
            ],
          },
        }),
      ).toThrow();
    },
  );

  it("rejects a ready candidate whose base Revision is stale", () => {
    const snapshot: TerritoryWorldSnapshot = structuredClone(
      starterTerritorySnapshot,
    );
    const nextRevision = {
      ...snapshot.world.currentRevision,
      id: "10000000-0000-4000-8000-000000000002",
      label: "移动书桌",
      parentRevisionId: territoryWorldFixtureIds.revision,
      reason: "direct" as const,
      sequence: 2,
    };
    snapshot.revisions.push(nextRevision);
    snapshot.world.currentRevision = nextRevision;

    expect(validateTerritoryWorldSnapshot(snapshot)).toContainEqual(
      expect.objectContaining({ code: "REVISION_CONFLICT" }),
    );
  });

  it("rejects cyclic attachment graphs", () => {
    const view: TerritoryZoneView = structuredClone(starterTerritoryZoneView);
    const desk = view.instances.find(
      (instance) => instance.id === territoryWorldFixtureIds.deskInstance,
    );
    expect(desk).toBeDefined();
    if (!desk) return;
    desk.placement = {
      anchorId: "top",
      flipped: false,
      kind: "attachment",
      offsetPx: { x: 0, y: 0 },
      parentInstanceId: territoryWorldFixtureIds.lampInstance,
      rotation: 0,
      zoneId: territoryWorldFixtureIds.zone,
    };

    expect(
      validateTerritoryZoneView(view, starterTerritorySnapshot),
    ).toContainEqual(expect.objectContaining({ code: "ATTACHMENT_CYCLE" }));
  });

  it("keeps locked content immutable in direct and generated changes", () => {
    const lockedDesk = {
      ...starterPlacedInstances[1]!,
      locked: true,
    };
    const view = {
      ...starterTerritoryZoneView,
      instances: [
        starterPlacedInstances[0]!,
        lockedDesk,
        starterPlacedInstances[2]!,
      ],
    };
    const changeSet = {
      ...starterCandidateChangeSet,
      mutations: [
        {
          changeId: territoryWorldFixtureIds.candidateChange,
          instance: { ...lockedDesk, favorite: false },
          kind: "instance.put" as const,
        },
      ],
    };

    expect(
      validateTerritoryWorldChangeSet(changeSet, starterTerritorySnapshot, [
        view,
      ]),
    ).toContainEqual(
      expect.objectContaining({ code: "LOCKED_CONTENT_CHANGED" }),
    );
  });

  it("preserves one stable Territory identity per Memory source", () => {
    const source: TerritorySourceSnapshot = {
      id: "70000000-0000-4000-8000-000000000001",
      kind: "memory" as const,
      label: "第一次一起完成长项目",
      occurredAt: "2026-08-12T08:00:00.000Z",
      revisionId: "70000000-0000-4000-8000-000000000002",
    };
    const snapshot: TerritoryWorldSnapshot = structuredClone(
      starterTerritorySnapshot,
    );
    snapshot.collection[0] = {
      ...starterCollectionInstance,
      sources: [source],
    };
    const duplicate: TerritoryInstance = {
      ...starterCollectionInstance,
      id: territoryWorldFixtureIds.candidateInstance,
      sources: [source],
    };
    const changeSet = {
      ...starterCandidateChangeSet,
      mutations: [
        {
          changeId: territoryWorldFixtureIds.candidateChange,
          instance: duplicate,
          kind: "instance.put" as const,
        },
      ],
    };

    expect(validateTerritoryWorldChangeSet(changeSet, snapshot)).toContainEqual(
      expect.objectContaining({ code: "SOURCE_IDENTITY_CONFLICT" }),
    );
  });
});
