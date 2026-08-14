import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProactiveConversationBubble } from "../../shared/contracts/pet";
import { PET_CHANNELS } from "../../shared/contracts/pet";
import { CharacterWindowController } from "./characterWindowController";
import type { PetService } from "./petService";

const electron = vi.hoisted(() => ({
  getDisplayMatching: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: vi.fn(),
  Menu: {},
  screen: {
    getDisplayMatching: electron.getDisplayMatching,
  },
}));

const bubble: ProactiveConversationBubble = {
  chatId: "11111111-1111-4111-8111-111111111111",
  content: "可以直接在这里继续聊。",
  createdAt: "2026-08-14T03:00:00.000Z",
  id: "22222222-2222-4222-8222-222222222222",
  kind: "continuation",
  replyState: "ready",
};

beforeEach(() => {
  vi.clearAllMocks();
  electron.getDisplayMatching.mockReturnValue({
    workArea: { height: 900, width: 1440, x: 0, y: 25 },
  });
});

describe("CharacterWindowController proactive conversation window", () => {
  it("keeps the pet untouched and projects the bubble into its own window", () => {
    const petWindow = {
      getBounds: () => ({ height: 135, width: 125, x: 1200, y: 750 }),
      isDestroyed: () => false,
      setFocusable: vi.fn(),
      webContents: { id: 1 },
    };
    const destroy = vi.fn();
    const send = vi.fn();
    const setBounds = vi.fn();
    const showInactive = vi.fn();
    const conversationWindow = {
      destroy,
      isDestroyed: () => false,
      setBounds,
      showInactive,
      webContents: {
        id: 2,
        isDestroyed: () => false,
        send,
      },
    };
    const controller = new CharacterWindowController({} as PetService, vi.fn());
    Reflect.set(controller, "window", petWindow);
    Reflect.set(controller, "conversationWindow", conversationWindow);

    controller.showProactiveBubble(bubble);

    expect(petWindow.setFocusable).not.toHaveBeenCalled();
    expect(setBounds).toHaveBeenCalledWith({
      height: 168,
      width: 360,
      x: 1072,
      y: 574,
    });
    expect(send).toHaveBeenCalledWith(
      PET_CHANNELS.proactiveBubbleChanged,
      bubble,
    );
    expect(showInactive).toHaveBeenCalledOnce();
    expect(controller.ownsSender({ id: 2 } as Electron.WebContents)).toBe(true);

    expect(controller.clearProactiveBubble(bubble.id)).toBe(true);
    expect(send).toHaveBeenCalledWith(
      PET_CHANNELS.proactiveBubbleChanged,
      null,
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
});
