import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

import { openApplicationDatabase } from "../../src/main/db/database";
import { TerritoryAssetStore } from "../../src/main/territory/territoryAssetStore";
import { TerritoryRepository } from "../../src/main/territory/territoryRepository";
import { TerritoryService } from "../../src/main/territory/territoryService";
import { territoryAssetUrl } from "../../src/shared/pure/territoryAsset";
import { FakeClock } from "../fixtures/fakeClock";
import { createSolidPng } from "../fixtures/png";
import { territoryCupManifest } from "../fixtures/territoryItemManifests";

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

    const behindDesk = await first.page.evaluate(async () => {
      const response = await window.charaMate.territory.movePet({
        from: { x: 10, y: 4 },
        sceneId: "forest-cabin",
        x: 14,
        y: 4,
      });
      return response.ok ? response.value.path : null;
    });
    expect(behindDesk).toEqual([
      { x: 10, y: 4 },
      { x: 11, y: 4 },
      { x: 12, y: 4 },
      { x: 13, y: 4 },
      { x: 14, y: 4 },
    ]);

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
          return fern?.target.kind === "ground"
            ? { x: fern.target.x, y: fern.target.y }
            : null;
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
      .toEqual([
        "collection.ceramic-cup",
        "collection.folded-letter",
        "collection.tiny-succulent",
        "forest-cabin.rug",
      ]);

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
          return rug?.target.kind === "ground"
            ? {
                collectionCount: response.ok
                  ? response.value.collection.length
                  : -1,
                x: rug.target.x,
                y: rug.target.y,
              }
            : null;
        }),
      )
      .toEqual({ collectionCount: 3, x: 6, y: 6 });

    await first.page.getByRole("button", { name: "收藏库" }).click();
    const accessoryDrawer = first.page.getByRole("complementary", {
      name: "领地收藏库",
    });
    await accessoryDrawer.getByRole("button", { name: /暖陶杯/u }).click();
    await expect(
      first.page.getByText("点击场景中发光的桌面插槽"),
    ).toBeVisible();
    await expect(accessoryDrawer).toBeHidden();
    await canvas.click({
      position: {
        x: offsetX + (11 * 48 + 36) * scale,
        y: offsetY + (4 * 48 + 34) * scale,
      },
    });
    await expect
      .poll(() =>
        first.page.evaluate(async () => {
          const response = await window.charaMate.territory.getSnapshot();
          const cup = response.ok
            ? response.value.activeScene?.placements.find(
                ({ id }) => id === "collection.ceramic-cup",
              )
            : undefined;
          return cup?.target ?? null;
        }),
      )
      .toEqual({
        kind: "surface",
        sceneId: "forest-cabin",
        slotId: "left",
        supportItemId: "forest-cabin.desk",
      });
    await first.page.getByRole("button", { name: "关闭物件详情" }).click();
    await first.page.getByRole("button", { name: "游览" }).click();
    await canvas.click({
      position: {
        x: offsetX + (11 * 48 + 36) * scale,
        y: offsetY + (4 * 48 + 20) * scale,
      },
    });
    await expect(
      first.page.getByRole("heading", { name: "暖陶杯" }),
    ).toBeVisible();

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

test("loads a generated image asset through the manifest domain path and restores its surface attachment", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-territory-asset-e2e-"),
  );
  const sourceImagePath = path.join(userDataDirectory, "generated-cup.png");
  const assetId = "asset.berry-cup.v1";
  const itemId = "generated.berry-cup";
  const manifest = {
    ...territoryCupManifest,
    definitionId: itemId,
    description: "由图片资产和结构化 manifest 安装的莓果杯。",
    name: "莓果杯",
    visual: {
      ...territoryCupManifest.visual,
      source: { assetId, kind: "asset" as const },
    },
  };
  let application: ElectronApplication | undefined;

  try {
    await writeFile(
      sourceImagePath,
      createSolidPng(24, 28, [224, 52, 142, 255]),
    );
    const database = openApplicationDatabase(
      path.join(userDataDirectory, "charamate.sqlite"),
    );
    const assets = new TerritoryAssetStore(
      path.join(userDataDirectory, "territory", "assets"),
      { normalize: (source) => source },
    );
    const service = new TerritoryService(
      new TerritoryRepository(database),
      assets,
      new FakeClock("2026-08-06T10:00:00.000Z"),
    );
    service.selectScene({ sceneId: "forest-cabin" });
    await service.installGeneratedItem({
      itemId,
      manifest,
      sourceImagePath,
    });
    database.close();

    const first = await launch(userDataDirectory);
    application = first.application;
    await openTerritory(first.page);
    await first.page.getByRole("button", { name: "布置" }).click();
    const drawer = first.page.getByRole("complementary", {
      name: "领地收藏库",
    });
    const generatedButton = drawer.getByRole("button", { name: /莓果杯/u });
    await expect(generatedButton).toBeVisible();
    await expect(generatedButton.locator("img")).toHaveAttribute(
      "src",
      territoryAssetUrl(assetId),
    );
    await generatedButton.click();
    await expect(drawer).toBeHidden();

    const canvas = first.page.getByTestId("territory-canvas").locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Territory canvas has no bounds");
    const scale = Math.min(box.width / 768, box.height / 480);
    const offsetX = (box.width - 768 * scale) / 2;
    const offsetY = (box.height - 480 * scale) / 2;
    await canvas.click({
      position: {
        x: offsetX + (11 * 48 + 36) * scale,
        y: offsetY + (4 * 48 + 34) * scale,
      },
    });
    await expect
      .poll(() =>
        first.page.evaluate(async (generatedItemId) => {
          const response = await window.charaMate.territory.getSnapshot();
          return response.ok
            ? response.value.activeScene?.placements.find(
                ({ id }) => id === generatedItemId,
              )?.target
            : null;
        }, itemId),
      )
      .toEqual({
        kind: "surface",
        sceneId: "forest-cabin",
        slotId: "left",
        supportItemId: "forest-cabin.desk",
      });
    await expect(canvas).toHaveAttribute("data-territory-asset-ids", assetId);
    await expect
      .poll(() =>
        first.page.evaluate(async (url) => {
          const response = await fetch(url);
          const blob = await response.blob();
          const image = await createImageBitmap(blob);
          return {
            height: image.height,
            mediaType: response.headers.get("content-type"),
            status: response.status,
            width: image.width,
          };
        }, territoryAssetUrl(assetId)),
      )
      .toEqual({
        height: 28,
        mediaType: "image/png",
        status: 200,
        width: 24,
      });

    await first.page.getByRole("button", { name: "游览" }).click();
    await canvas.click({
      position: {
        x: offsetX + (11 * 48 + 36) * scale,
        y: offsetY + (4 * 48 + 20) * scale,
      },
    });
    await expect(
      first.page.getByRole("heading", { name: "莓果杯" }),
    ).toBeVisible();
    const beforeRestart = await first.page.evaluate(async () => {
      const response = await window.charaMate.territory.getSnapshot();
      return response.ok ? response.value : null;
    });

    await application.close();
    application = undefined;
    const second = await launch(userDataDirectory);
    application = second.application;
    await openTerritory(second.page);
    const restoredCanvas = second.page
      .getByTestId("territory-canvas")
      .locator("canvas");
    await expect(restoredCanvas).toHaveAttribute(
      "data-territory-asset-ids",
      assetId,
    );
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
