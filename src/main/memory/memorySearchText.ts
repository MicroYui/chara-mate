const segmenter = new Intl.Segmenter(["zh-CN", "en"], {
  granularity: "word",
});

function isHan(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

export function memorySearchTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const part of segmenter.segment(text.normalize("NFKC").toLowerCase())) {
    if (!part.isWordLike) continue;
    tokens.add(part.segment);
    const characters = [...part.segment];
    if (characters.length < 2 || !characters.every(isHan)) continue;
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return [...tokens];
}

export function memorySearchDocument(text: string): string {
  return memorySearchTokens(text).join(" ");
}

export function memoryMatchExpression(text: string): string | undefined {
  const terms = memorySearchTokens(text).map(
    (token) => `"${token.replaceAll('"', '""')}"`,
  );
  return terms.length === 0 ? undefined : terms.join(" OR ");
}
