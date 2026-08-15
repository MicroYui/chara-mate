import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  Archive,
  ArchiveRestore,
  Brain,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  HeartHandshake,
  Map,
  MessageCircle,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";

import type { Chat } from "../../shared/contracts/chat";
import type { FoundationSnapshot } from "../../shared/contracts/foundation";
import type { JourneySnapshot } from "../../shared/contracts/journey";
import type { MemorySource } from "../../shared/contracts/memory";
import type { PetDescriptor } from "../../shared/contracts/pet";
import type { AgentSettings } from "../../shared/contracts/settings";
import type { UserInputResolution } from "../../shared/contracts/run";
import type { VoiceSessionSnapshot } from "../../shared/contracts/voice";
import type { ChatDomainState } from "../features/chats/chatStore";
import { ChatsPage } from "../features/chats/ChatsPage";
import { ProviderSettingsPanel } from "../features/settings/ProviderSettingsPanel";
import { CharacterSettingsPanel } from "../features/settings/CharacterSettingsPanel";
import { AgentSettingsPanel } from "../features/settings/AgentSettingsPanel";
import { BrowserComputerSettingsPanel } from "../features/settings/BrowserComputerSettingsPanel";
import { ActivitySettingsPanel } from "../features/settings/ActivitySettingsPanel";
import { DataSettingsPanel } from "../features/settings/DataSettingsPanel";
import { McpSettingsPanel } from "../features/settings/McpSettingsPanel";
import { SkillsSettingsPanel } from "../features/settings/SkillsSettingsPanel";
import { VoiceSettingsPanel } from "../features/settings/VoiceSettingsPanel";
import { TerritoryPage } from "../features/territory/TerritoryPage";
import { MemoryPage } from "../features/memory/MemoryPage";
import { ActivityPage } from "../features/activity/ActivityPage";
import { AutomationsPage } from "../features/automations/AutomationsPage";
import type { VoiceStore, VoiceUiState } from "../features/voice/voiceStore";
import type {
  ChatView,
  ChatsUiAction,
  ChatsUiState,
  PrimaryPageId,
} from "../features/chats/types";
import mikaPetImage from "../assets/mika-pet.svg";
import {
  backgroundSchemes,
  defaultCustomBackgroundColors,
  themePreferences,
  type BackgroundScheme,
  type CustomBackgroundColors,
  type ThemePreference,
} from "./appearance";
import styles from "./AppShell.module.css";

const pageItems = [
  { icon: MessageCircle, id: "chats", label: "Chats" },
  { icon: Map, id: "territory", label: "Territory" },
  { icon: Brain, id: "memory", label: "Memory" },
  { icon: Activity, id: "activity", label: "Activity" },
  { icon: CalendarClock, id: "automations", label: "Automations" },
] as const satisfies readonly {
  readonly icon: typeof MessageCircle;
  readonly id: Exclude<PrimaryPageId, "settings">;
  readonly label: string;
}[];

const currentPersona = {
  id: "00000000-0000-4000-8000-000000000701",
  label: "Mika",
} as const;

interface AppShellProps {
  readonly activeChat: ChatView | undefined;
  readonly activePet: PetDescriptor | undefined;
  readonly backgroundScheme: BackgroundScheme;
  readonly customBackgroundColors: CustomBackgroundColors;
  readonly themePreference: ThemePreference;
  readonly chatDomain: ChatDomainState;
  readonly dispatch: Dispatch<ChatsUiAction>;
  readonly foundation: FoundationSnapshot;
  readonly journeyError: string | null;
  readonly journeySnapshot: JourneySnapshot;
  readonly onChatArchive: (chatId: string) => void;
  readonly onChatCreate: () => void;
  readonly onChatDelete: (chatId: string) => void;
  readonly onChatRename: (chatId: string, title: string) => void;
  readonly onChatRestore: (chatId: string) => void;
  readonly onChatSetPinned: (chatId: string, pinned: boolean) => void;
  readonly onClearChatError: () => void;
  readonly onClearJourneyError: () => void;
  readonly onClearVoiceError: () => void;
  readonly onBackgroundSchemeChange: (scheme: BackgroundScheme) => void;
  readonly onCustomBackgroundColorsChange: (
    colors: CustomBackgroundColors,
  ) => void;
  readonly onThemePreferenceChange: (theme: ThemePreference) => void;
  readonly onAgentSettingsChanged: (settings: AgentSettings) => void;
  readonly onConfigureModels: () => void;
  readonly onProvidersChanged: () => void;
  readonly onSettingsOpen: () => void;
  readonly onResolveApproval: (
    approvalId: string,
    decision: "approved" | "rejected",
  ) => void;
  readonly onResolveUserInput: (
    runId: string,
    itemId: string,
    resolution: UserInputResolution,
  ) => Promise<void>;
  readonly onRunResume: (runId: string) => void;
  readonly onRunSend: () => void;
  readonly onRunStop: () => void;
  readonly onVoiceEnd: () => void;
  readonly onVoiceMutedChange: (muted: boolean) => void;
  readonly onVoicePausedChange: (paused: boolean) => void;
  readonly onVoiceRetry: () => void;
  readonly onVoiceStart: () => void;
  readonly petAnimationSpeed: number;
  readonly state: ChatsUiState;
  readonly settingsSectionTarget: "appearance" | "character" | "models";
  readonly voiceSnapshot: VoiceSessionSnapshot | null;
  readonly voiceStore: VoiceStore;
  readonly voiceError: VoiceUiState["error"];
}

interface SidebarButtonProps {
  readonly active: boolean;
  readonly children: ReactNode;
  readonly collapsed: boolean;
  readonly icon: typeof MessageCircle;
  readonly label: string;
  readonly onClick: () => void;
}

interface ChatActionMenuItemsProps {
  readonly chat: Chat;
  readonly includeArchive: boolean;
  readonly onChatArchive: (chatId: string) => void;
  readonly onChatDelete: (chatId: string) => void;
  readonly onChatRenameRequest: (chat: Chat) => void;
  readonly onChatRestore: (chatId: string) => void;
  readonly onChatSetPinned: (chatId: string, pinned: boolean) => void;
}

function ChatActionMenuItems({
  chat,
  includeArchive,
  onChatArchive,
  onChatDelete,
  onChatRenameRequest,
  onChatRestore,
  onChatSetPinned,
}: ChatActionMenuItemsProps) {
  const confirmDelete = () => {
    if (window.confirm(`确定删除“${chat.title}”吗？此操作无法撤销。`)) {
      onChatDelete(chat.id);
    }
  };

  return (
    <>
      <DropdownMenu.Item onSelect={() => onChatRenameRequest(chat)}>
        <Pencil aria-hidden="true" size={14} />
        重命名
      </DropdownMenu.Item>
      <DropdownMenu.Item
        onSelect={() => onChatSetPinned(chat.id, !chat.pinnedAt)}
      >
        {chat.pinnedAt ? (
          <PinOff aria-hidden="true" size={14} />
        ) : (
          <Pin aria-hidden="true" size={14} />
        )}
        {chat.pinnedAt ? "取消置顶" : "置顶"}
      </DropdownMenu.Item>
      {includeArchive ? (
        <DropdownMenu.Item
          onSelect={() =>
            chat.status === "archived"
              ? onChatRestore(chat.id)
              : onChatArchive(chat.id)
          }
        >
          {chat.status === "archived" ? (
            <ArchiveRestore aria-hidden="true" size={14} />
          ) : (
            <Archive aria-hidden="true" size={14} />
          )}
          {chat.status === "archived" ? "恢复" : "归档"}
        </DropdownMenu.Item>
      ) : null}
      <DropdownMenu.Separator />
      <DropdownMenu.Item
        className={styles["dangerMenuItem"]}
        onSelect={confirmDelete}
      >
        <Trash2 aria-hidden="true" size={14} />
        删除
      </DropdownMenu.Item>
    </>
  );
}

function SidebarButton({
  active,
  children,
  collapsed,
  icon: Icon,
  label,
  onClick,
}: SidebarButtonProps) {
  return (
    <button
      className={styles["sidebarButton"]}
      data-active={active || undefined}
      type="button"
      aria-label={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      onClick={onClick}
    >
      <Icon aria-hidden="true" size={17} strokeWidth={1.75} />
      {collapsed ? null : children}
    </button>
  );
}

function Sidebar({
  activePet,
  chatDomain,
  dispatch,
  onChatArchive,
  onChatCreate,
  onChatDelete,
  onChatRename,
  onChatRestore,
  onChatSetPinned,
  onSettingsOpen,
  state,
}: Pick<
  AppShellProps,
  | "activePet"
  | "chatDomain"
  | "dispatch"
  | "onChatArchive"
  | "onChatCreate"
  | "onChatDelete"
  | "onChatRename"
  | "onChatRestore"
  | "onChatSetPinned"
  | "onSettingsOpen"
  | "state"
>) {
  const chats = chatDomain.chats;
  const collapsed = state.sidebarCollapsed;
  const renameCancelled = useRef(false);
  const contextMenuRestoreFocus = useRef(true);
  const contextMenuSource = useRef<HTMLButtonElement | null>(null);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    readonly chat: Chat;
    readonly left: number;
    readonly top: number;
  } | null>(null);

  const openContextMenu = (
    chat: Chat,
    left: number,
    top: number,
    source: HTMLButtonElement,
  ) => {
    dispatch({ chatId: chat.id, type: "chat.selected" });
    contextMenuRestoreFocus.current = true;
    contextMenuSource.current = source;
    setContextMenu({ chat, left, top });
  };

  const beginChatRename = (chat: Chat) => {
    renameCancelled.current = false;
    setEditingChatId(chat.id);
    setTitleDraft(chat.title);
  };

  const commitChatRename = (chat: Chat) => {
    if (renameCancelled.current) {
      renameCancelled.current = false;
      setEditingChatId(null);
      return;
    }
    const title = titleDraft.trim();
    if (title && title !== chat.title) {
      onChatRename(chat.id, title);
    }
    setEditingChatId(null);
  };

  return (
    <aside
      className={styles["sidebar"]}
      data-collapsed={collapsed || undefined}
    >
      <div className={styles["sidebarDragRegion"]} />
      <div className={styles["brandRow"]}>
        <div className={styles["brandMark"]}>
          {activePet ? (
            <span
              aria-label={`${activePet.displayName} 桌宠缩略图`}
              className={styles["brandPetThumbnail"]}
              role="img"
              style={{
                backgroundImage: `url("${activePet.spriteUrl}")`,
                backgroundSize: `800% ${String(
                  (activePet.spriteVersionNumber === 2 ? 11 : 9) * 100,
                )}%`,
              }}
            />
          ) : (
            <img src={mikaPetImage} alt="Mika 桌宠" />
          )}
        </div>
        {collapsed ? null : <strong>CharaMate</strong>}
      </div>

      <button
        className={styles["newChat"]}
        type="button"
        aria-label="新建对话"
        onClick={onChatCreate}
      >
        <SquarePen aria-hidden="true" size={17} />
        {collapsed ? null : <span>新建对话</span>}
      </button>

      <nav className={styles["primaryNav"]} aria-label="主要页面">
        {pageItems.map(({ icon, id, label }) => (
          <SidebarButton
            key={id}
            active={state.activePage === id}
            collapsed={collapsed}
            icon={icon}
            label={label}
            onClick={() => dispatch({ page: id, type: "page.selected" })}
          >
            <span>{label}</span>
          </SidebarButton>
        ))}
      </nav>

      {!collapsed && state.activePage === "chats" ? (
        <section className={styles["chatNavigation"]} aria-label="会话列表">
          <label className={styles["searchField"]}>
            <Search aria-hidden="true" size={14} />
            <span className={styles["visuallyHidden"]}>搜索会话</span>
            <input
              type="search"
              value={state.searchQuery}
              placeholder="搜索"
              onChange={(event) =>
                dispatch({
                  query: event.currentTarget.value,
                  type: "search.changed",
                })
              }
            />
          </label>
          {state.chatListStatus === "active" ? (
            <p className={styles["sectionLabel"]}>最近对话</p>
          ) : null}
          <div className={styles["chatScopes"]} aria-label="会话范围">
            <button
              type="button"
              aria-current={
                state.chatListStatus === "active" ? "page" : undefined
              }
              onClick={() =>
                dispatch({
                  status: "active",
                  type: "chat-list-status.changed",
                })
              }
            >
              最近
            </button>
            <button
              type="button"
              aria-current={
                state.chatListStatus === "archived" ? "page" : undefined
              }
              onClick={() =>
                dispatch({
                  status: "archived",
                  type: "chat-list-status.changed",
                })
              }
            >
              已归档
            </button>
          </div>
          <div className={styles["chatLinks"]}>
            {chats.map((record) =>
              editingChatId === record.id ? (
                <input
                  key={record.id}
                  autoFocus
                  aria-label="会话标题"
                  className={styles["chatTitleInput"]}
                  value={titleDraft}
                  onBlur={() => commitChatRename(record)}
                  onChange={(event) => setTitleDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitChatRename(record);
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      renameCancelled.current = true;
                      setEditingChatId(null);
                    }
                  }}
                />
              ) : (
                <button
                  key={record.id}
                  type="button"
                  aria-haspopup="menu"
                  data-active={record.id === state.activeChatId || undefined}
                  onClick={() =>
                    dispatch({ chatId: record.id, type: "chat.selected" })
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openContextMenu(
                      record,
                      event.clientX,
                      event.clientY,
                      event.currentTarget,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key !== "ContextMenu" &&
                      !(event.shiftKey && event.key === "F10")
                    ) {
                      return;
                    }
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    openContextMenu(
                      record,
                      bounds.left + 16,
                      bounds.bottom - 4,
                      event.currentTarget,
                    );
                  }}
                >
                  <span>{record.title}</span>
                  {record.pinnedAt ? (
                    <Pin aria-label="已置顶" size={11} />
                  ) : null}
                </button>
              ),
            )}
            {chats.length === 0 ? (
              <p className={styles["emptySearch"]}>
                {chatDomain.status === "loading"
                  ? "正在加载…"
                  : state.searchQuery.trim()
                    ? "没有匹配的会话"
                    : state.chatListStatus === "archived"
                      ? "没有已归档会话"
                      : "还没有会话"}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      <DropdownMenu.Root
        modal={false}
        open={contextMenu !== null}
        onOpenChange={(open) => {
          if (!open) setContextMenu(null);
        }}
      >
        <DropdownMenu.Trigger
          aria-hidden="true"
          className={styles["contextMenuAnchor"]}
          style={{
            left: contextMenu?.left ?? 0,
            top: contextMenu?.top ?? 0,
          }}
          tabIndex={-1}
          type="button"
        />
        {contextMenu ? (
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              aria-label={`${contextMenu.chat.title} 会话操作`}
              className={styles["headerMenu"]}
              collisionPadding={8}
              sideOffset={2}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                if (
                  contextMenuRestoreFocus.current &&
                  contextMenuSource.current?.isConnected
                ) {
                  contextMenuSource.current.focus();
                }
              }}
            >
              <ChatActionMenuItems
                chat={contextMenu.chat}
                includeArchive
                onChatArchive={onChatArchive}
                onChatDelete={onChatDelete}
                onChatRenameRequest={(chat) => {
                  contextMenuRestoreFocus.current = false;
                  beginChatRename(chat);
                }}
                onChatRestore={onChatRestore}
                onChatSetPinned={onChatSetPinned}
              />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        ) : null}
      </DropdownMenu.Root>

      <div className={styles["sidebarFooter"]}>
        {!collapsed ? (
          <div className={styles["persona"]}>
            <span>Mika</span>
            <small>元气开朗</small>
          </div>
        ) : null}
        <div className={styles["footerActions"]}>
          <SidebarButton
            active={state.activePage === "settings"}
            collapsed={collapsed}
            icon={Settings}
            label="Settings"
            onClick={() => {
              onSettingsOpen();
              dispatch({ page: "settings", type: "page.selected" });
            }}
          >
            <span>Settings</span>
          </SidebarButton>
          <button
            className={styles["collapseButton"]}
            type="button"
            aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
            onClick={() => dispatch({ type: "sidebar.toggled" })}
          >
            {collapsed ? (
              <ChevronRight aria-hidden="true" size={16} />
            ) : (
              <ChevronLeft aria-hidden="true" size={16} />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}

function SharedPresenceHint({
  dispatch,
  journeySnapshot,
  onNaturalCorrection,
  state,
}: Pick<AppShellProps, "dispatch" | "journeySnapshot" | "state"> & {
  readonly onNaturalCorrection: (chatId: string, title: string) => void;
}) {
  const session = journeySnapshot.activeSession;
  if (!session) return null;
  const showingSessionChat =
    state.activePage === "chats" && state.activeChatId === session.chatId;
  return (
    <section
      className={styles["sharedPresenceHint"]}
      aria-label="Mika 正在和你一起"
    >
      <HeartHandshake aria-hidden="true" size={15} />
      <div>
        <strong>{session.title}</strong>
        <span>Mika 正和你一起</span>
      </div>
      {showingSessionChat ? null : (
        <button
          type="button"
          onClick={() =>
            dispatch({ chatId: session.chatId, type: "chat.selected" })
          }
        >
          回到对话
        </button>
      )}
      <button
        type="button"
        onClick={() => onNaturalCorrection(session.chatId, session.title)}
      >
        理解有误
      </button>
    </section>
  );
}

function SettingsPage({
  backgroundScheme,
  customBackgroundColors,
  onAgentSettingsChanged,
  onBackgroundSchemeChange,
  onCustomBackgroundColorsChange,
  onThemePreferenceChange,
  onProvidersChanged,
  settingsSectionTarget,
  themePreference,
  voiceStore,
}: Pick<
  AppShellProps,
  | "backgroundScheme"
  | "customBackgroundColors"
  | "onAgentSettingsChanged"
  | "onBackgroundSchemeChange"
  | "onCustomBackgroundColorsChange"
  | "onThemePreferenceChange"
  | "onProvidersChanged"
  | "settingsSectionTarget"
  | "themePreference"
  | "voiceStore"
>) {
  const [activeSection, setActiveSection] = useState<
    | "agent"
    | "activity"
    | "appearance"
    | "browser-computer"
    | "character"
    | "data"
    | "mcp"
    | "models"
    | "skills"
    | "voice"
  >(settingsSectionTarget);

  return (
    <div className={styles["settingsPage"]}>
      <aside aria-label="设置分类">
        <button
          type="button"
          aria-current={activeSection === "appearance" ? "page" : undefined}
          onClick={() => setActiveSection("appearance")}
        >
          Appearance
        </button>
        <button
          type="button"
          aria-current={activeSection === "character" ? "page" : undefined}
          onClick={() => setActiveSection("character")}
        >
          Character
        </button>
        <button
          type="button"
          aria-current={activeSection === "voice" ? "page" : undefined}
          onClick={() => setActiveSection("voice")}
        >
          Voice
        </button>
        <button
          type="button"
          aria-current={activeSection === "models" ? "page" : undefined}
          onClick={() => setActiveSection("models")}
        >
          Models
        </button>
        <button
          type="button"
          aria-current={activeSection === "agent" ? "page" : undefined}
          onClick={() => setActiveSection("agent")}
        >
          Agent
        </button>
        <button
          type="button"
          aria-current={
            activeSection === "browser-computer" ? "page" : undefined
          }
          onClick={() => setActiveSection("browser-computer")}
        >
          Browser &amp; Computer
        </button>
        <button
          type="button"
          aria-current={activeSection === "skills" ? "page" : undefined}
          onClick={() => setActiveSection("skills")}
        >
          Skills
        </button>
        <button
          type="button"
          aria-current={activeSection === "mcp" ? "page" : undefined}
          onClick={() => setActiveSection("mcp")}
        >
          MCP
        </button>
        <button
          type="button"
          aria-current={activeSection === "activity" ? "page" : undefined}
          onClick={() => setActiveSection("activity")}
        >
          Activity
        </button>
        <button
          type="button"
          aria-current={activeSection === "data" ? "page" : undefined}
          onClick={() => setActiveSection("data")}
        >
          Data
        </button>
      </aside>
      <div className={styles["settingsContent"]}>
        {activeSection === "appearance" ? (
          <section className={styles["appearancePanel"]}>
            <p className={styles["settingsEyebrow"]}>Appearance</p>
            <h2>界面背景</h2>
            <p className={styles["settingsDescription"]}>
              选择明暗主题与背景气质。设置会保留，并可随系统外观自动切换。
            </p>
            <fieldset className={styles["themePicker"]}>
              <legend>明暗主题</legend>
              {themePreferences.map((theme) => (
                <label
                  key={theme.id}
                  data-selected={themePreference === theme.id || undefined}
                >
                  <input
                    type="radio"
                    name="color-theme"
                    value={theme.id}
                    checked={themePreference === theme.id}
                    onChange={() => onThemePreferenceChange(theme.id)}
                  />
                  <strong>{theme.label}</strong>
                  <small>{theme.description}</small>
                </label>
              ))}
            </fieldset>
            <fieldset className={styles["schemePicker"]}>
              <legend>背景方案</legend>
              {backgroundSchemes.map((scheme) => (
                <label
                  key={scheme.id}
                  data-selected={backgroundScheme === scheme.id || undefined}
                >
                  <input
                    type="radio"
                    name="background-scheme"
                    value={scheme.id}
                    checked={backgroundScheme === scheme.id}
                    onChange={() => onBackgroundSchemeChange(scheme.id)}
                  />
                  <span
                    className={styles["schemePreview"]}
                    data-scheme={scheme.id}
                  >
                    <i
                      style={
                        scheme.id === "custom"
                          ? { backgroundColor: customBackgroundColors.sidebar }
                          : undefined
                      }
                    />
                    <i
                      style={
                        scheme.id === "custom"
                          ? { backgroundColor: customBackgroundColors.canvas }
                          : undefined
                      }
                    />
                  </span>
                  <strong>{scheme.label}</strong>
                  <small>{scheme.description}</small>
                </label>
              ))}
            </fieldset>
            {backgroundScheme === "custom" ? (
              <fieldset className={styles["customColors"]}>
                <legend>自定义颜色</legend>
                {(
                  [
                    ["canvas", "画布"],
                    ["sidebar", "侧栏"],
                    ["surface", "内容面"],
                    ["accent", "强调色"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <input
                      aria-label={`${label}颜色`}
                      type="color"
                      value={customBackgroundColors[key]}
                      onChange={(event) =>
                        onCustomBackgroundColorsChange({
                          ...customBackgroundColors,
                          [key]: event.currentTarget.value,
                        })
                      }
                    />
                    <code>{customBackgroundColors[key]}</code>
                  </label>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    onCustomBackgroundColorsChange(
                      defaultCustomBackgroundColors,
                    )
                  }
                >
                  恢复默认颜色
                </button>
              </fieldset>
            ) : null}
          </section>
        ) : activeSection === "character" ? (
          <CharacterSettingsPanel />
        ) : activeSection === "voice" ? (
          <VoiceSettingsPanel voiceStore={voiceStore} />
        ) : activeSection === "models" ? (
          <ProviderSettingsPanel onProfilesChanged={onProvidersChanged} />
        ) : activeSection === "agent" ? (
          <AgentSettingsPanel onChanged={onAgentSettingsChanged} />
        ) : activeSection === "browser-computer" ? (
          <BrowserComputerSettingsPanel />
        ) : activeSection === "skills" ? (
          <SkillsSettingsPanel />
        ) : activeSection === "mcp" ? (
          <McpSettingsPanel />
        ) : activeSection === "data" ? (
          <DataSettingsPanel />
        ) : (
          <ActivitySettingsPanel />
        )}
      </div>
    </div>
  );
}

export function AppShell({
  activeChat,
  activePet,
  backgroundScheme,
  customBackgroundColors,
  themePreference,
  chatDomain,
  dispatch,
  foundation,
  journeyError,
  journeySnapshot,
  onChatArchive,
  onChatCreate,
  onChatDelete,
  onChatRename,
  onChatRestore,
  onChatSetPinned,
  onClearChatError,
  onClearJourneyError,
  onClearVoiceError,
  onBackgroundSchemeChange,
  onCustomBackgroundColorsChange,
  onThemePreferenceChange,
  onAgentSettingsChanged,
  onConfigureModels,
  onProvidersChanged,
  onSettingsOpen,
  onResolveApproval,
  onResolveUserInput,
  onRunResume,
  onRunSend,
  onRunStop,
  onVoiceEnd,
  onVoiceMutedChange,
  onVoicePausedChange,
  onVoiceRetry,
  onVoiceStart,
  petAnimationSpeed,
  state,
  settingsSectionTarget,
  voiceSnapshot,
  voiceStore,
  voiceError,
}: AppShellProps) {
  const [activityTarget, setActivityTarget] = useState<{
    readonly episodeId: string;
  } | null>(null);
  const [memoryTargetId, setMemoryTargetId] = useState<string | null>(null);
  const [territoryTargetId, setTerritoryTargetId] = useState<string | null>(
    null,
  );

  const focusComposer = () => {
    window.setTimeout(() => {
      document
        .querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')
        ?.focus();
    }, 0);
  };
  const correctCompanionshipScope = (chatId: string, title: string) => {
    dispatch({ chatId, type: "chat.selected" });
    dispatch({
      draft: `我们现在一起做的不是「${title}」，实际是：`,
      type: "draft.changed",
    });
    focusComposer();
  };
  const openMemorySource = (source: MemorySource) => {
    if (source.type === "activity") {
      setActivityTarget({
        episodeId: source.referenceId,
      });
      dispatch({ page: "activity", type: "page.selected" });
      return;
    }
    if (source.type === "chat" || source.type === "voice") {
      dispatch({ chatId: source.referenceId, type: "chat.selected" });
    }
  };
  const consumeActivityTarget = useCallback(() => setActivityTarget(null), []);
  const consumeMemoryTarget = useCallback(() => setMemoryTargetId(null), []);
  const consumeTerritoryTarget = useCallback(
    () => setTerritoryTargetId(null),
    [],
  );
  const openTerritoryCandidate = useCallback(
    (candidateId: string) => {
      setTerritoryTargetId(candidateId);
      dispatch({ page: "territory", type: "page.selected" });
    },
    [dispatch],
  );
  const openTerritoryMemorySource = useCallback(
    (memoryId: string) => {
      setMemoryTargetId(memoryId);
      dispatch({ page: "memory", type: "page.selected" });
    },
    [dispatch],
  );
  return (
    <div className={styles["shell"]} data-platform={foundation.platform}>
      <Sidebar
        activePet={activePet}
        chatDomain={chatDomain}
        dispatch={dispatch}
        onChatArchive={onChatArchive}
        onChatCreate={onChatCreate}
        onChatDelete={onChatDelete}
        onChatRename={onChatRename}
        onChatRestore={onChatRestore}
        onChatSetPinned={onChatSetPinned}
        onSettingsOpen={onSettingsOpen}
        state={state}
      />
      <main className={styles["main"]}>
        <button
          className={styles["mobileSidebarButton"]}
          type="button"
          aria-label="切换侧栏"
          onClick={() => dispatch({ type: "sidebar.toggled" })}
        >
          <PanelLeft aria-hidden="true" size={18} />
        </button>
        <div className={styles["topChrome"]}>
          <SharedPresenceHint
            dispatch={dispatch}
            journeySnapshot={journeySnapshot}
            onNaturalCorrection={correctCompanionshipScope}
            state={state}
          />
        </div>
        {chatDomain.error || journeyError || voiceError ? (
          <div className={styles["errorBanner"]} role="alert">
            <span>
              {chatDomain.error ?? journeyError ?? voiceError?.message}
            </span>
            {!chatDomain.error && !journeyError && voiceError?.retryable ? (
              <button
                type="button"
                onClick={() => {
                  onClearVoiceError();
                  onVoiceRetry();
                }}
              >
                重试
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                onClearChatError();
                onClearJourneyError();
                onClearVoiceError();
              }}
            >
              关闭
            </button>
          </div>
        ) : null}
        <div className={styles["page"]}>
          {state.activePage === "chats" ? (
            <ChatsPage
              activeChat={activeChat}
              dispatch={dispatch}
              models={chatDomain.models}
              onConfigureModels={onConfigureModels}
              onResumeRun={onRunResume}
              onResolveApproval={onResolveApproval}
              onResolveUserInput={onResolveUserInput}
              onSend={onRunSend}
              onStop={onRunStop}
              onVoiceEnd={onVoiceEnd}
              onVoiceMutedChange={onVoiceMutedChange}
              onVoicePausedChange={onVoicePausedChange}
              onVoiceRetry={onVoiceRetry}
              onVoiceStart={onVoiceStart}
              runtimeEnabled={state.modelId !== undefined}
              state={state}
              voiceSnapshot={voiceSnapshot}
              voiceStore={voiceStore}
            />
          ) : state.activePage === "settings" ? (
            <SettingsPage
              key={settingsSectionTarget}
              backgroundScheme={backgroundScheme}
              customBackgroundColors={customBackgroundColors}
              themePreference={themePreference}
              onAgentSettingsChanged={onAgentSettingsChanged}
              onBackgroundSchemeChange={onBackgroundSchemeChange}
              onCustomBackgroundColorsChange={onCustomBackgroundColorsChange}
              onThemePreferenceChange={onThemePreferenceChange}
              onProvidersChanged={onProvidersChanged}
              settingsSectionTarget={settingsSectionTarget}
              voiceStore={voiceStore}
            />
          ) : state.activePage === "territory" ? (
            <TerritoryPage
              activePet={activePet}
              animationSpeed={petAnimationSpeed}
              {...(territoryTargetId
                ? { focusCandidateId: territoryTargetId }
                : {})}
              onFocusConsumed={consumeTerritoryTarget}
              onOpenMemorySource={openTerritoryMemorySource}
            />
          ) : state.activePage === "memory" ? (
            <MemoryPage
              {...(memoryTargetId ? { focusMemoryId: memoryTargetId } : {})}
              onFocusConsumed={consumeMemoryTarget}
              onOpenSource={openMemorySource}
              onOpenTerritory={openTerritoryCandidate}
            />
          ) : state.activePage === "activity" ? (
            <ActivityPage
              {...(activityTarget
                ? { focusEpisodeId: activityTarget.episodeId }
                : {})}
              onFocusConsumed={consumeActivityTarget}
              onOpenTerritory={openTerritoryCandidate}
            />
          ) : (
            <AutomationsPage
              models={chatDomain.models.map((model) => ({
                label: `${model.displayName} · ${model.provider.profileName}`,
                modelId: model.provider.modelId,
                providerProfileId: model.provider.profileId,
              }))}
              personas={[currentPersona]}
              onOpenChatRun={(chatId, runId) =>
                dispatch({
                  chatId,
                  ...(runId ? { runId } : {}),
                  type: "automation-run.focused",
                })
              }
            />
          )}
        </div>
        <span
          className={styles["visuallyHidden"]}
          data-testid="foundation-status"
        >
          Electron {foundation.electronVersion} · SQLite 已完成事务与重开读取
        </span>
      </main>
    </div>
  );
}
