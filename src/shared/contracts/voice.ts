import type { Static } from "@sinclair/typebox";

import type {
  VoiceCancelStartRequestSchema,
  VoiceCancelStartResultSchema,
  VoiceCancelStartResponseSchema,
  VoiceStartSubmissionSchema,
  VoiceQuickStartSubmissionSchema,
  VoicePreviewSubmissionSchema,
  VoiceClientCommandSchema,
  VoiceConnectionSchema,
  VoiceDriverEventRequestSchema,
  VoiceDriverEventSchema,
  VoiceEmptyRequestSchema,
  VoiceInputModeSchema,
  VoiceConnectionStageSchema,
  VoiceFunctionToolSchema,
  VoiceHistoryMessageSchema,
  VoiceMutedRequestSchema,
  VoiceMutationResponseSchema,
  VoiceNameSchema,
  VoicePhaseSchema,
  VoicePausedRequestSchema,
  VoicePausedSubmissionSchema,
  VoicePauseResponseSchema,
  VoicePauseResultSchema,
  VoicePreviewConnectionSchema,
  VoicePreviewRequestSchema,
  VoicePreviewResponseSchema,
  VoiceQuickStartRequestSchema,
  VoiceQuickStartResponseSchema,
  VoiceSessionRequestSchema,
  VoiceSessionSnapshotSchema,
  VoiceSessionRecordSchema,
  VoiceSessionStatusSchema,
  VoiceSnapshotResponseSchema,
  VoiceStartRequestSchema,
  VoiceStartResponseSchema,
  VoiceTurnRecordSchema,
  VoiceTurnStatusSchema,
} from "../schemas/voice";

export const VOICE_CHANNELS = {
  cancelStart: "voice.cancelStart",
  changed: "voice.changed",
  command: "voice.command",
  end: "voice.end",
  event: "voice.event",
  getActive: "voice.getActive",
  preview: "voice.preview",
  quickStart: "voice.quickStart",
  setMuted: "voice.setMuted",
  setPaused: "voice.setPaused",
  start: "voice.start",
} as const;

export const VOICE_CHAT_FALLBACK_TITLE = "语音对话";
export const VOICE_END_TOOL_NAME = "voice.end";

export type VoiceName = Static<typeof VoiceNameSchema>;
export type VoiceInputMode = Static<typeof VoiceInputModeSchema>;
export type VoiceConnectionStage = Static<typeof VoiceConnectionStageSchema>;
export type VoiceFunctionTool = Static<typeof VoiceFunctionToolSchema>;
export type VoiceHistoryMessage = Static<typeof VoiceHistoryMessageSchema>;
export type VoicePhase = Static<typeof VoicePhaseSchema>;
export type VoiceSessionSnapshot = Static<typeof VoiceSessionSnapshotSchema>;
export type VoiceSessionRecord = Static<typeof VoiceSessionRecordSchema>;
export type VoiceSessionStatus = Static<typeof VoiceSessionStatusSchema>;
export type VoiceTurnRecord = Static<typeof VoiceTurnRecordSchema>;
export type VoiceTurnStatus = Static<typeof VoiceTurnStatusSchema>;
export type VoiceStartRequest = Static<typeof VoiceStartRequestSchema>;
export type VoicePreviewRequest = Static<typeof VoicePreviewRequestSchema>;
export type VoiceQuickStartRequest = Static<
  typeof VoiceQuickStartRequestSchema
>;
export type VoiceSessionRequest = Static<typeof VoiceSessionRequestSchema>;
export type VoiceMutedRequest = Static<typeof VoiceMutedRequestSchema>;
export type VoicePausedRequest = Static<typeof VoicePausedRequestSchema>;
export type VoiceConnection = Static<typeof VoiceConnectionSchema>;
export type VoicePreviewConnection = Static<
  typeof VoicePreviewConnectionSchema
>;
export type VoiceDriverEvent = Static<typeof VoiceDriverEventSchema>;
export type VoiceDriverEventRequest = Static<
  typeof VoiceDriverEventRequestSchema
>;
export type VoiceClientCommand = Static<typeof VoiceClientCommandSchema>;
export type VoiceEmptyRequest = Static<typeof VoiceEmptyRequestSchema>;
export type VoiceStartResponse = Static<typeof VoiceStartResponseSchema>;
export type VoicePreviewResponse = Static<typeof VoicePreviewResponseSchema>;
export type VoiceQuickStartResponse = Static<
  typeof VoiceQuickStartResponseSchema
>;
export type VoiceMutationResponse = Static<typeof VoiceMutationResponseSchema>;
export type VoicePauseResult = Static<typeof VoicePauseResultSchema>;
export type VoicePauseResponse = Static<typeof VoicePauseResponseSchema>;
export type VoiceSnapshotResponse = Static<typeof VoiceSnapshotResponseSchema>;

export type VoicePausedSubmission = Static<typeof VoicePausedSubmissionSchema>;
export type VoiceStartSubmission = Static<typeof VoiceStartSubmissionSchema>;
export type VoiceQuickStartSubmission = Static<
  typeof VoiceQuickStartSubmissionSchema
>;
export type VoicePreviewSubmission = Static<
  typeof VoicePreviewSubmissionSchema
>;
export type VoiceCancelStartRequest = Static<
  typeof VoiceCancelStartRequestSchema
>;
export type VoiceCancelStartResult = Static<
  typeof VoiceCancelStartResultSchema
>;
export type VoiceCancelStartResponse = Static<
  typeof VoiceCancelStartResponseSchema
>;

export const VOICE_PREVIEW_PHRASE = "你好，我是 CharaMate，很高兴陪你聊聊。";

export function voiceHistoryItemEvent(message: VoiceHistoryMessage) {
  return {
    item: {
      content: [
        {
          text: message.content,
          type: message.role === "user" ? "input_text" : "output_text",
        },
      ],
      role: message.role,
      type: "message",
    },
    type: "conversation.item.create",
  } as const;
}

export function voicePreviewEvents(phrase: string = VOICE_PREVIEW_PHRASE) {
  return [
    voiceHistoryItemEvent({ content: phrase, role: "user" }),
    { type: "response.create" },
  ] as const;
}

export function voiceWakeGreetingEvent(
  command: Pick<
    Extract<VoiceClientCommand, { type: "wake.greeting.create" }>,
    "instructions" | "prompt" | "requestId"
  >,
) {
  return {
    event_id: command.requestId,
    response: {
      conversation: "none",
      input: [
        {
          content: [{ text: command.prompt, type: "input_text" }],
          role: "user",
          type: "message",
        },
      ],
      instructions: command.instructions,
      metadata: {
        charamate_purpose: "wake_greeting",
        charamate_request_id: command.requestId,
      },
      output_modalities: ["audio"],
      tools: [],
    },
    type: "response.create",
  } as const;
}

export function voiceSessionRefreshEvent(
  command: Extract<VoiceClientCommand, { type: "session.refresh" }>,
) {
  return {
    event_id: command.requestId,
    session: {
      instructions: command.instructions,
      parallel_tool_calls: false,
      tool_choice: "auto",
      tools: command.tools,
      type: "realtime",
    },
    type: "session.update",
  } as const;
}

export function voiceResponseCreateEvent(
  command: Pick<
    Extract<VoiceClientCommand, { type: "response.create" }>,
    "generation" | "instructions" | "requestId"
  >,
) {
  return {
    event_id: command.requestId,
    response: {
      instructions: command.instructions,
      metadata: {
        charamate_generation: String(command.generation),
        charamate_request_id: command.requestId,
      },
      output_modalities: ["audio"],
    },
    type: "response.create",
  } as const;
}

/** The same local submission is measured in Main and sent by the driver. */
export function voiceToolResultEvents(
  command: Extract<VoiceClientCommand, { type: "tool.result" }>,
) {
  return [
    {
      event_id: `${command.requestId}.output`,
      item: {
        call_id: command.callId,
        output: command.output,
        type: "function_call_output",
      },
      type: "conversation.item.create",
    },
    voiceResponseCreateEvent(command),
  ] as const;
}

export interface VoiceApi {
  cancelStart(
    request: VoiceCancelStartRequest,
  ): Promise<VoiceCancelStartResponse>;
  end(request: VoiceSessionRequest): Promise<VoiceMutationResponse>;
  getActive(): Promise<VoiceSnapshotResponse>;
  preview(request: VoicePreviewSubmission): Promise<VoicePreviewResponse>;
  quickStart(
    request: VoiceQuickStartSubmission,
  ): Promise<VoiceQuickStartResponse>;
  report(request: VoiceDriverEventRequest): Promise<VoiceMutationResponse>;
  setMuted(request: VoiceMutedRequest): Promise<VoiceMutationResponse>;
  setPaused(request: VoicePausedSubmission): Promise<VoicePauseResponse>;
  start(request: VoiceStartSubmission): Promise<VoiceStartResponse>;
  subscribeChanged(
    listener: (snapshot: VoiceSessionSnapshot | null) => void,
  ): () => void;
  subscribeCommand(listener: (command: VoiceClientCommand) => void): () => void;
}
