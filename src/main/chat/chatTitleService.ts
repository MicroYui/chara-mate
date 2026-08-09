import type { JsonValue } from "../../shared/contracts/primitives";
import { collectModelTurn, type ModelProvider } from "../agent/modelProvider";
import type { AppLogger } from "../observability/logger";
import type { ChatService } from "./chatService";
import { fallbackChatTitle, parseGeneratedChatTitle } from "./chatTitle";

export interface ChatTitleGenerationRequest {
  readonly assistantContent: string;
  readonly chatId: string;
  readonly firstUserContent: string;
  readonly modelId: string;
  readonly provider: ModelProvider;
  readonly signal: AbortSignal;
}

export interface ChatTitleGenerator {
  generate(request: ChatTitleGenerationRequest): Promise<void>;
}

const TITLE_INSTRUCTIONS = [
  "Generate one concise chat title that summarizes the conversation.",
  "Use the same language as the user.",
  "Return only the title as a single plain-text line, without quotes, Markdown, or explanation.",
].join(" ");

export class ChatTitleService implements ChatTitleGenerator {
  constructor(
    private readonly chats: Pick<ChatService, "replaceGeneratedTitle">,
    private readonly logger: Pick<AppLogger, "warn">,
  ) {}

  async generate(request: ChatTitleGenerationRequest): Promise<void> {
    const expectedTitle = fallbackChatTitle(request.firstUserContent);
    try {
      const input: JsonValue[] = [
        {
          content: request.firstUserContent,
          role: "user",
          type: "message",
        },
        {
          content: request.assistantContent,
          role: "assistant",
          type: "message",
        },
      ];
      const turn = await collectModelTurn(
        request.provider.stream(
          {
            input,
            instructions: TITLE_INSTRUCTIONS,
            maxOutputTokens: 128,
            modelId: request.modelId,
            nativeWebSearch: false,
            toolNamespaces: [],
          },
          request.signal,
        ),
      );
      const generatedTitle = parseGeneratedChatTitle(turn.text);
      if (!generatedTitle || generatedTitle === expectedTitle) return;
      this.chats.replaceGeneratedTitle(
        request.chatId,
        expectedTitle,
        generatedTitle,
      );
    } catch (error) {
      if (request.signal.aborted) return;
      this.logger.warn("CHAT_TITLE_GENERATION_FAILED", {
        chatId: request.chatId,
        error,
      });
    }
  }
}
