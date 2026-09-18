import { canonicalCognitionSource } from "./canonicalCognitionSources";
import { setImmediate } from "node:timers/promises";
import type Database from "better-sqlite3";
import type { CognitionSourceRetentionReason } from "../../shared/contracts/cognition";
import type { MemorySourceReclamation } from "../../shared/contracts/memoryRecall";
import type { RunRepository } from "../agent/runRepository";
import type { ChatRepository } from "../chat/chatRepository";
import type { CognitionRepository } from "../cognition/cognitionRepository";

export interface MemorySourceReclamationOptions {
  readonly database: Database.Database;
  readonly clock: { now(): string };
  readonly memory: MemorySourceReclamation;
  readonly cognition: Pick<
    CognitionRepository,
    | "protectedCanonicalSources"
    | "nextReclaimableEvidenceBody"
    | "releaseEvidenceBody"
  >;
  readonly runs: Pick<RunRepository, "getMessageItemSourceReferences">;
  readonly chats: Pick<ChatRepository, "getMessageSourceReference">;
}

export interface MemorySourceReclamationResult {
  scanned: number;
  released: number;
  retained: Partial<
    Record<CognitionSourceRetentionReason | "unknown_mapping", number>
  >;
  interrupted: boolean;
  cognition: {
    scanned: number;
    released: number;
    payloadBytesBefore: number;
    payloadBytesAfter: number;
  };
}

/** Called by the existing Memory maintenance owner. Each source is an atomic
 * unit; no live cursor or transaction crosses an event-loop yield. */
export async function reclaimMemorySources(
  options: MemorySourceReclamationOptions,
  signal: AbortSignal,
): Promise<MemorySourceReclamationResult> {
  const result: MemorySourceReclamationResult = {
    scanned: 0,
    released: 0,
    retained: {},
    interrupted: false,
    cognition: {
      scanned: 0,
      released: 0,
      payloadBytesBefore: 0,
      payloadBytesAfter: 0,
    },
  };
  let afterSourceId: string | undefined;
  while (!signal.aborted) {
    const step = options.database.transaction(() => {
      const source = options.memory.nextReclaimableSource(afterSourceId);
      if (!source) return;
      const original = canonicalCognitionSource(source, options);
      const reasons = original
        ? (options.cognition.protectedCanonicalSources([original])[0]
            ?.reasons ?? [])
        : (["unknown_mapping"] as const);
      const released =
        !reasons.length && options.memory.releaseCanonicalSource(source.id);
      return { sourceId: source.id, reasons, released };
    })();
    if (!step) break;
    afterSourceId = step.sourceId;
    result.scanned += 1;
    if (step.released) result.released += 1;
    for (const reason of step.reasons)
      result.retained[reason] = (result.retained[reason] ?? 0) + 1;
    await setImmediate();
  }
  let afterSequence = 0;
  while (!signal.aborted) {
    const candidate =
      options.cognition.nextReclaimableEvidenceBody(afterSequence);
    if (!candidate) break;
    afterSequence = candidate.receiptSequence;
    result.cognition.scanned += 1;
    const released = options.cognition.releaseEvidenceBody(
      candidate.id,
      options.clock.now(),
    );
    if (released) {
      result.cognition.released += 1;
      result.cognition.payloadBytesBefore += released.payloadBytesBefore;
      result.cognition.payloadBytesAfter += released.payloadBytesAfter;
    }
    await setImmediate();
  }
  result.interrupted = signal.aborted;
  return result;
}
