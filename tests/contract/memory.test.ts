import { describe, expect, it } from "vitest";

import { MEMORY_CHANNELS } from "../../src/shared/contracts/memory";
import { IpcChannelSchema } from "../../src/shared/schemas/ipc";
import {
  MemoryCreateRequestSchema,
  MemoryListRequestSchema,
  MemoryResolveClaimRequestSchema,
} from "../../src/shared/schemas/memory";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";

const parsers = [parseSchema, parseSchemaWithoutCodeGeneration] as const;
const memoryId = "10000000-0000-4000-8000-000000000001";

describe("Memory boundary contracts", () => {
  it.each(parsers)(
    "accepts stable claim filters and explicit resolution through %s",
    (parse) => {
      for (const channel of Object.values(MEMORY_CHANNELS)) {
        expect(parse(IpcChannelSchema, channel)).toBe(channel);
      }
      expect(
        parse(MemoryListRequestSchema, {
          claimSlot: "preference.hobbies",
          status: "active",
        }),
      ).toEqual({ claimSlot: "preference.hobbies", status: "active" });
      expect(
        parse(MemoryCreateRequestSchema, {
          claimSlot: "preference.hobbies",
          confidence: 1,
          content: "用户喜欢玩 CS2。",
          importance: 0.8,
          reason: "用户手动创建",
          sources: [],
          type: "preference",
        }),
      ).toMatchObject({ claimSlot: "preference.hobbies" });
      expect(
        parse(MemoryResolveClaimRequestSchema, {
          claimSlot: "preference.hobbies",
          content: "用户喜欢玩 CS2，也喜欢胶片摄影。",
          memoryId,
        }),
      ).toMatchObject({ memoryId });
    },
  );

  it.each(parsers)("rejects unknown claim slots through %s", (parse) => {
    expect(() =>
      parse(MemoryResolveClaimRequestSchema, {
        claimSlot: "preference.favorite_games",
        content: "用户喜欢玩 CS2。",
        memoryId,
      }),
    ).toThrow();
  });
});
