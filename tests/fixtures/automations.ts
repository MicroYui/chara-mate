import type {
  Automation,
  AutomationDefinition,
  AutomationEventEnvelope,
  AutomationRun,
} from "../../src/shared/contracts/automation";
import { FIXTURE_IDS, FIXTURE_TIMESTAMPS } from "./foundationContracts";

export const AUTOMATION_FIXTURE_IDS = {
  automation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  event: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  persona: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  run: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;

export const automationDefinitionFixture = {
  name: "每周项目回顾",
  schedule: {
    kind: "weekly",
    localTime: "18:30",
    timeZone: "Asia/Shanghai",
    weekdays: [5],
  },
  task: {
    execution: {
      approvalMode: "request_approval",
      mode: "agent",
    },
    goal: "总结本周项目进展并列出下周行动。",
    kind: "agent_task",
    modelId: "gpt-example",
    personaId: AUTOMATION_FIXTURE_IDS.persona,
    providerProfileId: FIXTURE_IDS.provider,
    toolScope: {
      mode: "selected",
      toolNames: ["memory.search", "browser.snapshot"],
    },
  },
} satisfies AutomationDefinition;

export const automationFixture = {
  createdAt: FIXTURE_TIMESTAMPS.created,
  definition: automationDefinitionFixture,
  id: AUTOMATION_FIXTURE_IDS.automation,
  nextRunAt: "2026-08-14T10:30:00.000Z",
  revision: 2,
  state: "active",
  updatedAt: FIXTURE_TIMESTAMPS.updated,
} satisfies Automation;

export const automationRunFixture = {
  automationId: AUTOMATION_FIXTURE_IDS.automation,
  automationRevision: automationFixture.revision,
  chatId: FIXTURE_IDS.chat,
  createdAt: FIXTURE_TIMESTAMPS.created,
  definition: automationDefinitionFixture,
  id: AUTOMATION_FIXTURE_IDS.run,
  requestedAt: FIXTURE_TIMESTAMPS.created,
  runId: FIXTURE_IDS.run,
  startedAt: FIXTURE_TIMESTAMPS.created,
  status: "waiting_approval",
  trigger: {
    kind: "scheduled",
    scheduledFor: FIXTURE_TIMESTAMPS.created,
  },
  updatedAt: FIXTURE_TIMESTAMPS.updated,
} satisfies AutomationRun;

export const automationFinishedEventFixture = {
  event: {
    automationId: AUTOMATION_FIXTURE_IDS.automation,
    automationRevision: automationFixture.revision,
    automationRunId: AUTOMATION_FIXTURE_IDS.run,
    chatId: FIXTURE_IDS.chat,
    definition: automationDefinitionFixture,
    runId: FIXTURE_IDS.run,
    status: "completed",
    summary: "项目回顾已完成。",
    type: "automation.run.finished",
  },
  eventId: AUTOMATION_FIXTURE_IDS.event,
  occurredAt: FIXTURE_TIMESTAMPS.updated,
} satisfies AutomationEventEnvelope;
