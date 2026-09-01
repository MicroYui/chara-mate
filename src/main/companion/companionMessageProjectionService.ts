import { isDeepStrictEqual } from "node:util";

import {
  COMPANION_PROTOCOL_VERSION,
  type CompanionAndroidMailboxEnqueueReceipt,
  type CompanionAndroidMailboxEnqueueRequest,
  type CompanionDeviceStatus,
} from "../../shared/contracts/companion";
import type { Message } from "../../shared/contracts/chat";
import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { Run } from "../../shared/contracts/run";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { CompanionAndroidMailboxEnqueueReceiptSchema } from "../../shared/schemas/companion";
import { parseSchema } from "../../shared/schemas/validation";
import type { RunRepository } from "../agent/runRepository";
import type { ChatRepository } from "../chat/chatRepository";
import { ProviderError } from "../providers/providerError";
import type { ProviderSecretStore } from "../providers/secretStore";
import type {
  CompanionBridgeRepository,
  CompanionMessageProjection,
  CompanionShareImportRecord,
  PairedCompanionDeviceRecord,
} from "./companionBridgeRepository";
import {
  CompanionRelayClientError,
  companionRelayRetryAfterMs,
  type CompanionRelayClient,
  waitForCompanionRetryAfter,
} from "./companionRelayClient";

interface CompanionMessageProjectionBridgePort {
  getMessageProjection(
    messageId: string,
  ): CompanionMessageProjection | undefined;
  getPairedDevice(): PairedCompanionDeviceRecord | undefined;
  getShareImportByRunId(runId: string): CompanionShareImportRecord | undefined;
  listCompletedShareRunsForProjectionRecovery(): CompanionShareImportRecord[];
  listPendingAndroidMessageProjections(): CompanionMessageProjection[];
  markMessageProjectionAcknowledged(
    messageId: string,
    acknowledgedAt: string,
  ): CompanionMessageProjection;
  markMessageProjectionFailed(
    messageId: string,
    failureMessage: string,
    failedAt: string,
  ): CompanionMessageProjection;
  markMessageProjectionProjected(
    messageId: string,
    projectedAt: string,
  ): CompanionMessageProjection;
  markMessageProjectionSubmitted(
    messageId: string,
    submittedAt: string,
  ): CompanionMessageProjection;
  reserveMessageProjection(
    input: Parameters<CompanionBridgeRepository["reserveMessageProjection"]>[0],
  ): ReturnType<CompanionBridgeRepository["reserveMessageProjection"]>;
}

interface CompanionMessageProjectionChatPort {
  getMessage(messageId: string): ReturnType<ChatRepository["getMessage"]>;
  listRunMessages(runId: string): ReturnType<ChatRepository["listRunMessages"]>;
}

interface CompanionMessageProjectionRunPort {
  getRun(runId: string): ReturnType<RunRepository["getRun"]>;
}

export interface CompanionMessageProjectionServiceDependencies {
  readonly bridge: CompanionMessageProjectionBridgePort;
  readonly chats: CompanionMessageProjectionChatPort;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly onBackgroundError?: (error: unknown) => void;
  readonly onStatusChange?: (
    deviceId: string,
    status: CompanionDeviceStatus,
  ) => void;
  readonly relay: Pick<CompanionRelayClient, "enqueueAndroidMailbox">;
  readonly runs: CompanionMessageProjectionRunPort;
  readonly secretStore: Pick<ProviderSecretStore, "get">;
}

export interface CompanionMessageProjectionSelection {
  readonly acceptedBySelectedSurface: boolean;
  readonly kind: "existing" | "reserved";
  readonly projection: CompanionMessageProjection;
  readonly shouldProjectDesktop: boolean;
  readonly state: CompanionMessageProjection["state"];
  readonly surface: CompanionMessageProjection["surface"];
}

class CompanionMessageProjectionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionMessageProjectionProtocolError";
  }
}

type PendingProjectionResult = "continue" | "stop";

function canReceiveAndroidNotification(
  paired: PairedCompanionDeviceRecord,
): boolean {
  return (
    paired.device.notificationPermission === "granted" &&
    paired.device.notificationsEnabled &&
    paired.device.status.state !== "protocol_error"
  );
}

function selectionResult(
  result: ReturnType<CompanionBridgeRepository["reserveMessageProjection"]>,
): CompanionMessageProjectionSelection {
  const { projection } = result;
  return {
    acceptedBySelectedSurface:
      projection.surface === "android_notification"
        ? ["selected", "submitted", "acknowledged"].includes(projection.state)
        : projection.state === "projected",
    kind: result.kind,
    projection,
    shouldProjectDesktop:
      projection.surface === "desktop_bubble" &&
      projection.state === "selected",
    state: projection.state,
    surface: projection.surface,
  };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

export class CompanionMessageProjectionService {
  #active = false;
  #blocked = false;
  #controller: AbortController | undefined;
  #paused = false;
  #restartRequested = false;
  #shutdown = false;
  #task: Promise<void> | undefined;
  #waitingForRetryAfter = false;

  constructor(
    private readonly dependencies: CompanionMessageProjectionServiceDependencies,
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
    this.#restart();
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    this.#paused = true;
    await this.#stop();
  }

  observeRun(
    envelope: RunEventEnvelope,
  ): CompanionMessageProjectionSelection | undefined {
    if (envelope.event.type !== "run.completed") return undefined;
    const share = this.dependencies.bridge.getShareImportByRunId(
      envelope.event.run.id,
    );
    if (!share) return undefined;
    try {
      return this.#selectCompletedShareRun(share);
    } catch (error) {
      this.#report(error);
      return undefined;
    }
  }

  selectImportantMoment(
    messageId: string,
    preferAndroid: boolean,
  ): CompanionMessageProjectionSelection {
    const existing = this.dependencies.bridge.getMessageProjection(messageId);
    if (existing) {
      const selected = selectionResult({
        kind: "existing",
        projection: existing,
      });
      this.#wakePendingAndroid(selected.projection);
      return selected;
    }

    const message = this.#requireCompletedAssistantMessage(messageId);
    const paired = preferAndroid
      ? this.dependencies.bridge.getPairedDevice()
      : undefined;
    if (paired && canReceiveAndroidNotification(paired)) {
      this.#requireCompletedRun(message);
      const result = this.dependencies.bridge.reserveMessageProjection({
        deviceId: paired.device.id,
        envelopeId: this.dependencies.idGenerator.generate(),
        messageId: message.id,
        selectedAt: this.dependencies.clock.now(),
        surface: "android_notification",
      });
      const selected = selectionResult(result);
      this.wake();
      return selected;
    }

    return selectionResult(
      this.dependencies.bridge.reserveMessageProjection({
        messageId: message.id,
        selectedAt: this.dependencies.clock.now(),
        surface: "desktop_bubble",
      }),
    );
  }

  markDesktopProjected(messageId: string): CompanionMessageProjection {
    return this.dependencies.bridge.markMessageProjectionProjected(
      messageId,
      this.dependencies.clock.now(),
    );
  }

  markDesktopFailed(
    messageId: string,
    failureMessage: string,
  ): CompanionMessageProjection {
    return this.dependencies.bridge.markMessageProjectionFailed(
      messageId,
      failureMessage,
      this.dependencies.clock.now(),
    );
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
        this.#blocked = true;
        this.#restartRequested = false;
        this.#report(error);
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
    this.#recoverCompletedShareRuns();
    const pending =
      this.dependencies.bridge.listPendingAndroidMessageProjections();
    for (const projection of pending) {
      signal.throwIfAborted();
      if (
        (await this.#processPendingProjection(projection, signal)) === "stop"
      ) {
        return;
      }
    }
  }

  #recoverCompletedShareRuns(): void {
    for (const share of this.dependencies.bridge.listCompletedShareRunsForProjectionRecovery()) {
      try {
        this.#selectCompletedShareRun(share, false);
      } catch (error) {
        this.#report(error);
      }
    }
  }

  #selectCompletedShareRun(
    share: CompanionShareImportRecord,
    wake = true,
  ): CompanionMessageProjectionSelection | undefined {
    if (!share.runId) return undefined;
    const message = this.#latestCompletedAssistantMessage(share.runId);
    if (!message) return undefined;
    const existing = this.dependencies.bridge.getMessageProjection(message.id);
    if (existing) {
      const selected = selectionResult({
        kind: "existing",
        projection: existing,
      });
      if (wake) this.#wakePendingAndroid(selected.projection);
      return selected;
    }
    const paired = this.dependencies.bridge.getPairedDevice();
    if (
      !paired ||
      paired.device.id !== share.deviceId ||
      !canReceiveAndroidNotification(paired)
    ) {
      return undefined;
    }
    this.#requireCompletedRun(message);
    const result = this.dependencies.bridge.reserveMessageProjection({
      deviceId: paired.device.id,
      envelopeId: this.dependencies.idGenerator.generate(),
      messageId: message.id,
      selectedAt: this.dependencies.clock.now(),
      surface: "android_notification",
    });
    const selected = selectionResult(result);
    if (wake) this.wake();
    return selected;
  }

  async #processPendingProjection(
    initial: CompanionMessageProjection,
    signal: AbortSignal,
  ): Promise<PendingProjectionResult> {
    if (
      initial.surface !== "android_notification" ||
      !initial.deviceId ||
      !initial.envelopeId
    ) {
      throw new CompanionMessageProjectionProtocolError(
        "Pending Android projection has no frozen delivery identity.",
      );
    }
    const paired = this.dependencies.bridge.getPairedDevice();
    if (!paired || paired.device.id !== initial.deviceId) {
      this.dependencies.bridge.markMessageProjectionFailed(
        initial.messageId,
        "Android companion target is no longer paired.",
        this.dependencies.clock.now(),
      );
      return "continue";
    }
    if (!canReceiveAndroidNotification(paired)) {
      return "continue";
    }

    let request: CompanionAndroidMailboxEnqueueRequest;
    try {
      request = this.#notificationRequest(initial, paired);
    } catch (error) {
      this.dependencies.bridge.markMessageProjectionFailed(
        initial.messageId,
        "Assistant message is unavailable for Android notification projection.",
        this.dependencies.clock.now(),
      );
      this.#report(error);
      return "continue";
    }

    let credential: string;
    try {
      credential = await this.dependencies.secretStore.get(
        paired.credentialRef,
      );
      signal.throwIfAborted();
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      this.#report(error);
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER.CREDENTIAL_REQUIRED" &&
        !error.retryable
      ) {
        const failedAt = this.dependencies.clock.now();
        this.dependencies.bridge.markMessageProjectionFailed(
          initial.messageId,
          "Android companion credential is unavailable.",
          failedAt,
        );
        this.#blocked = true;
        this.#restartRequested = false;
        this.#publishStatus(initial.deviceId, {
          message: "手机 Companion 的连接凭据不可用，请重新配对。",
          observedAt: failedAt,
          state: "protocol_error",
        });
        return "stop";
      }
      return "stop";
    }

    if (initial.state === "selected") {
      this.dependencies.bridge.markMessageProjectionSubmitted(
        initial.messageId,
        this.dependencies.clock.now(),
      );
    }

    while (!signal.aborted) {
      try {
        const receipt = await this.dependencies.relay.enqueueAndroidMailbox({
          credential,
          relayOrigin: paired.relayOrigin,
          request,
          signal,
        });
        signal.throwIfAborted();
        this.#assertReceipt(request, receipt);
        const acknowledgedAt = this.dependencies.clock.now();
        this.dependencies.bridge.markMessageProjectionAcknowledged(
          initial.messageId,
          acknowledgedAt,
        );
        this.#publishStatus(initial.deviceId, {
          observedAt: acknowledgedAt,
          state: "online",
        });
        return "continue";
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        if (
          error instanceof CompanionMessageProjectionProtocolError ||
          (error instanceof CompanionRelayClientError &&
            error.kind === "protocol")
        ) {
          this.dependencies.bridge.markMessageProjectionFailed(
            initial.messageId,
            "Companion Relay rejected the Android notification envelope.",
            this.dependencies.clock.now(),
          );
          this.#blocked = true;
          this.#restartRequested = false;
          this.#publishStatus(initial.deviceId, {
            message: this.#protocolErrorMessage(error),
            observedAt: this.dependencies.clock.now(),
            state: "protocol_error",
          });
          this.#report(error);
          return "stop";
        }
        this.#publishStatus(initial.deviceId, {
          observedAt: this.dependencies.clock.now(),
          state: "offline",
        });
        const retryAfterMs = companionRelayRetryAfterMs(error);
        if (retryAfterMs !== undefined) {
          this.#waitingForRetryAfter = true;
          try {
            await waitForCompanionRetryAfter(retryAfterMs, signal);
          } finally {
            this.#waitingForRetryAfter = false;
          }
          continue;
        }
        this.#report(error);
        return "stop";
      }
    }
    signal.throwIfAborted();
    return "stop";
  }

  #notificationRequest(
    projection: CompanionMessageProjection,
    paired: PairedCompanionDeviceRecord,
  ): CompanionAndroidMailboxEnqueueRequest {
    const message = this.#requireCompletedAssistantMessage(
      projection.messageId,
    );
    const run = this.#requireCompletedRun(message);
    if (
      message.chatId !== run.chatId ||
      projection.deviceId !== paired.device.id ||
      !projection.envelopeId
    ) {
      throw new CompanionMessageProjectionProtocolError(
        "Android notification projection identity is inconsistent.",
      );
    }
    return {
      envelopeId: projection.envelopeId,
      event: {
        deviceId: paired.device.id,
        notification: {
          body: message.content,
          chatId: message.chatId,
          messageCreatedAt: message.createdAt,
          messageId: message.id,
          role: "assistant",
          status: "completed",
          title: run.persona.displayName,
        },
        type: "companion.notification.created",
      },
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      recipient: { deviceId: paired.device.id, kind: "android" },
    };
  }

  #assertReceipt(
    request: CompanionAndroidMailboxEnqueueRequest,
    input: CompanionAndroidMailboxEnqueueReceipt,
  ): void {
    let receipt: CompanionAndroidMailboxEnqueueReceipt;
    try {
      receipt = parseSchema(CompanionAndroidMailboxEnqueueReceiptSchema, input);
    } catch {
      throw new CompanionMessageProjectionProtocolError(
        "Companion Relay returned an invalid Android mailbox receipt.",
      );
    }
    if (
      receipt.envelope.id !== request.envelopeId ||
      !isDeepStrictEqual(receipt.envelope.recipient, request.recipient) ||
      !isDeepStrictEqual(receipt.envelope.event, request.event)
    ) {
      throw new CompanionMessageProjectionProtocolError(
        "Companion Relay returned a receipt for another Android mailbox event.",
      );
    }
  }

  #latestCompletedAssistantMessage(runId: string): Message | undefined {
    const messages = this.dependencies.chats.listRunMessages(runId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message?.role === "assistant" &&
        message.status === "completed" &&
        message.content.trim()
      ) {
        return message;
      }
    }
    return undefined;
  }

  #wakePendingAndroid(projection: CompanionMessageProjection): void {
    if (
      projection.surface === "android_notification" &&
      (projection.state === "selected" || projection.state === "submitted")
    ) {
      this.wake();
    }
  }

  #requireCompletedAssistantMessage(messageId: string): Message {
    const message = this.dependencies.chats.getMessage(messageId);
    if (
      !message ||
      message.role !== "assistant" ||
      message.status !== "completed" ||
      !message.content.trim()
    ) {
      throw new Error(
        "Companion projection requires a completed Assistant Message.",
      );
    }
    return message;
  }

  #requireCompletedRun(message: Message): Run {
    const run = message.runId
      ? this.dependencies.runs.getRun(message.runId)
      : undefined;
    if (!run || run.status !== "completed" || run.chatId !== message.chatId) {
      throw new Error(
        "Android notification requires its completed Run snapshot.",
      );
    }
    return run;
  }

  #report(error: unknown): void {
    this.dependencies.onBackgroundError?.(error);
  }

  #protocolErrorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim()
      ? error.message
      : "Companion notification protocol error.";
  }

  #publishStatus(deviceId: string, status: CompanionDeviceStatus): void {
    this.dependencies.onStatusChange?.(deviceId, status);
  }
}
