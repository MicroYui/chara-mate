import { describe, expect, it } from "vitest";

import { composerAttachmentFixtures } from "./fixtures";
import { chatsFixtureUiReducer, initialChatsFixtureUiState } from "./state";

describe("Chats fixture UI state", () => {
  it("keeps the draft when switching between Chat and Agent", () => {
    const withDraft = chatsFixtureUiReducer(initialChatsFixtureUiState, {
      draft: "保留这段输入",
      type: "draft.changed",
    });
    const chatMode = chatsFixtureUiReducer(withDraft, {
      mode: "chat",
      type: "mode.changed",
    });

    expect(chatMode.mode).toBe("chat");
    expect(chatMode.draft).toBe("保留这段输入");
  });

  it("opens a clean Chat draft without leaking the previous projection", () => {
    const expanded = chatsFixtureUiReducer(initialChatsFixtureUiState, {
      runId: "00000000-0000-4000-8000-000000000301",
      type: "run.toggled",
    });
    const newChat = chatsFixtureUiReducer(
      { ...expanded, draft: "old draft" },
      { type: "chat.new" },
    );

    expect(newChat).toMatchObject({
      activeChatId: null,
      activePage: "chats",
      draft: "",
      expandedRunIds: [],
      mode: "chat",
    });
    expect(newChat.activeChatId).toBeNull();
  });

  it("adds each attachment once and removes it by artifact ID", () => {
    const withFile = chatsFixtureUiReducer(initialChatsFixtureUiState, {
      attachment: composerAttachmentFixtures.file,
      type: "composer.attachment-added",
    });
    const duplicate = chatsFixtureUiReducer(withFile, {
      attachment: composerAttachmentFixtures.file,
      type: "composer.attachment-added",
    });
    const removed = chatsFixtureUiReducer(duplicate, {
      attachmentId: composerAttachmentFixtures.file.id,
      type: "composer.attachment-removed",
    });

    expect(duplicate.composerAttachments).toHaveLength(1);
    expect(removed.composerAttachments).toHaveLength(0);
  });

  it("tracks local run and item expansion without duplicating approval truth", () => {
    const run = chatsFixtureUiReducer(initialChatsFixtureUiState, {
      runId: "00000000-0000-4000-8000-000000000301",
      type: "run.toggled",
    });
    const item = chatsFixtureUiReducer(run, {
      itemId: "00000000-0000-4400-8000-000000000033",
      type: "item.toggled",
    });
    expect(item.expandedRunIds).toHaveLength(1);
    expect(item.expandedItemIds).toHaveLength(1);
  });

  it("changes the repository-backed Chat list scope and clears the selection", () => {
    const state = chatsFixtureUiReducer(initialChatsFixtureUiState, {
      status: "archived",
      type: "chat-list-status.changed",
    });

    expect(state.chatListStatus).toBe("archived");
    expect(state.activeChatId).toBeNull();
  });
});
