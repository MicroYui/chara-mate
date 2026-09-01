import { isDeepStrictEqual } from "node:util";

import type { StartRunRequest } from "../../shared/contracts/agent";
import type {
  Automation,
  AutomationCreateRequest,
  AutomationDetail,
  AutomationEvent,
  AutomationEventEnvelope,
  AutomationIdRequest,
  AutomationListSnapshot,
  AutomationRun,
  AutomationRunNowRequest,
  AutomationSetPausedRequest,
  AutomationUpdateRequest,
} from "../../shared/contracts/automation";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { Run } from "../../shared/contracts/run";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import type { PersonaSnapshot } from "../../shared/contracts/persona";
import {
  AutomationCreateRequestSchema,
  AutomationEventEnvelopeSchema,
  AutomationIdRequestSchema,
  AutomationRunNowRequestSchema,
  AutomationRunSchema,
  AutomationSetPausedRequestSchema,
  AutomationUpdateRequestSchema,
} from "../../shared/schemas/automation";
import { parseSchema } from "../../shared/schemas/validation";
import type { AgentRuntime } from "../agent/agentRuntime";
import type { ChatService } from "../chat/chatService";
import { AutomationError } from "./automationError";
import { automationDispatchError } from "./automationRepository";
import type { AutomationRepository } from "./automationRepository";
import {
  nextAutomationOccurrence,
  validateAutomationDefinition,
} from "./automationSchedule";

export interface AutomationEventPublisher {
  publish(envelope: AutomationEventEnvelope): void;
}

interface AutomationAgentRuntime {
  startAssistantInitiated(
    request: StartRunRequest,
    options: {
      readonly modelId: string;
      readonly onStarted?: (run: Run) => void;
      readonly persona: PersonaSnapshot;
      readonly toolNames?: readonly string[];
    },
  ): Promise<Run>;
  startAutomation(
    request: StartRunRequest,
    options: {
      readonly modelId: string;
      readonly persona: PersonaSnapshot;
      readonly toolNames?: readonly string[];
    },
  ): Promise<Run>;
}

export interface AutomationRunProjectionReader {
  getRun(runId: string): Run | undefined;
  listChatRuns(chatId: string): readonly Run[];
  readCompletedAssistantMessage(runId: string): string | undefined;
}

export interface AutomationPersonaReader {
  getActiveSnapshot(): PersonaSnapshot;
  getSnapshot(personaId: string): PersonaSnapshot;
}

const ACTIVE_AUTOMATION_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "needs_input",
] as const;

function terminalRunStatus(status: AutomationRun["status"]): boolean {
  return (
    status === "interrupted" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  );
}

type FinishedAutomationRunStatus = Extract<
  AutomationRun["status"],
  "completed" | "failed" | "cancelled"
>;

function finishedRunStatus(
  status: AutomationRun["status"],
): status is FinishedAutomationRunStatus {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function runChatId(run: AutomationRun): string | undefined {
  return "chatId" in run ? run.chatId : undefined;
}

function runtimeRunId(run: AutomationRun): string | undefined {
  return "runId" in run ? run.runId : undefined;
}

function runStartedAt(run: AutomationRun): string | undefined {
  return "startedAt" in run ? run.startedAt : undefined;
}

function runEndedAt(run: AutomationRun): string | undefined {
  return "endedAt" in run ? run.endedAt : undefined;
}

function runFields(run: AutomationRun): Record<string, unknown> {
  return {
    automationId: run.automationId,
    automationRevision: run.automationRevision,
    ...(runChatId(run) ? { chatId: runChatId(run) } : {}),
    createdAt: run.createdAt,
    definition: run.definition,
    ...(runStartedAt(run) ? { startedAt: runStartedAt(run) } : {}),
    ...(runtimeRunId(run) ? { runId: runtimeRunId(run) } : {}),
    ...(run.status === "failed" ? { error: run.error } : {}),
    ...(runEndedAt(run) ? { endedAt: runEndedAt(run) } : {}),
    id: run.id,
    persona: run.persona,
    requestedAt: run.requestedAt,
    status: run.status,
    ...(run.summary === undefined ? {} : { summary: run.summary }),
    trigger: run.trigger,
    updatedAt: run.updatedAt,
  };
}

function updateAutomationRun(
  current: AutomationRun,
  patch: Readonly<Record<string, unknown>>,
  remove: readonly string[] = [],
): AutomationRun {
  const value = { ...runFields(current), ...patch };
  for (const key of remove) delete value[key];
  return parseSchema(AutomationRunSchema, value);
}

export class AutomationService {
  readonly #dispatching = new Set<string>();
  #scheduleChanged: () => void = () => undefined;

  constructor(
    private readonly repository: AutomationRepository,
    private readonly chats: ChatService,
    private readonly runProjections: AutomationRunProjectionReader,
    private readonly agent: AutomationAgentRuntime | AgentRuntime,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly events: AutomationEventPublisher,
    private readonly personas: AutomationPersonaReader,
  ) {}

  setScheduleChangedListener(listener: () => void): void {
    this.#scheduleChanged = listener;
  }

  async initialize(): Promise<void> {
    await Promise.all(
      this.repository
        .listRunsByStatus(ACTIVE_AUTOMATION_RUN_STATUSES)
        .map((run) => this.#dispatch(run.id)),
    );
  }

  create(input: AutomationCreateRequest): Automation {
    const request = parseSchema(AutomationCreateRequestSchema, input);
    const now = this.clock.now();
    const { definition, nextRunAt } = validateAutomationDefinition(
      request.definition,
      now,
    );
    const automation = this.repository.insertAutomation({
      createdAt: now,
      definition,
      id: this.ids.generate(),
      nextRunAt,
      revision: 1,
      state: "active",
      updatedAt: now,
    });
    this.#publish({ automation, type: "automation.changed" });
    this.#scheduleChanged();
    return automation;
  }

  get(input: AutomationIdRequest): AutomationDetail {
    const request = parseSchema(AutomationIdRequestSchema, input);
    return this.repository.getDetail(request.automationId);
  }

  list(): AutomationListSnapshot {
    return this.repository.list();
  }

  update(input: AutomationUpdateRequest): Automation {
    const request = parseSchema(AutomationUpdateRequestSchema, input);
    const current = this.repository.requireAutomation(request.automationId);
    if (current.revision !== request.expectedRevision) {
      throw new AutomationError(
        "AUTOMATION.REVISION_CONFLICT",
        "定时任务已经被更新，请刷新后重试。",
        false,
      );
    }
    const now = this.clock.now();
    const validated = validateAutomationDefinition(request.definition, now);
    const next: Automation =
      current.state === "paused"
        ? {
            ...current,
            definition: validated.definition,
            revision: current.revision + 1,
            updatedAt: now,
          }
        : {
            ...current,
            definition: validated.definition,
            nextRunAt: validated.nextRunAt,
            revision: current.revision + 1,
            state: "active",
            updatedAt: now,
          };
    const updated = this.repository.replaceAutomation(
      next,
      request.expectedRevision,
    );
    this.#publish({ automation: updated, type: "automation.changed" });
    this.#scheduleChanged();
    return updated;
  }

  setPaused(input: AutomationSetPausedRequest): Automation {
    const request = parseSchema(AutomationSetPausedRequestSchema, input);
    const current = this.repository.requireAutomation(request.automationId);
    if (current.revision !== request.expectedRevision) {
      throw new AutomationError(
        "AUTOMATION.REVISION_CONFLICT",
        "定时任务已经被更新，请刷新后重试。",
        false,
      );
    }
    if (current.state === "completed") {
      throw new AutomationError(
        "AUTOMATION.INVALID_STATE",
        "已完成的一次性任务不能暂停或恢复；编辑时间后可重新启用。",
        false,
      );
    }
    if (
      (request.paused && current.state === "paused") ||
      (!request.paused && current.state === "active")
    ) {
      return current;
    }

    const now = this.clock.now();
    const next: Automation = request.paused
      ? {
          createdAt: current.createdAt,
          definition: current.definition,
          id: current.id,
          revision: current.revision,
          state: "paused",
          updatedAt: now,
        }
      : {
          ...current,
          nextRunAt:
            nextAutomationOccurrence(current.definition.schedule, now) ??
            (() => {
              throw new AutomationError(
                "AUTOMATION.INVALID_SCHEDULE",
                "一次性任务的运行时间已经过去，请先编辑时间。",
                false,
              );
            })(),
          state: "active",
          updatedAt: now,
        };
    const updated = this.repository.replaceAutomation(
      next,
      request.expectedRevision,
    );
    this.#publish({ automation: updated, type: "automation.changed" });
    this.#scheduleChanged();
    return updated;
  }

  runNow(input: AutomationRunNowRequest): AutomationRun {
    const request = parseSchema(AutomationRunNowRequestSchema, input);
    const automation = this.repository.requireAutomation(request.automationId);
    const run = this.repository.insertManualRun({
      automation,
      createdAt: this.clock.now(),
      persona: this.#personaFor(automation.definition),
      requestedAt: request.requestedAt,
      runId: this.ids.generate(),
    });
    this.#publishRun(run, false);
    void this.#dispatch(run.id);
    return run;
  }

  runDue(now = this.clock.now()): Promise<void> {
    for (const due of this.repository.listDue(now)) {
      if (due.state !== "active") continue;
      const nextRunAt =
        due.definition.schedule.kind === "once"
          ? undefined
          : nextAutomationOccurrence(due.definition.schedule, now);
      if (due.definition.schedule.kind !== "once" && !nextRunAt) {
        throw new AutomationError(
          "AUTOMATION.INVALID_SCHEDULE",
          "无法计算定时任务的下一次运行时间。",
          false,
        );
      }
      const claimed = this.repository.claimScheduled({
        automationId: due.id,
        claimedAt: now,
        expectedNextRunAt: due.nextRunAt,
        expectedRevision: due.revision,
        ...(nextRunAt ? { nextRunAt } : {}),
        persona: this.#personaFor(due.definition),
        runId: this.ids.generate(),
      });
      if (!claimed) continue;
      this.#publish({
        automation: claimed.automation,
        type: "automation.changed",
      });
      this.#publishRun(claimed.run, false);
      void this.#dispatch(claimed.run.id);
    }
    return Promise.resolve();
  }

  earliestNextRunAt(): string | undefined {
    return this.repository.earliestNextRunAt();
  }

  observeRun(_envelope: RunEventEnvelope): void {
    const linked = this.repository.getRunByRuntimeRunId(_envelope.streamId);
    if (!linked) return;
    const run = this.runProjections.getRun(_envelope.streamId);
    if (!run) return;
    this.#synchronizeRun(linked, run);
  }

  async #dispatch(automationRunId: string): Promise<void> {
    if (this.#dispatching.has(automationRunId)) return;
    this.#dispatching.add(automationRunId);
    try {
      const run = this.repository.getRun(automationRunId);
      if (!run || terminalRunStatus(run.status)) return;
      if (run.definition.task.kind === "reminder") {
        this.#completeReminder(run);
      } else {
        await this.#dispatchAgentTask(run);
      }
    } catch (error) {
      this.#failDispatch(automationRunId, error);
    } finally {
      this.#dispatching.delete(automationRunId);
    }
  }

  #completeReminder(current: AutomationRun): void {
    const task = current.definition.task;
    if (task.kind !== "reminder") return;
    const now = this.clock.now();
    const completed = this.repository.replaceRun(
      updateAutomationRun(current, {
        endedAt: now,
        startedAt: runStartedAt(current) ?? now,
        status: "completed",
        summary: task.message,
        updatedAt: now,
      }),
    );
    this.#publishRun(completed, true);
  }

  async #dispatchAgentTask(initial: AutomationRun): Promise<void> {
    if (initial.definition.task.kind !== "agent_task") return;
    const task = initial.definition.task;
    let current = this.repository.getRun(initial.id) ?? initial;
    const linkedRunId = runtimeRunId(current);
    if (linkedRunId) {
      const linked = this.runProjections.getRun(linkedRunId);
      if (linked) this.#synchronizeRun(current, linked);
      return;
    }

    let chatId = runChatId(current) ?? task.targetChatId;
    if (!chatId) {
      chatId = this.chats.create({ title: current.definition.name }).id;
      current = this.repository.replaceRun(
        updateAutomationRun(current, {
          chatId,
          updatedAt: this.clock.now(),
        }),
      );
      this.#publishRun(current, false);
    } else if (!runChatId(current)) {
      const target = this.chats.getSnapshot({ chatId });
      if (!target) {
        throw new AutomationError(
          "AUTOMATION.INVALID_STATE",
          "Agent Task 的目标会话不存在。",
          false,
        );
      }
      if (target.chat.status === "archived") {
        this.chats.restore({ chatId });
      }
      current = this.repository.replaceRun(
        updateAutomationRun(current, {
          chatId,
          updatedAt: this.clock.now(),
        }),
      );
      this.#publishRun(current, false);
    }

    const request = {
      attachments: [],
      chatId,
      content: task.goal,
      execution: task.execution,
      providerProfileId: task.providerProfileId,
      requestedAt: current.requestedAt,
    } satisfies StartRunRequest;
    const options = {
      modelId: task.modelId,
      persona: current.persona,
      ...(task.toolScope.mode === "selected"
        ? { toolNames: task.toolScope.toolNames }
        : {}),
    };
    let runtimeRun: Run;
    if (task.delivery === "assistant_message") {
      runtimeRun = await this.agent.startAssistantInitiated(request, {
        ...options,
        onStarted: (started) => {
          current = this.repository.replaceRun(
            updateAutomationRun(current, {
              chatId,
              runId: started.id,
              updatedAt: this.clock.now(),
            }),
          );
          this.#publishRun(current, false);
        },
      });
    } else {
      const chatRuns =
        task.targetChatId === undefined
          ? this.runProjections.listChatRuns(chatId)
          : [];
      const existing =
        chatRuns.find((run) =>
          ["queued", "running", "waiting_approval", "needs_input"].includes(
            run.status,
          ),
        ) ?? chatRuns[0];
      runtimeRun =
        existing ?? (await this.agent.startAutomation(request, options));
    }

    if (runtimeRunId(current) !== runtimeRun.id) {
      current = this.repository.replaceRun(
        updateAutomationRun(current, {
          chatId,
          runId: runtimeRun.id,
          updatedAt: this.clock.now(),
        }),
      );
      this.#publishRun(current, false);
    }
    this.#synchronizeRun(
      current,
      this.runProjections.getRun(runtimeRun.id) ?? runtimeRun,
    );
  }

  #personaFor(definition: Automation["definition"]): PersonaSnapshot {
    return definition.task.kind === "agent_task"
      ? this.personas.getSnapshot(definition.task.personaId)
      : this.personas.getActiveSnapshot();
  }

  #synchronizeRun(current: AutomationRun, run: Run): AutomationRun {
    const summary = current.summary;
    let next: AutomationRun;
    if (run.status === "queued") {
      next = updateAutomationRun(
        current,
        {
          chatId: run.chatId,
          runId: run.id,
          status: "queued",
        },
        ["endedAt", "error", "startedAt"],
      );
    } else {
      const effectiveStartedAt =
        run.startedAt ?? runStartedAt(current) ?? this.clock.now();
      const terminal =
        run.status === "interrupted" ||
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "cancelled";
      const nextSummary = terminal ? this.#runSummary(run) : summary;
      next = updateAutomationRun(
        current,
        {
          chatId: run.chatId,
          runId: run.id,
          startedAt: effectiveStartedAt,
          status: run.status,
          ...(terminal ? { endedAt: run.endedAt ?? this.clock.now() } : {}),
          ...(run.status === "failed"
            ? {
                error:
                  run.error ??
                  ({
                    code: "AUTOMATION.RUN_FAILED",
                    message: "Agent Task 运行失败。",
                    retryable: false,
                  } as const),
              }
            : {}),
          ...(nextSummary === undefined ? {} : { summary: nextSummary }),
        },
        [
          ...(terminal ? [] : ["endedAt"]),
          ...(run.status === "failed" ? [] : ["error"]),
          ...(nextSummary === undefined ? ["summary"] : []),
        ],
      );
    }
    const comparable = { ...next, updatedAt: current.updatedAt };
    if (isDeepStrictEqual(comparable, current)) return current;
    const updated = this.repository.replaceRun({
      ...next,
      updatedAt: this.clock.now(),
    });
    this.#publishRun(updated, finishedRunStatus(updated.status));
    return updated;
  }

  #runSummary(run: Run): string | undefined {
    if (run.status === "completed") {
      return this.runProjections.readCompletedAssistantMessage(run.id);
    }
    if (run.status === "failed" || run.status === "interrupted") {
      return run.error?.message;
    }
    if (run.status === "cancelled") return "任务已取消。";
    return undefined;
  }

  #failDispatch(automationRunId: string, error: unknown): void {
    const current = this.repository.getRun(automationRunId);
    if (!current || terminalRunStatus(current.status)) return;
    const now = this.clock.now();
    const appError = automationDispatchError(error);
    const failed = this.repository.replaceRun(
      updateAutomationRun(current, {
        endedAt: now,
        error: appError,
        startedAt: runStartedAt(current) ?? now,
        status: "failed",
        summary: appError.message,
        updatedAt: now,
      }),
    );
    this.#publishRun(failed, true);
  }

  #publishRun(run: AutomationRun, finished: boolean): void {
    this.#publish({ run, type: "automation.run.changed" });
    if (!finished || !finishedRunStatus(run.status)) return;
    const chatId = runChatId(run);
    const linkedRunId = runtimeRunId(run);
    const common = {
      automationId: run.automationId,
      automationRevision: run.automationRevision,
      automationRunId: run.id,
      ...(chatId ? { chatId } : {}),
      definition: run.definition,
      ...(linkedRunId ? { runId: linkedRunId } : {}),
      ...(run.summary === undefined ? {} : { summary: run.summary }),
      type: "automation.run.finished",
    } as const;
    if (run.status === "failed") {
      this.#publish({ ...common, error: run.error, status: "failed" }, run.id);
    } else {
      this.#publish({ ...common, status: run.status }, run.id);
    }
  }

  #publish(event: AutomationEvent, eventId = this.ids.generate()): void {
    this.events.publish(
      parseSchema(AutomationEventEnvelopeSchema, {
        event,
        eventId,
        occurredAt: this.clock.now(),
      }),
    );
  }
}
