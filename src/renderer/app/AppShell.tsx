import {
  Activity,
  Archive,
  Brain,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleEllipsis,
  Map,
  MessageCircle,
  PanelLeft,
  Search,
  Settings,
  SquarePen,
} from "lucide-react";
import { useState, type Dispatch, type ReactNode } from "react";

import type { FoundationSnapshot } from "../../shared/contracts/foundation";
import { ChatsPage } from "../features/chats/ChatsPage";
import { chatsFixture } from "../features/chats/fixtures";
import { selectFilteredFixtureChats } from "../features/chats/state";
import { ProviderSettingsPanel } from "../features/settings/ProviderSettingsPanel";
import type {
  ChatsFixtureUiAction,
  ChatsFixtureUiState,
  PrimaryPageId,
} from "../features/chats/types";
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
  readonly backgroundScheme: BackgroundScheme;
  readonly dispatch: Dispatch<ChatsFixtureUiAction>;
  readonly foundation: FoundationSnapshot;
  readonly onBackgroundSchemeChange: (scheme: BackgroundScheme) => void;
  readonly state: ChatsFixtureUiState;
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
  dispatch,
  state,
}: Pick<AppShellProps, "dispatch" | "state">) {
  const chats = selectFilteredFixtureChats(state);
  const collapsed = state.sidebarCollapsed;

  return (
    <aside
      className={styles["sidebar"]}
      data-collapsed={collapsed || undefined}
    >
      <div className={styles["sidebarDragRegion"]} />
      <div className={styles["brandRow"]}>
        <div className={styles["brandMark"]}>
          <img
            src={chatsFixture.persona.imageSource}
            alt={`${chatsFixture.persona.displayName} 桌宠`}
          />
        </div>
        {collapsed ? null : <strong>CharaMate</strong>}
      </div>

      <button
        className={styles["newChat"]}
        type="button"
        aria-label="新建对话"
        onClick={() => dispatch({ type: "chat.new" })}
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
          <p className={styles["sectionLabel"]}>最近</p>
          <div className={styles["chatLinks"]}>
            {chats.map(({ record }) => (
              <button
                key={record.id}
                type="button"
                data-active={record.id === state.activeChatId || undefined}
                onClick={() =>
                  dispatch({ chatId: record.id, type: "chat.selected" })
                }
              >
                <span>{record.title}</span>
                {"pinnedAt" in record && record.pinnedAt ? (
                  <span aria-label="已置顶">·</span>
                ) : null}
              </button>
            ))}
            {chats.length === 0 ? (
              <p className={styles["emptySearch"]}>没有匹配的会话</p>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className={styles["sidebarFooter"]}>
        {!collapsed ? (
          <div className={styles["persona"]}>
            <span>{chatsFixture.persona.displayName}</span>
            <small>{chatsFixture.persona.styleName}</small>
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
  dispatch,
  state,
}: Pick<AppShellProps, "dispatch" | "state">) {
  const activeChat = chatsFixture.chats.find(
    ({ record }) => record.id === state.activeChatId,
  );
  const title =
    state.activePage === "chats"
      ? (activeChat?.record.title ?? "新对话")
      : state.activePage === "settings"
        ? "Settings"
        : placeholderCopy[state.activePage].title;

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
      <h1>{title}</h1>
      {state.activePage === "chats" && activeChat ? (
        <div className={styles["headerActions"]}>
          <button type="button" aria-label="归档会话">
            <Archive aria-hidden="true" size={16} />
          </button>
          <button type="button" aria-label="更多会话操作">
            <CircleEllipsis aria-hidden="true" size={17} />
          </button>
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
}: Pick<AppShellProps, "backgroundScheme" | "onBackgroundSchemeChange">) {
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
          <ProviderSettingsPanel />
        )}
      </div>
    </div>
  );
}

export function AppShell({
  backgroundScheme,
  dispatch,
  foundation,
  onBackgroundSchemeChange,
  state,
}: AppShellProps) {
  return (
    <div className={styles["shell"]}>
      <Sidebar dispatch={dispatch} state={state} />
      <main className={styles["main"]}>
        <PageHeader dispatch={dispatch} state={state} />
        <div className={styles["page"]}>
          {state.activePage === "chats" ? (
            <ChatsPage dispatch={dispatch} state={state} />
          ) : state.activePage === "settings" ? (
            <SettingsPage
              backgroundScheme={backgroundScheme}
              onBackgroundSchemeChange={onBackgroundSchemeChange}
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
