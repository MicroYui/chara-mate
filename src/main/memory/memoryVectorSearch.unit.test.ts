import { describe, expect, it } from "vitest";

import { searchMemoryVectors } from "./memoryVectorSearch";

describe("exact memory vector search", () => {
  it("ranks distinct revisions by their best chunk at any stream position", () => {
    const rows = [
      { id: "repeat", vector: new Float32Array([0, 1]) },
      { id: "other", vector: new Float32Array([0.8, 0.6]) },
      { id: "repeat", vector: new Float32Array([1, 0]) },
      { id: "repeat", vector: new Float32Array([-1, 0]) },
    ];
    for (let offset = 0; offset < rows.length; offset += 1) {
      const rotated = [...rows.slice(offset), ...rows.slice(0, offset)];
      const found = searchMemoryVectors(new Float32Array([1, 0]), rotated, 2);
      expect(found.map(({ id }) => id)).toEqual(["repeat", "other"]);
      expect(found[0]?.similarity).toBe(1);
    }
  });

  it("allows an evicted revision to re-enter and retains its new maximum", () => {
    const values = [
      ["a", 0.1],
      ["b", 0.3],
      ["c", 0.5],
      ["a", 0.9],
      ["b", 0.2],
      ["c", 0.7],
      ["a", 0.4],
    ] as const;
    const result = searchMemoryVectors(
      new Float32Array([1, 0]),
      values.map(([id, score]) => ({
        id,
        vector: new Float32Array([score, Math.sqrt(1 - score * score)]),
      })),
      2,
    );
    expect(result.map(({ id }) => id)).toEqual(["a", "c"]);
    expect(result[0]?.similarity).toBeCloseTo(0.9);
    expect(result[1]?.similarity).toBeCloseTo(0.7);
  });

  it("matches full max-per-revision sorting for repeat-heavy streamed data", () => {
    let seed = 0x1ac3b5;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let example = 0; example < 100; example += 1) {
      const count = 1 + Math.floor(random() * 60);
      const limit = 1 + Math.floor(random() * 20);
      const rows = Array.from({ length: 300 }, () => {
        const score = Math.floor(random() * 21) / 10 - 1;
        return {
          id: `revision-${Math.floor(random() * count)}`,
          vector: new Float32Array([score, Math.sqrt(1 - score * score)]),
        };
      });
      const maxima = new Map<string, number>();
      for (const { id, vector } of rows) {
        const score = vector[0]! / Math.hypot(...vector);
        maxima.set(id, Math.max(maxima.get(id) ?? -Infinity, score));
      }
      const expected = [...maxima]
        .map(([id, similarity]) => ({ id, similarity }))
        .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
        .slice(0, limit);
      for (const ordered of [rows, [...rows].reverse()]) {
        const actual = searchMemoryVectors(
          new Float32Array([1, 0]),
          ordered,
          limit,
        );
        expect(actual.map(({ id }) => id)).toEqual(
          expected.map(({ id }) => id),
        );
        actual.forEach((match, index) =>
          expect(match.similarity).toBeCloseTo(expected[index]!.similarity),
        );
      }
    }
  });

  it("checks cancellation for duplicate rows and closes the streaming iterator", () => {
    let consumed = 0;
    let closed = false;
    function* rows() {
      try {
        for (let index = 0; index < 10; index += 1) {
          consumed += 1;
          yield { id: "same", vector: new Float32Array([1, 0]) };
        }
      } finally {
        closed = true;
      }
    }
    expect(() =>
      searchMemoryVectors(new Float32Array([1, 0]), rows(), 2, () => {
        if (consumed === 3) throw new DOMException("cancelled", "AbortError");
      }),
    ).toThrow("cancelled");
    expect(consumed).toBe(3);
    expect(closed).toBe(true);
    for (const limit of [0, -1, 1.5, Infinity])
      expect(() =>
        searchMemoryVectors(new Float32Array([1, 0]), [], limit),
      ).toThrow();
  });

  it("ranks by cosine rather than magnitude and keeps the best streamed rows", () => {
    const matches = searchMemoryVectors(
      new Float32Array([1, 0]),
      [
        { id: "unrelated", vector: new Float32Array([0, 100]) },
        { id: "opposite", vector: new Float32Array([-1, 0]) },
        { id: "related", vector: new Float32Array([1, 1]) },
        { id: "identical", vector: new Float32Array([10, 0]) },
      ],
      2,
    );
    expect(matches.map(({ id }) => id)).toEqual(["identical", "related"]);
    expect(matches[0]?.similarity).toBe(1);
    expect(matches[1]?.similarity).toBeCloseTo(Math.SQRT1_2);
  });

  it("has stable ties independently of database iteration order", () => {
    const rows = ["z", "c", "b", "a"].map((id) => ({
      id,
      vector: new Float32Array([0.3, 0.4]),
    }));
    const query = new Float32Array([0.6, 0.8]);
    expect(searchMemoryVectors(query, rows, 2).map(({ id }) => id)).toEqual([
      "a",
      "b",
    ]);
    expect(
      searchMemoryVectors(query, rows.reverse(), 2).map(({ id }) => id),
    ).toEqual(["a", "b"]);
  });

  it("does not turn corrupt or mismatched stored embeddings into scored evidence", () => {
    const query = new Float32Array([1, 0]);
    for (const vector of [
      new Float32Array([1]),
      new Float32Array([0, 0]),
      new Float32Array([Number.NaN, 1]),
      new Float32Array([Number.POSITIVE_INFINITY, 1]),
    ]) {
      expect(() =>
        searchMemoryVectors(query, [{ id: "invalid", vector }], 2),
      ).toThrow();
    }
    expect(() => searchMemoryVectors(new Float32Array(), [], 2)).toThrow();
  });
});
