import { describe, expect, it, vi } from "vitest";

import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../agent/modelProvider";
import { fallbackChatTitle, parseGeneratedChatTitle } from "./chatTitle";
import { ChatTitleService } from "./chatTitleService";

class TitleProvider implements ModelProvider {
  request: ModelRequest | undefined;

  resolveContextLimits() {
    return Promise.resolve({});
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    await Promise.resolve();
    this.request = request;
    yield { delta: "标题： “北京周末行程”", type: "text.delta" };
    yield {
      responseId: "title-response",
      type: "response.completed",
      usage: { cachedInputTokens: 0, inputTokens: 20, outputTokens: 5 },
    };
  }
}

describe("Chat title generation", () => {
  it("uses compact first-message text as the bounded fallback", () => {
    expect(fallbackChatTitle("  帮我规划北京\n周末行程  ")).toBe(
      "帮我规划北京 周末行程",
    );
    expect(fallbackChatTitle()).toBe("新对话");
    expect(fallbackChatTitle("长".repeat(100))).toHaveLength(80);
  });

  it("accepts only the first plain title line", () => {
    expect(parseGeneratedChatTitle("## 标题：`北京周末行程`\n补充说明")).toBe(
      "北京周末行程",
    );
    expect(parseGeneratedChatTitle("\n \n")).toBeUndefined();
  });

  it("requests a tool-free summary and conditionally replaces the fallback", async () => {
    const provider = new TitleProvider();
    const replaceGeneratedTitle = vi.fn();
    const warn = vi.fn();
    const service = new ChatTitleService({ replaceGeneratedTitle }, { warn });

    await service.generate({
      assistantContent: "可以安排颐和园、故宫和景山。",
      chatId: "11111111-1111-4111-8111-111111111111",
      firstUserContent: "帮我规划北京周末行程",
      modelId: "gpt-chat",
      provider,
      signal: new AbortController().signal,
    });

    expect(provider.request).toMatchObject({
      maxOutputTokens: 128,
      modelId: "gpt-chat",
      toolNamespaces: [],
    });
    expect(provider.request?.instructions).toContain(
      "Generate one concise chat title",
    );
    expect(replaceGeneratedTitle).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "帮我规划北京周末行程",
      "北京周末行程",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the fallback when title generation fails", async () => {
    const replaceGeneratedTitle = vi.fn();
    const warn = vi.fn();
    const service = new ChatTitleService({ replaceGeneratedTitle }, { warn });
    const provider: ModelProvider = {
      resolveContextLimits: () => Promise.resolve({}),
      stream: () => {
        throw new Error("title endpoint unavailable");
      },
    };

    await expect(
      service.generate({
        assistantContent: "首轮回答",
        chatId: "11111111-1111-4111-8111-111111111111",
        firstUserContent: "保留这条兜底标题",
        modelId: "gpt-chat",
        provider,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();

    expect(replaceGeneratedTitle).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "CHAT_TITLE_GENERATION_FAILED",
      expect.objectContaining({
        chatId: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });
});
