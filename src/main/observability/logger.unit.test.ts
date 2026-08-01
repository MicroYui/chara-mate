import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createAppLogger } from "./logger";

describe("Pino entry boundary", () => {
  it("redacts messages, structured fields and Error payloads before writing", () => {
    const destination = new PassThrough();
    const lines: string[] = [];
    destination.on("data", (chunk: Buffer) => {
      lines.push(chunk.toString("utf8"));
    });
    const logger = createAppLogger({ destination });
    const apiKey = "sk-1234567890abcdef";
    const bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";

    logger.info(`Connection failed for api_key=${apiKey}`, {
      apiKey,
      authorization: `Bearer ${bearer}`,
      provider: "example",
      tokenCount: 12,
    });
    logger.error("Provider error", new Error(`Rejected ${apiKey}`));

    const output = lines.join("");
    expect(output).not.toContain(apiKey);
    expect(output).not.toContain(bearer);
    expect(output).toContain("[REDACTED]");
    expect(output).toContain('"provider":"example"');
    expect(output).toContain('"tokenCount":12');
  });
});
