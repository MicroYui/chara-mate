import type {
  Approval,
  ApprovalNavigationTarget,
  ApprovalMode,
  ArtifactReference,
  Chat,
  EntityId,
  Message,
  ProviderSnapshot,
  Run,
  RunItem,
} from "../../../shared/contracts";

export type PrimaryPageId =
  "chats" | "territory" | "memory" | "activity" | "automations" | "settings";

export interface FixturePersona {
  readonly accent: string;
  readonly displayName: string;
  readonly id: EntityId;
  readonly imageSource: string;
  readonly initials: string;
  readonly styleName: string;
}

export interface ChatModelOption {
  readonly displayName: string;
  readonly id: string;
  readonly provider: ProviderSnapshot;
}

export interface ChatAttachmentView extends ArtifactReference {
  readonly description?: string;
}

export interface ChatMessageView {
  readonly attachments: readonly ChatAttachmentView[];
  readonly record: Message;
}

export interface ChatRunView {
  readonly approvals: readonly Approval[];
  readonly items: readonly RunItem[];
  readonly record: Run;
}

export interface ChatView {
  readonly messages: readonly ChatMessageView[];
  readonly record: Chat;
  readonly runs: readonly ChatRunView[];
}

export type FixtureModel = ChatModelOption;
export type FixtureAttachment = ChatAttachmentView;
export type FixtureMessage = ChatMessageView;
export type FixtureRun = ChatRunView;
export type FixtureChat = ChatView;

export interface ChatsFixtureSnapshot {
  readonly chats: readonly ChatView[];
  readonly models: readonly ChatModelOption[];
  readonly persona: FixturePersona;
}

export type ComposerPhase = "idle" | "running" | "stopping";

export interface ComposerAttachment {
  readonly byteLength?: number;
  readonly displayName: string;
  readonly id: EntityId;
  readonly mediaType?: string;
  readonly source: "file" | "folder" | "image" | "screenshot";
  readonly storageKey: string;
}

export interface ChatsUiState {
  readonly activeChatId: EntityId | null;
  readonly activePage: PrimaryPageId;
  readonly approvalMode: ApprovalMode;
  readonly chatListStatus: "active" | "archived";
  readonly composerAttachments: readonly ComposerAttachment[];
  readonly composerPhase: ComposerPhase;
  readonly defaultApprovalMode: ApprovalMode;
  readonly defaultMode: "chat" | "agent";
  readonly draft: string;
  readonly expandedItemIds: readonly EntityId[];
  readonly expandedRunIds: readonly EntityId[];
  readonly mode: "chat" | "agent";
  readonly modelId: string | undefined;
  readonly searchQuery: string;
  readonly sidebarCollapsed: boolean;
}

export type ChatsUiAction =
  | { readonly type: "page.selected"; readonly page: PrimaryPageId }
  | { readonly type: "sidebar.toggled" }
  | { readonly type: "chat.selected"; readonly chatId: EntityId }
  | { readonly type: "chat.new" }
  | {
      readonly type: "chat-list-status.changed";
      readonly status: "active" | "archived";
    }
  | { readonly type: "search.changed"; readonly query: string }
  | { readonly type: "draft.changed"; readonly draft: string }
  | { readonly type: "mode.changed"; readonly mode: "chat" | "agent" }
  | {
      readonly type: "model.changed";
      readonly modelId: string | undefined;
    }
  | {
      readonly type: "approval-mode.changed";
      readonly approvalMode: ApprovalMode;
    }
  | { readonly type: "composer.phase-changed"; readonly phase: ComposerPhase }
  | {
      readonly type: "composer.attachment-added";
      readonly attachment: ComposerAttachment;
    }
  | {
      readonly type: "composer.attachment-removed";
      readonly attachmentId: EntityId;
    }
  | { readonly type: "run.toggled"; readonly runId: EntityId }
  | { readonly type: "item.toggled"; readonly itemId: EntityId }
  | {
      readonly approvalMode: ApprovalMode;
      readonly mode: "chat" | "agent";
      readonly type: "settings.defaults-loaded";
    }
  | {
      readonly type: "approval.focused";
      readonly target: ApprovalNavigationTarget;
    };

export type ChatsFixtureUiState = ChatsUiState;
export type ChatsFixtureUiAction = ChatsUiAction;
