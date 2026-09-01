import type {
  CompanionDesktopSetNotificationsEnabledRequest,
  CompanionDesktopSnapshot,
  CompanionDesktopUnpairRequest,
  CompanionDeviceStatus,
  CompanionPairingGrant,
  CompanionPairingTicket,
} from "../../shared/contracts/companion";
import { COMPANION_PROTOCOL_VERSION } from "../../shared/contracts/companion";
import type { Clock } from "../../shared/pure/clock";
import {
  CompanionDesktopSetNotificationsEnabledRequestSchema,
  CompanionDesktopUnpairRequestSchema,
  CompanionDeviceStatusSchema,
  CompanionPairingGrantSchema,
  CompanionPairingTicketSchema,
} from "../../shared/schemas/companion";
import { parseSchema } from "../../shared/schemas/validation";
import { ProviderError } from "../providers/providerError";
import type { ProviderSecretStore } from "../providers/secretStore";
import type {
  CompanionBridgeRepository,
  PairedCompanionDeviceRecord,
} from "./companionBridgeRepository";
import { CompanionError } from "./companionError";
import {
  companionRelayRetryAfterMs,
  type CompanionRelayClient,
  CompanionRelayClientError,
  waitForCompanionRetryAfter,
} from "./companionRelayClient";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface CompanionBridgePublisher {
  publish(snapshot: CompanionDesktopSnapshot): void;
}

export interface CompanionBridgeServiceHooks {
  beforeUnpair?(record: PairedCompanionDeviceRecord): Promise<void> | void;
  onBackgroundError?(error: unknown): void;
  onPaired?(record: PairedCompanionDeviceRecord): Promise<void> | void;
  onUnpairFailed?(
    record: PairedCompanionDeviceRecord,
    error: unknown,
  ): Promise<void> | void;
  onUnpaired?(record: PairedCompanionDeviceRecord): Promise<void> | void;
}

export interface CompanionBridgeServiceDependencies {
  readonly clock: Clock;
  readonly hooks?: CompanionBridgeServiceHooks;
  readonly publisher: CompanionBridgePublisher;
  readonly relay: CompanionRelayClient;
  readonly repository: CompanionBridgeRepository;
  readonly secrets: ProviderSecretStore;
}

interface ActivePairing {
  readonly controller: AbortController;
  readonly snapshot: Extract<CompanionDesktopSnapshot, { state: "pairing" }>;
  readonly ticket: CompanionPairingTicket;
  expiresTimer?: ReturnType<typeof setTimeout>;
}

function pairedSnapshot(
  record: PairedCompanionDeviceRecord,
): CompanionDesktopSnapshot {
  const { device } = record;
  return {
    device: {
      displayName: device.displayName,
      id: device.id,
      notificationPermission: device.notificationPermission,
      notificationsEnabled: device.notificationsEnabled,
      pairedAt: device.pairedAt,
      platform: device.platform,
      status: device.status,
    },
    state: "paired",
  };
}

function pairingQrPayload(ticket: CompanionPairingTicket): string {
  return JSON.stringify(ticket);
}

function timestampMs(value: string): number {
  return Date.parse(value);
}

function sameDevice(
  current: PairedCompanionDeviceRecord,
  grant: CompanionPairingGrant,
): boolean {
  return (
    current.device.id === grant.device.id &&
    current.device.installationId === grant.device.installationId &&
    current.device.protocolVersion === grant.device.protocolVersion
  );
}

function remoteDeviceAlreadyAbsent(error: unknown): boolean {
  if (
    error instanceof ProviderError &&
    error.code === "PROVIDER.CREDENTIAL_REQUIRED"
  ) {
    return true;
  }
  return (
    error instanceof CompanionRelayClientError &&
    error.kind === "protocol" &&
    (error.status === 401 || error.status === 404 || error.status === 410)
  );
}

export class CompanionBridgeService {
  #activePairing: ActivePairing | undefined;
  #disposed = false;
  readonly #operationControllers = new Set<AbortController>();
  #startingPairing: Promise<CompanionDesktopSnapshot> | undefined;

  constructor(
    private readonly dependencies: CompanionBridgeServiceDependencies,
  ) {}

  dispose(): void {
    this.#disposed = true;
    for (const controller of this.#operationControllers) controller.abort();
    this.#operationControllers.clear();
    this.#clearPairing(this.#activePairing, false);
  }

  getSnapshot(): CompanionDesktopSnapshot {
    const paired = this.dependencies.repository.getPairedDevice();
    if (paired) return pairedSnapshot(paired);
    if (this.#activePairing && !this.#pairingExpired(this.#activePairing)) {
      return this.#activePairing.snapshot;
    }
    return { state: "unpaired" };
  }

  publishCurrentSnapshot(): CompanionDesktopSnapshot {
    const snapshot = this.getSnapshot();
    this.dependencies.publisher.publish(snapshot);
    return snapshot;
  }

  startPairing(): Promise<CompanionDesktopSnapshot> {
    this.#assertRunning();
    const paired = this.dependencies.repository.getPairedDevice();
    if (paired) return Promise.resolve(pairedSnapshot(paired));

    const active = this.#activePairing;
    if (active && !this.#pairingExpired(active)) {
      return Promise.resolve(active.snapshot);
    }
    if (active) this.#expirePairing(active);
    if (this.#startingPairing) return this.#startingPairing;

    const task = this.#createPairing();
    this.#startingPairing = task;
    const clearStarting = () => {
      if (this.#startingPairing === task) this.#startingPairing = undefined;
    };
    void task.then(clearStarting, clearStarting);
    return task;
  }

  async setNotificationsEnabled(
    input: CompanionDesktopSetNotificationsEnabledRequest,
  ): Promise<CompanionDesktopSnapshot> {
    const request = parseSchema(
      CompanionDesktopSetNotificationsEnabledRequestSchema,
      input,
    );
    const controller = this.#beginOperation();
    try {
      const paired = this.#requirePaired(request.deviceId);
      if (paired.device.notificationsEnabled === request.enabled) {
        return pairedSnapshot(paired);
      }

      const credential = await this.dependencies.secrets.get(
        paired.credentialRef,
      );
      controller.signal.throwIfAborted();
      await this.dependencies.relay.setNotificationsEnabled({
        credential,
        relayOrigin: paired.relayOrigin,
        request: {
          deviceId: request.deviceId,
          enabled: request.enabled,
          protocolVersion: COMPANION_PROTOCOL_VERSION,
        },
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();

      const updated = this.dependencies.repository.setNotificationsEnabled(
        request.deviceId,
        request.enabled,
        this.dependencies.clock.now(),
      );
      if (!updated) throw this.#notPaired();
      const snapshot = pairedSnapshot(updated);
      this.dependencies.publisher.publish(snapshot);
      return snapshot;
    } finally {
      this.#endOperation(controller);
    }
  }

  updateDeviceStatus(
    deviceId: string,
    input: CompanionDeviceStatus,
  ): CompanionDesktopSnapshot {
    this.#requirePaired(deviceId);
    const status = parseSchema(CompanionDeviceStatusSchema, input);
    const updated = this.dependencies.repository.updateDeviceStatus(
      deviceId,
      status,
    );
    if (!updated) throw this.#notPaired();
    const snapshot = pairedSnapshot(updated);
    this.dependencies.publisher.publish(snapshot);
    return snapshot;
  }

  async unpair(
    input: CompanionDesktopUnpairRequest,
  ): Promise<CompanionDesktopSnapshot> {
    const request = parseSchema(CompanionDesktopUnpairRequestSchema, input);
    const controller = this.#beginOperation();
    let localRemoved = false;
    let paired: PairedCompanionDeviceRecord | undefined;
    let processorStopped = false;
    try {
      paired = this.#requirePaired(request.deviceId);
      if (this.dependencies.hooks?.beforeUnpair) {
        await this.dependencies.hooks.beforeUnpair(paired);
        processorStopped = true;
      }
      controller.signal.throwIfAborted();
      try {
        const credential = await this.dependencies.secrets.get(
          paired.credentialRef,
        );
        controller.signal.throwIfAborted();
        await this.dependencies.relay.unpairDevice({
          credential,
          relayOrigin: paired.relayOrigin,
          request: {
            deviceId: request.deviceId,
            protocolVersion: COMPANION_PROTOCOL_VERSION,
          },
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (!remoteDeviceAlreadyAbsent(error)) throw error;
      }
      controller.signal.throwIfAborted();

      const removed = this.dependencies.repository.unpairDevice(
        request.deviceId,
      );
      if (!removed) throw this.#notPaired();
      localRemoved = true;
      this.#clearPairing(this.#activePairing, false);
      await this.#bestEffort(() =>
        this.dependencies.secrets.delete(removed.credentialRef),
      );
      await this.#bestEffort(() =>
        this.dependencies.hooks?.onUnpaired?.(removed),
      );
      const snapshot: CompanionDesktopSnapshot = { state: "unpaired" };
      this.dependencies.publisher.publish(snapshot);
      return snapshot;
    } catch (error) {
      if (
        paired &&
        processorStopped &&
        !localRemoved &&
        !controller.signal.aborted
      ) {
        const recoveryRecord = paired;
        await this.#bestEffort(() =>
          this.dependencies.hooks?.onUnpairFailed?.(recoveryRecord, error),
        );
      }
      throw error;
    } finally {
      this.#endOperation(controller);
    }
  }

  async #createPairing(): Promise<CompanionDesktopSnapshot> {
    if (this.#disposed) {
      throw new CompanionError(
        "COMPANION.OPERATION_FAILED",
        "手机 Companion 服务已经停止。",
        true,
      );
    }
    const desktopInstanceId =
      this.dependencies.repository.getOrCreateDesktopInstanceId();
    const controller = this.#beginOperation();
    let result: CompanionPairingTicket;
    try {
      result = await this.dependencies.relay.createPairingTicket({
        desktopInstanceId,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
    } finally {
      this.#endOperation(controller);
    }
    const ticket = parseSchema(CompanionPairingTicketSchema, result);
    const pairedDuringRequest = this.dependencies.repository.getPairedDevice();
    if (pairedDuringRequest) return pairedSnapshot(pairedDuringRequest);
    if (ticket.desktopInstanceId !== desktopInstanceId) {
      throw new CompanionError(
        "COMPANION.INVALID_PAIRING_GRANT",
        "Relay 返回了不属于这台电脑的配对票据。",
        false,
      );
    }
    if (ticket.protocolVersion !== COMPANION_PROTOCOL_VERSION) {
      throw this.#protocolMismatch();
    }
    if (
      timestampMs(ticket.expiresAt) <=
      timestampMs(this.dependencies.clock.now())
    ) {
      throw new CompanionError(
        "COMPANION.PAIRING_EXPIRED",
        "配对二维码已经过期，请重新生成。",
        false,
      );
    }

    const active: ActivePairing = {
      controller: new AbortController(),
      snapshot: {
        expiresAt: ticket.expiresAt,
        qrPayload: pairingQrPayload(ticket),
        state: "pairing",
      },
      ticket,
    };
    this.#activePairing = active;
    this.#scheduleExpiry(active);
    this.dependencies.publisher.publish(active.snapshot);
    void this.#waitForPairingGrant(active);
    return active.snapshot;
  }

  async #waitForPairingGrant(active: ActivePairing): Promise<void> {
    try {
      while (this.#activePairing === active && !this.#pairingExpired(active)) {
        let result: CompanionPairingGrant | undefined;
        try {
          result = await this.dependencies.relay.waitForPairingGrant({
            signal: active.controller.signal,
            ticket: active.ticket,
          });
        } catch (error) {
          const retryAfterMs = companionRelayRetryAfterMs(error);
          if (retryAfterMs === undefined) throw error;
          await waitForCompanionRetryAfter(
            retryAfterMs,
            active.controller.signal,
          );
          continue;
        }
        if (this.#activePairing !== active || this.#pairingExpired(active)) {
          return;
        }
        if (!result) continue;
        const grant = parseSchema(CompanionPairingGrantSchema, result);
        await this.#completePairing(active, grant);
        return;
      }
    } catch (error) {
      if (active.controller.signal.aborted || this.#activePairing !== active) {
        return;
      }
      this.#clearPairing(active, true);
      this.dependencies.hooks?.onBackgroundError?.(error);
    }
  }

  async #completePairing(
    active: ActivePairing,
    grant: CompanionPairingGrant,
  ): Promise<void> {
    if (grant.desktopInstanceId !== active.ticket.desktopInstanceId) {
      throw new CompanionError(
        "COMPANION.INVALID_PAIRING_GRANT",
        "手机返回的配对结果不属于这台电脑。",
        false,
      );
    }
    if (
      grant.protocolVersion !== COMPANION_PROTOCOL_VERSION ||
      grant.device.protocolVersion !== COMPANION_PROTOCOL_VERSION
    ) {
      throw this.#protocolMismatch();
    }

    const existing = this.dependencies.repository.getPairedDevice();
    if (existing) {
      if (!sameDevice(existing, grant)) {
        throw new CompanionError(
          "COMPANION.DEVICE_SLOT_OCCUPIED",
          "这台电脑已经配对了另一台 Android 手机。",
          false,
        );
      }
      this.#clearPairing(active, false);
      this.dependencies.publisher.publish(pairedSnapshot(existing));
      return;
    }

    const credentialRef = await this.dependencies.secrets.store(
      grant.deviceCredential,
    );
    if (this.#activePairing !== active || this.#pairingExpired(active)) {
      await this.#bestEffort(() =>
        this.dependencies.secrets.delete(credentialRef),
      );
      return;
    }

    let paired: PairedCompanionDeviceRecord;
    try {
      paired = this.dependencies.repository.pairDevice({
        credentialRef,
        device: grant.device,
        relayOrigin: active.ticket.relayOrigin,
        updatedAt: this.dependencies.clock.now(),
      });
    } catch (error) {
      await this.#bestEffort(() =>
        this.dependencies.secrets.delete(credentialRef),
      );
      throw error;
    }

    this.#clearPairing(active, false);
    await this.#bestEffort(() => this.dependencies.hooks?.onPaired?.(paired));
    this.dependencies.publisher.publish(pairedSnapshot(paired));
  }

  #scheduleExpiry(active: ActivePairing): void {
    if (this.#activePairing !== active) return;
    const remaining =
      timestampMs(active.ticket.expiresAt) -
      timestampMs(this.dependencies.clock.now());
    active.expiresTimer = setTimeout(
      () => {
        if (this.#activePairing !== active) return;
        if (!this.#pairingExpired(active)) {
          this.#scheduleExpiry(active);
          return;
        }
        this.#expirePairing(active);
      },
      Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS)),
    );
  }

  #pairingExpired(active: ActivePairing): boolean {
    return (
      timestampMs(active.ticket.expiresAt) <=
      timestampMs(this.dependencies.clock.now())
    );
  }

  #expirePairing(active: ActivePairing): void {
    this.#clearPairing(active, true);
  }

  #clearPairing(active: ActivePairing | undefined, publish: boolean): void {
    if (!active || this.#activePairing !== active) return;
    if (active.expiresTimer) clearTimeout(active.expiresTimer);
    active.controller.abort();
    this.#activePairing = undefined;
    if (publish) this.publishCurrentSnapshot();
  }

  #requirePaired(deviceId: string): PairedCompanionDeviceRecord {
    const paired = this.dependencies.repository.getPairedDevice();
    if (!paired) throw this.#notPaired();
    if (paired.device.id !== deviceId) {
      throw new CompanionError(
        "COMPANION.DEVICE_MISMATCH",
        "请求的手机不是当前配对设备。",
        false,
      );
    }
    return paired;
  }

  #notPaired(): CompanionError {
    return new CompanionError(
      "COMPANION.NOT_PAIRED",
      "当前没有已配对的 Android 手机。",
      false,
    );
  }

  #protocolMismatch(): CompanionError {
    return new CompanionError(
      "COMPANION.PROTOCOL_MISMATCH",
      "手机与桌面端的 Companion 协议版本不一致。",
      false,
    );
  }

  #assertRunning(): void {
    if (this.#disposed) {
      throw new CompanionError(
        "COMPANION.OPERATION_FAILED",
        "手机 Companion 服务已经停止。",
        true,
      );
    }
  }

  #beginOperation(): AbortController {
    this.#assertRunning();
    const controller = new AbortController();
    this.#operationControllers.add(controller);
    return controller;
  }

  #endOperation(controller: AbortController): void {
    this.#operationControllers.delete(controller);
  }

  async #bestEffort(operation: () => unknown): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.dependencies.hooks?.onBackgroundError?.(error);
    }
  }
}
