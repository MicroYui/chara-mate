import { describe, expect, it } from "vitest";

import { TerritoryItemManifestV1Schema } from "../../src/shared/schemas/territoryItemManifest";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";
import {
  territoryCupManifest,
  territoryDeskManifest,
  territoryHearthManifest,
  territoryRugManifest,
} from "../fixtures/territoryItemManifests";

describe("Territory item manifest contract", () => {
  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts ground, underlay, support, and surface items through %s",
    (parse) => {
      for (const manifest of [
        territoryDeskManifest,
        territoryHearthManifest,
        territoryRugManifest,
        territoryCupManifest,
      ]) {
        expect(parse(TerritoryItemManifestV1Schema, manifest)).toEqual(
          manifest,
        );
      }
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "rejects malformed or open-ended authoring output through %s",
    (parse) => {
      expect(() =>
        parse(TerritoryItemManifestV1Schema, {
          ...territoryCupManifest,
          arbitraryScript: "moveEverything()",
        }),
      ).toThrow();
      expect(() =>
        parse(TerritoryItemManifestV1Schema, {
          ...territoryDeskManifest,
          transforms: {
            ...territoryDeskManifest.transforms,
            rotations: [45],
          },
        }),
      ).toThrow();
      expect(() =>
        parse(TerritoryItemManifestV1Schema, {
          ...territoryCupManifest,
          placement: {
            ...territoryCupManifest.placement,
            allowedSurfaceKinds: ["anything-agent-invents"],
          },
        }),
      ).toThrow();
    },
  );
});
