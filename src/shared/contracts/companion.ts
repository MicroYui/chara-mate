import type { Static } from "@sinclair/typebox";

import type {
  CompanionAndroidMailboxAckSchema,
  CompanionAndroidMailboxEnvelopeSchema,
  CompanionAndroidMailboxEventSchema,
  CompanionAndroidMailboxPageSchema,
  CompanionAndroidMailboxRecipientSchema,
  CompanionChatTargetSchema,
  CompanionChatTargetSnapshotSchema,
  CompanionChatTargetsReplacedEventSchema,
  CompanionDesktopMailboxAckSchema,
  CompanionDesktopMailboxEnvelopeSchema,
  CompanionDesktopMailboxPageSchema,
  CompanionDesktopMailboxRecipientSchema,
  CompanionDeviceNotificationPreferenceRequestSchema,
  CompanionDeviceRegistrationUpdateSchema,
  CompanionDeviceSchema,
  CompanionDeviceStatusSchema,
  CompanionMailboxAckResultSchema,
  CompanionMailboxAckSchema,
  CompanionMailboxCursorSchema,
  CompanionMailboxEnvelopeSchema,
  CompanionMailboxEventSchema,
  CompanionMailboxFetchRequestSchema,
  CompanionMailboxPageSchema,
  CompanionMailboxRecipientSchema,
  CompanionEnvelopeReceivedAckResultSchema,
  CompanionNotificationCreatedEventSchema,
  CompanionNotificationMessageSchema,
  CompanionNotificationPermissionSchema,
  CompanionNotificationPushSchema,
  CompanionPairingClaimSchema,
  CompanionPairingGrantSchema,
  CompanionPairingTicketSchema,
  CompanionPlatformSchema,
  CompanionProtocolVersionSchema,
  CompanionSharePayloadSchema,
  CompanionShareImportedAckResultSchema,
  CompanionShareUploadedEventSchema,
  CompanionShareTargetSchema,
  CompanionUnpairRequestSchema,
  CompanionUploadAssetSchema,
  CompanionUploadCreateRequestSchema,
  CompanionUploadContentKindSchema,
  CompanionUploadReceiptSchema,
} from "../schemas/companion";

export const COMPANION_PROTOCOL_VERSION = 1 as const;

export type CompanionProtocolVersion = Static<
  typeof CompanionProtocolVersionSchema
>;
export type CompanionPlatform = Static<typeof CompanionPlatformSchema>;
export type CompanionNotificationPermission = Static<
  typeof CompanionNotificationPermissionSchema
>;
export type CompanionDeviceStatus = Static<typeof CompanionDeviceStatusSchema>;
export type CompanionDevice = Static<typeof CompanionDeviceSchema>;
export type CompanionPairingTicket = Static<
  typeof CompanionPairingTicketSchema
>;
export type CompanionPairingClaim = Static<typeof CompanionPairingClaimSchema>;
export type CompanionPairingGrant = Static<typeof CompanionPairingGrantSchema>;
export type CompanionDeviceNotificationPreferenceRequest = Static<
  typeof CompanionDeviceNotificationPreferenceRequestSchema
>;
export type CompanionDeviceRegistrationUpdate = Static<
  typeof CompanionDeviceRegistrationUpdateSchema
>;
export type CompanionUnpairRequest = Static<
  typeof CompanionUnpairRequestSchema
>;
export type CompanionMailboxCursor = Static<
  typeof CompanionMailboxCursorSchema
>;
export type CompanionDesktopMailboxRecipient = Static<
  typeof CompanionDesktopMailboxRecipientSchema
>;
export type CompanionAndroidMailboxRecipient = Static<
  typeof CompanionAndroidMailboxRecipientSchema
>;
export type CompanionMailboxRecipient = Static<
  typeof CompanionMailboxRecipientSchema
>;
export type CompanionShareTarget = Static<typeof CompanionShareTargetSchema>;
export type CompanionChatTarget = Static<typeof CompanionChatTargetSchema>;
export type CompanionChatTargetSnapshot = Static<
  typeof CompanionChatTargetSnapshotSchema
>;
export type CompanionUploadContentKind = Static<
  typeof CompanionUploadContentKindSchema
>;
export type CompanionUploadAsset = Static<typeof CompanionUploadAssetSchema>;
export type CompanionUploadCreateRequest = Static<
  typeof CompanionUploadCreateRequestSchema
>;
export type CompanionUploadReceipt = Static<
  typeof CompanionUploadReceiptSchema
>;
export type CompanionSharePayload = Static<typeof CompanionSharePayloadSchema>;
export type CompanionNotificationMessage = Static<
  typeof CompanionNotificationMessageSchema
>;
export type CompanionShareUploadedEvent = Static<
  typeof CompanionShareUploadedEventSchema
>;
export type CompanionNotificationCreatedEvent = Static<
  typeof CompanionNotificationCreatedEventSchema
>;
export type CompanionChatTargetsReplacedEvent = Static<
  typeof CompanionChatTargetsReplacedEventSchema
>;
export type CompanionAndroidMailboxEvent = Static<
  typeof CompanionAndroidMailboxEventSchema
>;
export type CompanionMailboxEvent = Static<typeof CompanionMailboxEventSchema>;
export type CompanionDesktopMailboxEnvelope = Static<
  typeof CompanionDesktopMailboxEnvelopeSchema
>;
export type CompanionAndroidMailboxEnvelope = Static<
  typeof CompanionAndroidMailboxEnvelopeSchema
>;
export type CompanionMailboxEnvelope = Static<
  typeof CompanionMailboxEnvelopeSchema
>;
export type CompanionMailboxFetchRequest = Static<
  typeof CompanionMailboxFetchRequestSchema
>;
export type CompanionDesktopMailboxPage = Static<
  typeof CompanionDesktopMailboxPageSchema
>;
export type CompanionAndroidMailboxPage = Static<
  typeof CompanionAndroidMailboxPageSchema
>;
export type CompanionMailboxPage = Static<typeof CompanionMailboxPageSchema>;
export type CompanionShareImportedAckResult = Static<
  typeof CompanionShareImportedAckResultSchema
>;
export type CompanionEnvelopeReceivedAckResult = Static<
  typeof CompanionEnvelopeReceivedAckResultSchema
>;
export type CompanionMailboxAckResult = Static<
  typeof CompanionMailboxAckResultSchema
>;
export type CompanionDesktopMailboxAck = Static<
  typeof CompanionDesktopMailboxAckSchema
>;
export type CompanionAndroidMailboxAck = Static<
  typeof CompanionAndroidMailboxAckSchema
>;
export type CompanionMailboxAck = Static<typeof CompanionMailboxAckSchema>;
export type CompanionNotificationPush = Static<
  typeof CompanionNotificationPushSchema
>;
