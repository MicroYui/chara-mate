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

test("manages real Chats and restores product state after an Electron restart", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-chats-e2e-"),
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  const launchApplication = async (expectedHeading = "新对话") => {
    const launched = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: {
        ...process.env,
        CHARAMATE_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await launched.firstWindow();
    await expect(
      page.getByRole("heading", { name: expectedHeading }),
    ).toBeVisible();
    return { launched, page };
  };

  try {
    const first = await launchApplication();
    application = first.launched;
    const page = first.page;
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
    expect(
      Math.abs(
        settingsBox!.y +
          settingsBox!.height / 2 -
          (collapseBox!.y + collapseBox!.height / 2),
      ),
    ).toBeLessThan(1);

    await page.getByRole("button", { name: "新建对话" }).click();
    await expect(
      page.getByRole("button", { exact: true, name: "新对话" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "更多会话操作" }).click();
    await page.getByRole("menuitem", { name: "重命名" }).click();
    const titleInput = page.getByRole("textbox", { name: "会话标题" });
    await titleInput.fill("Phase 1 真实会话");
    await titleInput.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Phase 1 真实会话" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "更多会话操作" }).click();
    await page.getByRole("menuitem", { name: "置顶" }).click();
    await expect(page.getByLabel("已置顶")).toBeVisible();

    await page.getByRole("button", { name: "聊聊今天发生的事" }).click();
    const composer = page.getByRole("textbox", { name: "消息" });
    await expect(composer).toHaveValue("聊聊今天发生的事");
    await expect(page.getByRole("button", { name: "发送" })).toBeDisabled();
    await page.getByRole("button", { exact: true, name: "Chat" }).click();
    await page.getByRole("menuitem", { name: /^Agent/u }).click();
    await expect(composer).toHaveValue("聊聊今天发生的事");
    await expect(page.getByRole("button", { name: /请求批准/u })).toBeVisible();
    await expect(page.getByRole("button", { name: "发送" })).toBeDisabled();

    await page.getByRole("button", { name: "新建对话" }).click();
    await page
      .getByRole("button", { exact: true, name: "新对话" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名" }).click();
    await page.getByRole("textbox", { name: "会话标题" }).fill("临时会话");
    await page.getByRole("textbox", { name: "会话标题" }).press("Enter");
    await expect(page.getByRole("heading", { name: "临时会话" })).toBeVisible();

    const search = page.getByRole("searchbox", { name: "搜索会话" });
    await search.focus();
    const searchFocusLayout = await search.evaluate((input) => {
      const field = input.closest("label");
      const navigation = input.closest("section");
      if (!field || !navigation) throw new Error("Missing search layout");
      const fieldBounds = field.getBoundingClientRect();
      const navigationBounds = navigation.getBoundingClientRect();
      return {
        boxShadow: window.getComputedStyle(field).boxShadow,
        topClearance: fieldBounds.top - navigationBounds.top,
      };
    });
    expect(searchFocusLayout.boxShadow).not.toBe("none");
    expect(searchFocusLayout.topClearance).toBeGreaterThanOrEqual(2);
    await search.fill("真实");
    await expect(
      page.getByRole("button", { exact: true, name: /Phase 1 真实会话/u }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { exact: true, name: "临时会话" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { exact: true, name: /Phase 1 真实会话/u })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "归档" }).click();
    await expect(page.getByText("没有匹配的会话")).toBeVisible();
    await page.getByRole("button", { name: "已归档" }).click();
    await expect(
      page.getByRole("heading", { name: "Phase 1 真实会话" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "恢复会话" }).click();
    await expect(page.getByRole("button", { name: "最近" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await search.fill("");
    await page
      .getByRole("button", { exact: true, name: "临时会话" })
      .click({ button: "right" });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("menuitem", { name: "删除" }).click();
    await expect(
      page.getByRole("button", { exact: true, name: "临时会话" }),
    ).toHaveCount(0);

    const savedBounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === "CharaMate",
      );
      if (!window) throw new Error("Missing main window");
      const current = window.getBounds();
      window.setBounds({
        height: 700,
        width: 1020,
        x: current.x + 20,
        y: current.y + 20,
      });
      return window.getBounds();
    });
    await page.getByRole("button", { name: "折叠侧栏" }).click();
    await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();

    await application.close();
    application = undefined;
    const second = await launchApplication("Phase 1 真实会话");
    application = second.launched;
    await expect(
      second.page.getByRole("heading", { name: "Phase 1 真实会话" }),
    ).toBeVisible();
    await expect(
      second.page.getByRole("button", { name: "展开侧栏" }),
    ).toBeVisible();
    const restoredBounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === "CharaMate",
      );
      if (!window) throw new Error("Missing main window");
      return window.getBounds();
    });
    expect(
      Math.abs(restoredBounds.width - savedBounds.width),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(restoredBounds.height - savedBounds.height),
    ).toBeLessThanOrEqual(2);
    expect(Math.abs(restoredBounds.x - savedBounds.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(restoredBounds.y - savedBounds.y)).toBeLessThanOrEqual(2);

    await second.page.getByRole("button", { name: "展开侧栏" }).click();
    await expect(
      second.page.getByRole("button", {
        exact: true,
        name: /Phase 1 真实会话/u,
      }),
    ).toBeVisible();
    await expect(
      second.page.getByRole("button", { exact: true, name: "临时会话" }),
    ).toHaveCount(0);
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true });
    }
  }
});
