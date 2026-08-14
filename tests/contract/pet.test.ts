import { describe, expect, it } from "vitest";

import {
  CodexPetManifestSchema,
  PetAnimationSpeedRequestSchema,
  PetCharacterSnapshotSchema,
  PetConversationNavigationSchema,
  PetDragPointSchema,
  PetLibrarySnapshotSchema,
  PetMainNavigationSchema,
  PetScaleRequestSchema,
  ProactiveConversationBubbleReplyRequestSchema,
  ProactiveConversationBubbleReplyResponseSchema,
  ProactiveConversationBubbleSchema,
} from "../../src/shared/schemas/pet";
import { parseSchema } from "../../src/shared/schemas/validation";
import { parseSchemaWithoutCodeGeneration } from "../../src/shared/schemas/valueValidation";

const descriptor = {
  description: "A test pet",
  displayName: "Columbinya",
  id: "columbinya",
  spriteHeight: 2288,
  spriteUrl: "chara-mate-pet://asset/columbinya/spritesheet.webp",
  spriteVersionNumber: 2,
  spriteWidth: 1536,
} as const;

describe("pet IPC and import contracts", () => {
  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts v1 manifests with an omitted version through %s",
    (parse) => {
      expect(
        parse(CodexPetManifestSchema, {
          description: "Legacy atlas",
          displayName: "Linnea",
          id: "linnea",
          spritesheetPath: "spritesheet.webp",
        }),
      ).toMatchObject({ id: "linnea" });
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "validates a v2 library and Character projection through %s",
    (parse) => {
      expect(
        parse(PetLibrarySnapshotSchema, {
          activePetId: descriptor.id,
          animationSpeed: 0.75,
          pets: [descriptor],
          scale: 1.25,
        }),
      ).toMatchObject({ activePetId: descriptor.id });
      expect(
        parse(PetCharacterSnapshotSchema, {
          activePet: descriptor,
          animation: "look",
          animationSpeed: 0.75,
          facing: "left",
          scale: 1.25,
        }),
      ).toMatchObject({ animation: "look", facing: "left" });
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "rejects unsafe IDs, unsupported versions and local paths through %s",
    (parse) => {
      expect(() =>
        parse(CodexPetManifestSchema, {
          description: "Invalid",
          displayName: "Invalid",
          id: "../escape",
          spriteVersionNumber: 3,
          spritesheetPath: "/tmp/spritesheet.webp",
        }),
      ).toThrow();
      expect(() =>
        parse(PetCharacterSnapshotSchema, {
          activePet: { ...descriptor, spriteUrl: "file:///tmp/atlas.webp" },
          animation: "idle",
          animationSpeed: 0.75,
          facing: "right",
          scale: 1,
        }),
      ).toThrow();
      expect(() =>
        parse(PetDragPointSchema, {
          screenX: Number.NaN,
          screenY: 100,
        }),
      ).toThrow();
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts only the supported Main navigation targets through %s",
    (parse) => {
      expect(parse(PetMainNavigationSchema, { target: "chat" })).toEqual({
        target: "chat",
      });
      expect(parse(PetMainNavigationSchema, { target: "character" })).toEqual({
        target: "character",
      });
      expect(() =>
        parse(PetMainNavigationSchema, { target: "settings" }),
      ).toThrow();
      expect(() =>
        parse(PetMainNavigationSchema, {
          extra: true,
          target: "chat",
        }),
      ).toThrow();
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "accepts the size and speed slider boundaries through %s",
    (parse) => {
      expect(parse(PetScaleRequestSchema, { scale: 0.3 })).toEqual({
        scale: 0.3,
      });
      expect(
        parse(PetAnimationSpeedRequestSchema, { animationSpeed: 0.1 }),
      ).toEqual({ animationSpeed: 0.1 });
      expect(() => parse(PetScaleRequestSchema, { scale: 0.29 })).toThrow();
      expect(() =>
        parse(PetAnimationSpeedRequestSchema, { animationSpeed: 0.09 }),
      ).toThrow();
    },
  );

  it.each([parseSchema, parseSchemaWithoutCodeGeneration])(
    "allows a proactive conversation before or inside a Journey through %s",
    (parse) => {
      const bubble = {
        chatId: "11111111-1111-4111-8111-111111111111",
        content: "你在整理这篇文章吗？",
        createdAt: "2026-08-13T09:00:00.000Z",
        id: "22222222-2222-4222-8222-222222222222",
        kind: "continuation",
        replyState: "ready",
      };
      expect(parse(ProactiveConversationBubbleSchema, bubble)).toEqual(bubble);
      expect(
        parse(ProactiveConversationBubbleSchema, {
          ...bubble,
          journeyId: "33333333-3333-4333-8333-333333333333",
        }),
      ).toMatchObject({ journeyId: "33333333-3333-4333-8333-333333333333" });
      expect(
        parse(ProactiveConversationBubbleReplyRequestSchema, {
          bubbleId: bubble.id,
          content: "我正在整理实验设计。",
          requestedAt: "2026-08-13T09:01:00.000Z",
        }),
      ).toMatchObject({ bubbleId: bubble.id });
      expect(
        parse(ProactiveConversationBubbleReplyResponseSchema, {
          ok: true,
          value: { runId: "44444444-4444-4444-8444-444444444444" },
        }),
      ).toMatchObject({ ok: true });
      expect(
        parse(PetConversationNavigationSchema, {
          bubbleId: bubble.id,
          chatId: bubble.chatId,
        }),
      ).toEqual({ bubbleId: bubble.id, chatId: bubble.chatId });
      expect(
        parse(PetConversationNavigationSchema, { chatId: bubble.chatId }),
      ).toEqual({ chatId: bubble.chatId });
    },
  );
});
