export interface MemoryVectorRow {
  /** Revision identity shared by all chunks of the same memory revision. */
  readonly id: string;
  readonly vector: Float32Array;
}

export interface MemoryVectorMatch {
  readonly id: string;
  readonly similarity: number;
}

function squaredNorm(vector: Float32Array): number {
  let value = 0;
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw new TypeError("Memory embedding contains a non-finite value");
    }
    value += component * component;
  }
  if (value === 0) {
    throw new TypeError("Memory embedding has zero magnitude");
  }
  return value;
}

function compare(a: MemoryVectorMatch, b: MemoryVectorMatch): number {
  return b.similarity - a.similarity || a.id.localeCompare(b.id);
}

/** Rank revisions by their best chunk cosine using O(limit) retained state. */
export function searchMemoryVectors(
  query: Float32Array,
  rows: Iterable<MemoryVectorRow>,
  limit: number,
  checkCancellation?: () => void,
): MemoryVectorMatch[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Memory vector candidate limit must be positive");
  }
  const queryNorm = squaredNorm(query);
  // The worst retained candidate is at the root. Rows may be streamed from SQL.
  const heap: MemoryVectorMatch[] = [];
  const positions = new Map<string, number>();
  const swap = (a: number, b: number) => {
    [heap[a], heap[b]] = [heap[b]!, heap[a]!];
    positions.set(heap[a].id, a);
    positions.set(heap[b].id, b);
  };
  const siftDown = (start: number) => {
    let parent = start;
    while (true) {
      const left = parent * 2 + 1;
      if (left >= heap.length) return;
      const right = left + 1;
      const worse =
        right < heap.length && compare(heap[right]!, heap[left]!) > 0
          ? right
          : left;
      if (compare(heap[parent]!, heap[worse]!) >= 0) return;
      swap(parent, worse);
      parent = worse;
    }
  };

  checkCancellation?.();
  for (const row of rows) {
    checkCancellation?.();
    if (row.vector.length !== query.length) {
      throw new TypeError("Memory embedding dimensions do not match the query");
    }
    const norm = squaredNorm(row.vector);
    let dot = 0;
    for (let index = 0; index < query.length; index += 1) {
      dot += query[index]! * row.vector[index]!;
    }
    const match = {
      id: row.id,
      similarity: Math.max(-1, Math.min(1, dot / Math.sqrt(queryNorm * norm))),
    };
    const retained = positions.get(match.id);
    if (retained !== undefined) {
      if (compare(match, heap[retained]!) >= 0) continue;
      heap[retained] = match;
      siftDown(retained);
    } else if (heap.length < limit) {
      heap.push(match);
      let child = heap.length - 1;
      positions.set(match.id, child);
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (compare(heap[child]!, heap[parent]!) <= 0) break;
        swap(parent, child);
        child = parent;
      }
    } else if (compare(match, heap[0]!) < 0) {
      // An evicted revision needs no stored maximum: the cutoff only improves,
      // and a later better chunk can re-enter through this same comparison.
      positions.delete(heap[0]!.id);
      heap[0] = match;
      positions.set(match.id, 0);
      siftDown(0);
    }
  }
  return heap.sort(compare);
}
