import { describe, expect, it } from "vitest";

import { Bm25SearchIndex } from "./bm25";

describe("BM25 search scope", () => {
  it("applies document eligibility before the result cap", () => {
    const documents = Array.from({ length: 20 }, (_, index) => ({
      id: `tool-${String(index).padStart(2, "0")}`,
      text: "current layout",
      value: index,
    }));
    const index = new Bm25SearchIndex(documents);
    const eligible = new Set(documents.slice(8).map(({ id }) => id));
    expect(index.search("current layout")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(index.search("current layout", 99, eligible)).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(index.search("current layout", 1, eligible)).toEqual([8]);
    expect(index.search("current layout", 0, eligible)).toEqual([]);
    expect(index.search("current layout", 8, new Set())).toEqual([]);
    expect(index.search("current layout", 8, new Set(["missing"]))).toEqual([]);
  });

  it("retains whole-corpus statistics and ordering when the scope is smaller", () => {
    const documents = [
      { id: "a", text: "alpha", value: "a" },
      { id: "b", text: "beta", value: "b" },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `other-${String(index)}`,
        text: "alpha",
        value: `other-${String(index)}`,
      })),
    ];
    const index = new Bm25SearchIndex(documents);
    const eligible = new Set(["a", "b"]);
    const original = index.search("alpha beta");
    expect(original.filter((id) => eligible.has(id))).toEqual(["b", "a"]);
    expect(index.search("alpha beta", 8, eligible)).toEqual(["b", "a"]);
    // A rebuilt scoped corpus loses beta's rarity and reverses this ordering.
    expect(
      new Bm25SearchIndex(documents.slice(0, 2)).search("alpha beta"),
    ).toEqual(["a", "b"]);
    expect(index.search("alpha beta")).toEqual(original);
  });
});
