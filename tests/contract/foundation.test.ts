import { describe, expect, it } from "vitest";

import { FoundationSnapshotSchema } from "../../src/shared/contracts/foundation";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";

const validSnapshot = {
  appName: "CharaMate",
  appVersion: "0.1.0",
  databaseRoundTrip: true,
  electronVersion: "43.2.0",
  nodeVersion: "24.13.0",
  platform: "darwin",
} as const;

describe("foundation snapshot boundary", () => {
  it("accepts the same valid value in Ajv and code-generation-free validation", () => {
    expect(parseSchema(FoundationSnapshotSchema, validSnapshot)).toEqual(
      validSnapshot,
    );
    expect(
      parseSchemaWithoutCodeGeneration(FoundationSnapshotSchema, validSnapshot),
    ).toEqual(validSnapshot);
  });

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "rejects unknown properties through %s",
    (parse) => {
      expect(() =>
        parse(FoundationSnapshotSchema, {
          ...validSnapshot,
          ipcRenderer: "must-not-cross",
        }),
      ).toThrow(/additional|Unexpected property/u);
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "rejects unsupported platform values through %s",
    (parse) => {
      expect(() =>
        parse(FoundationSnapshotSchema, {
          ...validSnapshot,
          platform: "aix",
        }),
      ).toThrow(/platform|union/u);
    },
  );
});
