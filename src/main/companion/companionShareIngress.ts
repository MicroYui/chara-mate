import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type { StartRunRequest } from "../../shared/contracts/agent";
import type { Attachment, Chat, Message } from "../../shared/contracts/chat";
import type {
  CompanionDesktopMailboxEnvelope,
  CompanionShareImportedAckResult,
  CompanionSharePayload,
  CompanionShareUploadedEnvelope,
  CompanionUploadAsset,
} from "../../shared/contracts/companion";
import type { ArtifactReference } from "../../shared/contracts/run";
import type { Clock } from "../../shared/pure/clock";
import { CompanionDesktopMailboxEnvelopeSchema } from "../../shared/schemas/companion";
import { parseSchema } from "../../shared/schemas/validation";
import type { ChatPersistenceSnapshot } from "../chat/chatRepository";
import type {
  BindShareRun,
  ClaimShare,
  CompanionShareImportRecord,
  CompleteShareImport,
} from "./companionBridgeRepository";

interface CompanionBridgePort {
  bindOrRebindShareRun(input: BindShareRun): CompanionShareImportRecord;
  claimShare(input: ClaimShare): {
    readonly kind: "claimed" | "existing";
    readonly record: CompanionShareImportRecord;
  };
  completeShareImport(input: CompleteShareImport): CompanionShareImportRecord;
  getDesktopMailboxCursor(): string | undefined;
  getOrCreateDesktopInstanceId(): string;
  getShareImport(submissionId: string): CompanionShareImportRecord | undefined;
}

interface ChatRepositoryPort {
  getChat(chatId: string): Chat | undefined;
  getSnapshot(chatId: string): ChatPersistenceSnapshot | null;
  insertAttachment(attachment: Attachment): Attachment;
  isProvisionalChat(chatId: string): boolean;
  listRunMessages(runId: string): Message[];
}

interface ChatServicePort {
  createProvisional(input: { readonly initialMessage?: string }): Chat;
  discardProvisional(chatId: string): boolean;
  establishProvisional(chatId: string): Chat;
  restore(input: { readonly chatId: string }): Chat;
}

interface RunRepositoryPort {
  getRun(runId: string): { readonly chatId: string } | undefined;
}

interface AgentRuntimePort {
  start(
    request: StartRunRequest,
    options: {
      readonly onRunAllocated: (runId: string) => void;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown>;
}

interface ArtifactStorePort {
  storeBufferWithStableId(
    scopeId: string,
    artifactId: string,
    displayName: string,
    content: Buffer,
    mediaType: string,
    kind: ArtifactReference["kind"],
  ): Promise<ArtifactReference>;
}

interface ProviderPort {
  getDefaultChatProfileId(): string;
}

export interface CompanionShareIngressDependencies {
  readonly agent: AgentRuntimePort;
  readonly artifacts: ArtifactStorePort;
  readonly bridge: CompanionBridgePort;
  readonly chatRepository: ChatRepositoryPort;
  readonly chats: ChatServicePort;
  readonly clock: Clock;
  readonly providers: ProviderPort;
  readonly readRelayAsset: (
    asset: CompanionUploadAsset,
    signal?: AbortSignal,
  ) => Promise<Buffer>;
  readonly runs: RunRepositoryPort;
}

export type CompanionShareIngressErrorCode =
  | "COMPANION.ATTACHMENT_HASH_MISMATCH"
  | "COMPANION.ATTACHMENT_LENGTH_MISMATCH"
  | "COMPANION.ATTACHMENT_REFERENCE_INVALID"
  | "COMPANION.ATTACHMENT_UTF8_INVALID"
  | "COMPANION.CHAT_NOT_FOUND"
  | "COMPANION.RECIPIENT_MISMATCH"
  | "COMPANION.SHARE_EXPIRED"
  | "COMPANION.SHARE_EVENT_REQUIRED"
  | "COMPANION.SHARE_RECOVERY_FAILED"
  | "COMPANION.SHARE_TARGET_MISMATCH";

export class CompanionShareIngressError extends Error {
  constructor(
    readonly code: CompanionShareIngressErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompanionShareIngressError";
  }
}

interface PreparedShare {
  readonly artifact?: ArtifactReference;
  readonly content: string;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Companion share payload is not canonical JSON");
}

function payloadSha256(payload: CompanionSharePayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function isShareEnvelope(
  envelope: CompanionDesktopMailboxEnvelope,
): envelope is CompanionShareUploadedEnvelope {
  return envelope.event.type === "companion.share.uploaded";
}

function inflightIdentity(envelope: CompanionShareUploadedEnvelope): string {
  const share = envelope.event.share;
  return canonicalJson({
    cursor: envelope.cursor,
    deviceId: envelope.event.deviceId,
    envelopeId: envelope.id,
    expiresAt: envelope.expiresAt,
    payloadSha256: payloadSha256(share),
    recipientDesktopInstanceId: envelope.recipient.desktopInstanceId,
    ...(share.kind === "attachment"
      ? { relayAssetId: share.attachment.relayAssetId }
      : {}),
    sourceKind: share.kind,
    submissionId: share.submissionId,
  });
}

function completedUserMessage(
  messages: readonly Message[],
): Message | undefined {
  return messages.find(
    ({ role, status }) => role === "user" && status === "completed",
  );
}

export class CompanionShareIngress {
  readonly #inflight = new Map<
    string,
    Promise<CompanionShareImportedAckResult>
  >();

  constructor(
    private readonly dependencies: CompanionShareIngressDependencies,
  ) {}

  async importEnvelope(
    input: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CompanionShareImportedAckResult> {
    const envelope = parseSchema(CompanionDesktopMailboxEnvelopeSchema, input);
    if (!isShareEnvelope(envelope)) {
      throw this.#error(
        "COMPANION.SHARE_EVENT_REQUIRED",
        "Companion share ingress only accepts share upload envelopes.",
      );
    }
    const identity = inflightIdentity(envelope);
    const inflight = this.#inflight.get(identity);
    if (inflight) return inflight;

    const task = this.#importEnvelope(envelope, options.signal);
    this.#inflight.set(identity, task);
    try {
      return await task;
    } finally {
      if (this.#inflight.get(identity) === task) {
        this.#inflight.delete(identity);
      }
    }
  }

  async #importEnvelope(
    envelope: CompanionShareUploadedEnvelope,
    signal?: AbortSignal,
  ): Promise<CompanionShareImportedAckResult> {
    signal?.throwIfAborted();
    const desktopInstanceId =
      this.dependencies.bridge.getOrCreateDesktopInstanceId();
    if (envelope.recipient.desktopInstanceId !== desktopInstanceId) {
      throw this.#error(
        "COMPANION.RECIPIENT_MISMATCH",
        "Companion share was addressed to a different Desktop instance.",
      );
    }

    const share = envelope.event.share;
    const existingBeforeClaim = this.dependencies.bridge.getShareImport(
      share.submissionId,
    );
    const claimedAt = this.dependencies.clock.now();
    if (!existingBeforeClaim) {
      this.#assertNotExpired(envelope, claimedAt);
    }
    const predecessorCursor = existingBeforeClaim
      ? existingBeforeClaim.predecessorCursor
      : this.dependencies.bridge.getDesktopMailboxCursor();
    const claimed = this.dependencies.bridge.claimShare({
      claimedAt,
      cursor: envelope.cursor,
      deviceId: envelope.event.deviceId,
      envelopeId: envelope.id,
      expiresAt: envelope.expiresAt,
      payloadSha256: payloadSha256(share),
      ...(predecessorCursor === undefined ? {} : { predecessorCursor }),
      ...(share.kind === "attachment"
        ? {
            relayAssetId: share.attachment.relayAssetId,
            sourceKind: "attachment" as const,
          }
        : { sourceKind: "text" as const }),
      submissionId: share.submissionId,
    });

    if (claimed.record.state === "imported") {
      return this.#finishImported(claimed.record);
    }

    const recovered = await this.#recoverCompletedMessage(
      envelope,
      claimed.record,
      signal,
    );
    if (recovered) return recovered;

    const prepared = await this.#prepareShare(share, signal);
    signal?.throwIfAborted();
    const chat = this.#resolveTargetChat(
      share,
      claimed.record,
      prepared.content,
    );
    signal?.throwIfAborted();

    try {
      const request: StartRunRequest = {
        attachments: prepared.artifact ? [prepared.artifact] : [],
        chatId: chat.id,
        content: prepared.content,
        execution: { mode: "chat" },
        providerProfileId:
          this.dependencies.providers.getDefaultChatProfileId(),
        requestedAt: this.dependencies.clock.now(),
      };
      signal?.throwIfAborted();
      await this.dependencies.agent.start(request, {
        onRunAllocated: (runId) => {
          this.dependencies.bridge.bindOrRebindShareRun({
            runId,
            submissionId: share.submissionId,
            updatedAt: this.dependencies.clock.now(),
          });
        },
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
    } catch (error) {
      const afterFailure = this.dependencies.bridge.getShareImport(
        share.submissionId,
      );
      if (signal?.aborted) {
        if (!afterFailure?.runId) {
          this.#discardPendingNewChat(share, chat.id);
        }
        signal.throwIfAborted();
      }
      const recoveredAfterFailure = afterFailure
        ? await this.#recoverCompletedMessage(envelope, afterFailure, signal)
        : undefined;
      if (recoveredAfterFailure) return recoveredAfterFailure;
      this.#discardPendingNewChat(share, chat.id);
      throw error;
    }

    const current = this.dependencies.bridge.getShareImport(share.submissionId);
    const completed = current
      ? await this.#recoverCompletedMessage(envelope, current, signal)
      : undefined;
    if (!completed) {
      this.#discardPendingNewChat(share, chat.id);
      throw this.#error(
        "COMPANION.SHARE_RECOVERY_FAILED",
        "Companion Run did not persist its completed User Message.",
      );
    }
    return completed;
  }

  async #recoverCompletedMessage(
    envelope: CompanionShareUploadedEnvelope,
    record: CompanionShareImportRecord,
    signal?: AbortSignal,
  ): Promise<CompanionShareImportedAckResult | undefined> {
    signal?.throwIfAborted();
    if (record.state === "imported") return this.#finishImported(record);
    if (!record.runId) return undefined;

    const message = completedUserMessage(
      this.dependencies.chatRepository.listRunMessages(record.runId),
    );
    if (!message) return undefined;
    this.#assertTarget(envelope.event.share, message.chatId);

    signal?.throwIfAborted();
    if (this.dependencies.chatRepository.isProvisionalChat(message.chatId)) {
      this.dependencies.chats.establishProvisional(message.chatId);
    }
    const attachmentId = await this.#ensureAttachment(
      envelope.event.share,
      message,
      signal,
    );
    signal?.throwIfAborted();
    const completed = this.dependencies.bridge.completeShareImport({
      ...(attachmentId ? { attachmentId } : {}),
      chatId: message.chatId,
      importedAt: this.dependencies.clock.now(),
      messageId: message.id,
      submissionId: envelope.event.share.submissionId,
    });
    return this.#finishImported(completed);
  }

  #resolveTargetChat(
    share: CompanionSharePayload,
    record: CompanionShareImportRecord,
    initialMessage: string,
  ): Chat {
    if (record.runId) {
      const boundRun = this.dependencies.runs.getRun(record.runId);
      if (boundRun) {
        if (share.target.kind === "existing_chat") {
          this.#assertTarget(share, boundRun.chatId);
          return this.#restore(this.#requireChat(boundRun.chatId));
        }
        if (
          this.dependencies.chatRepository.isProvisionalChat(boundRun.chatId)
        ) {
          this.dependencies.chats.discardProvisional(boundRun.chatId);
        } else if (this.dependencies.chatRepository.getChat(boundRun.chatId)) {
          throw this.#error(
            "COMPANION.SHARE_TARGET_MISMATCH",
            "A pending new-chat share is bound to an established Chat.",
          );
        }
        return this.dependencies.chats.createProvisional({ initialMessage });
      }
    }

    if (share.target.kind === "existing_chat") {
      return this.#restore(this.#requireChat(share.target.chatId));
    }
    return this.dependencies.chats.createProvisional({ initialMessage });
  }

  #requireChat(chatId: string): Chat {
    const chat = this.dependencies.chatRepository.getChat(chatId);
    if (!chat) {
      throw this.#error(
        "COMPANION.CHAT_NOT_FOUND",
        `Companion share target Chat ${chatId} does not exist.`,
      );
    }
    return chat;
  }

  #restore(chat: Chat): Chat {
    return chat.status === "archived"
      ? this.dependencies.chats.restore({ chatId: chat.id })
      : chat;
  }

  #assertTarget(share: CompanionSharePayload, chatId: string): void {
    if (
      share.target.kind === "existing_chat" &&
      share.target.chatId !== chatId
    ) {
      throw this.#error(
        "COMPANION.SHARE_TARGET_MISMATCH",
        "Companion share Run does not belong to its exact target Chat.",
      );
    }
  }

  #discardPendingNewChat(share: CompanionSharePayload, chatId: string): void {
    if (
      share.target.kind === "new_chat" &&
      this.dependencies.chatRepository.isProvisionalChat(chatId)
    ) {
      this.dependencies.chats.discardProvisional(chatId);
    }
  }

  async #prepareShare(
    share: CompanionSharePayload,
    signal?: AbortSignal,
  ): Promise<PreparedShare> {
    signal?.throwIfAborted();
    if (share.kind === "text") {
      return { content: share.text };
    }
    const bytes = await this.dependencies.readRelayAsset(
      share.attachment,
      signal,
    );
    signal?.throwIfAborted();
    this.#validateBytes(share.attachment, bytes);
    const content = this.#attachmentContent(share, bytes);
    const kind = share.attachment.contentKind === "image" ? "image" : "file";
    signal?.throwIfAborted();
    const artifact = await this.dependencies.artifacts.storeBufferWithStableId(
      share.submissionId,
      share.submissionId,
      share.attachment.displayName,
      bytes,
      share.attachment.mediaType,
      kind,
    );
    signal?.throwIfAborted();
    this.#validateArtifact(share, artifact, kind);
    return { artifact, content };
  }

  async #ensureAttachment(
    share: CompanionSharePayload,
    message: Message,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    signal?.throwIfAborted();
    if (share.kind === "text") return undefined;
    const snapshot = this.dependencies.chatRepository.getSnapshot(
      message.chatId,
    );
    const existing = snapshot?.attachments.find(
      ({ id, messageId }) =>
        id === share.submissionId && messageId === message.id,
    );
    if (existing) {
      this.#validatePersistedAttachment(share, existing);
      return existing.id;
    }

    const prepared = await this.#prepareShare(share, signal);
    const artifact = prepared.artifact;
    if (!artifact) {
      throw this.#error(
        "COMPANION.ATTACHMENT_REFERENCE_INVALID",
        "Companion attachment preparation returned no managed artifact.",
      );
    }
    signal?.throwIfAborted();
    const attachment = this.dependencies.chatRepository.insertAttachment({
      ...(artifact.byteLength === undefined
        ? {}
        : { byteLength: artifact.byteLength }),
      chatId: message.chatId,
      createdAt: message.createdAt,
      displayName: artifact.displayName,
      id: artifact.artifactId,
      kind: artifact.kind === "image" ? "image" : "file",
      ...(artifact.mediaType === undefined
        ? {}
        : { mediaType: artifact.mediaType }),
      messageId: message.id,
      ...(artifact.sha256 === undefined ? {} : { sha256: artifact.sha256 }),
      storageKey: artifact.storageKey,
    });
    return attachment.id;
  }

  #attachmentContent(
    share: Extract<CompanionSharePayload, { kind: "attachment" }>,
    bytes: Buffer,
  ): string {
    const caption = share.caption?.trim();
    if (
      share.attachment.contentKind !== "text" &&
      share.attachment.contentKind !== "markdown"
    ) {
      return caption || "请处理这个附件。";
    }
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw this.#error(
        "COMPANION.ATTACHMENT_UTF8_INVALID",
        "Companion text attachment is not valid UTF-8.",
      );
    }
    const parts = [caption, body].filter((part): part is string =>
      Boolean(part && /\S/u.test(part)),
    );
    return parts.length > 0 ? parts.join("\n\n") : "请处理这个附件。";
  }

  #validateBytes(asset: CompanionUploadAsset, bytes: Buffer): void {
    if (bytes.byteLength !== asset.byteLength) {
      throw this.#error(
        "COMPANION.ATTACHMENT_LENGTH_MISMATCH",
        "Companion attachment byte length does not match its upload receipt.",
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      throw this.#error(
        "COMPANION.ATTACHMENT_HASH_MISMATCH",
        "Companion attachment digest does not match its upload receipt.",
      );
    }
  }

  #assertNotExpired(
    envelope: CompanionShareUploadedEnvelope,
    now: string,
  ): void {
    const expiration =
      envelope.event.share.kind === "attachment"
        ? Math.min(
            Date.parse(envelope.expiresAt),
            Date.parse(envelope.event.share.attachment.expiresAt),
          )
        : Date.parse(envelope.expiresAt);
    if (Date.parse(now) >= expiration) {
      throw this.#error(
        "COMPANION.SHARE_EXPIRED",
        "Companion share envelope or attachment has expired.",
      );
    }
  }

  #validateArtifact(
    share: Extract<CompanionSharePayload, { kind: "attachment" }>,
    artifact: ArtifactReference,
    expectedKind: "file" | "image",
  ): void {
    if (
      artifact.artifactId !== share.submissionId ||
      artifact.kind !== expectedKind ||
      artifact.byteLength !== share.attachment.byteLength ||
      artifact.sha256 !== share.attachment.sha256 ||
      artifact.mediaType !== share.attachment.mediaType ||
      artifact.displayName !== share.attachment.displayName
    ) {
      throw this.#error(
        "COMPANION.ATTACHMENT_REFERENCE_INVALID",
        "Managed Companion artifact does not match its stable upload identity.",
      );
    }
  }

  #validatePersistedAttachment(
    share: Extract<CompanionSharePayload, { kind: "attachment" }>,
    attachment: Attachment,
  ): void {
    const expectedKind =
      share.attachment.contentKind === "image" ? "image" : "file";
    if (
      attachment.kind !== expectedKind ||
      attachment.byteLength !== share.attachment.byteLength ||
      attachment.sha256 !== share.attachment.sha256 ||
      attachment.mediaType !== share.attachment.mediaType ||
      attachment.displayName !== share.attachment.displayName
    ) {
      throw this.#error(
        "COMPANION.ATTACHMENT_REFERENCE_INVALID",
        "Persisted Companion attachment does not match its upload identity.",
      );
    }
  }

  #finishImported(
    record: CompanionShareImportRecord,
  ): CompanionShareImportedAckResult {
    if (!record.chatId || !record.messageId) {
      throw this.#error(
        "COMPANION.SHARE_RECOVERY_FAILED",
        "Imported Companion share is missing its Message result.",
      );
    }
    if (this.dependencies.chatRepository.isProvisionalChat(record.chatId)) {
      this.dependencies.chats.establishProvisional(record.chatId);
    }
    return {
      ...(record.attachmentId ? { attachmentId: record.attachmentId } : {}),
      chatId: record.chatId,
      messageId: record.messageId,
      submissionId: record.submissionId,
      type: "share.imported",
    };
  }

  #error(
    code: CompanionShareIngressErrorCode,
    message: string,
  ): CompanionShareIngressError {
    return new CompanionShareIngressError(code, message);
  }
}
