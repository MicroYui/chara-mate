import { Type, type Static } from "@sinclair/typebox";

import type { JsonValue } from "../../shared/contracts/primitives";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { Run } from "../../shared/contracts/run";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { JourneyService } from "./journeyService";

export const COMPANIONSHIP_UPDATE_TOOL_NAME = "companionship.update";

const NullableIdSchema = Type.Union([EntityIdSchema, Type.Null()]);
const NullableTextSchema = Type.Union([NonBlankStringSchema, Type.Null()]);
const NullableTimestampSchema = Type.Union([TimestampSchema, Type.Null()]);

export const CompanionshipActionSchema = Type.Union([
  Type.Literal("create_journey"),
  Type.Literal("update_journey"),
  Type.Literal("pause_journey"),
  Type.Literal("complete_journey"),
  Type.Literal("reopen_journey"),
  Type.Literal("start_session"),
  Type.Literal("update_session"),
  Type.Literal("resume_session"),
  Type.Literal("pause_session"),
  Type.Literal("end_session"),
  Type.Literal("relink_session"),
  Type.Literal("record_milestone"),
  Type.Literal("schedule_follow_up"),
  Type.Literal("clear_follow_up"),
]);

export const CompanionshipUpdateInputSchema = Type.Object(
  {
    action: CompanionshipActionSchema,
    content: NullableTextSchema,
    currentPosition: NullableTextSchema,
    followUpAt: NullableTimestampSchema,
    followUpMessage: NullableTextSchema,
    journeyId: NullableIdSchema,
    nextStep: NullableTextSchema,
    purpose: NullableTextSchema,
    recap: NullableTextSchema,
    resumeNote: NullableTextSchema,
    sessionId: NullableIdSchema,
    title: NullableTextSchema,
  },
  { additionalProperties: false },
);

type CompanionshipUpdateInput = Static<typeof CompanionshipUpdateInputSchema>;

const INTERNAL_UPDATE_SUMMARY =
  "Internal companionship state updated. Do not mention this tool result to the user.";

export interface CompanionshipToolDependencies {
  readonly getRun: (runId: string) => Run | undefined;
  readonly journeys: JourneyService;
}

function required(value: string | null, label: string): string {
  if (!value?.trim())
    throw new TypeError(`${label} is required for this action`);
  return value.trim();
}

function optional(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

function optionalField<TKey extends string>(
  key: TKey,
  value: string | null,
): Record<TKey, string> | Record<string, never> {
  const normalized = optional(value);
  return normalized ? ({ [key]: normalized } as Record<TKey, string>) : {};
}

function success(summary: string, modelContent: JsonValue) {
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success" as const,
    summary,
  };
}

export function registerCompanionshipTool(
  registry: ToolRegistry,
  dependencies: CompanionshipToolDependencies,
): void {
  registry.register({
    descriptor: {
      description:
        "Maintain invisible CharaMate companionship state after semantic judgment. Never expose Journey, Together Session, Home Chat, action names, IDs, or status labels in the visible reply. A Journey is a user-important experience lasting days to months; a Together Session is one concrete shared-presence activity lasting minutes to hours. An Activity observation or proactive opener never creates state by itself. Start or resume only once the user engages and you actually participate in the present activity; no fixed invitation phrase is required, but casual small talk is insufficient. Starting a different shared activity automatically pauses the active Session. Pause only when this exact episode is meant to continue later, with a concrete resume note; end when the episode is wrapped, with a short recap. Silence, elapsed time, focus changes, and mild topic drift alone never change state. Never create a Journey silently: make a natural continuity proposal about the concrete matter and create only after the user confirms. When that Journey grows out of an unfinished Session, include its supplied sessionId so the host links them atomically. Prefer supplied candidates marked as belonging to the current Chat; never ask the user to choose a Chat or internal object. Record only sparse meaningful milestones. Schedule only one follow-up the user explicitly agreed to. Null every field irrelevant to the chosen action.",
      effect: "write",
      idempotency: "idempotent",
      inputSchema: CompanionshipUpdateInputSchema,
      itemKind: "tool_call",
      name: COMPANIONSHIP_UPDATE_TOOL_NAME,
      namespace: "companionship",
      source: "builtin",
      summary: "更新内部陪伴状态",
    },
    execute: (input, context) => {
      const request: CompanionshipUpdateInput = parseSchema(
        CompanionshipUpdateInputSchema,
        input,
      );
      const run = dependencies.getRun(context.runId);
      if (!run) throw new TypeError("Companionship source Run is unavailable");
      const journeys = dependencies.journeys;

      if (request.action === "create_journey") {
        const journey = journeys.createJourney({
          ...optionalField("currentPosition", request.currentPosition),
          homeChatId: run.chatId,
          ...optionalField("nextStep", request.nextStep),
          operationId: context.itemId,
          purpose: required(request.purpose, "purpose"),
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          title: required(request.title, "title"),
        });
        return Promise.resolve(
          success(INTERNAL_UPDATE_SUMMARY, {
            action: request.action,
            journey,
            navigateChatId: journey.homeChatId,
          }),
        );
      }

      if (request.action === "update_journey") {
        const journey = journeys.updateJourney({
          currentPosition: request.currentPosition,
          journeyId: required(request.journeyId, "journeyId"),
          nextStep: request.nextStep,
          ...optionalField("purpose", request.purpose),
          ...optionalField("title", request.title),
        });
        return Promise.resolve(
          success(INTERNAL_UPDATE_SUMMARY, { action: request.action, journey }),
        );
      }

      if (
        request.action === "pause_journey" ||
        request.action === "complete_journey" ||
        request.action === "reopen_journey"
      ) {
        const journeyId = required(request.journeyId, "journeyId");
        const snapshot = journeys.setJourneyStatus({
          ...(request.action === "complete_journey"
            ? optionalField("closure", request.content)
            : {}),
          journeyId,
          status:
            request.action === "pause_journey"
              ? "paused"
              : request.action === "complete_journey"
                ? "completed"
                : "active",
        });
        const journey = snapshot.journeys.find(({ id }) => id === journeyId);
        return Promise.resolve(
          success(INTERNAL_UPDATE_SUMMARY, {
            action: request.action,
            journey: journey ?? null,
          }),
        );
      }

      if (request.action === "start_session") {
        const session = journeys.startSession({
          chatId: run.chatId,
          ...(request.journeyId ? { journeyId: request.journeyId } : {}),
          operationId: context.itemId,
          ...optionalField("resumeNote", request.resumeNote),
          title: required(request.title, "title"),
        });
        return Promise.resolve(
          success(INTERNAL_UPDATE_SUMMARY, {
            action: request.action,
            navigateChatId: session.chatId,
            session,
          }),
        );
      }

      if (request.action === "update_session") {
        const session = journeys.updateSession({
          recap: request.recap,
          resumeNote: request.resumeNote,
          sessionId: required(request.sessionId, "sessionId"),
          ...optionalField("title", request.title),
        });
        return Promise.resolve(
          success(INTERNAL_UPDATE_SUMMARY, { action: request.action, session }),
        );
      }

      if (
        request.action === "resume_session" ||
        request.action === "pause_session" ||
        request.action === "end_session"
      ) {
        const sessionId = required(request.sessionId, "sessionId");
        const snapshot = journeys.setSessionStatus({
          ...optionalField("recap", request.recap),
          ...optionalField("resumeNote", request.resumeNote),
          sessionId,
          status:
            request.action === "resume_session"
              ? "active"
              : request.action === "pause_session"
                ? "paused"
                : "ended",
        });
        const session = snapshot.sessions.find(({ id }) => id === sessionId);
        const stored =
          session ??
          (request.journeyId
            ? journeys
                .getDetail({ journeyId: request.journeyId })
                .sessions.find(({ id }) => id === sessionId)
            : undefined);
        return Promise.resolve(
          success(INTERNAL_UPDATE_SUMMARY, {
            action: request.action,
            ...(stored?.chatId ? { navigateChatId: stored.chatId } : {}),
            session: stored ?? null,
          }),
        );
      }

      if (request.action === "relink_session") {
        const session = journeys.relinkSession(
          required(request.sessionId, "sessionId"),
          request.journeyId ?? undefined,
        );
        return Promise.resolve(
          success(INTERNAL_UPDATE_SUMMARY, {
            action: request.action,
            navigateChatId: session.chatId,
            session,
          }),
        );
      }

      if (request.action === "record_milestone") {
        const moment = journeys.recordMoment({
          content: required(request.content, "content"),
          journeyId: required(request.journeyId, "journeyId"),
          operationId: context.itemId,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        });
        return Promise.resolve(
          success(INTERNAL_UPDATE_SUMMARY, {
            action: request.action,
            moment,
          }),
        );
      }

      if (request.action === "schedule_follow_up") {
        const followUp = journeys.scheduleFollowUp({
          journeyId: required(request.journeyId, "journeyId"),
          message: required(request.followUpMessage, "followUpMessage"),
          runAt: required(request.followUpAt, "followUpAt"),
          sourceRunId: context.runId,
        });
        return Promise.resolve(
          success(INTERNAL_UPDATE_SUMMARY, {
            action: request.action,
            followUp,
          }),
        );
      }

      const followUp = journeys.clearFollowUp(
        required(request.journeyId, "journeyId"),
      );
      return Promise.resolve(
        success(INTERNAL_UPDATE_SUMMARY, {
          action: request.action,
          followUp: followUp ?? null,
        }),
      );
    },
    summarize: (input) => {
      const action = input["action"];
      const title = input["title"];
      return `更新内部陪伴状态${typeof title === "string" ? `：${title}` : typeof action === "string" ? `（${action}）` : ""}`;
    },
  });
}
