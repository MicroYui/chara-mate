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

test("recovers the main Renderer once after a process crash", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-recovery-e2e-"),
  );
  const application = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      CHARAMATE_USER_DATA_DIR: userDataDirectory,
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("region", { name: "Chats" })).toBeVisible();

    const recoveredWindow = application.waitForEvent("window", {
      predicate: async (candidate) => {
        await candidate.waitForLoadState("domcontentloaded");
        return (await candidate.title()) === "CharaMate";
      },
    });
    await application
      .evaluate(({ BrowserWindow }) => {
        const mainWindow = BrowserWindow.getAllWindows().find(
          (window) => window.getTitle() === "CharaMate",
        );
        if (!mainWindow) throw new Error("Main window is unavailable");
        mainWindow.webContents.forcefullyCrashRenderer();
      })
      .catch((error: unknown) => {
        if (
          !(error instanceof Error) ||
          !/Target crashed/u.test(error.message)
        ) {
          throw error;
        }
      });

    const recoveredPage = await recoveredWindow;
    await expect(
      recoveredPage.getByRole("region", { name: "Chats" }),
    ).toBeVisible();
    await expect(recoveredPage.getByTestId("foundation-status")).toContainText(
      "SQLite 已完成事务与重开读取",
    );
  } finally {
    await application.close();
    await rm(userDataDirectory, { force: true, recursive: true });
  }
});
