import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./primitives";

export const CompanionProtocolVersionSchema = Type.Literal(1);

export const CompanionPlatformSchema = Type.Literal("android");

export const CompanionNotificationPermissionSchema = Type.Union([
  Type.Literal("unknown"),
  Type.Literal("granted"),
  Type.Literal("denied"),
]);

export const CompanionDeviceStatusSchema = Type.Union([
  Type.Object(
    {
      observedAt: TimestampSchema,
      state: Type.Literal("online"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      observedAt: TimestampSchema,
      state: Type.Literal("offline"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      message: NonBlankStringSchema,
      observedAt: TimestampSchema,
      state: Type.Literal("protocol_error"),
    },
    { additionalProperties: false },
  ),
]);

export const CompanionDeviceSchema = Type.Object(
  {
    displayName: NonBlankStringSchema,
    id: EntityIdSchema,
    installationId: EntityIdSchema,
    notificationPermission: CompanionNotificationPermissionSchema,
    notificationsEnabled: Type.Boolean(),
    pairedAt: TimestampSchema,
    platform: CompanionPlatformSchema,
    protocolVersion: CompanionProtocolVersionSchema,
    status: CompanionDeviceStatusSchema,
  },
  { additionalProperties: false },
);

export const CompanionDesktopDeviceSchema = Type.Object(
  {
    displayName: NonBlankStringSchema,
    id: EntityIdSchema,
    notificationPermission: CompanionNotificationPermissionSchema,
    notificationsEnabled: Type.Boolean(),
    pairedAt: TimestampSchema,
    platform: CompanionPlatformSchema,
    status: CompanionDeviceStatusSchema,
  },
  { additionalProperties: false },
);

export const CompanionDesktopSnapshotSchema = Type.Union([
  Type.Object(
    {
      state: Type.Literal("unpaired"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      expiresAt: TimestampSchema,
      qrPayload: NonBlankStringSchema,
      state: Type.Literal("pairing"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      device: CompanionDesktopDeviceSchema,
      state: Type.Literal("paired"),
    },
    { additionalProperties: false },
  ),
]);

export const CompanionDesktopEmptyRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const CompanionDesktopSetNotificationsEnabledRequestSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CompanionDesktopUnpairRequestSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
  },
  { additionalProperties: false },
);

function operationResponse<TValue extends TSchema>(value: TValue) {
  return Type.Union([
    Type.Object(
      { ok: Type.Literal(true), value },
      { additionalProperties: false },
    ),
    Type.Object(
      { error: AppErrorSchema, ok: Type.Literal(false) },
      { additionalProperties: false },
    ),
  ]);
}

export const CompanionDesktopSnapshotResponseSchema = operationResponse(
  CompanionDesktopSnapshotSchema,
);

export const CompanionPairingTicketSchema = Type.Object(
  {
    desktopInstanceId: EntityIdSchema,
    expiresAt: TimestampSchema,
    pairingId: EntityIdSchema,
    pairingSecret: NonBlankStringSchema,
    protocolVersion: CompanionProtocolVersionSchema,
    relayOrigin: Type.String({
      pattern: "^https://[^\\s]+$",
    }),
  },
  { additionalProperties: false },
);

export const CompanionPairingClaimSchema = Type.Object(
  {
    deviceDisplayName: NonBlankStringSchema,
    installationId: EntityIdSchema,
    notificationPermission: CompanionNotificationPermissionSchema,
    pairingId: EntityIdSchema,
    pairingSecret: NonBlankStringSchema,
    protocolVersion: CompanionProtocolVersionSchema,
    pushRegistrationId: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const CompanionPairingGrantSchema = Type.Object(
  {
    desktopInstanceId: EntityIdSchema,
    device: CompanionDeviceSchema,
    deviceCredential: NonBlankStringSchema,
    protocolVersion: CompanionProtocolVersionSchema,
  },
  { additionalProperties: false },
);

export const CompanionDeviceNotificationPreferenceRequestSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    enabled: Type.Boolean(),
    protocolVersion: CompanionProtocolVersionSchema,
  },
  { additionalProperties: false },
);

export const CompanionDeviceRegistrationUpdateSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    notificationPermission: CompanionNotificationPermissionSchema,
    protocolVersion: CompanionProtocolVersionSchema,
    pushRegistrationId: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const CompanionUnpairRequestSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    protocolVersion: CompanionProtocolVersionSchema,
  },
  { additionalProperties: false },
);

export const CompanionDesktopMailboxRecipientSchema = Type.Object(
  {
    desktopInstanceId: EntityIdSchema,
    kind: Type.Literal("desktop"),
  },
  { additionalProperties: false },
);

export const CompanionAndroidMailboxRecipientSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    kind: Type.Literal("android"),
  },
  { additionalProperties: false },
);

export const CompanionMailboxRecipientSchema = Type.Union([
  CompanionDesktopMailboxRecipientSchema,
  CompanionAndroidMailboxRecipientSchema,
]);

export const CompanionMailboxCursorSchema = NonBlankStringSchema;

export const CompanionShareTargetSchema = Type.Union([
  Type.Object(
    {
      chatId: EntityIdSchema,
      kind: Type.Literal("existing_chat"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("new_chat"),
    },
    { additionalProperties: false },
  ),
]);

export const CompanionChatTargetSchema = Type.Object(
  {
    chatId: EntityIdSchema,
    title: NonBlankStringSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const CompanionChatTargetSnapshotSchema = Type.Object(
  {
    generatedAt: TimestampSchema,
    targets: Type.Array(CompanionChatTargetSchema),
  },
  { additionalProperties: false },
);

export const CompanionUploadContentKindSchema = Type.Union([
  Type.Literal("image"),
  Type.Literal("text"),
  Type.Literal("markdown"),
  Type.Literal("pdf"),
  Type.Literal("file"),
]);

export const CompanionUploadAssetSchema = Type.Object(
  {
    byteLength: Type.Integer({ minimum: 0 }),
    contentKind: CompanionUploadContentKindSchema,
    displayName: NonBlankStringSchema,
    expiresAt: TimestampSchema,
    mediaType: NonBlankStringSchema,
    relayAssetId: EntityIdSchema,
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
);

export const CompanionUploadCreateRequestSchema = Type.Object(
  {
    byteLength: Type.Integer({ minimum: 0 }),
    contentKind: CompanionUploadContentKindSchema,
    deviceId: EntityIdSchema,
    displayName: NonBlankStringSchema,
    mediaType: NonBlankStringSchema,
    protocolVersion: CompanionProtocolVersionSchema,
    sha256: Sha256Schema,
    submissionId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const CompanionUploadReceiptSchema = Type.Object(
  {
    asset: CompanionUploadAssetSchema,
    deviceId: EntityIdSchema,
    protocolVersion: CompanionProtocolVersionSchema,
    submissionId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const CompanionSharePayloadSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("text"),
      mediaType: Type.Union([
        Type.Literal("text/plain"),
        Type.Literal("text/markdown"),
      ]),
      submissionId: EntityIdSchema,
      target: CompanionShareTargetSchema,
      text: NonBlankStringSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attachment: CompanionUploadAssetSchema,
      caption: Type.Optional(Type.String()),
      kind: Type.Literal("attachment"),
      submissionId: EntityIdSchema,
      target: CompanionShareTargetSchema,
    },
    { additionalProperties: false },
  ),
]);

export const CompanionNotificationMessageSchema = Type.Object(
  {
    body: NonBlankStringSchema,
    chatId: EntityIdSchema,
    messageCreatedAt: TimestampSchema,
    messageId: EntityIdSchema,
    role: Type.Literal("assistant"),
    status: Type.Literal("completed"),
    title: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const CompanionShareUploadedEventSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    share: CompanionSharePayloadSchema,
    type: Type.Literal("companion.share.uploaded"),
  },
  { additionalProperties: false },
);

export const CompanionNotificationCreatedEventSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    notification: CompanionNotificationMessageSchema,
    type: Type.Literal("companion.notification.created"),
  },
  { additionalProperties: false },
);

export const CompanionChatTargetsReplacedEventSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    snapshot: CompanionChatTargetSnapshotSchema,
    type: Type.Literal("companion.chat_targets.replaced"),
  },
  { additionalProperties: false },
);

export const CompanionAndroidMailboxEventSchema = Type.Union([
  CompanionNotificationCreatedEventSchema,
  CompanionChatTargetsReplacedEventSchema,
]);

export const CompanionMailboxEventSchema = Type.Union([
  CompanionShareUploadedEventSchema,
  CompanionNotificationCreatedEventSchema,
  CompanionChatTargetsReplacedEventSchema,
]);

const CompanionMailboxEnvelopeBaseProperties = {
  createdAt: TimestampSchema,
  cursor: CompanionMailboxCursorSchema,
  expiresAt: TimestampSchema,
  id: EntityIdSchema,
  protocolVersion: CompanionProtocolVersionSchema,
};

export const CompanionDesktopMailboxEnvelopeSchema = Type.Object(
  {
    ...CompanionMailboxEnvelopeBaseProperties,
    event: CompanionShareUploadedEventSchema,
    recipient: CompanionDesktopMailboxRecipientSchema,
  },
  { additionalProperties: false },
);

export const CompanionAndroidMailboxEnvelopeSchema = Type.Object(
  {
    ...CompanionMailboxEnvelopeBaseProperties,
    event: CompanionAndroidMailboxEventSchema,
    recipient: CompanionAndroidMailboxRecipientSchema,
  },
  { additionalProperties: false },
);

export const CompanionMailboxEnvelopeSchema = Type.Union([
  CompanionDesktopMailboxEnvelopeSchema,
  CompanionAndroidMailboxEnvelopeSchema,
]);

export const CompanionMailboxFetchRequestSchema = Type.Object(
  {
    afterCursor: Type.Optional(CompanionMailboxCursorSchema),
    protocolVersion: CompanionProtocolVersionSchema,
    recipient: CompanionMailboxRecipientSchema,
  },
  { additionalProperties: false },
);

const CompanionMailboxPageBaseProperties = {
  hasMore: Type.Boolean(),
  protocolVersion: CompanionProtocolVersionSchema,
};

export const CompanionDesktopMailboxPageSchema = Type.Object(
  {
    ...CompanionMailboxPageBaseProperties,
    envelopes: Type.Array(CompanionDesktopMailboxEnvelopeSchema),
    recipient: CompanionDesktopMailboxRecipientSchema,
  },
  { additionalProperties: false },
);

export const CompanionAndroidMailboxPageSchema = Type.Object(
  {
    ...CompanionMailboxPageBaseProperties,
    envelopes: Type.Array(CompanionAndroidMailboxEnvelopeSchema),
    recipient: CompanionAndroidMailboxRecipientSchema,
  },
  { additionalProperties: false },
);

export const CompanionMailboxPageSchema = Type.Union([
  CompanionDesktopMailboxPageSchema,
  CompanionAndroidMailboxPageSchema,
]);

export const CompanionShareImportedAckResultSchema = Type.Object(
  {
    attachmentId: Type.Optional(EntityIdSchema),
    chatId: EntityIdSchema,
    messageId: EntityIdSchema,
    submissionId: EntityIdSchema,
    type: Type.Literal("share.imported"),
  },
  { additionalProperties: false },
);

export const CompanionEnvelopeReceivedAckResultSchema = Type.Object(
  {
    type: Type.Literal("envelope.received"),
  },
  { additionalProperties: false },
);

export const CompanionMailboxAckResultSchema = Type.Union([
  CompanionShareImportedAckResultSchema,
  CompanionEnvelopeReceivedAckResultSchema,
]);

const CompanionMailboxAckBaseProperties = {
  acknowledgedAt: TimestampSchema,
  cursor: CompanionMailboxCursorSchema,
  envelopeId: EntityIdSchema,
  protocolVersion: CompanionProtocolVersionSchema,
};

export const CompanionDesktopMailboxAckSchema = Type.Object(
  {
    ...CompanionMailboxAckBaseProperties,
    recipient: CompanionDesktopMailboxRecipientSchema,
    result: CompanionShareImportedAckResultSchema,
  },
  { additionalProperties: false },
);

export const CompanionAndroidMailboxAckSchema = Type.Object(
  {
    ...CompanionMailboxAckBaseProperties,
    recipient: CompanionAndroidMailboxRecipientSchema,
    result: CompanionEnvelopeReceivedAckResultSchema,
  },
  { additionalProperties: false },
);

export const CompanionMailboxAckSchema = Type.Union([
  CompanionDesktopMailboxAckSchema,
  CompanionAndroidMailboxAckSchema,
]);

export const CompanionNotificationPushSchema = Type.Object(
  {
    cursor: CompanionMailboxCursorSchema,
    deviceId: EntityIdSchema,
    envelopeId: EntityIdSchema,
    notification: CompanionNotificationMessageSchema,
    protocolVersion: CompanionProtocolVersionSchema,
    type: Type.Literal("companion.notification"),
  },
  { additionalProperties: false },
);
