import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VoiceSessionSnapshot } from "../../../shared/contracts/voice";
import { VoiceDock } from "./VoiceDock";
import type { VoiceStore } from "./voiceStore";

const snapshot: VoiceSessionSnapshot = {
  assistantTranscript: "已经读取计划。",
  chatId: "10000000-0000-4000-8000-000000000001",
  connectedAt: "2026-08-08T12:00:01.000Z",
  createdAt: "2026-08-08T12:00:00.000Z",
  generation: 1,
  inputMode: "push_to_talk",
  muted: false,
  phase: "speaking",
  sessionId: "10000000-0000-4000-8000-000000000002",
  turnId: "10000000-0000-4000-8000-000000000003",
  userTranscript: "读取计划",
  voice: "verse",
};

afterEach(cleanup);

function store() {
  const setPushToTalk = vi.fn();
  const envelope = { input: 0.25, output: 0.8 };
  return {
    setPushToTalk,
    store: {
      getEnvelope: () => envelope,
      setPushToTalk,
      subscribeEnvelope: () => () => undefined,
    } as unknown as VoiceStore,
  };
}

describe("Voice Dock", () => {
  it("shows the audible transcript and keeps mute, push-to-talk and end explicit", () => {
    const value = store();
    const onEnd = vi.fn();
    const onMutedChange = vi.fn();
    render(
      <VoiceDock
        onEnd={onEnd}
        onMutedChange={onMutedChange}
        onRetry={vi.fn()}
        snapshot={snapshot}
        store={value.store}
      />,
    );

    expect(screen.getByText("正在说话")).toBeVisible();
    expect(screen.getByText("已经读取计划。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "麦克风静音" }));
    expect(onMutedChange).toHaveBeenCalledWith(true);
    const push = screen.getByRole("button", { name: "按住说话" });
    fireEvent.pointerDown(push);
    fireEvent.pointerUp(push);
    expect(value.setPushToTalk.mock.calls).toEqual([[true], [false]]);
    fireEvent.click(screen.getByRole("button", { name: "结束语音" }));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("offers an inline retry only for a retryable interrupted connection", () => {
    const value = store();
    const onRetry = vi.fn();
    render(
      <VoiceDock
        onEnd={vi.fn()}
        onMutedChange={vi.fn()}
        onRetry={onRetry}
        snapshot={{
          ...snapshot,
          error: {
            code: "VOICE.CONNECTION_CLOSED",
            message: "连接已断开。",
            retryable: true,
          },
          inputMode: "hands_free",
          phase: "interrupted",
        }}
        store={value.store}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("makes hands-free capture explicit without showing a hold control", () => {
    const value = store();
    render(
      <VoiceDock
        onEnd={vi.fn()}
        onMutedChange={vi.fn()}
        onRetry={vi.fn()}
        snapshot={{
          ...snapshot,
          assistantTranscript: "",
          inputMode: "hands_free",
          phase: "listening",
          userTranscript: "",
        }}
        store={value.store}
      />,
    );

    expect(screen.getByText("免手持")).toBeVisible();
    expect(screen.getByText("你可以直接开始说话")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "按住说话" }),
    ).not.toBeInTheDocument();
  });
});
