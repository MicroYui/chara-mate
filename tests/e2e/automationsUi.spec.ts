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

test("opens the Automations one-page form in the real desktop shell", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-automations-ui-e2e-"),
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    application = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        CHARAMATE_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "新对话" })).toBeVisible();

    await page.getByRole("button", { name: "Automations" }).click();
    await expect(
      page.getByRole("heading", { name: "按时提醒，也按时完成" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "新建任务" }).first().click();

    const form = page.getByRole("region", { name: "新建定时任务" });
    await expect(form).toBeVisible();
    await expect(form.getByLabel("名称")).toBeFocused();
    await expect(
      form.getByRole("radio", { exact: true, name: "Chat" }),
    ).toBeChecked();
    await expect(form.getByLabel("重复方式")).toHaveValue("once");

    await form.getByRole("radio", { name: /提醒/u }).click();
    await expect(form.getByLabel("提醒内容")).toBeVisible();
    await form.getByLabel("重复方式").selectOption("cron");
    await expect(form.getByLabel("POSIX 五段 Cron")).toBeVisible();
    await expect(form.getByLabel("时区")).not.toHaveValue("");
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true });
    }
  }
});
