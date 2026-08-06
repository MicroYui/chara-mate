import { describe, expect, it } from "vitest";

import {
  CodexPetManifestSchema,
  PetAnimationSpeedRequestSchema,
  PetCharacterSnapshotSchema,
  PetDragPointSchema,
  PetLibrarySnapshotSchema,
  PetMainNavigationSchema,
  PetScaleRequestSchema,
} from "../../src/shared/schemas/pet";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";

const descriptor = {
  description: "A test pet",
  displayName: "Columbinya",
  id: "columbinya",
  spriteHeight: 2288,
  spriteUrl: "chara-mate-pet://asset/columbinya/spritesheet.webp",
  spriteVersionNumber: 2,
  spriteWidth: 1536,
} as const;

describe("pet IPC and import contracts", () => {
  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts v1 manifests with an omitted version through %s",
    (parse) => {
      expect(
        parse(CodexPetManifestSchema, {
          description: "Legacy atlas",
          displayName: "Linnea",
          id: "linnea",
          spritesheetPath: "spritesheet.webp",
        }),
      ).toMatchObject({ id: "linnea" });
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "validates a v2 library and Character projection through %s",
    (parse) => {
      expect(
        parse(PetLibrarySnapshotSchema, {
          activePetId: descriptor.id,
          animationSpeed: 0.75,
          pets: [descriptor],
          scale: 1.25,
        }),
      ).toMatchObject({ activePetId: descriptor.id });
      expect(
        parse(PetCharacterSnapshotSchema, {
          activePet: descriptor,
          animation: "look",
          animationSpeed: 0.75,
          facing: "left",
          scale: 1.25,
        }),
      ).toMatchObject({ animation: "look", facing: "left" });
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "rejects unsafe IDs, unsupported versions and local paths through %s",
    (parse) => {
      expect(() =>
        parse(CodexPetManifestSchema, {
          description: "Invalid",
          displayName: "Invalid",
          id: "../escape",
          spriteVersionNumber: 3,
          spritesheetPath: "/tmp/spritesheet.webp",
        }),
      ).toThrow();
      expect(() =>
        parse(PetCharacterSnapshotSchema, {
          activePet: { ...descriptor, spriteUrl: "file:///tmp/atlas.webp" },
          animation: "idle",
          animationSpeed: 0.75,
          facing: "right",
          scale: 1,
        }),
      ).toThrow();
      expect(() =>
        parse(PetDragPointSchema, {
          screenX: Number.NaN,
          screenY: 100,
        }),
      ).toThrow();
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts only the supported Main navigation targets through %s",
    (parse) => {
      expect(parse(PetMainNavigationSchema, { target: "chat" })).toEqual({
        target: "chat",
      });
      expect(parse(PetMainNavigationSchema, { target: "character" })).toEqual({
        target: "character",
      });
      expect(() =>
        parse(PetMainNavigationSchema, { target: "settings" }),
      ).toThrow();
      expect(() =>
        parse(PetMainNavigationSchema, {
          extra: true,
          target: "chat",
        }),
      ).toThrow();
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts the size and speed slider boundaries through %s",
    (parse) => {
      expect(parse(PetScaleRequestSchema, { scale: 0.3 })).toEqual({
        scale: 0.3,
      });
      expect(
        parse(PetAnimationSpeedRequestSchema, { animationSpeed: 0.1 }),
      ).toEqual({ animationSpeed: 0.1 });
      expect(() => parse(PetScaleRequestSchema, { scale: 0.29 })).toThrow();
      expect(() =>
        parse(PetAnimationSpeedRequestSchema, { animationSpeed: 0.09 }),
      ).toThrow();
    },
  );
});
