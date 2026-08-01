import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProviderApi,
  ProviderProfile,
} from "../../../shared/contracts/provider";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";

afterEach(cleanup);

const profile: ProviderProfile = {
  apiStyle: "azure-openai",
  apiVersion: "2025-04-01-preview",
  baseUrl: "https://example.openai.azure.com",
  chatModel: "deployment-a",
  createdAt: "2026-08-01T08:00:00.000Z",
  hasApiKey: true,
  id: "77777777-7777-4777-8777-777777777777",
  name: "Azure",
  updatedAt: "2026-08-01T08:00:00.000Z",
};

function createApi() {
  const deleteProfile = vi
    .fn<ProviderApi["deleteProfile"]>()
    .mockResolvedValue({
      ok: true,
      value: { profileId: profile.id },
    });
  const discoverModels = vi
    .fn<ProviderApi["discoverModels"]>()
    .mockResolvedValue({
      ok: true,
      value: {
        models: [{ createdAtUnixSeconds: 1, id: "model-a", ownedBy: "vendor" }],
        status: "available",
      },
    });
  const listProfiles = vi.fn<ProviderApi["listProfiles"]>().mockResolvedValue({
    ok: true,
    value: [profile],
  });
  const saveProfile = vi.fn<ProviderApi["saveProfile"]>().mockResolvedValue({
    ok: true,
    value: profile,
  });
  const testConnection = vi
    .fn<ProviderApi["testConnection"]>()
    .mockResolvedValue({
      ok: true,
      value: { modelCount: 1, status: "connected" },
    });
  const api: ProviderApi = {
    deleteProfile,
    discoverModels,
    listProfiles,
    saveProfile,
    testConnection,
  };
  return {
    api,
    deleteProfile,
    discoverModels,
    listProfiles,
    saveProfile,
    testConnection,
  };
}

describe("Provider Settings panel", () => {
  it("loads metadata without ever reading the saved API Key", async () => {
    const { api, saveProfile } = createApi();
    render(<ProviderSettingsPanel api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: /Azure/u }));
    const keyInput = screen.getByLabelText("API Key");
    expect(keyInput).toHaveValue("");
    expect(keyInput).toHaveAttribute("placeholder", "已安全保存；留空则保持");
    expect(api).not.toHaveProperty("getApiKey");

    fireEvent.click(screen.getByLabelText("保存时删除现有 API Key"));
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
    await waitFor(() => {
      expect(saveProfile).toHaveBeenCalledOnce();
      expect(saveProfile.mock.calls[0]?.[0].credential).toEqual({
        mode: "remove",
      });
    });
  });

  it("tests an unsaved draft, discovers models and saves a replacement key", async () => {
    const { api, saveProfile, testConnection } = createApi();
    render(<ProviderSettingsPanel api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "新建 Provider" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Local" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-renderer-submission" },
    });

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接成功，发现 1 个模型。")).toBeVisible();
    expect(testConnection.mock.calls[0]?.[0].connection).toMatchObject({
      apiKey: "sk-renderer-submission",
      source: "draft",
    });

    fireEvent.click(screen.getByRole("button", { name: "加载模型" }));
    expect(
      await screen.findByText("已加载 1 个模型，也可以继续手填。"),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Chat Model"), {
      target: { value: "model-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
    await waitFor(() => {
      const request = saveProfile.mock.calls[0]?.[0];
      expect(request?.credential).toEqual({
        mode: "replace",
        value: "sk-renderer-submission",
      });
      expect(request?.profile).toMatchObject({
        apiStyle: "openai-compatible",
        chatModel: "model-a",
        name: "Local",
      });
    });
  });

  it("keeps manual Model ID available when discovery is unsupported", async () => {
    const { api, discoverModels } = createApi();
    discoverModels.mockResolvedValue({
      ok: true,
      value: {
        reason: "model_list_unsupported",
        status: "manual_required",
      },
    });
    render(<ProviderSettingsPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /Azure/u }));
    fireEvent.click(screen.getByRole("button", { name: "加载模型" }));

    expect(
      await screen.findByText(
        "该 Provider 不支持模型发现，请手动填写 Model ID。",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Chat Model")).toBeEnabled();
  });

  it("shows a stable message when the preload request rejects unexpectedly", async () => {
    const { api, listProfiles } = createApi();
    listProfiles.mockRejectedValue(new Error("raw ipc failure"));

    render(<ProviderSettingsPanel api={api} />);

    const alert = await screen.findByText("Provider 请求失败，请稍后重试。");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toBeVisible();
    expect(screen.queryByText("raw ipc failure")).not.toBeInTheDocument();
  });
});
