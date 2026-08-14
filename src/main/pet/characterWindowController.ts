import path from "node:path";

import { app, BrowserWindow, Menu, screen } from "electron";

import type {
  PetDragPoint,
  PetDragResult,
  PetMainTarget,
  ProactiveConversationBubble,
} from "../../shared/contracts/pet";
import { PET_CHANNELS } from "../../shared/contracts/pet";
import { ProactiveConversationBubbleSchema } from "../../shared/schemas/pet";
import { parseSchema } from "../../shared/schemas/validation";
import {
  captureCharacterPlacement,
  restoreCharacterBounds,
} from "./characterPlacement";
import { calculateDragMovement } from "./dragMovement";
import type { PetService } from "./petService";
import { placeProactiveBubble } from "./proactiveBubblePlacement";

interface DragState {
  lastPoint: PetDragPoint;
  readonly originBounds: Electron.Rectangle;
  readonly originPoint: PetDragPoint;
  moved: boolean;
}

export class CharacterWindowController {
  private window: BrowserWindow | null = null;
  private conversationWindow: BrowserWindow | null = null;
  private conversationWindowPromise: Promise<BrowserWindow | null> | null =
    null;
  private drag: DragState | undefined;
  private mainWindowVisible = false;
  private territoryActive = false;
  private proactiveBubble: ProactiveConversationBubble | null = null;

  constructor(
    private readonly service: PetService,
    private readonly openMainWindow: (target?: PetMainTarget) => void,
    private readonly revealOnReady = true,
  ) {}

  getWindow(): BrowserWindow | null {
    return this.window;
  }

  private reconcileVisibility(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !this.revealOnReady) return;
    if (this.mainWindowVisible && this.territoryActive) {
      if (window.isVisible()) window.hide();
      return;
    }
    if (!window.isVisible()) window.showInactive();
  }

  setMainWindowVisible(visible: boolean): void {
    this.mainWindowVisible = visible;
    this.reconcileVisibility();
  }

  setTerritoryActive(active: boolean): void {
    this.territoryActive = active;
    this.reconcileVisibility();
  }

  getConversationWindow(): BrowserWindow | null {
    return this.conversationWindow;
  }

  ownsSender(sender: Electron.WebContents): boolean {
    return [this.window, this.conversationWindow].some(
      (window) =>
        window !== null &&
        !window.isDestroyed() &&
        window.webContents.id === sender.id,
    );
  }

  showProactiveBubble(bubble: ProactiveConversationBubble): void {
    this.proactiveBubble = parseSchema(
      ProactiveConversationBubbleSchema,
      bubble,
    );
    this.syncConversationWindow();
  }

  clearProactiveBubble(bubbleId?: string): boolean {
    if (
      bubbleId &&
      this.proactiveBubble &&
      this.proactiveBubble.id !== bubbleId
    ) {
      return false;
    }
    if (!this.proactiveBubble) return false;
    this.proactiveBubble = null;
    const window = this.conversationWindow;
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(PET_CHANNELS.proactiveBubbleChanged, null);
    }
    this.destroyConversationWindow();
    return true;
  }

  flushProactiveBubble(): void {
    const window = this.conversationWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      if (this.proactiveBubble) this.syncConversationWindow();
      return;
    }
    this.positionConversationWindow();
    window.webContents.send(
      PET_CHANNELS.proactiveBubbleChanged,
      this.proactiveBubble,
    );
  }

  private syncConversationWindow(): void {
    if (!this.proactiveBubble || !this.window || this.window.isDestroyed()) {
      return;
    }
    if (this.conversationWindow && !this.conversationWindow.isDestroyed()) {
      this.flushProactiveBubble();
      if (this.revealOnReady) this.conversationWindow.showInactive();
      return;
    }
    void this.ensureConversationWindow().catch(() => undefined);
  }

  private destroyConversationWindow(): void {
    const window = this.conversationWindow;
    this.conversationWindow = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  assertCharacterSender(sender: Electron.WebContents): void {
    if (!this.ownsSender(sender)) {
      throw new Error("Character window IPC sender rejected.");
    }
  }

  private assertPetSender(sender: Electron.WebContents): void {
    if (
      !this.window ||
      this.window.isDestroyed() ||
      this.window.webContents.id !== sender.id
    ) {
      throw new Error("Pet window IPC sender rejected.");
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
    this.positionConversationWindow();
    this.persistPlacement();
  }

  private readonly handleDisplayChange = (): void => {
    this.applyStoredBounds();
  };

  private loadRenderer(
    window: BrowserWindow,
    surface: "conversation" | "pet",
  ): Promise<void> {
    if (CHARACTER_WINDOW_VITE_DEV_SERVER_URL) {
      const url = new URL(CHARACTER_WINDOW_VITE_DEV_SERVER_URL);
      url.searchParams.set("surface", surface);
      return window.loadURL(url.toString());
    }
    return window.loadFile(
      path.join(
        import.meta.dirname,
        `../renderer/${CHARACTER_WINDOW_VITE_NAME}/index.html`,
      ),
      { query: { surface } },
    );
  }

  private positionConversationWindow(): void {
    const petWindow = this.window;
    const conversationWindow = this.conversationWindow;
    if (
      !petWindow ||
      petWindow.isDestroyed() ||
      !conversationWindow ||
      conversationWindow.isDestroyed()
    ) {
      return;
    }
    const petBounds = petWindow.getBounds();
    const display = screen.getDisplayMatching(petBounds);
    const placement = placeProactiveBubble(petBounds, display.workArea);
    conversationWindow.setBounds(placement.bounds);
  }

  private async ensureConversationWindow(): Promise<BrowserWindow | null> {
    if (this.conversationWindow && !this.conversationWindow.isDestroyed()) {
      return this.conversationWindow;
    }
    if (this.conversationWindowPromise) return this.conversationWindowPromise;
    const petWindow = this.window;
    if (!petWindow || petWindow.isDestroyed() || !this.proactiveBubble) {
      return null;
    }

    const placement = placeProactiveBubble(
      petWindow.getBounds(),
      screen.getDisplayMatching(petWindow.getBounds()).workArea,
    );
    const promise = (async (): Promise<BrowserWindow | null> => {
      const window = new BrowserWindow({
        ...placement.bounds,
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
        title: "CharaMate Conversation",
        transparent: true,
        ...(process.platform === "darwin" ? { type: "panel" } : {}),
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          preload: path.join(import.meta.dirname, "character-preload.mjs"),
          sandbox: false,
        },
      });
      this.conversationWindow = window;
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.on("page-title-updated", (event) => event.preventDefault());
      window.on("closed", () => {
        if (this.conversationWindow === window) {
          this.conversationWindow = null;
        }
      });
      await this.loadRenderer(window, "conversation");
      if (
        this.conversationWindow !== window ||
        window.isDestroyed() ||
        !this.proactiveBubble
      ) {
        if (!window.isDestroyed()) window.destroy();
        return null;
      }
      this.positionConversationWindow();
      this.flushProactiveBubble();
      if (this.revealOnReady) window.showInactive();
      return window;
    })();
    this.conversationWindowPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.conversationWindowPromise === promise) {
        this.conversationWindowPromise = null;
      }
    }
  }

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
      focusable: process.platform !== "darwin",
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
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(import.meta.dirname, "character-preload.mjs"),
        sandbox: false,
      },
    });
    this.window = window;
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.once("ready-to-show", () => {
      this.reconcileVisibility();
    });
    window.on("close", () => this.persistPlacement());
    window.on("closed", () => {
      if (this.window === window) this.window = null;
      this.drag = undefined;
      this.destroyConversationWindow();
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

    await this.loadRenderer(window, "pet");

    screen.on("display-added", this.handleDisplayChange);
    screen.on("display-removed", this.handleDisplayChange);
    screen.on("display-metrics-changed", this.handleDisplayChange);
    this.syncConversationWindow();
    return window;
  }

  startDrag(sender: Electron.WebContents, point: PetDragPoint): PetDragResult {
    this.assertPetSender(sender);
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
    this.assertPetSender(sender);
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
    this.positionConversationWindow();
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
    this.assertPetSender(sender);
    this.openMainWindow();
  }

  showContextMenu(sender: Electron.WebContents): void {
    this.assertPetSender(sender);
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
    const window = this.window;
    this.persistPlacement();
    this.window = null;
    this.destroyConversationWindow();
    this.drag = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
