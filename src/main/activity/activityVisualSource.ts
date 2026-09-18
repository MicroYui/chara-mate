import type { Timestamp } from "../../shared/contracts/primitives";
import { TimestampSchema } from "../../shared/schemas/primitives";

import type {
  ActivitySurface,
  ActivityVisual,
} from "../../shared/contracts/activity";
import {
  ActivitySurfaceSchema,
  ActivityVisualSchema,
} from "../../shared/schemas/activity";
import { parseSchema } from "../../shared/schemas/validation";
import { redactText } from "../../shared/pure/redaction";
import {
  visualContentRevision,
  type ActivityVisualFrame,
} from "./activityVisualEvidence";

export interface ActivityVisualChange {
  readonly surface: ActivitySurface;
  readonly actor: "agent" | "user" | "unknown";
  readonly capturedAt: Timestamp;
  readonly sequence: number;
}

export function normalizeVisualChange(input: unknown): ActivityVisualChange {
  if (!input || typeof input !== "object")
    throw new Error("Invalid visual change notice");
  const value = input as Record<string, unknown>;
  if (
    (value["actor"] !== "user" &&
      value["actor"] !== "agent" &&
      value["actor"] !== "unknown") ||
    !Number.isSafeInteger(value["sequence"]) ||
    Number(value["sequence"]) < 0
  )
    throw new Error("Invalid visual change notice");
  return {
    surface: normalizeVisualSurface(value["surface"]),
    actor: value["actor"],
    capturedAt: parseSchema(TimestampSchema, value["capturedAt"]),
    sequence: Number(value["sequence"]),
  };
}

export function normalizeVisualSurface(input: unknown): ActivitySurface {
  const surface = parseSchema(ActivitySurfaceSchema, input);
  return {
    ...surface,
    appName: redactText(surface.appName),
    ...(surface.appId ? { appId: redactText(surface.appId) } : {}),
    ...(surface.windowTitle
      ? { windowTitle: redactText(surface.windowTitle) }
      : {}),
  };
}

/** OCR/raw pixels cross only this ephemeral boundary. Persistent frames are sanitized together. */
export async function normalizeVisualFrame(
  input: unknown,
  mask: (
    bytes: Buffer,
    regions: ActivityVisual["ocr"]["lines"][number]["bounds"][],
  ) => Promise<Buffer>,
  signal?: AbortSignal,
): Promise<ActivityVisualFrame | undefined> {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object")
    throw new Error("Invalid native visual frame");
  const value = input as Record<string, unknown>;
  const bytes = value["bytes"];
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.readUInt32BE(16) !== value["width"] ||
    bytes.readUInt32BE(20) !== value["height"]
  )
    throw new Error("Invalid native visual PNG dimensions");
  if (
    value["actor"] !== "user" &&
    value["actor"] !== "agent" &&
    value["actor"] !== "unknown"
  )
    throw new Error("Invalid native visual actor");
  const raw = value["visual"];
  if (!raw || typeof raw !== "object")
    throw new Error("Invalid native visual metadata");
  const visual = parseSchema(ActivityVisualSchema, {
    ...raw,
    contentRevision: "pending",
    trigger: "frame",
    redactedRegions: 0,
  });
  const original = visual.ocr.lines;
  for (const { bounds } of original)
    if (
      bounds.x + bounds.width > 1.000001 ||
      bounds.y + bounds.height > 1.000001
    )
      throw new Error("Native OCR box exceeds its visual surface");
  const lines = original.map((line) => ({
    ...line,
    text: redactText(line.text),
  }));
  let regions = original
    .filter((line, index) => line.text !== lines[index]?.text)
    .map((line) => line.bounds);
  const joined = original.map((line) => line.text).join("\n");
  // A credential may span OCR lines (e.g. a PEM block). In that case mask every participating line.
  if (redactText(joined) !== lines.map((line) => line.text).join("\n")) {
    regions = original.map((line) => line.bounds);
    for (const line of lines) line.text = "[REDACTED]";
  }
  signal?.throwIfAborted();
  const redacted = regions.length ? await mask(bytes, regions) : bytes;
  signal?.throwIfAborted();
  return {
    actor: value["actor"],
    bytes: redacted,
    width: Number(value["width"]),
    height: Number(value["height"]),
    visual: {
      ...visual,
      surface: normalizeVisualSurface(visual.surface),
      contentRevision: await visualContentRevision(redacted),
      redactedRegions: regions.length,
      ocr: { ...visual.ocr, lines },
    },
  };
}
