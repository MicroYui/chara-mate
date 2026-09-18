import type { ActivitySurface } from "../../shared/contracts/activity";
import {
  visualContentRevision,
  type ActivityVisualFrame,
} from "./activityVisualEvidence";

export const visualSurfaceFixture: ActivitySurface = {
  id: "display:1/window:42",
  epoch: "fixture-epoch",
  displayId: "1",
  windowId: "42",
  processId: 123,
  appName: "Synthetic fixture",
  windowTitle: "Fixture",
  bounds: { x: 20, y: 30, width: 1, height: 1 },
  scaleFactor: 1,
  clipped: false,
};
export const visualPngFixture = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf4kAAAAASUVORK5CYII=",
  "base64",
);
export async function visualFrameFixture(
  sequence = 1,
): Promise<ActivityVisualFrame> {
  return {
    actor: "user",
    bytes: visualPngFixture,
    width: 1,
    height: 1,
    visual: {
      surface: visualSurfaceFixture,
      capturedAt: "2026-08-10T12:00:00.000Z",
      receivedAt: "2026-08-10T12:00:00.010Z",
      contentRevision: await visualContentRevision(visualPngFixture),
      sequence,
      coalescedFrames: 0,
      trigger: "foreground",
      redactedRegions: 0,
      ocr: {
        engine: "apple_vision",
        revision: 3,
        languages: ["zh-Hans", "en-US"],
        status: "empty",
        lines: [],
      },
    },
  };
}
