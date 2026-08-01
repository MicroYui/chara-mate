import { describe, expect, it } from "vitest";

import { chatsFixture } from "../../src/renderer/features/chats/fixtures";
import { ChatSchema, MessageSchema } from "../../src/shared/schemas/chat";
import { ProviderSnapshotSchema } from "../../src/shared/schemas/provider";
import {
  ApprovalSchema,
  ArtifactReferenceSchema,
  RunItemSchema,
  RunSchema,
} from "../../src/shared/schemas/run";
import { parseSchema } from "../../src/shared/schemas/validation";

describe("Chats UI fixture contract", () => {
  it("validates every production-boundary record through the frozen schemas", () => {
    for (const model of chatsFixture.models) {
      expect(parseSchema(ProviderSnapshotSchema, model.provider)).toEqual(
        model.provider,
      );
    }

    for (const chat of chatsFixture.chats) {
      expect(parseSchema(ChatSchema, chat.record)).toEqual(chat.record);
      for (const message of chat.messages) {
        expect(parseSchema(MessageSchema, message.record)).toEqual(
          message.record,
        );
        for (const attachment of message.attachments) {
          expect(parseSchema(ArtifactReferenceSchema, attachment)).toEqual(
            attachment,
          );
        }
      }
      for (const run of chat.runs) {
        expect(parseSchema(RunSchema, run.record)).toEqual(run.record);
        for (const item of run.items) {
          expect(parseSchema(RunItemSchema, item)).toEqual(item);
        }
        for (const approval of run.approvals) {
          expect(parseSchema(ApprovalSchema, approval)).toEqual(approval);
        }
      }
    }
  });

  it("keeps Chat, Message, Run, Item and Approval references coherent", () => {
    for (const chat of chatsFixture.chats) {
      const runIds = new Set<string>(chat.runs.map((run) => run.record.id));
      for (const message of chat.messages) {
        expect(message.record.chatId).toBe(chat.record.id);
        if (message.record.runId) {
          expect(runIds.has(message.record.runId)).toBe(true);
        }
      }

      for (const run of chat.runs) {
        expect(run.record.chatId).toBe(chat.record.id);
        expect(run.record.latestSequence).toBe(run.items.length);
        for (const [index, item] of run.items.entries()) {
          expect(item.runId).toBe(run.record.id);
          expect(item.sequence).toBe(index + 1);
        }
        for (const approval of run.approvals) {
          expect(approval.runId).toBe(run.record.id);
          expect(run.items.some((item) => item.id === approval.itemId)).toBe(
            true,
          );
        }
      }
    }
  });
});
