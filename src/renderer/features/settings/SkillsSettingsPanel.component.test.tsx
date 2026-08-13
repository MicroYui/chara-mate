import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExtensionsApi,
  SkillDescriptor,
} from "../../../shared/contracts/extensions";
import { SkillsSettingsPanel } from "./SkillsSettingsPanel";

const activeSkill: SkillDescriptor = {
  archived: false,
  contentSha256: "0".repeat(64),
  description: "Run the verified release workflow.",
  enabled: true,
  id: "user:release-flow",
  lifecycle: "active",
  name: "release-flow",
  patchCount: 1,
  pinned: false,
  readOnly: false,
  revision: 2,
  source: "user",
  successCount: 1,
  useCount: 3,
};

const skillContent = `---
name: release-flow
description: Run the verified release workflow.
---

# Workflow
`;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeApi(initialSkill: SkillDescriptor) {
  let currentSkill: SkillDescriptor | undefined = initialSkill;
  let currentContent = skillContent;
  const unused = () => Promise.reject(new Error("not used"));
  const skillDelete = vi.fn<ExtensionsApi["skillDelete"]>((request) => {
    currentSkill = undefined;
    return Promise.resolve({
      ok: true,
      value: { skillId: request.skillId },
    });
  });
  const skillArchive = vi.fn<ExtensionsApi["skillArchive"]>(() => {
    currentSkill = {
      ...(currentSkill ?? activeSkill),
      archived: true,
      lifecycle: "archived",
    };
    return Promise.resolve({ ok: true, value: currentSkill });
  });
  const skillSave = vi.fn<ExtensionsApi["skillSave"]>((request) => {
    currentContent = request.content;
    currentSkill = {
      ...(currentSkill ?? activeSkill),
      archived: false,
      contentSha256: "1".repeat(64),
      lifecycle: "active",
      revision: (currentSkill?.revision ?? 0) + 1,
    };
    return Promise.resolve({ ok: true, value: currentSkill });
  });
  const skillRestore = vi.fn<ExtensionsApi["skillRestore"]>(() => {
    currentSkill = {
      ...(currentSkill ?? activeSkill),
      archived: false,
      lifecycle: "active",
      revision: (currentSkill?.revision ?? 0) + 1,
    };
    return Promise.resolve({ ok: true, value: currentSkill });
  });
  const api: ExtensionsApi = {
    mcpDelete: unused,
    mcpList: unused,
    mcpRefresh: unused,
    mcpSave: unused,
    skillArchive,
    skillDelete,
    skillGet: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { content: currentContent, skill: currentSkill ?? initialSkill },
      }),
    ),
    skillHistory: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: [
          {
            content: currentContent,
            contentSha256: initialSkill.contentSha256,
            createdAt: "2026-08-13T08:00:00.000Z",
            lifecycle: initialSkill.lifecycle,
            revision: initialSkill.revision,
          },
        ],
      }),
    ),
    skillList: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: currentSkill ? [currentSkill] : [],
      }),
    ),
    skillRefresh: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: currentSkill ? [currentSkill] : [],
      }),
    ),
    skillRestore,
    skillSave,
    skillSetEnabled: unused,
    skillSetPinned: unused,
  };
  return { api, skillArchive, skillDelete, skillRestore, skillSave };
}

describe("SkillsSettingsPanel", () => {
  it("edits, saves, and permanently deletes an active user Skill", async () => {
    const { api, skillDelete, skillSave } = makeApi(activeSkill);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SkillsSettingsPanel api={api} />);

    expect(await screen.findByDisplayValue("release-flow")).toBeEnabled();
    expect(screen.getByText("可编辑")).toBeVisible();
    expect(screen.getByRole("button", { name: "永久删除" })).toBeVisible();
    expect(screen.getByLabelText("SKILL.md")).toHaveAttribute("wrap", "soft");
    expect(screen.getByRole("checkbox", { name: /启用 Skill/u })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Pin 当前 Skill/u }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", {
        name: /release-flowRun the verified release workflow/u,
      }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "已保存" })).toBeDisabled();
    expect(
      screen.queryByRole("region", { name: "版本与恢复" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/用户 · r2/u)).not.toBeInTheDocument();

    const editedContent = skillContent.replace(
      "verified release workflow",
      "updated release workflow",
    );
    fireEvent.change(screen.getByLabelText("SKILL.md"), {
      target: { value: editedContent },
    });
    expect(screen.getByRole("button", { name: "归档 Skill" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    await waitFor(() =>
      expect(skillSave).toHaveBeenCalledWith({
        content: editedContent,
        name: "release-flow",
      }),
    );
    expect(await screen.findByText("已保存。")).toBeVisible();
    expect(screen.getByRole("button", { name: "归档 Skill" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("永久删除“release-flow”及其整个目录"),
    );
    await waitFor(() =>
      expect(skillDelete).toHaveBeenCalledWith({ skillId: activeSkill.id }),
    );
    expect(await screen.findByText("Skill 已永久删除。")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /release-flow/u }),
    ).not.toBeInTheDocument();
  });

  it("moves archive and restore into one explicit Skill lifecycle without version controls", async () => {
    const { api, skillArchive, skillRestore } = makeApi(activeSkill);
    render(<SkillsSettingsPanel api={api} />);

    expect(await screen.findByDisplayValue("release-flow")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "归档 Skill" }));

    await waitFor(() =>
      expect(skillArchive).toHaveBeenCalledWith({ skillId: activeSkill.id }),
    );
    expect(
      await screen.findByText("Skill 已归档；它已移出当前列表。"),
    ).toBeVisible();
    expect(screen.getByText("已归档", { selector: "strong" })).toBeVisible();
    expect(screen.getByRole("button", { name: "永久删除" })).toBeVisible();
    expect(screen.getByDisplayValue("release-flow")).toBeDisabled();
    expect(
      screen.queryByRole("region", { name: "版本与恢复" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复 Skill" }));

    await waitFor(() =>
      expect(skillRestore).toHaveBeenCalledWith({
        revision: activeSkill.revision,
        skillId: activeSkill.id,
      }),
    );
    expect(await screen.findByDisplayValue("release-flow")).toBeEnabled();
    expect(screen.getByRole("button", { name: "已保存" })).toBeDisabled();
  });

  it("keeps creating a new Skill as an explicit selection", async () => {
    const { api } = makeApi(activeSkill);
    render(<SkillsSettingsPanel api={api} />);

    expect(await screen.findByDisplayValue("release-flow")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "新建 Skill" }));

    expect(screen.getByDisplayValue("my-skill")).toBeEnabled();
    expect(
      screen.getByText("新建 Skill", { selector: "strong" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "永久删除" }),
    ).not.toBeInTheDocument();
  });
});
