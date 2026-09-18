import { Type } from "@sinclair/typebox";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import { CognitionAnalysisSchema } from "../../shared/schemas/cognition";
import { parseSchema } from "../../shared/schemas/validation";
import {
  restoreStructuredOutput,
  structuredOutputWireSchema,
} from "./structuredOutput";

const domain = Type.Object(
  {
    optional: Type.Optional(Type.String()),
    focus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    entries: Type.Array(
      Type.Object(
        { name: Type.String(), at: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

describe("structured model output boundary", () => {
  it("constrains numeric references in the actual nullable wire schema", () => {
    const bounded = Type.Object(
      {
        references: Type.Array(
          Type.Object(
            {
              index: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    );
    const validate = new Ajv({ strict: true }).compile(
      structuredOutputWireSchema(bounded),
    );
    for (const index of [null, 0, 2]) {
      expect(validate({ references: [{ index }] })).toBe(true);
    }
    for (const index of [-1, 3, 0.5, "persona-id"]) {
      expect(validate({ references: [{ index }] })).toBe(false);
    }
    expect(validate({ references: [{}] })).toBe(false);
    expect(
      restoreStructuredOutput(bounded, {
        references: [{ index: null }, { index: 0 }],
      }),
    ).toEqual({ references: [{}, { index: 0 }] });
  });

  it("makes optional fields nullable on the wire and preserves intentional clear operations", () => {
    const wire = structuredOutputWireSchema(domain);
    expect(wire["required"]).toEqual(["optional", "focus", "entries"]);
    expect(
      restoreStructuredOutput(domain, {
        optional: null,
        focus: null,
        entries: [{ name: "existing", at: null }],
      }),
    ).toEqual({ focus: null, entries: [{ name: "existing" }] });
  });

  it("keeps domain validation responsible for unsupported values", () => {
    const restored = restoreStructuredOutput(domain, {
      optional: null,
      focus: null,
      entries: [{ name: 42, at: null }],
    });
    expect(() => parseSchema(domain, restored)).toThrow();
    expect(() =>
      structuredOutputWireSchema(CognitionAnalysisSchema),
    ).not.toThrow();
    expect(() =>
      structuredOutputWireSchema(Type.Record(Type.String(), Type.String())),
    ).toThrow("entry arrays");
  });
});
