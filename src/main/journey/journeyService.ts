import type { AutomationEvent } from "../../shared/contracts/automation";
import type {
  Journey,
  JourneyDetail,
  JourneyFollowUp,
  JourneyMoment,
  JourneyMomentKind,
  JourneySetStatusRequest,
  JourneySnapshot,
  TogetherSession,
  TogetherSessionSetStatusRequest,
} from "../../shared/contracts/journey";
import type { Run } from "../../shared/contracts/run";
import type { ProactiveConversationBubble } from "../../shared/contracts/pet";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import {
  JourneyIdRequestSchema,
  JourneySetStatusRequestSchema,
  JourneySnapshotSchema,
  TogetherSessionSetStatusRequestSchema,
} from "../../shared/schemas/journey";
import { parseSchema } from "../../shared/schemas/validation";
import type { ChatService } from "../chat/chatService";
import { JourneyError } from "./journeyError";
import type { JourneyRepository } from "./journeyRepository";

export interface JourneyEventPublisher {
  publish(snapshot: JourneySnapshot): void;
}

export interface JourneyRunReader {
  getRun(runId: string): Run | undefined;
}

export interface JourneyFollowUpScheduler {
  cancel(automationId: string): void;
  schedule(input: {
    readonly journey: Journey;
    readonly message: string;
    readonly run: Run;
    readonly runAt: string;
  }): string;
}

export interface JourneyCreateInput {
  readonly currentPosition?: string;
  readonly homeChatId: string;
  readonly nextStep?: string;
  readonly operationId?: string;
  readonly purpose: string;
  readonly sessionId?: string;
  readonly title: string;
}

export interface JourneyUpdateInput {
  readonly currentPosition?: string | null;
  readonly journeyId: string;
  readonly nextStep?: string | null;
  readonly purpose?: string;
  readonly title?: string;
}

export interface TogetherSessionCreateInput {
  readonly chatId: string;
  readonly journeyId?: string;
  readonly operationId?: string;
  readonly resumeNote?: string;
  readonly title: string;
}

export interface TogetherSessionUpdateInput {
  readonly recap?: string | null;
  readonly resumeNote?: string | null;
  readonly sessionId: string;
  readonly title?: string;
}

function clean(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function cleanField<TKey extends string>(
  key: TKey,
  value: string | undefined,
): Record<TKey, string> | Record<string, never> {
  const normalized = clean(value);
  return normalized ? ({ [key]: normalized } as Record<TKey, string>) : {};
}

function replaceOptional(
  current: string | undefined,
  value: string | null | undefined,
): string | undefined {
  return value === undefined
    ? current
    : value === null
      ? undefined
      : clean(value);
}

export class JourneyService {
  #followUps: JourneyFollowUpScheduler | undefined;

  constructor(
    private readonly repository: JourneyRepository,
    private readonly chats: ChatService,
    private readonly runs: JourneyRunReader,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly events: JourneyEventPublisher,
  ) {}

  setFollowUpScheduler(scheduler: JourneyFollowUpScheduler): void {
    this.#followUps = scheduler;
  }

  initialize(): void {
    const active = this.repository.getActiveSession();
    if (!active) return;
    const now = this.clock.now();
    this.repository.updateSession({
      ...active,
      pausedAt: now,
      resumeNote:
        active.resumeNote ??
        "应用关闭前正在一起做的内容，可以从上次停下的地方继续。",
      status: "paused",
      updatedAt: now,
    });
  }

  pauseForShutdown(): void {
    const active = this.repository.getActiveSession();
    if (!active) return;
    const now = this.clock.now();
    this.repository.updateSession({
      ...active,
      pausedAt: now,
      resumeNote:
        active.resumeNote ??
        "应用关闭前正在一起做的内容，可以从上次停下的地方继续。",
      status: "paused",
      updatedAt: now,
    });
  }

  getSnapshot(): JourneySnapshot {
    const sessions = this.repository
      .listSessions()
      .filter(({ status }) => status !== "ended");
    const activeSession = sessions.find(({ status }) => status === "active");
    return parseSchema(JourneySnapshotSchema, {
      ...(activeSession ? { activeSession } : {}),
      journeys: this.repository.listJourneys(),
      sessions,
    });
  }

  getDetail(input: { readonly journeyId: string }): JourneyDetail {
    const request = parseSchema(JourneyIdRequestSchema, input);
    return {
      journey: this.#requireJourney(request.journeyId),
      moments: this.repository.listMoments(request.journeyId),
      sessions: this.repository.listJourneySessions(request.journeyId),
    };
  }

  createJourney(input: JourneyCreateInput): Journey {
    if (input.operationId) {
      const existing = this.repository.getJourney(input.operationId);
      if (existing) return existing;
    }
    const title = clean(input.title);
    const purpose = clean(input.purpose);
    if (!title || !purpose) {
      throw new JourneyError(
        "JOURNEY.CONFLICT",
        "需要一个清楚的名称和意义。",
        false,
      );
    }
    if (!this.chats.getSnapshot({ chatId: input.homeChatId })) {
      throw new JourneyError(
        "JOURNEY.CONFLICT",
        "无法把这件事连接到已经不存在的对话。",
        false,
      );
    }
    if (this.repository.getJourneyByHomeChat(input.homeChatId)) {
      throw new JourneyError(
        "JOURNEY.CONFLICT",
        "这个对话已经用于另一件需要持续接上的事情。",
        false,
      );
    }
    const session = input.sessionId
      ? this.#requireSession(input.sessionId)
      : undefined;
    if (session?.journeyId) {
      throw new JourneyError(
        "JOURNEY.CONFLICT",
        "当前活动已经关联到另一件长期事情。",
        false,
      );
    }
    if (
      session &&
      (session.status === "ended" || session.chatId !== input.homeChatId)
    ) {
      throw new JourneyError(
        "JOURNEY.CONFLICT",
        "只能把当前对话里尚未结束的活动纳入这件长期事情。",
        false,
      );
    }
    const now = this.clock.now();
    const currentPosition = clean(input.currentPosition);
    const nextStep = clean(input.nextStep);
    let journey!: Journey;
    this.repository.transaction(() => {
      journey = this.repository.insertJourney({
        createdAt: now,
        ...(currentPosition ? { currentPosition } : {}),
        homeChatId: input.homeChatId,
        id: input.operationId ?? this.ids.generate(),
        ...(nextStep ? { nextStep } : {}),
        purpose,
        status: "active",
        title,
        updatedAt: now,
      });
      if (session) {
        this.repository.updateSession({
          ...session,
          chatId: journey.homeChatId,
          journeyId: journey.id,
          updatedAt: now,
        });
      }
    });
    this.#publish();
    return journey;
  }

  updateJourney(input: JourneyUpdateInput): Journey {
    const current = this.#requireJourney(input.journeyId);
    const title =
      input.title === undefined ? current.title : clean(input.title);
    const purpose =
      input.purpose === undefined ? current.purpose : clean(input.purpose);
    if (!title || !purpose) {
      throw new JourneyError("JOURNEY.CONFLICT", "名称和意义不能为空。", false);
    }
    const next: Journey = {
      ...current,
      purpose,
      title,
      updatedAt: this.clock.now(),
    };
    const currentPosition = replaceOptional(
      current.currentPosition,
      input.currentPosition,
    );
    const nextStep = replaceOptional(current.nextStep, input.nextStep);
    if (currentPosition) next.currentPosition = currentPosition;
    else delete next.currentPosition;
    if (nextStep) next.nextStep = nextStep;
    else delete next.nextStep;
    const updated = this.repository.updateJourney(next);
    this.#publish();
    return updated;
  }

  setJourneyStatus(input: JourneySetStatusRequest): JourneySnapshot {
    const request = parseSchema(JourneySetStatusRequestSchema, input);
    const current = this.#requireJourney(request.journeyId);
    if (current.status === request.status) return this.getSnapshot();
    const now = this.clock.now();
    let nextCurrent = current;
    if (
      request.status === "completed" &&
      current.followUp?.status === "scheduled"
    ) {
      this.#followUps?.cancel(current.followUp.automationId);
      nextCurrent = {
        ...current,
        followUp: { ...current.followUp, status: "cancelled" },
      };
    }
    this.repository.transaction(() => {
      if (request.status === "active") {
        const reopened = current.status === "completed";
        const value = { ...current };
        delete value.completedAt;
        delete value.pausedAt;
        this.repository.updateJourney({
          ...value,
          status: "active",
          updatedAt: now,
        });
        if (reopened) {
          this.#insertMoment({
            content: "这件事重新开始了。",
            journeyId: current.id,
            kind: "reopened",
            occurredAt: now,
          });
        }
        return;
      }
      if (request.status === "paused") {
        if (current.status === "completed") {
          throw new JourneyError(
            "JOURNEY.INVALID_STATE",
            "已经告一段落的事情需要先重新开始，不能直接暂停。",
            false,
          );
        }
        const active = this.repository.getActiveSession();
        if (active?.journeyId === current.id) this.#pauseSession(active, now);
        this.repository.updateJourney({
          ...current,
          pausedAt: now,
          status: "paused",
          updatedAt: now,
        });
        return;
      }
      for (const session of this.repository.listUnfinishedJourneySessions(
        current.id,
      )) {
        this.#endSession(session, now, session.recap);
      }
      const value = { ...current };
      delete value.pausedAt;
      this.repository.updateJourney({
        ...value,
        ...(nextCurrent.followUp ? { followUp: nextCurrent.followUp } : {}),
        completedAt: now,
        status: "completed",
        updatedAt: now,
      });
      this.#insertMoment({
        content: clean(request.closure) ?? "这件事已经告一段落。",
        journeyId: current.id,
        kind: "closure",
        occurredAt: now,
      });
    });
    this.#publish();
    return this.getSnapshot();
  }

  startSession(input: TogetherSessionCreateInput): TogetherSession {
    if (input.operationId) {
      const existing = this.repository.getSession(input.operationId);
      if (existing) return existing;
    }
    const title = clean(input.title);
    if (!title) {
      throw new JourneyError(
        "JOURNEY.CONFLICT",
        "当前一起做的活动需要一个清楚的名称。",
        false,
      );
    }
    const journey = input.journeyId
      ? this.#requireJourney(input.journeyId)
      : undefined;
    if (journey?.status === "completed") {
      throw new JourneyError(
        "JOURNEY.INVALID_STATE",
        "请先重新开始这件事，再进行新的共同活动。",
        false,
      );
    }
    const chatId = journey?.homeChatId ?? input.chatId;
    const target = this.chats.getSnapshot({ chatId });
    if (!target) {
      throw new JourneyError(
        "JOURNEY.CONFLICT",
        "无法把当前活动连接到已经不存在的对话。",
        false,
      );
    }
    if (target.chat.status === "archived") this.chats.restore({ chatId });
    const now = this.clock.now();
    const resumeNote = clean(input.resumeNote);
    let created!: TogetherSession;
    this.repository.transaction(() => {
      const active = this.repository.getActiveSession();
      if (active) this.#pauseSession(active, now);
      if (journey?.status === "paused") this.#activateJourney(journey, now);
      created = this.repository.insertSession({
        chatId,
        createdAt: now,
        id: input.operationId ?? this.ids.generate(),
        ...(journey ? { journeyId: journey.id } : {}),
        ...(resumeNote ? { resumeNote } : {}),
        status: "active",
        title,
        updatedAt: now,
      });
    });
    this.#publish();
    return created;
  }

  updateSession(input: TogetherSessionUpdateInput): TogetherSession {
    const current = this.#requireSession(input.sessionId);
    const title =
      input.title === undefined ? current.title : clean(input.title);
    if (!title) {
      throw new JourneyError(
        "JOURNEY.CONFLICT",
        "当前活动名称不能为空。",
        false,
      );
    }
    const value = { ...current };
    const recap = replaceOptional(current.recap, input.recap);
    const resumeNote = replaceOptional(current.resumeNote, input.resumeNote);
    if (recap) value.recap = recap;
    else delete value.recap;
    if (resumeNote) value.resumeNote = resumeNote;
    else delete value.resumeNote;
    const updated = this.repository.updateSession({
      ...value,
      title,
      updatedAt: this.clock.now(),
    });
    this.#publish();
    return updated;
  }

  setSessionStatus(input: TogetherSessionSetStatusRequest): JourneySnapshot {
    const request = parseSchema(TogetherSessionSetStatusRequestSchema, input);
    const current = this.#requireSession(request.sessionId);
    if (current.status === request.status) return this.getSnapshot();
    const now = this.clock.now();
    this.repository.transaction(() => {
      if (request.status === "active") {
        if (current.status === "ended") {
          throw new JourneyError(
            "JOURNEY.INVALID_STATE",
            "已经结束的活动不会恢复，可以开始一次新的活动。",
            false,
          );
        }
        const active = this.repository.getActiveSession();
        if (active && active.id !== current.id) this.#pauseSession(active, now);
        if (current.journeyId) {
          const journey = this.#requireJourney(current.journeyId);
          if (journey.status === "completed") {
            throw new JourneyError(
              "JOURNEY.INVALID_STATE",
              "请先重新开始这件事，再恢复相关活动。",
              false,
            );
          }
          if (journey.status === "paused") this.#activateJourney(journey, now);
          if (
            this.chats.getSnapshot({ chatId: journey.homeChatId })?.chat
              .status === "archived"
          ) {
            this.chats.restore({ chatId: journey.homeChatId });
          }
        }
        const value = { ...current };
        delete value.pausedAt;
        const resumeNote = clean(request.resumeNote);
        this.repository.updateSession({
          ...value,
          ...(resumeNote ? { resumeNote } : {}),
          status: "active",
          updatedAt: now,
        });
      } else if (request.status === "paused") {
        if (current.status === "ended") {
          throw new JourneyError(
            "JOURNEY.INVALID_STATE",
            "已经结束的活动不能暂停。",
            false,
          );
        }
        this.#pauseSession(current, now, request.resumeNote);
      } else {
        this.#endSession(current, now, request.recap);
      }
    });
    this.#publish();
    return this.getSnapshot();
  }

  relinkSession(sessionId: string, journeyId?: string): TogetherSession {
    const current = this.#requireSession(sessionId);
    const journey = journeyId ? this.#requireJourney(journeyId) : undefined;
    if (journey?.status === "completed") {
      throw new JourneyError(
        "JOURNEY.INVALID_STATE",
        "不能把当前活动关联到已经告一段落的事情。",
        false,
      );
    }
    if (
      journey &&
      current.status === "active" &&
      this.chats.getSnapshot({ chatId: journey.homeChatId })?.chat.status ===
        "archived"
    ) {
      this.chats.restore({ chatId: journey.homeChatId });
    }
    const now = this.clock.now();
    let updated!: TogetherSession;
    this.repository.transaction(() => {
      if (journey?.status === "paused" && current.status === "active") {
        this.#activateJourney(journey, now);
      }
      const value = { ...current };
      if (journey) value.journeyId = journey.id;
      else delete value.journeyId;
      updated = this.repository.updateSession({
        ...value,
        ...(journey ? { chatId: journey.homeChatId } : {}),
        updatedAt: now,
      });
    });
    this.#publish();
    return updated;
  }

  recordMoment(input: {
    readonly content: string;
    readonly journeyId: string;
    readonly kind?: Extract<JourneyMomentKind, "milestone">;
    readonly occurredAt?: string;
    readonly operationId?: string;
    readonly sessionId?: string;
  }): JourneyMoment {
    if (input.operationId) {
      const existing = this.repository.getMoment(input.operationId);
      if (existing) return existing;
    }
    this.#requireJourney(input.journeyId);
    if (input.sessionId) {
      const session = this.#requireSession(input.sessionId);
      if (session.journeyId !== input.journeyId) {
        throw new JourneyError(
          "JOURNEY.CONFLICT",
          "当前活动不属于这件长期事情。",
          false,
        );
      }
    }
    const content = clean(input.content);
    if (!content) {
      throw new JourneyError(
        "JOURNEY.CONFLICT",
        "关键节点内容不能为空。",
        false,
      );
    }
    const moment = this.#insertMoment(
      {
        content,
        journeyId: input.journeyId,
        kind: input.kind ?? "milestone",
        occurredAt: input.occurredAt ?? this.clock.now(),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
      input.operationId,
    );
    this.#publish();
    return moment;
  }

  scheduleFollowUp(input: {
    readonly journeyId: string;
    readonly message: string;
    readonly runAt: string;
    readonly sourceRunId: string;
  }): JourneyFollowUp {
    const scheduler = this.#followUps;
    if (!scheduler) {
      throw new JourneyError(
        "JOURNEY.INVALID_STATE",
        "跟进调度尚未就绪。",
        true,
      );
    }
    const journey = this.#requireJourney(input.journeyId);
    if (journey.status === "completed") {
      throw new JourneyError(
        "JOURNEY.INVALID_STATE",
        "已经告一段落的事情不能再安排跟进。",
        false,
      );
    }
    const run = this.runs.getRun(input.sourceRunId);
    const message = clean(input.message);
    if (!run || !message) {
      throw new JourneyError(
        "JOURNEY.CONFLICT",
        "跟进需要当前 Run 和明确的约定内容。",
        false,
      );
    }
    if (
      journey.followUp?.status === "scheduled" &&
      journey.followUp.message === message &&
      journey.followUp.runAt === input.runAt
    ) {
      return journey.followUp;
    }
    if (journey.followUp?.status === "scheduled") {
      scheduler.cancel(journey.followUp.automationId);
    }
    const automationId = scheduler.schedule({
      journey,
      message,
      run,
      runAt: input.runAt,
    });
    const followUp: JourneyFollowUp = {
      automationId,
      message,
      runAt: input.runAt,
      status: "scheduled",
    };
    this.repository.updateJourney({
      ...journey,
      followUp,
      updatedAt: this.clock.now(),
    });
    this.#publish();
    return followUp;
  }

  clearFollowUp(journeyId: string): JourneyFollowUp | undefined {
    const journey = this.#requireJourney(journeyId);
    const current = journey.followUp;
    if (!current || current.status !== "scheduled") return current;
    this.#followUps?.cancel(current.automationId);
    const followUp: JourneyFollowUp = { ...current, status: "cancelled" };
    this.repository.updateJourney({
      ...journey,
      followUp,
      updatedAt: this.clock.now(),
    });
    this.#publish();
    return followUp;
  }

  observeAutomation(
    event: AutomationEvent,
  ): ProactiveConversationBubble | undefined {
    if (event.type !== "automation.run.finished") return undefined;
    return this.#finishFollowUp(event);
  }

  linkMemoryForRun(runId: string, memoryId: string, content: string): void {
    const run = this.runs.getRun(runId);
    if (!run) return;
    const session = this.repository.findActiveSessionForChat(run.chatId);
    if (!session?.journeyId) return;
    if (this.repository.hasMemoryMoment(session.journeyId, memoryId)) return;
    this.#insertMoment({
      content,
      journeyId: session.journeyId,
      kind: "memory",
      memoryId,
      occurredAt: this.clock.now(),
      sessionId: session.id,
    });
    this.#publish();
  }

  agentContextInstructions(currentChatId?: string): string {
    const snapshot = this.getSnapshot();
    if (snapshot.journeys.length === 0 && snapshot.sessions.length === 0) {
      return "There are currently no internal long-term companionship or unfinished shared-activity records.";
    }
    const context = {
      activeSession: snapshot.activeSession
        ? {
            id: snapshot.activeSession.id,
            ...(snapshot.activeSession.journeyId
              ? { journeyId: snapshot.activeSession.journeyId }
              : {}),
            ...(currentChatId
              ? {
                  belongsToCurrentChat:
                    snapshot.activeSession.chatId === currentChatId,
                }
              : {}),
            ...(snapshot.activeSession.resumeNote
              ? { resumeNote: snapshot.activeSession.resumeNote }
              : {}),
            status: snapshot.activeSession.status,
            title: snapshot.activeSession.title,
          }
        : null,
      journeys: snapshot.journeys.map(
        ({
          currentPosition,
          homeChatId,
          id,
          nextStep,
          purpose,
          status,
          title,
        }) => ({
          ...(currentPosition ? { currentPosition } : {}),
          ...(currentChatId
            ? { homeForCurrentChat: homeChatId === currentChatId }
            : {}),
          id,
          ...(nextStep ? { nextStep } : {}),
          purpose,
          status,
          title,
        }),
      ),
      sessions: snapshot.sessions.map(
        ({ chatId, id, journeyId, resumeNote, status, title }) => ({
          ...(currentChatId
            ? { belongsToCurrentChat: chatId === currentChatId }
            : {}),
          id,
          ...(journeyId ? { journeyId } : {}),
          ...(resumeNote ? { resumeNote } : {}),
          status,
          title,
        }),
      ),
    };
    return `Current internal companionship candidates. IDs, object names, action names, and status labels are never user-facing. Prefer candidates marked for the current Chat; never ask the user to choose a Chat or internal object, and refer only to the concrete activity or matter: ${JSON.stringify(context)}`;
  }

  #finishFollowUp(
    event: Extract<AutomationEvent, { type: "automation.run.finished" }>,
  ): ProactiveConversationBubble | undefined {
    const journey = this.repository.findJourneyByFollowUpAutomation(
      event.automationId,
    );
    if (!journey?.followUp || journey.followUp.status !== "scheduled") {
      return undefined;
    }
    const delivered = event.status === "completed";
    this.repository.updateJourney({
      ...journey,
      followUp: {
        ...journey.followUp,
        status: delivered ? "sent" : "cancelled",
      },
      updatedAt: this.clock.now(),
    });
    this.#publish();
    const content = delivered ? clean(event.summary) : undefined;
    if (!content) return undefined;
    return {
      chatId: journey.homeChatId,
      content,
      createdAt: this.clock.now(),
      id: event.runId ?? event.automationRunId,
      journeyId: journey.id,
      kind: "continuation",
      replyState: "ready",
    };
  }

  #activateJourney(journey: Journey, now: string): void {
    const value = { ...journey };
    delete value.pausedAt;
    this.repository.updateJourney({
      ...value,
      status: "active",
      updatedAt: now,
    });
  }

  #pauseSession(
    session: TogetherSession,
    now: string,
    resumeNote?: string,
  ): TogetherSession {
    if (session.status === "ended") return session;
    const note = clean(resumeNote) ?? session.resumeNote;
    return this.repository.updateSession({
      ...session,
      pausedAt: now,
      ...cleanField("resumeNote", note),
      status: "paused",
      updatedAt: now,
    });
  }

  #endSession(
    session: TogetherSession,
    now: string,
    recap?: string,
  ): TogetherSession {
    if (session.status === "ended") return session;
    const value = { ...session };
    delete value.pausedAt;
    const summary = clean(recap) ?? session.recap;
    return this.repository.updateSession({
      ...value,
      endedAt: now,
      ...cleanField("recap", summary),
      status: "ended",
      updatedAt: now,
    });
  }

  #insertMoment(
    input: Omit<JourneyMoment, "createdAt" | "id">,
    operationId?: string,
  ): JourneyMoment {
    return this.repository.insertMoment({
      ...input,
      createdAt: this.clock.now(),
      id: operationId ?? this.ids.generate(),
    });
  }

  #publish(): void {
    this.events.publish(this.getSnapshot());
  }

  #requireJourney(journeyId: string): Journey {
    const journey = this.repository.getJourney(journeyId);
    if (!journey) {
      throw new JourneyError(
        "JOURNEY.NOT_FOUND",
        "找不到这件长期事情。",
        false,
      );
    }
    return journey;
  }

  #requireSession(sessionId: string): TogetherSession {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw new JourneyError(
        "JOURNEY.SESSION_NOT_FOUND",
        "找不到这次活动。",
        false,
      );
    }
    return session;
  }
}
