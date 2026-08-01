import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { parseSchemaWithoutCodeGeneration } from "./valueValidation";

describe("code-generation-free schema validation", () => {
  it("returns a typed value without requiring eval", () => {
    const schema = Type.Object(
      { sequence: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    );

    expect(parseSchemaWithoutCodeGeneration(schema, { sequence: 1 })).toEqual({
      sequence: 1,
    });
    expect(() =>
      parseSchemaWithoutCodeGeneration(schema, { sequence: 0 }),
    ).toThrow(/sequence/u);
  });
});
