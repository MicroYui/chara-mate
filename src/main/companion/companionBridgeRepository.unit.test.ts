import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_SQL, METADATA_SCHEMA_SQL } from "../db/schema/current";
import {
  CompanionBridgePersistenceError,
  CompanionBridgeRepository,
  type ClaimShare,
  type PairedCompanionDeviceRecord,
} from "./companionBridgeRepository";

const IDS = {
  attachment: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  chat: "11111111-1111-4111-8111-111111111111",
  credential: "22222222-2222-4222-8222-222222222222",
  desktop: "33333333-3333-4333-8333-333333333333",
  device: "44444444-4444-4444-8444-444444444444",
  envelope: "55555555-5555-4555-8555-555555555555",
  envelope2: "66666666-6666-4666-8666-666666666666",
  installation: "77777777-7777-4777-8777-777777777777",
  message: "88888888-8888-4888-8888-888888888888",
  message2: "99999999-9999-4999-8999-999999999999",
  message3: "12121212-1212-4212-8212-121212121212",
  run: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  run2: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  submission: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  submission2: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  otherDevice: "ffffffff-ffff-4fff-8fff-ffffffffffff",
} as const;

const NOW = "2026-09-01T00:00:00.000Z";
const LATER = "2026-09-01T00:01:00.000Z";
const LATEST = "2026-09-01T00:02:00.000Z";
const EXPIRES = "2026-09-02T00:00:00.000Z";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function openDatabase(): Database.Database {
  const opened = new Database(":memory:");
  opened.pragma("foreign_keys = ON");
  opened.exec(METADATA_SCHEMA_SQL);
  opened.exec(CURRENT_SCHEMA_SQL);
  opened
    .prepare(
      `INSERT INTO chats (id, title, status, created_at, updated_at)
       VALUES (?, 'Mobile share', 'active', ?, ?)`,
    )
    .run(IDS.chat, NOW, NOW);
  return opened;
}

function pairedDevice(
  overrides: Partial<PairedCompanionDeviceRecord> = {},
): PairedCompanionDeviceRecord {
  return {
    credentialRef: IDS.credential,
    device: {
      displayName: "Pixel 10",
      id: IDS.device,
      installationId: IDS.installation,
      notificationPermission: "granted",
      notificationsEnabled: true,
      pairedAt: NOW,
      platform: "android",
      protocolVersion: 1,
      status: { observedAt: NOW, state: "online" },
    },
    relayOrigin: "https://relay.example.test",
    updatedAt: NOW,
    ...overrides,
  };
}

function expectPersistenceCode(
  action: () => unknown,
  code: CompanionBridgePersistenceError["code"],
): void {
  try {
    action();
    throw new Error("Expected persistence action to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CompanionBridgePersistenceError);
    expect((error as CompanionBridgePersistenceError).code).toBe(code);
  }
}

function insertRun(
  id: string,
  status: "completed" | "running" = "running",
): void {
  database!
    .prepare(
      `INSERT INTO runs (
         id, chat_id, execution_json, persona_json, provider_json, source,
         status, latest_sequence, created_at, started_at, ended_at
       ) VALUES (?, ?, '{}', '{}', '{}', 'text', ?, 0, ?, ?, ?)`,
    )
    .run(id, IDS.chat, status, NOW, NOW, status === "completed" ? LATER : null);
}

function insertMessage(
  id: string,
  role: "assistant" | "user",
  runId: string | null,
  status: "completed" | "streaming" = "completed",
): void {
  database!
    .prepare(
      `INSERT INTO messages (
         id, chat_id, run_id, role, status, content, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'content', ?, ?)`,
    )
    .run(id, IDS.chat, runId, role, status, NOW, NOW);
}

function textClaim(overrides: Partial<ClaimShare> = {}): ClaimShare {
  return {
    claimedAt: NOW,
    cursor: "opaque-cursor-1",
    deviceId: IDS.device,
    envelopeId: IDS.envelope,
    expiresAt: EXPIRES,
    payloadSha256: "1".repeat(64),
    sourceKind: "text",
    submissionId: IDS.submission,
    ...overrides,
  } as ClaimShare;
}

describe("CompanionBridgeRepository", () => {
  it("keeps one Android pairing while Desktop identity remains stable", () => {
    database = openDatabase();
    const repository = new CompanionBridgeRepository(database);
    const device = pairedDevice();

    expect(repository.getOrCreateDesktopInstanceId(() => IDS.desktop)).toBe(
      IDS.desktop,
    );
    expect(repository.getOrCreateDesktopInstanceId(() => IDS.otherDevice)).toBe(
      IDS.desktop,
    );
    expect(repository.pairDevice(device)).toEqual(device);
    expect(repository.pairDevice(device)).toEqual(device);
    expectPersistenceCode(
      () =>
        repository.pairDevice(
          pairedDevice({
            device: {
              ...device.device,
              id: IDS.otherDevice,
              installationId: IDS.envelope2,
            },
          }),
        ),
      "COMPANION.DEVICE_SLOT_OCCUPIED",
    );
    expect(repository.listCredentialReferences()).toEqual(
      new Set([IDS.credential]),
    );
    expect(
      repository.updateDeviceStatus(IDS.device, {
        message: "Protocol version mismatch",
        observedAt: LATER,
        state: "protocol_error",
      })?.device.status,
    ).toMatchObject({ state: "protocol_error" });
    expect(
      repository.updateDeviceStatus(IDS.device, {
        observedAt: "2026-09-01T10:02:00.000Z",
        state: "online",
      })?.device.status,
    ).toEqual({
      message: "Protocol version mismatch",
      observedAt: LATER,
      state: "protocol_error",
    });
    expect(
      repository.setNotificationsEnabled(IDS.device, false, LATER)?.device
        .notificationsEnabled,
    ).toBe(false);
  });

  it("applies registration permission and advances a generic Desktop envelope idempotently", () => {
    database = openDatabase();
    const repository = new CompanionBridgeRepository(database);
    repository.getOrCreateDesktopInstanceId(() => IDS.desktop);
    repository.pairDevice(pairedDevice());

    const updated = repository.updateNotificationPermission(
      IDS.device,
      "denied",
      LATER,
    );
    expect(updated).toMatchObject({
      device: { notificationPermission: "denied" },
      updatedAt: LATER,
    });
    expect(
      repository.updateNotificationPermission(IDS.device, "denied", LATEST),
    ).toEqual(updated);
    expect(
      repository.updateNotificationPermission(
        IDS.otherDevice,
        "granted",
        LATEST,
      ),
    ).toBeUndefined();

    expect(
      repository.advanceDesktopMailboxCursor(
        undefined,
        "opaque-registration-cursor",
        LATER,
      ),
    ).toBe(true);
    expect(repository.getDesktopMailboxCursor()).toBe(
      "opaque-registration-cursor",
    );
    expect(
      repository.advanceDesktopMailboxCursor(
        undefined,
        "opaque-registration-cursor",
        LATEST,
      ),
    ).toBe(true);
    expect(
      repository.advanceDesktopMailboxCursor(
        "opaque-stale-cursor",
        "opaque-next-cursor",
        LATEST,
      ),
    ).toBe(false);
    expect(
      repository.advanceDesktopMailboxCursor(
        "opaque-registration-cursor",
        "opaque-next-cursor",
        LATEST,
      ),
    ).toBe(true);
    expect(repository.getDesktopMailboxCursor()).toBe("opaque-next-cursor");
  });

  it("recovers claimed shares, advances cursor only on completion, and retries Relay ack", () => {
    database = openDatabase();
    const repository = new CompanionBridgeRepository(database);
    repository.getOrCreateDesktopInstanceId(() => IDS.desktop);
    repository.pairDevice(pairedDevice());
    const claim = textClaim();

    expect(repository.claimShare(claim)).toMatchObject({
      kind: "claimed",
      record: { state: "claimed", submissionId: IDS.submission },
    });
    expect(repository.claimShare(claim).kind).toBe("existing");
    expect(repository.getDesktopMailboxCursor()).toBeUndefined();
    expectPersistenceCode(
      () =>
        repository.claimShare({
          ...claim,
          payloadSha256: "2".repeat(64),
        }),
      "COMPANION.SHARE_IDENTITY_CONFLICT",
    );
    expectPersistenceCode(
      () =>
        repository.claimShare({
          ...claim,
          predecessorCursor: "opaque-unrelated",
        }),
      "COMPANION.SHARE_IDENTITY_CONFLICT",
    );

    expect(
      repository.bindOrRebindShareRun({
        runId: IDS.run,
        submissionId: IDS.submission,
        updatedAt: LATER,
      }).runId,
    ).toBe(IDS.run);
    expect(
      repository.bindOrRebindShareRun({
        runId: IDS.run2,
        submissionId: IDS.submission,
        updatedAt: LATEST,
      }).runId,
    ).toBe(IDS.run2);
    insertRun(IDS.run2);
    insertMessage(IDS.message, "user", IDS.run2);

    expect(
      repository.completeShareImport({
        chatId: IDS.chat,
        importedAt: LATEST,
        messageId: IDS.message,
        submissionId: IDS.submission,
      }),
    ).toMatchObject({
      chatId: IDS.chat,
      messageId: IDS.message,
      runId: IDS.run2,
      state: "imported",
    });
    expect(repository.getDesktopMailboxCursor()).toBe("opaque-cursor-1");
    expect(repository.listPendingShareAcks(IDS.device)).toHaveLength(1);
    expect(repository.listPendingShareAcks(IDS.otherDevice)).toEqual([]);

    repository.unpairDevice(IDS.device);
    expect(repository.getOrCreateDesktopInstanceId()).toBe(IDS.desktop);
    expect(repository.getDesktopMailboxCursor()).toBe("opaque-cursor-1");
    database.prepare("DELETE FROM chats WHERE id = ?").run(IDS.chat);
    expect(repository.listPendingShareAcks(IDS.device)).toHaveLength(1);
    expect(repository.pruneExpiredShares(EXPIRES)).toBe(0);
    expect(repository.listPendingShareAcks(IDS.device)).toHaveLength(1);

    expect(repository.markShareAcked(IDS.submission, LATEST).relayAckedAt).toBe(
      LATEST,
    );
    expect(
      repository.markShareAcked(IDS.submission, EXPIRES).relayAckedAt,
    ).toBe(LATEST);
    expect(repository.listPendingShareAcks(IDS.device)).toEqual([]);
    expect(repository.pruneExpiredShares(EXPIRES)).toBe(1);
    expect(repository.getShareImport(IDS.submission)).toBeUndefined();
    expect(repository.getDesktopMailboxCursor()).toBe("opaque-cursor-1");
  });

  it("protects a persisted User Message without rebasing its predecessor cursor", () => {
    database = openDatabase();
    const repository = new CompanionBridgeRepository(database);
    repository.getOrCreateDesktopInstanceId(() => IDS.desktop);
    repository.pairDevice(pairedDevice());
    insertRun(IDS.run);
    insertMessage(IDS.message, "user", IDS.run);
    database
      .prepare(
        `INSERT INTO attachments (
           id, chat_id, message_id, kind, display_name, storage_key,
           media_type, byte_length, sha256, created_at
         ) VALUES (?, ?, ?, 'image', 'sunset.jpg', 'companion/sunset.jpg',
                   'image/jpeg', 1024, ?, ?)`,
      )
      .run(IDS.attachment, IDS.chat, IDS.message, "3".repeat(64), NOW);
    repository.claimShare({
      claimedAt: NOW,
      cursor: "opaque-cursor-1",
      deviceId: IDS.device,
      envelopeId: IDS.envelope,
      expiresAt: EXPIRES,
      payloadSha256: "1".repeat(64),
      predecessorCursor: "opaque-before",
      relayAssetId: IDS.envelope2,
      sourceKind: "attachment",
      submissionId: IDS.submission,
    });
    repository.bindOrRebindShareRun({
      runId: IDS.run,
      submissionId: IDS.submission,
      updatedAt: LATER,
    });
    expectPersistenceCode(
      () =>
        repository.bindOrRebindShareRun({
          runId: IDS.run2,
          submissionId: IDS.submission,
          updatedAt: LATEST,
        }),
      "COMPANION.SHARE_STATE_CONFLICT",
    );
    database
      .prepare(
        `INSERT INTO companion_mailbox_cursors (
           desktop_instance_id, recipient_kind, cursor, updated_at
         ) VALUES (?, 'desktop', 'opaque-newer', ?)`,
      )
      .run(IDS.desktop, NOW);

    expectPersistenceCode(
      () =>
        repository.completeShareImport({
          attachmentId: IDS.attachment,
          chatId: IDS.chat,
          importedAt: LATEST,
          messageId: IDS.message,
          submissionId: IDS.submission,
        }),
      "COMPANION.MAILBOX_CURSOR_CONFLICT",
    );
    expect(repository.getShareImport(IDS.submission)?.state).toBe("claimed");
    expect(repository.getDesktopMailboxCursor()).toBe("opaque-newer");
    expectPersistenceCode(
      () =>
        repository.completeShareImport({
          attachmentId: IDS.attachment,
          chatId: IDS.chat,
          importedAt: LATEST,
          messageId: IDS.message,
          submissionId: IDS.submission,
        }),
      "COMPANION.MAILBOX_CURSOR_CONFLICT",
    );
    expect(repository.getDesktopMailboxCursor()).toBe("opaque-newer");

    repository.claimShare(
      textClaim({
        claimedAt: NOW,
        cursor: "opaque-cursor-2",
        envelopeId: IDS.envelope2,
        expiresAt: LATER,
        submissionId: IDS.submission2,
      }),
    );
    expect(repository.pruneExpiredShares(LATEST)).toBe(1);
    expect(repository.getShareImport(IDS.submission)).toBeDefined();
    expect(repository.getShareImport(IDS.submission2)).toBeUndefined();
  });

  it("finds share imports by Run and recovers only an unprojected completed reply", () => {
    database = openDatabase();
    const repository = new CompanionBridgeRepository(database);
    repository.pairDevice(pairedDevice());

    repository.claimShare(textClaim());
    repository.bindOrRebindShareRun({
      runId: IDS.run,
      submissionId: IDS.submission,
      updatedAt: LATER,
    });
    insertRun(IDS.run, "completed");
    insertMessage(IDS.message, "user", IDS.run);
    insertMessage(IDS.message2, "assistant", IDS.run);

    repository.claimShare(
      textClaim({
        cursor: "opaque-cursor-2",
        envelopeId: IDS.envelope2,
        submissionId: IDS.submission2,
      }),
    );
    repository.bindOrRebindShareRun({
      runId: IDS.run2,
      submissionId: IDS.submission2,
      updatedAt: LATER,
    });
    insertRun(IDS.run2);
    insertMessage(IDS.message3, "assistant", IDS.run2);

    expect(repository.getShareImportByRunId(IDS.run)).toMatchObject({
      runId: IDS.run,
      state: "claimed",
      submissionId: IDS.submission,
    });
    expect(repository.getShareImportByRunId(IDS.otherDevice)).toBeUndefined();
    expect(repository.listCompletedShareRunsForProjectionRecovery()).toEqual([
      expect.objectContaining({ runId: IDS.run, state: "claimed" }),
    ]);

    repository.completeShareImport({
      chatId: IDS.chat,
      importedAt: LATEST,
      messageId: IDS.message,
      submissionId: IDS.submission,
    });
    expect(repository.listCompletedShareRunsForProjectionRecovery()).toEqual([
      expect.objectContaining({ runId: IDS.run, state: "imported" }),
    ]);

    repository.reserveMessageProjection({
      deviceId: IDS.device,
      envelopeId: IDS.envelope,
      messageId: IDS.message2,
      selectedAt: LATEST,
      surface: "android_notification",
    });
    expect(repository.listCompletedShareRunsForProjectionRecovery()).toEqual(
      [],
    );
  });

  it("fixes the Android envelope at reservation and resumes projection states", () => {
    database = openDatabase();
    const repository = new CompanionBridgeRepository(database);
    repository.pairDevice(pairedDevice());
    insertMessage(IDS.message, "assistant", null);
    insertMessage(IDS.message2, "assistant", null);
    insertMessage(IDS.message3, "assistant", null);

    expect(
      repository.reserveMessageProjection({
        deviceId: IDS.device,
        envelopeId: IDS.envelope,
        messageId: IDS.message,
        selectedAt: NOW,
        surface: "android_notification",
      }),
    ).toMatchObject({
      kind: "reserved",
      projection: { envelopeId: IDS.envelope, state: "selected" },
    });
    expect(
      repository.reserveMessageProjection({
        deviceId: IDS.device,
        envelopeId: IDS.envelope,
        messageId: IDS.message,
        selectedAt: LATER,
        surface: "android_notification",
      }).kind,
    ).toBe("existing");
    expectPersistenceCode(
      () =>
        repository.reserveMessageProjection({
          deviceId: IDS.device,
          envelopeId: IDS.envelope2,
          messageId: IDS.message,
          selectedAt: LATER,
          surface: "android_notification",
        }),
      "COMPANION.MESSAGE_SURFACE_CONFLICT",
    );

    repository.unpairDevice(IDS.device);
    expect(repository.listPendingAndroidMessageProjections()).toHaveLength(1);
    expect(
      repository.markMessageProjectionSubmitted(IDS.message, LATER).state,
    ).toBe("submitted");
    expect(
      repository.markMessageProjectionSubmitted(IDS.message, LATEST)
        .submittedAt,
    ).toBe(LATER);
    expect(
      repository.markMessageProjectionAcknowledged(IDS.message, EXPIRES).state,
    ).toBe("acknowledged");
    expect(
      repository.markMessageProjectionAcknowledged(IDS.message, LATEST)
        .acknowledgedAt,
    ).toBe(EXPIRES);
    expectPersistenceCode(
      () =>
        repository.markMessageProjectionFailed(
          IDS.message,
          "Late delivery failure",
          EXPIRES,
        ),
      "COMPANION.MESSAGE_STATE_CONFLICT",
    );
    expect(repository.listPendingAndroidMessageProjections()).toEqual([]);

    repository.reserveMessageProjection({
      messageId: IDS.message2,
      selectedAt: NOW,
      surface: "desktop_bubble",
    });
    expect(
      repository.markMessageProjectionProjected(IDS.message2, LATER).state,
    ).toBe("projected");
    expectPersistenceCode(
      () =>
        repository.markMessageProjectionFailed(
          IDS.message2,
          "Window was closed",
          LATEST,
        ),
      "COMPANION.MESSAGE_STATE_CONFLICT",
    );

    repository.reserveMessageProjection({
      messageId: IDS.message3,
      selectedAt: NOW,
      surface: "desktop_bubble",
    });
    expect(
      repository.markMessageProjectionFailed(
        IDS.message3,
        "Window was closed",
        LATEST,
      ),
    ).toMatchObject({
      failedAt: LATEST,
      failureMessage: "Window was closed",
      state: "failed",
    });
  });
});
