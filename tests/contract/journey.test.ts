import type { TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { JOURNEY_CHANNELS } from "../../src/shared/contracts/journey";
import {
  JourneyDetailResponseSchema,
  JourneyDetailSchema,
  JourneyIdRequestSchema,
  JourneyMomentSchema,
  JourneyMutationResponseSchema,
  JourneySchema,
  JourneySetStatusRequestSchema,
  JourneySnapshotRequestSchema,
  JourneySnapshotResponseSchema,
  JourneySnapshotSchema,
  TogetherSessionSchema,
  TogetherSessionSetStatusRequestSchema,
} from "../../src/shared/schemas/journey";
import { IpcChannelSchema } from "../../src/shared/schemas/ipc";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";

const NOW = "2026-08-13T09:00:00.000Z";
const JOURNEY_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const MOMENT_ID = "44444444-4444-4444-8444-444444444444";
const MEMORY_ID = "55555555-5555-4555-8555-555555555555";

const journey = {
  createdAt: NOW,
  currentPosition: "正在整理研究问题",
  homeChatId: CHAT_ID,
  id: JOURNEY_ID,
  nextStep: "继续阅读相关论文",
  purpose: "完成未来几个月的毕业论文",
  status: "active",
  title: "毕业论文",
  updatedAt: NOW,
} as const;

const session = {
  chatId: CHAT_ID,
  createdAt: NOW,
  id: SESSION_ID,
  journeyId: JOURNEY_ID,
  status: "active",
  title: "一起整理研究问题",
  updatedAt: NOW,
} as const;

const moment = {
  content: "确定先收窄研究问题。",
  createdAt: NOW,
  id: MOMENT_ID,
  journeyId: JOURNEY_ID,
  kind: "memory",
  memoryId: MEMORY_ID,
  occurredAt: NOW,
  sessionId: SESSION_ID,
} as const;

const snapshot = {
  activeSession: session,
  journeys: [journey],
  sessions: [session],
};

const detail = { journey, moments: [moment], sessions: [session] };

const validCases: readonly (readonly [string, TSchema, unknown])[] = [
  ["Journey", JourneySchema, journey],
  ["Together Session", TogetherSessionSchema, session],
  ["Journey moment", JourneyMomentSchema, moment],
  ["Journey snapshot", JourneySnapshotSchema, snapshot],
  ["Journey detail", JourneyDetailSchema, detail],
  ["Snapshot request", JourneySnapshotRequestSchema, {}],
  ["Journey ID request", JourneyIdRequestSchema, { journeyId: JOURNEY_ID }],
  [
    "Journey status request",
    JourneySetStatusRequestSchema,
    { journeyId: JOURNEY_ID, status: "paused" },
  ],
  [
    "Session status request",
    TogetherSessionSetStatusRequestSchema,
    {
      resumeNote: "下次从研究问题继续",
      sessionId: SESSION_ID,
      status: "paused",
    },
  ],
  [
    "Snapshot response",
    JourneySnapshotResponseSchema,
    { ok: true, value: snapshot },
  ],
  ["Detail response", JourneyDetailResponseSchema, { ok: true, value: detail }],
  [
    "Mutation response",
    JourneyMutationResponseSchema,
    { ok: true, value: snapshot },
  ],
];

describe("Journey and Together Session contracts", () => {
  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts every Journey IPC channel through %s",
    (parse) => {
      for (const channel of Object.values(JOURNEY_CHANNELS)) {
        expect(parse(IpcChannelSchema, channel)).toBe(channel);
      }
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "round-trips every valid boundary value through %s",
    (parse) => {
      for (const [, schema, value] of validCases) {
        expect(parse(schema, value)).toEqual(value);
      }
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts lifecycle projections and rejects hidden state through %s",
    (parse) => {
      expect(() =>
        parse(JourneySchema, {
          ...journey,
          pausedAt: NOW,
          status: "paused",
        }),
      ).not.toThrow();
      expect(() =>
        parse(TogetherSessionSchema, {
          ...session,
          endedAt: NOW,
          status: "ended",
        }),
      ).not.toThrow();
      expect(() =>
        parse(TogetherSessionSchema, {
          ...session,
          hiddenChatChoice: true,
        }),
      ).toThrow();
      expect(() =>
        parse(JourneySetStatusRequestSchema, {
          journeyId: JOURNEY_ID,
          status: "running",
        }),
      ).toThrow();
    },
  );
});
