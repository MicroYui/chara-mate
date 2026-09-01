import type { TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { COMPANION_PROTOCOL_VERSION } from "../../src/shared/contracts/companion";
import {
  CompanionChatTargetSnapshotSchema,
  CompanionDeviceNotificationPreferenceRequestSchema,
  CompanionDeviceRegistrationUpdateSchema,
  CompanionDeviceSchema,
  CompanionDesktopSnapshotResponseSchema,
  CompanionDesktopSnapshotSchema,
  CompanionMailboxAckSchema,
  CompanionMailboxEnvelopeSchema,
  CompanionMailboxFetchRequestSchema,
  CompanionMailboxPageSchema,
  CompanionNotificationMessageSchema,
  CompanionNotificationPushSchema,
  CompanionPairingClaimSchema,
  CompanionPairingGrantSchema,
  CompanionPairingTicketSchema,
  CompanionSharePayloadSchema,
  CompanionUnpairRequestSchema,
  CompanionUploadAssetSchema,
  CompanionUploadCreateRequestSchema,
  CompanionUploadReceiptSchema,
} from "../../src/shared/schemas/companion";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";
import {
  COMPANION_FIXTURE_IDS,
  COMPANION_FIXTURE_TIMESTAMPS,
  companionChatTargetEnvelopeFixture,
  companionChatTargetSnapshotFixture,
  companionDeviceFixture,
  companionMailboxFetchRequestFixture,
  companionMailboxPageFixture,
  companionNotificationAckFixture,
  companionNotificationEnvelopeFixture,
  companionNotificationPushFixture,
  companionPairingClaimFixture,
  companionPairingGrantFixture,
  companionPairingTicketFixture,
  companionShareAckFixture,
  companionShareEnvelopeFixture,
  companionUploadAssetFixture,
  companionUploadCreateRequestFixture,
  companionUploadReceiptFixture,
} from "../fixtures/companionContracts";

const parsers = [parseSchema, parseSchemaWithoutCodeGeneration] as const;

const validCases: readonly (readonly [string, TSchema, unknown])[] = [
  ["device", CompanionDeviceSchema, companionDeviceFixture],
  [
    "pairing ticket",
    CompanionPairingTicketSchema,
    companionPairingTicketFixture,
  ],
  ["pairing claim", CompanionPairingClaimSchema, companionPairingClaimFixture],
  ["pairing grant", CompanionPairingGrantSchema, companionPairingGrantFixture],
  ["upload asset", CompanionUploadAssetSchema, companionUploadAssetFixture],
  [
    "upload create request",
    CompanionUploadCreateRequestSchema,
    companionUploadCreateRequestFixture,
  ],
  [
    "upload receipt",
    CompanionUploadReceiptSchema,
    companionUploadReceiptFixture,
  ],
  [
    "chat target snapshot",
    CompanionChatTargetSnapshotSchema,
    companionChatTargetSnapshotFixture,
  ],
  [
    "share envelope",
    CompanionMailboxEnvelopeSchema,
    companionShareEnvelopeFixture,
  ],
  [
    "notification envelope",
    CompanionMailboxEnvelopeSchema,
    companionNotificationEnvelopeFixture,
  ],
  [
    "chat target envelope",
    CompanionMailboxEnvelopeSchema,
    companionChatTargetEnvelopeFixture,
  ],
  [
    "mailbox fetch request",
    CompanionMailboxFetchRequestSchema,
    companionMailboxFetchRequestFixture,
  ],
  ["mailbox page", CompanionMailboxPageSchema, companionMailboxPageFixture],
  ["share ack", CompanionMailboxAckSchema, companionShareAckFixture],
  [
    "notification ack",
    CompanionMailboxAckSchema,
    companionNotificationAckFixture,
  ],
  [
    "notification push",
    CompanionNotificationPushSchema,
    companionNotificationPushFixture,
  ],
  [
    "notification preference",
    CompanionDeviceNotificationPreferenceRequestSchema,
    {
      deviceId: COMPANION_FIXTURE_IDS.device,
      enabled: false,
      protocolVersion: 1,
    },
  ],
  [
    "device registration update",
    CompanionDeviceRegistrationUpdateSchema,
    {
      deviceId: COMPANION_FIXTURE_IDS.device,
      notificationPermission: "granted",
      protocolVersion: 1,
      pushRegistrationId: "refreshed-opaque-push-registration-id",
    },
  ],
  [
    "unpair request",
    CompanionUnpairRequestSchema,
    { deviceId: COMPANION_FIXTURE_IDS.device, protocolVersion: 1 },
  ],
  [
    "plain text share",
    CompanionSharePayloadSchema,
    {
      kind: "text",
      mediaType: "text/plain",
      submissionId: COMPANION_FIXTURE_IDS.submission,
      target: { kind: "new_chat" },
      text: "今天的分享结束了",
    },
  ],
  [
    "desktop paired snapshot",
    CompanionDesktopSnapshotSchema,
    {
      device: {
        displayName: companionDeviceFixture.displayName,
        id: companionDeviceFixture.id,
        notificationPermission: companionDeviceFixture.notificationPermission,
        notificationsEnabled: companionDeviceFixture.notificationsEnabled,
        pairedAt: companionDeviceFixture.pairedAt,
        platform: companionDeviceFixture.platform,
        status: companionDeviceFixture.status,
      },
      state: "paired",
    },
  ],
];

describe("Android Companion v1 boundary contracts", () => {
  it.each(parsers)("round-trips every v1 value through %s", (parse) => {
    expect(COMPANION_PROTOCOL_VERSION).toBe(1);
    for (const [, schema, value] of validCases) {
      expect(parse(schema, value)).toEqual(value);
    }
  });

  it.each(parsers)(
    "rejects version drift and undeclared wire state through %s",
    (parse) => {
      expect(() =>
        parse(CompanionPairingTicketSchema, {
          ...companionPairingTicketFixture,
          protocolVersion: 2,
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionDeviceSchema, {
          ...companionDeviceFixture,
          cloudAgentEnabled: true,
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionPairingClaimSchema, {
          ...companionPairingClaimFixture,
          fcmServiceAccount: "must-stay-on-relay",
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionPairingTicketSchema, {
          ...companionPairingTicketFixture,
          relayOrigin: "http://relay.example.test",
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "keeps Desktop snapshots free of relay credentials and mailbox state through %s",
    (parse) => {
      const desktopDevice = {
        displayName: companionDeviceFixture.displayName,
        id: companionDeviceFixture.id,
        notificationPermission: companionDeviceFixture.notificationPermission,
        notificationsEnabled: companionDeviceFixture.notificationsEnabled,
        pairedAt: companionDeviceFixture.pairedAt,
        platform: companionDeviceFixture.platform,
        status: companionDeviceFixture.status,
      };
      expect(
        parse(CompanionDesktopSnapshotResponseSchema, {
          ok: true,
          value: { device: desktopDevice, state: "paired" },
        }),
      ).toEqual({
        ok: true,
        value: { device: desktopDevice, state: "paired" },
      });
      for (const [field, value] of [
        ["installationId", companionDeviceFixture.installationId],
        ["deviceCredential", "must-stay-in-main"],
        ["cursor", "must-stay-in-main"],
      ] as const) {
        expect(() =>
          parse(CompanionDesktopSnapshotSchema, {
            device: { ...desktopDevice, [field]: value },
            state: "paired",
          }),
        ).toThrow();
      }
    },
  );

  it.each(parsers)(
    "keeps notifications bound to one completed assistant message through %s",
    (parse) => {
      const notification =
        companionNotificationEnvelopeFixture.event.notification;
      expect(parse(CompanionNotificationMessageSchema, notification)).toEqual(
        notification,
      );
      expect(() =>
        parse(CompanionNotificationMessageSchema, {
          ...notification,
          role: "user",
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionNotificationMessageSchema, {
          ...notification,
          status: "streaming",
        }),
      ).toThrow();
      const withoutMessageId = Object.fromEntries(
        Object.entries(notification).filter(([key]) => key !== "messageId"),
      );
      expect(() =>
        parse(CompanionNotificationMessageSchema, withoutMessageId),
      ).toThrow();
      const withoutChatId = Object.fromEntries(
        Object.entries(notification).filter(([key]) => key !== "chatId"),
      );
      expect(() =>
        parse(CompanionNotificationMessageSchema, withoutChatId),
      ).toThrow();
      expect(() =>
        parse(CompanionNotificationPushSchema, {
          ...companionNotificationPushFixture,
          deliveredAt: COMPANION_FIXTURE_TIMESTAMPS.created,
          deliveryStatus: "delivered",
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "keeps uploads single, reference-only and independent of local paths through %s",
    (parse) => {
      expect(
        parse(CompanionUploadAssetSchema, companionUploadAssetFixture),
      ).toEqual(companionUploadAssetFixture);
      for (const forbiddenField of [
        "contentUri",
        "downloadUrl",
        "path",
        "storageKey",
      ]) {
        expect(() =>
          parse(CompanionUploadAssetSchema, {
            ...companionUploadAssetFixture,
            [forbiddenField]: "external-location",
          }),
        ).toThrow();
      }
      expect(() =>
        parse(CompanionSharePayloadSchema, {
          ...companionShareEnvelopeFixture.event.share,
          attachments: [companionUploadAssetFixture],
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionUploadCreateRequestSchema, {
          ...companionUploadCreateRequestFixture,
          contentUri: "content://temporary/mobile-uri",
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "requires opaque cursors and an import receipt before a share ack through %s",
    (parse) => {
      expect(() =>
        parse(CompanionMailboxFetchRequestSchema, {
          ...companionMailboxFetchRequestFixture,
          afterCursor: "",
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionMailboxEnvelopeSchema, {
          ...companionShareEnvelopeFixture,
          cursor: "",
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionMailboxAckSchema, {
          ...companionShareAckFixture,
          result: { type: "share.imported" },
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionMailboxAckSchema, {
          ...companionNotificationAckFixture,
          result: {
            chatId: COMPANION_FIXTURE_IDS.chat,
            type: "envelope.received",
          },
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "binds share import to Desktop and notification receipt to Android through %s",
    (parse) => {
      expect(() =>
        parse(CompanionMailboxEnvelopeSchema, {
          ...companionNotificationEnvelopeFixture,
          recipient: companionShareEnvelopeFixture.recipient,
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionMailboxEnvelopeSchema, {
          ...companionShareEnvelopeFixture,
          recipient: companionNotificationEnvelopeFixture.recipient,
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionMailboxAckSchema, {
          ...companionShareAckFixture,
          result: { type: "envelope.received" },
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionMailboxAckSchema, {
          ...companionNotificationAckFixture,
          result: companionShareAckFixture.result,
        }),
      ).toThrow();
      expect(() =>
        parse(CompanionMailboxPageSchema, {
          ...companionMailboxPageFixture,
          recipient: companionNotificationEnvelopeFixture.recipient,
        }),
      ).toThrow();
    },
  );

  it.each(parsers)(
    "keeps share retries tied to one stable submission without exposing chat history through %s",
    (parse) => {
      const share = companionShareEnvelopeFixture.event.share;
      expect(parse(CompanionSharePayloadSchema, share)).toEqual(share);
      const withoutSubmissionId = Object.fromEntries(
        Object.entries(share).filter(([key]) => key !== "submissionId"),
      );
      expect(() =>
        parse(CompanionSharePayloadSchema, withoutSubmissionId),
      ).toThrow();
      expect(() =>
        parse(CompanionChatTargetSnapshotSchema, {
          ...companionChatTargetSnapshotFixture,
          messages: ["full chat history must stay on Desktop"],
        }),
      ).toThrow();
      expect(companionUploadReceiptFixture.submissionId).toBe(
        companionUploadCreateRequestFixture.submissionId,
      );
    },
  );
});
