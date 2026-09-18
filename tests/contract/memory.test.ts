import { describe, expect, it } from "vitest";

import { MEMORY_CHANNELS } from "../../src/shared/contracts/memory";
import { IpcChannelSchema } from "../../src/shared/schemas/ipc";
import {
  MemoryCreateRequestSchema,
  MemoryListRequestSchema,
  MemoryRevisionSchema,
  MemoryReviseRequestSchema,
} from "../../src/shared/schemas/memory";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";

const parsers = [parseSchema, parseSchemaWithoutCodeGeneration] as const;
const memoryId = "10000000-0000-4000-8000-000000000001";

describe("Memory boundary contracts", () => {
  it.each(parsers)(
    "accepts owned claim filters and free-content memory creation through %s",
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
        parse(MemoryCreateRequestSchema, {
          confidence: 1,
          content: "用户喜欢科幻电影。",
          importance: 0.5,
          reason: "用户手动创建",
          sources: [],
          type: "preference",
        }),
      ).not.toHaveProperty("claimSlot");
    },
  );

  it.each(parsers)("rejects unknown claim slots through %s", (parse) => {
    expect(() =>
      parse(MemoryListRequestSchema, {
        claimSlot: "preference.favorite_games",
      }),
    ).toThrow();
  });

  it.each(parsers)(
    "keeps event time paired on requests and revisions through %s",
    (parse) => {
      const timedCreate = {
        confidence: 1,
        content: "用户明天下午三点有重要的演示。",
        importance: 0.9,
        importantMoment: true,
        occursAt: "2026-09-02T07:00:00.000Z",
        reason: "用户明确说明",
        sources: [],
        timeZone: "Asia/Shanghai",
        type: "event",
      } as const;
      expect(parse(MemoryCreateRequestSchema, timedCreate)).toMatchObject({
        occursAt: timedCreate.occursAt,
        timeZone: timedCreate.timeZone,
      });
      expect(() =>
        parse(MemoryCreateRequestSchema, {
          ...timedCreate,
          timeZone: undefined,
        }),
      ).toThrow();
      expect(
        parse(MemoryReviseRequestSchema, {
          content: "用户的演示已经取消。",
          importantMoment: false,
          memoryId,
          occursAt: null,
          reason: "用户明确取消",
          sources: [],
          timeZone: null,
        }),
      ).toMatchObject({ occursAt: null, timeZone: null });

      const revision = {
        content: timedCreate.content,
        createdAt: "2026-09-01T12:00:00.000Z",
        id: "10000000-0000-4000-8000-000000000002",
        importantMoment: true,
        memoryId,
        occursAt: timedCreate.occursAt,
        priorDispositions: [],
        historyStatus: "current",
        reason: timedCreate.reason,
        sourceIds: [],
        sourceType: "chat",
        timeZone: timedCreate.timeZone,
      } as const;
      expect(parse(MemoryRevisionSchema, revision)).toMatchObject({
        importantMoment: true,
        occursAt: timedCreate.occursAt,
      });
      expect(() =>
        parse(MemoryRevisionSchema, { ...revision, timeZone: undefined }),
      ).toThrow();
    },
  );
});
