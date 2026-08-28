import { describe, expect, it } from "vitest";

import {
  VOICE_WAKE_CHANNELS,
  VOICE_WAKE_PHRASE,
} from "../../src/shared/contracts/voiceWake";
import { IpcChannelSchema } from "../../src/shared/schemas/ipc";
import {
  VoiceWakeReportRequestSchema,
  VoiceWakeSetEnabledRequestSchema,
  VoiceWakeSnapshotResponseSchema,
} from "../../src/shared/schemas/voiceWake";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";

const parsers = [parseSchema, parseSchemaWithoutCodeGeneration] as const;

describe("VOICE-WAKE boundary contracts", () => {
  it.each(parsers)(
    "accepts the fixed phrase and typed IPC through %s",
    (parse) => {
      expect(VOICE_WAKE_PHRASE).toBe("Hi Mika");
      for (const channel of Object.values(VOICE_WAKE_CHANNELS)) {
        expect(parse(IpcChannelSchema, channel)).toBe(channel);
      }
      expect(
        parse(VoiceWakeSetEnabledRequestSchema, { enabled: true }),
      ).toEqual({
        enabled: true,
      });
      expect(
        parse(VoiceWakeReportRequestSchema, { phase: "detected" }),
      ).toEqual({
        phase: "detected",
      });
      expect(
        parse(VoiceWakeSnapshotResponseSchema, {
          ok: true,
          value: {
            enabled: true,
            microphone: "granted",
            phase: "listening",
            phrase: "Hi Mika",
          },
        }),
      ).toMatchObject({ ok: true, value: { phase: "listening" } });
    },
  );

  it.each(parsers)(
    "rejects runtime modes and non-fixed phrases through %s",
    (parse) => {
      expect(() =>
        parse(VoiceWakeSnapshotResponseSchema, {
          ok: true,
          value: {
            enabled: true,
            microphone: "granted",
            phase: "listening",
            phrase: "Hey Mika",
          },
        }),
      ).toThrow();
      expect(() =>
        parse(VoiceWakeSetEnabledRequestSchema, {
          enabled: true,
          provider: "cloud-fallback",
        }),
      ).toThrow();
      expect(() =>
        parse(VoiceWakeReportRequestSchema, { phase: "voice_active" }),
      ).toThrow();
    },
  );
});
