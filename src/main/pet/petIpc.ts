import { dialog, ipcMain, type BrowserWindow } from "electron";

import {
  PET_CHANNELS,
  type ProactiveConversationBubbleFrequencyResponse,
  type ProactiveConversationBubbleReplyRequest,
  type ProactiveConversationBubbleReplyResponse,
} from "../../shared/contracts/pet";
import { ApprovalNavigationRequestSchema } from "../../shared/schemas/agent";
import {
  PetAnimationSpeedRequestSchema,
  PetCharacterSnapshotSchema,
  PetConversationNavigationSchema,
  PetDragPointSchema,
  PetDragResultSchema,
  PetEmptyRequestSchema,
  PetImportResponseSchema,
  PetLibraryResponseSchema,
  PetLibrarySnapshotSchema,
  PetScaleRequestSchema,
  PetSelectRequestSchema,
  PetTerritoryPresenceRequestSchema,
  ProactiveConversationBubbleDismissRequestSchema,
  ProactiveConversationBubbleFrequencyResponseSchema,
  ProactiveConversationBubbleReplyRequestSchema,
  ProactiveConversationBubbleReplyResponseSchema,
} from "../../shared/schemas/pet";
import { parseSchema } from "../../shared/schemas/validation";
import type { CharacterWindowController } from "./characterWindowController";
import { toPetAppError } from "./petError";
import type { PetService } from "./petService";

function senderMatches(
  sender: Electron.WebContents,
  window: BrowserWindow | null,
): boolean {
  return Boolean(
    window && !window.isDestroyed() && window.webContents.id === sender.id,
  );
}

export function registerPetIpc(
  service: PetService,
  character: CharacterWindowController,
  getMainWindow: () => BrowserWindow | null,
  onCharacterReady?: () => void,
  onFocusApproval?: (approvalId: string) => void,
  onFocusConversation?: (chatId: string) => void,
  onClearProactiveBubble?: (bubbleId?: string) => boolean,
  onReduceProactiveFrequency?: (
    bubbleId: string,
  ) => ProactiveConversationBubbleFrequencyResponse,
  onReplyProactiveBubble?: (
    request: ProactiveConversationBubbleReplyRequest,
  ) => Promise<ProactiveConversationBubbleReplyResponse>,
): () => void {
  const requireMain = (sender: Electron.WebContents): BrowserWindow => {
    const main = getMainWindow();
    if (!senderMatches(sender, main) || !main) {
      throw new Error("Main window IPC sender rejected.");
    }
    return main;
  };

  const broadcast = async (): Promise<void> => {
    const [library, snapshot] = await Promise.all([
      service.getLibrary(),
      service.getCharacterSnapshot(),
    ]);
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send(
        PET_CHANNELS.libraryChanged,
        parseSchema(PetLibrarySnapshotSchema, library),
      );
    }
    const characterSnapshot = parseSchema(PetCharacterSnapshotSchema, snapshot);
    for (const characterWindow of [
      character.getWindow(),
      character.getConversationWindow(),
    ]) {
      if (characterWindow && !characterWindow.isDestroyed()) {
        characterWindow.webContents.send(
          PET_CHANNELS.characterChanged,
          characterSnapshot,
        );
      }
    }
  };
  const unsubscribe = service.subscribe(() => {
    void broadcast().catch(() => undefined);
  });

  ipcMain.handle(PET_CHANNELS.getLibrary, async (event, input) => {
    try {
      requireMain(event.sender);
      parseSchema(PetEmptyRequestSchema, input);
      return parseSchema(PetLibraryResponseSchema, {
        ok: true,
        value: await service.getLibrary(),
      });
    } catch (error) {
      return parseSchema(PetLibraryResponseSchema, {
        error: toPetAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(PET_CHANNELS.importFromFolder, async (event, input) => {
    try {
      const main = requireMain(event.sender);
      parseSchema(PetEmptyRequestSchema, input);
      const selection = await dialog.showOpenDialog(main, {
        buttonLabel: "导入桌宠",
        message: "选择包含 pet.json 与 spritesheet 的 Codex 桌宠目录",
        properties: ["openDirectory"],
        title: "导入 Codex 桌宠",
      });
      const sourceDirectory = selection.filePaths[0];
      const imported =
        selection.canceled || !sourceDirectory
          ? null
          : await service.importFrom(sourceDirectory);
      return parseSchema(PetImportResponseSchema, {
        ok: true,
        value: imported,
      });
    } catch (error) {
      return parseSchema(PetImportResponseSchema, {
        error: toPetAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(PET_CHANNELS.select, async (event, input) => {
    try {
      requireMain(event.sender);
      const request = parseSchema(PetSelectRequestSchema, input);
      return parseSchema(PetLibraryResponseSchema, {
        ok: true,
        value: await service.select(request.petId),
      });
    } catch (error) {
      return parseSchema(PetLibraryResponseSchema, {
        error: toPetAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(PET_CHANNELS.setScale, async (event, input) => {
    try {
      requireMain(event.sender);
      const request = parseSchema(PetScaleRequestSchema, input);
      const library = await service.setScale(request.scale);
      character.applyStoredBounds();
      return parseSchema(PetLibraryResponseSchema, {
        ok: true,
        value: library,
      });
    } catch (error) {
      return parseSchema(PetLibraryResponseSchema, {
        error: toPetAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(PET_CHANNELS.setAnimationSpeed, async (event, input) => {
    try {
      requireMain(event.sender);
      const request = parseSchema(PetAnimationSpeedRequestSchema, input);
      return parseSchema(PetLibraryResponseSchema, {
        ok: true,
        value: await service.setAnimationSpeed(request.animationSpeed),
      });
    } catch (error) {
      return parseSchema(PetLibraryResponseSchema, {
        error: toPetAppError(error),
        ok: false,
      });
    }
  });

  ipcMain.handle(PET_CHANNELS.characterGetSnapshot, async (event, input) => {
    character.assertCharacterSender(event.sender);
    parseSchema(PetEmptyRequestSchema, input);
    return parseSchema(
      PetCharacterSnapshotSchema,
      await service.getCharacterSnapshot(),
    );
  });
  ipcMain.handle(PET_CHANNELS.dragStart, (event, input) =>
    parseSchema(
      PetDragResultSchema,
      character.startDrag(event.sender, parseSchema(PetDragPointSchema, input)),
    ),
  );
  ipcMain.handle(PET_CHANNELS.dragEnd, (event, input) =>
    parseSchema(
      PetDragResultSchema,
      character.endDrag(event.sender, parseSchema(PetDragPointSchema, input)),
    ),
  );
  ipcMain.handle(PET_CHANNELS.replyProactiveBubble, async (event, input) => {
    character.assertCharacterSender(event.sender);
    const request = parseSchema(
      ProactiveConversationBubbleReplyRequestSchema,
      input,
    );
    if (!onReplyProactiveBubble) {
      throw new Error("Proactive conversation replies are unavailable");
    }
    return parseSchema(
      ProactiveConversationBubbleReplyResponseSchema,
      await onReplyProactiveBubble(request),
    );
  });
  ipcMain.handle(PET_CHANNELS.reduceProactiveFrequency, (event, input) => {
    try {
      character.assertCharacterSender(event.sender);
      const request = parseSchema(
        ProactiveConversationBubbleDismissRequestSchema,
        input,
      );
      if (!onReduceProactiveFrequency) {
        throw new Error("Proactive conversation feedback is unavailable");
      }
      return parseSchema(
        ProactiveConversationBubbleFrequencyResponseSchema,
        onReduceProactiveFrequency(request.bubbleId),
      );
    } catch (error) {
      return parseSchema(ProactiveConversationBubbleFrequencyResponseSchema, {
        error: toPetAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.on(PET_CHANNELS.dragMove, (event, input) => {
    try {
      character.moveDrag(event.sender, parseSchema(PetDragPointSchema, input));
    } catch {
      // Pointer capture can transiently emit non-finite screen coordinates
      // while crossing native windows. Ignore that sample and keep dragging.
    }
  });
  ipcMain.on(PET_CHANNELS.focusMain, (event, input) => {
    parseSchema(PetEmptyRequestSchema, input);
    character.focusMain(event.sender);
  });
  ipcMain.on(PET_CHANNELS.focusApproval, (event, input) => {
    character.assertCharacterSender(event.sender);
    const request = parseSchema(ApprovalNavigationRequestSchema, input);
    onFocusApproval?.(request.approvalId);
  });
  ipcMain.on(PET_CHANNELS.focusConversation, (event, input) => {
    character.assertCharacterSender(event.sender);
    const request = parseSchema(PetConversationNavigationSchema, input);
    if (request.bubbleId) {
      const cleared = onClearProactiveBubble
        ? onClearProactiveBubble(request.bubbleId)
        : character.clearProactiveBubble(request.bubbleId);
      if (!cleared) character.flushProactiveBubble();
    }
    onFocusConversation?.(request.chatId);
  });
  ipcMain.on(PET_CHANNELS.dismissProactiveBubble, (event, input) => {
    character.assertCharacterSender(event.sender);
    const request = parseSchema(
      ProactiveConversationBubbleDismissRequestSchema,
      input,
    );
    const cleared = onClearProactiveBubble
      ? onClearProactiveBubble(request.bubbleId)
      : character.clearProactiveBubble(request.bubbleId);
    if (!cleared) character.flushProactiveBubble();
  });
  ipcMain.on(PET_CHANNELS.showContextMenu, (event, input) => {
    parseSchema(PetEmptyRequestSchema, input);
    character.showContextMenu(event.sender);
  });
  ipcMain.on(PET_CHANNELS.characterReady, (event, input) => {
    character.assertCharacterSender(event.sender);
    parseSchema(PetEmptyRequestSchema, input);
    character.flushProactiveBubble();
    onCharacterReady?.();
  });
  ipcMain.on(PET_CHANNELS.setTerritoryActive, (event, input) => {
    requireMain(event.sender);
    const request = parseSchema(PetTerritoryPresenceRequestSchema, input);
    character.setTerritoryActive(request.active);
  });

  return () => {
    unsubscribe();
    for (const channel of [
      PET_CHANNELS.getLibrary,
      PET_CHANNELS.importFromFolder,
      PET_CHANNELS.select,
      PET_CHANNELS.setAnimationSpeed,
      PET_CHANNELS.setScale,
      PET_CHANNELS.characterGetSnapshot,
      PET_CHANNELS.dragStart,
      PET_CHANNELS.dragEnd,
      PET_CHANNELS.reduceProactiveFrequency,
      PET_CHANNELS.replyProactiveBubble,
    ]) {
      ipcMain.removeHandler(channel);
    }
    for (const channel of [
      PET_CHANNELS.dragMove,
      PET_CHANNELS.focusMain,
      PET_CHANNELS.focusApproval,
      PET_CHANNELS.focusConversation,
      PET_CHANNELS.dismissProactiveBubble,
      PET_CHANNELS.showContextMenu,
      PET_CHANNELS.characterReady,
      PET_CHANNELS.setTerritoryActive,
    ]) {
      ipcMain.removeAllListeners(channel);
    }
  };
}
