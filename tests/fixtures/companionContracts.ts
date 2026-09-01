import type {
  CompanionAndroidMailboxEnqueueReceipt,
  CompanionAndroidMailboxEnqueueRequest,
  CompanionChatTargetSnapshot,
  CompanionDevice,
  CompanionMailboxAck,
  CompanionMailboxEnvelope,
  CompanionMailboxFetchRequest,
  CompanionMailboxPage,
  CompanionNotificationPush,
  CompanionPairingClaim,
  CompanionPairingCreateRequest,
  CompanionPairingGrant,
  CompanionPairingTicket,
  CompanionUploadAsset,
  CompanionUploadCreateRequest,
  CompanionUploadReceipt,
} from "../../src/shared/contracts";

export const COMPANION_FIXTURE_IDS = {
  attachment: "90000000-0000-4000-8000-000000000001",
  chat: "90000000-0000-4000-8000-000000000002",
  desktop: "90000000-0000-4000-8000-000000000003",
  device: "90000000-0000-4000-8000-000000000004",
  envelopeNotification: "90000000-0000-4000-8000-000000000005",
  envelopeShare: "90000000-0000-4000-8000-000000000006",
  envelopeTargets: "90000000-0000-4000-8000-000000000013",
  installation: "90000000-0000-4000-8000-000000000007",
  messageAssistant: "90000000-0000-4000-8000-000000000008",
  messageUser: "90000000-0000-4000-8000-000000000009",
  pairing: "90000000-0000-4000-8000-000000000010",
  relayAsset: "90000000-0000-4000-8000-000000000011",
  submission: "90000000-0000-4000-8000-000000000012",
} as const;

export const COMPANION_FIXTURE_CURSORS = {
  androidNotification: "mcur_Qv3pA9nX",
  androidTargets: "mcur_Yk8sL2wR",
  desktopPrevious: "mcur_Bf6tH1cM",
  desktopShare: "mcur_Zd4jN7uK",
} as const;

export const COMPANION_FIXTURE_TIMESTAMPS = {
  created: "2026-09-01T09:00:00.000Z",
  expires: "2026-09-02T09:00:00.000Z",
} as const;

export const companionDeviceFixture = {
  displayName: "Yifan's phone",
  id: COMPANION_FIXTURE_IDS.device,
  installationId: COMPANION_FIXTURE_IDS.installation,
  notificationPermission: "granted",
  notificationsEnabled: true,
  pairedAt: COMPANION_FIXTURE_TIMESTAMPS.created,
  platform: "android",
  protocolVersion: 1,
  status: {
    observedAt: COMPANION_FIXTURE_TIMESTAMPS.created,
    state: "online",
  },
} satisfies CompanionDevice;

export const companionPairingCreateRequestFixture = {
  desktopInstanceId: COMPANION_FIXTURE_IDS.desktop,
  protocolVersion: 1,
} satisfies CompanionPairingCreateRequest;

export const companionPairingTicketFixture = {
  desktopInstanceId: COMPANION_FIXTURE_IDS.desktop,
  expiresAt: COMPANION_FIXTURE_TIMESTAMPS.expires,
  pairingId: COMPANION_FIXTURE_IDS.pairing,
  pairingSecret: "one-time-pairing-secret",
  protocolVersion: 1,
  relayOrigin: "https://relay.example.test",
} satisfies CompanionPairingTicket;

export const companionPairingClaimFixture = {
  deviceDisplayName: "Yifan's phone",
  installationId: COMPANION_FIXTURE_IDS.installation,
  notificationPermission: "granted",
  pairingId: COMPANION_FIXTURE_IDS.pairing,
  pairingSecret: "one-time-pairing-secret",
  protocolVersion: 1,
  pushRegistrationId: "opaque-push-registration-id",
} satisfies CompanionPairingClaim;

export const companionPairingGrantFixture = {
  desktopInstanceId: COMPANION_FIXTURE_IDS.desktop,
  device: companionDeviceFixture,
  deviceCredential: "opaque-device-mailbox-credential",
  protocolVersion: 1,
} satisfies CompanionPairingGrant;

export const companionUploadAssetFixture = {
  byteLength: 2048,
  contentKind: "image",
  displayName: "sunset.jpg",
  expiresAt: COMPANION_FIXTURE_TIMESTAMPS.expires,
  mediaType: "image/jpeg",
  relayAssetId: COMPANION_FIXTURE_IDS.relayAsset,
  sha256: "c".repeat(64),
} satisfies CompanionUploadAsset;

export const companionUploadCreateRequestFixture = {
  byteLength: companionUploadAssetFixture.byteLength,
  contentKind: companionUploadAssetFixture.contentKind,
  deviceId: COMPANION_FIXTURE_IDS.device,
  displayName: companionUploadAssetFixture.displayName,
  mediaType: companionUploadAssetFixture.mediaType,
  protocolVersion: 1,
  sha256: companionUploadAssetFixture.sha256,
  submissionId: COMPANION_FIXTURE_IDS.submission,
} satisfies CompanionUploadCreateRequest;

export const companionUploadReceiptFixture = {
  asset: companionUploadAssetFixture,
  deviceId: COMPANION_FIXTURE_IDS.device,
  protocolVersion: 1,
  submissionId: COMPANION_FIXTURE_IDS.submission,
} satisfies CompanionUploadReceipt;

export const companionChatTargetSnapshotFixture = {
  generatedAt: COMPANION_FIXTURE_TIMESTAMPS.created,
  targets: [
    {
      chatId: COMPANION_FIXTURE_IDS.chat,
      title: "Presentation 加油",
      updatedAt: COMPANION_FIXTURE_TIMESTAMPS.created,
    },
  ],
} satisfies CompanionChatTargetSnapshot;

export const companionShareEnvelopeFixture = {
  createdAt: COMPANION_FIXTURE_TIMESTAMPS.created,
  cursor: COMPANION_FIXTURE_CURSORS.desktopShare,
  event: {
    deviceId: COMPANION_FIXTURE_IDS.device,
    share: {
      attachment: companionUploadAssetFixture,
      caption: "分享结束了",
      kind: "attachment",
      submissionId: COMPANION_FIXTURE_IDS.submission,
      target: {
        chatId: COMPANION_FIXTURE_IDS.chat,
        kind: "existing_chat",
      },
    },
    type: "companion.share.uploaded",
  },
  expiresAt: COMPANION_FIXTURE_TIMESTAMPS.expires,
  id: COMPANION_FIXTURE_IDS.envelopeShare,
  protocolVersion: 1,
  recipient: {
    desktopInstanceId: COMPANION_FIXTURE_IDS.desktop,
    kind: "desktop",
  },
} satisfies CompanionMailboxEnvelope;

export const companionChatTargetEnvelopeFixture = {
  createdAt: COMPANION_FIXTURE_TIMESTAMPS.created,
  cursor: COMPANION_FIXTURE_CURSORS.androidTargets,
  event: {
    deviceId: COMPANION_FIXTURE_IDS.device,
    snapshot: companionChatTargetSnapshotFixture,
    type: "companion.chat_targets.replaced",
  },
  expiresAt: COMPANION_FIXTURE_TIMESTAMPS.expires,
  id: COMPANION_FIXTURE_IDS.envelopeTargets,
  protocolVersion: 1,
  recipient: {
    deviceId: COMPANION_FIXTURE_IDS.device,
    kind: "android",
  },
} satisfies CompanionMailboxEnvelope;

export const companionNotificationEnvelopeFixture = {
  createdAt: COMPANION_FIXTURE_TIMESTAMPS.created,
  cursor: COMPANION_FIXTURE_CURSORS.androidNotification,
  event: {
    deviceId: COMPANION_FIXTURE_IDS.device,
    notification: {
      body: "看样子至少你现在还有心情拍夕阳，应该不算太糟？",
      chatId: COMPANION_FIXTURE_IDS.chat,
      messageCreatedAt: COMPANION_FIXTURE_TIMESTAMPS.created,
      messageId: COMPANION_FIXTURE_IDS.messageAssistant,
      role: "assistant",
      status: "completed",
      title: "Mika",
    },
    type: "companion.notification.created",
  },
  expiresAt: COMPANION_FIXTURE_TIMESTAMPS.expires,
  id: COMPANION_FIXTURE_IDS.envelopeNotification,
  protocolVersion: 1,
  recipient: {
    deviceId: COMPANION_FIXTURE_IDS.device,
    kind: "android",
  },
} satisfies CompanionMailboxEnvelope;

export const companionNotificationEnqueueRequestFixture = {
  envelopeId: COMPANION_FIXTURE_IDS.envelopeNotification,
  event: companionNotificationEnvelopeFixture.event,
  protocolVersion: 1,
  recipient: companionNotificationEnvelopeFixture.recipient,
} satisfies CompanionAndroidMailboxEnqueueRequest;

export const companionNotificationEnqueueReceiptFixture = {
  envelope: companionNotificationEnvelopeFixture,
  protocolVersion: 1,
} satisfies CompanionAndroidMailboxEnqueueReceipt;

export const companionMailboxFetchRequestFixture = {
  afterCursor: COMPANION_FIXTURE_CURSORS.desktopPrevious,
  protocolVersion: 1,
  recipient: {
    desktopInstanceId: COMPANION_FIXTURE_IDS.desktop,
    kind: "desktop",
  },
} satisfies CompanionMailboxFetchRequest;

export const companionMailboxPageFixture = {
  envelopes: [companionShareEnvelopeFixture],
  hasMore: false,
  protocolVersion: 1,
  recipient: companionMailboxFetchRequestFixture.recipient,
} satisfies CompanionMailboxPage;

export const companionShareAckFixture = {
  acknowledgedAt: COMPANION_FIXTURE_TIMESTAMPS.created,
  cursor: COMPANION_FIXTURE_CURSORS.desktopShare,
  envelopeId: COMPANION_FIXTURE_IDS.envelopeShare,
  protocolVersion: 1,
  recipient: companionMailboxFetchRequestFixture.recipient,
  result: {
    attachmentId: COMPANION_FIXTURE_IDS.attachment,
    chatId: COMPANION_FIXTURE_IDS.chat,
    messageId: COMPANION_FIXTURE_IDS.messageUser,
    submissionId: COMPANION_FIXTURE_IDS.submission,
    type: "share.imported",
  },
} satisfies CompanionMailboxAck;

export const companionNotificationAckFixture = {
  acknowledgedAt: COMPANION_FIXTURE_TIMESTAMPS.created,
  cursor: COMPANION_FIXTURE_CURSORS.androidNotification,
  envelopeId: COMPANION_FIXTURE_IDS.envelopeNotification,
  protocolVersion: 1,
  recipient: companionNotificationEnvelopeFixture.recipient,
  result: {
    type: "envelope.received",
  },
} satisfies CompanionMailboxAck;

export const companionNotificationPushFixture = {
  cursor: COMPANION_FIXTURE_CURSORS.androidNotification,
  deviceId: COMPANION_FIXTURE_IDS.device,
  envelopeId: COMPANION_FIXTURE_IDS.envelopeNotification,
  notification: companionNotificationEnvelopeFixture.event.notification,
  protocolVersion: 1,
  type: "companion.notification",
} satisfies CompanionNotificationPush;
