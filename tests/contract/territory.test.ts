import { describe, expect, it } from "vitest";

import {
  TerritoryEditImageRequestSchema,
  TerritoryCreateSourceCandidateRequestSchema,
  TerritoryGenerateImageRequestSchema,
  TerritoryImageMutationResponseSchema,
  TerritoryInstallGeneratedItemInputSchema,
  TerritoryMovePetRequestSchema,
  TerritoryMoveResponseSchema,
  TerritoryPlaceItemRequestSchema,
  TerritorySelectItemVersionRequestSchema,
  TerritorySetItemPinnedRequestSchema,
  TerritorySnapshotResponseSchema,
  TerritorySnapshotSchema,
  TerritorySourceCandidateMutationResponseSchema,
} from "../../src/shared/schemas/territory";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";
import {
  activeTerritorySnapshot,
  emptyTerritorySnapshot,
} from "../fixtures/territory";
import { territoryCupManifest } from "../fixtures/territoryItemManifests";

describe("Territory IPC contracts", () => {
  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts first-run and active projections through %s",
    (parse) => {
      expect(parse(TerritorySnapshotSchema, emptyTerritorySnapshot)).toEqual(
        emptyTerritorySnapshot,
      );
      expect(parse(TerritorySnapshotSchema, activeTerritorySnapshot)).toEqual(
        activeTerritorySnapshot,
      );
      expect(
        parse(TerritorySnapshotResponseSchema, {
          ok: true,
          value: activeTerritorySnapshot,
        }),
      ).toMatchObject({ ok: true });
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "validates movement paths and placement transforms through %s",
    (parse) => {
      expect(
        parse(TerritoryMovePetRequestSchema, {
          from: { x: 8, y: 6 },
          sceneId: "forest-cabin",
          x: 7,
          y: 6,
        }),
      ).toEqual({
        from: { x: 8, y: 6 },
        sceneId: "forest-cabin",
        x: 7,
        y: 6,
      });
      expect(
        parse(TerritoryPlaceItemRequestSchema, {
          flipped: true,
          itemId: "forest-cabin.desk",
          rotation: 90,
          target: {
            kind: "ground",
            sceneId: "forest-cabin",
            x: 6,
            y: 5,
          },
        }),
      ).toMatchObject({ flipped: true, rotation: 90 });
      expect(
        parse(TerritoryInstallGeneratedItemInputSchema, {
          itemId: "generated.ceramic-cup",
          manifest: territoryCupManifest,
          sourceImagePath: "/tmp/generated-cup.png",
        }),
      ).toMatchObject({
        manifest: { visual: { source: { kind: "asset" } } },
      });
      const candidateId = "61e0b15d-a46d-4268-9a2c-6c4bd271a627";
      const itemCandidateId = "6b90bf76-893b-47dc-b9ea-913d0c25c5e6";
      expect(
        parse(TerritoryGenerateImageRequestSchema, {
          description: "留一盏灯，纪念完成项目的夜晚。",
          itemCandidateId,
          name: "长夜台灯",
          providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
          sceneId: "forest-cabin",
          structure: {
            footprintTiles: { height: 2, width: 3 },
            placement: "ground_object",
            surfaceSlots: [
              {
                anchorPx: { x: 72, y: 48 },
                id: "center",
                maxItemSizePx: { height: 32, width: 32 },
              },
            ],
            visualSizePx: { height: 120, width: 144 },
          },
          visualPrompt: "一盏小巧的黄铜工坊台灯",
        }),
      ).toMatchObject({
        name: "长夜台灯",
        itemCandidateId,
        structure: {
          footprintTiles: { height: 2, width: 3 },
          surfaceSlots: [{ id: "center" }],
          visualSizePx: { height: 120, width: 144 },
        },
      });
      expect(
        parse(TerritoryCreateSourceCandidateRequestSchema, {
          source: {
            kind: "memory",
            memoryId: "17bd6914-d46b-44ee-9776-c0aa07ae91cd",
          },
        }),
      ).toMatchObject({ source: { kind: "memory" } });
      expect(
        parse(TerritorySetItemPinnedRequestSchema, {
          itemId: `memory.${itemCandidateId}`,
          pinned: true,
        }),
      ).toMatchObject({ pinned: true });
      expect(
        parse(TerritorySelectItemVersionRequestSchema, {
          itemId: `memory.${itemCandidateId}`,
          revision: 2,
        }),
      ).toMatchObject({ revision: 2 });
      expect(
        parse(TerritoryEditImageRequestSchema, {
          candidateId,
          instruction: "把灯罩改成琥珀玻璃",
        }),
      ).toEqual({
        candidateId,
        instruction: "把灯罩改成琥珀玻璃",
      });
      expect(
        parse(TerritoryImageMutationResponseSchema, {
          ok: true,
          value: {
            candidateId,
            snapshot: activeTerritorySnapshot,
          },
        }),
      ).toMatchObject({ ok: true });
      expect(
        parse(TerritorySourceCandidateMutationResponseSchema, {
          ok: true,
          value: {
            candidateId: itemCandidateId,
            snapshot: activeTerritorySnapshot,
          },
        }),
      ).toMatchObject({ ok: true });
      expect(
        parse(TerritoryMoveResponseSchema, {
          ok: true,
          value: {
            path: [
              { x: 8, y: 6 },
              { x: 7, y: 6 },
            ],
            snapshot: activeTerritorySnapshot,
          },
        }),
      ).toMatchObject({ ok: true });
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "rejects unknown scenes, unsafe item IDs and malformed grids through %s",
    (parse) => {
      expect(() =>
        parse(TerritoryMovePetRequestSchema, {
          from: { x: 8, y: 6 },
          sceneId: "generated-world",
          x: 1,
          y: 1,
        }),
      ).toThrow();
      expect(() =>
        parse(TerritoryMovePetRequestSchema, {
          sceneId: "forest-cabin",
          x: 7,
          y: 6,
        }),
      ).toThrow();
      expect(() =>
        parse(TerritoryPlaceItemRequestSchema, {
          flipped: false,
          itemId: "../outside",
          rotation: 45,
          target: {
            kind: "ground",
            sceneId: "forest-cabin",
            x: 1,
            y: 1,
          },
        }),
      ).toThrow();
      expect(() =>
        parse(TerritoryCreateSourceCandidateRequestSchema, {
          source: { kind: "memory", memoryId: "not-a-memory-id" },
        }),
      ).toThrow();
      expect(() =>
        parse(TerritorySelectItemVersionRequestSchema, {
          itemId: "memory.valid-id",
          revision: 0,
        }),
      ).toThrow();
      expect(() =>
        parse(TerritoryEditImageRequestSchema, {
          candidateId: "../preview",
          instruction: "修改",
        }),
      ).toThrow();
      expect(() =>
        parse(TerritorySnapshotSchema, {
          ...activeTerritorySnapshot,
          activeScene: {
            ...activeTerritorySnapshot.activeScene,
            definition: {
              ...activeTerritorySnapshot.activeScene?.definition,
              walkableRows: ["111"],
            },
          },
        }),
      ).toThrow();
    },
  );
});
