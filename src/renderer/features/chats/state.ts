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
  defaultApprovalMode: "request_approval",
  defaultMode: "chat",
  draft: "",
  expandedItemIds: [],
  expandedRunIds: [],
  isDraftChat: false,
  mode: "chat",
  modelId: undefined,
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
    case "approval.focused":
      return {
        ...state,
        activeChatId: action.target.chatId,
        activePage: "chats",
        chatListStatus: "active",
        expandedItemIds: [action.target.itemId],
        expandedRunIds: [action.target.runId],
        isDraftChat: false,
      };
    case "automation-run.focused":
      return {
        ...state,
        activeChatId: action.chatId,
        activePage: "chats",
        chatListStatus: "active",
        expandedItemIds: [],
        expandedRunIds: action.runId ? [action.runId] : [],
        isDraftChat: false,
        searchQuery: "",
      };
    case "settings.defaults-loaded":
      return {
        ...state,
        approvalMode: action.approvalMode,
        defaultApprovalMode: action.approvalMode,
        defaultMode: action.mode,
        mode: action.mode,
      };
    case "sidebar.toggled":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case "chat.selected":
      return {
        ...state,
        activeChatId: action.chatId,
        activePage: "chats",
        expandedItemIds: [],
        expandedRunIds: [],
        isDraftChat: false,
      };
    case "chat.new":
      return {
        ...state,
        activeChatId: null,
        activePage: "chats",
        chatListStatus: "active",
        composerAttachments: [],
        composerPhase: "idle",
        draft: "",
        expandedItemIds: [],
        expandedRunIds: [],
        isDraftChat: true,
        approvalMode: state.defaultApprovalMode,
        mode: state.defaultMode,
        searchQuery: "",
      };
    case "chat.selection-cleared":
      return {
        ...state,
        activeChatId: null,
        composerAttachments: [],
        composerPhase: "idle",
        draft: "",
        expandedItemIds: [],
        expandedRunIds: [],
        isDraftChat: false,
        approvalMode: state.defaultApprovalMode,
        mode: state.defaultMode,
      };
    case "chat-list-status.changed":
      return {
        ...state,
        activeChatId: null,
        chatListStatus: action.status,
        expandedItemIds: [],
        expandedRunIds: [],
        isDraftChat: false,
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
  }
}

export const initialChatsFixtureUiState = initialChatsUiState;
export const chatsFixtureUiReducer = chatsUiReducer;
