import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { CalendarDateSchema, JsonValueSchema } from "./primitives";
import { parseSchema } from "./validation";
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

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "validates calendar dates through %s",
    (parse) => {
      expect(parse(CalendarDateSchema, "2026-08-09")).toBe("2026-08-09");
      expect(() => parse(CalendarDateSchema, "2026-02-29")).toThrow();
      expect(() => parse(CalendarDateSchema, "2026-8-9")).toThrow();
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "validates the reusable recursive JSON schema through %s",
    (parse) => {
      const value = { nested: [null, true, 42, "text", { child: "value" }] };
      expect(parse(JsonValueSchema, value)).toEqual(value);
      expect(() => parse(JsonValueSchema, { invalid: undefined })).toThrow();
    },
  );
});
