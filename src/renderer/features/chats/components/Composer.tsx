import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  File,
  Folder,
  Image,
  MessageCircle,
  Mic,
  Paperclip,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import {
  type Dispatch,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  forwardRef,
  useEffect,
  useRef,
  useState,
} from "react";

import type { ApprovalMode } from "../../../../shared/contracts";
import { composerAttachmentFixtures } from "../fixtures";
import type {
  ChatsFixtureUiAction,
  ChatsFixtureUiState,
  ComposerAttachment,
  FixtureModel,
} from "../types";
import styles from "./Composer.module.css";

interface ComposerProps {
  readonly dispatch: Dispatch<ChatsFixtureUiAction>;
  readonly models: readonly FixtureModel[];
  readonly state: ChatsFixtureUiState;
}

const approvalOptions = [
  {
    description: "执行敏感动作前先询问你",
    id: "request_approval",
    label: "请求批准",
  },
  {
    description: "由 CharaMate 处理常规确认",
    id: "auto_approve",
    label: "替我审批",
  },
  {
    description: "本轮允许直接执行可用动作",
    id: "full_access",
    label: "完全访问",
  },
] as const satisfies readonly {
  readonly description: string;
  readonly id: ApprovalMode;
  readonly label: string;
}[];

interface ControlButtonProps extends ComponentPropsWithoutRef<"button"> {
  readonly children: string;
  readonly icon: typeof MessageCircle;
}

const ControlButton = forwardRef<HTMLButtonElement, ControlButtonProps>(
  ({ children, className, icon: Icon, ...props }, ref) => (
    <button
      ref={ref}
      className={`${styles["controlButton"]} ${className ?? ""}`}
      type="button"
      {...props}
    >
      <Icon aria-hidden="true" size={14} />
      <span>{children}</span>
      <ChevronDown aria-hidden="true" size={11} />
    </button>
  ),
);

ControlButton.displayName = "ControlButton";

function ModePicker({
  dispatch,
  state,
}: Pick<ComposerProps, "dispatch" | "state">) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <ControlButton icon={state.mode === "chat" ? MessageCircle : Bot}>
          {state.mode === "chat" ? "Chat" : "Agent"}
        </ControlButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={styles["menu"]}
          sideOffset={6}
          align="start"
        >
          <DropdownMenu.Item
            className={styles["menuItem"]}
            onSelect={() => dispatch({ mode: "chat", type: "mode.changed" })}
          >
            <MessageCircle aria-hidden="true" size={15} />
            <span>
              <strong>Chat</strong>
              <small>只进行对话，不执行电脑动作</small>
            </span>
            {state.mode === "chat" ? (
              <Check aria-hidden="true" size={14} />
            ) : null}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={styles["menuItem"]}
            onSelect={() => dispatch({ mode: "agent", type: "mode.changed" })}
          >
            <Bot aria-hidden="true" size={15} />
            <span>
              <strong>Agent</strong>
              <small>可以使用工具完成任务</small>
            </span>
            {state.mode === "agent" ? (
              <Check aria-hidden="true" size={14} />
            ) : null}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ModelPicker({ dispatch, models, state }: ComposerProps) {
  const selected = models.find(({ id }) => id === state.modelId) ?? models[0];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <ControlButton icon={Bot}>
          {selected?.displayName ?? "Model"}
        </ControlButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={styles["menu"]}
          sideOffset={6}
          align="start"
        >
          {models.map((model) => (
            <DropdownMenu.Item
              key={model.id}
              className={styles["menuItem"]}
              onSelect={() =>
                dispatch({ modelId: model.id, type: "model.changed" })
              }
            >
              <Bot aria-hidden="true" size={15} />
              <span>
                <strong>{model.displayName}</strong>
                <small>{model.provider.profileName}</small>
              </span>
              {state.modelId === model.id ? (
                <Check aria-hidden="true" size={14} />
              ) : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ApprovalPicker({
  dispatch,
  state,
}: Pick<ComposerProps, "dispatch" | "state">) {
  const selected =
    approvalOptions.find(({ id }) => id === state.approvalMode) ??
    approvalOptions[0];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <ControlButton icon={ShieldCheck}>{selected.label}</ControlButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={styles["menu"]}
          sideOffset={6}
          align="start"
        >
          {approvalOptions.map((option) => (
            <DropdownMenu.Item
              key={option.id}
              className={styles["menuItem"]}
              onSelect={() =>
                dispatch({
                  approvalMode: option.id,
                  type: "approval-mode.changed",
                })
              }
            >
              <ShieldCheck aria-hidden="true" size={15} />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {state.approvalMode === option.id ? (
                <Check aria-hidden="true" size={14} />
              ) : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function attachmentLabel(attachment: ComposerAttachment): string {
  return attachment.source === "folder"
    ? "文件夹"
    : attachment.source === "image"
      ? "图片"
      : "文件";
}

function AttachmentPicker({ dispatch }: Pick<ComposerProps, "dispatch">) {
  const choices = [
    {
      attachment: composerAttachmentFixtures.file,
      icon: File,
      label: "添加文件",
    },
    {
      attachment: composerAttachmentFixtures.image,
      icon: Image,
      label: "添加图片",
    },
    {
      attachment: composerAttachmentFixtures.folder,
      icon: Folder,
      label: "添加文件夹",
    },
  ] as const;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className={styles["iconButton"]}
          type="button"
          aria-label="添加附件"
        >
          <Plus aria-hidden="true" size={17} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles["attachmentMenu"]}
          sideOffset={6}
          align="start"
        >
          {choices.map(({ attachment, icon: Icon, label }) => (
            <Popover.Close key={label} asChild>
              <button
                type="button"
                onClick={() =>
                  dispatch({ attachment, type: "composer.attachment-added" })
                }
              >
                <Icon aria-hidden="true" size={15} />
                <span>{label}</span>
              </button>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MoreControls({ dispatch, models, state }: ComposerProps) {
  const selectedModel =
    models.find(({ id }) => id === state.modelId) ?? models[0];
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className={`${styles["controlButton"]} ${styles["moreButton"]}`}
          type="button"
        >
          <SlidersHorizontal aria-hidden="true" size={14} />
          <span>更多</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles["compactControls"]}
          sideOffset={6}
          align="start"
        >
          <p>模型</p>
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              data-selected={model.id === selectedModel?.id || undefined}
              onClick={() =>
                dispatch({ modelId: model.id, type: "model.changed" })
              }
            >
              {model.displayName}
            </button>
          ))}
          {state.mode === "agent" ? (
            <>
              <p>执行权限</p>
              {approvalOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-selected={option.id === state.approvalMode || undefined}
                  onClick={() =>
                    dispatch({
                      approvalMode: option.id,
                      type: "approval-mode.changed",
                    })
                  }
                >
                  {option.label}
                </button>
              ))}
            </>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function VoiceGlyph() {
  return (
    <span className={styles["voiceGlyph"]} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export function Composer({ dispatch, models, state }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const canSend =
    state.draft.trim().length > 0 || state.composerAttachments.length > 0;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "0";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 154)}px`;
  }, [state.draft]);

  const send = () => {
    if (canSend && state.composerPhase === "idle") {
      dispatch({ phase: "running", type: "composer.phase-changed" });
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div
      className={styles["composer"]}
      data-dragging={dragging || undefined}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        dispatch({
          attachment: composerAttachmentFixtures.file,
          type: "composer.attachment-added",
        });
      }}
    >
      {state.composerAttachments.length > 0 ? (
        <div className={styles["composerAttachments"]} aria-label="待发送附件">
          {state.composerAttachments.map((attachment) => (
            <div key={attachment.artifact.artifactId}>
              <Paperclip aria-hidden="true" size={13} />
              <span>
                <strong>{attachment.artifact.displayName}</strong>
                <small>{attachmentLabel(attachment)}</small>
              </span>
              <button
                type="button"
                aria-label={`移除 ${attachment.artifact.displayName}`}
                onClick={() =>
                  dispatch({
                    artifactId: attachment.artifact.artifactId,
                    type: "composer.attachment-removed",
                  })
                }
              >
                <X aria-hidden="true" size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        rows={1}
        value={state.draft}
        placeholder="问问 CharaMate…"
        aria-label="消息"
        onChange={(event) =>
          dispatch({ draft: event.currentTarget.value, type: "draft.changed" })
        }
        onKeyDown={handleKeyDown}
      />

      <div className={styles["controls"]}>
        <div className={styles["leftControls"]}>
          <AttachmentPicker dispatch={dispatch} />
          <ModePicker dispatch={dispatch} state={state} />
          <span className={styles["secondaryControl"]}>
            <ModelPicker dispatch={dispatch} models={models} state={state} />
          </span>
          {state.mode === "agent" ? (
            <span className={styles["secondaryControl"]}>
              <ApprovalPicker dispatch={dispatch} state={state} />
            </span>
          ) : null}
          <MoreControls dispatch={dispatch} models={models} state={state} />
        </div>
        <div className={styles["rightControls"]}>
          <button
            className={styles["iconButton"]}
            type="button"
            aria-label="录入语音"
          >
            <Mic aria-hidden="true" size={16} />
          </button>
          {state.composerPhase === "running" ? (
            <button
              className={styles["primaryButton"]}
              type="button"
              aria-label="停止"
              onClick={() =>
                dispatch({ phase: "stopping", type: "composer.phase-changed" })
              }
            >
              <Square aria-hidden="true" fill="currentColor" size={11} />
            </button>
          ) : state.composerPhase === "stopping" ? (
            <button
              className={styles["primaryButton"]}
              type="button"
              disabled
              aria-label="正在停止"
            >
              <Square aria-hidden="true" fill="currentColor" size={10} />
            </button>
          ) : canSend ? (
            <button
              className={styles["primaryButton"]}
              type="button"
              aria-label="发送"
              onClick={send}
            >
              <ArrowUp aria-hidden="true" size={17} />
            </button>
          ) : (
            <button
              className={styles["primaryButton"]}
              type="button"
              aria-label="开始语音对话"
            >
              <VoiceGlyph />
            </button>
          )}
        </div>
      </div>
      {dragging ? (
        <div className={styles["dropHint"]}>松开以添加文件</div>
      ) : null}
    </div>
  );
}
