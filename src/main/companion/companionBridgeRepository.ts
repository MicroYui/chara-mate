import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { Type, type Static } from "@sinclair/typebox";
import type Database from "better-sqlite3";

import {
  CompanionDeviceSchema,
  CompanionDeviceStatusSchema,
  CompanionNotificationPermissionSchema,
} from "../../shared/schemas/companion";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import { sanitizeForPersistence } from "../db/persistenceBoundary";

const DESKTOP_INSTANCE_METADATA_KEY = "companion_desktop_instance_id";

const PairedCompanionDeviceRecordSchema = Type.Object(
  {
    credentialRef: EntityIdSchema,
    device: CompanionDeviceSchema,
    relayOrigin: Type.String({ pattern: "^https://[^\\s]+$" }),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

const ShareIdentityProperties = {
  claimedAt: TimestampSchema,
  cursor: NonBlankStringSchema,
  deviceId: EntityIdSchema,
  envelopeId: EntityIdSchema,
  expiresAt: TimestampSchema,
  payloadSha256: Sha256Schema,
  submissionId: EntityIdSchema,
};

const ClaimShareSchema = Type.Union([
  Type.Object(
    { ...ShareIdentityProperties, sourceKind: Type.Literal("text") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ShareIdentityProperties,
      relayAssetId: EntityIdSchema,
      sourceKind: Type.Literal("attachment"),
    },
    { additionalProperties: false },
  ),
]);

const CompanionShareImportRecordSchema = Type.Object(
  {
    attachmentId: Type.Optional(EntityIdSchema),
    chatId: Type.Optional(EntityIdSchema),
    claimedAt: TimestampSchema,
    cursor: NonBlankStringSchema,
    deviceId: EntityIdSchema,
    envelopeId: EntityIdSchema,
    expiresAt: TimestampSchema,
    importedAt: Type.Optional(TimestampSchema),
    messageId: Type.Optional(EntityIdSchema),
    payloadSha256: Sha256Schema,
    relayAckedAt: Type.Optional(TimestampSchema),
    relayAssetId: Type.Optional(EntityIdSchema),
    runId: Type.Optional(EntityIdSchema),
    sourceKind: Type.Union([Type.Literal("text"), Type.Literal("attachment")]),
    state: Type.Union([Type.Literal("claimed"), Type.Literal("imported")]),
    submissionId: EntityIdSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

const BindShareRunSchema = Type.Object(
  {
    runId: EntityIdSchema,
    submissionId: EntityIdSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

const CompleteShareImportSchema = Type.Object(
  {
    attachmentId: Type.Optional(EntityIdSchema),
    chatId: EntityIdSchema,
    expectedCursor: Type.Optional(NonBlankStringSchema),
    importedAt: TimestampSchema,
    messageId: EntityIdSchema,
    submissionId: EntityIdSchema,
  },
  { additionalProperties: false },
);

const MarkShareAckedSchema = Type.Object(
  {
    acknowledgedAt: TimestampSchema,
    submissionId: EntityIdSchema,
  },
  { additionalProperties: false },
);

const CompanionMessageProjectionSchema = Type.Object(
  {
    acknowledgedAt: Type.Optional(TimestampSchema),
    deviceId: Type.Optional(EntityIdSchema),
    envelopeId: Type.Optional(EntityIdSchema),
    failedAt: Type.Optional(TimestampSchema),
    failureMessage: Type.Optional(NonBlankStringSchema),
    messageId: EntityIdSchema,
    projectedAt: Type.Optional(TimestampSchema),
    selectedAt: TimestampSchema,
    state: Type.Union([
      Type.Literal("selected"),
      Type.Literal("submitted"),
      Type.Literal("projected"),
      Type.Literal("acknowledged"),
      Type.Literal("failed"),
    ]),
    submittedAt: Type.Optional(TimestampSchema),
    surface: Type.Union([
      Type.Literal("desktop_bubble"),
      Type.Literal("android_notification"),
    ]),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

const ReserveMessageProjectionSchema = Type.Union([
  Type.Object(
    {
      messageId: EntityIdSchema,
      selectedAt: TimestampSchema,
      surface: Type.Literal("desktop_bubble"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      deviceId: EntityIdSchema,
      envelopeId: EntityIdSchema,
      messageId: EntityIdSchema,
      selectedAt: TimestampSchema,
      surface: Type.Literal("android_notification"),
    },
    { additionalProperties: false },
  ),
]);

const ProjectionTransitionSchema = Type.Object(
  { messageId: EntityIdSchema, transitionedAt: TimestampSchema },
  { additionalProperties: false },
);

const ProjectionFailureSchema = Type.Object(
  {
    failedAt: TimestampSchema,
    failureMessage: NonBlankStringSchema,
    messageId: EntityIdSchema,
  },
  { additionalProperties: false },
);

const DevicePreferenceSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    enabled: Type.Boolean(),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

const DevicePermissionSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    permission: CompanionNotificationPermissionSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

const DeviceStatusUpdateSchema = Type.Object(
  {
    deviceId: EntityIdSchema,
    status: CompanionDeviceStatusSchema,
  },
  { additionalProperties: false },
);

export type PairedCompanionDeviceRecord = Static<
  typeof PairedCompanionDeviceRecordSchema
>;
export type ClaimShare = Static<typeof ClaimShareSchema>;
export type CompanionShareImportRecord = Static<
  typeof CompanionShareImportRecordSchema
>;
export type BindShareRun = Static<typeof BindShareRunSchema>;
export type CompleteShareImport = Static<typeof CompleteShareImportSchema>;
export type ReserveMessageProjection = Static<
  typeof ReserveMessageProjectionSchema
>;
export type CompanionMessageProjection = Static<
  typeof CompanionMessageProjectionSchema
>;

export type CompanionBridgeConflictCode =
  | "COMPANION.DEVICE_SLOT_OCCUPIED"
  | "COMPANION.MAILBOX_CURSOR_CONFLICT"
  | "COMPANION.MESSAGE_NOT_ELIGIBLE"
  | "COMPANION.MESSAGE_STATE_CONFLICT"
  | "COMPANION.MESSAGE_SURFACE_CONFLICT"
  | "COMPANION.NOT_PAIRED"
  | "COMPANION.SHARE_IDENTITY_CONFLICT"
  | "COMPANION.SHARE_STATE_CONFLICT";

export class CompanionBridgePersistenceError extends Error {
  constructor(
    readonly code: CompanionBridgeConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "CompanionBridgePersistenceError";
  }
}

interface PairedDeviceRow {
  readonly credential_ref: string;
  readonly device_id: string;
  readonly display_name: string;
  readonly installation_id: string;
  readonly notification_permission: string;
  readonly notifications_enabled: number;
  readonly paired_at: string;
  readonly protocol_version: number;
  readonly relay_origin: string;
  readonly status_message: string | null;
  readonly status_observed_at: string;
  readonly status_state: string;
  readonly updated_at: string;
}

interface ShareImportRow {
  readonly attachment_id: string | null;
  readonly chat_id: string | null;
  readonly claimed_at: string;
  readonly cursor: string;
  readonly device_id: string;
  readonly envelope_id: string;
  readonly expires_at: string;
  readonly imported_at: string | null;
  readonly message_id: string | null;
  readonly payload_sha256: string;
  readonly relay_acked_at: string | null;
  readonly relay_asset_id: string | null;
  readonly run_id: string | null;
  readonly source_kind: string;
  readonly state: string;
  readonly submission_id: string;
  readonly updated_at: string;
}

interface MessageProjectionRow {
  readonly acknowledged_at: string | null;
  readonly device_id: string | null;
  readonly envelope_id: string | null;
  readonly failed_at: string | null;
  readonly failure_message: string | null;
  readonly message_id: string;
  readonly projected_at: string | null;
  readonly selected_at: string;
  readonly state: string;
  readonly submitted_at: string | null;
  readonly surface: string;
  readonly updated_at: string;
}

const DEVICE_COLUMNS = `
  device_id, installation_id, display_name, relay_origin, credential_ref,
  protocol_version, notification_permission, notifications_enabled,
  status_state, status_message, status_observed_at, paired_at, updated_at
`;

const SHARE_IMPORT_COLUMNS = `
  submission_id, device_id, envelope_id, payload_sha256, source_kind,
  relay_asset_id, cursor, state, run_id, expires_at, chat_id, message_id,
  attachment_id, claimed_at, imported_at, relay_acked_at, updated_at
`;

const MESSAGE_PROJECTION_COLUMNS = `
  message_id, surface, device_id, envelope_id, state, selected_at,
  submitted_at, projected_at, acknowledged_at, failed_at, failure_message,
  updated_at
`;

function optionalProperty(key: string, value: string | null): object {
  return value === null ? {} : { [key]: value };
}

function readDevice(row: PairedDeviceRow): PairedCompanionDeviceRecord {
  return parseSchema(PairedCompanionDeviceRecordSchema, {
    credentialRef: row.credential_ref,
    device: {
      displayName: row.display_name,
      id: row.device_id,
      installationId: row.installation_id,
      notificationPermission: row.notification_permission,
      notificationsEnabled: row.notifications_enabled === 1,
      pairedAt: row.paired_at,
      platform: "android",
      protocolVersion: row.protocol_version,
      status:
        row.status_state === "protocol_error"
          ? {
              message: row.status_message,
              observedAt: row.status_observed_at,
              state: row.status_state,
            }
          : {
              observedAt: row.status_observed_at,
              state: row.status_state,
            },
    },
    relayOrigin: row.relay_origin,
    updatedAt: row.updated_at,
  });
}

function readShareImport(row: ShareImportRow): CompanionShareImportRecord {
  return parseSchema(CompanionShareImportRecordSchema, {
    ...optionalProperty("attachmentId", row.attachment_id),
    ...optionalProperty("chatId", row.chat_id),
    claimedAt: row.claimed_at,
    cursor: row.cursor,
    deviceId: row.device_id,
    envelopeId: row.envelope_id,
    expiresAt: row.expires_at,
    ...optionalProperty("importedAt", row.imported_at),
    ...optionalProperty("messageId", row.message_id),
    payloadSha256: row.payload_sha256,
    ...optionalProperty("relayAckedAt", row.relay_acked_at),
    ...optionalProperty("relayAssetId", row.relay_asset_id),
    ...optionalProperty("runId", row.run_id),
    sourceKind: row.source_kind,
    state: row.state,
    submissionId: row.submission_id,
    updatedAt: row.updated_at,
  });
}

function readProjection(row: MessageProjectionRow): CompanionMessageProjection {
  return parseSchema(CompanionMessageProjectionSchema, {
    ...optionalProperty("acknowledgedAt", row.acknowledged_at),
    ...optionalProperty("deviceId", row.device_id),
    ...optionalProperty("envelopeId", row.envelope_id),
    ...optionalProperty("failedAt", row.failed_at),
    ...optionalProperty("failureMessage", row.failure_message),
    messageId: row.message_id,
    ...optionalProperty("projectedAt", row.projected_at),
    selectedAt: row.selected_at,
    state: row.state,
    ...optionalProperty("submittedAt", row.submitted_at),
    surface: row.surface,
    updatedAt: row.updated_at,
  });
}

function sameShareIdentity(
  current: CompanionShareImportRecord,
  candidate: ClaimShare,
): boolean {
  return (
    current.submissionId === candidate.submissionId &&
    current.deviceId === candidate.deviceId &&
    current.envelopeId === candidate.envelopeId &&
    current.payloadSha256 === candidate.payloadSha256 &&
    current.sourceKind === candidate.sourceKind &&
    current.cursor === candidate.cursor &&
    current.expiresAt === candidate.expiresAt &&
    (current.sourceKind === "text" ||
      (candidate.sourceKind === "attachment" &&
        current.relayAssetId === candidate.relayAssetId))
  );
}

export class CompanionBridgeRepository {
  constructor(private readonly database: Database.Database) {}

  getOrCreateDesktopInstanceId(createId: () => string = randomUUID): string {
    return this.database.transaction(() => {
      const existing = this.readDesktopInstanceId();
      if (existing) return existing;
      const candidate = parseSchema(EntityIdSchema, createId());
      this.database
        .prepare(
          "INSERT OR IGNORE INTO app_metadata (key, value) VALUES (?, ?)",
        )
        .run(DESKTOP_INSTANCE_METADATA_KEY, candidate);
      return this.readDesktopInstanceId()!;
    })();
  }

  getPairedDevice(): PairedCompanionDeviceRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${DEVICE_COLUMNS}
         FROM paired_companion_devices
         WHERE slot = 'android'`,
      )
      .get() as PairedDeviceRow | undefined;
    return row ? readDevice(row) : undefined;
  }

  pairDevice(input: PairedCompanionDeviceRecord): PairedCompanionDeviceRecord {
    const record = sanitizeForPersistence(
      PairedCompanionDeviceRecordSchema,
      input,
    );
    const existing = this.getPairedDevice();
    if (existing) {
      if (isDeepStrictEqual(existing, record)) return existing;
      throw this.error(
        "COMPANION.DEVICE_SLOT_OCCUPIED",
        "Android companion device slot is already occupied.",
      );
    }
    const statusMessage =
      record.device.status.state === "protocol_error"
        ? record.device.status.message
        : null;
    this.database
      .prepare(
        `INSERT INTO paired_companion_devices (
           slot, device_id, installation_id, display_name, relay_origin,
           credential_ref, protocol_version, notification_permission,
           notifications_enabled, status_state, status_message,
           status_observed_at, paired_at, updated_at
         ) VALUES ('android', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.device.id,
        record.device.installationId,
        record.device.displayName,
        record.relayOrigin,
        record.credentialRef,
        record.device.protocolVersion,
        record.device.notificationPermission,
        record.device.notificationsEnabled ? 1 : 0,
        record.device.status.state,
        statusMessage,
        record.device.status.observedAt,
        record.device.pairedAt,
        record.updatedAt,
      );
    return this.getPairedDevice()!;
  }

  setNotificationsEnabled(
    deviceId: string,
    enabled: boolean,
    updatedAt: string,
  ): PairedCompanionDeviceRecord | undefined {
    const input = parseSchema(DevicePreferenceSchema, {
      deviceId,
      enabled,
      updatedAt,
    });
    const changed = this.database
      .prepare(
        `UPDATE paired_companion_devices
         SET notifications_enabled = ?, updated_at = ?
         WHERE slot = 'android' AND device_id = ?`,
      )
      .run(input.enabled ? 1 : 0, input.updatedAt, input.deviceId).changes;
    return changed === 1 ? this.getPairedDevice() : undefined;
  }

  updateNotificationPermission(
    deviceId: string,
    permission: Static<typeof CompanionNotificationPermissionSchema>,
    updatedAt: string,
  ): PairedCompanionDeviceRecord | undefined {
    const input = parseSchema(DevicePermissionSchema, {
      deviceId,
      permission,
      updatedAt,
    });
    const changed = this.database
      .prepare(
        `UPDATE paired_companion_devices
         SET notification_permission = ?, updated_at = ?
         WHERE slot = 'android' AND device_id = ?`,
      )
      .run(input.permission, input.updatedAt, input.deviceId).changes;
    return changed === 1 ? this.getPairedDevice() : undefined;
  }

  updateDeviceStatus(
    deviceId: string,
    status: Static<typeof CompanionDeviceStatusSchema>,
  ): PairedCompanionDeviceRecord | undefined {
    const input = parseSchema(DeviceStatusUpdateSchema, {
      deviceId,
      status,
    });
    const changed = this.database
      .prepare(
        `UPDATE paired_companion_devices
         SET status_state = ?, status_message = ?, status_observed_at = ?,
             updated_at = ?
         WHERE slot = 'android' AND device_id = ?`,
      )
      .run(
        input.status.state,
        input.status.state === "protocol_error" ? input.status.message : null,
        input.status.observedAt,
        input.status.observedAt,
        input.deviceId,
      ).changes;
    return changed === 1 ? this.getPairedDevice() : undefined;
  }

  unpairDevice(deviceId: string): PairedCompanionDeviceRecord | undefined {
    const id = parseSchema(EntityIdSchema, deviceId);
    const existing = this.getPairedDevice();
    if (!existing || existing.device.id !== id) return undefined;
    this.database
      .prepare(
        "DELETE FROM paired_companion_devices WHERE slot = 'android' AND device_id = ?",
      )
      .run(id);
    return existing;
  }

  listCredentialReferences(): ReadonlySet<string> {
    const paired = this.getPairedDevice();
    return new Set(paired ? [paired.credentialRef] : []);
  }

  getDesktopMailboxCursor(): string | undefined {
    const desktopInstanceId = this.readDesktopInstanceId();
    if (!desktopInstanceId) return undefined;
    const row = this.database
      .prepare(
        `SELECT cursor FROM companion_mailbox_cursors
         WHERE desktop_instance_id = ? AND recipient_kind = 'desktop'`,
      )
      .get(desktopInstanceId) as { readonly cursor: string } | undefined;
    return row?.cursor;
  }

  claimShare(input: ClaimShare): {
    readonly kind: "claimed" | "existing";
    readonly record: CompanionShareImportRecord;
  } {
    const value = sanitizeForPersistence(ClaimShareSchema, input);
    return this.database.transaction(() => {
      const paired = this.getPairedDevice();
      if (!paired || paired.device.id !== value.deviceId) {
        throw this.error(
          "COMPANION.NOT_PAIRED",
          "Share source is not the paired Android device.",
        );
      }
      const bySubmission = this.getShareImport(value.submissionId);
      const byEnvelope = this.getShareImportByEnvelopeId(value.envelopeId);
      if (
        bySubmission &&
        byEnvelope &&
        bySubmission.submissionId !== byEnvelope.submissionId
      ) {
        throw this.shareIdentityConflict();
      }
      const existing = bySubmission ?? byEnvelope;
      if (existing) {
        if (!sameShareIdentity(existing, value)) {
          throw this.shareIdentityConflict();
        }
        return { kind: "existing" as const, record: existing };
      }
      this.database
        .prepare(
          `INSERT INTO companion_share_imports (
             submission_id, device_id, envelope_id, payload_sha256,
             source_kind, relay_asset_id, cursor, state, run_id, expires_at,
             chat_id, message_id, attachment_id, claimed_at, imported_at,
             relay_acked_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, 'claimed', NULL, ?, NULL, NULL, NULL, ?,
             NULL, NULL, ?
           )`,
        )
        .run(
          value.submissionId,
          value.deviceId,
          value.envelopeId,
          value.payloadSha256,
          value.sourceKind,
          value.sourceKind === "attachment" ? value.relayAssetId : null,
          value.cursor,
          value.expiresAt,
          value.claimedAt,
          value.claimedAt,
        );
      return {
        kind: "claimed" as const,
        record: this.getShareImport(value.submissionId)!,
      };
    })();
  }

  bindOrRebindShareRun(input: BindShareRun): CompanionShareImportRecord {
    const value = sanitizeForPersistence(BindShareRunSchema, input);
    const record = this.requireShareImport(value.submissionId);
    if (record.state !== "claimed") {
      if (record.runId === value.runId) return record;
      throw this.shareStateConflict("Imported share cannot be rebound.");
    }
    if (record.runId && record.runId !== value.runId) {
      const importedMessage = this.database
        .prepare(
          `SELECT id FROM messages
           WHERE run_id = ? AND role = 'user' AND status = 'completed'
           LIMIT 1`,
        )
        .get(record.runId) as { readonly id: string } | undefined;
      if (importedMessage) {
        throw this.shareStateConflict(
          "Share cannot rebind after its Run persisted a completed User Message.",
        );
      }
    }
    const otherBinding = this.database
      .prepare(
        `SELECT submission_id FROM companion_share_imports
         WHERE run_id = ? AND submission_id <> ?`,
      )
      .get(value.runId, value.submissionId) as
      { readonly submission_id: string } | undefined;
    if (otherBinding) {
      throw this.shareStateConflict(
        "Run is already bound to another share import.",
      );
    }
    this.database
      .prepare(
        `UPDATE companion_share_imports
         SET run_id = ?, updated_at = ?
         WHERE submission_id = ? AND state = 'claimed'`,
      )
      .run(value.runId, value.updatedAt, value.submissionId);
    return this.requireShareImport(value.submissionId);
  }

  completeShareImport(input: CompleteShareImport): CompanionShareImportRecord {
    const value = sanitizeForPersistence(CompleteShareImportSchema, input);
    return this.database.transaction(() => {
      const record = this.requireShareImport(value.submissionId);
      const expectedAttachmentId =
        record.sourceKind === "attachment" ? value.attachmentId : undefined;
      if (record.sourceKind === "attachment" && !expectedAttachmentId) {
        throw this.shareStateConflict(
          "Attachment share completion requires an Attachment record.",
        );
      }
      if (record.sourceKind === "text" && value.attachmentId) {
        throw this.shareStateConflict(
          "Text share completion cannot bind an Attachment record.",
        );
      }
      if (record.state === "imported") {
        if (
          record.chatId === value.chatId &&
          record.messageId === value.messageId &&
          record.attachmentId === expectedAttachmentId
        ) {
          return record;
        }
        throw this.shareStateConflict(
          "Imported share result cannot be replaced with different records.",
        );
      }
      if (!record.runId) {
        throw this.shareStateConflict(
          "Share import must bind a Run before completion.",
        );
      }
      const run = this.database
        .prepare("SELECT chat_id FROM runs WHERE id = ?")
        .get(record.runId) as { readonly chat_id: string } | undefined;
      if (!run || run.chat_id !== value.chatId) {
        throw this.shareStateConflict(
          "Share import result must belong to its bound Run chat.",
        );
      }
      const message = this.database
        .prepare(
          "SELECT chat_id, run_id, role, status FROM messages WHERE id = ?",
        )
        .get(value.messageId) as
        | {
            readonly chat_id: string;
            readonly role: string;
            readonly run_id: string | null;
            readonly status: string;
          }
        | undefined;
      if (
        !message ||
        message.chat_id !== value.chatId ||
        message.run_id !== record.runId ||
        message.role !== "user" ||
        message.status !== "completed"
      ) {
        throw this.shareStateConflict(
          "Share import must reference its completed User Message.",
        );
      }
      if (expectedAttachmentId) {
        const attachment = this.database
          .prepare("SELECT chat_id, message_id FROM attachments WHERE id = ?")
          .get(expectedAttachmentId) as
          { readonly chat_id: string; readonly message_id: string } | undefined;
        if (
          !attachment ||
          attachment.chat_id !== value.chatId ||
          attachment.message_id !== value.messageId
        ) {
          throw this.shareStateConflict(
            "Share import Attachment must belong to its User Message.",
          );
        }
      }
      this.database
        .prepare(
          `UPDATE companion_share_imports
           SET state = 'imported', chat_id = ?, message_id = ?,
               attachment_id = ?, imported_at = ?, updated_at = ?
           WHERE submission_id = ? AND state = 'claimed'`,
        )
        .run(
          value.chatId,
          value.messageId,
          expectedAttachmentId ?? null,
          value.importedAt,
          value.importedAt,
          value.submissionId,
        );
      if (
        !this.advanceDesktopMailboxCursor(
          value.expectedCursor,
          record.cursor,
          value.importedAt,
        )
      ) {
        throw this.error(
          "COMPANION.MAILBOX_CURSOR_CONFLICT",
          "Desktop companion mailbox cursor changed before import completion.",
        );
      }
      return this.requireShareImport(value.submissionId);
    })();
  }

  getShareImport(submissionId: string): CompanionShareImportRecord | undefined {
    const id = parseSchema(EntityIdSchema, submissionId);
    const row = this.database
      .prepare(
        `SELECT ${SHARE_IMPORT_COLUMNS} FROM companion_share_imports
         WHERE submission_id = ?`,
      )
      .get(id) as ShareImportRow | undefined;
    return row ? readShareImport(row) : undefined;
  }

  listPendingShareAcks(): CompanionShareImportRecord[] {
    return (
      this.database
        .prepare(
          `SELECT ${SHARE_IMPORT_COLUMNS} FROM companion_share_imports
           WHERE state = 'imported' AND relay_acked_at IS NULL
           ORDER BY imported_at, submission_id`,
        )
        .all() as ShareImportRow[]
    ).map(readShareImport);
  }

  markShareAcked(
    submissionId: string,
    acknowledgedAt: string,
  ): CompanionShareImportRecord {
    const value = sanitizeForPersistence(MarkShareAckedSchema, {
      acknowledgedAt,
      submissionId,
    });
    const record = this.requireShareImport(value.submissionId);
    if (record.state !== "imported") {
      throw this.shareStateConflict("Claimed share cannot be acknowledged.");
    }
    if (record.relayAckedAt) return record;
    this.database
      .prepare(
        `UPDATE companion_share_imports
         SET relay_acked_at = ?, updated_at = ?
         WHERE submission_id = ? AND state = 'imported'
           AND relay_acked_at IS NULL`,
      )
      .run(value.acknowledgedAt, value.acknowledgedAt, value.submissionId);
    return this.requireShareImport(value.submissionId);
  }

  pruneExpiredShares(now: string): number {
    const timestamp = parseSchema(TimestampSchema, now);
    return this.database
      .prepare("DELETE FROM companion_share_imports WHERE expires_at <= ?")
      .run(timestamp).changes;
  }

  getMessageProjection(
    messageId: string,
  ): CompanionMessageProjection | undefined {
    const id = parseSchema(EntityIdSchema, messageId);
    const row = this.database
      .prepare(
        `SELECT ${MESSAGE_PROJECTION_COLUMNS}
         FROM companion_message_projections WHERE message_id = ?`,
      )
      .get(id) as MessageProjectionRow | undefined;
    return row ? readProjection(row) : undefined;
  }

  reserveMessageProjection(input: ReserveMessageProjection): {
    readonly kind: "existing" | "reserved";
    readonly projection: CompanionMessageProjection;
  } {
    const value = sanitizeForPersistence(ReserveMessageProjectionSchema, input);
    return this.database.transaction(() => {
      const existing = this.getMessageProjection(value.messageId);
      if (existing) {
        const sameSurface =
          existing.surface === value.surface &&
          (value.surface === "desktop_bubble" ||
            (existing.deviceId === value.deviceId &&
              existing.envelopeId === value.envelopeId));
        if (!sameSurface) {
          throw this.error(
            "COMPANION.MESSAGE_SURFACE_CONFLICT",
            "Assistant message already belongs to another delivery surface.",
          );
        }
        return { kind: "existing" as const, projection: existing };
      }
      const message = this.database
        .prepare("SELECT role, status FROM messages WHERE id = ?")
        .get(value.messageId) as
        { readonly role: string; readonly status: string } | undefined;
      if (message?.role !== "assistant" || message.status !== "completed") {
        throw this.error(
          "COMPANION.MESSAGE_NOT_ELIGIBLE",
          "Only completed assistant messages can select a companion surface.",
        );
      }
      if (value.surface === "android_notification") {
        const paired = this.getPairedDevice();
        if (!paired || paired.device.id !== value.deviceId) {
          throw this.error(
            "COMPANION.NOT_PAIRED",
            "Android notification target is not the paired device.",
          );
        }
      }
      this.database
        .prepare(
          `INSERT INTO companion_message_projections (
             message_id, surface, device_id, envelope_id, state, selected_at,
             submitted_at, projected_at, acknowledged_at, failed_at,
             failure_message, updated_at
           ) VALUES (?, ?, ?, ?, 'selected', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
        )
        .run(
          value.messageId,
          value.surface,
          value.surface === "android_notification" ? value.deviceId : null,
          value.surface === "android_notification" ? value.envelopeId : null,
          value.selectedAt,
          value.selectedAt,
        );
      return {
        kind: "reserved" as const,
        projection: this.getMessageProjection(value.messageId)!,
      };
    })();
  }

  markMessageProjectionSubmitted(
    messageId: string,
    submittedAt: string,
  ): CompanionMessageProjection {
    const value = parseSchema(ProjectionTransitionSchema, {
      messageId,
      transitionedAt: submittedAt,
    });
    const current = this.requireProjection(value.messageId);
    if (current.surface !== "android_notification") {
      throw this.messageStateConflict(
        "Only Android notification projections are submitted.",
      );
    }
    if (["submitted", "projected", "acknowledged"].includes(current.state)) {
      return current;
    }
    if (current.state !== "selected") {
      throw this.messageStateConflict("Failed projection cannot be submitted.");
    }
    this.database
      .prepare(
        `UPDATE companion_message_projections
         SET state = 'submitted', submitted_at = ?, updated_at = ?
         WHERE message_id = ? AND state = 'selected'`,
      )
      .run(value.transitionedAt, value.transitionedAt, value.messageId);
    return this.requireProjection(value.messageId);
  }

  markMessageProjectionProjected(
    messageId: string,
    projectedAt: string,
  ): CompanionMessageProjection {
    const value = parseSchema(ProjectionTransitionSchema, {
      messageId,
      transitionedAt: projectedAt,
    });
    const current = this.requireProjection(value.messageId);
    if (current.state === "projected") return current;
    if (current.surface !== "desktop_bubble" || current.state !== "selected") {
      throw this.messageStateConflict(
        "Only a selected Desktop bubble can become projected.",
      );
    }
    this.database
      .prepare(
        `UPDATE companion_message_projections
         SET state = 'projected', projected_at = ?, updated_at = ?
         WHERE message_id = ? AND state = 'selected'`,
      )
      .run(value.transitionedAt, value.transitionedAt, value.messageId);
    return this.requireProjection(value.messageId);
  }

  markMessageProjectionFailed(
    messageId: string,
    failureMessage: string,
    failedAt: string,
  ): CompanionMessageProjection {
    const value = sanitizeForPersistence(ProjectionFailureSchema, {
      failedAt,
      failureMessage,
      messageId,
    });
    const current = this.requireProjection(value.messageId);
    if (current.state === "failed") return current;
    if (current.state === "projected" || current.state === "acknowledged") {
      throw this.messageStateConflict(
        "Successful projection cannot become failed.",
      );
    }
    if (
      current.state !== "selected" &&
      !(
        current.surface === "android_notification" &&
        current.state === "submitted"
      )
    ) {
      throw this.messageStateConflict(
        "Only a selected projection or submitted Android notification can fail.",
      );
    }
    this.database
      .prepare(
        `UPDATE companion_message_projections
         SET state = 'failed', failed_at = ?, failure_message = ?,
             updated_at = ?
         WHERE message_id = ?
           AND (
             state = 'selected' OR
             (surface = 'android_notification' AND state = 'submitted')
           )`,
      )
      .run(
        value.failedAt,
        value.failureMessage,
        value.failedAt,
        value.messageId,
      );
    return this.requireProjection(value.messageId);
  }

  markMessageProjectionAcknowledged(
    messageId: string,
    acknowledgedAt: string,
  ): CompanionMessageProjection {
    const value = parseSchema(ProjectionTransitionSchema, {
      messageId,
      transitionedAt: acknowledgedAt,
    });
    const current = this.requireProjection(value.messageId);
    if (current.state === "acknowledged") return current;
    if (
      current.surface !== "android_notification" ||
      current.state !== "submitted"
    ) {
      throw this.messageStateConflict(
        "Only a submitted Android notification can be acknowledged.",
      );
    }
    this.database
      .prepare(
        `UPDATE companion_message_projections
         SET state = 'acknowledged', acknowledged_at = ?, updated_at = ?
         WHERE message_id = ? AND state = 'submitted'`,
      )
      .run(value.transitionedAt, value.transitionedAt, value.messageId);
    return this.requireProjection(value.messageId);
  }

  listPendingAndroidMessageProjections(): CompanionMessageProjection[] {
    return (
      this.database
        .prepare(
          `SELECT ${MESSAGE_PROJECTION_COLUMNS}
           FROM companion_message_projections
           WHERE surface = 'android_notification'
             AND state IN ('selected', 'submitted')
           ORDER BY selected_at, message_id`,
        )
        .all() as MessageProjectionRow[]
    ).map(readProjection);
  }

  private readDesktopInstanceId(): string | undefined {
    const row = this.database
      .prepare("SELECT value FROM app_metadata WHERE key = ?")
      .get(DESKTOP_INSTANCE_METADATA_KEY) as
      { readonly value: string } | undefined;
    return row ? parseSchema(EntityIdSchema, row.value) : undefined;
  }

  private advanceDesktopMailboxCursor(
    expectedCursor: string | undefined,
    nextCursor: string,
    updatedAt: string,
  ): boolean {
    const desktopInstanceId = this.getOrCreateDesktopInstanceId();
    if (expectedCursor === undefined) {
      return (
        this.database
          .prepare(
            `INSERT OR IGNORE INTO companion_mailbox_cursors (
               desktop_instance_id, recipient_kind, cursor, updated_at
             ) VALUES (?, 'desktop', ?, ?)`,
          )
          .run(desktopInstanceId, nextCursor, updatedAt).changes === 1
      );
    }
    return (
      this.database
        .prepare(
          `UPDATE companion_mailbox_cursors
           SET cursor = ?, updated_at = ?
           WHERE desktop_instance_id = ? AND recipient_kind = 'desktop'
             AND cursor = ?`,
        )
        .run(nextCursor, updatedAt, desktopInstanceId, expectedCursor)
        .changes === 1
    );
  }

  private getShareImportByEnvelopeId(
    envelopeId: string,
  ): CompanionShareImportRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${SHARE_IMPORT_COLUMNS} FROM companion_share_imports
         WHERE envelope_id = ?`,
      )
      .get(envelopeId) as ShareImportRow | undefined;
    return row ? readShareImport(row) : undefined;
  }

  private requireShareImport(submissionId: string): CompanionShareImportRecord {
    const record = this.getShareImport(submissionId);
    if (!record) {
      throw this.shareStateConflict("Share import claim was not found.");
    }
    return record;
  }

  private requireProjection(messageId: string): CompanionMessageProjection {
    const projection = this.getMessageProjection(messageId);
    if (!projection) {
      throw this.messageStateConflict("Message projection was not found.");
    }
    return projection;
  }

  private shareIdentityConflict(): CompanionBridgePersistenceError {
    return this.error(
      "COMPANION.SHARE_IDENTITY_CONFLICT",
      "Share submission or envelope identity was reused with different data.",
    );
  }

  private shareStateConflict(message: string): CompanionBridgePersistenceError {
    return this.error("COMPANION.SHARE_STATE_CONFLICT", message);
  }

  private messageStateConflict(
    message: string,
  ): CompanionBridgePersistenceError {
    return this.error("COMPANION.MESSAGE_STATE_CONFLICT", message);
  }

  private error(
    code: CompanionBridgeConflictCode,
    message: string,
  ): CompanionBridgePersistenceError {
    return new CompanionBridgePersistenceError(code, message);
  }
}
