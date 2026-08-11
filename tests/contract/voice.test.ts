import { describe, expect, it } from "vitest";

import { VOICE_CHANNELS } from "../../src/shared/contracts/voice";
import { IpcChannelSchema } from "../../src/shared/schemas/ipc";
import {
  VoiceClientCommandSchema,
  VoiceDriverEventRequestSchema,
  VoicePausedRequestSchema,
  VoicePauseResponseSchema,
  VoiceQuickStartRequestSchema,
  VoiceSessionRecordSchema,
  VoiceStartRequestSchema,
  VoiceTurnRecordSchema,
} from "../../src/shared/schemas/voice";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";
import {
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
} from "../fixtures/foundationContracts";

const parsers = [parseSchema, parseSchemaWithoutCodeGeneration] as const;
const sessionId = "20000000-0000-4000-8000-000000000001";
const turnId = "20000000-0000-4000-8000-000000000002";

const session = {
  chatId: FIXTURE_IDS.chat,
  connectedAt: FIXTURE_TIMESTAMPS.updated,
  createdAt: FIXTURE_TIMESTAMPS.created,
  generation: 1,
  id: sessionId,
  inputMode: "hands_free",
  instructions: "自然、简洁地说中文。",
  muted: false,
  protocolSessionId: "session-protocol",
  provider: {
    apiStyle: "azure-openai",
    modelId: "gpt-realtime-2.1",
    profileId: FIXTURE_IDS.provider,
    profileName: "Azure Voice",
  },
  status: "active",
  voice: "verse",
} as const;

const turn = {
  assistantTranscript: "已经完成。",
  generation: 1,
  id: turnId,
  instructions: session.instructions,
  interrupted: false,
  responseId: "response-1",
  sessionId,
  startedAt: FIXTURE_TIMESTAMPS.updated,
  status: "responding",
  userItemId: "item-user-1",
  userTranscript: "请完成任务。",
  voice: "verse",
} as const;

describe("Phase 4 Voice boundary contracts", () => {
  it.each(parsers)(
    "accepts typed Voice channels and values through %s",
    (parse) => {
      for (const channel of Object.values(VOICE_CHANNELS)) {
        expect(parse(IpcChannelSchema, channel)).toBe(channel);
      }
      expect(parse(VoiceSessionRecordSchema, session)).toEqual(session);
      expect(parse(VoiceTurnRecordSchema, turn)).toEqual(turn);
      expect(
        parse(VoiceStartRequestSchema, {
          chatId: FIXTURE_IDS.chat,
          chatProviderProfileId: FIXTURE_IDS.provider,
          execution: { approvalMode: "request_approval", mode: "agent" },
          requestedAt: FIXTURE_TIMESTAMPS.updated,
        }),
      ).toMatchObject({ chatId: FIXTURE_IDS.chat });
      expect(
        parse(VoiceQuickStartRequestSchema, {
          requestedAt: FIXTURE_TIMESTAMPS.updated,
        }),
      ).toEqual({ requestedAt: FIXTURE_TIMESTAMPS.updated });
      expect(
        parse(VoiceDriverEventRequestSchema, {
          event: {
            arguments: '{"city":"北京"}',
            callId: "call-1",
            generation: 1,
            itemId: "item-tool-1",
            name: "weather_lookup",
            responseId: "response-1",
            type: "tool.call",
          },
          occurredAt: FIXTURE_TIMESTAMPS.updated,
          sessionId,
        }),
      ).toMatchObject({ event: { callId: "call-1", type: "tool.call" } });
      expect(
        parse(VoiceClientCommandSchema, {
          generation: 1,
          instructions: "自然回答。",
          requestId: FIXTURE_IDS.request,
          sessionId,
          type: "response.create",
        }),
      ).toMatchObject({ generation: 1, type: "response.create" });
      expect(
        parse(VoiceClientCommandSchema, {
          callId: "call-1",
          generation: 1,
          instructions: "自然回答。",
          output: '{"status":"success"}',
          requestId: FIXTURE_IDS.request,
          sessionId,
          type: "tool.result",
        }),
      ).toMatchObject({ callId: "call-1", type: "tool.result" });
      expect(
        parse(VoicePausedRequestSchema, {
          paused: true,
          requestedAt: FIXTURE_TIMESTAMPS.updated,
          sessionId,
        }),
      ).toMatchObject({ paused: true, sessionId });
      expect(
        parse(VoiceClientCommandSchema, {
          instructions: "恢复后的指令。",
          requestId: FIXTURE_IDS.request,
          sessionId,
          tools: [
            {
              description: "查询天气。",
              name: "weather_lookup",
              parameters: { properties: {}, type: "object" },
              type: "function",
            },
          ],
          type: "session.refresh",
        }),
      ).toMatchObject({ type: "session.refresh" });
      expect(
        parse(VoiceDriverEventRequestSchema, {
          event: {
            durationMs: 320,
            stage: "microphone",
            type: "connection.stage",
          },
          occurredAt: FIXTURE_TIMESTAMPS.updated,
          sessionId,
        }),
      ).toMatchObject({ event: { stage: "microphone" } });
      expect(
        parse(VoicePauseResponseSchema, {
          ok: true,
          value: {
            snapshot: {
              assistantTranscript: "",
              chatId: FIXTURE_IDS.chat,
              connectedAt: FIXTURE_TIMESTAMPS.updated,
              createdAt: FIXTURE_TIMESTAMPS.created,
              generation: 0,
              inputMode: "hands_free",
              muted: false,
              phase: "paused",
              sessionId,
              userTranscript: "",
              voice: "verse",
            },
          },
        }),
      ).toMatchObject({ ok: true, value: { snapshot: { phase: "paused" } } });
      expect(
        parse(VoiceDriverEventRequestSchema, {
          event: {
            generation: 1,
            hasAudio: true,
            responseId: "response-1",
            status: "completed",
            type: "response.done",
            usage: {
              cachedInputTokens: 1,
              inputTokens: 10,
              outputTokens: 4,
            },
          },
          occurredAt: FIXTURE_TIMESTAMPS.updated,
          sessionId,
        }),
      ).toMatchObject({ event: { generation: 1, type: "response.done" } });
    },
  );

  it.each(parsers)(
    "rejects ambiguous generations and boundary-only secrets through %s",
    (parse) => {
      expect(() =>
        parse(VoiceDriverEventRequestSchema, {
          event: {
            responseId: "response-1",
            status: "completed",
            type: "response.done",
          },
          occurredAt: FIXTURE_TIMESTAMPS.updated,
          sessionId,
        }),
      ).toThrow();
      expect(() =>
        parse(VoiceSessionRecordSchema, {
          ...session,
          clientSecret: "must-not-persist",
        }),
      ).toThrow();
      expect(() =>
        parse(VoiceStartRequestSchema, {
          chatId: FIXTURE_IDS.chat,
          execution: { mode: "chat" },
          inputMode: "push_to_talk",
          requestedAt: FIXTURE_TIMESTAMPS.updated,
        }),
      ).toThrow();
      expect(() =>
        parse(VoiceStartRequestSchema, {
          chatId: FIXTURE_IDS.chat,
          execution: { mode: "chat" },
          requestedAt: FIXTURE_TIMESTAMPS.updated,
          transport: "websocket",
        }),
      ).toThrow();
      expect(() =>
        parse(VoiceClientCommandSchema, {
          generation: 1,
          instructions: "自然回答。",
          requestId: FIXTURE_IDS.request,
          sessionId,
          text: "旧朗读路径",
          type: "speech.create",
        }),
      ).toThrow();
    },
  );
});
