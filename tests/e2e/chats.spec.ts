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

test("covers the Chats fixture interaction journey", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-chats-e2e-"),
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
    await expect(
      page.getByRole("heading", { name: "Phase 1 UI" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Territory" })).toBeVisible();
    const petImage = page.getByRole("img", { name: "Mika 桌宠" });
    await expect(petImage).toHaveJSProperty("complete", true);
    expect(
      await petImage.evaluate(
        (image) => (image as HTMLImageElement).naturalWidth,
      ),
    ).toBeGreaterThan(0);
    const settingsBox = await page
      .getByRole("button", { name: "Settings" })
      .boundingBox();
    const collapseBox = await page
      .getByRole("button", { name: "折叠侧栏" })
      .boundingBox();
    expect(settingsBox).not.toBeNull();
    expect(collapseBox).not.toBeNull();
    const settingsCenter = settingsBox!.y + settingsBox!.height / 2;
    const collapseCenter = collapseBox!.y + collapseBox!.height / 2;
    expect(Math.abs(settingsCenter - collapseCenter)).toBeLessThan(1);

    await page.getByRole("button", { name: "新建对话" }).click();
    await expect(
      page.getByRole("heading", { name: "今天想从哪里开始？" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "聊聊今天发生的事" }).click();
    await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue(
      "聊聊今天发生的事",
    );

    await page.getByRole("button", { exact: true, name: "Chat" }).click();
    await page.getByRole("menuitem", { name: /^Agent/u }).click();
    await expect(page.getByRole("button", { name: /请求批准/u })).toBeVisible();
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByRole("button", { name: "停止" })).toBeVisible();

    await page.getByRole("button", { name: /Phase 1 UI/u }).click();
    const completedRun = page.getByRole("button", { name: /已处理/u });
    await expect(completedRun).toHaveAttribute("aria-expanded", "false");
    await completedRun.click();
    await expect(page.getByText("已运行命令", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "实现 Chats UI" }).click();
    await expect(page.getByLabel("需要你的确认")).toBeVisible();
    await page.getByRole("button", { name: "查看详情" }).click();
    await expect(page.getByText("file.apply_patch")).toBeVisible();
    await page.getByRole("button", { name: "允许一次" }).click();
    await expect(page.getByRole("status")).toContainText("已允许一次");

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radio", { name: /暖灰/u }).check();
    await expect(page.locator("html")).toHaveAttribute(
      "data-background-scheme",
      "warm",
    );
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true });
    }
  }
});
