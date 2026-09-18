import { setImmediate } from "node:timers/promises";
import type {
  MemoryFormationEpisode,
  MemoryFormationMaterial,
  MemoryFormationSource,
} from "../../shared/contracts/memoryRecall";
import type {
  FormationSourceMetadata,
  MemoryFormationRepository,
} from "./memoryFormationRepository";

export interface MemorySourceWindow {
  sourceId: string;
  start: number;
  end: number;
  totalLength: number;
}
export interface MemoryFormationSourceCoverage {
  primarySourceCount: number;
  contextSourceCount: number;
  includedContextSourceCount: number;
  omittedContextSourceCount: number;
  truncatedContextSourceCount: number;
}
export interface MemoryFormationCursor {
  ordinal: number;
  start: number;
}
export interface MemoryFormationSegment {
  episode: MemoryFormationMaterial;
  sourceWindows: MemorySourceWindow[];
  sourceCoverage: MemoryFormationSourceCoverage;
  nextCursor: MemoryFormationCursor;
}
interface SelectedSource {
  meta: FormationSourceMetadata;
  start: number;
  end: number;
  contentBytes: number;
  content?: string;
}
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
const contentBytes = (text: string) => bytes(text) - 2;
const identity = (
  meta: FormationSourceMetadata,
): Omit<MemoryFormationSource, "content"> => ({
  id: meta.id,
  referenceId: meta.referenceId,
  type: meta.type,
  speaker: meta.speaker,
  occurredAt: meta.occurredAt,
});
const window = (item: SelectedSource): MemorySourceWindow => ({
  sourceId: item.meta.id,
  start: item.start,
  end: item.end,
  totalLength: item.meta.length,
});

/** Reads only the current model source working set. Immutable references let
 * resume begin at a source ordinal/UTF-16 offset without replaying old bodies.
 * Every short SQLite read finishes before cancellation/event-loop yields. */
export async function* segmentMemoryEpisode(
  repository: MemoryFormationRepository,
  work: { workId: string; episode: MemoryFormationEpisode },
  budget: number,
  cursor: MemoryFormationCursor = { ordinal: 0, start: 0 },
  signal?: AbortSignal,
): AsyncIterable<MemoryFormationSegment> {
  if (!Number.isSafeInteger(budget) || budget < 1)
    throw new TypeError("Formation segment budget must be a positive integer");
  const counts = repository.sourceCounts(work.workId);
  if (!counts.primary) throw new Error("Formation work has no primary source");
  if (
    !Number.isSafeInteger(cursor.ordinal) ||
    !Number.isSafeInteger(cursor.start) ||
    cursor.ordinal < 0 ||
    cursor.start < 0 ||
    cursor.ordinal > counts.primary + counts.context
  )
    throw new RangeError("Formation cursor is outside its source references");
  const coverage = (
    items: readonly SelectedSource[],
  ): MemoryFormationSourceCoverage => {
    const context = items.filter((item) => !item.meta.primary);
    return {
      primarySourceCount: counts.primary,
      contextSourceCount: counts.context,
      includedContextSourceCount: context.length,
      omittedContextSourceCount: counts.context - context.length,
      truncatedContextSourceCount: context.filter(
        (x) => x.start > 0 || x.end < x.meta.length,
      ).length,
    };
  };
  // Same conservative plaintext shape heuristic as the full wire guard, not
  // exact token counts. Full-source JSON costs are persisted at registration.
  const cost = (items: readonly SelectedSource[]): number => {
    const primary = items.filter((x) => x.meta.primary).map((x) => x.meta.id);
    const skeleton = {
      episode: { ...work.episode, sources: [], evidenceSourceIds: [] },
      sourceWindows: [],
      sourceCoverage: coverage(items),
      existing: [],
      entities: [],
    };
    return (
      bytes(skeleton) +
      items.reduce(
        (sum, item) =>
          sum +
          bytes({ ...identity(item.meta), content: "" }) +
          item.contentBytes +
          bytes(window(item)),
        0,
      ) +
      primary.reduce((sum, id) => sum + bytes(id), 0) +
      2 * Math.max(0, items.length - 1) +
      Math.max(0, primary.length - 1) +
      256 +
      16 * (3 + 2 * items.length)
    );
  };
  const full = (meta: FormationSourceMetadata): SelectedSource => ({
    meta,
    start: 0,
    end: meta.length,
    contentBytes: meta.jsonBytes,
  });
  const read = (meta: FormationSourceMetadata, start: number, end: number) =>
    repository.sourceWindow(work.workId, meta.id, start, end);
  const pause = async () => {
    signal?.throwIfAborted();
    await setImmediate(undefined, { signal });
  };
  const finish = async (
    primary: SelectedSource[],
    nextCursor: MemoryFormationCursor,
  ): Promise<MemoryFormationSegment> => {
    let items = primary;
    const through = primary.reduce(
      (latest, x) => (x.meta.occurredAt > latest ? x.meta.occurredAt : latest),
      "",
    );
    for (const meta of repository.contextSources(work.workId, through)) {
      await pause();
      const all = full(meta);
      if (cost([...items, all]) <= budget) {
        items = [...items, all];
        continue;
      }
      // Every nonempty suffix costs at least one content byte and a window
      // whose start has at least one digit. If even that lower bound cannot
      // fit, skip its body read while retaining the same context coverage.
      if (
        cost([
          ...items,
          { meta, start: 0, end: meta.length, contentBytes: 1 },
        ]) > budget
      )
        continue;
      // JSON string bytes are at least UTF-16 length. No suffix longer than
      // budget can fit; load this bounded suffix once before exact byte search.
      const base = Math.max(0, meta.length - budget - 1);
      const text = read(meta, base, meta.length);
      const candidate = (start: number): SelectedSource => ({
        meta,
        start,
        end: meta.length,
        content: text.slice(start - base),
        contentBytes: contentBytes(text.slice(start - base)),
      });
      let low = Math.max(0, meta.length - budget),
        high = meta.length - 1,
        offset = meta.length;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (cost([...items, candidate(middle)]) <= budget) {
          offset = middle;
          high = middle - 1;
        } else low = middle + 1;
      }
      if (/[\uDC00-\uDFFF]/u.test(text[offset - base] ?? "")) offset += 1;
      const boundary = /[\n。！？!?]|\.(?=\s|$)/u.exec(
        text.slice(offset - base),
      );
      if (boundary) {
        const after = offset + boundary.index + boundary[0].length;
        if (after < meta.length) offset = after;
      }
      if (offset < meta.length && text.slice(offset - base).trim())
        items = [...items, candidate(offset)];
    }
    return {
      episode: {
        ...work.episode,
        sources: items.map((item) => ({
          ...identity(item.meta),
          content: item.content ?? read(item.meta, item.start, item.end),
        })),
        evidenceSourceIds: items
          .filter((x) => x.meta.primary)
          .map((x) => x.meta.id),
      },
      sourceWindows: items.map(window),
      sourceCoverage: coverage(items),
      nextCursor,
    };
  };
  let packed: SelectedSource[] = [];
  let packedNext: MemoryFormationCursor = { ...cursor };
  for (const meta of repository.primarySources(work.workId, cursor.ordinal)) {
    await pause();
    const sourceStart = meta.ordinal === cursor.ordinal ? cursor.start : 0;
    if (sourceStart < 0 || sourceStart >= meta.length)
      throw new Error("Formation progress is outside its primary source");
    if (sourceStart === 0 && cost([...packed, full(meta)]) <= budget) {
      packed.push(full(meta));
      packedNext = { ordinal: meta.ordinal + 1, start: 0 };
      continue;
    }
    if (packed.length) {
      yield await finish(packed, packedNext);
      packed = [];
    }
    if (sourceStart === 0 && cost([full(meta)]) <= budget) {
      packed = [full(meta)];
      packedNext = { ordinal: meta.ordinal + 1, start: 0 };
      continue;
    }
    let start = sourceStart;
    while (start < meta.length) {
      await pause();
      const readEnd = Math.min(meta.length, start + budget + 1);
      const text = read(meta, start, readEnd);
      const candidate = (end: number): SelectedSource => ({
        meta,
        start,
        end,
        content: text.slice(0, end - start),
        contentBytes: contentBytes(text.slice(0, end - start)),
      });
      let low = start + 1,
        high = Math.min(meta.length, start + budget),
        end = start;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (cost([candidate(middle)]) <= budget) {
          end = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (
        end < meta.length &&
        /[\uD800-\uDBFF]/u.test(text[end - start - 1] ?? "")
      )
        end -= 1;
      if (end <= start)
        throw new RangeError(
          "Formation budget cannot contain source metadata and one complete Unicode character",
        );
      if (end < meta.length) {
        const boundary = [
          ...text.slice(0, end - start).matchAll(/[\n。！？!?]|\.(?=\s|$)/gu),
        ].at(-1);
        if (boundary) end = start + boundary.index + boundary[0].length;
      }
      const next =
        end === meta.length
          ? { ordinal: meta.ordinal + 1, start: 0 }
          : { ordinal: meta.ordinal, start: end };
      yield await finish([candidate(end)], next);
      start = end;
    }
  }
  if (packed.length) yield await finish(packed, packedNext);
}
