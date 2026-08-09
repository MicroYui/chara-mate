import type { Dispatch } from "react";
import type { UserInputResolution } from "../../../shared/contracts";

import { Composer } from "./components/Composer";
import { MessageList } from "./components/MessageList";
import { ActivePlan } from "./components/PlanDisplay";
import type {
  ChatModelOption,
  ChatView,
  ChatsUiAction,
  ChatsUiState,
} from "./types";
import styles from "./ChatsPage.module.css";

interface ChatsPageProps {
  readonly activeChat: ChatView | undefined;
  readonly dispatch: Dispatch<ChatsUiAction>;
  readonly models: readonly ChatModelOption[];
  readonly onResumeRun: (runId: string) => void;
  readonly onResolveApproval: (
    approvalId: string,
    decision: "approved" | "rejected",
  ) => void;
  readonly onResolveUserInput: (
    runId: string,
    itemId: string,
    resolution: UserInputResolution,
  ) => Promise<void>;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly runtimeEnabled: boolean;
  readonly state: ChatsUiState;
}

const suggestions = [
  "聊聊今天发生的事",
  "帮我整理一个周末计划",
  "解释一段代码",
] as const;

const ACTIVE_RUN_STATUSES = new Set<
  ChatView["runs"][number]["record"]["status"]
>(["queued", "running", "waiting_approval", "needs_input"]);

export function activeRunForChat(chat: ChatView | undefined) {
  return chat
    ? [...chat.runs]
        .reverse()
        .find(({ record }) => ACTIVE_RUN_STATUSES.has(record.status))
    : undefined;
}

function EmptyChat({ dispatch }: Pick<ChatsPageProps, "dispatch">) {
  return (
    <div className={styles["empty"]}>
      <p>晚上好</p>
      <h2>今天想从哪里开始？</h2>
      <div aria-label="建议问题">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() =>
              dispatch({ draft: suggestion, type: "draft.changed" })
            }
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatsPage({
  activeChat,
  dispatch,
  models,
  onResumeRun,
  onResolveApproval,
  onResolveUserInput,
  onSend,
  onStop,
  runtimeEnabled,
  state,
}: ChatsPageProps) {
  const hasTimeline = Boolean(
    activeChat &&
    (activeChat.messages.length > 0 || activeChat.runs.length > 0),
  );
  const activeRun = activeRunForChat(activeChat);
  return (
    <section className={styles["chats"]} aria-label="Chats">
      <div className={styles["conversation"]}>
        {activeChat && hasTimeline ? (
          <MessageList
            chat={activeChat}
            dispatch={dispatch}
            onResumeRun={onResumeRun}
            onResolveApproval={onResolveApproval}
            onResolveUserInput={onResolveUserInput}
            state={state}
          />
        ) : (
          <EmptyChat dispatch={dispatch} />
        )}
      </div>
      <div className={styles["composerDock"]}>
        <div className={styles["composerStack"]}>
          {activeRun ? (
            <ActivePlan key={activeRun.record.id} run={activeRun} />
          ) : null}
          <Composer
            dispatch={dispatch}
            models={models}
            onSend={onSend}
            onStop={onStop}
            runtimeEnabled={runtimeEnabled}
            state={state}
          />
        </div>
        <p>CharaMate 也可能出错，请核对重要信息。</p>
      </div>
    </section>
  );
}
