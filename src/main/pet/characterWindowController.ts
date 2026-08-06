import path from "node:path";

import { app, BrowserWindow, Menu, screen } from "electron";

import type {
  PetDragPoint,
  PetDragResult,
  PetMainTarget,
} from "../../shared/contracts/pet";
import {
  captureCharacterPlacement,
  restoreCharacterBounds,
} from "./characterPlacement";
import { calculateDragMovement } from "./dragMovement";
import type { PetService } from "./petService";

interface DragState {
  lastPoint: PetDragPoint;
  readonly originBounds: Electron.Rectangle;
  readonly originPoint: PetDragPoint;
  moved: boolean;
}

export class CharacterWindowController {
  private window: BrowserWindow | null = null;
  private drag: DragState | undefined;

  constructor(
    private readonly service: PetService,
    private readonly openMainWindow: (target?: PetMainTarget) => void,
  ) {}

  getWindow(): BrowserWindow | null {
    return this.window;
  }

  private senderIsCharacter(sender: Electron.WebContents): boolean {
    return this.window?.webContents.id === sender.id;
  }

  assertCharacterSender(sender: Electron.WebContents): void {
    if (!this.senderIsCharacter(sender)) {
      throw new Error("Character window IPC sender rejected.");
    }
  }

  private persistPlacement(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const bounds = this.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    this.service.updatePlacement(captureCharacterPlacement(bounds, display));
  }

  applyStoredBounds(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const state = this.service.getStoredState();
    const bounds = restoreCharacterBounds(
      state,
      screen.getAllDisplays(),
      screen.getPrimaryDisplay().id,
    );
    this.window.setBounds(bounds);
    this.persistPlacement();
  }

  private readonly handleDisplayChange = (): void => {
    this.applyStoredBounds();
  };

  async create(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const state = this.service.getStoredState();
    const bounds = restoreCharacterBounds(
      state,
      screen.getAllDisplays(),
      screen.getPrimaryDisplay().id,
    );
    const window = new BrowserWindow({
      ...bounds,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      focusable: true,
      frame: false,
      fullscreenable: false,
      hasShadow: false,
      maximizable: false,
      minimizable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      title: "CharaMate Character",
      transparent: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(import.meta.dirname, "character-preload.mjs"),
        sandbox: false,
      },
    });
    this.window = window;
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.once("ready-to-show", () => window.showInactive());
    window.on("close", () => this.persistPlacement());
    window.on("closed", () => {
      if (this.window === window) this.window = null;
      this.drag = undefined;
    });

    if (process.env["CHARAMATE_SMOKE_TEST"] === "1") {
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        console.error(
          `CHARAMATE_CHARACTER_PRELOAD_ERROR ${JSON.stringify({
            message: error.message,
            preloadPath,
          })}`,
        );
      });
      window.webContents.on("did-fail-load", (_event, code, description) => {
        console.error(
          `CHARAMATE_CHARACTER_LOAD_ERROR ${JSON.stringify({ code, description })}`,
        );
      });
      window.webContents.on("console-message", (details) => {
        console.error(
          `CHARAMATE_CHARACTER_CONSOLE ${JSON.stringify({
            level: details.level,
            message: details.message,
          })}`,
        );
      });
    }

    if (CHARACTER_WINDOW_VITE_DEV_SERVER_URL) {
      await window.loadURL(CHARACTER_WINDOW_VITE_DEV_SERVER_URL);
    } else {
      await window.loadFile(
        path.join(
          import.meta.dirname,
          `../renderer/${CHARACTER_WINDOW_VITE_NAME}/index.html`,
        ),
      );
    }

    screen.on("display-added", this.handleDisplayChange);
    screen.on("display-removed", this.handleDisplayChange);
    screen.on("display-metrics-changed", this.handleDisplayChange);
    return window;
  }

  startDrag(sender: Electron.WebContents, point: PetDragPoint): PetDragResult {
    this.assertCharacterSender(sender);
    const window = this.window;
    if (
      !window ||
      window.isDestroyed() ||
      !Number.isFinite(point.screenX) ||
      !Number.isFinite(point.screenY)
    ) {
      return { moved: false };
    }
    this.drag = {
      lastPoint: point,
      moved: false,
      originBounds: window.getBounds(),
      originPoint: point,
    };
    return { moved: false };
  }

  moveDrag(sender: Electron.WebContents, point: PetDragPoint): void {
    this.assertCharacterSender(sender);
    const window = this.window;
    const drag = this.drag;
    if (!window || window.isDestroyed() || !drag) return;
    const movement = calculateDragMovement(
      drag.originBounds,
      drag.originPoint,
      drag.lastPoint,
      point,
    );
    if (!movement) return;
    drag.lastPoint = point;
    if (!drag.moved && Math.hypot(movement.deltaX, movement.deltaY) >= 3) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    window.setPosition(movement.nextX, movement.nextY);
    if (Math.abs(movement.stepDeltaX) >= 1) {
      this.service.setFacing(movement.stepDeltaX < 0 ? "left" : "right");
    }
  }

  endDrag(sender: Electron.WebContents, point: PetDragPoint): PetDragResult {
    this.moveDrag(sender, point);
    const moved = this.drag?.moved ?? false;
    this.drag = undefined;
    if (moved) this.persistPlacement();
    return { moved };
  }

  focusMain(sender: Electron.WebContents): void {
    this.assertCharacterSender(sender);
    this.openMainWindow();
  }

  showContextMenu(sender: Electron.WebContents): void {
    this.assertCharacterSender(sender);
    const menu = Menu.buildFromTemplate([
      { click: () => this.openMainWindow("chat"), label: "打开 Chat" },
      {
        click: () => this.openMainWindow("character"),
        label: "Character 设置",
      },
      { type: "separator" },
      { click: () => app.quit(), label: "退出 CharaMate" },
    ]);
    if (this.window) menu.popup({ window: this.window });
    else menu.popup();
  }

  destroy(): void {
    screen.off("display-added", this.handleDisplayChange);
    screen.off("display-removed", this.handleDisplayChange);
    screen.off("display-metrics-changed", this.handleDisplayChange);
    this.persistPlacement();
  }
}
