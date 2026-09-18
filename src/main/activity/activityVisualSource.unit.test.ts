import { describe, expect, it, vi } from "vitest";
import { normalizeVisualFrame } from "./activityVisualSource";
import { visualFrameFixture, visualPngFixture } from "./activityVisual.fixture";

async function nativeFrame(text: string) {
  const frame = await visualFrameFixture();
  return {
    ...frame,
    visual: {
      ...frame.visual,
      ocr: {
        ...frame.visual.ocr,
        status: "complete",
        lines: [
          {
            text,
            confidence: 0.9,
            bounds: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
          },
        ],
      },
    },
  };
}

describe("visual OCR persistence boundary", () => {
  it("masks the same OCR region whose credential text was removed", async () => {
    const input = await nativeFrame("access_token=synthetic-secret");
    const masked = Buffer.concat([visualPngFixture, Buffer.from("sanitized")]);
    const mask = vi.fn(() => Promise.resolve(masked));
    const frame = await normalizeVisualFrame(input, mask);
    expect(mask).toHaveBeenCalledExactlyOnceWith(input.bytes, [
      { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
    ]);
    expect(frame?.bytes).toEqual(masked);
    expect(frame?.visual.redactedRegions).toBe(1);
    expect(JSON.stringify(frame?.visual)).not.toContain("synthetic-secret");
    expect(frame?.visual.contentRevision).not.toBe(
      input.visual.contentRevision,
    );
  });

  it("does not confuse identical OCR with identical pixels", async () => {
    const input = await nativeFrame("蓝色和橙色柱状图");
    const mask = vi.fn((bytes: Buffer) => Promise.resolve(bytes));
    const a = await normalizeVisualFrame(input, mask);
    const b = await normalizeVisualFrame(
      {
        ...input,
        bytes: Buffer.concat([
          input.bytes,
          Buffer.from("changed-graph-pixels"),
        ]),
      },
      mask,
    );
    expect(a?.visual.ocr).toEqual(b?.visual.ocr);
    expect(a?.visual.contentRevision).not.toBe(b?.visual.contentRevision);
    expect(mask).not.toHaveBeenCalled();
  });

  it("rejects impossible source dimensions and OCR boxes before masking", async () => {
    const input = await nativeFrame("总额 980 元");
    const mask = vi.fn((bytes: Buffer) => Promise.resolve(bytes));
    await expect(
      normalizeVisualFrame({ ...input, width: 999 }, mask),
    ).rejects.toThrow("dimensions");
    input.visual.ocr.lines[0]!.bounds.width = 1;
    await expect(normalizeVisualFrame(input, mask)).rejects.toThrow("exceeds");
    expect(mask).not.toHaveBeenCalled();
  });

  it("does not return an unmasked image when redaction or cancellation fails", async () => {
    const input = await nativeFrame("access_token=synthetic-secret");
    await expect(
      normalizeVisualFrame(input, () =>
        Promise.reject(new Error("mask failed")),
      ),
    ).rejects.toThrow("mask failed");
    const controller = new AbortController();
    await expect(
      normalizeVisualFrame(
        input,
        () => {
          controller.abort();
          return Promise.resolve(input.bytes);
        },
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it("redacts surface title using the same boundary and keeps an empty OCR result valid", async () => {
    const frame = await visualFrameFixture();
    frame.visual.surface = {
      ...frame.visual.surface,
      windowTitle: "password=synthetic-secret",
    };
    const normalized = await normalizeVisualFrame(frame, (bytes) =>
      Promise.resolve(bytes),
    );
    expect(normalized?.visual.surface.windowTitle).not.toContain(
      "synthetic-secret",
    );
    expect(normalized?.visual.ocr.status).toBe("empty");
  });
});
