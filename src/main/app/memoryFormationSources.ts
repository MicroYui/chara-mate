import { createHash } from "node:crypto";
import type { ActivityEvent } from "../../shared/contracts/activity";
import type { Message } from "../../shared/contracts/chat";
import type { CognitionEvidence } from "../../shared/contracts/cognition";
import type {
  MemoryFormationSource,
  MemoryEvidenceReference,
  MemoryFormationIntake,
} from "../../shared/contracts/memoryRecall";
import type { Run, RunItem } from "../../shared/contracts/run";
import type { ChatMessageSourceReference } from "../chat/chatRepository";
import type { RunItemSourceReference } from "../agent/runRepository";

export type MemorySourceMetadata = Omit<MemoryFormationSource, "content">;
export type MemorySourceResolution =
  | { kind: "available"; source: MemorySourceMetadata }
  | { kind: "unsupported" }
  | { kind: "missing"; reference: string };

export interface MemorySourceReferences {
  hasChat(id: string): boolean;
  getCanonicalSource(id: string): MemorySourceMetadata | undefined;
  getRunSource(
    id: string,
  ): Pick<Run, "id" | "chatId" | "source" | "createdAt"> | undefined;
  getRunItemSource(id: string): RunItemSourceReference | undefined;
  getMessageSource(id: string): ChatMessageSourceReference | undefined;
  getActivitySource(
    id: string,
  ): Pick<ActivityEvent, "id" | "actor" | "startedAt"> | undefined;
}

/** IDs refer to immutable source bodies. Versions depend on identity and use, not repeated body copies. */
export function createMemoryFormationIntake(input: {
  id: string;
  personaId: string;
  situationId?: string;
  availableMemoryReferences?: readonly MemoryEvidenceReference[];
  sources: Iterable<{ source: MemorySourceMetadata; primary: boolean }>;
  resolveSource: (id: string) => MemoryFormationSource | undefined;
}): MemoryFormationIntake | undefined {
  const byId = new Map<
    string,
    { source: MemorySourceMetadata; primary: boolean }
  >();
  for (const value of input.sources) {
    const source: MemorySourceMetadata = {
      id: value.source.id,
      type: value.source.type,
      referenceId: value.source.referenceId,
      speaker: value.source.speaker,
      occurredAt: value.source.occurredAt,
    };
    const previous = byId.get(value.source.id);
    if (previous && JSON.stringify(previous.source) !== JSON.stringify(source))
      throw new Error("Conflicting canonical source metadata");
    byId.set(value.source.id, {
      source,
      primary: Boolean(previous?.primary || value.primary),
    });
  }
  const ordered = [...byId.values()].sort(
    (a, b) =>
      a.source.occurredAt.localeCompare(b.source.occurredAt) ||
      a.source.id.localeCompare(b.source.id),
  );
  const primary = ordered.filter((value) => value.primary);
  if (!primary.length) return;
  const availableMemoryReferences = [
    ...(input.availableMemoryReferences ?? []),
  ].sort((a, b) =>
    `${a.memoryId}:${a.revisionId}:${a.use}`.localeCompare(
      `${b.memoryId}:${b.revisionId}:${b.use}`,
    ),
  );
  const version = createHash("sha256")
    .update(JSON.stringify({ ordered, availableMemoryReferences }))
    .digest("hex");
  return {
    episode: {
      id: input.id,
      version,
      personaId: input.personaId,
      ...(availableMemoryReferences.length
        ? { availableMemoryReferences }
        : {}),
      ...(input.situationId ? { situationId: input.situationId } : {}),
      recordedAt: primary.at(-1)!.source.occurredAt,
    },
    sources: () =>
      ordered.map(({ source, primary }) => ({ sourceId: source.id, primary })),
    resolveSource: input.resolveSource,
  };
}

export function messageMemorySourceMetadata(
  run: Pick<Run, "id" | "chatId" | "source">,
  message: ChatMessageSourceReference,
): MemorySourceMetadata | undefined {
  if (
    message.runId !== run.id ||
    message.chatId !== run.chatId ||
    message.status !== "completed" ||
    !message.hasText
  )
    return;
  return {
    id: message.id,
    referenceId: message.chatId,
    type: run.source === "voice" ? "voice" : "chat",
    speaker: message.role === "user" ? "user" : "assistant",
    occurredAt: message.createdAt,
  };
}

export function toolMemorySourceMetadata(
  run: Pick<Run, "id" | "createdAt">,
  item: RunItemSourceReference,
): MemorySourceMetadata | undefined {
  if (
    item.runId !== run.id ||
    !["completed", "failed"].includes(item.status) ||
    item.toolName === undefined ||
    item.toolName.startsWith("memory.") ||
    !item.hasToolOutput
  )
    return;
  return {
    id: item.id,
    referenceId: run.id,
    type: "tool",
    speaker: "tool",
    occurredAt: item.endedAt ?? item.startedAt ?? run.createdAt,
  };
}

/** Availability comes from the canonical source owner; the Cognition excerpt is never a substitute. */
export function cognitionMemorySourceReference(
  evidence: CognitionEvidence,
  records: MemorySourceReferences,
): MemorySourceResolution {
  const { source } = evidence;
  if (
    source.kind === "activity" &&
    evidence.kind === "observation" &&
    (evidence.actor === "user" || evidence.actor === "unknown")
  ) {
    const saved = records.getCanonicalSource(source.id);
    if (
      saved?.id === source.id &&
      saved.referenceId === source.id &&
      saved.type === "activity_event" &&
      saved.speaker === "environment"
    )
      return { kind: "available", source: saved };
    const event = records.getActivitySource(source.id);
    if (!event) return { kind: "missing", reference: source.id };
    if (event.actor !== "user" && event.actor !== "unknown")
      return { kind: "unsupported" };
    return {
      kind: "available",
      source: {
        id: event.id,
        referenceId: event.id,
        type: "activity_event",
        speaker: "environment",
        occurredAt: event.startedAt,
      },
    };
  }
  if (
    source.kind !== "run" ||
    !source.fragment ||
    (evidence.kind !== "effect" && evidence.kind !== "utterance")
  )
    return { kind: "unsupported" };
  // Chat deletion also retires its not-yet-transferred formation references.
  // Independently persisted Memory remains owned by Memory's deletion rules.
  if (evidence.chatId && !records.hasChat(evidence.chatId))
    return { kind: "unsupported" };
  if (evidence.kind === "effect") {
    const saved = records.getCanonicalSource(source.fragment);
    if (
      saved?.id === source.fragment &&
      saved.referenceId === source.id &&
      saved.type === "tool" &&
      saved.speaker === "tool"
    )
      return { kind: "available", source: saved };
  }
  const item = records.getRunItemSource(source.fragment);
  if (!item) return { kind: "missing", reference: source.fragment };
  if (item.runId !== source.id) return { kind: "unsupported" };
  if (evidence.kind === "utterance" && item.messageId !== undefined) {
    const saved = records.getCanonicalSource(item.messageId);
    if (
      saved?.id === item.messageId &&
      (saved.type === "chat" || saved.type === "voice") &&
      (saved.speaker === "user" || saved.speaker === "assistant")
    )
      return { kind: "available", source: saved };
  }
  const run = records.getRunSource(source.id);
  if (!run) return { kind: "missing", reference: source.id };
  if (evidence.kind === "effect") {
    const value = toolMemorySourceMetadata(run, item);
    return value
      ? { kind: "available", source: value }
      : { kind: "unsupported" };
  }
  if (item.messageId === undefined) return { kind: "unsupported" };
  const message = records.getMessageSource(item.messageId);
  if (!message) return { kind: "missing", reference: item.messageId };
  const value = messageMemorySourceMetadata(run, message);
  return value ? { kind: "available", source: value } : { kind: "unsupported" };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function messageMemorySource(
  run: Pick<Run, "id" | "chatId" | "source">,
  message: Message,
): MemoryFormationSource | undefined {
  if (
    message.runId !== run.id ||
    message.chatId !== run.chatId ||
    message.status !== "completed" ||
    !message.content.trim()
  )
    return;
  return {
    id: message.id,
    referenceId: message.chatId,
    type: run.source === "voice" ? "voice" : "chat",
    speaker: message.role === "user" ? "user" : "assistant",
    content: message.content,
    occurredAt: message.createdAt,
  };
}

export function toolMemorySource(
  run: Pick<Run, "id" | "createdAt">,
  item: RunItem,
): MemoryFormationSource | undefined {
  if (item.runId !== run.id || !["completed", "failed"].includes(item.status))
    return;
  const output = record(item.output);
  const input = record(item.input);
  const tool = input?.["toolName"] ?? input?.["name"];
  if (
    typeof tool !== "string" ||
    tool.startsWith("memory.") ||
    typeof output?.["status"] !== "string" ||
    typeof output["summary"] !== "string"
  )
    return;
  return {
    id: item.id,
    referenceId: run.id,
    type: "tool",
    speaker: "tool",
    content: JSON.stringify({
      tool,
      status: output["status"],
      summary: output["summary"],
      result: output["modelContent"],
    }),
    occurredAt: item.endedAt ?? item.startedAt ?? run.createdAt,
  };
}

export interface MemorySourceRecords {
  getRun(id: string): Run | undefined;
  getRunItem(id: string): RunItem | undefined;
  getMessage(id: string): Message | undefined;
  getActivityEvent(id: string): ActivityEvent | undefined;
  getActivitySourceSnapshot?(id: string): MemoryFormationSource | undefined;
}

/** All formation entrances use the same persisted record, identity, text and time. */
export function cognitionMemorySource(
  evidence: CognitionEvidence,
  records: MemorySourceRecords,
): MemoryFormationSource | undefined {
  const source = evidence.source;
  if (
    source.kind === "activity" &&
    evidence.kind === "observation" &&
    (evidence.actor === "user" || evidence.actor === "unknown")
  ) {
    const event = records.getActivityEvent(source.id);
    if (!event) {
      // Formation retains the original source independently of raw capture retention.
      const saved = records.getActivitySourceSnapshot?.(source.id);
      return saved?.id === source.id &&
        saved.referenceId === source.id &&
        saved.type === "activity_event" &&
        saved.speaker === "environment"
        ? saved
        : undefined;
    }
    if (event.actor !== "user" && event.actor !== "unknown") return;
    return {
      id: event.id,
      referenceId: event.id,
      type: "activity_event",
      speaker: "environment",
      content: JSON.stringify({
        id: event.id,
        actor: event.actor,
        startedAt: event.startedAt,
        details: event.details,
      }),
      occurredAt: event.startedAt,
    };
  }
  if (source.kind !== "run" || !source.fragment) return;
  const run = records.getRun(source.id);
  const item = records.getRunItem(source.fragment);
  if (!run || !item || item.runId !== run.id) return;
  if (evidence.kind === "effect") return toolMemorySource(run, item);
  if (evidence.kind !== "utterance") return;
  const messageId =
    record(item.output)?.["messageId"] ?? record(item.input)?.["messageId"];
  if (typeof messageId !== "string") return;
  const message = records.getMessage(messageId);
  return message ? messageMemorySource(run, message) : undefined;
}
