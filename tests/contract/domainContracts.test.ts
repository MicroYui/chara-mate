import type { TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { ChatSchema, MessageSchema } from "../../src/shared/schemas/chat";
import {
  IpcChannelSchema,
  IpcRequestSchema,
  IpcResponseSchema,
  RunEventEnvelopeSchema,
  RunEventReplayRequestSchema,
  RunEventReplayResponseSchema,
} from "../../src/shared/schemas/ipc";
import { FOUNDATION_CHANNELS } from "../../src/shared/contracts/foundation";
import { ProviderSnapshotSchema } from "../../src/shared/schemas/provider";
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
  artifactFixture,
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

const validCases: readonly [string, TSchema, unknown][] = [
  ["Chat", ChatSchema, chatFixture],
  ["Message", MessageSchema, messageFixture],
  ["Provider snapshot", ProviderSnapshotSchema, providerSnapshotFixture],
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
    "rejects Decision-gated or hidden fields in Run items through %s",
    (parse) => {
      expect(() =>
        parse(RunItemSchema, { ...runItemFixture, kind: "subtask" }),
      ).toThrow();
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
