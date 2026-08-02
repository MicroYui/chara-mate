import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  Archive,
  ArchiveRestore,
  Brain,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleEllipsis,
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
import { useState, type Dispatch, type ReactNode } from "react";

import type { FoundationSnapshot } from "../../shared/contracts/foundation";
import type { ChatDomainState } from "../features/chats/chatStore";
import { ChatsPage } from "../features/chats/ChatsPage";
import { ProviderSettingsPanel } from "../features/settings/ProviderSettingsPanel";
import type {
  ChatView,
  ChatsUiAction,
  ChatsUiState,
  PrimaryPageId,
} from "../features/chats/types";
import mikaPetImage from "../assets/mika-pet.svg";
import { backgroundSchemes, type BackgroundScheme } from "./appearance";
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

const placeholderCopy = {
  activity: {
    description: "在这里回顾应用活动，并决定哪些内容值得保留。",
    eyebrow: "Phase 3",
    title: "Activity",
  },
  automations: {
    description: "定时任务会沿用与手动对话相同的 Chat 与 Run。",
    eyebrow: "Phase 5",
    title: "Automations",
  },
  memory: {
    description: "管理长期记忆、来源与可撤销的内容变化。",
    eyebrow: "Phase 3",
    title: "Memory",
  },
  territory: {
    description: "角色、记忆物件与场景会在后续阶段汇聚到这里。",
    eyebrow: "Phase 6",
    title: "Territory",
  },
} as const;

interface AppShellProps {
  readonly activeChat: ChatView | undefined;
  readonly backgroundScheme: BackgroundScheme;
  readonly chatDomain: ChatDomainState;
  readonly dispatch: Dispatch<ChatsUiAction>;
  readonly foundation: FoundationSnapshot;
  readonly onChatArchive: (chatId: string) => void;
  readonly onChatCreate: () => void;
  readonly onChatDelete: (chatId: string) => void;
  readonly onChatRename: (chatId: string, title: string) => void;
  readonly onChatRestore: (chatId: string) => void;
  readonly onChatSetPinned: (chatId: string, pinned: boolean) => void;
  readonly onClearChatError: () => void;
  readonly onBackgroundSchemeChange: (scheme: BackgroundScheme) => void;
  readonly onProvidersChanged: () => void;
  readonly state: ChatsUiState;
}

interface SidebarButtonProps {
  readonly active: boolean;
  readonly children: ReactNode;
  readonly collapsed: boolean;
  readonly icon: typeof MessageCircle;
  readonly label: string;
  readonly onClick: () => void;
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
  chatDomain,
  dispatch,
  onChatCreate,
  state,
}: Pick<AppShellProps, "chatDomain" | "dispatch" | "onChatCreate" | "state">) {
  const chats = chatDomain.chats;
  const collapsed = state.sidebarCollapsed;

  return (
    <aside
      className={styles["sidebar"]}
      data-collapsed={collapsed || undefined}
    >
      <div className={styles["sidebarDragRegion"]} />
      <div className={styles["brandRow"]}>
        <div className={styles["brandMark"]}>
          <img src={mikaPetImage} alt="Mika 桌宠" />
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
            {chats.map((record) => (
              <button
                key={record.id}
                type="button"
                data-active={record.id === state.activeChatId || undefined}
                onClick={() =>
                  dispatch({ chatId: record.id, type: "chat.selected" })
                }
              >
                <span>{record.title}</span>
                {record.pinnedAt ? <Pin aria-label="已置顶" size={11} /> : null}
              </button>
            ))}
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
            onClick={() =>
              dispatch({ page: "settings", type: "page.selected" })
            }
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

function PageHeader({
  activeChat,
  chatDomain,
  dispatch,
  onChatArchive,
  onChatDelete,
  onChatRename,
  onChatRestore,
  onChatSetPinned,
  state,
}: Pick<
  AppShellProps,
  | "activeChat"
  | "chatDomain"
  | "dispatch"
  | "onChatArchive"
  | "onChatDelete"
  | "onChatRename"
  | "onChatRestore"
  | "onChatSetPinned"
  | "state"
>) {
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const activeRecord =
    activeChat?.record ??
    chatDomain.chats.find(({ id }) => id === state.activeChatId);
  const editingTitle = editingChatId === activeRecord?.id;

  const commitTitle = () => {
    const title = titleDraft.trim();
    if (activeRecord && title && title !== activeRecord.title) {
      onChatRename(activeRecord.id, title);
    }
    setEditingChatId(null);
  };

  const title =
    state.activePage === "chats"
      ? (activeRecord?.title ?? "新对话")
      : state.activePage === "settings"
        ? "Settings"
        : placeholderCopy[state.activePage].title;

  const confirmDelete = () => {
    if (
      activeRecord &&
      window.confirm(`确定删除“${activeRecord.title}”吗？此操作无法撤销。`)
    ) {
      onChatDelete(activeRecord.id);
    }
  };

  return (
    <header className={styles["pageHeader"]}>
      <button
        className={styles["mobileSidebarButton"]}
        type="button"
        aria-label="切换侧栏"
        onClick={() => dispatch({ type: "sidebar.toggled" })}
      >
        <PanelLeft aria-hidden="true" size={18} />
      </button>
      {editingTitle && activeRecord ? (
        <input
          autoFocus
          className={styles["titleInput"]}
          aria-label="会话标题"
          value={titleDraft}
          onBlur={commitTitle}
          onChange={(event) => setTitleDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitTitle();
            if (event.key === "Escape") {
              setTitleDraft(activeRecord.title);
              setEditingChatId(null);
            }
          }}
        />
      ) : (
        <h1>{title}</h1>
      )}
      {state.activePage === "chats" && activeRecord ? (
        <div className={styles["headerActions"]}>
          <button
            type="button"
            aria-label={
              activeRecord.status === "archived" ? "恢复会话" : "归档会话"
            }
            onClick={() =>
              activeRecord.status === "archived"
                ? onChatRestore(activeRecord.id)
                : onChatArchive(activeRecord.id)
            }
          >
            {activeRecord.status === "archived" ? (
              <ArchiveRestore aria-hidden="true" size={16} />
            ) : (
              <Archive aria-hidden="true" size={16} />
            )}
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" aria-label="更多会话操作">
                <CircleEllipsis aria-hidden="true" size={17} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                className={styles["headerMenu"]}
                sideOffset={6}
              >
                <DropdownMenu.Item
                  onSelect={() => {
                    setTitleDraft(activeRecord.title);
                    setEditingChatId(activeRecord.id);
                  }}
                >
                  <Pencil aria-hidden="true" size={14} />
                  重命名
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() =>
                    onChatSetPinned(activeRecord.id, !activeRecord.pinnedAt)
                  }
                >
                  {activeRecord.pinnedAt ? (
                    <PinOff aria-hidden="true" size={14} />
                  ) : (
                    <Pin aria-hidden="true" size={14} />
                  )}
                  {activeRecord.pinnedAt ? "取消置顶" : "置顶"}
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  className={styles["dangerMenuItem"]}
                  onSelect={confirmDelete}
                >
                  <Trash2 aria-hidden="true" size={14} />
                  删除
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      ) : null}
    </header>
  );
}

function PlaceholderPage({
  page,
}: {
  readonly page: keyof typeof placeholderCopy;
}) {
  const copy = placeholderCopy[page];
  return (
    <section className={styles["placeholderPage"]}>
      <p>{copy.eyebrow}</p>
      <h2>{copy.title}</h2>
      <span>{copy.description}</span>
    </section>
  );
}

function SettingsPage({
  backgroundScheme,
  onBackgroundSchemeChange,
  onProvidersChanged,
}: Pick<
  AppShellProps,
  "backgroundScheme" | "onBackgroundSchemeChange" | "onProvidersChanged"
>) {
  const [activeSection, setActiveSection] = useState<"appearance" | "models">(
    "appearance",
  );

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
        <button type="button" disabled>
          Character
        </button>
        <button type="button" disabled>
          Voice
        </button>
        <button
          type="button"
          aria-current={activeSection === "models" ? "page" : undefined}
          onClick={() => setActiveSection("models")}
        >
          Models
        </button>
        <button type="button" disabled>
          Agent
        </button>
        <button type="button" disabled>
          Data
        </button>
      </aside>
      <div className={styles["settingsContent"]}>
        {activeSection === "appearance" ? (
          <section className={styles["appearancePanel"]}>
            <p className={styles["settingsEyebrow"]}>Appearance</p>
            <h2>界面背景</h2>
            <p className={styles["settingsDescription"]}>
              选择更适合当前环境的背景。内容层级与交互保持不变。
            </p>
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
                    <i />
                    <i />
                  </span>
                  <strong>{scheme.label}</strong>
                  <small>{scheme.description}</small>
                </label>
              ))}
            </fieldset>
          </section>
        ) : (
          <ProviderSettingsPanel onProfilesChanged={onProvidersChanged} />
        )}
      </div>
    </div>
  );
}

export function AppShell({
  activeChat,
  backgroundScheme,
  chatDomain,
  dispatch,
  foundation,
  onChatArchive,
  onChatCreate,
  onChatDelete,
  onChatRename,
  onChatRestore,
  onChatSetPinned,
  onClearChatError,
  onBackgroundSchemeChange,
  onProvidersChanged,
  state,
}: AppShellProps) {
  return (
    <div className={styles["shell"]} data-platform={foundation.platform}>
      <Sidebar
        chatDomain={chatDomain}
        dispatch={dispatch}
        onChatCreate={onChatCreate}
        state={state}
      />
      <main className={styles["main"]}>
        <PageHeader
          activeChat={activeChat}
          chatDomain={chatDomain}
          dispatch={dispatch}
          onChatArchive={onChatArchive}
          onChatDelete={onChatDelete}
          onChatRename={onChatRename}
          onChatRestore={onChatRestore}
          onChatSetPinned={onChatSetPinned}
          state={state}
        />
        {chatDomain.error ? (
          <div className={styles["errorBanner"]} role="alert">
            <span>{chatDomain.error}</span>
            <button type="button" onClick={onClearChatError}>
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
              state={state}
            />
          ) : state.activePage === "settings" ? (
            <SettingsPage
              backgroundScheme={backgroundScheme}
              onBackgroundSchemeChange={onBackgroundSchemeChange}
              onProvidersChanged={onProvidersChanged}
            />
          ) : (
            <PlaceholderPage page={state.activePage} />
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
