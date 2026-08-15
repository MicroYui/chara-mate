import type { TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import {
  AttachmentSchema,
  ChatCreateRequestSchema,
  ChatDataSnapshotRequestSchema,
  ChatDataSnapshotResponseSchema,
  ChatDataSnapshotSchema,
  ChatDeleteResponseSchema,
  ChatGetSnapshotResponseSchema,
  ChatIdRequestSchema,
  ChatListRequestSchema,
  ChatListResponseSchema,
  ChatMutationResponseSchema,
  ChatRenameRequestSchema,
  ChatSchema,
  ChatSetPinnedRequestSchema,
  MessageSchema,
} from "../../src/shared/schemas/chat";
import { CHAT_CHANNELS } from "../../src/shared/contracts/chat";
import {
  IpcChannelSchema,
  IpcRequestSchema,
  IpcResponseSchema,
  RunEventEnvelopeSchema,
  RunEventReplayRequestSchema,
  RunEventReplayResponseSchema,
} from "../../src/shared/schemas/ipc";
import { FOUNDATION_CHANNELS } from "../../src/shared/contracts/foundation";
import { RUN_EVENT_CHANNELS } from "../../src/shared/contracts/ipc";
import { ProviderSnapshotSchema } from "../../src/shared/schemas/provider";
import { TimestampSchema } from "../../src/shared/schemas/primitives";
import {
  DataSettingsSnapshotResponseSchema,
  DataSettingsSnapshotSchema,
} from "../../src/shared/schemas/settings";
import {
  ApprovalSchema,
  AppErrorSchema,
  ArtifactReferenceSchema,
  RunCancelRequestSchema,
  RunCancelResultSchema,
  RunItemSchema,
  RunSchema,
} from "../../src/shared/schemas/run";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";
import {
  approvalFixture,
  attachmentFixture,
  artifactFixture,
  chatDataSnapshotFixture,
  chatFixture,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
  messageFixture,
  providerSnapshotFixture,
  runEventEnvelopeFixture,
  runFixture,
  runItemFixture,
} from "../fixtures/foundationContracts";

const parsers = [parseSchema, parseSchemaWithoutCodeGeneration] as const;

const dataSettingsSnapshot = {
  categories: [
    { byteLength: 4096, id: "database", label: "对话与应用数据库" },
    { byteLength: 2048, id: "territory", label: "领地场景与生成素材" },
  ],
  dataDirectory: "/Users/example/Library/Application Support/CharaMate",
  totalByteLength: 6144,
} as const;

const validCases: readonly [string, TSchema, unknown][] = [
  ["Chat", ChatSchema, chatFixture],
  ["Message", MessageSchema, messageFixture],
  ["Attachment", AttachmentSchema, attachmentFixture],
  ["Chat data snapshot", ChatDataSnapshotSchema, chatDataSnapshotFixture],
  [
    "Chat data snapshot request",
    ChatDataSnapshotRequestSchema,
    { chatId: FIXTURE_IDS.chat },
  ],
  [
    "Chat data snapshot response",
    ChatDataSnapshotResponseSchema,
    chatDataSnapshotFixture,
  ],
  ["Missing chat data snapshot", ChatDataSnapshotResponseSchema, null],
  [
    "Chat list request",
    ChatListRequestSchema,
    { query: "phase", status: "active" },
  ],
  ["Chat create request", ChatCreateRequestSchema, {}],
  [
    "Chat create request from first message",
    ChatCreateRequestSchema,
    { initialMessage: "Plan a weekend trip" },
  ],
  [
    "Chat rename request",
    ChatRenameRequestSchema,
    { chatId: FIXTURE_IDS.chat, title: "Renamed" },
  ],
  [
    "Chat pin request",
    ChatSetPinnedRequestSchema,
    { chatId: FIXTURE_IDS.chat, pinned: true },
  ],
  ["Chat ID request", ChatIdRequestSchema, { chatId: FIXTURE_IDS.chat }],
  [
    "Chat list response",
    ChatListResponseSchema,
    { ok: true, value: [chatFixture] },
  ],
  [
    "Chat mutation response",
    ChatMutationResponseSchema,
    { ok: true, value: chatFixture },
  ],
  [
    "Chat delete response",
    ChatDeleteResponseSchema,
    { ok: true, value: { chatId: FIXTURE_IDS.chat } },
  ],
  [
    "Chat snapshot operation response",
    ChatGetSnapshotResponseSchema,
    { ok: true, value: chatDataSnapshotFixture },
  ],
  ["Provider snapshot", ProviderSnapshotSchema, providerSnapshotFixture],
  ["Data settings snapshot", DataSettingsSnapshotSchema, dataSettingsSnapshot],
  [
    "Data settings response",
    DataSettingsSnapshotResponseSchema,
    { ok: true, value: dataSettingsSnapshot },
  ],
  ["Run", RunSchema, runFixture],
  ["Run item", RunItemSchema, runItemFixture],
  ["Artifact reference", ArtifactReferenceSchema, artifactFixture],
  ["Approval", ApprovalSchema, approvalFixture],
  ["Run event envelope", RunEventEnvelopeSchema, runEventEnvelopeFixture],
  [
    "Replay request",
    RunEventReplayRequestSchema,
    { afterSequence: 0, streamId: FIXTURE_IDS.run },
  ],
  [
    "Replay response",
    RunEventReplayResponseSchema,
    {
      events: [runEventEnvelopeFixture],
      latestSequence: 1,
      streamId: FIXTURE_IDS.run,
    },
  ],
  [
    "IPC request",
    IpcRequestSchema,
    {
      channel: "run.events.replay",
      payload: { afterSequence: 0, streamId: FIXTURE_IDS.run },
      requestId: FIXTURE_IDS.request,
    },
  ],
  [
    "IPC success response",
    IpcResponseSchema,
    {
      ok: true,
      requestId: FIXTURE_IDS.request,
      value: { latestSequence: 1 },
    },
  ],
  [
    "IPC error response",
    IpcResponseSchema,
    {
      error: {
        code: "RUN.NOT_FOUND",
        message: "Run not found",
        retryable: false,
      },
      ok: false,
      requestId: FIXTURE_IDS.request,
    },
  ],
  [
    "Application error",
    AppErrorSchema,
    {
      code: "PROVIDER.UNAVAILABLE",
      details: { attempt: 1 },
      message: "Provider is unavailable",
      retryable: true,
    },
  ],
  [
    "Cancellation request",
    RunCancelRequestSchema,
    { requestedAt: FIXTURE_TIMESTAMPS.updated, runId: FIXTURE_IDS.run },
  ],
  [
    "Cancellation accepted result",
    RunCancelResultSchema,
    { outcome: "accepted", runId: FIXTURE_IDS.run },
  ],
  [
    "Cancellation terminal result",
    RunCancelResultSchema,
    {
      outcome: "already_terminal",
      runId: FIXTURE_IDS.run,
      status: "completed",
    },
  ],
];

describe("Phase 0 domain contracts", () => {
  it.each(parsers)(
    "accepts the actual IPC channel names through %s",
    (parse) => {
      expect(parse(IpcChannelSchema, FOUNDATION_CHANNELS.getSnapshot)).toBe(
        FOUNDATION_CHANNELS.getSnapshot,
      );
      expect(parse(IpcChannelSchema, FOUNDATION_CHANNELS.rendererReady)).toBe(
        FOUNDATION_CHANNELS.rendererReady,
      );
      expect(parse(IpcChannelSchema, RUN_EVENT_CHANNELS.replay)).toBe(
        RUN_EVENT_CHANNELS.replay,
      );
      expect(parse(IpcChannelSchema, RUN_EVENT_CHANNELS.subscribe)).toBe(
        RUN_EVENT_CHANNELS.subscribe,
      );
      for (const channel of Object.values(CHAT_CHANNELS)) {
        expect(parse(IpcChannelSchema, channel)).toBe(channel);
      }
    },
  );

  it.each(parsers)(
    "accepts every valid boundary fixture through %s",
    (parse) => {
      for (const [, schema, value] of validCases) {
        expect(parse(schema, value)).toEqual(value);
      }
    },
  );

  it.each(parsers)("validates real UTC timestamps through %s", (parse) => {
    expect(parse(TimestampSchema, "2024-02-29T12:34:56.000Z")).toBe(
      "2024-02-29T12:34:56.000Z",
    );
    expect(parse(TimestampSchema, "2024-02-29T12:34:56Z")).toBe(
      "2024-02-29T12:34:56Z",
    );

    for (const timestamp of [
      "2026-02-29T12:34:56.000Z",
      "2026-13-01T12:34:56.000Z",
      "2026-08-01T24:00:00.000Z",
    ]) {
      expect(() => parse(TimestampSchema, timestamp)).toThrow();
    }
  });

  it.each(parsers)(
    "rejects credentials in Provider snapshots through %s",
    (parse) => {
      expect(() =>
        parse(ProviderSnapshotSchema, {
          ...providerSnapshotFixture,
          apiKey: "sk-must-not-persist",
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "accepts selected Run item kinds and rejects hidden fields through %s",
    (parse) => {
      expect(
        parse(RunItemSchema, { ...runItemFixture, kind: "subtask" }),
      ).toMatchObject({ kind: "subtask" });
      expect(() =>
        parse(RunItemSchema, {
          ...runItemFixture,
          hiddenReasoning: "must not be stored",
        }),
      ).toThrow();
    },
  );

  it.each(parsers)("keeps artifacts reference-only through %s", (parse) => {
    expect(() =>
      parse(ArtifactReferenceSchema, {
        ...artifactFixture,
        content: "large inline result",
      }),
    ).toThrow();
  });

  it.each(parsers)("keeps attachments reference-only through %s", (parse) => {
    expect(() =>
      parse(AttachmentSchema, {
        ...attachmentFixture,
        content: "large inline attachment",
      }),
    ).toThrow();
  });

  it.each(parsers)(
    "keeps Chat mode free of Agent approval settings through %s",
    (parse) => {
      expect(() =>
        parse(RunSchema, {
          ...runFixture,
          execution: { approvalMode: "full_access", mode: "chat" },
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "rejects malformed sequence, approval, error and cancellation payloads through %s",
    (parse) => {
      expect(() =>
        parse(RunEventEnvelopeSchema, {
          ...runEventEnvelopeFixture,
          sequence: 0,
        }),
      ).toThrow();
      expect(() =>
        parse(RunEventReplayRequestSchema, {
          afterSequence: -1,
          streamId: FIXTURE_IDS.run,
        }),
      ).toThrow();
      expect(() =>
        parse(ApprovalSchema, { ...approvalFixture, expiresAt: undefined }),
      ).toThrow();
      expect(() =>
        parse(AppErrorSchema, {
          code: "provider.unavailable",
          message: "bad code",
          retryable: false,
        }),
      ).toThrow();
      expect(() =>
        parse(RunCancelResultSchema, {
          outcome: "already_terminal",
          runId: FIXTURE_IDS.run,
          status: "running",
        }),
      ).toThrow();
    },
  );
});
