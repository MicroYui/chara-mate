import { describe, expect, it } from "vitest";

import { composerAttachmentFixtures } from "./fixtures";
import {
  chatsFixtureUiReducer,
  initialChatsFixtureUiState,
  selectActiveFixtureChat,
  selectFilteredFixtureChats,
} from "./state";

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
    expect(selectActiveFixtureChat(newChat)).toBeUndefined();
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
      artifactId: composerAttachmentFixtures.file.artifact.artifactId,
      type: "composer.attachment-removed",
    });

    expect(duplicate.composerAttachments).toHaveLength(1);
    expect(removed.composerAttachments).toHaveLength(0);
  });

  it("tracks run, item and approval interactions independently", () => {
    const run = chatsFixtureUiReducer(initialChatsFixtureUiState, {
      runId: "00000000-0000-4000-8000-000000000301",
      type: "run.toggled",
    });
    const item = chatsFixtureUiReducer(run, {
      itemId: "00000000-0000-4400-8000-000000000033",
      type: "item.toggled",
    });
    const approval = chatsFixtureUiReducer(item, {
      approvalId: "00000000-0000-4000-8000-000000000501",
      decision: "approved",
      type: "approval.resolved",
    });

    expect(approval.expandedRunIds).toHaveLength(1);
    expect(approval.expandedItemIds).toHaveLength(1);
    expect(approval.resolvedApprovals).toEqual({
      "00000000-0000-4000-8000-000000000501": "approved",
    });
  });

  it("filters recent Chats without changing the active Chat", () => {
    const state = chatsFixtureUiReducer(initialChatsFixtureUiState, {
      query: "旅行",
      type: "search.changed",
    });

    expect(
      selectFilteredFixtureChats(state).map(({ record }) => record.title),
    ).toEqual(["周末旅行计划"]);
    expect(selectActiveFixtureChat(state)?.record.title).toBe("Phase 1 UI");
  });
});
