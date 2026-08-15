import { describe, expect, it, vi } from "vitest";

import type { BrowserWindow, RenderProcessGoneDetails } from "electron";

import { MainWindowController } from "./mainWindowController";

type RendererGoneListener = (
  event: unknown,
  details: RenderProcessGoneDetails,
) => void;

class FakeMainWindow {
  readonly hide = vi.fn(() => {
    this.visible = false;
    this.emit("hide");
  });
  readonly focus = vi.fn();
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    this.visible = false;
    for (const listener of this.closedListeners) listener();
  });
  readonly restore = vi.fn(() => {
    this.minimized = false;
    this.emit("restore");
  });
  readonly show = vi.fn(() => {
    this.visible = true;
    this.emit("show");
  });
  private readonly webContentsValue: {
    readonly id: number;
    on(event: string, listener: RendererGoneListener): void;
  };
  private destroyed = false;
  private minimized = false;
  private visible = false;
  private readonly closeListeners: Array<
    (event: { preventDefault(): void }) => void
  > = [];
  private readonly closedListeners: Array<() => void> = [];
  private readonly windowEventListeners = new Map<string, Array<() => void>>();
  private readonly rendererGoneListeners: RendererGoneListener[] = [];

  constructor(id: number) {
    this.webContentsValue = {
      id,
      on: (event, listener) => {
        if (event === "render-process-gone") {
          this.rendererGoneListeners.push(listener);
        }
      },
    };
  }

  get webContents(): typeof this.webContentsValue {
    if (this.destroyed) throw new Error("Object has been destroyed");
    return this.webContentsValue;
  }

  close(): void {
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const listener of this.closeListeners) listener(event);
    if (prevented) return;
    this.destroyed = true;
    this.visible = false;
    for (const listener of this.closedListeners) listener();
  }

  crash(reason: RenderProcessGoneDetails["reason"] = "crashed"): void {
    for (const listener of this.rendererGoneListeners) {
      listener({}, { exitCode: 1, reason });
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isVisible(): boolean {
    return this.visible;
  }

  minimize(): void {
    this.minimized = true;
    this.emit("minimize");
  }

  on(
    event: string,
    listener: (event?: { preventDefault(): void }) => void,
  ): this {
    if (event === "close") {
      this.closeListeners.push((closeEvent) => listener(closeEvent));
    }
    if (event === "closed") this.closedListeners.push(() => listener());
    if (!["close", "closed"].includes(event)) {
      const listeners = this.windowEventListeners.get(event) ?? [];
      listeners.push(() => listener());
      this.windowEventListeners.set(event, listeners);
    }
    return this;
  }

  private emit(event: string): void {
    for (const listener of this.windowEventListeners.get(event) ?? []) {
      listener();
    }
  }
}

function asBrowserWindow(window: FakeMainWindow): BrowserWindow {
  return window as unknown as BrowserWindow;
}

describe("MainWindowController", () => {
  it("single-flights recreation and waits for Renderer readiness before navigation", async () => {
    const window = new FakeMainWindow(41);
    let finishCreation: ((window: BrowserWindow) => void) | undefined;
    const createWindow = vi.fn(
      () =>
        new Promise<BrowserWindow>((resolve) => {
          finishCreation = resolve;
        }),
    );
    const activateApplication = vi.fn();
    const navigate = vi.fn();
    const controller = new MainWindowController(
      createWindow,
      activateApplication,
      navigate,
    );

    const openChat = controller.open("chat");
    const openCharacter = controller.open("character");
    expect(createWindow).toHaveBeenCalledOnce();
    finishCreation?.(asBrowserWindow(window));
    await vi.waitFor(() => expect(window.show).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();

    controller.markRendererReady({ id: 41 });
    await Promise.all([openChat, openCharacter]);

    expect(createWindow).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenNthCalledWith(
      1,
      asBrowserWindow(window),
      "chat",
    );
    expect(navigate).toHaveBeenNthCalledWith(
      2,
      asBrowserWindow(window),
      "character",
    );
    expect(activateApplication).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
  });

  it("restores an existing window and recreates it after close", async () => {
    const first = new FakeMainWindow(51);
    const second = new FakeMainWindow(52);
    const createWindow = vi
      .fn<() => Promise<BrowserWindow>>()
      .mockResolvedValueOnce(asBrowserWindow(first))
      .mockResolvedValueOnce(asBrowserWindow(second));
    const controller = new MainWindowController(createWindow, vi.fn(), vi.fn());

    controller.markRendererReady({ id: 51 });
    await controller.open();
    first.minimize();
    await controller.open();
    expect(first.restore).toHaveBeenCalledOnce();

    first.close();
    controller.markRendererReady({ id: 52 });
    await controller.open();

    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(controller.getWindow()).toBe(asBrowserWindow(second));
  });

  it("recreates the main window once after a recoverable Renderer crash", async () => {
    const first = new FakeMainWindow(53);
    const second = new FakeMainWindow(54);
    const createWindow = vi
      .fn<() => Promise<BrowserWindow>>()
      .mockResolvedValueOnce(asBrowserWindow(first))
      .mockResolvedValueOnce(asBrowserWindow(second));
    const controller = new MainWindowController(createWindow, vi.fn(), vi.fn());

    controller.markRendererReady({ id: 53 });
    await controller.open();
    first.crash();
    await vi.waitFor(() => expect(createWindow).toHaveBeenCalledTimes(2));
    controller.markRendererReady({ id: 54 });
    await vi.waitFor(() =>
      expect(controller.getWindow()).toBe(asBrowserWindow(second)),
    );

    second.crash();
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it("closes the tracked window before releasing it during shutdown", async () => {
    const window = new FakeMainWindow(61);
    const controller = new MainWindowController(
      vi.fn().mockResolvedValue(asBrowserWindow(window)),
      vi.fn(),
      vi.fn(),
    );

    controller.markRendererReady({ id: 61 });
    await controller.open();
    controller.destroy();

    expect(window.isDestroyed()).toBe(true);
    expect(window.destroy).not.toHaveBeenCalled();
    expect(controller.getWindow()).toBeNull();
  });

  it("hides instead of destroying the Voice connection owner while Voice is active", async () => {
    const window = new FakeMainWindow(62);
    let keepAlive = true;
    const controller = new MainWindowController(
      vi.fn().mockResolvedValue(asBrowserWindow(window)),
      vi.fn(),
      vi.fn(),
      { shouldKeepAliveOnClose: () => keepAlive },
    );

    controller.markRendererReady({ id: 62 });
    await controller.open();
    window.close();

    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.isDestroyed()).toBe(false);
    expect(controller.getWindow()).toBe(asBrowserWindow(window));

    keepAlive = false;
    window.close();
    expect(window.isDestroyed()).toBe(true);
    expect(controller.getWindow()).toBeNull();
  });

  it("reports native visibility changes to window-owned companions", async () => {
    const window = new FakeMainWindow(63);
    const onVisibilityChanged = vi.fn();
    const controller = new MainWindowController(
      vi.fn().mockResolvedValue(asBrowserWindow(window)),
      vi.fn(),
      vi.fn(),
      { onVisibilityChanged },
    );

    controller.markRendererReady({ id: 63 });
    await controller.open();
    expect(onVisibilityChanged).toHaveBeenLastCalledWith(true);

    window.minimize();
    expect(onVisibilityChanged).toHaveBeenLastCalledWith(false);
    window.restore();
    expect(onVisibilityChanged).toHaveBeenLastCalledWith(true);
    window.hide();
    expect(onVisibilityChanged).toHaveBeenLastCalledWith(false);
    window.show();
    expect(onVisibilityChanged).toHaveBeenLastCalledWith(true);
    window.close();
    expect(onVisibilityChanged).toHaveBeenLastCalledWith(false);
  });

  it("keeps background E2E windows loaded without revealing or focusing them", async () => {
    const window = new FakeMainWindow(71);
    const activateApplication = vi.fn();
    const controller = new MainWindowController(
      vi.fn().mockResolvedValue(asBrowserWindow(window)),
      activateApplication,
      vi.fn(),
      { reveal: false },
    );

    controller.markRendererReady({ id: 71 });
    await controller.open();

    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
    expect(activateApplication).not.toHaveBeenCalled();
  });
});
