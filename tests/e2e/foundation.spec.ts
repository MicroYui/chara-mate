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

test("launches through the typed preload boundary", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-e2e-"),
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
    await expect(
      page.getByRole("heading", { name: "工程基线已就绪" }),
    ).toBeVisible();

    const bridgeShape = await page.evaluate(() => ({
      foundationKeys: Object.keys(window.charaMate.foundation).sort(),
      rootKeys: Object.keys(window.charaMate).sort(),
      exposesRawIpcRenderer: "ipcRenderer" in window.charaMate,
    }));
    expect(bridgeShape).toEqual({
      foundationKeys: ["getSnapshot", "markRendererReady"],
      rootKeys: ["foundation"],
      exposesRawIpcRenderer: false,
    });

    const snapshot = await page.evaluate(() =>
      window.charaMate.foundation.getSnapshot(),
    );
    expect(snapshot).toMatchObject({
      appName: "CharaMate",
      databaseRoundTrip: true,
      electronVersion: "43.2.0",
      platform: "darwin",
    });
  } finally {
    await application.close();
    await rm(userDataDirectory, { force: true, recursive: true });
  }
});
