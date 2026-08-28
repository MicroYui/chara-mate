import type { Static } from "@sinclair/typebox";

import type {
  VoiceWakePhaseSchema,
  VoiceWakeReportRequestSchema,
  VoiceWakeReportedPhaseSchema,
  VoiceWakeSetEnabledRequestSchema,
  VoiceWakeSnapshotResponseSchema,
  VoiceWakeSnapshotSchema,
} from "../schemas/voiceWake";

export const VOICE_WAKE_PHRASE = "Hi Mika" as const;

export const VOICE_WAKE_CHANNELS = {
  changed: "voiceWake.changed",
  getSnapshot: "voiceWake.getSnapshot",
  report: "voiceWake.report",
  setEnabled: "voiceWake.setEnabled",
} as const;

export type VoiceWakePhase = Static<typeof VoiceWakePhaseSchema>;
export type VoiceWakeReportedPhase = Static<
  typeof VoiceWakeReportedPhaseSchema
>;
export type VoiceWakeSnapshot = Static<typeof VoiceWakeSnapshotSchema>;
export type VoiceWakeSetEnabledRequest = Static<
  typeof VoiceWakeSetEnabledRequestSchema
>;
export type VoiceWakeReportRequest = Static<
  typeof VoiceWakeReportRequestSchema
>;
export type VoiceWakeSnapshotResponse = Static<
  typeof VoiceWakeSnapshotResponseSchema
>;

export interface VoiceWakeSubscriptionApi {
  getSnapshot(): Promise<VoiceWakeSnapshotResponse>;
  subscribe(listener: (snapshot: VoiceWakeSnapshot) => void): () => void;
}

export interface VoiceWakeSettingsApi extends VoiceWakeSubscriptionApi {
  setEnabled(
    request: VoiceWakeSetEnabledRequest,
  ): Promise<VoiceWakeSnapshotResponse>;
}

export interface VoiceWakeCharacterApi extends VoiceWakeSubscriptionApi {
  report(request: VoiceWakeReportRequest): Promise<VoiceWakeSnapshotResponse>;
}
