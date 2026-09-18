import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AudioLines, ExternalLink, Mic, SendHorizontal, X } from "lucide-react";

import type {
  PetAnimation,
  PetCharacterSnapshot,
  PetDragPoint,
  PetFacing,
  PetTerritoryMomentNotice,
  ProactiveConversationBubble,
} from "../../shared/contracts/pet";
import type { Approval } from "../../shared/contracts/run";
import type { VoiceWakeSnapshot } from "../../shared/contracts/voiceWake";
import { getDragAnimation } from "./petAtlas";
import { PixiPetCanvas } from "./PixiPetCanvas";
import { VoiceStore } from "../features/voice/voiceStore";
import { MicrophoneLease } from "./MicrophoneLease";
import { VoiceWakeController } from "./VoiceWakeController";
import styles from "./CharacterApp.module.css";

type CharacterSurface = "conversation" | "pet";

function currentSurface(): CharacterSurface {
  return new URLSearchParams(window.location.search).get("surface") ===
    "conversation"
    ? "conversation"
    : "pet";
}

function pointFromEvent(event: ReactPointerEvent): PetDragPoint | null {
  const point = { screenX: event.screenX, screenY: event.screenY };
  return Number.isFinite(point.screenX) && Number.isFinite(point.screenY)
    ? point
    : null;
}

export function CharacterApp({
  surface = currentSurface(),
}: {
  readonly surface?: CharacterSurface;
}) {
  const isConversationSurface = surface === "conversation";
  const [snapshot, setSnapshot] = useState<PetCharacterSnapshot | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [attachmentDragging, setAttachmentDragging] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [proactiveBubble, setProactiveBubble] =
    useState<ProactiveConversationBubble | null>(null);
  const [territoryMoment, setTerritoryMoment] =
    useState<PetTerritoryMomentNotice | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyPending, setReplyPending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [dragFacing, setDragFacing] = useState<PetFacing>("right");
  const [lookAngleDegrees, setLookAngleDegrees] = useState<number | null>(null);
  const [wake, setWake] = useState<VoiceWakeSnapshot>();
  const voiceRuntime = useMemo(() => {
    const microphone = new MicrophoneLease();
    return {
      microphone,
      voiceStore: new VoiceStore(window.charaMateCharacter.voice, () =>
        microphone.prepareVoiceMicrophone(),
      ),
    };
  }, []);
  const { microphone, voiceStore } = voiceRuntime;
  const voice = useSyncExternalStore(voiceStore.subscribe, voiceStore.getState);
  const activePointer = useRef<number | null>(null);
  const lastDragPoint = useRef<PetDragPoint | null>(null);
  const markedReady = useRef(false);
  const proactiveBubbleId = useRef<string | null>(null);
  const submittedBubbleId = useRef<string | null>(null);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = isConversationSurface
      ? "CharaMate Conversation"
      : "CharaMate Character";
    return () => {
      document.title = previousTitle;
    };
  }, [isConversationSurface]);

  const markReady = useCallback(() => {
    if (markedReady.current) return;
    markedReady.current = true;
    window.charaMateCharacter.markReady();
  }, []);

  const receiveProactiveBubble = useCallback(
    (next: ProactiveConversationBubble | null) => {
      const nextId = next?.id ?? null;
      if (proactiveBubbleId.current !== nextId) {
        setReplyDraft("");
        setReplyPending(false);
        setReplyError(null);
        submittedBubbleId.current = null;
      }
      proactiveBubbleId.current = nextId;
      if (
        next?.replyState === "ready" &&
        submittedBubbleId.current === next.id
      ) {
        setReplyDraft("");
        setReplyPending(false);
        setReplyError(null);
        submittedBubbleId.current = null;
      } else if (next?.replyState === "failed") {
        setReplyPending(false);
        setReplyError("没有发送成功，可以直接重试。");
        submittedBubbleId.current = null;
      }
      setProactiveBubble(next);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const unsubscribe = window.charaMateCharacter.subscribe((next) => {
      if (active) setSnapshot(next);
    });
    void window.charaMateCharacter
      .getSnapshot()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        if (!next.activePet && !isConversationSurface) markReady();
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStartupError(
          error instanceof Error ? error.message : "无法读取桌宠状态。",
        );
        markReady();
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [isConversationSurface, markReady]);

  useEffect(
    () =>
      isConversationSurface
        ? undefined
        : window.charaMateCharacter.subscribeApproval(setApproval),
    [isConversationSurface],
  );
  useEffect(
    () =>
      isConversationSurface
        ? undefined
        : window.charaMateCharacter.subscribeTerritoryMoment(
            setTerritoryMoment,
          ),
    [isConversationSurface],
  );
  useEffect(() => {
    if (!isConversationSurface) return undefined;
    const unsubscribeBubble =
      window.charaMateCharacter.subscribeProactiveBubble(
        receiveProactiveBubble,
      );
    markReady();
    return () => {
      unsubscribeBubble();
    };
  }, [isConversationSurface, markReady, receiveProactiveBubble]);
  useEffect(() => voiceStore.startListening(), [voiceStore]);
  useEffect(() => {
    if (isConversationSurface) return undefined;
    let active = true;
    const unsubscribeWake = window.charaMateCharacter.voiceWake.subscribe(
      (snapshot) => {
        if (active) setWake(snapshot);
      },
    );
    void window.charaMateCharacter.voiceWake.getSnapshot().then((response) => {
      if (active && response.ok) setWake(response.value);
    });
    const controller = new VoiceWakeController(
      window.charaMateCharacter.voiceWake,
      voiceStore,
      microphone,
    );
    const stopController = controller.start();
    return () => {
      active = false;
      unsubscribeWake();
      stopController();
    };
  }, [isConversationSurface, microphone, voiceStore]);

  const decideApproval = (decision: "approved" | "rejected") => {
    if (!approval) return;
    void window.charaMateCharacter
      .resolveApproval({
        approvalId: approval.id,
        decidedAt: new Date().toISOString(),
        decision,
      })
      .then((response) => {
        if (response.ok) setApproval(null);
      })
      .catch(() => undefined);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || activePointer.current !== null) return;
    const point = pointFromEvent(event);
    if (!point) return;
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    activePointer.current = pointerId;
    lastDragPoint.current = point;
    setDragFacing(snapshot?.facing ?? "right");
    setDragging(true);
    target.setPointerCapture(pointerId);
    void window.charaMateCharacter.startDrag(point).catch(() => {
      if (activePointer.current !== pointerId) return;
      activePointer.current = null;
      lastDragPoint.current = null;
      setDragging(false);
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (activePointer.current === event.pointerId) {
      const point = pointFromEvent(event);
      if (!point) return;
      const previousPoint = lastDragPoint.current;
      const deltaX = previousPoint ? point.screenX - previousPoint.screenX : 0;
      lastDragPoint.current = point;
      if (Math.abs(deltaX) >= 1) setDragFacing(deltaX < 0 ? "left" : "right");
      window.charaMateCharacter.moveDrag(point);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const deltaX = event.clientX - (bounds.left + bounds.width / 2);
    const deltaY = event.clientY - (bounds.top + bounds.height / 2);
    const angle = (Math.atan2(deltaX, -deltaY) * 180) / Math.PI;
    setLookAngleDegrees(Math.round(((angle + 360) % 360) / 22.5) * 22.5);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (activePointer.current !== event.pointerId) return;
    const point = pointFromEvent(event) ?? lastDragPoint.current;
    activePointer.current = null;
    lastDragPoint.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!point) return;
    void window.charaMateCharacter
      .endDrag(point)
      .then(({ moved }) => {
        if (!moved) window.charaMateCharacter.focusMain();
      })
      .catch(() => undefined);
  };

  const animation: PetAnimation = dragging
    ? getDragAnimation(dragFacing)
    : lookAngleDegrees === null
      ? (snapshot?.animation ?? "idle")
      : "look";
  const voiceActive = Boolean(voice.snapshot || voice.starting);
  const voicePaused = voice.snapshot?.phase === "paused";
  const voiceTransitioning =
    voice.starting ||
    voice.snapshot?.phase === "connecting" ||
    voice.snapshot?.phase === "resuming";
  const voiceFailed =
    voice.snapshot?.phase === "failed" ||
    voice.snapshot?.phase === "interrupted";
  const voiceActionLabel = !voiceActive
    ? "开始语音聊天"
    : voicePaused
      ? "恢复语音聊天"
      : voiceFailed
        ? "结束异常语音聊天"
        : voiceTransitioning
          ? "结束语音准备"
          : "暂停语音聊天";

  const stopPetInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const dismissProactiveBubble = () => {
    if (!proactiveBubble) return;
    window.charaMateCharacter.dismissProactiveBubble({
      bubbleId: proactiveBubble.id,
    });
    setProactiveBubble(null);
  };

  const reduceProactiveFrequency = () => {
    if (!proactiveBubble) return;
    setReplyError(null);
    void window.charaMateCharacter
      .reduceProactiveFrequency({ bubbleId: proactiveBubble.id })
      .then((response) => {
        if (response.ok) setProactiveBubble(null);
        else setReplyError(response.error.message);
      })
      .catch(() => setReplyError("没有保存成功，请稍后重试。"));
  };

  const submitBubbleReply = () => {
    if (
      !proactiveBubble ||
      replyPending ||
      proactiveBubble.replyState === "responding"
    ) {
      return;
    }
    const content = replyDraft.trim();
    if (!content) return;
    setReplyPending(true);
    setReplyError(null);
    submittedBubbleId.current = proactiveBubble.id;
    void window.charaMateCharacter
      .replyProactiveBubble({
        bubbleId: proactiveBubble.id,
        content,
        requestedAt: new Date().toISOString(),
      })
      .then((response) => {
        if (response.ok) return;
        submittedBubbleId.current = null;
        setReplyPending(false);
        setReplyError(response.error.message);
      })
      .catch(() => {
        submittedBubbleId.current = null;
        setReplyPending(false);
        setReplyError("没有发送成功，可以直接重试。");
      });
  };

  return (
    <main
      className={`${styles["character"]} ${
        isConversationSurface ? styles["conversationSurface"] : ""
      }`}
      onContextMenu={
        isConversationSurface
          ? undefined
          : (event) => {
              event.preventDefault();
              window.charaMateCharacter.showContextMenu();
            }
      }
    >
      {!isConversationSurface && approval ? (
        <section
          aria-label="桌宠审批提醒"
          className={styles["approvalBubble"]}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header>
            <span>需要你的允许</span>
            <small>{approval.toolName}</small>
          </header>
          <p>{approval.parameterSummary}</p>
          <div>
            <button type="button" onClick={() => decideApproval("rejected")}>
              拒绝
            </button>
            <button
              type="button"
              onClick={() =>
                window.charaMateCharacter.focusApproval({
                  approvalId: approval.id,
                })
              }
            >
              详情
            </button>
            <button type="button" onClick={() => decideApproval("approved")}>
              允许一次
            </button>
          </div>
        </section>
      ) : null}
      {!isConversationSurface && !approval && territoryMoment ? (
        <button
          aria-label={`打开领地回响：${territoryMoment.name}`}
          className={styles["territoryMomentNotice"]}
          data-status={territoryMoment.status}
          onClick={() => {
            window.charaMateCharacter.focusTerritoryMoment({
              candidateId: territoryMoment.candidateId,
            });
            setTerritoryMoment(null);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={stopPetInteraction}
          type="button"
        >
          <span>
            {territoryMoment.status === "ready"
              ? "领地里有一份新的回响"
              : "这份领地回响需要再试一次"}
          </span>
          <strong>{territoryMoment.name}</strong>
          <ExternalLink aria-hidden="true" size={12} />
        </button>
      ) : null}
      {isConversationSurface && proactiveBubble ? (
        <section
          aria-label="角色发起的对话"
          className={styles["proactiveBubble"]}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header className={styles["bubbleToolbar"]}>
            <span className={styles["bubbleSpeaker"]}>
              {snapshot?.activePet?.displayName ?? "CharaMate"}
            </span>
            <span className={styles["bubbleToolbarActions"]}>
              <button
                aria-label="减少主动对话频率"
                className={styles["bubbleFeedback"]}
                disabled={
                  voiceActive || proactiveBubble.replyState === "responding"
                }
                onClick={reduceProactiveFrequency}
                title="以后少一点"
                type="button"
              >
                少一点
              </button>
              {proactiveBubble.kind === "continuation" ? (
                <button
                  aria-label="打开完整 Chat"
                  className={styles["bubbleOpen"]}
                  title="打开完整 Chat"
                  type="button"
                  onClick={() => {
                    window.charaMateCharacter.focusConversation({
                      ...(voiceActive ? {} : { bubbleId: proactiveBubble.id }),
                      chatId: proactiveBubble.chatId,
                    });
                    if (!voiceActive) setProactiveBubble(null);
                  }}
                >
                  <ExternalLink aria-hidden="true" size={12} />
                </button>
              ) : null}
              <button
                aria-label="关闭这次对话邀请"
                className={styles["bubbleClose"]}
                disabled={voiceActive}
                onClick={dismissProactiveBubble}
                title={voiceActive ? "语音聊天结束后可关闭" : "关闭"}
                type="button"
              >
                <X aria-hidden="true" size={13} />
              </button>
            </span>
          </header>
          <div
            aria-label="角色消息"
            className={styles["bubbleMessage"]}
            tabIndex={0}
          >
            {proactiveBubble.content}
          </div>
          <form
            aria-label="气泡内文字回复"
            className={styles["bubbleComposer"]}
            onSubmit={(event) => {
              event.preventDefault();
              submitBubbleReply();
            }}
          >
            <input
              aria-disabled={
                voiceActive ||
                replyPending ||
                proactiveBubble.replyState === "responding"
              }
              aria-label="在气泡中回复"
              onChange={(event) => setReplyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.nativeEvent.isComposing) {
                  event.preventDefault();
                }
              }}
              placeholder={
                voiceActive
                  ? "语音聊天进行中…"
                  : proactiveBubble.replyState === "responding"
                    ? "角色正在回复…"
                    : proactiveBubble.replyState === "failed"
                      ? "发送失败，可重试"
                      : "在这里回复…"
              }
              readOnly={
                voiceActive ||
                replyPending ||
                proactiveBubble.replyState === "responding"
              }
              value={replyDraft}
            />
            <button
              aria-label="发送气泡回复"
              className={styles["bubbleSend"]}
              disabled={
                !replyDraft.trim() ||
                voiceActive ||
                replyPending ||
                proactiveBubble.replyState === "responding"
              }
              title="发送"
              type="submit"
            >
              <SendHorizontal aria-hidden="true" size={13} />
            </button>
            <button
              aria-label="在同一对话中语音回复"
              className={styles["bubbleVoice"]}
              disabled={
                voiceActive || proactiveBubble.replyState === "responding"
              }
              title="语音回复"
              type="button"
              onClick={() => {
                void voiceStore.startQuick({ chatId: proactiveBubble.chatId });
              }}
            >
              <Mic aria-hidden="true" size={13} />
            </button>
          </form>
          <span aria-live="polite" className={styles["bubbleStatus"]}>
            {replyError ??
              (proactiveBubble.replyState === "responding"
                ? "角色正在回复"
                : "")}
          </span>
        </section>
      ) : null}
      {!isConversationSurface && voice.error ? (
        <div
          className={styles["voiceError"]}
          onPointerDown={stopPetInteraction}
          role="alert"
        >
          <span>{voice.error.message}</span>
          <button
            aria-label="关闭语音错误提示"
            className={styles["voiceErrorClose"]}
            onClick={() => voiceStore.clearError()}
            title="关闭"
            type="button"
          >
            <X aria-hidden="true" size={12} />
          </button>
        </div>
      ) : null}
      {!isConversationSurface && wake?.enabled ? (
        <span
          aria-label={
            wake.phase === "listening"
              ? "正在等待 Hi Mika"
              : wake.phase === "detected"
                ? "已听到 Hi Mika"
                : wake.phase === "error"
                  ? "Hi Mika 语音唤醒暂时不可用"
                  : "Hi Mika 语音唤醒已开启"
          }
          className={styles["wakeStatus"]}
          data-phase={wake.phase}
          title={wake.error ?? "说 Hi Mika 开始语音对话"}
        >
          <Mic aria-hidden="true" size={11} strokeWidth={2.4} />
          <span>
            {wake.phase === "detected"
              ? "听到了"
              : wake.phase === "connecting"
                ? "连接中"
                : "Hi Mika"}
          </span>
        </span>
      ) : null}
      {!isConversationSurface ? (
        <div
          aria-label={
            snapshot?.activePet
              ? `${snapshot.activePet.displayName} 桌宠`
              : "CharaMate 桌宠"
          }
          className={styles["petSurface"]}
          data-attachment-dragging={attachmentDragging || undefined}
          data-dragging={dragging || undefined}
          onDragEnter={(event) => {
            event.preventDefault();
            setAttachmentDragging(true);
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              setAttachmentDragging(false);
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            setAttachmentDragging(false);
            window.charaMateCharacter.dropComposerAttachments([
              ...event.dataTransfer.files,
            ]);
          }}
          onDoubleClick={() => window.charaMateCharacter.focusMain()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              window.charaMateCharacter.focusMain();
            }
          }}
          onPointerCancel={finishDrag}
          onPointerDown={handlePointerDown}
          onPointerLeave={() => {
            if (activePointer.current === null) setLookAngleDegrees(null);
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          role="button"
          tabIndex={0}
        >
          {startupError ? (
            <span className={styles["status"]} role="alert">
              {startupError}
            </span>
          ) : snapshot?.activePet ? (
            <PixiPetCanvas
              animation={animation}
              animationSpeed={snapshot.animationSpeed}
              lookAngleDegrees={lookAngleDegrees ?? 0}
              onReady={markReady}
              pet={snapshot.activePet}
            />
          ) : snapshot ? (
            <span className={styles["status"]}>
              请在 Character 设置中导入桌宠
            </span>
          ) : null}
          {attachmentDragging ? (
            <span className={styles["dropHint"]}>放到聊天里</span>
          ) : null}
        </div>
      ) : null}
      {!isConversationSurface ? (
        <button
          aria-label={voiceActionLabel}
          aria-pressed={voiceActive}
          className={styles["voiceButton"]}
          data-active={voiceActive || undefined}
          onClick={() => {
            if (voiceTransitioning) void voiceStore.end();
            else if (!voice.snapshot) void voiceStore.startQuick();
            else if (voicePaused) void voiceStore.setPaused(false);
            else if (voiceFailed) void voiceStore.end();
            else void voiceStore.setPaused(true);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerCancel={stopPetInteraction}
          onPointerDown={stopPetInteraction}
          onPointerUp={stopPetInteraction}
          title={voiceActionLabel}
          type="button"
        >
          <AudioLines aria-hidden="true" size={20} strokeWidth={2.6} />
        </button>
      ) : null}
    </main>
  );
}
