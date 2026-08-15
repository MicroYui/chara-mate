import type { BrowserWindow, WebContents } from "electron";

import type { PetMainTarget } from "../../shared/contracts/pet";
import { shouldRecoverRenderer } from "./rendererRecovery";

export type MainWindowTarget = PetMainTarget;

interface MainWindowControllerOptions {
  readonly onVisibilityChanged?: (visible: boolean) => void;
  readonly reveal?: boolean;
  readonly shouldKeepAliveOnClose?: () => boolean;
}

interface RendererReadyState {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly webContentsId: number;
}

export class MainWindowController {
  private window: BrowserWindow | null = null;
  private creation: Promise<BrowserWindow> | undefined;
  private readyState: RendererReadyState | undefined;
  private readonly earlyReadySenders = new Set<number>();
  private rendererRecoveryAttempted = false;

  constructor(
    private readonly createWindow: () => Promise<BrowserWindow>,
    private readonly activateApplication: () => void,
    private readonly navigate: (
      window: BrowserWindow,
      target: MainWindowTarget,
    ) => void,
    private readonly options: MainWindowControllerOptions = {},
  ) {}

  getWindow(): BrowserWindow | null {
    if (this.window?.isDestroyed()) this.window = null;
    return this.window;
  }

  destroy(): void {
    const window = this.getWindow();
    if (!window) return;
    const webContentsId = window.webContents.id;

    // `close` runs the window-placement persistence listener while the
    // application database is still available. Force-destroy only when a
    // renderer prevents the normal close so no window can outlive storage.
    window.close();
    if (!window.isDestroyed()) window.destroy();

    if (this.window === window) this.window = null;
    const readyState = this.readyState;
    if (readyState?.webContentsId === webContentsId) {
      this.readyState = undefined;
      readyState.resolve();
    }
    this.earlyReadySenders.delete(webContentsId);
  }

  markRendererReady(sender: Pick<WebContents, "id">): void {
    const readyState = this.readyState;
    if (readyState?.webContentsId === sender.id) {
      readyState.resolve();
      return;
    }
    this.earlyReadySenders.add(sender.id);
  }

  async open(target?: MainWindowTarget): Promise<BrowserWindow> {
    for (;;) {
      const window = await this.ensureWindow();
      if (window.isDestroyed()) continue;
      this.reveal(window);
      await this.waitUntilRendererReady(window);
      if (window.isDestroyed()) continue;
      if (target) this.navigate(window, target);
      this.reveal(window);
      return window;
    }
  }

  private reveal(window: BrowserWindow): void {
    if (this.options.reveal === false) return;
    if (window.isMinimized()) window.restore();
    window.show();
    this.options.onVisibilityChanged?.(true);
    this.activateApplication();
    window.focus();
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    const existing = this.getWindow();
    if (existing) return existing;
    if (!this.creation) this.creation = this.createAndTrackWindow();
    const creation = this.creation;
    try {
      return await creation;
    } finally {
      if (this.creation === creation) this.creation = undefined;
    }
  }

  private async createAndTrackWindow(): Promise<BrowserWindow> {
    const window = await this.createWindow();
    if (window.isDestroyed()) {
      throw new Error("Main window was destroyed while it was being created.");
    }
    this.window = window;
    const webContentsId = window.webContents.id;
    let resolveReady = (): void => undefined;
    const promise = this.earlyReadySenders.delete(webContentsId)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
    const readyState: RendererReadyState = {
      promise,
      resolve: resolveReady,
      webContentsId,
    };
    this.readyState = readyState;

    const reportVisibility = (): void => {
      this.options.onVisibilityChanged?.(
        window.isVisible() && !window.isMinimized(),
      );
    };
    this.options.onVisibilityChanged?.(
      window.isVisible() && !window.isMinimized(),
    );
    window.on("show", reportVisibility);
    window.on("hide", reportVisibility);
    window.on("minimize", reportVisibility);
    window.on("restore", reportVisibility);

    window.on("close", (event) => {
      if (!this.options.shouldKeepAliveOnClose?.()) return;
      event.preventDefault();
      window.hide();
      this.options.onVisibilityChanged?.(false);
    });
    window.on("closed", () => {
      this.options.onVisibilityChanged?.(false);
      if (this.window === window) this.window = null;
      if (this.readyState === readyState) this.readyState = undefined;
      this.earlyReadySenders.delete(webContentsId);
      readyState.resolve();
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      if (
        this.rendererRecoveryAttempted ||
        !shouldRecoverRenderer(details.reason) ||
        window.isDestroyed()
      ) {
        return;
      }
      this.rendererRecoveryAttempted = true;
      window.destroy();
      void this.open().catch(() => undefined);
    });
    return window;
  }

  private waitUntilRendererReady(window: BrowserWindow): Promise<void> {
    const readyState = this.readyState;
    return readyState?.webContentsId === window.webContents.id
      ? readyState.promise
      : Promise.resolve();
  }
}
