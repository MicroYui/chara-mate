import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function findMainWindow(application: ElectronApplication): Promise<Page> {
  await expect
    .poll(async () =>
      Promise.all(application.windows().map((window) => window.title())),
    )
    .toContain("CharaMate");
  for (const window of application.windows()) {
    if ((await window.title()) === "CharaMate") return window;
  }
  throw new Error("Missing CharaMate Main window");
}

async function launch(userDataDirectory: string) {
  const application = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      CHARAMATE_USER_DATA_DIR: userDataDirectory,
    },
  });
  const page = await findMainWindow(application);
  await expect(page.getByRole("heading", { name: "新对话" })).toBeVisible();
  return { application, page };
}

async function openTerritory(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Territory" }).click();
  await expect(page.getByRole("heading", { name: "Territory" })).toBeVisible();
}

test("completes first Territory setup, edits it, and restores the exact scene", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-territory-e2e-"),
  );
  let application: ElectronApplication | undefined;

  try {
    const first = await launch(userDataDirectory);
    application = first.application;
    await openTerritory(first.page);
    await expect(
      first.page.getByRole("heading", {
        name: "先选一处想停留的地方",
      }),
    ).toBeVisible();
    await first.page.getByRole("button", { name: /林间小屋/u }).click();
    await expect(first.page.getByTestId("territory-canvas")).toBeVisible();
    await expect(
      first.page.getByRole("button", { name: /桌宠向/u }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        first.page.evaluate(async () => {
          const response = await window.charaMate.territory.getSnapshot();
          return response.ok
            ? {
                itemCount: response.value.activeScene?.placements.length,
                sceneId: response.value.activeScene?.definition.id,
              }
            : null;
        }),
      )
      .toEqual({ itemCount: 4, sceneId: "forest-cabin" });

    const sceneCanvas = first.page
      .getByTestId("territory-canvas")
      .locator("canvas");
    const sceneBox = await sceneCanvas.boundingBox();
    if (!sceneBox) throw new Error("Territory canvas has no bounds");
    const sceneScale = Math.min(sceneBox.width / 768, sceneBox.height / 480);
    const sceneOffsetX = (sceneBox.width - 768 * sceneScale) / 2;
    const sceneOffsetY = (sceneBox.height - 480 * sceneScale) / 2;
    const scenePosition = (x: number, y: number) => ({
      x: sceneOffsetX + (x + 0.5) * 48 * sceneScale,
      y: sceneOffsetY + (y + 0.5) * 48 * sceneScale,
    });
    const scenePoint = (x: number, y: number) => {
      const position = scenePosition(x, y);
      return { x: sceneBox.x + position.x, y: sceneBox.y + position.y };
    };
    await sceneCanvas.click({ position: scenePosition(8, 6) });
    await expect
      .poll(() =>
        first.page.evaluate(async () => {
          const response = await window.charaMate.territory.getSnapshot();
          return response.ok ? response.value.activeScene?.pet : null;
        }),
      )
      .toMatchObject({ x: 8, y: 6 });
    await sceneCanvas.click({ position: scenePosition(7, 6) });
    await expect
      .poll(() =>
        first.page.evaluate(async () => {
          const response = await window.charaMate.territory.getSnapshot();
          return response.ok ? response.value.activeScene?.pet : null;
        }),
      )
      .toMatchObject({ facing: "left", x: 7, y: 6 });

    await first.page.getByRole("button", { name: "布置" }).click();
    const drawer = first.page.getByRole("complementary", {
      name: "领地收藏库",
    });
    await expect(drawer).toBeVisible();
    const fernStart = scenePoint(5, 4);
    const fernDestination = scenePoint(4, 6);
    await first.page.mouse.move(fernStart.x, fernStart.y);
    await first.page.mouse.down();
    await first.page.mouse.move(fernDestination.x, fernDestination.y, {
      steps: 5,
    });
    await first.page.mouse.up();
    await expect(
      first.page.getByRole("heading", { name: "蕨叶陶盆" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        first.page.evaluate(async () => {
          const response = await window.charaMate.territory.getSnapshot();
          const fern = response.ok
            ? response.value.activeScene?.placements.find(
                ({ id }) => id === "forest-cabin.fern",
              )
            : undefined;
          return fern ? { x: fern.x, y: fern.y } : null;
        }),
      )
      .toEqual({ x: 4, y: 6 });

    await drawer.getByRole("button", { name: /青苔软毯/u }).click();
    await first.page.getByRole("button", { name: "收回" }).click();
    await expect
      .poll(() =>
        first.page.evaluate(async () => {
          const response = await window.charaMate.territory.getSnapshot();
          return response.ok
            ? response.value.collection.map(({ id }) => id)
            : [];
        }),
      )
      .toEqual(["forest-cabin.rug"]);

    await first.page.getByRole("button", { name: "关闭收藏库" }).click();
    const canvas = first.page.getByTestId("territory-canvas").locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Territory canvas has no bounds");
    const scale = Math.min(box.width / 768, box.height / 480);
    const offsetX = (box.width - 768 * scale) / 2;
    const offsetY = (box.height - 480 * scale) / 2;
    await canvas.click({
      position: {
        x: offsetX + (6 + 0.5) * 48 * scale,
        y: offsetY + (6 + 0.5) * 48 * scale,
      },
    });
    await expect
      .poll(() =>
        first.page.evaluate(async () => {
          const response = await window.charaMate.territory.getSnapshot();
          const rug = response.ok
            ? response.value.activeScene?.placements.find(
                ({ id }) => id === "forest-cabin.rug",
              )
            : undefined;
          return rug
            ? {
                collectionCount: response.ok
                  ? response.value.collection.length
                  : -1,
                x: rug.x,
                y: rug.y,
              }
            : null;
        }),
      )
      .toEqual({ collectionCount: 0, x: 6, y: 6 });

    const beforeRestart = await first.page.evaluate(async () => {
      const response = await window.charaMate.territory.getSnapshot();
      return response.ok ? response.value : null;
    });
    expect(beforeRestart).not.toBeNull();

    await application.close();
    application = undefined;
    const second = await launch(userDataDirectory);
    application = second.application;
    await openTerritory(second.page);
    await expect(second.page.getByTestId("territory-canvas")).toBeVisible();
    await expect(
      second.page.getByRole("heading", {
        name: "先选一处想停留的地方",
      }),
    ).toHaveCount(0);
    const afterRestart = await second.page.evaluate(async () => {
      const response = await window.charaMate.territory.getSnapshot();
      return response.ok ? response.value : null;
    });
    expect(afterRestart).toEqual(beforeRestart);
  } finally {
    await application?.close();
    await rm(userDataDirectory, { force: true, recursive: true });
  }
});
