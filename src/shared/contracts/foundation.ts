import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";

export const FOUNDATION_CHANNELS = {
  getSnapshot: "app.foundation.getSnapshot",
  rendererReady: "app.foundation.rendererReady",
} as const;

export const FoundationSnapshotSchema = Type.Object(
  {
    appName: Type.Literal("CharaMate"),
    appVersion: Type.String({ minLength: 1 }),
    databaseRoundTrip: Type.Literal(true),
    electronVersion: Type.String({ minLength: 1 }),
    nodeVersion: Type.String({ minLength: 1 }),
    platform: Type.Union([
      Type.Literal("darwin"),
      Type.Literal("linux"),
      Type.Literal("win32"),
    ]),
  },
  { additionalProperties: false, $id: "FoundationSnapshot" },
);

export type FoundationSnapshot = Static<typeof FoundationSnapshotSchema>;

export interface FoundationApi {
  getSnapshot(): Promise<FoundationSnapshot>;
  markRendererReady(): void;
}

export interface DesktopApi {
  foundation: FoundationApi;
}
