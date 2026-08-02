import type { ChatDataSnapshot } from "../../../shared/contracts/chat";
import type { Approval, RunItem } from "../../../shared/contracts/run";
import type {
  ChatAttachmentView,
  ChatMessageView,
  ChatRunView,
  ChatView,
} from "./types";

export function projectChatSnapshot(snapshot: ChatDataSnapshot): ChatView {
  const attachmentsByMessage = new Map<string, ChatAttachmentView[]>();
  for (const attachment of snapshot.attachments) {
    const projected: ChatAttachmentView = {
      artifactId: attachment.id,
      ...(attachment.byteLength === undefined
        ? {}
        : { byteLength: attachment.byteLength }),
      displayName: attachment.displayName,
      kind: attachment.kind,
      ...(attachment.mediaType === undefined
        ? {}
        : { mediaType: attachment.mediaType }),
      ...(attachment.sha256 === undefined ? {} : { sha256: attachment.sha256 }),
      storageKey: attachment.storageKey,
    };
    const attachments = attachmentsByMessage.get(attachment.messageId) ?? [];
    attachments.push(projected);
    attachmentsByMessage.set(attachment.messageId, attachments);
  }

  const messages: ChatMessageView[] = snapshot.messages.map((record) => ({
    attachments: attachmentsByMessage.get(record.id) ?? [],
    record,
  }));
  const itemsByRun = new Map<string, RunItem[]>();
  for (const item of snapshot.runItems) {
    const items = itemsByRun.get(item.runId) ?? [];
    items.push(item);
    itemsByRun.set(item.runId, items);
  }
  const approvalsByRun = new Map<string, Approval[]>();
  for (const approval of snapshot.approvals) {
    const approvals = approvalsByRun.get(approval.runId) ?? [];
    approvals.push(approval);
    approvalsByRun.set(approval.runId, approvals);
  }
  const runs: ChatRunView[] = snapshot.runs.map((record) => ({
    approvals: approvalsByRun.get(record.id) ?? [],
    items: itemsByRun.get(record.id) ?? [],
    record,
  }));

  return { messages, record: snapshot.chat, runs };
}
