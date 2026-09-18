import { createHash } from "node:crypto";
import type {
  CognitionEvidence,
  CognitionMemoryHandoff,
} from "../../shared/contracts/cognition";
import type {
  MemoryFormationIntake,
  MemoryFormationSource,
} from "../../shared/contracts/memoryRecall";
import type { CognitionRepository } from "../cognition/cognitionRepository";
import {
  createMemoryFormationIntake,
  type MemorySourceMetadata,
  type MemorySourceResolution,
} from "./memoryFormationSources";

export class CognitionMemorySourceError extends Error {
  constructor(readonly reference: string) {
    super(`Original source is unavailable for memory handoff: ${reference}`);
  }
}
function episodeId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Frozen first-hand sources define the work. Episode summaries never become raw evidence. */
export function cognitionMemoryIntake(
  handoff: CognitionMemoryHandoff,
  cognition: Pick<
    CognitionRepository,
    "memoryHandoffEvidence" | "memoryHandoffContext"
  >,
  describe: (evidence: CognitionEvidence) => MemorySourceResolution,
  resolve: (evidence: CognitionEvidence) => MemoryFormationSource | undefined,
): MemoryFormationIntake | undefined {
  const sources = new Map<
    string,
    {
      source: MemorySourceMetadata;
      primary: boolean;
      evidence: CognitionEvidence;
    }
  >();
  const acceptedAnchors: string[] = [];
  const add = (evidence: CognitionEvidence, primary: boolean) => {
    const resolution = describe(evidence);
    if (resolution.kind === "missing")
      throw new CognitionMemorySourceError(resolution.reference);
    if (resolution.kind === "unsupported") return;
    const previous = sources.get(resolution.source.id);
    if (
      previous &&
      (["id", "type", "referenceId", "speaker", "occurredAt"] as const).some(
        (field) => previous.source[field] !== resolution.source[field],
      )
    )
      throw new Error("Conflicting canonical source metadata");
    sources.set(resolution.source.id, {
      source: resolution.source,
      primary: Boolean(previous?.primary || primary),
      evidence: previous?.evidence ?? evidence,
    });
    if (primary) acceptedAnchors.push(evidence.id);
  };
  const read = (ids: readonly string[], primary: boolean) => {
    const missing = new Set(ids);
    for (const evidence of cognition.memoryHandoffEvidence(handoff, ids)) {
      missing.delete(evidence.id);
      add(evidence, primary);
    }
    if (missing.size) throw new CognitionMemorySourceError([...missing][0]!);
  };
  read(handoff.primaryEvidenceIds, true);
  if (!acceptedAnchors.length) return;
  read(handoff.historyEvidenceIds, false);
  for (const evidence of cognition.memoryHandoffContext(
    handoff,
    acceptedAnchors,
  ))
    add(evidence, false);
  const primaryIds = [...sources.values()]
    .filter((value) => value.primary)
    .map((value) => value.source.id)
    .sort();
  return createMemoryFormationIntake({
    id: episodeId(
      `${handoff.personaId}:${handoff.situationId}:${JSON.stringify(primaryIds)}`,
    ),
    personaId: handoff.personaId,
    situationId: handoff.situationId,
    sources: sources.values(),
    resolveSource: (id) => {
      const source = sources.get(id);
      return source ? resolve(source.evidence) : undefined;
    },
  });
}
