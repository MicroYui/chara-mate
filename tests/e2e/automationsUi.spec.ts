import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("operates a real Reminder from the Automations page and restores it", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-automations-ui-e2e-"),
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    const launch = async () => {
      const launched = await electron.launch({
        args: [projectRoot],
        cwd: projectRoot,
        env: {
          ...process.env,
          CHARAMATE_USER_DATA_DIR: userDataDirectory,
        },
      });
      return { launched, page: await launched.firstWindow() };
    };

    const first = await launch();
    application = first.launched;
    const page = first.page;
    await expect(page.getByRole("region", { name: "Chats" })).toBeVisible();

    await page.getByRole("button", { name: "Automations" }).click();
    await expect(
      page.getByRole("heading", { name: "按时提醒，也按时完成" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "新建任务" }).click();

    const form = page.getByRole("region", { name: "新建定时任务" });
    await expect(form).toBeVisible();
    await expect(form.getByLabel("名称")).toBeFocused();
    await expect(
      form.getByRole("radio", { exact: true, name: "Chat" }),
    ).toBeChecked();
    await expect(form.getByLabel("重复方式")).toHaveValue("once");

    await form.getByRole("radio", { name: /提醒/u }).click();
    await form.getByLabel("名称").fill("UI Core 集成提醒");
    await form.getByLabel("提醒内容").fill("旧运行历史保持原始提醒内容。");
    await form.getByLabel("重复方式").selectOption("daily");
    await form.getByLabel("本地时间").fill("09:30");
    await expect(form.getByLabel("时区")).not.toHaveValue("");
    await form.getByRole("button", { name: "创建任务" }).click();

    const detail = page.getByRole("region", { name: "任务详情" });
    await expect(detail).toBeVisible();
    await expect(
      page.getByRole("button", { name: "查看 UI Core 集成提醒" }),
    ).toBeVisible();
    await detail.getByRole("button", { exact: true, name: "立即试跑" }).click();
    await expect(
      page.getByText("提醒试跑已开始，结果会出现在运行历史中。"),
    ).toBeVisible();
    await expect(detail.getByText("已处理", { exact: true })).toBeVisible();
    await expect(detail.getByText(/提醒记录/u)).toBeVisible();

    await detail.getByRole("button", { exact: true, name: "暂停" }).click();
    await expect(detail.getByText("已暂停", { exact: true })).toBeVisible();
    await detail.getByRole("button", { exact: true, name: "恢复" }).click();
    await expect(detail.getByText("已启用", { exact: true })).toBeVisible();

    await detail.getByRole("button", { exact: true, name: "编辑" }).click();
    const editForm = page.getByRole("region", { name: "编辑定时任务" });
    await editForm.getByLabel("名称").fill("UI Core 集成提醒（已编辑）");
    await editForm.getByLabel("提醒内容").fill("新定义已保存。");
    await editForm.getByRole("button", { name: "保存修改" }).click();
    await expect(
      detail.getByRole("heading", { name: "UI Core 集成提醒（已编辑）" }),
    ).toBeVisible();
    await expect(detail.getByText("Revision 2", { exact: true })).toBeVisible();
    await expect(
      detail.getByText("新定义已保存。", { exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByText("旧运行历史保持原始提醒内容。", { exact: true }),
    ).toBeVisible();

    await application.close();
    application = undefined;
    const second = await launch();
    application = second.launched;
    await second.page.getByRole("button", { name: "Automations" }).click();
    await expect(
      second.page.getByRole("button", {
        name: "查看 UI Core 集成提醒（已编辑）",
      }),
    ).toBeVisible();
    await expect(
      second.page.getByText("旧运行历史保持原始提醒内容。", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true });
    }
  }
});
