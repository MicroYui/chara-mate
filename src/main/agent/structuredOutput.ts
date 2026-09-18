// OpenAI structured-output subset checked 2026-09-16:
// https://developers.openai.com/api/docs/guides/structured-outputs
// Optional domain fields become required nullable wire fields. Richer domain
// constraints remain in Ajv; a valid model JSON object is not factual evidence.
// Numeric bounds are supported by the selected generation model's protocol;
// the documented fine-tuned generation subset does not support those bounds.

type Schema = Readonly<Record<string, unknown>>;

function record(value: unknown): Schema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function allowsNull(schema: Schema): boolean {
  return (
    schema["type"] === "null" ||
    (Array.isArray(schema["anyOf"]) &&
      schema["anyOf"].some((child) => {
        const nested = record(child);
        return nested ? allowsNull(nested) : false;
      }))
  );
}

export function structuredOutputWireSchema(
  value: unknown,
): Record<string, unknown> {
  const schema = record(value);
  if (!schema)
    throw new TypeError("Structured output requires an object schema");
  if (schema["type"] === "object") {
    const fields = record(schema["properties"]);
    if (
      !fields ||
      schema["patternProperties"] ||
      schema["additionalProperties"] !== false
    ) {
      throw new TypeError(
        "Model output records must be represented as named fields or entry arrays",
      );
    }
    const required = new Set(
      Array.isArray(schema["required"]) ? schema["required"] : [],
    );
    const properties = Object.fromEntries(
      Object.entries(fields).map(([key, child]) => {
        const wire = structuredOutputWireSchema(child);
        return [
          key,
          required.has(key) || allowsNull(wire)
            ? wire
            : { anyOf: [wire, { type: "null" }] },
        ];
      }),
    );
    return {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }
  if (schema["type"] === "array") {
    return {
      type: "array",
      items: structuredOutputWireSchema(schema["items"]),
    };
  }
  if (Array.isArray(schema["anyOf"])) {
    return { anyOf: schema["anyOf"].map(structuredOutputWireSchema) };
  }
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) =>
      ["type", "enum", "const", "description", "minimum", "maximum"].includes(
        key,
      ),
    ),
  );
}

/** Remove only nulls introduced for optional fields. Explicit domain nulls
 * such as clearing an attention focus must survive round trips. */
export function restoreStructuredOutput(
  schemaValue: unknown,
  value: unknown,
): unknown {
  const schema = record(schemaValue);
  if (!schema || value === null) return value;
  if (schema["type"] === "array" && Array.isArray(value)) {
    return value.map((child) =>
      restoreStructuredOutput(schema["items"], child),
    );
  }
  const fields = record(schema["properties"]);
  const data = record(value);
  if (schema["type"] === "object" && fields && data) {
    const required = new Set(
      Array.isArray(schema["required"]) ? schema["required"] : [],
    );
    return Object.fromEntries(
      Object.entries(data).flatMap(([key, child]) => {
        const field = record(fields[key]);
        if (!field) return [[key, child]];
        if (child === null && !required.has(key) && !allowsNull(field))
          return [];
        return [[key, restoreStructuredOutput(field, child)]];
      }),
    );
  }
  return value;
}
