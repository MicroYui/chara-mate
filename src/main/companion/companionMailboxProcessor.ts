import type {
  CompanionDesktopMailboxAck,
  CompanionDesktopMailboxEnvelope,
  CompanionDeviceStatus,
  CompanionShareImportedAckResult,
} from "../../shared/contracts/companion";
import { COMPANION_PROTOCOL_VERSION } from "../../shared/contracts/companion";
import type { Clock } from "../../shared/pure/clock";
import type { ProviderSecretStore } from "../providers/secretStore";
import { ProviderError } from "../providers/providerError";
import {
  CompanionBridgePersistenceError,
  type CompanionShareImportRecord,
  type PairedCompanionDeviceRecord,
} from "./companionBridgeRepository";
import {
  CompanionShareIngressError,
  type CompanionShareIngress,
} from "./companionShareIngress";
import {
  CompanionRelayClientError,
  companionRelayRetryAfterMs,
  type CompanionRelayClient,
  waitForCompanionRetryAfter,
} from "./companionRelayClient";

interface CompanionMailboxBridgePort {
  getDesktopMailboxCursor(): string | undefined;
  getOrCreateDesktopInstanceId(): string;
  getPairedDevice(): PairedCompanionDeviceRecord | undefined;
  listPendingShareAcks(deviceId: string): CompanionShareImportRecord[];
  markShareAcked(
    submissionId: string,
    acknowledgedAt: string,
  ): CompanionShareImportRecord;
}

interface CompanionShareIngressPort {
  importEnvelope(
    envelope: CompanionDesktopMailboxEnvelope,
    options?: { readonly signal: AbortSignal },
  ): ReturnType<CompanionShareIngress["importEnvelope"]>;
}

interface CompanionRelaySession {
  readonly credential: string;
  readonly relayOrigin: string;
}

export interface CompanionMailboxProcessorDependencies {
  readonly bridge: CompanionMailboxBridgePort;
  readonly clock: Clock;
  readonly ingress: CompanionShareIngressPort;
  readonly onStatusChange?: (
    deviceId: string,
    status: CompanionDeviceStatus,
  ) => void;
  readonly relay: CompanionRelayClient;
  readonly secretStore: Pick<ProviderSecretStore, "get">;
}

export type CompanionMailboxProcessorErrorCode =
  | "COMPANION.MAILBOX_CURSOR_DID_NOT_ADVANCE"
  | "COMPANION.MAILBOX_DEVICE_MISMATCH"
  | "COMPANION.MAILBOX_EMPTY_CONTINUATION"
  | "COMPANION.MAILBOX_IMPORT_RESULT_MISMATCH"
  | "COMPANION.MAILBOX_PENDING_ACK_INVALID"
  | "COMPANION.MAILBOX_RECIPIENT_MISMATCH";

export class CompanionMailboxProcessorError extends Error {
  constructor(
    readonly code: CompanionMailboxProcessorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompanionMailboxProcessorError";
  }
}

function shareImportedResult(
  record: CompanionShareImportRecord,
): CompanionShareImportedAckResult {
  if (!record.chatId || !record.messageId || record.state !== "imported") {
    throw new CompanionMailboxProcessorError(
      "COMPANION.MAILBOX_PENDING_ACK_INVALID",
      "Pending companion acknowledgement has no completed share import.",
    );
  }
  return {
    ...(record.attachmentId ? { attachmentId: record.attachmentId } : {}),
    chatId: record.chatId,
    messageId: record.messageId,
    submissionId: record.submissionId,
    type: "share.imported",
  };
}

function errorMessage(error: unknown): string {
  if (
    error instanceof ProviderError &&
    error.code === "PROVIDER.CREDENTIAL_REQUIRED"
  ) {
    return "手机 Companion 的连接凭据不可用，请重新配对。";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Companion mailbox protocol error.";
}

function isProtocolError(error: unknown): boolean {
  return (
    error instanceof CompanionMailboxProcessorError ||
    error instanceof CompanionShareIngressError ||
    error instanceof CompanionBridgePersistenceError ||
    (error instanceof ProviderError &&
      error.code === "PROVIDER.CREDENTIAL_REQUIRED") ||
    (error instanceof CompanionRelayClientError && error.kind === "protocol")
  );
}

export class CompanionMailboxProcessor {
  #active = false;
  #blocked = false;
  #controller: AbortController | undefined;
  #paused = false;
  #restartRequested = false;
  #shutdown = false;
  #task: Promise<void> | undefined;
  #waitingForRetryAfter = false;

  constructor(
    private readonly dependencies: CompanionMailboxProcessorDependencies,
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
      return;
    }
    this.restart();
  }

  restart(): void {
    if (this.#shutdown || this.#blocked || this.#paused) return;
    this.#active = true;
    if (!this.#task) {
      this.#launch();
      return;
    }
    this.#restartRequested = true;
    this.#controller?.abort();
  }

  reset(): void {
    if (this.#shutdown) return;
    this.#blocked = false;
    this.#paused = false;
    this.restart();
  }

  async pause(): Promise<void> {
    if (this.#shutdown) return;
    this.#paused = true;
    await this.stop();
  }

  resume(): void {
    if (this.#shutdown) return;
    this.#paused = false;
    this.start();
  }

  async stop(): Promise<void> {
    this.#active = false;
    this.#restartRequested = false;
    this.#controller?.abort();
    await this.#task;
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    this.#paused = true;
    await this.stop();
  }

  #launch(): void {
    if (
      !this.#active ||
      this.#blocked ||
      this.#paused ||
      this.#shutdown ||
      this.#task
    )
      return;
    const controller = new AbortController();
    this.#controller = controller;
    const task = this.#run(controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const protocolError = isProtocolError(error);
        if (protocolError) {
          this.#blocked = true;
          this.#restartRequested = false;
        }
        const paired = this.dependencies.bridge.getPairedDevice();
        if (!paired) return;
        this.#publishStatus(
          paired.device.id,
          protocolError
            ? {
                message: errorMessage(error),
                observedAt: this.dependencies.clock.now(),
                state: "protocol_error",
              }
            : {
                observedAt: this.dependencies.clock.now(),
                state: "offline",
              },
        );
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
    if (!paired) return;
    const desktopInstanceId =
      this.dependencies.bridge.getOrCreateDesktopInstanceId();
    const credential = await this.dependencies.secretStore.get(
      paired.credentialRef,
    );
    signal.throwIfAborted();

    const session = {
      credential,
      relayOrigin: paired.relayOrigin,
    };

    while (!signal.aborted) {
      try {
        await this.#pollMailbox(paired, desktopInstanceId, session, signal);
        return;
      } catch (error) {
        if (signal.aborted) throw error;
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
  }

  async #pollMailbox(
    paired: PairedCompanionDeviceRecord,
    desktopInstanceId: string,
    session: CompanionRelaySession,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#replayPendingAcks(paired, desktopInstanceId, session, signal);

    while (!signal.aborted) {
      const afterCursor = this.dependencies.bridge.getDesktopMailboxCursor();
      const page = await this.dependencies.relay.fetchDesktopMailbox({
        ...session,
        request: {
          ...(afterCursor === undefined ? {} : { afterCursor }),
          protocolVersion: COMPANION_PROTOCOL_VERSION,
          recipient: { desktopInstanceId, kind: "desktop" },
        },
        signal,
      });
      signal.throwIfAborted();
      this.#assertPageRecipient(
        page.recipient.desktopInstanceId,
        desktopInstanceId,
      );
      if (page.hasMore && page.envelopes.length === 0) {
        throw new CompanionMailboxProcessorError(
          "COMPANION.MAILBOX_EMPTY_CONTINUATION",
          "Companion Relay returned hasMore without a mailbox envelope.",
        );
      }
      this.#publishStatus(paired.device.id, {
        observedAt: this.dependencies.clock.now(),
        state: "online",
      });

      let expectedCursor = afterCursor;
      for (const envelope of page.envelopes) {
        this.#assertEnvelope(
          envelope,
          paired.device.id,
          desktopInstanceId,
          expectedCursor,
        );
        const result = await this.dependencies.ingress.importEnvelope(
          envelope,
          {
            signal,
          },
        );
        signal.throwIfAborted();
        if (result.submissionId !== envelope.event.share.submissionId) {
          throw new CompanionMailboxProcessorError(
            "COMPANION.MAILBOX_IMPORT_RESULT_MISMATCH",
            "Companion share import result does not match its submission.",
          );
        }
        const persistedCursor =
          this.dependencies.bridge.getDesktopMailboxCursor();
        if (persistedCursor !== envelope.cursor) {
          throw new CompanionMailboxProcessorError(
            "COMPANION.MAILBOX_CURSOR_DID_NOT_ADVANCE",
            "Desktop companion mailbox cursor did not advance after import.",
          );
        }
        await this.#acknowledge(
          paired,
          desktopInstanceId,
          envelope.id,
          envelope.cursor,
          result,
          session,
          signal,
        );
        expectedCursor = envelope.cursor;
      }
    }
  }

  async #replayPendingAcks(
    paired: PairedCompanionDeviceRecord,
    desktopInstanceId: string,
    session: CompanionRelaySession,
    signal: AbortSignal,
  ): Promise<void> {
    for (const record of this.dependencies.bridge.listPendingShareAcks(
      paired.device.id,
    )) {
      signal.throwIfAborted();
      if (record.deviceId !== paired.device.id) {
        throw new CompanionMailboxProcessorError(
          "COMPANION.MAILBOX_DEVICE_MISMATCH",
          "Pending companion acknowledgement belongs to another device.",
        );
      }
      await this.#acknowledge(
        paired,
        desktopInstanceId,
        record.envelopeId,
        record.cursor,
        shareImportedResult(record),
        session,
        signal,
      );
    }
  }

  async #acknowledge(
    paired: PairedCompanionDeviceRecord,
    desktopInstanceId: string,
    envelopeId: string,
    cursor: string,
    result: CompanionShareImportedAckResult,
    session: CompanionRelaySession,
    signal: AbortSignal,
  ): Promise<void> {
    const acknowledgedAt = this.dependencies.clock.now();
    const ack: CompanionDesktopMailboxAck = {
      acknowledgedAt,
      cursor,
      envelopeId,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      recipient: { desktopInstanceId, kind: "desktop" },
      result,
    };
    await this.dependencies.relay.acknowledgeDesktopMailbox({
      ...session,
      ack,
      signal,
    });
    signal.throwIfAborted();
    this.dependencies.bridge.markShareAcked(
      result.submissionId,
      acknowledgedAt,
    );
    this.#publishStatus(paired.device.id, {
      observedAt: acknowledgedAt,
      state: "online",
    });
  }

  #assertPageRecipient(actual: string, expected: string): void {
    if (actual === expected) return;
    throw new CompanionMailboxProcessorError(
      "COMPANION.MAILBOX_RECIPIENT_MISMATCH",
      "Companion mailbox page was addressed to another Desktop instance.",
    );
  }

  #assertEnvelope(
    envelope: CompanionDesktopMailboxEnvelope,
    deviceId: string,
    desktopInstanceId: string,
    expectedCursor: string | undefined,
  ): void {
    this.#assertPageRecipient(
      envelope.recipient.desktopInstanceId,
      desktopInstanceId,
    );
    if (envelope.event.deviceId !== deviceId) {
      throw new CompanionMailboxProcessorError(
        "COMPANION.MAILBOX_DEVICE_MISMATCH",
        "Companion mailbox envelope came from another Android device.",
      );
    }
    if (envelope.cursor === expectedCursor) {
      throw new CompanionMailboxProcessorError(
        "COMPANION.MAILBOX_CURSOR_DID_NOT_ADVANCE",
        "Companion mailbox envelope did not advance its opaque cursor.",
      );
    }
  }

  #publishStatus(deviceId: string, status: CompanionDeviceStatus): void {
    this.dependencies.onStatusChange?.(deviceId, status);
  }
}
