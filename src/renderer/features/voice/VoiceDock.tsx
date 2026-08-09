import { Mic, MicOff, PhoneOff, RotateCcw } from "lucide-react";
import { useSyncExternalStore } from "react";

import type { VoiceSessionSnapshot } from "../../../shared/contracts/voice";
import type { VoiceStore } from "./voiceStore";
import styles from "./VoiceDock.module.css";

const phaseLabel: Record<VoiceSessionSnapshot["phase"], string> = {
  connecting: "正在连接…",
  failed: "语音遇到问题",
  interrupted: "连接已中断",
  listening: "正在聆听…",
  speaking: "正在说话",
  thinking: "正在思考…",
  using_tool: "正在使用工具…",
  waiting_approval: "等待你的批准",
};

interface VoiceDockProps {
  readonly onEnd: () => void;
  readonly onMutedChange: (muted: boolean) => void;
  readonly onRetry: () => void;
  readonly snapshot: VoiceSessionSnapshot;
  readonly store: VoiceStore;
}

export function VoiceDock({
  onEnd,
  onMutedChange,
  onRetry,
  snapshot,
  store,
}: VoiceDockProps) {
  const envelope = useSyncExternalStore(
    store.subscribeEnvelope,
    store.getEnvelope,
  );
  const level =
    snapshot.phase === "speaking" ? envelope.output : envelope.input;
  const transcript =
    snapshot.phase === "speaking" && snapshot.assistantTranscript
      ? snapshot.assistantTranscript
      : snapshot.userTranscript || snapshot.assistantTranscript;
  const pushToTalk = snapshot.inputMode === "push_to_talk";
  const retryable =
    snapshot.phase === "interrupted" && snapshot.error?.retryable === true;

  return (
    <section className={styles["dock"]} aria-label="Realtime 语音">
      <button
        className={styles["roundButton"]}
        type="button"
        aria-label={snapshot.muted ? "取消静音" : "麦克风静音"}
        aria-pressed={snapshot.muted}
        onClick={() => onMutedChange(!snapshot.muted)}
      >
        {snapshot.muted ? (
          <MicOff aria-hidden="true" size={16} />
        ) : (
          <Mic aria-hidden="true" size={16} />
        )}
      </button>
      <div className={styles["body"]}>
        <div className={styles["statusRow"]}>
          <span className={styles["wave"]} aria-hidden="true">
            {[0.62, 0.9, 1.18, 0.82, 0.55].map((weight) => (
              <i
                key={weight}
                style={{
                  height: `${String(5 + Math.round(level * weight * 16))}px`,
                }}
              />
            ))}
          </span>
          <strong>{phaseLabel[snapshot.phase]}</strong>
          {!pushToTalk ? (
            <span className={styles["inputMode"]}>免手持</span>
          ) : null}
          {retryable ? (
            <button
              className={styles["pushToTalk"]}
              type="button"
              onClick={onRetry}
            >
              <RotateCcw aria-hidden="true" size={13} />
              重试
            </button>
          ) : null}
          {pushToTalk && !snapshot.muted ? (
            <button
              className={styles["pushToTalk"]}
              type="button"
              onPointerDown={() => store.setPushToTalk(true)}
              onPointerLeave={() => store.setPushToTalk(false)}
              onPointerUp={() => store.setPushToTalk(false)}
            >
              按住说话
            </button>
          ) : null}
        </div>
        <p>{transcript || "你可以直接开始说话"}</p>
      </div>
      <button
        className={`${styles["roundButton"]} ${styles["endButton"]}`}
        type="button"
        aria-label="结束语音"
        onClick={onEnd}
      >
        <PhoneOff aria-hidden="true" size={16} />
      </button>
    </section>
  );
}
