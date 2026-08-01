import type { EntityId } from "../../../shared/contracts";
import { chatsFixture, chatsFixtureIds } from "./fixtures";
import type { ChatsFixtureUiAction, ChatsFixtureUiState } from "./types";

function toggleId(ids: readonly EntityId[], id: EntityId): readonly EntityId[] {
  return ids.includes(id)
    ? ids.filter((candidate) => candidate !== id)
    : [...ids, id];
}

export const initialChatsFixtureUiState: ChatsFixtureUiState = {
  activeChatId: chatsFixtureIds.designChat,
  activePage: "chats",
  approvalMode: "request_approval",
  composerAttachments: [],
  composerPhase: "idle",
  draft: "",
  expandedItemIds: [],
  expandedRunIds: [],
  mode: "agent",
  modelId: chatsFixture.models[0].id,
  resolvedApprovals: {},
  searchQuery: "",
  sidebarCollapsed: false,
};

export function chatsFixtureUiReducer(
  state: ChatsFixtureUiState,
  action: ChatsFixtureUiAction,
): ChatsFixtureUiState {
  switch (action.type) {
    case "page.selected":
      return { ...state, activePage: action.page };
    case "sidebar.toggled":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case "chat.selected":
      return {
        ...state,
        activeChatId: action.chatId,
        activePage: "chats",
        expandedItemIds: [],
        expandedRunIds: [],
      };
    case "chat.new":
      return {
        ...state,
        activeChatId: null,
        activePage: "chats",
        composerAttachments: [],
        composerPhase: "idle",
        draft: "",
        expandedItemIds: [],
        expandedRunIds: [],
        mode: "chat",
      };
    case "search.changed":
      return { ...state, searchQuery: action.query };
    case "draft.changed":
      return { ...state, draft: action.draft };
    case "mode.changed":
      return { ...state, mode: action.mode };
    case "model.changed":
      return { ...state, modelId: action.modelId };
    case "approval-mode.changed":
      return { ...state, approvalMode: action.approvalMode };
    case "composer.phase-changed":
      return { ...state, composerPhase: action.phase };
    case "composer.attachment-added":
      if (
        state.composerAttachments.some(
          ({ artifact }) =>
            artifact.artifactId === action.attachment.artifact.artifactId,
        )
      ) {
        return state;
      }
      return {
        ...state,
        composerAttachments: [...state.composerAttachments, action.attachment],
      };
    case "composer.attachment-removed":
      return {
        ...state,
        composerAttachments: state.composerAttachments.filter(
          ({ artifact }) => artifact.artifactId !== action.artifactId,
        ),
      };
    case "run.toggled":
      return {
        ...state,
        expandedRunIds: toggleId(state.expandedRunIds, action.runId),
      };
    case "item.toggled":
      return {
        ...state,
        expandedItemIds: toggleId(state.expandedItemIds, action.itemId),
      };
    case "approval.resolved":
      return {
        ...state,
        resolvedApprovals: {
          ...state.resolvedApprovals,
          [action.approvalId]: action.decision,
        },
      };
  }
}

export function selectActiveFixtureChat(state: ChatsFixtureUiState) {
  return state.activeChatId === null
    ? undefined
    : chatsFixture.chats.find(({ record }) => record.id === state.activeChatId);
}

export function selectFilteredFixtureChats(state: ChatsFixtureUiState) {
  const query = state.searchQuery.trim().toLocaleLowerCase();
  if (!query) {
    return chatsFixture.chats;
  }
  return chatsFixture.chats.filter(({ record }) =>
    record.title.toLocaleLowerCase().includes(query),
  );
}
