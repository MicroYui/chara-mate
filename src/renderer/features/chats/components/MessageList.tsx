import { useVirtualizer } from "@tanstack/react-virtual";
import {
  File,
  FileImage,
  Folder,
  Pencil,
  Quote,
  RefreshCcw,
} from "lucide-react";
import { type Dispatch, useEffect, useMemo, useRef, useState } from "react";

import type {
  EntityId,
  UserInputResolution,
} from "../../../../shared/contracts";
import type {
  EvolutionApi,
  EvolutionCandidate,
} from "../../../../shared/contracts/evolution";
import { EvolutionCandidateCard } from "../../evolution/EvolutionCandidates";
import { MarkdownRenderer } from "../content/MarkdownRenderer";
import type {
  ChatAttachmentView,
  ChatMessageView,
  ChatRunView,
  ChatsUiAction,
  ChatsUiState,
  ChatView,
} from "../types";
import { CopyButton } from "./CopyButton";
import { RunProcess } from "./RunProcess";
import styles from "./MessageList.module.css";

type TimelineEntry =
  | {
      readonly id: EntityId;
      readonly kind: "evolution";
      readonly value: EvolutionCandidate;
    }
  | {
      readonly id: EntityId;
      readonly kind: "message";
      readonly value: ChatMessageView;
    }
  | {
      readonly id: EntityId;
      readonly kind: "run";
      readonly value: ChatRunView;
    };

interface MessageListProps {
  readonly chat: ChatView;
  readonly dispatch: Dispatch<ChatsUiAction>;
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
  readonly state: ChatsUiState;
}

function formatBytes(byteLength: number | undefined): string | undefined {
  if (byteLength === undefined) {
    return undefined;
  }
  if (byteLength < 1_024) {
    return `${byteLength} B`;
  }
  if (byteLength < 1_048_576) {
    return `${Math.round(byteLength / 1_024)} KB`;
  }
  return `${(byteLength / 1_048_576).toFixed(1)} MB`;
}

function AttachmentCard({
  attachment,
}: {
  readonly attachment: ChatAttachmentView;
}) {
  const Icon =
    attachment.kind === "directory"
      ? Folder
      : attachment.kind === "image"
        ? FileImage
        : File;
  const metadata =
    attachment.kind === "directory"
      ? "将按需读取"
      : (formatBytes(attachment.byteLength) ?? attachment.mediaType ?? "附件");

  return (
    <button className={styles["attachment"]} type="button">
      <span>
        <Icon aria-hidden="true" size={16} />
      </span>
      <span>
        <strong>{attachment.displayName}</strong>
        <small>{metadata}</small>
      </span>
    </button>
  );
}

function Message({ value }: { readonly value: ChatMessageView }) {
  const isUser = value.record.role === "user";
  return (
    <article
      className={styles["message"]}
      data-role={value.record.role}
      aria-label={isUser ? "用户消息" : "助手消息"}
    >
      <div className={styles["messageBody"]}>
        <MarkdownRenderer source={value.record.content} />
      </div>
      {value.attachments.length > 0 ? (
        <div className={styles["attachments"]} aria-label="消息附件">
          {value.attachments.map((attachment) => (
            <AttachmentCard
              key={attachment.artifactId}
              attachment={attachment}
            />
          ))}
        </div>
      ) : null}
      {value.record.status === "interrupted" ? (
        <span className={styles["messageStatus"]}>已打断</span>
      ) : null}
      <div className={styles["messageActions"]}>
        <CopyButton value={value.record.content} />
        {isUser ? (
          <button type="button" aria-label="编辑消息">
            <Pencil aria-hidden="true" size={12} />
            <span>编辑</span>
          </button>
        ) : (
          <>
            <button type="button" aria-label="重试回答">
              <RefreshCcw aria-hidden="true" size={12} />
              <span>重试</span>
            </button>
            <button type="button" aria-label="引用回答">
              <Quote aria-hidden="true" size={12} />
              <span>引用</span>
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function buildTimeline(
  chat: ChatView,
  candidates: readonly EvolutionCandidate[] = [],
): readonly TimelineEntry[] {
  const runsById = new Map(chat.runs.map((run) => [run.record.id, run]));
  const lastUserMessageByRun = new Map<EntityId, number>();
  for (const [index, message] of chat.messages.entries()) {
    if (message.record.role === "user" && message.record.runId) {
      lastUserMessageByRun.set(message.record.runId, index);
    }
  }
  const entries: TimelineEntry[] = [];
  const placedRuns = new Set<EntityId>();

  for (const [index, fixtureMessage] of chat.messages.entries()) {
    entries.push({
      id: fixtureMessage.record.id,
      kind: "message",
      value: fixtureMessage,
    });
    if (
      fixtureMessage.record.role === "user" &&
      fixtureMessage.record.runId &&
      lastUserMessageByRun.get(fixtureMessage.record.runId) === index
    ) {
      const run = runsById.get(fixtureMessage.record.runId);
      if (run) {
        entries.push({ id: run.record.id, kind: "run", value: run });
        placedRuns.add(run.record.id);
      }
    }
  }

  for (const run of chat.runs) {
    if (!placedRuns.has(run.record.id)) {
      entries.push({ id: run.record.id, kind: "run", value: run });
    }
  }

  for (const candidate of [...candidates].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    entries.push({ id: candidate.id, kind: "evolution", value: candidate });
  }

  return entries;
}

export function MessageList({
  chat,
  dispatch,
  onResumeRun,
  onResolveApproval,
  onResolveUserInput,
  state,
}: MessageListProps) {
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [evolutionCandidates, setEvolutionCandidates] = useState<
    EvolutionCandidate[]
  >([]);
  const evolutionApi: EvolutionApi | undefined =
    typeof window === "undefined" ? undefined : window.charaMate?.evolution;
  useEffect(() => {
    if (!evolutionApi) return;
    let active = true;
    void evolutionApi.list({ chatId: chat.record.id }).then((response) => {
      if (!active || !response.ok) return;
      setEvolutionCandidates(
        response.value.candidates.filter(
          ({ status }) => status !== "archived" && status !== "rejected",
        ),
      );
    });
    const unsubscribe = evolutionApi.subscribe((event) => {
      if (
        !active ||
        event.type !== "candidate.changed" ||
        event.candidate.chatId !== chat.record.id
      ) {
        return;
      }
      setEvolutionCandidates((current) => {
        const without = current.filter(({ id }) => id !== event.candidate.id);
        if (
          event.candidate.status !== "archived" &&
          event.candidate.status !== "rejected"
        ) {
          without.push(event.candidate);
        }
        return without;
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [chat.record.id, evolutionApi]);
  const timeline = useMemo(
    () => buildTimeline(chat, evolutionCandidates),
    [chat, evolutionCandidates],
  );
  // TanStack Virtual intentionally exposes mutable measurement callbacks.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: timeline.length,
    estimateSize: (index) => {
      const entry = timeline[index];
      if (!entry) {
        return 80;
      }
      if (entry.kind === "run") {
        return entry.value.record.status === "completed" ? 42 : 220;
      }
      if (entry.kind === "evolution") return 270;
      return entry.value.record.role === "user" ? 90 : 430;
    },
    getItemKey: (index) => timeline[index]?.id ?? index,
    getScrollElement: () => scrollElementRef.current,
    initialRect: { height: 640, width: 760 },
    overscan: 3,
  });

  useEffect(() => {
    virtualizer.scrollToIndex(Math.max(0, timeline.length - 1), {
      align: "end",
    });
  }, [chat.record.id, timeline.length, virtualizer]);

  return (
    <div className={styles["listRoot"]}>
      <div
        ref={scrollElementRef}
        className={styles["scroller"]}
        onScroll={(event) => {
          const element = event.currentTarget;
          setShowLatest(
            element.scrollHeight - element.scrollTop - element.clientHeight >
              120,
          );
        }}
      >
        <div
          className={styles["virtualCanvas"]}
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const entry = timeline[virtualItem.index];
            return entry ? (
              <div
                key={entry.id}
                ref={virtualizer.measureElement}
                className={styles["virtualRow"]}
                data-index={virtualItem.index}
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {entry.kind === "message" ? (
                  <Message value={entry.value} />
                ) : entry.kind === "run" ? (
                  <RunProcess
                    run={entry.value}
                    dispatch={dispatch}
                    onResume={onResumeRun}
                    onResolveApproval={onResolveApproval}
                    onResolveUserInput={onResolveUserInput}
                    state={state}
                  />
                ) : evolutionApi ? (
                  <EvolutionCandidateCard
                    api={evolutionApi}
                    candidate={entry.value}
                    compact
                    onChanged={(changed) =>
                      setEvolutionCandidates((current) =>
                        current.map((candidate) =>
                          candidate.id === changed.id ? changed : candidate,
                        ),
                      )
                    }
                  />
                ) : null}
              </div>
            ) : null;
          })}
        </div>
      </div>
      {showLatest ? (
        <button
          className={styles["latestButton"]}
          type="button"
          onClick={() =>
            virtualizer.scrollToIndex(timeline.length - 1, { align: "end" })
          }
        >
          回到最新
        </button>
      ) : null}
    </div>
  );
}
