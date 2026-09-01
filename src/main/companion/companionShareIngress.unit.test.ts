import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { StartRunRequest } from "../../shared/contracts/agent";
import type { Attachment, Chat, Message } from "../../shared/contracts/chat";
import type {
  CompanionDesktopMailboxEnvelope,
  CompanionSharePayload,
  CompanionUploadAsset,
} from "../../shared/contracts/companion";
import type { ArtifactReference } from "../../shared/contracts/run";
import type {
  ClaimShare,
  CompanionShareImportRecord,
  CompleteShareImport,
} from "./companionBridgeRepository";
import {
  CompanionShareIngress,
  CompanionShareIngressError,
  type CompanionShareIngressDependencies,
} from "./companionShareIngress";

const IDS = {
  asset: "50000000-0000-4000-8000-000000000005",
  chat: "60000000-0000-4000-8000-000000000006",
  desktop: "10000000-0000-4000-8000-000000000001",
  device: "20000000-0000-4000-8000-000000000002",
  envelope: "40000000-0000-4000-8000-000000000004",
  message: "80000000-0000-4000-8000-000000000008",
  oldChat: "a0000000-0000-4000-8000-00000000000a",
  oldRun: "b0000000-0000-4000-8000-00000000000b",
  profile: "90000000-0000-4000-8000-000000000009",
  run: "70000000-0000-4000-8000-000000000007",
  submission: "30000000-0000-4000-8000-000000000003",
} as const;

const NOW = "2026-09-01T07:00:00.000Z";
const EXPIRES_AT = "2026-09-01T08:00:00.000Z";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function textEnvelope(
  target: CompanionSharePayload["target"] = { kind: "new_chat" },
): CompanionDesktopMailboxEnvelope {
  return {
    createdAt: NOW,
    cursor: "cursor-1",
    event: {
      deviceId: IDS.device,
      share: {
        kind: "text",
        mediaType: "text/plain",
        submissionId: IDS.submission,
        target,
        text: "分享结束了",
      },
      type: "companion.share.uploaded",
    },
    expiresAt: EXPIRES_AT,
    id: IDS.envelope,
    protocolVersion: 1,
    recipient: { desktopInstanceId: IDS.desktop, kind: "desktop" },
  };
}

function attachmentEnvelope(
  bytes: Buffer,
  options: {
    readonly caption?: string;
    readonly contentKind?: CompanionUploadAsset["contentKind"];
    readonly displayName?: string;
    readonly assetExpiresAt?: string;
    readonly mediaType?: string;
    readonly sha256?: string;
    readonly byteLength?: number;
    readonly target?: CompanionSharePayload["target"];
  } = {},
): CompanionDesktopMailboxEnvelope {
  return {
    createdAt: NOW,
    cursor: "cursor-1",
    event: {
      deviceId: IDS.device,
      share: {
        attachment: {
          byteLength: options.byteLength ?? bytes.byteLength,
          contentKind: options.contentKind ?? "image",
          displayName: options.displayName ?? "sunset.png",
          expiresAt: options.assetExpiresAt ?? EXPIRES_AT,
          mediaType: options.mediaType ?? "image/png",
          relayAssetId: IDS.asset,
          sha256: options.sha256 ?? sha256(bytes),
        },
        ...(options.caption === undefined ? {} : { caption: options.caption }),
        kind: "attachment",
        submissionId: IDS.submission,
        target: options.target ?? { kind: "new_chat" },
      },
      type: "companion.share.uploaded",
    },
    expiresAt: EXPIRES_AT,
    id: IDS.envelope,
    protocolVersion: 1,
    recipient: { desktopInstanceId: IDS.desktop, kind: "desktop" },
  };
}

function chat(id: string = IDS.chat, status: Chat["status"] = "active"): Chat {
  return {
    ...(status === "archived" ? { archivedAt: NOW } : {}),
    createdAt: NOW,
    id,
    status,
    title: "分享",
    updatedAt: NOW,
  };
}

function createHarness(
  options: {
    readonly bytes?: Buffer;
    readonly cursor?: string;
    readonly now?: string;
    readonly returnWithoutMessage?: boolean;
    readonly throwBeforeMessage?: boolean;
    readonly throwAfterMessage?: boolean;
    readonly throwDefaultProvider?: boolean;
  } = {},
) {
  let currentNow = options.now ?? NOW;
  let mailboxCursor = options.cursor;
  let shareRecord: CompanionShareImportRecord | undefined;
  let messageSequence = 0;
  const chatsById = new Map<string, Chat>();
  const provisionalChats = new Set<string>();
  const runsById = new Map<string, { readonly chatId: string }>();
  const messagesByRun = new Map<string, Message[]>();
  const attachmentsByChat = new Map<string, Attachment[]>();

  const getOrCreateDesktopInstanceId = vi.fn(() => IDS.desktop);
  const getDesktopMailboxCursor = vi.fn(() => mailboxCursor);
  const claimShare = vi.fn((input: ClaimShare) => {
    if (shareRecord) {
      return { kind: "existing" as const, record: shareRecord };
    }
    shareRecord = {
      claimedAt: input.claimedAt,
      cursor: input.cursor,
      deviceId: input.deviceId,
      envelopeId: input.envelopeId,
      expiresAt: input.expiresAt,
      payloadSha256: input.payloadSha256,
      ...(input.predecessorCursor === undefined
        ? {}
        : { predecessorCursor: input.predecessorCursor }),
      ...(input.sourceKind === "attachment"
        ? { relayAssetId: input.relayAssetId }
        : {}),
      sourceKind: input.sourceKind,
      state: "claimed",
      submissionId: input.submissionId,
      updatedAt: input.claimedAt,
    };
    return { kind: "claimed" as const, record: shareRecord };
  });
  const bindOrRebindShareRun = vi.fn(
    (input: {
      readonly runId: string;
      readonly submissionId: string;
      readonly updatedAt: string;
    }) => {
      if (!shareRecord) throw new Error("missing claim");
      shareRecord = {
        ...shareRecord,
        runId: input.runId,
        updatedAt: input.updatedAt,
      };
      return shareRecord;
    },
  );
  const completeShareImport = vi.fn((input: CompleteShareImport) => {
    if (!shareRecord) throw new Error("missing claim");
    const cursorMatches =
      shareRecord.predecessorCursor === undefined
        ? mailboxCursor === undefined
        : mailboxCursor === shareRecord.predecessorCursor;
    if (!cursorMatches) throw new Error("cursor conflict");
    shareRecord = {
      ...shareRecord,
      ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
      chatId: input.chatId,
      importedAt: input.importedAt,
      messageId: input.messageId,
      state: "imported",
      updatedAt: input.importedAt,
    };
    mailboxCursor = shareRecord.cursor;
    return shareRecord;
  });
  const getShareImport = vi.fn(() => shareRecord);

  const createProvisional = vi.fn(
    ({ initialMessage }: { readonly initialMessage?: string }) => {
      const created = { ...chat(), title: initialMessage ?? "新对话" };
      chatsById.set(created.id, created);
      provisionalChats.add(created.id);
      return created;
    },
  );
  const establishProvisional = vi.fn((chatId: string) => {
    provisionalChats.delete(chatId);
    const current = chatsById.get(chatId);
    if (!current) throw new Error("missing Chat");
    return current;
  });
  const discardProvisional = vi.fn((chatId: string) => {
    const wasProvisional = provisionalChats.delete(chatId);
    if (wasProvisional) chatsById.delete(chatId);
    return wasProvisional;
  });
  const restore = vi.fn(({ chatId }: { readonly chatId: string }) => {
    const current = chatsById.get(chatId);
    if (!current) throw new Error("missing Chat");
    const restored = { ...current, status: "active" as const };
    delete (restored as Partial<Chat>).archivedAt;
    chatsById.set(chatId, restored);
    return restored;
  });
  const insertAttachment = vi.fn((attachment: Attachment) => {
    const current = attachmentsByChat.get(attachment.chatId) ?? [];
    current.push(attachment);
    attachmentsByChat.set(attachment.chatId, current);
    return attachment;
  });

  const storeBufferWithStableId = vi.fn(
    (
      scopeId: string,
      artifactId: string,
      displayName: string,
      content: Buffer,
      mediaType: string,
      kind: ArtifactReference["kind"],
    ): Promise<ArtifactReference> =>
      Promise.resolve({
        artifactId,
        byteLength: content.byteLength,
        displayName,
        kind,
        mediaType,
        sha256: sha256(content),
        storageKey: `${scopeId}/${artifactId}.bin`,
      }),
  );
  const readRelayAsset = vi.fn<
    CompanionShareIngressDependencies["readRelayAsset"]
  >(() => Promise.resolve(options.bytes ?? Buffer.alloc(0)));
  const start = vi.fn(
    (
      request: StartRunRequest,
      startOptions: {
        readonly onRunAllocated: (runId: string) => void;
        readonly signal?: AbortSignal;
      },
    ) => {
      startOptions.onRunAllocated(IDS.run);
      runsById.set(IDS.run, { chatId: request.chatId });
      if (options.throwBeforeMessage) {
        return Promise.reject(new Error("start failed before message"));
      }
      if (options.returnWithoutMessage) {
        return Promise.resolve({ id: IDS.run });
      }
      messageSequence += 1;
      const message: Message = {
        chatId: request.chatId,
        content: request.content,
        createdAt: NOW,
        id: IDS.message,
        role: "user",
        runId: IDS.run,
        status: "completed",
        updatedAt: NOW,
      };
      messagesByRun.set(IDS.run, [message]);
      for (const artifact of request.attachments) {
        insertAttachment({
          ...(artifact.byteLength === undefined
            ? {}
            : { byteLength: artifact.byteLength }),
          chatId: request.chatId,
          createdAt: NOW,
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
      }
      if (options.throwAfterMessage) {
        return Promise.reject(new Error("start failed late"));
      }
      return Promise.resolve({ id: IDS.run });
    },
  );

  const dependencies: CompanionShareIngressDependencies = {
    agent: { start },
    artifacts: { storeBufferWithStableId },
    bridge: {
      bindOrRebindShareRun,
      claimShare,
      completeShareImport,
      getDesktopMailboxCursor,
      getOrCreateDesktopInstanceId,
      getShareImport,
    },
    chatRepository: {
      getChat: (chatId) => chatsById.get(chatId),
      getSnapshot: (chatId) => {
        const current = chatsById.get(chatId);
        if (!current) return null;
        return {
          attachments: attachmentsByChat.get(chatId) ?? [],
          chat: current,
          messages: [...messagesByRun.values()]
            .flat()
            .filter((message) => message.chatId === chatId),
        };
      },
      insertAttachment,
      isProvisionalChat: (chatId) => provisionalChats.has(chatId),
      listRunMessages: (runId) => messagesByRun.get(runId) ?? [],
    },
    chats: {
      createProvisional,
      discardProvisional,
      establishProvisional,
      restore,
    },
    clock: { now: () => currentNow },
    providers: {
      getDefaultChatProfileId: vi.fn(() => {
        if (options.throwDefaultProvider) {
          throw new Error("default provider unavailable");
        }
        return IDS.profile;
      }),
    },
    readRelayAsset,
    runs: { getRun: (runId) => runsById.get(runId) },
  };

  return {
    addChat: (value: Chat, provisional = false) => {
      chatsById.set(value.id, value);
      if (provisional) provisionalChats.add(value.id);
    },
    attachmentsByChat,
    claimShare,
    completeShareImport,
    createProvisional,
    dependencies,
    discardProvisional,
    establishProvisional,
    getOrCreateDesktopInstanceId,
    get messageCount() {
      return messageSequence;
    },
    insertAttachment,
    messagesByRun,
    readRelayAsset,
    restore,
    seedClaimedRun: (
      envelope: CompanionDesktopMailboxEnvelope,
      message: Message,
      provisional = true,
    ) => {
      const sourceKind = envelope.event.share.kind;
      shareRecord = {
        claimedAt: NOW,
        cursor: envelope.cursor,
        deviceId: envelope.event.deviceId,
        envelopeId: envelope.id,
        expiresAt: envelope.expiresAt,
        payloadSha256: "0".repeat(64),
        ...(sourceKind === "attachment"
          ? { relayAssetId: envelope.event.share.attachment.relayAssetId }
          : {}),
        runId: IDS.run,
        sourceKind,
        state: "claimed",
        submissionId: envelope.event.share.submissionId,
        updatedAt: NOW,
      };
      runsById.set(IDS.run, { chatId: message.chatId });
      messagesByRun.set(IDS.run, [message]);
      const targetChat = chat(message.chatId);
      chatsById.set(message.chatId, targetChat);
      if (provisional) provisionalChats.add(message.chatId);
    },
    setCursor: (cursor: string | undefined) => {
      mailboxCursor = cursor;
    },
    setNow: (now: string) => {
      currentNow = now;
    },
    seedBoundRunWithoutMessage: (envelope: CompanionDesktopMailboxEnvelope) => {
      const sourceKind = envelope.event.share.kind;
      shareRecord = {
        claimedAt: NOW,
        cursor: envelope.cursor,
        deviceId: envelope.event.deviceId,
        envelopeId: envelope.id,
        expiresAt: envelope.expiresAt,
        payloadSha256: "0".repeat(64),
        ...(sourceKind === "attachment"
          ? { relayAssetId: envelope.event.share.attachment.relayAssetId }
          : {}),
        runId: IDS.oldRun,
        sourceKind,
        state: "claimed",
        submissionId: envelope.event.share.submissionId,
        updatedAt: NOW,
      };
      runsById.set(IDS.oldRun, { chatId: IDS.oldChat });
      chatsById.set(IDS.oldChat, chat(IDS.oldChat));
      provisionalChats.add(IDS.oldChat);
    },
    start,
    storeBufferWithStableId,
  };
}

describe("CompanionShareIngress", () => {
  it("imports text into one provisional Chat with the default Chat Provider", async () => {
    const harness = createHarness();
    const ingress = new CompanionShareIngress(harness.dependencies);
    const envelope = textEnvelope();
    const controller = new AbortController();

    await expect(
      ingress.importEnvelope(envelope, { signal: controller.signal }),
    ).resolves.toEqual({
      chatId: IDS.chat,
      messageId: IDS.message,
      submissionId: IDS.submission,
      type: "share.imported",
    });

    expect(harness.createProvisional).toHaveBeenCalledWith({
      initialMessage: "分享结束了",
    });
    expect(harness.start.mock.calls[0]?.[0]).toMatchObject({
      attachments: [],
      chatId: IDS.chat,
      content: "分享结束了",
      execution: { mode: "chat" },
      providerProfileId: IDS.profile,
    });
    expect(typeof harness.start.mock.calls[0]?.[1].onRunAllocated).toBe(
      "function",
    );
    expect(harness.start.mock.calls[0]?.[1].signal).toBe(controller.signal);
    expect(harness.establishProvisional).toHaveBeenCalledWith(IDS.chat);
    expect(
      harness.establishProvisional.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.completeShareImport.mock.invocationCallOrder[0]!);
    const canonicalPayload =
      '{"kind":"text","mediaType":"text/plain","submissionId":"30000000-0000-4000-8000-000000000003","target":{"kind":"new_chat"},"text":"分享结束了"}';
    expect(harness.claimShare).toHaveBeenCalledWith(
      expect.objectContaining({ payloadSha256: sha256(canonicalPayload) }),
    );
  });

  it("does not claim or start an already-aborted text share", async () => {
    const harness = createHarness();
    const ingress = new CompanionShareIngress(harness.dependencies);
    const controller = new AbortController();
    controller.abort();

    await expect(
      ingress.importEnvelope(textEnvelope(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(harness.getOrCreateDesktopInstanceId).not.toHaveBeenCalled();
    expect(harness.claimShare).not.toHaveBeenCalled();
    expect(harness.createProvisional).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.completeShareImport).not.toHaveBeenCalled();
  });

  it("stores verified image bytes as one stable managed image artifact", async () => {
    const bytes = Buffer.from("real-image-bytes");
    const harness = createHarness({ bytes });
    const ingress = new CompanionShareIngress(harness.dependencies);

    await expect(
      ingress.importEnvelope(
        attachmentEnvelope(bytes, { caption: "分享结束了" }),
      ),
    ).resolves.toMatchObject({
      attachmentId: IDS.submission,
      chatId: IDS.chat,
      messageId: IDS.message,
    });

    expect(harness.storeBufferWithStableId).toHaveBeenCalledWith(
      IDS.submission,
      IDS.submission,
      "sunset.png",
      bytes,
      "image/png",
      "image",
    );
    expect(harness.start.mock.calls[0]?.[0]).toMatchObject({
      attachments: [
        expect.objectContaining({
          artifactId: IDS.submission,
          kind: "image",
          sha256: sha256(bytes),
        }),
      ],
      content: "分享结束了",
    });
  });

  it("does not start a Run when a first attachment import is aborted after managed asset storage", async () => {
    const bytes = Buffer.from("real-image-bytes");
    const harness = createHarness({ bytes });
    const controller = new AbortController();
    const store = harness.storeBufferWithStableId.getMockImplementation();
    if (!store) throw new Error("Missing artifact store implementation");
    harness.storeBufferWithStableId.mockImplementationOnce(async (...args) => {
      const artifact = await store(...args);
      controller.abort();
      return artifact;
    });
    const ingress = new CompanionShareIngress(harness.dependencies);

    await expect(
      ingress.importEnvelope(attachmentEnvelope(bytes), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(harness.storeBufferWithStableId).toHaveBeenCalledOnce();
    expect(harness.createProvisional).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.completeShareImport).not.toHaveBeenCalled();
  });

  it("decodes text and Markdown attachments as strict UTF-8", async () => {
    const bytes = Buffer.from("# 分享完成\n\n今天的夕阳很好看", "utf8");
    const harness = createHarness({ bytes });
    const ingress = new CompanionShareIngress(harness.dependencies);

    await ingress.importEnvelope(
      attachmentEnvelope(bytes, {
        caption: "补充说明",
        contentKind: "markdown",
        displayName: "note.md",
        mediaType: "text/markdown",
      }),
    );

    expect(harness.start.mock.calls[0]?.[0]).toMatchObject({
      content: "补充说明\n\n# 分享完成\n\n今天的夕阳很好看",
    });
    expect(harness.storeBufferWithStableId).toHaveBeenCalledWith(
      IDS.submission,
      IDS.submission,
      "note.md",
      bytes,
      "text/markdown",
      "file",
    );
  });

  it("keeps PDF content as a file without claiming to parse its body", async () => {
    const bytes = Buffer.from("%PDF-1.7\nprivate-binary-body", "utf8");
    const harness = createHarness({ bytes });
    const ingress = new CompanionShareIngress(harness.dependencies);

    await ingress.importEnvelope(
      attachmentEnvelope(bytes, {
        contentKind: "pdf",
        displayName: "slides.pdf",
        mediaType: "application/pdf",
      }),
    );

    expect(harness.start.mock.calls[0]?.[0]).toMatchObject({
      attachments: [expect.objectContaining({ kind: "file" })],
      content: "请处理这个附件。",
    });
    expect(harness.storeBufferWithStableId).toHaveBeenCalledWith(
      IDS.submission,
      IDS.submission,
      "slides.pdf",
      bytes,
      "application/pdf",
      "file",
    );
  });

  it.each([
    {
      expectedCode: "COMPANION.ATTACHMENT_LENGTH_MISMATCH",
      envelope: (bytes: Buffer) =>
        attachmentEnvelope(bytes, { byteLength: bytes.byteLength + 1 }),
    },
    {
      expectedCode: "COMPANION.ATTACHMENT_HASH_MISMATCH",
      envelope: (bytes: Buffer) =>
        attachmentEnvelope(bytes, { sha256: "f".repeat(64) }),
    },
    {
      expectedCode: "COMPANION.ATTACHMENT_UTF8_INVALID",
      envelope: (bytes: Buffer) =>
        attachmentEnvelope(bytes, {
          contentKind: "text",
          displayName: "bad.txt",
          mediaType: "text/plain",
        }),
    },
  ])(
    "rejects invalid attachment bytes with $expectedCode",
    async ({ envelope, expectedCode }) => {
      const bytes = Buffer.from([0xc3, 0x28]);
      const harness = createHarness({ bytes });
      const ingress = new CompanionShareIngress(harness.dependencies);

      await expect(
        ingress.importEnvelope(envelope(bytes)),
      ).rejects.toMatchObject({
        code: expectedCode,
      });
      expect(harness.start).not.toHaveBeenCalled();
      expect(harness.storeBufferWithStableId).not.toHaveBeenCalled();
    },
  );

  it("recovers a late start failure without creating a duplicate Run or Message", async () => {
    const harness = createHarness({ throwAfterMessage: true });
    const ingress = new CompanionShareIngress(harness.dependencies);
    const envelope = textEnvelope();

    await expect(ingress.importEnvelope(envelope)).resolves.toMatchObject({
      chatId: IDS.chat,
      messageId: IDS.message,
    });
    harness.setNow("2026-09-01T09:00:00.000Z");
    await expect(ingress.importEnvelope(envelope)).resolves.toMatchObject({
      chatId: IDS.chat,
      messageId: IDS.message,
    });

    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.messageCount).toBe(1);
  });

  it.each([
    {
      error: "default provider unavailable",
      options: { throwDefaultProvider: true },
    },
    {
      error: "start failed before message",
      options: { throwBeforeMessage: true },
    },
  ])(
    "discards a new provisional Chat when $error",
    async ({ error, options }) => {
      const harness = createHarness(options);
      const ingress = new CompanionShareIngress(harness.dependencies);

      await expect(ingress.importEnvelope(textEnvelope())).rejects.toThrow(
        error,
      );

      expect(harness.discardProvisional).toHaveBeenCalledWith(IDS.chat);
      expect(harness.establishProvisional).not.toHaveBeenCalled();
      expect(harness.completeShareImport).not.toHaveBeenCalled();
    },
  );

  it("discards a new provisional Chat when Agent preflight is aborted before Run allocation", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    harness.start.mockImplementationOnce((_request, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      options.signal?.throwIfAborted();
      return Promise.resolve({ id: IDS.run });
    });
    const ingress = new CompanionShareIngress(harness.dependencies);

    await expect(
      ingress.importEnvelope(textEnvelope(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(harness.discardProvisional).toHaveBeenCalledWith(IDS.chat);
    expect(harness.establishProvisional).not.toHaveBeenCalled();
    expect(harness.completeShareImport).not.toHaveBeenCalled();
  });

  it("discards a provisional Chat when start resolves without a completed User Message", async () => {
    const harness = createHarness({ returnWithoutMessage: true });
    const ingress = new CompanionShareIngress(harness.dependencies);

    await expect(ingress.importEnvelope(textEnvelope())).rejects.toMatchObject({
      code: "COMPANION.SHARE_RECOVERY_FAILED",
    });

    expect(harness.discardProvisional).toHaveBeenCalledWith(IDS.chat);
    expect(harness.establishProvisional).not.toHaveBeenCalled();
  });

  it("discards an old bound provisional before rebinding a retry without a User Message", async () => {
    const envelope = textEnvelope();
    const harness = createHarness();
    harness.seedBoundRunWithoutMessage(envelope);
    const ingress = new CompanionShareIngress(harness.dependencies);

    await expect(ingress.importEnvelope(envelope)).resolves.toMatchObject({
      chatId: IDS.chat,
      messageId: IDS.message,
    });

    expect(harness.discardProvisional).toHaveBeenCalledWith(IDS.oldChat);
    expect(harness.discardProvisional.mock.invocationCallOrder[0]).toBeLessThan(
      harness.createProvisional.mock.invocationCallOrder[0]!,
    );
    expect(harness.start).toHaveBeenCalledOnce();
  });

  it("repairs a missing stable attachment on the bound completed User Message", async () => {
    const bytes = Buffer.from("image-bytes");
    const envelope = attachmentEnvelope(bytes);
    const harness = createHarness({ bytes });
    const message: Message = {
      chatId: IDS.chat,
      content: "请处理这个附件。",
      createdAt: NOW,
      id: IDS.message,
      role: "user",
      runId: IDS.run,
      status: "completed",
      updatedAt: NOW,
    };
    harness.seedClaimedRun(envelope, message);
    const ingress = new CompanionShareIngress(harness.dependencies);

    await expect(ingress.importEnvelope(envelope)).resolves.toMatchObject({
      attachmentId: IDS.submission,
      messageId: IDS.message,
    });

    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.establishProvisional).toHaveBeenCalledWith(IDS.chat);
    expect(
      harness.establishProvisional.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.storeBufferWithStableId.mock.invocationCallOrder[0]!,
    );
    expect(harness.storeBufferWithStableId).toHaveBeenCalledOnce();
    expect(harness.attachmentsByChat.get(IDS.chat)).toEqual([
      expect.objectContaining({
        id: IDS.submission,
        messageId: IDS.message,
      }),
    ]);
  });

  it("passes cancellation into recovery download and does not insert a missing attachment after abort", async () => {
    const bytes = Buffer.from("image-bytes");
    const envelope = attachmentEnvelope(bytes);
    const harness = createHarness({ bytes });
    const message: Message = {
      chatId: IDS.chat,
      content: "请处理这个附件。",
      createdAt: NOW,
      id: IDS.message,
      role: "user",
      runId: IDS.run,
      status: "completed",
      updatedAt: NOW,
    };
    harness.seedClaimedRun(envelope, message);
    const controller = new AbortController();
    harness.readRelayAsset.mockImplementationOnce((_asset, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return Promise.resolve(bytes);
    });
    const ingress = new CompanionShareIngress(harness.dependencies);

    await expect(
      ingress.importEnvelope(envelope, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(harness.readRelayAsset).toHaveBeenCalledOnce();
    expect(harness.storeBufferWithStableId).not.toHaveBeenCalled();
    expect(harness.insertAttachment).not.toHaveBeenCalled();
    expect(harness.attachmentsByChat.get(IDS.chat)).toBeUndefined();
    expect(harness.completeShareImport).not.toHaveBeenCalled();
  });

  it("establishes the recovered Chat without rebasing a stale predecessor cursor", async () => {
    const harness = createHarness({ cursor: "cursor-0" });
    harness.start.mockImplementationOnce((request, options) => {
      options.onRunAllocated(IDS.run);
      harness.messagesByRun.set(IDS.run, [
        {
          chatId: request.chatId,
          content: request.content,
          createdAt: NOW,
          id: IDS.message,
          role: "user",
          runId: IDS.run,
          status: "completed",
          updatedAt: NOW,
        },
      ]);
      harness.setCursor("cursor-newer");
      return Promise.resolve({ id: IDS.run });
    });
    const ingress = new CompanionShareIngress(harness.dependencies);

    await expect(ingress.importEnvelope(textEnvelope())).rejects.toThrow(
      "cursor conflict",
    );

    expect(harness.claimShare).toHaveBeenCalledWith(
      expect.objectContaining({ predecessorCursor: "cursor-0" }),
    );
    expect(harness.establishProvisional).toHaveBeenCalledWith(IDS.chat);
    expect(
      harness.establishProvisional.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.completeShareImport.mock.invocationCallOrder[0]!);

    await expect(ingress.importEnvelope(textEnvelope())).rejects.toThrow(
      "cursor conflict",
    );
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.messagesByRun.get(IDS.run)).toHaveLength(1);
    expect(harness.completeShareImport).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.bridge.getDesktopMailboxCursor()).toBe(
      "cursor-newer",
    );
  });

  it("rejects a new claim at envelope expiry but allows an imported retry", async () => {
    const expiredHarness = createHarness({ now: EXPIRES_AT });
    const expiredIngress = new CompanionShareIngress(
      expiredHarness.dependencies,
    );

    await expect(
      expiredIngress.importEnvelope(textEnvelope()),
    ).rejects.toMatchObject({ code: "COMPANION.SHARE_EXPIRED" });
    expect(expiredHarness.claimShare).not.toHaveBeenCalled();
    expect(expiredHarness.start).not.toHaveBeenCalled();

    const importedHarness = createHarness();
    const importedIngress = new CompanionShareIngress(
      importedHarness.dependencies,
    );
    await importedIngress.importEnvelope(textEnvelope());
    importedHarness.setNow("2026-09-01T09:00:00.000Z");

    await expect(
      importedIngress.importEnvelope(textEnvelope()),
    ).resolves.toMatchObject({ messageId: IDS.message });
    expect(importedHarness.start).toHaveBeenCalledOnce();
  });

  it("rejects a new attachment claim when its relay asset has expired", async () => {
    const bytes = Buffer.from("image-bytes");
    const harness = createHarness({
      bytes,
      now: "2026-09-01T07:30:00.000Z",
    });
    const ingress = new CompanionShareIngress(harness.dependencies);

    await expect(
      ingress.importEnvelope(
        attachmentEnvelope(bytes, {
          assetExpiresAt: "2026-09-01T07:30:00.000Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "COMPANION.SHARE_EXPIRED" });
    expect(harness.claimShare).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("restores and uses only the exact existing Chat target", async () => {
    const harness = createHarness();
    harness.addChat(chat(IDS.chat, "archived"));
    const ingress = new CompanionShareIngress(harness.dependencies);

    await ingress.importEnvelope(
      textEnvelope({ chatId: IDS.chat, kind: "existing_chat" }),
    );

    expect(harness.restore).toHaveBeenCalledWith({ chatId: IDS.chat });
    expect(harness.createProvisional).not.toHaveBeenCalled();
    expect(harness.start.mock.calls[0]?.[0].chatId).toBe(IDS.chat);

    const missingTarget = "a0000000-0000-4000-8000-00000000000a";
    const secondHarness = createHarness();
    const secondIngress = new CompanionShareIngress(secondHarness.dependencies);
    await expect(
      secondIngress.importEnvelope(
        textEnvelope({ chatId: missingTarget, kind: "existing_chat" }),
      ),
    ).rejects.toMatchObject({ code: "COMPANION.CHAT_NOT_FOUND" });
    expect(secondHarness.start).not.toHaveBeenCalled();
  });

  it("strictly rejects envelopes for another recipient or with unknown fields", async () => {
    const harness = createHarness();
    const ingress = new CompanionShareIngress(harness.dependencies);
    const wrongRecipient = {
      ...textEnvelope(),
      recipient: {
        desktopInstanceId: "b0000000-0000-4000-8000-00000000000b",
        kind: "desktop",
      },
    };

    await expect(ingress.importEnvelope(wrongRecipient)).rejects.toBeInstanceOf(
      CompanionShareIngressError,
    );
    await expect(
      ingress.importEnvelope({ ...textEnvelope(), unexpected: true }),
    ).rejects.toThrow();
    expect(harness.claimShare).not.toHaveBeenCalled();
  });

  it("does not coalesce concurrent envelopes with conflicting recipients or payloads", async () => {
    const harness = createHarness();
    const ingress = new CompanionShareIngress(harness.dependencies);
    const first = ingress.importEnvelope(textEnvelope());
    const wrongRecipient = ingress.importEnvelope({
      ...textEnvelope(),
      recipient: {
        desktopInstanceId: "c0000000-0000-4000-8000-00000000000c",
        kind: "desktop",
      },
    });
    const conflictingPayload = ingress.importEnvelope(
      textEnvelope({
        chatId: "d0000000-0000-4000-8000-00000000000d",
        kind: "existing_chat",
      }),
    );

    await expect(wrongRecipient).rejects.toMatchObject({
      code: "COMPANION.RECIPIENT_MISMATCH",
    });
    await expect(conflictingPayload).rejects.toMatchObject({
      code: "COMPANION.CHAT_NOT_FOUND",
    });
    await expect(first).resolves.toMatchObject({ messageId: IDS.message });
    expect(harness.start).toHaveBeenCalledOnce();
  });
});
