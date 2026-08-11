import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Automation,
  AutomationApi,
  AutomationDefinition,
  AutomationEventEnvelope,
  AutomationRun,
} from "../../../shared/contracts/automation";
import {
  AUTOMATION_FIXTURE_IDS,
  automationFixture,
  automationRunFixture,
} from "../../../../tests/fixtures/automations";
import {
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
} from "../../../../tests/fixtures/foundationContracts";
import { AutomationsPage } from "./AutomationsPage";

const NOW = "2026-08-11T04:00:00.000Z";
const CREATED_AUTOMATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MANUAL_RUN_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const models = [
  {
    label: "GPT Example · Local provider",
    modelId: "gpt-example",
    providerProfileId: FIXTURE_IDS.provider,
  },
] as const;

const personas = [
  { id: AUTOMATION_FIXTURE_IDS.persona, label: "Mika" },
] as const;

afterEach(cleanup);

function activeAutomation(
  definition: AutomationDefinition,
  id = CREATED_AUTOMATION_ID,
  revision = 1,
): Automation {
  return {
    createdAt: NOW,
    definition,
    id,
    nextRunAt:
      definition.schedule.kind === "once"
        ? definition.schedule.runAt
        : "2026-08-12T01:00:00.000Z",
    revision,
    state: "active",
    updatedAt: NOW,
  };
}

function makeApi({
  automation = automationFixture,
  runs = [automationRunFixture],
}: {
  readonly automation?: Automation | null;
  readonly runs?: readonly AutomationRun[];
} = {}) {
  let current: Automation | null = automation;
  let currentRuns = [...runs];
  let listener: ((event: AutomationEventEnvelope) => void) | undefined;

  const list = vi.fn<AutomationApi["list"]>(() =>
    Promise.resolve({
      ok: true,
      value: {
        items: current
          ? [
              {
                automation: current,
                ...(currentRuns[0] ? { recentRun: currentRuns[0] } : {}),
              },
            ]
          : [],
      },
    }),
  );
  const get = vi.fn<AutomationApi["get"]>(() =>
    current
      ? Promise.resolve({
          ok: true,
          value: { automation: current, runs: currentRuns },
        })
      : Promise.resolve({
          error: {
            code: "AUTOMATION.NOT_FOUND",
            message: "任务不存在。",
            retryable: false,
          },
          ok: false,
        }),
  );
  const create = vi.fn<AutomationApi["create"]>((request) => {
    const next = activeAutomation(request.definition);
    current = next;
    currentRuns = [];
    return Promise.resolve({ ok: true, value: next });
  });
  const update = vi.fn<AutomationApi["update"]>((request) => {
    if (!current) throw new Error("Missing Automation");
    const base = {
      createdAt: current.createdAt,
      definition: request.definition,
      id: current.id,
      revision: current.revision + 1,
      updatedAt: request.requestedAt,
    };
    const next: Automation =
      current.state === "active"
        ? { ...base, nextRunAt: current.nextRunAt, state: "active" }
        : { ...base, state: current.state };
    current = next;
    return Promise.resolve({ ok: true, value: next });
  });
  const setPaused = vi.fn<AutomationApi["setPaused"]>((request) => {
    if (!current) throw new Error("Missing Automation");
    const base = {
      createdAt: current.createdAt,
      definition: current.definition,
      id: current.id,
      revision: current.revision + 1,
      updatedAt: request.requestedAt,
    };
    const next: Automation = request.paused
      ? { ...base, state: "paused" }
      : {
          ...base,
          nextRunAt: "2026-08-12T01:00:00.000Z",
          state: "active",
        };
    current = next;
    return Promise.resolve({ ok: true, value: next });
  });
  const runNow = vi.fn<AutomationApi["runNow"]>((request) => {
    if (!current) throw new Error("Missing Automation");
    const run = {
      automationId: current.id,
      automationRevision: current.revision,
      createdAt: request.requestedAt,
      definition: current.definition,
      id: MANUAL_RUN_ID,
      requestedAt: request.requestedAt,
      status: "queued",
      trigger: { kind: "manual" },
      updatedAt: request.requestedAt,
    } satisfies AutomationRun;
    currentRuns = [run, ...currentRuns];
    return Promise.resolve({ ok: true, value: run });
  });
  const api: AutomationApi = {
    create,
    get,
    list,
    runNow,
    setPaused,
    subscribe: vi.fn<AutomationApi["subscribe"]>((nextListener) => {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = undefined;
      };
    }),
    update,
  };

  return {
    api,
    create,
    emit: (event: AutomationEventEnvelope) => listener?.(event),
    get,
    list,
    runNow,
    setPaused,
    update,
  };
}

function renderPage(api: AutomationApi, onOpenChatRun = vi.fn()) {
  render(
    <AutomationsPage
      api={api}
      models={models}
      now={() => new Date(NOW)}
      onOpenChatRun={onOpenChatRun}
      personas={personas}
    />,
  );
  return onOpenChatRun;
}

describe("AutomationsPage", () => {
  it("shows schedule, state and latest result, then opens the linked Chat Run", async () => {
    const { api, get } = makeApi();
    const onOpenChatRun = renderPage(api);

    expect(await screen.findByText("每周项目回顾")).toBeVisible();
    expect(screen.getByText(/周五 18:30 · Asia\/Shanghai/u)).toBeVisible();
    expect(screen.getByText("等待确认")).toBeVisible();
    expect(screen.getByText("等待你在 Chat 中确认后继续。")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "查看 每周项目回顾" }));
    const detail = await screen.findByRole("region", { name: "任务详情" });
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith({
        automationId: AUTOMATION_FIXTURE_IDS.automation,
      }),
    );
    fireEvent.click(
      within(detail).getByRole("button", { name: /等待确认 ·/u }),
    );

    expect(onOpenChatRun).toHaveBeenCalledWith(
      FIXTURE_IDS.chat,
      FIXTURE_IDS.run,
    );
  });

  it("creates a daily Reminder from the empty state", async () => {
    const { api, create } = makeApi({ automation: null, runs: [] });
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: "新建任务" }));
    const form = screen.getByRole("region", { name: "新建定时任务" });
    fireEvent.change(within(form).getByLabelText("名称"), {
      target: { value: "喝水提醒" },
    });
    fireEvent.click(within(form).getByRole("radio", { name: /提醒/u }));
    fireEvent.change(within(form).getByLabelText("提醒内容"), {
      target: { value: "起来活动并喝一杯水。" },
    });
    fireEvent.click(within(form).getByRole("checkbox", { name: /语音播报/u }));
    fireEvent.change(within(form).getByLabelText("重复方式"), {
      target: { value: "daily" },
    });
    fireEvent.change(within(form).getByLabelText("本地时间"), {
      target: { value: "09:15" },
    });
    fireEvent.change(within(form).getByLabelText("时区"), {
      target: { value: "Asia/Shanghai" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "创建任务" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        definition: {
          name: "喝水提醒",
          schedule: {
            kind: "daily",
            localTime: "09:15",
            timeZone: "Asia/Shanghai",
          },
          task: {
            delivery: "bubble_and_voice",
            kind: "reminder",
            message: "起来活动并喝一杯水。",
          },
        },
        requestedAt: NOW,
      }),
    );
    expect(await screen.findByText("任务已创建。")).toBeVisible();
    expect(screen.getByRole("button", { name: "查看 喝水提醒" })).toBeVisible();
  });

  it("creates a weekly Agent Task with an explicit approval mode", async () => {
    const { api, create } = makeApi({ automation: null, runs: [] });
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: "新建任务" }));
    const form = screen.getByRole("region", { name: "新建定时任务" });
    fireEvent.change(within(form).getByLabelText("名称"), {
      target: { value: "双周计划" },
    });
    fireEvent.change(within(form).getByLabelText("目标"), {
      target: { value: "整理下一阶段行动。" },
    });
    fireEvent.click(within(form).getByRole("radio", { name: "Agent" }));
    fireEvent.change(within(form).getByLabelText("执行权限"), {
      target: { value: "full_access" },
    });
    fireEvent.change(within(form).getByLabelText("重复方式"), {
      target: { value: "weekly" },
    });
    fireEvent.change(within(form).getByLabelText("本地时间"), {
      target: { value: "18:30" },
    });
    fireEvent.click(within(form).getByRole("checkbox", { name: "一" }));
    fireEvent.click(within(form).getByRole("checkbox", { name: "五" }));
    fireEvent.change(within(form).getByLabelText("时区"), {
      target: { value: "Asia/Shanghai" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "创建任务" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        definition: {
          name: "双周计划",
          schedule: {
            kind: "weekly",
            localTime: "18:30",
            timeZone: "Asia/Shanghai",
            weekdays: [1, 5],
          },
          task: {
            execution: { approvalMode: "full_access", mode: "agent" },
            goal: "整理下一阶段行动。",
            kind: "agent_task",
            modelId: "gpt-example",
            personaId: AUTOMATION_FIXTURE_IDS.persona,
            providerProfileId: FIXTURE_IDS.provider,
            toolScope: { mode: "all_allowed" },
          },
        },
        requestedAt: NOW,
      }),
    );
  });

  it("pauses, runs now and edits with the current revision", async () => {
    const { api, runNow, setPaused, update } = makeApi();
    renderPage(api);
    await screen.findByText("每周项目回顾");

    fireEvent.click(screen.getByRole("button", { name: "暂停 每周项目回顾" }));
    await waitFor(() =>
      expect(setPaused).toHaveBeenCalledWith({
        automationId: AUTOMATION_FIXTURE_IDS.automation,
        expectedRevision: 2,
        paused: true,
        requestedAt: NOW,
      }),
    );
    expect(await screen.findByText("任务已暂停。")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "立即试跑 每周项目回顾" }),
    );
    await waitFor(() =>
      expect(runNow).toHaveBeenCalledWith({
        automationId: AUTOMATION_FIXTURE_IDS.automation,
        requestedAt: NOW,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑 每周项目回顾" }));
    const form = screen.getByRole("region", { name: "编辑定时任务" });
    fireEvent.change(within(form).getByLabelText("名称"), {
      target: { value: "每周交付回顾" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      automationId: AUTOMATION_FIXTURE_IDS.automation,
      expectedRevision: 3,
      requestedAt: NOW,
    });
    expect(update.mock.calls[0]?.[0].definition.name).toBe("每周交付回顾");
  });

  it("validates five-field Cron and refreshes after an Automation event", async () => {
    const { api, create, emit, list } = makeApi({
      automation: null,
      runs: [],
    });
    renderPage(api);
    fireEvent.click(await screen.findByRole("button", { name: "新建任务" }));
    const form = screen.getByRole("region", { name: "新建定时任务" });
    fireEvent.change(within(form).getByLabelText("名称"), {
      target: { value: "工作日提醒" },
    });
    fireEvent.click(within(form).getByRole("radio", { name: /提醒/u }));
    fireEvent.change(within(form).getByLabelText("提醒内容"), {
      target: { value: "查看今日计划。" },
    });
    fireEvent.change(within(form).getByLabelText("重复方式"), {
      target: { value: "cron" },
    });
    fireEvent.change(within(form).getByLabelText("POSIX 五段 Cron"), {
      target: { value: "0 9 * *" },
    });
    fireEvent.change(within(form).getByLabelText("时区"), {
      target: { value: "Asia/Shanghai" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "创建任务" }));
    expect(
      await within(form).findByText("Cron 需要且只接受五个调度字段。"),
    ).toBeVisible();
    expect(create).not.toHaveBeenCalled();

    emit({
      event: {
        automation: automationFixture,
        type: "automation.changed",
      },
      eventId: "abababab-abab-4bab-8bab-abababababab",
      occurredAt: FIXTURE_TIMESTAMPS.updated,
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});
