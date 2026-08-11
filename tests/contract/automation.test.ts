import type { TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { AUTOMATION_CHANNELS } from "../../src/shared/contracts/automation";
import {
  AutomationCreateRequestSchema,
  AutomationCronExpressionSchema,
  AutomationDefinitionSchema,
  AutomationDetailResponseSchema,
  AutomationEventEnvelopeSchema,
  AutomationListResponseSchema,
  AutomationMutationResponseSchema,
  AutomationRunNowRequestSchema,
  AutomationRunNowResponseSchema,
  AutomationRunSchema,
  AutomationScheduleSchema,
  AutomationSchema,
  AutomationSetPausedRequestSchema,
  AutomationUpdateRequestSchema,
} from "../../src/shared/schemas/automation";
import { IpcChannelSchema } from "../../src/shared/schemas/ipc";
import { TimeZoneIdSchema } from "../../src/shared/schemas/primitives";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";
import {
  automationDefinitionFixture,
  automationFinishedEventFixture,
  automationFixture,
  AUTOMATION_FIXTURE_IDS,
  automationRunFixture,
} from "../fixtures/automations";
import { FIXTURE_TIMESTAMPS } from "../fixtures/foundationContracts";

const parsers = [parseSchema, parseSchemaWithoutCodeGeneration] as const;

const schedules = [
  { kind: "once", runAt: "2026-08-12T03:00:00.000Z" },
  { kind: "daily", localTime: "08:15", timeZone: "Asia/Shanghai" },
  {
    kind: "weekly",
    localTime: "18:30",
    timeZone: "America/New_York",
    weekdays: [1, 5],
  },
  {
    dialect: "posix-5-field",
    expression: "15 3 * * 1-5",
    kind: "cron",
    timeZone: "UTC",
  },
] as const;

const validCases: readonly (readonly [string, TSchema, unknown])[] = [
  ...schedules.map(
    (schedule, index) =>
      [`Schedule ${index + 1}`, AutomationScheduleSchema, schedule] as const,
  ),
  ["Definition", AutomationDefinitionSchema, automationDefinitionFixture],
  ["Automation", AutomationSchema, automationFixture],
  ["Run", AutomationRunSchema, automationRunFixture],
  [
    "Event envelope",
    AutomationEventEnvelopeSchema,
    automationFinishedEventFixture,
  ],
  [
    "Create request",
    AutomationCreateRequestSchema,
    {
      definition: automationDefinitionFixture,
      requestedAt: FIXTURE_TIMESTAMPS.updated,
    },
  ],
  [
    "Update request",
    AutomationUpdateRequestSchema,
    {
      automationId: AUTOMATION_FIXTURE_IDS.automation,
      definition: automationDefinitionFixture,
      expectedRevision: 2,
      requestedAt: FIXTURE_TIMESTAMPS.updated,
    },
  ],
  [
    "Pause request",
    AutomationSetPausedRequestSchema,
    {
      automationId: AUTOMATION_FIXTURE_IDS.automation,
      expectedRevision: 2,
      paused: true,
      requestedAt: FIXTURE_TIMESTAMPS.updated,
    },
  ],
  [
    "Run now request",
    AutomationRunNowRequestSchema,
    {
      automationId: AUTOMATION_FIXTURE_IDS.automation,
      requestedAt: FIXTURE_TIMESTAMPS.updated,
    },
  ],
  [
    "List response",
    AutomationListResponseSchema,
    {
      ok: true,
      value: {
        items: [
          { automation: automationFixture, recentRun: automationRunFixture },
        ],
      },
    },
  ],
  [
    "Detail response",
    AutomationDetailResponseSchema,
    {
      ok: true,
      value: { automation: automationFixture, runs: [automationRunFixture] },
    },
  ],
  [
    "Mutation response",
    AutomationMutationResponseSchema,
    { ok: true, value: automationFixture },
  ],
  [
    "Run now response",
    AutomationRunNowResponseSchema,
    { ok: true, value: automationRunFixture },
  ],
];

describe("Phase 5 Automation contracts", () => {
  it.each(parsers)(
    "accepts every Automation IPC channel through %s",
    (parse) => {
      for (const channel of Object.values(AUTOMATION_CHANNELS)) {
        expect(parse(IpcChannelSchema, channel)).toBe(channel);
      }
    },
  );

  it.each(parsers)(
    "round-trips every valid boundary value through %s",
    (parse) => {
      for (const [, schema, value] of validCases) {
        expect(parse(schema, value)).toEqual(value);
      }
    },
  );

  it.each(parsers)(
    "uses runtime-recognized IANA time zones through %s",
    (parse) => {
      expect(parse(TimeZoneIdSchema, "Asia/Shanghai")).toBe("Asia/Shanghai");
      expect(parse(TimeZoneIdSchema, "UTC")).toBe("UTC");
      expect(() => parse(TimeZoneIdSchema, "Mars/Olympus_Mons")).toThrow();
    },
  );

  it.each(parsers)(
    "keeps Cron to five scheduling fields through %s",
    (parse) => {
      expect(parse(AutomationCronExpressionSchema, "0 9 * * 1-5")).toBe(
        "0 9 * * 1-5",
      );
      for (const expression of [
        "0 9 * *",
        "0 9 * * 1 echo-dangerous-command",
        "0 9 * * 1\nnext-line",
      ]) {
        expect(() =>
          parse(AutomationCronExpressionSchema, expression),
        ).toThrow();
      }
    },
  );

  it.each(parsers)(
    "rejects invalid weekly calendar values through %s",
    (parse) => {
      for (const schedule of [
        { ...schedules[2], localTime: "24:00" },
        { ...schedules[2], weekdays: [0] },
        { ...schedules[2], weekdays: [1, 1] },
      ]) {
        expect(() => parse(AutomationScheduleSchema, schedule)).toThrow();
      }
    },
  );

  it.each(parsers)(
    "keeps active scheduling and persisted Agent configuration strict through %s",
    (parse) => {
      const withoutNextRun = {
        createdAt: automationFixture.createdAt,
        definition: automationFixture.definition,
        id: automationFixture.id,
        revision: automationFixture.revision,
        state: automationFixture.state,
        updatedAt: automationFixture.updatedAt,
      };
      expect(() => parse(AutomationSchema, withoutNextRun)).toThrow();
      expect(() =>
        parse(AutomationSchema, {
          ...automationFixture,
          state: "paused",
        }),
      ).toThrow();
      expect(() =>
        parse(AutomationDefinitionSchema, {
          ...automationDefinitionFixture,
          task: {
            ...automationDefinitionFixture.task,
            apiKey: "sk-must-not-persist",
          },
        }),
      ).toThrow();
      expect(() =>
        parse(AutomationDefinitionSchema, {
          ...automationDefinitionFixture,
          task: {
            ...automationDefinitionFixture.task,
            toolScope: {
              mode: "selected",
              toolNames: ["memory.search", "memory.search"],
            },
          },
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "keeps run lifecycle and finished-event errors aligned with SQLite through %s",
    (parse) => {
      const runWithoutChat = { ...automationRunFixture } as Record<
        string,
        unknown
      >;
      delete runWithoutChat["chatId"];
      expect(() => parse(AutomationRunSchema, runWithoutChat)).toThrow();
      expect(() =>
        parse(AutomationRunSchema, {
          ...automationRunFixture,
          endedAt: FIXTURE_TIMESTAMPS.updated,
        }),
      ).toThrow();
      expect(() =>
        parse(AutomationRunSchema, {
          ...automationRunFixture,
          endedAt: FIXTURE_TIMESTAMPS.updated,
          status: "failed",
        }),
      ).toThrow();
      expect(() =>
        parse(AutomationEventEnvelopeSchema, {
          ...automationFinishedEventFixture,
          event: {
            ...automationFinishedEventFixture.event,
            status: "failed",
          },
        }),
      ).toThrow();
    },
  );
});
