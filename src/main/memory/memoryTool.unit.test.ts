import { describe, expect, it } from "vitest";

import { parseSchema } from "../../shared/schemas/validation";
import { MemoryFormationInputSchema } from "./memoryTool";

describe("Memory formation Tool schema", () => {
  it("requires closed slots for profile and preference memories", () => {
    expect(
      parseSchema(MemoryFormationInputSchema, {
        basis: "explicit_user_statement",
        claimSlot: "preference.hobbies",
        content: "用户的爱好是徒步。",
        operation: "create",
      }),
    ).toMatchObject({ claimSlot: "preference.hobbies" });

    expect(() =>
      parseSchema(MemoryFormationInputSchema, {
        basis: "explicit_user_statement",
        content: "用户的爱好是徒步。",
        operation: "create",
        type: "preference",
      }),
    ).toThrow(/rejected value/u);
  });

  it("keeps unscoped durable types and update operations explicit", () => {
    expect(
      parseSchema(MemoryFormationInputSchema, {
        basis: "explicit_user_statement",
        content: "Lantern 计划六月发布。",
        operation: "replace",
        type: "project",
      }),
    ).toMatchObject({ operation: "replace", type: "project" });

    expect(() =>
      parseSchema(MemoryFormationInputSchema, {
        basis: "explicit_user_statement",
        claimSlot: "preference.hobbies",
        content: "用户的爱好是徒步。",
        memoryId: "10000000-0000-4000-8000-000000000001",
        operation: "replace",
      }),
    ).toThrow(/rejected value/u);
  });

  it("keeps timed memories paired and resolves updates through content hints", () => {
    expect(
      parseSchema(MemoryFormationInputSchema, {
        basis: "explicit_user_statement",
        content: "用户明天下午三点有重要的演示。",
        importantMoment: true,
        occursAt: "2026-09-02T07:00:00.000Z",
        operation: "create",
        timeZone: "Asia/Shanghai",
        type: "event",
      }),
    ).toMatchObject({ importantMoment: true, type: "event" });

    expect(
      parseSchema(MemoryFormationInputSchema, {
        basis: "explicit_user_statement",
        content: "用户的演示已取消。",
        importantMoment: false,
        occursAt: null,
        operation: "replace",
        targetHint: "用户明天下午三点有重要的演示。",
        timeZone: null,
        type: "event",
      }),
    ).toMatchObject({
      occursAt: null,
      targetHint: "用户明天下午三点有重要的演示。",
    });

    expect(() =>
      parseSchema(MemoryFormationInputSchema, {
        basis: "explicit_user_statement",
        content: "用户明天下午三点有演示。",
        importantMoment: false,
        occursAt: "2026-09-02T07:00:00.000Z",
        operation: "create",
        type: "event",
      }),
    ).toThrow(/rejected value/u);

    expect(() =>
      parseSchema(MemoryFormationInputSchema, {
        basis: "explicit_user_statement",
        content: "用户的演示改到四点。",
        importantMoment: true,
        operation: "replace",
        type: "event",
      }),
    ).toThrow(/rejected value/u);

    expect(() =>
      parseSchema(MemoryFormationInputSchema, {
        basis: "explicit_user_statement",
        content: "Lantern 计划六月发布。",
        importantMoment: true,
        operation: "create",
        type: "project",
      }),
    ).toThrow(/rejected value/u);
  });
});
