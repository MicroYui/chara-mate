import { describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";

import { MainWindowController } from "./mainWindowController";

class FakeMainWindow {
  readonly focus = vi.fn();
  readonly restore = vi.fn(() => {
    this.minimized = false;
  });
  readonly show = vi.fn();
  readonly webContents: {
    readonly id: number;
  };
  private destroyed = false;
  private minimized = false;
  private readonly closedListeners: Array<() => void> = [];

  constructor(id: number) {
    this.webContents = { id };
  }

  close(): void {
    this.destroyed = true;
    for (const listener of this.closedListeners) listener();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  minimize(): void {
    this.minimized = true;
  }

  on(event: string, listener: () => void): this {
    if (event === "closed") this.closedListeners.push(listener);
    return this;
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
});
