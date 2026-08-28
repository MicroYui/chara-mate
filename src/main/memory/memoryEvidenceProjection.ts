import type {
  MemorySource,
  MemorySourceType,
} from "../../shared/contracts/memory";
import type { JsonValue, Timestamp } from "../../shared/contracts/primitives";

export interface MemoryEvidenceSummary {
  readonly [key: string]: JsonValue;
  readonly count: number;
  readonly firstAt?: Timestamp;
  readonly lastAt?: Timestamp;
  readonly types: MemorySourceType[];
}

export function summarizeMemoryEvidence(
  sources: readonly MemorySource[],
): MemoryEvidenceSummary {
  const timestamps = sources.map(({ createdAt }) => createdAt).sort();
  const types = [...new Set(sources.map(({ type }) => type))].sort();
  const firstAt = timestamps[0];
  const lastAt = timestamps.at(-1);
  if (!firstAt || !lastAt) {
    return { count: sources.length, types };
  }
  return {
    count: sources.length,
    firstAt,
    lastAt,
    types,
  };
}

export function formatMemoryEvidenceSummary(
  sources: readonly MemorySource[],
): string {
  const summary = summarizeMemoryEvidence(sources);
  if (summary.count === 0) return "evidence: no stored source rows";
  if (!summary.firstAt || !summary.lastAt) {
    throw new TypeError("Memory evidence timestamps are unavailable");
  }
  const span =
    summary.firstAt === summary.lastAt
      ? summary.firstAt
      : `${summary.firstAt} to ${summary.lastAt}`;
  return `evidence: ${String(summary.count)} source record(s); types: ${summary.types.join(", ")}; span: ${span}`;
}
