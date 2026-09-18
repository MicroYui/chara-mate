import type { CognitionRepository } from "../cognition/cognitionRepository";
import type { CognitionSourceRetentionCandidate } from "../../shared/contracts/cognition";
import type {
  MemoryEvidenceItem,
  MemoryCanonicalSourceCandidate,
} from "../../shared/contracts/memoryRecall";
import type { RunRepository } from "../agent/runRepository";
import type { ChatRepository } from "../chat/chatRepository";

/** Canonical IDs are source-owner identities, not Cognition summaries. */
export function canonicalCognitionSource(
  source: Pick<MemoryCanonicalSourceCandidate, "id" | "referenceId" | "type">,
  options: {
    readonly runs: Pick<RunRepository, "getMessageItemSourceReferences">;
    readonly chats: Pick<ChatRepository, "getMessageSourceReference">;
  },
): CognitionSourceRetentionCandidate | undefined {
  if (source.type === "activity_event")
    return source.id === source.referenceId
      ? {
          candidateId: source.id,
          references: [{ kind: "activity", id: source.id }],
        }
      : undefined;
  if (source.type === "tool")
    return {
      candidateId: source.id,
      references: [
        { kind: "run", id: source.referenceId, fragment: source.id },
      ],
    };
  if (source.type !== "chat" && source.type !== "voice") return;
  const message = options.chats.getMessageSourceReference(source.id);
  if (!message?.runId || message.chatId !== source.referenceId) return;
  const items = options.runs.getMessageItemSourceReferences(
    message.runId,
    message.id,
  );
  return {
    candidateId: source.id,
    references: [
      { kind: "message", id: message.id },
      ...items.map((item) => ({
        kind: "run" as const,
        id: item.runId,
        fragment: item.id,
      })),
    ],
  };
}

/** Locate owning Cognition state through actual canonical identities. A Memory
 * source excerpt or an unresolved owner remains an explicit discovery gap. */
export function referencedCognitionState(
  personaId: string,
  items: readonly Pick<MemoryEvidenceItem, "sourceRefs" | "sourceCount">[],
  maxBytes: number,
  options: Parameters<typeof canonicalCognitionSource>[1] & {
    readonly cognition: Pick<CognitionRepository, "stateReferencesForSources">;
  },
): ReturnType<CognitionRepository["stateReferencesForSources"]> {
  const candidates = new Map<string, CognitionSourceRetentionCandidate>();
  const seen = new Set<string>();
  let missingReferenceCount = 0;
  for (const item of items) {
    missingReferenceCount += Math.max(
      0,
      (item.sourceCount ?? item.sourceRefs.length) - item.sourceRefs.length,
    );
    for (const source of item.sourceRefs) {
      if (seen.has(source.sourceId)) continue;
      seen.add(source.sourceId);
      const original = canonicalCognitionSource(
        {
          id: source.sourceId,
          type: source.type,
          referenceId: source.referenceId,
        },
        options,
      );
      if (original) candidates.set(original.candidateId, original);
      else missingReferenceCount += 1;
    }
  }
  // The owner counts missing state relations; this adapter also knows omitted or
  // unmapped canonical sources. Reserve their possible decimal-width increase.
  const countBytes =
    JSON.stringify(candidates.size + missingReferenceCount).length -
    JSON.stringify(candidates.size).length;
  const references = options.cognition.stateReferencesForSources(
    personaId,
    [...candidates.values()],
    maxBytes - countBytes,
  );
  return {
    ...references,
    missingReferenceCount:
      references.missingReferenceCount + missingReferenceCount,
  };
}
