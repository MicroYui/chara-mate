import type { Dispatch } from "react";

import { Composer } from "./components/Composer";
import { MessageList } from "./components/MessageList";
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
  readonly state: ChatsUiState;
}

const suggestions = [
  "聊聊今天发生的事",
  "帮我整理一个周末计划",
  "解释一段代码",
] as const;

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
  state,
}: ChatsPageProps) {
  const hasTimeline = Boolean(
    activeChat &&
    (activeChat.messages.length > 0 || activeChat.runs.length > 0),
  );
  return (
    <section className={styles["chats"]} aria-label="Chats">
      <div className={styles["conversation"]}>
        {activeChat && hasTimeline ? (
          <MessageList chat={activeChat} dispatch={dispatch} state={state} />
        ) : (
          <EmptyChat dispatch={dispatch} />
        )}
      </div>
      <div className={styles["composerDock"]}>
        <Composer
          dispatch={dispatch}
          models={models}
          runtimeEnabled={false}
          state={state}
        />
        <p>CharaMate 也可能出错，请核对重要信息。</p>
      </div>
    </section>
  );
}
