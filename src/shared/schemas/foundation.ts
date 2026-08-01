import { Type } from "@sinclair/typebox";

export const FoundationRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

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
  { additionalProperties: false },
);
