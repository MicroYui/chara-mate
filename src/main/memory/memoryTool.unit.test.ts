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
        memoryId: "10000000-0000-4000-8000-000000000001",
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
        operation: "create",
      }),
    ).toThrow(/rejected value/u);
  });
});
