import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SettingsRepository } from "../../src/main/app/settingsRepository";
import { SettingsService } from "../../src/main/app/settingsService";
import type { ManagedBrowser } from "../../src/main/browser/managedBrowser";
import { openApplicationDatabase } from "../../src/main/db/database";
import { SkillRepository } from "../../src/main/extensions/skillRepository";
import { SkillService } from "../../src/main/extensions/skillService";
import { ToolRegistry } from "../../src/main/tools/toolRegistry";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";

const NOW = "2026-08-08T12:00:00.000Z";
const RUN_ID = "10000000-0000-4000-8000-000000000001";
const ITEM_ID = "10000000-0000-4000-8000-000000000002";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
}

function skillMarkdown(
  name: string,
  description: string,
  body: string,
): string {
  return `---
name: ${name}
description: ${description}
---

${body}
`;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Phase 2 Agent Settings", () => {
  it("persists only user-facing defaults and refreshes workspace Skills on directory change", async () => {
    const root = await temporaryDirectory("chara-mate-settings-");
    const firstWorkspace = path.join(root, "first");
    const secondWorkspace = path.join(root, "second");
    await Promise.all([
      mkdir(firstWorkspace, { recursive: true }),
      mkdir(secondWorkspace, { recursive: true }),
    ]);
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    const repository = new SettingsRepository(database, firstWorkspace);
    const refreshed: string[] = [];
    let browserOpened = 0;
    const browser = {
      importCookies: () => Promise.resolve(3),
      open: () => {
        browserOpened += 1;
        return Promise.resolve();
      },
      profileDirectory: path.join(root, "browser-profile"),
      status: () => Promise.resolve("ready" as const),
    } as unknown as ManagedBrowser;
    const service = new SettingsService(
      repository,
      browser,
      {
        read: () => "granted",
        readMicrophone: () => "granted",
        readScreenRecording: () => "not_determined",
      },
      new FakeClock(NOW),
      (directory) => {
        refreshed.push(directory);
        return Promise.resolve();
      },
    );

    expect(await service.getSnapshot()).toEqual({
      agent: {
        defaultApprovalMode: "request_approval",
        defaultMode: "chat",
        workingDirectory: firstWorkspace,
      },
      browserComputer: {
        accessibility: "granted",
        browser: "ready",
        profileDirectory: path.join(root, "browser-profile"),
        screenRecording: "not_determined",
      },
      voice: {
        inputMode: "hands_free",
        instructions:
          "使用用户当前使用的语言自然、简洁地回应，并在用户切换语言时跟随；中文使用简体中文。角色整体开朗、有温度，处理任务时保持清楚可靠。允许自然停顿，不朗读命令、代码、JSON 和日志；涉及工具执行时只用一句短话说明正在做什么。",
        microphone: "granted",
        providerProfileId: "d0197d17-a231-41e0-afe2-664791a531ec",
        voice: "verse",
      },
    });
    await expect(
      service.saveAgent({
        defaultApprovalMode: "auto_approve",
        defaultMode: "agent",
        workingDirectory: secondWorkspace,
      }),
    ).resolves.toEqual({
      defaultApprovalMode: "auto_approve",
      defaultMode: "agent",
      workingDirectory: secondWorkspace,
    });
    expect(refreshed).toEqual([secondWorkspace]);
    expect(service.resolveWorkingPath("notes/today.md")).toBe(
      path.join(secondWorkspace, "notes/today.md"),
    );
    await expect(service.openManagedBrowser()).resolves.toEqual({
      message: "受管浏览器已打开。",
    });
    expect(browserOpened).toBe(1);
    await expect(
      service.importBrowserCookies(path.join(root, "cookies.json")),
    ).resolves.toMatchObject({ importedCookies: 3 });
    await expect(
      service.saveAgent({
        defaultApprovalMode: "full_access",
        defaultMode: "agent",
        workingDirectory: path.join(root, "missing"),
      }),
    ).rejects.toThrow("工作目录不存在");

    database.close();
    const reopened = openApplicationDatabase(path.join(root, "app.sqlite"));
    expect(new SettingsRepository(reopened, firstWorkspace).getAgent()).toEqual(
      {
        defaultApprovalMode: "auto_approve",
        defaultMode: "agent",
        workingDirectory: secondWorkspace,
      },
    );
    reopened.close();
  });
});

describe("Phase 2 Agent Skills", () => {
  it("discovers metadata, loads content progressively, versions edits and preserves archives across restart", async () => {
    const root = await temporaryDirectory("chara-mate-skills-");
    const workspace = path.join(root, "workspace");
    const workspaceSkillDirectory = path.join(
      workspace,
      ".agents",
      "skills",
      "workspace-review",
    );
    const userSkillsDirectory = path.join(root, "user-skills");
    await mkdir(workspaceSkillDirectory, { recursive: true });
    await writeFile(
      path.join(workspaceSkillDirectory, "SKILL.md"),
      skillMarkdown(
        "workspace-review",
        "Review a workspace change",
        "Read the changed files and report the outcome.",
      ),
      "utf8",
    );
    const database = openApplicationDatabase(path.join(root, "app.sqlite"));
    const clock = new FakeClock(NOW);
    const repository = new SkillRepository(database);
    const service = new SkillService(
      path.join(workspace, ".agents", "skills"),
      userSkillsDirectory,
      repository,
      new CryptoIdGenerator(),
      clock,
    );
    await service.initialize();

    expect(service.list()).toMatchObject([
      {
        id: "workspace:workspace-review",
        readOnly: true,
        revision: 1,
        source: "workspace",
      },
    ]);
    expect(service.instructions()).toContain(
      "workspace:workspace-review — workspace-review: Review a workspace change",
    );
    expect(service.instructions()).not.toContain("Read the changed files");

    const registry = new ToolRegistry();
    service.registerTools(registry);
    const loaded = await registry.execute(
      "skills.load",
      { skillId: "workspace:workspace-review" },
      {
        itemId: ITEM_ID,
        onDelta: () => undefined,
        runId: RUN_ID,
        signal: new AbortController().signal,
      },
    );
    expect(JSON.stringify(loaded.modelContent)).toContain(
      "Read the changed files",
    );
    expect(JSON.stringify(loaded.modelContent)).toContain(
      workspaceSkillDirectory,
    );
    expect(JSON.stringify(loaded.modelContent)).toContain(
      "workspace:workspace-review",
    );
    expect(service.list()[0]?.lastUsedAt).toBe(NOW);

    const first = await service.save(
      "repeatable-notes",
      skillMarkdown(
        "repeatable-notes",
        "Create consistent notes",
        "Use the requested note structure.",
      ),
    );
    expect(first).toMatchObject({
      id: "user:repeatable-notes",
      revision: 1,
      source: "user",
    });
    const second = await service.save(
      "repeatable-notes",
      skillMarkdown(
        "repeatable-notes",
        "Create consistent notes",
        "Use the updated note structure.",
      ),
    );
    expect(second.revision).toBe(2);
    service.setEnabled(second.id, false);
    expect(service.instructions()).not.toContain("Create consistent notes");
    await expect(
      registry.execute(
        "skills.load",
        { skillId: second.id },
        {
          itemId: ITEM_ID,
          onDelta: () => undefined,
          runId: RUN_ID,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow("未启用");
    service.setEnabled(second.id, true);
    const directDelete = await service.save(
      "direct-delete",
      skillMarkdown(
        "direct-delete",
        "Delete without a separate archive step",
        "Verify the direct deletion flow.",
      ),
    );
    await expect(service.delete(directDelete.id)).resolves.toBe(
      directDelete.id,
    );
    expect(repository.listVersions(directDelete.id)).toEqual([]);
    await expect(
      readFile(
        path.join(userSkillsDirectory, "direct-delete", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      service.delete("workspace:workspace-review"),
    ).rejects.toMatchObject({ code: "SKILL.READ_ONLY" });
    const archived = await service.archive(second.id);
    expect(archived).toMatchObject({ archived: true, revision: 2 });
    expect(service.instructions()).not.toContain("Create consistent notes");

    const archiveRoot = path.join(userSkillsDirectory, ".archive");
    const pendingRoot = path.join(userSkillsDirectory, ".delete-pending");
    const [archivedDirectory] = await readdir(archiveRoot);
    if (!archivedDirectory) throw new Error("Missing archived Skill directory");
    await mkdir(pendingRoot, { recursive: true });
    await rename(
      path.join(archiveRoot, archivedDirectory),
      path.join(pendingRoot, archivedDirectory),
    );

    const restarted = new SkillService(
      path.join(workspace, ".agents", "skills"),
      userSkillsDirectory,
      new SkillRepository(database),
      new CryptoIdGenerator(),
      clock,
    );
    await restarted.initialize();
    expect(restarted.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          archived: true,
          id: "user:repeatable-notes",
          revision: 2,
        }),
        expect.objectContaining({
          id: "workspace:workspace-review",
          readOnly: true,
        }),
      ]),
    );
    expect(await readdir(pendingRoot)).toEqual([]);
    await expect(restarted.delete("user:repeatable-notes")).resolves.toBe(
      "user:repeatable-notes",
    );
    expect(restarted.list()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "user:repeatable-notes" }),
      ]),
    );
    expect(repository.listVersions("user:repeatable-notes")).toEqual([]);

    const afterDeleteRestart = new SkillService(
      path.join(workspace, ".agents", "skills"),
      userSkillsDirectory,
      new SkillRepository(database),
      new CryptoIdGenerator(),
      clock,
    );
    await afterDeleteRestart.initialize();
    expect(
      afterDeleteRestart
        .list()
        .some(({ id }) => id === "user:repeatable-notes"),
    ).toBe(false);

    const nextWorkspace = path.join(root, "next-workspace");
    await mkdir(nextWorkspace, { recursive: true });
    await afterDeleteRestart.setWorkspaceDirectory(nextWorkspace);
    expect(
      afterDeleteRestart
        .list()
        .some(({ id }) => id === "workspace:workspace-review"),
    ).toBe(false);
    database.close();
  });
});
