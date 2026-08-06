import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { expect, test } from "@playwright/test";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

import { openApplicationDatabase } from "../../src/main/db/database";
import { PetLibraryRepository } from "../../src/main/pet/petLibraryRepository";
import { PetService } from "../../src/main/pet/petService";
import { PetStateRepository } from "../../src/main/pet/petStateRepository";
import { SystemClock } from "../../src/shared/pure/clock";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBuffer, data])),
    8 + data.length,
  );
  return chunk;
}

function transparentPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function createSourcePet(
  sources: string,
  pet: { id: string; name: string; version: 1 | 2 },
): Promise<string> {
  const directory = path.join(sources, `${pet.id}-source-folder`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "pet.json"),
    JSON.stringify({
      description: `${pet.name} automated atlas`,
      displayName: pet.name,
      id: pet.id,
      ...(pet.version === 2 ? { spriteVersionNumber: 2 } : {}),
      spritesheetPath: "spritesheet.png",
    }),
    "utf8",
  );
  await writeFile(
    path.join(directory, "spritesheet.png"),
    transparentPng(1536, pet.version === 2 ? 2288 : 1872),
  );
  return directory;
}

async function findWindow(
  application: ElectronApplication,
  title: string,
): Promise<Page> {
  await expect
    .poll(async () => {
      const titles = await Promise.all(
        application.windows().map((window) => window.title()),
      );
      return titles;
    })
    .toContain(title);
  const windows = application.windows();
  const titles = await Promise.all(windows.map((window) => window.title()));
  const index = titles.indexOf(title);
  const window = windows[index];
  if (!window) throw new Error(`Missing Electron window: ${title}`);
  return window;
}

async function launchApplication(userDataDirectory: string) {
  const application = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      CHARAMATE_USER_DATA_DIR: userDataDirectory,
    },
  });
  const main = await findWindow(application, "CharaMate");
  const character = await findWindow(application, "CharaMate Character");
  await expect(main.getByRole("heading", { name: "新对话" })).toBeVisible();
  return { application, character, main };
}

test("renders imported v1/v2 pets in a transparent movable window and restores it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chara-mate-pet-e2e-"));
  const userDataDirectory = path.join(root, "user-data");
  const sources = path.join(root, "sources");
  let application: ElectronApplication | undefined;

  try {
    const linnea = await createSourcePet(sources, {
      id: "linnea",
      name: "Linnea",
      version: 1,
    });
    const columbinya = await createSourcePet(sources, {
      id: "columbinya",
      name: "Columbinya",
      version: 2,
    });
    const database = openApplicationDatabase(
      path.join(userDataDirectory, "charamate.sqlite"),
    );
    const repository = new PetLibraryRepository(
      path.join(userDataDirectory, "pets"),
    );
    await repository.importFrom(linnea);
    await repository.importFrom(columbinya);
    const service = new PetService(
      repository,
      new PetStateRepository(database),
      new SystemClock(),
    );
    await service.initialize();
    await service.select("columbinya");
    database.close();
    await rm(sources, { force: true, recursive: true });

    const first = await launchApplication(userDataDirectory);
    application = first.application;
    await expect(
      first.character.getByRole("button", { name: "Columbinya 桌宠" }),
    ).toBeVisible();
    await expect(
      first.main.getByRole("img", { name: "Columbinya 桌宠缩略图" }),
    ).toHaveAttribute("style", /columbinya/u);
    await expect(first.character.locator("canvas")).toHaveCount(1);
    await expect(
      first.character.locator("[data-pet-render-ready='true']"),
    ).toHaveCount(1);
    await expect(first.character.getByRole("alert")).toHaveCount(0);

    const windowFlags = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === "CharaMate Character",
      );
      if (!window) throw new Error("Missing Character window");
      return {
        alwaysOnTop: window.isAlwaysOnTop(),
        maximizable: window.isMaximizable(),
        resizable: window.isResizable(),
      };
    });
    expect(windowFlags).toEqual({
      alwaysOnTop: true,
      maximizable: false,
      resizable: false,
    });

    const directionOrigin = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === "CharaMate Character",
      );
      if (!window) throw new Error("Missing Character window");
      return window.getBounds();
    });
    await first.character.evaluate(async () => {
      await window.charaMateCharacter.startDrag({ screenX: 100, screenY: 100 });
      window.charaMateCharacter.moveDrag({ screenX: 180, screenY: 100 });
      window.charaMateCharacter.moveDrag({ screenX: 160, screenY: 100 });
      await window.charaMateCharacter.endDrag({ screenX: 160, screenY: 100 });
    });
    await expect
      .poll(() =>
        first.character.evaluate(() => window.charaMateCharacter.getSnapshot()),
      )
      .toMatchObject({ facing: "left" });
    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.getTitle() === "CharaMate Character",
          );
          if (!window) throw new Error("Missing Character window");
          return window.getBounds().x;
        }),
      )
      .toBe(directionOrigin.x + 60);

    await first.main.getByRole("button", { name: "Settings" }).click();
    await first.main.getByRole("button", { name: "Character" }).click();
    await expect(
      first.main.getByRole("heading", { name: "桌面角色" }),
    ).toBeVisible();
    await expect(
      first.main.getByRole("button", { name: "Columbinya 已选" }),
    ).toBeDisabled();
    await expect(
      first.main.getByRole("listitem").filter({ hasText: "Linnea" }),
    ).toContainText("v1");
    await expect(
      first.main
        .getByRole("listitem")
        .filter({ hasText: "Columbinya" })
        .locator("[style*='chara-mate-pet']"),
    ).toHaveCount(1);
    await expect(first.main.getByLabel("桌宠大小")).toHaveAttribute(
      "min",
      "0.3",
    );
    await expect(first.main.getByLabel("动画速度")).toHaveAttribute(
      "min",
      "0.1",
    );
    await expect(first.main.locator("output")).toHaveCount(0);

    await first.main.getByRole("button", { name: "选择 Linnea" }).click();
    await expect(
      first.character.getByRole("button", { name: "Linnea 桌宠" }),
    ).toBeVisible();
    await expect(
      first.character.locator("[data-pet-render-ready='true']"),
    ).toHaveCount(1);
    await expect(
      first.main.getByRole("img", { name: "Linnea 桌宠缩略图" }),
    ).toHaveAttribute("style", /linnea/u);
    await first.main.getByLabel("桌宠大小").fill("1.25");
    await first.main.getByLabel("动画速度").fill("0.6");
    await expect(first.main.getByLabel("桌宠大小")).toHaveValue("1.25");
    await expect(first.main.getByLabel("动画速度")).toHaveValue("0.6");

    const boundsBeforeDrag = await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.getTitle() === "CharaMate Character",
          );
          if (!window) throw new Error("Missing Character window");
          return window.getBounds();
        }),
      )
      .toMatchObject({ height: 260, width: 240 });
    void boundsBeforeDrag;

    const originalBounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === "CharaMate Character",
      );
      if (!window) throw new Error("Missing Character window");
      return window.getBounds();
    });
    await first.character.mouse.move(120, 130);
    await first.character.mouse.down();
    await first.character.mouse.move(160, 160, { steps: 4 });
    await first.character.mouse.up();
    const draggedBounds = await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.getTitle() === "CharaMate Character",
          );
          if (!window) throw new Error("Missing Character window");
          return window.getBounds();
        }),
      )
      .not.toEqual(originalBounds);
    void draggedBounds;
    const savedBounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === "CharaMate Character",
      );
      if (!window) throw new Error("Missing Character window");
      return window.getBounds();
    });

    await application.close();
    application = undefined;
    const second = await launchApplication(userDataDirectory);
    application = second.application;
    await expect(
      second.character.getByRole("button", { name: "Linnea 桌宠" }),
    ).toBeVisible();
    await expect(
      second.main.getByRole("img", { name: "Linnea 桌宠缩略图" }),
    ).toHaveAttribute("style", /linnea/u);
    await expect
      .poll(() => second.main.evaluate(() => window.charaMate.pet.getLibrary()))
      .toMatchObject({
        ok: true,
        value: { animationSpeed: 0.6, scale: 1.25 },
      });
    const restoredBounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === "CharaMate Character",
      );
      if (!window) throw new Error("Missing Character window");
      return window.getBounds();
    });
    expect(restoredBounds.width).toBe(savedBounds.width);
    expect(restoredBounds.height).toBe(savedBounds.height);
    expect(Math.abs(restoredBounds.x - savedBounds.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(restoredBounds.y - savedBounds.y)).toBeLessThanOrEqual(2);

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === "CharaMate",
      );
      if (!window) throw new Error("Missing Main window");
      window.close();
    });
    await expect
      .poll(async () =>
        Promise.all(application!.windows().map((window) => window.title())),
      )
      .not.toContain("CharaMate");

    await second.character
      .getByRole("button", { name: "Linnea 桌宠" })
      .dblclick();
    const reopenedMain = await findWindow(application, "CharaMate");
    await expect(
      reopenedMain.getByRole("heading", { name: "新对话" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        application!.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter(
              (window) => window.getTitle() === "CharaMate",
            ).length,
        ),
      )
      .toBe(1);
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});
