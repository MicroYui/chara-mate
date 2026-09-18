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
  const child = application.process();
  const output: string[] = [];
  const captureOutput = (data: Buffer) => output.push(data.toString());
  child.stdout?.on("data", captureOutput);
  child.stderr?.on("data", captureOutput);
  try {
    const page = await findMainWindow(application);
    await expect(page.getByRole("region", { name: "Chats" })).toBeVisible();
    return { application, page };
  } catch (error) {
    const state = await application
      .evaluate(({ app, BrowserWindow }) => ({
        ready: app.isReady(),
        windows: BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          title: window.getTitle(),
          visible: window.isVisible(),
          destroyed: window.isDestroyed(),
        })),
      }))
      .catch((stateError: unknown) => ({ error: String(stateError) }));
    await test.info().attach("electron-startup-failure", {
      body: JSON.stringify({ pid: child.pid, state, output }),
      contentType: "application/json",
    });
    // launch owns this application until it returns it to the caller.
    await application.close().catch(async (closeError: unknown) => {
      await test.info().attach("electron-startup-close-failure", {
        body: String(closeError),
        contentType: "text/plain",
      });
    });
    throw error;
  } finally {
    child.stdout?.off("data", captureOutput);
    child.stderr?.off("data", captureOutput);
  }
}

async function openTerritory(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Territory" }).click();
  await expect(page.getByTestId("territory-world-canvas")).toBeVisible();
}

test("persists the World contract, lifecycle and immutable restore", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-territory-world-e2e-"),
  );
  let application: ElectronApplication | undefined;

  try {
    const first = await launch(userDataDirectory);
    application = first.application;
    const initial = await first.page.evaluate(async () => {
      const snapshot = await window.charaMate.territory.getSnapshot();
      if (!snapshot.ok) return { error: snapshot.error.code };
      const view = await window.charaMate.territory.getZoneView({
        revisionId: snapshot.value.world.currentRevision.id,
        zoneId: snapshot.value.world.activeZoneId,
      });
      return {
        collectionCount: snapshot.value.collection.length,
        currentRevisionId: snapshot.value.world.currentRevision.id,
        instanceCount: view.ok ? view.value.instances.length : -1,
        sequence: snapshot.value.world.currentRevision.sequence,
        worldId: snapshot.value.world.id,
        zoneName: snapshot.value.world.zones[0]?.name,
      };
    });
    expect(initial).toMatchObject({
      collectionCount: 1,
      instanceCount: 403,
      sequence: 1,
      worldId: "territory",
      zoneName: "住了很久的暮色小屋",
    });
    if (!("currentRevisionId" in initial)) {
      throw new Error("Territory World did not initialize");
    }

    const moved = await first.page.evaluate(async () => {
      const snapshot = await window.charaMate.territory.getSnapshot();
      if (!snapshot.ok) return null;
      const response = await window.charaMate.territory.movePet({
        from: snapshot.value.pet.point,
        to: { x: 7, y: 13 },
        zoneId: snapshot.value.world.activeZoneId,
      });
      return response.ok
        ? {
            destination: response.value.path.at(-1),
            revision: response.value.snapshot.world.currentRevision.sequence,
          }
        : null;
    });
    expect(moved).toMatchObject({ revision: 1 });
    expect(moved?.destination).not.toEqual({ x: 7, y: 13 });

    const trashed = await first.page.evaluate(async () => {
      const snapshot = await window.charaMate.territory.getSnapshot();
      if (!snapshot.ok || !snapshot.value.collection[0]) return null;
      const item = snapshot.value.collection[0];
      const timestamp = "2026-08-13T11:00:00.000Z";
      const response = await window.charaMate.territory.commitChangeSet({
        changeSet: {
          baseRevisionId: snapshot.value.world.currentRevision.id,
          id: "65000000-0000-4000-8000-000000000001",
          label: "把软毯移到回收站",
          mutations: [
            {
              changeId: "65000000-0000-4000-8000-000000000002",
              instance: {
                ...item,
                status: "trashed",
                trashedAt: timestamp,
                updatedAt: timestamp,
              },
              kind: "instance.put",
            },
          ],
        },
      });
      return response.ok
        ? {
            collectionCount: response.value.collection.length,
            sequence: response.value.world.currentRevision.sequence,
            trashIds: response.value.trash.map((entry) => entry.id),
          }
        : { error: response.error.code };
    });
    expect(trashed).toMatchObject({ collectionCount: 0, sequence: 2 });
    expect(trashed && "trashIds" in trashed ? trashed.trashIds : []).toContain(
      "44000000-0000-4000-8000-000000000001",
    );

    const restored = await first.page.evaluate(async (revisionId) => {
      const snapshot = await window.charaMate.territory.getSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.code);
      const response = await window.charaMate.territory.restoreRevision({
        expectedCurrentRevisionId: snapshot.value.world.currentRevision.id,
        revisionId,
      });
      return response.ok
        ? {
            collectionCount: response.value.collection.length,
            reason: response.value.world.currentRevision.reason,
            sequence: response.value.world.currentRevision.sequence,
          }
        : null;
    }, initial.currentRevisionId);
    expect(restored).toEqual({
      collectionCount: 1,
      reason: "restore",
      sequence: 3,
    });

    await application.close();
    application = undefined;
    const reopened = await launch(userDataDirectory);
    application = reopened.application;
    await expect
      .poll(() =>
        reopened.page.evaluate(async () => {
          const response = await window.charaMate.territory.getSnapshot();
          return response.ok
            ? {
                collectionCount: response.value.collection.length,
                sequence: response.value.world.currentRevision.sequence,
              }
            : null;
        }),
      )
      .toEqual({ collectionCount: 1, sequence: 3 });
  } finally {
    await application?.close();
    await rm(userDataDirectory, { force: true, recursive: true });
  }
});

test("opens the 2.5D build workspace and keeps failed AI work as a candidate", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-territory-workspace-e2e-"),
  );
  let application: ElectronApplication | undefined;

  try {
    const launched = await launch(userDataDirectory);
    application = launched.application;
    await openTerritory(launched.page);
    await expect(launched.page.getByText("暮色小屋").first()).toBeVisible();
    const canvas = launched.page
      .getByTestId("territory-world-canvas")
      .locator("canvas");
    await expect(canvas).toHaveAttribute(
      "data-territory-render-strategy",
      "zone-projection+direct-tree+asset-cache",
    );
    const initialZoom = await canvas.getAttribute("data-world-zoom");
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Territory canvas has no bounds");
    await launched.page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await launched.page.mouse.wheel(0, -180);
    await expect
      .poll(() => canvas.getAttribute("data-world-zoom"))
      .not.toBe(initialZoom);
    await launched.page.keyboard.down("Shift");
    await launched.page.mouse.down();
    await launched.page.mouse.move(
      bounds.x + bounds.width / 2 + 42,
      bounds.y + bounds.height / 2 + 26,
      { steps: 3 },
    );
    await launched.page.mouse.up();
    await launched.page.keyboard.up("Shift");
    await expect
      .poll(() => canvas.getAttribute("data-world-pan"))
      .not.toBe("0,0");
    await launched.page.getByRole("button", { name: "建造" }).click();
    await launched.page
      .getByRole("button", { exact: true, name: "物件库" })
      .click();
    await expect(launched.page.getByText(/无数量上限/u)).toBeVisible();
    await expect(launched.page.getByText("回收站是空的。")).toHaveCount(0);

    await launched.page.getByRole("button", { name: "关闭侧栏" }).click();
    await launched.page.getByRole("button", { name: /AI 创作/u }).click();
    await launched.page
      .getByRole("textbox", { name: "创作指令" })
      .fill("一盏会记住雨声的玻璃灯");
    const before = await launched.page.evaluate(async () => {
      const response = await window.charaMate.territory.getSnapshot();
      return response.ok ? response.value.world.currentRevision.id : null;
    });
    await launched.page
      .getByRole("button", { name: /生成可审阅预览/u })
      .click();
    await expect(launched.page.getByText("生成失败").first()).toBeVisible();
    await expect(launched.page.getByText(/请先配置一个带凭据/u)).toBeVisible();
    const after = await launched.page.evaluate(async () => {
      const response = await window.charaMate.territory.getSnapshot();
      return response.ok
        ? {
            candidateStatus: response.value.candidates[0]?.status,
            revisionId: response.value.world.currentRevision.id,
          }
        : null;
    });
    expect(after).toEqual({ candidateStatus: "failed", revisionId: before });
  } finally {
    await application?.close();
    await rm(userDataDirectory, { force: true, recursive: true });
  }
});
