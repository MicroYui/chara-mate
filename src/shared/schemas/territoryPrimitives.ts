import { Type } from "@sinclair/typebox";

export const TerritoryRotationSchema = Type.Union([
  Type.Literal(0),
  Type.Literal(90),
  Type.Literal(180),
  Type.Literal(270),
]);
