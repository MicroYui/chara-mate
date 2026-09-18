import { describe, expect, it } from "vitest";

import {
  estimateInputBudget,
  fitsInputBudget,
  modelInputBudget,
} from "./inputBudget";

describe("submitted input budget", () => {
  it("uses an exact count without the estimate margin or unknown-content penalty", () => {
    const estimate = {
      estimatedTokens: 900_000,
      wireBytes: 800_000,
      unknownKinds: ["input_file"],
    };
    expect(
      fitsInputBudget({ ...estimate, exactInputTokens: 30_000 }, 30_000),
    ).toBe(true);
    expect(
      fitsInputBudget({ ...estimate, exactInputTokens: 30_001 }, 30_000),
    ).toBe(false);
    expect(fitsInputBudget(estimate, 30_000)).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not treat invalid exact count %s as a small valid estimate",
    (exactInputTokens) => {
      expect(
        fitsInputBudget(
          {
            estimatedTokens: 100,
            wireBytes: 50,
            unknownKinds: [],
            exactInputTokens,
          },
          30_000,
        ),
      ).toBe(false);
    },
  );
  it("intersects every declared limit and the actual output reservation", () => {
    expect(modelInputBudget({})).toBe(258_000);
    const limits = {
      effectiveInputTokens: 900_000,
      maxContextTokens: 20_000,
      maxOutputTokens: 4_000,
      maxPromptTokens: 12_000,
    };
    expect(modelInputBudget(limits)).toBe(12_000);
    expect(modelInputBudget(limits, 15_000)).toBe(5_000);
    expect(modelInputBudget(limits, 20_000)).toBe(0);
  });

  it("includes instructions, history, tool schemas, structured output and UTF-8 content", () => {
    const initial = { input: [{ role: "user", content: "hello" }] };
    const larger = {
      ...initial,
      instructions: "系统".repeat(2_000),
      tools: [{ parameters: { description: "参数".repeat(2_000) } }],
      text: { format: { schema: { description: "输出".repeat(2_000) } } },
    };
    expect(estimateInputBudget(larger).estimatedTokens).toBeGreaterThan(
      estimateInputBudget(initial).estimatedTokens + 36_000,
    );
    expect(fitsInputBudget(estimateInputBudget(initial), 258_000)).toBe(true);
    expect(fitsInputBudget(estimateInputBudget(larger), 10_000)).toBe(false);
  });

  it("budgets accepted patch images independently of base64 compression or URL length", () => {
    const inline = estimateInputBudget(
      {
        type: "input_image",
        image_url: `data:image/png;base64,${"A".repeat(50_000)}`,
      },
      "gpt-6-astra",
    );
    const remote = estimateInputBudget(
      { type: "input_image", image_url: "https://example.test/picture.png" },
      "gpt-6-astra",
    );
    expect(inline.estimatedTokens).toBe(remote.estimatedTokens);
    expect(inline.estimatedTokens).toBeGreaterThan(36_000);
    expect(inline.wireBytes).toBeGreaterThan(remote.wireBytes);
    expect(fitsInputBudget(inline, 258_000)).toBe(true);
  });

  it("counts schema property names as visible text instead of media or opaque content", () => {
    const estimate = estimateInputBudget(
      {
        tools: [
          {
            parameters: {
              properties: {
                conversation: { type: "string" },
                encrypted_content: { type: "string" },
              },
            },
          },
        ],
        text: {
          format: {
            schema: {
              const: { type: "input_image", image_url: "large".repeat(10_000) },
            },
          },
        },
      },
      "gpt-6-astra",
    );
    expect(estimate.unknownKinds).toEqual([]);
    expect(estimate.estimatedTokens).toBeGreaterThan(50_000);
    expect(fitsInputBudget(estimate, 258_000)).toBe(true);
  });

  it("requires real counts for unknown media and opaque continuation but allows visible reasoning", () => {
    for (const input of [
      { type: "input_file", file_data: "small compressed PDF" },
      { type: "input_audio", data: "a" },
      { type: "input_video", video_url: "https://example.test/v" },
      { type: "item_reference", id: "old-item" },
      { type: "reasoning", encrypted_content: "opaque" },
      { type: "compaction", encrypted_content: "opaque" },
      { previous_response_id: "response-previous" },
    ]) {
      expect(fitsInputBudget(estimateInputBudget(input), 258_000)).toBe(false);
    }
    expect(
      fitsInputBudget(
        estimateInputBudget({
          type: "reasoning",
          summary: [{ text: "visible reasoning" }],
        }),
        258_000,
      ),
    ).toBe(true);
    expect(
      estimateInputBudget(
        { type: "input_image", image_url: "x" },
        "unknown-deployment",
      ).unknownKinds,
    ).toEqual(["image_model"]);
  });
});
