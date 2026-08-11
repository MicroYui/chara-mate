import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CharacterWindowApi } from "../../shared/contracts/pet";
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

function renderCharacter() {
  let voiceListener:
    ((snapshot: VoiceSessionSnapshot | null) => void) | undefined;
  let approvalListener:
    Parameters<CharacterWindowApi["subscribeApproval"]>[0] | undefined;
  const quickStart = vi.fn<VoiceApi["quickStart"]>().mockImplementation(() => {
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
    focusApproval: vi.fn(),
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
    voice,
  };
  Object.defineProperty(window, "charaMateCharacter", {
    configurable: true,
    value: api,
  });
  render(<CharacterApp />);
  return {
    api,
    emitApproval: (approval: typeof approvalFixture | null) =>
      approvalListener?.(approval),
    end,
    quickStart,
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
});
