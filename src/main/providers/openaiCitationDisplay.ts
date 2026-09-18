import type {
  ResponseOutputItem,
  ResponseOutputText,
} from "openai/resources/responses/responses";

type Citation = ResponseOutputText.URLCitation;
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly links: Set<string>;
}

const CITATION_MARKER = /^\uE200cite\uE202[^\uE201]+\uE201$/u;
const LINKED_CITATION =
  /^\(\[([^\][\\&\r\n]+)\]\((https?:\/\/[^\s()<>&\\]+)\)\)$/u;

function isAlreadyLinked(
  text: string,
  range: { start: number; end: number },
  url: string,
): boolean {
  const link = LINKED_CITATION.exec(text.slice(range.start, range.end));
  if (!link || !link[1]!.trim() || link[2] !== url) return false;
  // Recognize only the observed ([label](url)) prose form. Code, escapes,
  // HTML, math, tables, images and indented blocks may prevent an apparent link
  // from being clickable; retain the source instead of parsing Markdown.
  if (/[`\\<>$~|\t]/u.test(text) || /!\[|^ {4}/mu.test(text)) return false;
  const lineStart = text.lastIndexOf("\n", range.start - 1) + 1;
  const linePrefix = text.slice(lineStart, range.start);
  return !linePrefix.includes("[") && !linePrefix.includes("]");
}

function citationLink(citation: Citation, number: number): string | undefined {
  try {
    const url = new URL(citation.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  const destination = citation.url.replace(/[<>\s\\]/gu, encodeURIComponent);
  const title = citation.title
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/[\r\n]/gu, " ");
  return `[${String(number)}](<${destination}> "${title}")`;
}

function citationRange(
  text: string,
  citation: Citation,
): { start: number; end: number } | undefined {
  const { start_index: start, end_index: end } = citation;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  )
    return undefined;
  const characters = [...text];
  const ranges = [
    ...(end <= text.length ? [{ start, end }] : []),
    ...(end <= characters.length
      ? [
          {
            start: characters.slice(0, start).join("").length,
            end: characters.slice(0, end).join("").length,
          },
        ]
      : []),
  ];
  // The SDK says "character index". Actual BMP offsets are unambiguous;
  // for non-BMP text only replace a marker when an exact range identifies it.
  const markers = ranges.filter((range) =>
    CITATION_MARKER.test(text.slice(range.start, range.end)),
  );
  if (
    markers.length &&
    markers.every((range) => range.start === markers[0]!.start)
  )
    return markers[0];
  if (
    ranges.length === 2 &&
    ranges[0]!.end === ranges[1]!.end &&
    ranges[0]!.start === ranges[1]!.start
  )
    return ranges[0];
  return undefined;
}

function materializePart(
  part: ResponseOutputText,
  numbers: Map<string, number>,
): string {
  const edits = new Map<string, Edit>();
  const unplaced = new Set<string>();
  for (const annotation of part.annotations ?? []) {
    if (annotation.type !== "url_citation") continue;
    const number = numbers.get(annotation.url) ?? numbers.size + 1;
    const link = citationLink(annotation, number);
    if (!link) continue;
    numbers.set(annotation.url, number);
    const range = citationRange(part.text, annotation);
    if (!range) {
      unplaced.add(link);
      continue;
    }
    if (isAlreadyLinked(part.text, range, annotation.url)) continue;
    // Ordinary annotated prose is retained. Only the Provider's exact marker
    // is replaced; otherwise place the source after the annotated passage.
    const start = CITATION_MARKER.test(part.text.slice(range.start, range.end))
      ? range.start
      : range.end;
    const key = `${String(start)}:${String(range.end)}`;
    const edit = edits.get(key) ?? {
      start,
      end: range.end,
      links: new Set<string>(),
    };
    edit.links.add(link);
    edits.set(key, edit);
  }
  let result = "";
  let cursor = 0;
  for (const edit of [...edits.values()].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    if (edit.start < cursor) {
      for (const link of edit.links) unplaced.add(link);
      continue;
    }
    result += part.text.slice(cursor, edit.start) + [...edit.links].join(" ");
    cursor = edit.end;
  }
  result += part.text.slice(cursor);
  return result + (unplaced.size ? ` ${[...unplaced].join(" ")}` : "");
}

/** Final display only; never mutate raw Provider text or output items.
 * Source: Responses web-search annotations, OpenAI SDK 6.49.0 (2026-09-15).
 */
export function openAIResponseDisplayText(
  output: readonly ResponseOutputItem[] | undefined,
): string | undefined {
  const numbers = new Map<string, number>();
  const parts: string[] = [];
  for (const item of output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "output_text")
        parts.push(materializePart(part, numbers));
      else if (part.type === "refusal") parts.push(part.refusal);
    }
  }
  return numbers.size ? parts.join("") : undefined;
}
