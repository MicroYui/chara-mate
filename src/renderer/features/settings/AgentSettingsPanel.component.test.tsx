import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SettingsApi } from "../../../shared/contracts/settings";
import { AgentSettingsPanel } from "./AgentSettingsPanel";

afterEach(cleanup);

function createApi() {
  const agent = {
    defaultApprovalMode: "request_approval" as const,
    defaultMode: "chat" as const,
    workingDirectory: "/workspace/chara-mate",
  };
  const saveAgent = vi
    .fn<SettingsApi["saveAgent"]>()
    .mockImplementation(({ agent: next }) =>
      Promise.resolve({ ok: true, value: next }),
    );
  const api: SettingsApi = {
    getDataSnapshot: vi.fn(),
    getSnapshot: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        agent,
        browserComputer: {
          accessibility: "granted",
          browser: "ready",
          profileDirectory: "/browser/profile",
          screenRecording: "granted",
        },
        companionInitiative: {
          level: "balanced",
          quietHours: {
            enabled: true,
            endMinute: 8 * 60,
            startMinute: 22 * 60,
          },
        },
        voice: {
          inputMode: "hands_free",
          instructions: "使用自然、简洁的中文口语。",
          microphone: "granted",
          providerProfileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          voice: "verse",
        },
      },
    }),
    importBrowserCookies: vi.fn(),
    openDataDirectory: vi.fn(),
    openManagedBrowser: vi.fn(),
    saveAgent,
    saveCompanionInitiative: vi.fn(),
    saveVoice: vi.fn(),
  };
  return { api, saveAgent };
}

describe("Agent Settings panel", () => {
  it("keeps select values stable and saves them without crashing the Renderer", async () => {
    const { api, saveAgent } = createApi();
    render(<AgentSettingsPanel api={api} />);

    const defaultMode = await screen.findByLabelText("默认模式");
    const approvalMode = screen.getByLabelText("Agent 默认权限");
    fireEvent.change(defaultMode, { target: { value: "agent" } });
    fireEvent.change(approvalMode, { target: { value: "full_access" } });

    expect(defaultMode).toHaveValue("agent");
    expect(approvalMode).toHaveValue("full_access");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(saveAgent).toHaveBeenCalledWith({
        agent: {
          defaultApprovalMode: "full_access",
          defaultMode: "agent",
          workingDirectory: "/workspace/chara-mate",
        },
      });
    });
  });
});
