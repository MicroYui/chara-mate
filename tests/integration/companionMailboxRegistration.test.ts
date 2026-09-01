import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanionBridgeRepository } from "../../src/main/companion/companionBridgeRepository";
import { CompanionMailboxProcessor } from "../../src/main/companion/companionMailboxProcessor";
import type { CompanionRelayClient } from "../../src/main/companion/companionRelayClient";
import { openApplicationDatabase } from "../../src/main/db/database";
import type { CompanionDesktopMailboxEnvelope } from "../../src/shared/contracts/companion";
import { FakeClock } from "../fixtures/fakeClock";

const IDS = {
  credential: "10000000-0000-4000-8000-000000000001",
  desktop: "20000000-0000-4000-8000-000000000002",
  device: "30000000-0000-4000-8000-000000000003",
  envelope: "40000000-0000-4000-8000-000000000004",
  installation: "50000000-0000-4000-8000-000000000005",
} as const;

const NOW = "2026-09-01T09:00:00.000Z";
const EXPIRES_AT = "2026-09-02T09:00:00.000Z";

const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];
const processors: CompanionMailboxProcessor[] = [];

afterEach(async () => {
  for (const processor of processors.splice(0)) await processor.shutdown();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function pendingUntilAbort<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (!signal) return;
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

describe("Companion registration mailbox persistence", () => {
  it("persists Android notification permission and commits the Desktop cursor after ack", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "charamate-companion-registration-"),
    );
    temporaryDirectories.push(root);
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    databases.push(database);
    const bridge = new CompanionBridgeRepository(database);
    bridge.getOrCreateDesktopInstanceId(() => IDS.desktop);
    bridge.pairDevice({
      credentialRef: IDS.credential,
      device: {
        displayName: "Pixel 10",
        id: IDS.device,
        installationId: IDS.installation,
        notificationPermission: "unknown",
        notificationsEnabled: true,
        pairedAt: NOW,
        platform: "android",
        protocolVersion: 1,
        status: { observedAt: NOW, state: "offline" },
      },
      relayOrigin: "https://relay.example.test",
      updatedAt: NOW,
    });
    const registrationEnvelope = {
      createdAt: NOW,
      cursor: "cursor-registration-1",
      event: {
        deviceId: IDS.device,
        notificationPermission: "granted",
        type: "companion.device.registration_updated",
      },
      expiresAt: EXPIRES_AT,
      id: IDS.envelope,
      protocolVersion: 1,
      recipient: { desktopInstanceId: IDS.desktop, kind: "desktop" },
    } satisfies CompanionDesktopMailboxEnvelope;
    const fetchDesktopMailbox = vi
      .fn<CompanionRelayClient["fetchDesktopMailbox"]>()
      .mockResolvedValueOnce({
        envelopes: [registrationEnvelope],
        hasMore: false,
        protocolVersion: 1,
        recipient: registrationEnvelope.recipient,
      })
      .mockImplementation(({ signal }) => pendingUntilAbort(signal));
    const acknowledgeDesktopMailbox = vi.fn<
      CompanionRelayClient["acknowledgeDesktopMailbox"]
    >(() => Promise.resolve());
    const clock = new FakeClock(NOW);
    const processor = new CompanionMailboxProcessor({
      bridge,
      clock,
      ingress: {
        importEnvelope: () => Promise.reject(new Error("unexpected share")),
      },
      relay: {
        acknowledgeDesktopMailbox,
        createPairingTicket: vi.fn(() => Promise.reject(new Error("unused"))),
        enqueueAndroidMailbox: vi.fn(() => Promise.reject(new Error("unused"))),
        fetchDesktopMailbox,
        readAsset: vi.fn(() => Promise.reject(new Error("unused"))),
        setNotificationsEnabled: vi.fn(() =>
          Promise.reject(new Error("unused")),
        ),
        unpairDevice: vi.fn(() => Promise.reject(new Error("unused"))),
        waitForPairingGrant: vi.fn(() => Promise.reject(new Error("unused"))),
      },
      secretStore: { get: () => Promise.resolve("device-credential") },
    });
    processors.push(processor);

    processor.start();
    await vi.waitFor(() =>
      expect(bridge.getDesktopMailboxCursor()).toBe(
        registrationEnvelope.cursor,
      ),
    );

    expect(bridge.getPairedDevice()?.device.notificationPermission).toBe(
      "granted",
    );
    expect(acknowledgeDesktopMailbox).toHaveBeenCalledWith(
      expect.objectContaining({
        ack: {
          acknowledgedAt: NOW,
          cursor: registrationEnvelope.cursor,
          envelopeId: registrationEnvelope.id,
          protocolVersion: 1,
          recipient: registrationEnvelope.recipient,
          result: { type: "envelope.received" },
        },
        credential: "device-credential",
        relayOrigin: "https://relay.example.test",
      }),
    );
  });
});
