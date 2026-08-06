import { describe, expect, it } from "vitest";

import {
  TerritoryInstallGeneratedItemInputSchema,
  TerritoryMovePetRequestSchema,
  TerritoryMoveResponseSchema,
  TerritoryPlaceItemRequestSchema,
  TerritorySnapshotResponseSchema,
  TerritorySnapshotSchema,
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
