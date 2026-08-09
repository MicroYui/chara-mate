import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderApi } from "../../../shared/contracts/provider";
import type { SettingsApi } from "../../../shared/contracts/settings";
import type { VoiceStore } from "../voice/voiceStore";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

const PROFILE_ID = "10000000-0000-4000-8000-000000000001";

afterEach(cleanup);

describe("Voice Settings panel", () => {
  it("loads one eligible Azure profile, previews the selected voice and saves user-facing settings", async () => {
    const saveVoice = vi
      .fn<SettingsApi["saveVoice"]>()
      .mockImplementation(({ voice }) =>
        Promise.resolve({
          ok: true,
          value: { ...voice, microphone: "granted" },
        }),
      );
    const settingsApi = {
      getSnapshot: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          agent: {
            defaultApprovalMode: "request_approval",
            defaultMode: "chat",
            workingDirectory: "/workspace",
          },
          browserComputer: {
            accessibility: "granted",
            browser: "ready",
            profileDirectory: "/profile",
            screenRecording: "granted",
          },
          voice: {
            inputMode: "hands_free",
            instructions: "自然、简洁地说中文。",
            microphone: "granted",
            providerProfileId: PROFILE_ID,
            voice: "verse",
          },
        },
      }),
      importBrowserCookies: vi.fn(),
      openManagedBrowser: vi.fn(),
      saveAgent: vi.fn(),
      saveVoice,
    } satisfies SettingsApi;
    const providerApi = {
      deleteProfile: vi.fn(),
      discoverModels: vi.fn(),
      listProfiles: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            apiStyle: "azure-openai",
            baseUrl: "https://unit.openai.azure.com/openai/v1",
            createdAt: "2026-08-08T12:00:00.000Z",
            hasApiKey: true,
            id: PROFILE_ID,
            name: "Azure Voice",
            realtimeEndpoint:
              "https://unit.openai.azure.com/openai/v1/realtime",
            realtimeModel: "gpt-realtime-2.1",
            updatedAt: "2026-08-08T12:00:00.000Z",
          },
        ],
      }),
      saveProfile: vi.fn(),
      testConnection: vi.fn(),
    } satisfies ProviderApi;
    const preview = vi.fn().mockResolvedValue(undefined);
    const voiceStore = { preview } as unknown as VoiceStore;

    render(
      <VoiceSettingsPanel
        providerApi={providerApi}
        settingsApi={settingsApi}
        voiceStore={voiceStore}
      />,
    );

    expect(await screen.findByText("已授权")).toBeVisible();
    expect(screen.getByRole("option", { name: /Azure Voice/u })).toBeVisible();
    fireEvent.change(screen.getByLabelText("音色"), {
      target: { value: "coral" },
    });
    fireEvent.change(screen.getByLabelText("输入方式"), {
      target: { value: "push_to_talk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "试听" }));
    await waitFor(() => {
      expect(preview).toHaveBeenCalledWith({
        instructions: "自然、简洁地说中文。",
        providerProfileId: PROFILE_ID,
        voice: "coral",
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(saveVoice).toHaveBeenCalledWith({
        voice: {
          inputMode: "push_to_talk",
          instructions: "自然、简洁地说中文。",
          providerProfileId: PROFILE_ID,
          voice: "coral",
        },
      });
    });
    expect(await screen.findByText("Voice 设置已保存。")).toBeVisible();
  });
});
