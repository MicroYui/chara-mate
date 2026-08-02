import type { EntityId } from "../../../shared/contracts";
import type { ChatsUiAction, ChatsUiState } from "./types";

function toggleId(ids: readonly EntityId[], id: EntityId): readonly EntityId[] {
  return ids.includes(id)
    ? ids.filter((candidate) => candidate !== id)
    : [...ids, id];
}

export const initialChatsUiState: ChatsUiState = {
  activeChatId: null,
  activePage: "chats",
  approvalMode: "request_approval",
  chatListStatus: "active",
  composerAttachments: [],
  composerPhase: "idle",
  draft: "",
  expandedItemIds: [],
  expandedRunIds: [],
  mode: "chat",
  modelId: undefined,
  resolvedApprovals: {},
  searchQuery: "",
  sidebarCollapsed: false,
};

export function chatsUiReducer(
  state: ChatsUiState,
  action: ChatsUiAction,
): ChatsUiState {
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
    case "chat-list-status.changed":
      return {
        ...state,
        activeChatId: null,
        chatListStatus: action.status,
        expandedItemIds: [],
        expandedRunIds: [],
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
        state.composerAttachments.some(({ id }) => id === action.attachment.id)
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
          ({ id }) => id !== action.attachmentId,
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

export const initialChatsFixtureUiState = initialChatsUiState;
export const chatsFixtureUiReducer = chatsUiReducer;
