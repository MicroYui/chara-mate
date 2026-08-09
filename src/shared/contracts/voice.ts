import type { Static } from "@sinclair/typebox";

import type {
  VoiceClientCommandSchema,
  VoiceConnectionSchema,
  VoiceDriverEventRequestSchema,
  VoiceDriverEventSchema,
  VoiceEmptyRequestSchema,
  VoiceInputModeSchema,
  VoiceHistoryMessageSchema,
  VoiceMutedRequestSchema,
  VoiceMutationResponseSchema,
  VoiceNameSchema,
  VoicePhaseSchema,
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
  changed: "voice.changed",
  command: "voice.command",
  end: "voice.end",
  event: "voice.event",
  getActive: "voice.getActive",
  preview: "voice.preview",
  quickStart: "voice.quickStart",
  setMuted: "voice.setMuted",
  start: "voice.start",
} as const;

export const VOICE_CHAT_FALLBACK_TITLE = "语音对话";

export type VoiceName = Static<typeof VoiceNameSchema>;
export type VoiceInputMode = Static<typeof VoiceInputModeSchema>;
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
export type VoiceSnapshotResponse = Static<typeof VoiceSnapshotResponseSchema>;

export interface VoiceApi {
  end(request: VoiceSessionRequest): Promise<VoiceMutationResponse>;
  getActive(): Promise<VoiceSnapshotResponse>;
  preview(request: VoicePreviewRequest): Promise<VoicePreviewResponse>;
  quickStart(request: VoiceQuickStartRequest): Promise<VoiceQuickStartResponse>;
  report(request: VoiceDriverEventRequest): Promise<VoiceMutationResponse>;
  setMuted(request: VoiceMutedRequest): Promise<VoiceMutationResponse>;
  start(request: VoiceStartRequest): Promise<VoiceStartResponse>;
  subscribeChanged(
    listener: (snapshot: VoiceSessionSnapshot | null) => void,
  ): () => void;
  subscribeCommand(listener: (command: VoiceClientCommand) => void): () => void;
}
