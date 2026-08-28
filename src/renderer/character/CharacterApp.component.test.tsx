import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CharacterWindowApi,
  ProactiveConversationBubble,
} from "../../shared/contracts/pet";
import type {
  VoiceApi,
  VoiceSessionSnapshot,
} from "../../shared/contracts/voice";
import { approvalFixture } from "../../../tests/fixtures/foundationContracts";
import { CharacterApp } from "./CharacterApp";

vi.mock("../features/voice/WebRtcVoiceDriver", () => ({
  prepareMicrophone: vi.fn().mockResolvedValue({
    durationMs: 0,
    stream: {
      getAudioTracks: () => [],
      getTracks: () => [],
    },
  }),
  previewVoice: vi.fn(),
  WebRtcVoiceDriver: class {
    close(): void {}
    connect(): Promise<void> {
      return Promise.resolve();
    }
    handle(): void {}
    setCapture(): void {}
  },
}));

vi.mock("./PixiPetCanvas", () => ({
  PixiPetCanvas: () => null,
}));

const ACTIVE_VOICE: VoiceSessionSnapshot = {
  assistantTranscript: "",
  chatId: "10000000-0000-4000-8000-000000000001",
  connectedAt: "2026-08-09T06:00:01.000Z",
  createdAt: "2026-08-09T06:00:00.000Z",
  generation: 0,
  inputMode: "hands_free",
  muted: false,
  phase: "listening",
  sessionId: "10000000-0000-4000-8000-000000000002",
  userTranscript: "",
  voice: "verse",
};

beforeEach(() => {
  vi.stubGlobal(
    "AudioContext",
    class {
      state: AudioContextState = "suspended";

      close(): Promise<void> {
        this.state = "closed";
        return Promise.resolve();
      }

      resume(): Promise<void> {
        this.state = "running";
        return Promise.resolve();
      }
    },
  );
});

function renderCharacter(
  surface: "conversation" | "pet" = "pet",
  quickStartError?: Error,
) {
  let voiceListener:
    ((snapshot: VoiceSessionSnapshot | null) => void) | undefined;
  let approvalListener:
    Parameters<CharacterWindowApi["subscribeApproval"]>[0] | undefined;
  let proactiveListener:
    Parameters<CharacterWindowApi["subscribeProactiveBubble"]>[0] | undefined;
  const quickStart = vi.fn<VoiceApi["quickStart"]>().mockImplementation(() => {
    if (quickStartError) return Promise.reject(quickStartError);
    voiceListener?.(ACTIVE_VOICE);
    return Promise.resolve({
      ok: true,
      value: {
        callsUrl: "https://unit.openai.azure.com/openai/v1/realtime/calls",
        clientSecret: "ephemeral",
        expiresAt: "2026-08-09T06:01:00.000Z",
        history: [],
        inputMode: "hands_free",
        sessionId: ACTIVE_VOICE.sessionId,
        voice: "verse",
      },
    });
  });
  const end = vi.fn<VoiceApi["end"]>().mockImplementation(() => {
    voiceListener?.(null);
    return Promise.resolve({ ok: true, value: null });
  });
  const setPaused = vi
    .fn<VoiceApi["setPaused"]>()
    .mockImplementation((request) => {
      const snapshot = {
        ...ACTIVE_VOICE,
        phase: request.paused ? ("paused" as const) : ("listening" as const),
      };
      voiceListener?.(snapshot);
      return Promise.resolve({
        ok: true,
        value: { snapshot },
      });
    });
  const resolveApproval = vi
    .fn<CharacterWindowApi["resolveApproval"]>()
    .mockResolvedValue({
      ok: true,
      value: {
        ...approvalFixture,
        decidedAt: "2026-08-09T06:00:02.000Z",
        status: "approved",
      },
    });
  const dismissProactiveBubble =
    vi.fn<CharacterWindowApi["dismissProactiveBubble"]>();
  const replyProactiveBubble = vi
    .fn<CharacterWindowApi["replyProactiveBubble"]>()
    .mockResolvedValue({
      ok: true,
      value: { runId: "20000000-0000-4000-8000-000000000099" },
    });
  const focusConversation = vi.fn<CharacterWindowApi["focusConversation"]>();
  const voice: VoiceApi = {
    end,
    getActive: vi.fn().mockResolvedValue({ ok: true, value: null }),
    preview: vi.fn(),
    quickStart,
    report: vi.fn().mockResolvedValue({ ok: true, value: null }),
    setMuted: vi.fn(),
    setPaused,
    start: vi.fn(),
    subscribeChanged: (listener) => {
      voiceListener = listener;
      return () => {
        if (voiceListener === listener) voiceListener = undefined;
      };
    },
    subscribeCommand: () => () => undefined,
  };
  const api: CharacterWindowApi = {
    endDrag: vi.fn().mockResolvedValue({ moved: false }),
    dismissProactiveBubble,
    focusApproval: vi.fn(),
    focusConversation,
    focusMain: vi.fn(),
    getPendingApproval: vi.fn().mockResolvedValue({ ok: true, value: null }),
    getSnapshot: vi.fn().mockResolvedValue({
      activePet: null,
      animation: "idle",
      animationSpeed: 0.75,
      facing: "right",
      scale: 1,
    }),
    markReady: vi.fn(),
    moveDrag: vi.fn(),
    replyProactiveBubble,
    resolveApproval,
    showContextMenu: vi.fn(),
    startDrag: vi.fn().mockResolvedValue({ moved: false }),
    subscribe: () => () => undefined,
    subscribeApproval: (listener) => {
      approvalListener = listener;
      return () => {
        if (approvalListener === listener) approvalListener = undefined;
      };
    },
    subscribeProactiveBubble: (listener) => {
      proactiveListener = listener;
      return () => {
        if (proactiveListener === listener) proactiveListener = undefined;
      };
    },
    voice,
    voiceWake: {
      getSnapshot: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          enabled: false,
          microphone: "granted",
          phase: "disabled",
          phrase: "Hi Mika",
        },
      }),
      report: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          enabled: false,
          microphone: "granted",
          phase: "disabled",
          phrase: "Hi Mika",
        },
      }),
      subscribe: vi.fn(() => () => undefined),
    },
  };
  Object.defineProperty(window, "charaMateCharacter", {
    configurable: true,
    value: api,
  });
  render(<CharacterApp surface={surface} />);
  return {
    api,
    dismissProactiveBubble,
    emitApproval: (approval: typeof approvalFixture | null) =>
      approvalListener?.(approval),
    emitProactive: (bubble: ProactiveConversationBubble | null) =>
      proactiveListener?.(bubble),
    end,
    focusConversation,
    quickStart,
    replyProactiveBubble,
    resolveApproval,
    setPaused,
  };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "charaMateCharacter");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Character chat control", () => {
  it("starts, pauses, and resumes the same Voice Agent Chat", async () => {
    const { end, quickStart, setPaused } = renderCharacter();
    const startButton = await screen.findByRole("button", {
      name: "开始语音聊天",
    });
    expect(startButton.textContent).toBe("");
    expect(startButton.querySelector(".lucide-audio-lines")).not.toBeNull();

    fireEvent.click(startButton);
    await waitFor(() => expect(quickStart).toHaveBeenCalledOnce());
    expect(typeof quickStart.mock.calls[0]?.[0].requestedAt).toBe("string");
    const pauseButton = await screen.findByRole("button", {
      name: "暂停语音聊天",
    });

    fireEvent.click(pauseButton);
    await waitFor(() => expect(setPaused).toHaveBeenCalledTimes(1));
    const pauseRequest = setPaused.mock.calls[0]?.[0];
    expect(pauseRequest).toMatchObject({
      paused: true,
      sessionId: ACTIVE_VOICE.sessionId,
    });
    expect(typeof pauseRequest?.requestedAt).toBe("string");
    const resumeButton = await screen.findByRole("button", {
      name: "恢复语音聊天",
    });

    fireEvent.click(resumeButton);
    await waitFor(() => expect(setPaused).toHaveBeenCalledTimes(2));
    const resumeRequest = setPaused.mock.calls[1]?.[0];
    expect(resumeRequest).toMatchObject({
      paused: false,
      sessionId: ACTIVE_VOICE.sessionId,
    });
    expect(typeof resumeRequest?.requestedAt).toBe("string");
    expect(end).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: "暂停语音聊天" }),
    ).toBeInTheDocument();
  });

  it("lets the user dismiss a failed Voice connection notice", async () => {
    const { end, quickStart } = renderCharacter(
      "pet",
      new Error("无法连接 Azure Realtime。"),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "开始语音聊天" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法连接 Azure Realtime。",
    );
    expect(quickStart).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "关闭语音错误提示" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(quickStart).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "开始语音聊天" }),
    ).toBeInTheDocument();
  });

  it("shows the pending approval as an actionable pet bubble", async () => {
    const { emitApproval, resolveApproval } = renderCharacter();
    await screen.findByRole("button", { name: "开始语音聊天" });

    act(() => emitApproval(approvalFixture));
    const bubble = screen.getByRole("region", { name: "桌宠审批提醒" });
    expect(bubble).toHaveTextContent("需要你的允许");
    expect(bubble).toHaveTextContent("command.execute");
    expect(bubble).toHaveTextContent(approvalFixture.parameterSummary);

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    await waitFor(() =>
      expect(resolveApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: approvalFixture.id,
          decision: "approved",
        }),
      ),
    );
  });

  it("starts a Voice Chat in the bubble's exact bound Chat", async () => {
    const {
      dismissProactiveBubble,
      emitProactive,
      focusConversation,
      quickStart,
    } = renderCharacter("conversation");
    await act(async () => Promise.resolve());
    const bubble = {
      chatId: "20000000-0000-4000-8000-000000000001",
      content: "你在整理这篇文章吗？",
      createdAt: "2026-08-13T09:00:00.000Z",
      id: "20000000-0000-4000-8000-000000000002",
      kind: "continuation",
      replyState: "ready",
    } satisfies ProactiveConversationBubble;

    act(() => emitProactive(bubble));
    expect(
      screen.getByRole("region", { name: "角色发起的对话" }),
    ).toHaveTextContent(bubble.content);

    fireEvent.click(
      screen.getByRole("button", { name: "在同一对话中语音回复" }),
    );
    await waitFor(() =>
      expect(quickStart).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: bubble.chatId,
          execution: { mode: "chat" },
        }),
      ),
    );
    expect(dismissProactiveBubble).not.toHaveBeenCalled();
    expect(focusConversation).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "关闭这次对话邀请" }),
      ).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "打开完整 Chat" }));
    expect(focusConversation).toHaveBeenCalledWith({
      chatId: bubble.chatId,
    });
    expect(
      screen.getByRole("region", { name: "角色发起的对话" }),
    ).toBeInTheDocument();
  });

  it("keeps continuous text replies in the exact originating Chat without opening Main", async () => {
    const { emitProactive, focusConversation, replyProactiveBubble } =
      renderCharacter("conversation");
    const bubble = {
      chatId: "20000000-0000-4000-8000-000000000003",
      content: "这篇文章看到哪里了？",
      createdAt: "2026-08-13T09:00:00.000Z",
      id: "20000000-0000-4000-8000-000000000004",
      kind: "continuation",
      replyState: "ready",
    } satisfies ProactiveConversationBubble;

    act(() => emitProactive(bubble));
    const input = screen.getByRole("textbox", { name: "在气泡中回复" });
    fireEvent.change(input, { target: { value: "刚看到方法部分" } });
    fireEvent.click(screen.getByRole("button", { name: "发送气泡回复" }));

    await waitFor(() => expect(replyProactiveBubble).toHaveBeenCalledOnce());
    const firstReply = replyProactiveBubble.mock.calls[0]?.[0];
    expect(firstReply).toMatchObject({
      bubbleId: bubble.id,
      content: "刚看到方法部分",
    });
    expect(typeof firstReply?.requestedAt).toBe("string");
    expect(focusConversation).not.toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: "角色发起的对话" }),
    ).toBeInTheDocument();

    act(() => emitProactive({ ...bubble, replyState: "responding" }));
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveAttribute("aria-disabled", "true");
    act(() =>
      emitProactive({
        ...bubble,
        content: "方法部分有哪一段最难处理？",
        createdAt: "2026-08-13T09:00:02.000Z",
        replyState: "ready",
      }),
    );
    await waitFor(() => expect(input).toHaveValue(""));
    expect(input).not.toHaveAttribute("readonly");
    expect(screen.getByText("方法部分有哪一段最难处理？")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "实验设计那一段" } });
    fireEvent.click(screen.getByRole("button", { name: "发送气泡回复" }));
    await waitFor(() => expect(replyProactiveBubble).toHaveBeenCalledTimes(2));
    expect(replyProactiveBubble.mock.calls[1]?.[0]).toMatchObject({
      bubbleId: bubble.id,
      content: "实验设计那一段",
    });
    expect(focusConversation).not.toHaveBeenCalled();
  });

  it("does not offer the full Chat until a new-topic invitation is established", () => {
    const { emitProactive } = renderCharacter("conversation");
    const invitation = {
      chatId: "20000000-0000-4000-8000-000000000007",
      content: "你在整理一篇新文章吗？",
      createdAt: "2026-08-13T09:00:00.000Z",
      id: "20000000-0000-4000-8000-000000000008",
      kind: "invitation",
      replyState: "ready",
    } satisfies ProactiveConversationBubble;

    act(() => emitProactive(invitation));
    expect(
      screen.queryByRole("button", { name: "打开完整 Chat" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "发送气泡回复" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在同一对话中语音回复" }),
    ).toBeInTheDocument();

    act(() => emitProactive({ ...invitation, kind: "continuation" }));
    expect(
      screen.getByRole("button", { name: "打开完整 Chat" }),
    ).toBeInTheDocument();
  });

  it("opens the exact bound Chat only when the user chooses the full surface", () => {
    const { emitProactive, focusConversation } =
      renderCharacter("conversation");
    const bubble = {
      chatId: "20000000-0000-4000-8000-000000000005",
      content: "需要展开看完整上下文吗？",
      createdAt: "2026-08-13T09:00:00.000Z",
      id: "20000000-0000-4000-8000-000000000006",
      kind: "continuation",
      replyState: "ready",
    } satisfies ProactiveConversationBubble;

    act(() => emitProactive(bubble));
    fireEvent.click(screen.getByRole("button", { name: "打开完整 Chat" }));

    expect(focusConversation).toHaveBeenCalledWith({
      bubbleId: bubble.id,
      chatId: bubble.chatId,
    });
    expect(
      screen.queryByRole("region", { name: "角色发起的对话" }),
    ).not.toBeInTheDocument();
  });
});
