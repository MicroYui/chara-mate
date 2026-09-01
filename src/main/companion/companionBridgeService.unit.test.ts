import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type {
  CompanionDesktopSnapshot,
  CompanionPairingGrant,
  CompanionPairingTicket,
} from "../../shared/contracts/companion";
import type { Clock } from "../../shared/pure/clock";
import {
  companionDeviceFixture,
  companionPairingGrantFixture,
  companionPairingTicketFixture,
  COMPANION_FIXTURE_IDS,
  COMPANION_FIXTURE_TIMESTAMPS,
} from "../../../tests/fixtures/companionContracts";
import { CURRENT_SCHEMA_SQL, METADATA_SCHEMA_SQL } from "../db/schema/current";
import { ProviderError } from "../providers/providerError";
import type { ProviderSecretStore } from "../providers/secretStore";
import {
  CompanionBridgePersistenceError,
  CompanionBridgeRepository,
  type PairedCompanionDeviceRecord,
} from "./companionBridgeRepository";
import { CompanionBridgeService } from "./companionBridgeService";
import type { CompanionRelayClient } from "./companionRelayClient";
import { CompanionRelayClientError } from "./companionRelayClient";

const SECRET_REF = "91000000-0000-4000-8000-000000000001";
const NEW_SECRET_REF = "91000000-0000-4000-8000-000000000002";
const LATER = "2026-09-01T10:00:00.000Z";

class MutableClock implements Clock {
  constructor(public value: string = COMPANION_FIXTURE_TIMESTAMPS.created) {}

  now(): string {
    return this.value;
  }
}

class MemorySecretStore implements ProviderSecretStore {
  readonly deleted: string[] = [];
  readonly stored: string[] = [];
  readonly values = new Map<string, string>();
  deleteError: Error | undefined;
  getError: Error | undefined;

  delete(secretRef: string): Promise<void> {
    this.deleted.push(secretRef);
    if (this.deleteError) return Promise.reject(this.deleteError);
    this.values.delete(secretRef);
    return Promise.resolve();
  }

  get(secretRef: string): Promise<string> {
    if (this.getError) return Promise.reject(this.getError);
    const value = this.values.get(secretRef);
    if (!value) {
      return Promise.reject(
        new ProviderError("PROVIDER.CREDENTIAL_REQUIRED", "missing", false),
      );
    }
    return Promise.resolve(value);
  }

  prune(allowedReferences: ReadonlySet<string>): Promise<void> {
    for (const key of this.values.keys()) {
      if (!allowedReferences.has(key)) this.values.delete(key);
    }
    return Promise.resolve();
  }

  store(plainText: string): Promise<string> {
    this.stored.push(plainText);
    this.values.set(NEW_SECRET_REF, plainText);
    return Promise.resolve(NEW_SECRET_REF);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function pairedRecord(): PairedCompanionDeviceRecord {
  return {
    credentialRef: SECRET_REF,
    device: companionDeviceFixture,
    relayOrigin: companionPairingTicketFixture.relayOrigin,
    updatedAt: COMPANION_FIXTURE_TIMESTAMPS.created,
  };
}

interface RelayDouble {
  readonly client: CompanionRelayClient;
  readonly createPairingTicket: Mock<
    CompanionRelayClient["createPairingTicket"]
  >;
  readonly setNotificationsEnabled: Mock<
    CompanionRelayClient["setNotificationsEnabled"]
  >;
  readonly unpairDevice: Mock<CompanionRelayClient["unpairDevice"]>;
  readonly waitForPairingGrant: Mock<
    CompanionRelayClient["waitForPairingGrant"]
  >;
}

function createRelay(
  grant: Deferred<CompanionPairingGrant | undefined>,
  ticket: CompanionPairingTicket = companionPairingTicketFixture,
): RelayDouble {
  const createPairingTicket = vi
    .fn<CompanionRelayClient["createPairingTicket"]>()
    .mockResolvedValue(ticket);
  const setNotificationsEnabled = vi
    .fn<CompanionRelayClient["setNotificationsEnabled"]>()
    .mockResolvedValue(undefined);
  const unpairDevice = vi
    .fn<CompanionRelayClient["unpairDevice"]>()
    .mockResolvedValue(undefined);
  const waitForPairingGrant = vi.fn<
    CompanionRelayClient["waitForPairingGrant"]
  >(() => grant.promise);
  return {
    client: {
      acknowledgeDesktopMailbox: vi.fn().mockResolvedValue(undefined),
      createPairingTicket,
      enqueueAndroidMailbox: vi.fn(() => Promise.reject(new Error("unused"))),
      fetchDesktopMailbox: vi.fn(),
      readAsset: vi.fn(),
      setNotificationsEnabled,
      unpairDevice,
      waitForPairingGrant,
    },
    createPairingTicket,
    setNotificationsEnabled,
    unpairDevice,
    waitForPairingGrant,
  };
}

interface Harness {
  readonly backgroundErrors: Mock<(error: unknown) => void>;
  readonly beforeUnpair: Mock<(record: PairedCompanionDeviceRecord) => void>;
  readonly clock: MutableClock;
  readonly database: Database.Database;
  readonly grant: Deferred<CompanionPairingGrant | undefined>;
  readonly onPaired: Mock<(record: PairedCompanionDeviceRecord) => void>;
  readonly onUnpairFailed: Mock<
    (record: PairedCompanionDeviceRecord, error: unknown) => void
  >;
  readonly onUnpaired: Mock<(record: PairedCompanionDeviceRecord) => void>;
  readonly publish: Mock<(snapshot: CompanionDesktopSnapshot) => void>;
  readonly relay: CompanionRelayClient;
  readonly relayCreatePairingTicket: RelayDouble["createPairingTicket"];
  readonly relaySetNotificationsEnabled: RelayDouble["setNotificationsEnabled"];
  readonly relayUnpairDevice: RelayDouble["unpairDevice"];
  readonly relayWaitForPairingGrant: RelayDouble["waitForPairingGrant"];
  readonly repository: CompanionBridgeRepository;
  readonly secrets: MemorySecretStore;
  readonly service: CompanionBridgeService;
}

const harnesses: Harness[] = [];

function createHarness(options: { readonly paired?: boolean } = {}): Harness {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(METADATA_SCHEMA_SQL);
  database.exec(CURRENT_SCHEMA_SQL);
  const repository = new CompanionBridgeRepository(database);
  repository.getOrCreateDesktopInstanceId(() => COMPANION_FIXTURE_IDS.desktop);
  if (options.paired) repository.pairDevice(pairedRecord());

  const grant = deferred<CompanionPairingGrant | undefined>();
  const relay = createRelay(grant);
  const secrets = new MemorySecretStore();
  if (options.paired) secrets.values.set(SECRET_REF, "stored-credential");
  const publish = vi.fn<(snapshot: CompanionDesktopSnapshot) => void>();
  const beforeUnpair = vi.fn<(record: PairedCompanionDeviceRecord) => void>();
  const onPaired = vi.fn<(record: PairedCompanionDeviceRecord) => void>();
  const onUnpairFailed =
    vi.fn<(record: PairedCompanionDeviceRecord, error: unknown) => void>();
  const onUnpaired = vi.fn<(record: PairedCompanionDeviceRecord) => void>();
  const backgroundErrors = vi.fn<(error: unknown) => void>();
  const clock = new MutableClock();
  const service = new CompanionBridgeService({
    clock,
    hooks: {
      beforeUnpair,
      onBackgroundError: backgroundErrors,
      onPaired,
      onUnpairFailed,
      onUnpaired,
    },
    publisher: { publish },
    relay: relay.client,
    repository,
    secrets,
  });
  const harness = {
    backgroundErrors,
    beforeUnpair,
    clock,
    database,
    grant,
    onPaired,
    onUnpairFailed,
    onUnpaired,
    publish,
    relay: relay.client,
    relayCreatePairingTicket: relay.createPairingTicket,
    relaySetNotificationsEnabled: relay.setNotificationsEnabled,
    relayUnpairDevice: relay.unpairDevice,
    relayWaitForPairingGrant: relay.waitForPairingGrant,
    repository,
    secrets,
    service,
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  vi.useRealTimers();
  for (const harness of harnesses.splice(0)) {
    harness.service.dispose();
    harness.database.close();
  }
});

describe("CompanionBridgeService", () => {
  it("keeps the pairing ticket in memory, then persists only the granted credential reference", async () => {
    const harness = createHarness();

    await expect(harness.service.startPairing()).resolves.toEqual({
      expiresAt: companionPairingTicketFixture.expiresAt,
      qrPayload: JSON.stringify(companionPairingTicketFixture),
      state: "pairing",
    });
    expect(harness.repository.getPairedDevice()).toBeUndefined();
    expect(harness.secrets.stored).toEqual([]);

    harness.grant.resolve(companionPairingGrantFixture);
    await vi.waitFor(() =>
      expect(harness.repository.getPairedDevice()).toMatchObject({
        credentialRef: NEW_SECRET_REF,
        device: companionDeviceFixture,
        relayOrigin: companionPairingTicketFixture.relayOrigin,
      }),
    );

    expect(harness.secrets.stored).toEqual([
      companionPairingGrantFixture.deviceCredential,
    ]);
    expect(harness.onPaired).toHaveBeenCalledOnce();
    const snapshot = harness.publish.mock.lastCall?.[0];
    expect(snapshot?.state).toBe("paired");
    if (snapshot?.state === "paired") {
      expect(snapshot.device.id).toBe(COMPANION_FIXTURE_IDS.device);
    }
    expect(JSON.stringify(harness.repository.getPairedDevice())).not.toContain(
      companionPairingGrantFixture.deviceCredential,
    );
  });

  it("expires the in-memory QR from the ticket timestamp and aborts the waiter", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await harness.service.startPairing();
    const waitCall = harness.relayWaitForPairingGrant.mock.calls[0]?.[0];

    harness.clock.value = companionPairingTicketFixture.expiresAt;
    await vi.advanceTimersByTimeAsync(
      Date.parse(companionPairingTicketFixture.expiresAt) -
        Date.parse(COMPANION_FIXTURE_TIMESTAMPS.created),
    );

    expect(waitCall?.signal?.aborted).toBe(true);
    expect(harness.service.getSnapshot()).toEqual({ state: "unpaired" });
    expect(harness.publish).toHaveBeenLastCalledWith({ state: "unpaired" });
  });

  it("continues Relay-controlled waits without discarding a still-valid QR", async () => {
    const harness = createHarness();
    const nextGrant = deferred<CompanionPairingGrant | undefined>();
    harness.relayWaitForPairingGrant
      .mockImplementationOnce(() => harness.grant.promise)
      .mockImplementationOnce(() => nextGrant.promise);
    await harness.service.startPairing();

    harness.grant.resolve(undefined);
    await vi.waitFor(() =>
      expect(harness.relayWaitForPairingGrant).toHaveBeenCalledTimes(2),
    );
    expect(harness.service.getSnapshot()).toMatchObject({ state: "pairing" });
    expect(harness.secrets.stored).toEqual([]);

    nextGrant.resolve(companionPairingGrantFixture);
    await vi.waitFor(() =>
      expect(harness.repository.getPairedDevice()?.device.id).toBe(
        COMPANION_FIXTURE_IDS.device,
      ),
    );
  });

  it("keeps a valid pairing ticket while honoring Relay retry-after", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.relayWaitForPairingGrant.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "busy", 503, 2_000),
    );
    await harness.service.startPairing();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.relayWaitForPairingGrant).toHaveBeenCalledTimes(1);
    expect(harness.service.getSnapshot()).toMatchObject({ state: "pairing" });
    expect(harness.backgroundErrors).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.relayWaitForPairingGrant).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.relayWaitForPairingGrant).toHaveBeenCalledTimes(2);

    harness.grant.resolve(companionPairingGrantFixture);
    await vi.waitFor(() =>
      expect(harness.repository.getPairedDevice()?.device.id).toBe(
        COMPANION_FIXTURE_IDS.device,
      ),
    );
  });

  it("clears pairing when a retryable Relay failure has no retry-after", async () => {
    const harness = createHarness();
    harness.relayWaitForPairingGrant.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "offline"),
    );
    await harness.service.startPairing();

    await vi.waitFor(() =>
      expect(harness.service.getSnapshot()).toEqual({ state: "unpaired" }),
    );
    expect(harness.backgroundErrors).toHaveBeenCalledOnce();
    expect(harness.relayWaitForPairingGrant).toHaveBeenCalledTimes(1);
  });

  it("cancels a Relay-directed pairing retry when disposed", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.relayWaitForPairingGrant.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "busy", 429, 2_000),
    );
    await harness.service.startPairing();
    await vi.advanceTimersByTimeAsync(0);

    harness.service.dispose();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.relayWaitForPairingGrant).toHaveBeenCalledTimes(1);
    expect(harness.service.getSnapshot()).toEqual({ state: "unpaired" });
    expect(harness.backgroundErrors).not.toHaveBeenCalled();
  });

  it("deletes a newly stored credential when device persistence fails", async () => {
    const harness = createHarness();
    vi.spyOn(harness.repository, "pairDevice").mockImplementation(() => {
      throw new CompanionBridgePersistenceError(
        "COMPANION.DEVICE_SLOT_OCCUPIED",
        "occupied",
      );
    });
    await harness.service.startPairing();

    harness.grant.resolve(companionPairingGrantFixture);
    await vi.waitFor(() =>
      expect(harness.backgroundErrors).toHaveBeenCalledOnce(),
    );

    expect(harness.secrets.deleted).toEqual([NEW_SECRET_REF]);
    expect(harness.repository.getPairedDevice()).toBeUndefined();
    expect(harness.service.getSnapshot()).toEqual({ state: "unpaired" });
  });

  it("does not store a second credential when the same device grant is replayed", async () => {
    const harness = createHarness();
    await harness.service.startPairing();
    harness.repository.pairDevice(pairedRecord());

    harness.grant.resolve(companionPairingGrantFixture);
    await vi.waitFor(() => {
      const snapshot = harness.publish.mock.lastCall?.[0];
      expect(snapshot?.state).toBe("paired");
      if (snapshot?.state === "paired") {
        expect(snapshot.device.id).toBe(COMPANION_FIXTURE_IDS.device);
      }
    });

    expect(harness.secrets.stored).toEqual([]);
    expect(harness.repository.getPairedDevice()?.credentialRef).toBe(
      SECRET_REF,
    );
    expect(harness.onPaired).not.toHaveBeenCalled();
  });

  it("updates Relay before publishing notification preference and status changes", async () => {
    const harness = createHarness({ paired: true });
    harness.clock.value = LATER;

    await expect(
      harness.service.setNotificationsEnabled({
        deviceId: COMPANION_FIXTURE_IDS.device,
        enabled: false,
      }),
    ).resolves.toMatchObject({
      device: { notificationsEnabled: false },
      state: "paired",
    });
    const preferenceCall =
      harness.relaySetNotificationsEnabled.mock.calls[0]?.[0];
    expect(preferenceCall).toMatchObject({
      credential: "stored-credential",
      relayOrigin: companionPairingTicketFixture.relayOrigin,
      request: {
        deviceId: COMPANION_FIXTURE_IDS.device,
        enabled: false,
        protocolVersion: 1,
      },
    });
    expect(preferenceCall?.signal).toBeInstanceOf(AbortSignal);

    harness.service.updateDeviceStatus(COMPANION_FIXTURE_IDS.device, {
      message: "Relay protocol mismatch",
      observedAt: LATER,
      state: "protocol_error",
    });
    const statusSnapshot = harness.publish.mock.lastCall?.[0];
    expect(statusSnapshot?.state).toBe("paired");
    if (statusSnapshot?.state === "paired") {
      expect(statusSnapshot.device.status).toEqual({
        message: "Relay protocol mismatch",
        observedAt: LATER,
        state: "protocol_error",
      });
    }

    harness.service.updateDeviceStatus(COMPANION_FIXTURE_IDS.device, {
      observedAt: "2026-09-01T10:02:00.000Z",
      state: "online",
    });
    const stickySnapshot = harness.publish.mock.lastCall?.[0];
    expect(stickySnapshot?.state).toBe("paired");
    if (stickySnapshot?.state === "paired") {
      expect(stickySnapshot.device.status).toEqual({
        message: "Relay protocol mismatch",
        observedAt: LATER,
        state: "protocol_error",
      });
    }
  });

  it("keeps local pairing and asks the processor to resume when Relay revoke fails", async () => {
    const harness = createHarness({ paired: true });
    harness.relayUnpairDevice.mockRejectedValueOnce(
      new CompanionRelayClientError("network", "offline"),
    );

    await expect(
      harness.service.unpair({ deviceId: COMPANION_FIXTURE_IDS.device }),
    ).rejects.toMatchObject({ message: "offline" });

    expect(harness.beforeUnpair).toHaveBeenCalledOnce();
    expect(harness.onUnpairFailed).toHaveBeenCalledOnce();
    const unpairFailure = harness.onUnpairFailed.mock.calls[0];
    expect(unpairFailure?.[0].device).toEqual(companionDeviceFixture);
    expect(unpairFailure?.[1]).toBeInstanceOf(CompanionRelayClientError);
    expect(harness.repository.getPairedDevice()).toBeDefined();
    expect(harness.secrets.deleted).toEqual([]);
  });

  it("removes local pairing when the stored remote credential is already missing", async () => {
    const harness = createHarness({ paired: true });
    harness.secrets.values.delete(SECRET_REF);

    await expect(
      harness.service.unpair({ deviceId: COMPANION_FIXTURE_IDS.device }),
    ).resolves.toEqual({ state: "unpaired" });

    expect(harness.relayUnpairDevice).not.toHaveBeenCalled();
    expect(harness.onUnpairFailed).not.toHaveBeenCalled();
    expect(harness.repository.getPairedDevice()).toBeUndefined();
    expect(harness.secrets.deleted).toEqual([SECRET_REF]);
    expect(harness.publish).toHaveBeenLastCalledWith({ state: "unpaired" });
  });

  it.each([401, 404, 410])(
    "removes local pairing when Relay revoke returns terminal HTTP %s",
    async (status) => {
      const harness = createHarness({ paired: true });
      harness.relayUnpairDevice.mockRejectedValueOnce(
        new CompanionRelayClientError("protocol", "already gone", status),
      );

      await expect(
        harness.service.unpair({ deviceId: COMPANION_FIXTURE_IDS.device }),
      ).resolves.toEqual({ state: "unpaired" });

      expect(harness.onUnpairFailed).not.toHaveBeenCalled();
      expect(harness.repository.getPairedDevice()).toBeUndefined();
      expect(harness.secrets.deleted).toEqual([SECRET_REF]);
    },
  );

  it("retains local pairing and resumes the processor on secret storage failure", async () => {
    const harness = createHarness({ paired: true });
    harness.secrets.getError = new ProviderError(
      "PROVIDER.STORAGE_FAILED",
      "storage failed",
      true,
    );

    await expect(
      harness.service.unpair({ deviceId: COMPANION_FIXTURE_IDS.device }),
    ).rejects.toMatchObject({ code: "PROVIDER.STORAGE_FAILED" });

    expect(harness.onUnpairFailed).toHaveBeenCalledOnce();
    expect(harness.repository.getPairedDevice()).toBeDefined();
    expect(harness.secrets.deleted).toEqual([]);
  });

  it("resumes the processor when local persistence fails after Relay revoke", async () => {
    const harness = createHarness({ paired: true });
    vi.spyOn(harness.repository, "unpairDevice").mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(
      harness.service.unpair({ deviceId: COMPANION_FIXTURE_IDS.device }),
    ).rejects.toThrow("database unavailable");

    expect(harness.relayUnpairDevice).toHaveBeenCalledOnce();
    expect(harness.onUnpairFailed).toHaveBeenCalledOnce();
    const recovery = harness.onUnpairFailed.mock.calls[0];
    expect(recovery?.[0].device.id).toBe(COMPANION_FIXTURE_IDS.device);
    expect(recovery?.[1]).toBeInstanceOf(Error);
    expect(harness.repository.getPairedDevice()).toBeDefined();
    expect(harness.secrets.deleted).toEqual([]);
  });

  it("revokes remotely, removes local pairing, and tolerates secret cleanup failure", async () => {
    const harness = createHarness({ paired: true });
    harness.secrets.deleteError = new Error("cleanup failed");

    await expect(
      harness.service.unpair({ deviceId: COMPANION_FIXTURE_IDS.device }),
    ).resolves.toEqual({ state: "unpaired" });

    const unpairCall = harness.relayUnpairDevice.mock.calls[0]?.[0];
    expect(unpairCall).toMatchObject({
      credential: "stored-credential",
      relayOrigin: companionPairingTicketFixture.relayOrigin,
      request: {
        deviceId: COMPANION_FIXTURE_IDS.device,
        protocolVersion: 1,
      },
    });
    expect(unpairCall?.signal).toBeInstanceOf(AbortSignal);
    expect(harness.repository.getPairedDevice()).toBeUndefined();
    expect(harness.secrets.deleted).toEqual([SECRET_REF]);
    expect(harness.onUnpaired).toHaveBeenCalledOnce();
    expect(harness.onUnpairFailed).not.toHaveBeenCalled();
    const cleanupError = harness.backgroundErrors.mock.calls[0]?.[0];
    expect(cleanupError).toBeInstanceOf(Error);
    if (cleanupError instanceof Error) {
      expect(cleanupError.message).toBe("cleanup failed");
    }
    expect(harness.publish).toHaveBeenLastCalledWith({ state: "unpaired" });
  });

  it("aborts an in-flight pairing ticket request during disposal", async () => {
    const harness = createHarness();
    const ticket = deferred<CompanionPairingTicket>();
    harness.relayCreatePairingTicket.mockImplementationOnce(
      () => ticket.promise,
    );

    const starting = harness.service.startPairing();
    await vi.waitFor(() =>
      expect(harness.relayCreatePairingTicket).toHaveBeenCalledOnce(),
    );
    const signal = harness.relayCreatePairingTicket.mock.calls[0]?.[0].signal;
    harness.service.dispose();
    expect(signal?.aborted).toBe(true);

    ticket.resolve(companionPairingTicketFixture);
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.repository.getPairedDevice()).toBeUndefined();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it("does not persist a notification preference after disposal aborts its Relay request", async () => {
    const harness = createHarness({ paired: true });
    const remote = deferred<void>();
    harness.relaySetNotificationsEnabled.mockImplementationOnce(
      () => remote.promise,
    );

    const updating = harness.service.setNotificationsEnabled({
      deviceId: COMPANION_FIXTURE_IDS.device,
      enabled: false,
    });
    await vi.waitFor(() =>
      expect(harness.relaySetNotificationsEnabled).toHaveBeenCalledOnce(),
    );
    const signal =
      harness.relaySetNotificationsEnabled.mock.calls[0]?.[0].signal;
    harness.service.dispose();
    expect(signal?.aborted).toBe(true);

    remote.resolve(undefined);
    await expect(updating).rejects.toMatchObject({ name: "AbortError" });
    expect(
      harness.repository.getPairedDevice()?.device.notificationsEnabled,
    ).toBe(true);
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it("does not delete local pairing after disposal aborts Relay revoke", async () => {
    const harness = createHarness({ paired: true });
    const remote = deferred<void>();
    harness.relayUnpairDevice.mockImplementationOnce(() => remote.promise);

    const unpairing = harness.service.unpair({
      deviceId: COMPANION_FIXTURE_IDS.device,
    });
    await vi.waitFor(() =>
      expect(harness.relayUnpairDevice).toHaveBeenCalledOnce(),
    );
    const signal = harness.relayUnpairDevice.mock.calls[0]?.[0].signal;
    harness.service.dispose();
    expect(signal?.aborted).toBe(true);

    remote.resolve(undefined);
    await expect(unpairing).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.repository.getPairedDevice()).toBeDefined();
    expect(harness.onUnpairFailed).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });
});
