import type {
  Approval,
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

export interface FixtureModel {
  readonly displayName: string;
  readonly id: string;
  readonly provider: ProviderSnapshot;
}

export interface FixtureAttachment extends ArtifactReference {
  readonly description?: string;
}

export interface FixtureMessage {
  readonly attachments: readonly FixtureAttachment[];
  readonly record: Message;
}

export interface FixtureRun {
  readonly approvals: readonly Approval[];
  readonly items: readonly RunItem[];
  readonly record: Run;
}

export interface FixtureChat {
  readonly messages: readonly FixtureMessage[];
  readonly record: Chat;
  readonly runs: readonly FixtureRun[];
}

export interface ChatsFixtureSnapshot {
  readonly chats: readonly FixtureChat[];
  readonly models: readonly FixtureModel[];
  readonly persona: FixturePersona;
}

export type ComposerPhase = "idle" | "running" | "stopping";

export interface ComposerAttachment {
  readonly artifact: FixtureAttachment;
  readonly source: "file" | "folder" | "image" | "screenshot";
}

export interface ChatsFixtureUiState {
  readonly activeChatId: EntityId | null;
  readonly activePage: PrimaryPageId;
  readonly approvalMode: ApprovalMode;
  readonly composerAttachments: readonly ComposerAttachment[];
  readonly composerPhase: ComposerPhase;
  readonly draft: string;
  readonly expandedItemIds: readonly EntityId[];
  readonly expandedRunIds: readonly EntityId[];
  readonly mode: "chat" | "agent";
  readonly modelId: string;
  readonly resolvedApprovals: Readonly<Record<string, "approved" | "rejected">>;
  readonly searchQuery: string;
  readonly sidebarCollapsed: boolean;
}

export type ChatsFixtureUiAction =
  | { readonly type: "page.selected"; readonly page: PrimaryPageId }
  | { readonly type: "sidebar.toggled" }
  | { readonly type: "chat.selected"; readonly chatId: EntityId }
  | { readonly type: "chat.new" }
  | { readonly type: "search.changed"; readonly query: string }
  | { readonly type: "draft.changed"; readonly draft: string }
  | { readonly type: "mode.changed"; readonly mode: "chat" | "agent" }
  | { readonly type: "model.changed"; readonly modelId: string }
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
      readonly artifactId: EntityId;
    }
  | { readonly type: "run.toggled"; readonly runId: EntityId }
  | { readonly type: "item.toggled"; readonly itemId: EntityId }
  | {
      readonly type: "approval.resolved";
      readonly approvalId: EntityId;
      readonly decision: "approved" | "rejected";
    };
