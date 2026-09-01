import { isDeepStrictEqual } from "node:util";

import {
  COMPANION_PROTOCOL_VERSION,
  type CompanionAndroidMailboxEnqueueReceipt,
  type CompanionAndroidMailboxEnqueueRequest,
  type CompanionChatTarget,
  type CompanionDeviceStatus,
} from "../../shared/contracts/companion";
import type { Chat } from "../../shared/contracts/chat";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { CompanionAndroidMailboxEnqueueReceiptSchema } from "../../shared/schemas/companion";
import { parseSchema } from "../../shared/schemas/validation";
import type { ChatRepository } from "../chat/chatRepository";
import { ProviderError } from "../providers/providerError";
import type { ProviderSecretStore } from "../providers/secretStore";
import type { PairedCompanionDeviceRecord } from "./companionBridgeRepository";
import {
  CompanionRelayClientError,
  companionRelayRetryAfterMs,
  type CompanionRelayClient,
  waitForCompanionRetryAfter,
} from "./companionRelayClient";

interface CompanionChatTargetsBridgePort {
  getPairedDevice(): PairedCompanionDeviceRecord | undefined;
}

interface CompanionChatTargetsChatPort {
  listChats(
    filter: Parameters<ChatRepository["listChats"]>[0],
  ): ReturnType<ChatRepository["listChats"]>;
}

export interface CompanionChatTargetsProjectionServiceDependencies {
  readonly bridge: CompanionChatTargetsBridgePort;
  readonly chats: CompanionChatTargetsChatPort;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly onBackgroundError?: (error: unknown) => void;
  readonly onStatusChange?: (
    deviceId: string,
    status: CompanionDeviceStatus,
  ) => void;
  readonly relay: Pick<CompanionRelayClient, "enqueueAndroidMailbox">;
  readonly secretStore: Pick<ProviderSecretStore, "get">;
}

interface PendingProjection {
  readonly deviceId: string;
  readonly fingerprint: string;
  readonly request: CompanionAndroidMailboxEnqueueRequest;
}

class CompanionChatTargetsProjectionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionChatTargetsProjectionProtocolError";
  }
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function target(chat: Chat): CompanionChatTarget {
  return { chatId: chat.id, title: chat.title, updatedAt: chat.updatedAt };
}

function fingerprint(
  deviceId: string,
  targets: readonly CompanionChatTarget[],
) {
  return JSON.stringify({ deviceId, targets });
}

export class CompanionChatTargetsProjectionService {
  #active = false;
  #blocked = false;
  #controller: AbortController | undefined;
  #lastProjectedFingerprint: string | undefined;
  #paused = false;
  #pending: PendingProjection | undefined;
  #restartRequested = false;
  #shutdown = false;
  #task: Promise<void> | undefined;
  #waitingForRetryAfter = false;

  constructor(
    private readonly dependencies: CompanionChatTargetsProjectionServiceDependencies,
  ) {}

  start(): void {
    if (this.#shutdown || this.#blocked || this.#paused) return;
    this.#active = true;
    if (this.#task) {
      if (this.#controller?.signal.aborted) this.#restartRequested = true;
      return;
    }
    this.#launch();
  }

  wake(): void {
    if (this.#shutdown || this.#blocked || this.#paused) return;
    if (this.#waitingForRetryAfter) {
      this.#active = true;
      this.#restartRequested = true;
      return;
    }
    this.#restart();
  }

  async pause(): Promise<void> {
    if (this.#shutdown) return;
    this.#paused = true;
    await this.#stop();
  }

  resume(): void {
    if (this.#shutdown) return;
    this.#paused = false;
    this.start();
  }

  reset(): void {
    if (this.#shutdown) return;
    this.#blocked = false;
    this.#paused = false;
    this.#lastProjectedFingerprint = undefined;
    this.#pending = undefined;
    this.#restart();
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    this.#paused = true;
    await this.#stop();
  }

  #restart(): void {
    this.#active = true;
    if (!this.#task) {
      this.#launch();
      return;
    }
    this.#restartRequested = true;
    this.#controller?.abort();
  }

  async #stop(): Promise<void> {
    this.#active = false;
    this.#restartRequested = false;
    this.#controller?.abort();
    await this.#task;
  }

  #launch(): void {
    if (
      !this.#active ||
      this.#blocked ||
      this.#paused ||
      this.#shutdown ||
      this.#task
    ) {
      return;
    }
    const controller = new AbortController();
    this.#controller = controller;
    const task = this.#run(controller.signal)
      .catch((error: unknown) => {
        if (isAbort(error, controller.signal)) return;
        const paired = this.dependencies.bridge.getPairedDevice();
        if (!paired) return;
        const protocolError =
          error instanceof CompanionChatTargetsProjectionProtocolError ||
          (error instanceof CompanionRelayClientError &&
            error.kind === "protocol") ||
          (error instanceof ProviderError &&
            error.code === "PROVIDER.CREDENTIAL_REQUIRED" &&
            !error.retryable);
        if (protocolError) {
          this.#blocked = true;
          this.#restartRequested = false;
        }
        this.#publishStatus(
          paired.device.id,
          protocolError
            ? {
                message:
                  error instanceof Error && error.message.trim()
                    ? error.message
                    : "Companion Chat target protocol error.",
                observedAt: this.dependencies.clock.now(),
                state: "protocol_error",
              }
            : {
                observedAt: this.dependencies.clock.now(),
                state: "offline",
              },
        );
        this.dependencies.onBackgroundError?.(error);
      })
      .finally(() => {
        if (this.#task !== task) return;
        this.#task = undefined;
        if (this.#controller === controller) this.#controller = undefined;
        if (
          this.#restartRequested &&
          this.#active &&
          !this.#blocked &&
          !this.#paused &&
          !this.#shutdown
        ) {
          this.#restartRequested = false;
          this.#launch();
        }
      });
    this.#task = task;
  }

  async #run(signal: AbortSignal): Promise<void> {
    const paired = this.dependencies.bridge.getPairedDevice();
    if (!paired || paired.device.status.state === "protocol_error") return;

    const targets = this.dependencies.chats
      .listChats({ status: "active" })
      .map(target);
    const currentFingerprint = fingerprint(paired.device.id, targets);
    if (currentFingerprint === this.#lastProjectedFingerprint) return;
    if (
      !this.#pending ||
      this.#pending.deviceId !== paired.device.id ||
      this.#pending.fingerprint !== currentFingerprint
    ) {
      this.#pending = {
        deviceId: paired.device.id,
        fingerprint: currentFingerprint,
        request: {
          envelopeId: this.dependencies.idGenerator.generate(),
          event: {
            deviceId: paired.device.id,
            snapshot: {
              generatedAt: this.dependencies.clock.now(),
              targets,
            },
            type: "companion.chat_targets.replaced",
          },
          protocolVersion: COMPANION_PROTOCOL_VERSION,
          recipient: { deviceId: paired.device.id, kind: "android" },
        },
      };
    }
    const pending = this.#pending;
    const credential = await this.dependencies.secretStore.get(
      paired.credentialRef,
    );
    signal.throwIfAborted();

    while (!signal.aborted) {
      try {
        const receipt = await this.dependencies.relay.enqueueAndroidMailbox({
          credential,
          relayOrigin: paired.relayOrigin,
          request: pending.request,
          signal,
        });
        signal.throwIfAborted();
        this.#assertReceipt(pending.request, receipt);
        if (this.#pending === pending) {
          this.#lastProjectedFingerprint = pending.fingerprint;
          this.#pending = undefined;
        }
        this.#publishStatus(paired.device.id, {
          observedAt: this.dependencies.clock.now(),
          state: "online",
        });
        return;
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        const retryAfterMs = companionRelayRetryAfterMs(error);
        if (retryAfterMs === undefined) throw error;
        this.#publishStatus(paired.device.id, {
          observedAt: this.dependencies.clock.now(),
          state: "offline",
        });
        this.#waitingForRetryAfter = true;
        try {
          await waitForCompanionRetryAfter(retryAfterMs, signal);
        } finally {
          this.#waitingForRetryAfter = false;
        }
      }
    }
    signal.throwIfAborted();
  }

  #assertReceipt(
    request: CompanionAndroidMailboxEnqueueRequest,
    input: CompanionAndroidMailboxEnqueueReceipt,
  ): void {
    let receipt: CompanionAndroidMailboxEnqueueReceipt;
    try {
      receipt = parseSchema(CompanionAndroidMailboxEnqueueReceiptSchema, input);
    } catch {
      throw new CompanionChatTargetsProjectionProtocolError(
        "Companion Relay returned an invalid Chat targets receipt.",
      );
    }
    if (
      receipt.envelope.id !== request.envelopeId ||
      !isDeepStrictEqual(receipt.envelope.event, request.event) ||
      !isDeepStrictEqual(receipt.envelope.recipient, request.recipient)
    ) {
      throw new CompanionChatTargetsProjectionProtocolError(
        "Companion Relay returned a receipt for another Chat targets event.",
      );
    }
  }

  #publishStatus(deviceId: string, status: CompanionDeviceStatus): void {
    this.dependencies.onStatusChange?.(deviceId, status);
  }
}
