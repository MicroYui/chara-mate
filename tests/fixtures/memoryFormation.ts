import type { MemoryFormationRepository } from "../../src/main/memory/memoryFormationRepository";
import {
  segmentMemoryEpisode,
  type MemoryFormationSegment,
} from "../../src/main/memory/memoryFormationSegments";
import type {
  MemoryFormationEpisode,
  MemoryFormationIntake,
  MemoryFormationSource,
} from "../../src/shared/contracts/memoryRecall";

/** Test fixtures keep explicit originals; production intake only carries refs. */
export type FormationFixture = MemoryFormationEpisode & {
  sources: MemoryFormationSource[];
  evidenceSourceIds?: string[];
};
export function formationIntake(
  input: FormationFixture,
): MemoryFormationIntake {
  const { sources, evidenceSourceIds, ...episode } = input;
  const primary = new Set(evidenceSourceIds ?? sources.map(({ id }) => id));
  return {
    episode,
    sources: function* () {
      for (const source of sources)
        yield { sourceId: source.id, primary: primary.has(source.id) };
    },
    resolveSource: (id) => sources.find((source) => source.id === id),
  };
}

export async function collectFormationSegments(
  repository: MemoryFormationRepository,
  workId: string,
  budget: number,
) {
  const result: MemoryFormationSegment[] = [];
  for await (const segment of segmentMemoryEpisode(
    repository,
    repository.work(workId),
    budget,
  ))
    result.push(segment);
  return result;
}
