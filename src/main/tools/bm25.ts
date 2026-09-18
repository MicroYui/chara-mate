export interface SearchDocument<TValue> {
  readonly id: string;
  readonly text: string;
  readonly value: TValue;
}

interface IndexedDocument<TValue> extends SearchDocument<TValue> {
  readonly frequencies: ReadonlyMap<string, number>;
  readonly length: number;
}

const K1 = 1.2;
const B = 0.75;

function stem(token: string): string {
  if (token.length <= 3) return token;
  for (const suffix of ["ingly", "edly", "ing", "ed", "ies", "es", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return suffix === "ies"
        ? `${token.slice(0, -suffix.length)}y`
        : token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function tokenizeToolMetadata(input: string): string[] {
  return input
    .normalize("NFKC")
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stem);
}

export class Bm25SearchIndex<TValue> {
  readonly #averageLength: number;
  readonly #documentFrequency = new Map<string, number>();
  readonly #documents: readonly IndexedDocument<TValue>[];

  constructor(documents: readonly SearchDocument<TValue>[]) {
    this.#documents = documents.map((document) => {
      const tokens = tokenizeToolMetadata(document.text);
      const frequencies = new Map<string, number>();
      for (const token of tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }
      for (const token of frequencies.keys()) {
        this.#documentFrequency.set(
          token,
          (this.#documentFrequency.get(token) ?? 0) + 1,
        );
      }
      return { ...document, frequencies, length: tokens.length };
    });
    this.#averageLength =
      this.#documents.length === 0
        ? 1
        : this.#documents.reduce(
            (total, document) => total + document.length,
            0,
          ) / this.#documents.length;
  }

  search(
    query: string,
    limit = 8,
    eligibleIds?: ReadonlySet<string>,
  ): TValue[] {
    const tokens = [...new Set(tokenizeToolMetadata(query))];
    const count = this.#documents.length;
    if (tokens.length === 0 || count === 0) return [];

    return (
      this.#documents
        // Eligibility narrows results, not the corpus statistics used to rank them.
        .filter((document) => eligibleIds?.has(document.id) ?? true)
        .map((document) => {
          let score = 0;
          for (const token of tokens) {
            const frequency = document.frequencies.get(token) ?? 0;
            if (frequency === 0) continue;
            const containing = this.#documentFrequency.get(token) ?? 0;
            const inverseFrequency = Math.log(
              1 + (count - containing + 0.5) / (containing + 0.5),
            );
            const lengthNormalization =
              frequency +
              K1 * (1 - B + (B * document.length) / this.#averageLength);
            score +=
              inverseFrequency * ((frequency * (K1 + 1)) / lengthNormalization);
          }
          return { document, score };
        })
        .filter(({ score }) => score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.document.id.localeCompare(right.document.id),
        )
        .slice(0, Math.max(0, Math.min(8, limit)))
        .map(({ document }) => document.value)
    );
  }
}
