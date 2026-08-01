import type {
  ChatDataSnapshotRequest,
  ChatDataSnapshotResponse,
} from "../../shared/contracts/chat";
import {
  ChatDataSnapshotRequestSchema,
  ChatDataSnapshotResponseSchema,
} from "../../shared/schemas/chat";
import { parseSchema } from "../../shared/schemas/validation";
import type { RunRepository } from "../agent/runRepository";
import type { ChatRepository } from "./chatRepository";

export class ChatDataService {
  constructor(
    private readonly chats: ChatRepository,
    private readonly runs: RunRepository,
  ) {}

  getSnapshot(input: ChatDataSnapshotRequest): ChatDataSnapshotResponse {
    const request = parseSchema(ChatDataSnapshotRequestSchema, input);
    const chatSnapshot = this.chats.getSnapshot(request.chatId);
    if (!chatSnapshot) {
      return null;
    }
    const runSnapshot = this.runs.getSnapshot(request.chatId);

    return parseSchema(ChatDataSnapshotResponseSchema, {
      ...chatSnapshot,
      ...runSnapshot,
    });
  }
}
