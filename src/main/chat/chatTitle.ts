export const DEFAULT_CHAT_TITLE = "新对话";

const MAX_CHAT_TITLE_LENGTH = 80;

function compact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function clamp(value: string): string {
  const characters = [...value];
  if (characters.length <= MAX_CHAT_TITLE_LENGTH) return value;
  return `${characters.slice(0, MAX_CHAT_TITLE_LENGTH - 1).join("")}…`;
}

export function fallbackChatTitle(firstMessage?: string): string {
  const title = compact(firstMessage ?? "");
  return title ? clamp(title) : DEFAULT_CHAT_TITLE;
}

export function parseGeneratedChatTitle(output: string): string | undefined {
  const firstLine = output.split(/\r?\n/u).map(compact).find(Boolean);
  if (!firstLine) return undefined;

  const title = compact(
    firstLine
      .replace(/^#{1,6}\s*/u, "")
      .replace(/^[-*]\s*/u, "")
      .replace(/^(?:标题|title)\s*[:：]\s*/iu, "")
      .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/gu, ""),
  );
  return title ? clamp(title) : undefined;
}
