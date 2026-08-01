import { describe, expect, it } from "vitest";

import { REDACTED_VALUE, redactBoundaryValue, redactText } from "./redaction";

describe("shared persistence and logging redaction boundary", () => {
  it("removes nested credential fields without removing ordinary token metrics", () => {
    const redacted = redactBoundaryValue({
      apiKey: "azure-secret-value",
      nested: {
        access_token: "access-secret-value",
        tokenCount: 42,
      },
      provider: "example",
    });

    expect(redacted).toEqual({
      apiKey: REDACTED_VALUE,
      nested: {
        access_token: REDACTED_VALUE,
        tokenCount: 42,
      },
      provider: "example",
    });
  });

  it("removes common credentials embedded in text and Error objects", () => {
    const secretKey = "sk-1234567890abcdef";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
    const redactedText = redactText(
      `Authorization: Bearer ${jwt}; api_key=${secretKey}`,
    );
    const redactedError = redactBoundaryValue(
      new Error(`Provider rejected ${secretKey}`),
    );

    expect(redactedText).not.toContain(secretKey);
    expect(redactedText).not.toContain(jwt);
    expect(JSON.stringify(redactedError)).not.toContain(secretKey);
    expect(redactedText).toContain(REDACTED_VALUE);
  });

  it("handles cycles without leaking the referenced object", () => {
    const value: Record<string, unknown> = { password: "hidden" };
    value["self"] = value;

    expect(redactBoundaryValue(value)).toEqual({
      password: REDACTED_VALUE,
      self: "[Circular]",
    });
  });
});
