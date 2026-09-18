import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ActivityRepository } from "../../src/main/activity/activityRepository";
import { RunRepository } from "../../src/main/agent/runRepository";
import { cognitionMemoryIntake } from "../../src/main/app/cognitionMemoryIntake";
import {
  cognitionMemorySource,
  cognitionMemorySourceReference,
  type MemorySourceRecords,
  type MemorySourceReferences,
} from "../../src/main/app/memoryFormationSources";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import { MemoryFormationRepository } from "../../src/main/memory/memoryFormationRepository";
import type { ActivityEvent } from "../../src/shared/contracts/activity";
import type {
  CognitionEvidence,
  CognitionMemoryHandoff,
} from "../../src/shared/contracts/cognition";
import type { RunItem } from "../../src/shared/contracts/run";
import {
  chatFixture,
  messageFixture,
  runFixture,
} from "../fixtures/foundationContracts";

const now = "2026-09-15T12:00:00.000Z";
const id = (value: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, "0")}`;
const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(provisional = false) {
  const database = openApplicationDatabase(":memory:");
  databases.push(database);
  const chats = new ChatRepository(database);
  const runs = new RunRepository(database);
  const activities = new ActivityRepository(database);
  const memory = new MemoryFormationRepository(database);
  chats.insertChat(chatFixture, { provisional });
  runs.appendEvent({
    event: { type: "run.started", run: runFixture },
    streamId: runFixture.id,
    sequence: 1,
    occurredAt: runFixture.createdAt,
  });
  const message = chats.insertMessage({
    ...messageFixture,
    role: provisional ? "assistant" : "user",
    content: provisional
      ? "你刚才在看行程，我可以陪你一起整理。"
      : "之前我说的是姐姐的行程，我自己还没有决定。",
  });
  function terminalItem(
    itemId: string,
    sequence: number,
    kind: RunItem["kind"],
    input: NonNullable<RunItem["input"]>,
    output: NonNullable<RunItem["output"]>,
  ): RunItem {
    const item: RunItem = {
      id: itemId,
      runId: runFixture.id,
      sequence,
      kind,
      status: "running",
      input,
      artifacts: [],
      startedAt: message.createdAt,
    };
    runs.appendEvent({
      event: { type: "item.started", item },
      streamId: runFixture.id,
      sequence,
      occurredAt: message.createdAt,
    });
    const completed: RunItem = {
      ...item,
      status: "completed",
      output,
      endedAt: message.createdAt,
    };
    runs.appendEvent({
      event: { type: "item.completed", item: completed },
      streamId: runFixture.id,
      sequence: sequence + 1,
      occurredAt: message.createdAt,
    });
    return completed;
  }
  const messageItem = terminalItem(
    id(1),
    2,
    provisional ? "assistant_message" : "user_message",
    { content: message.content, messageId: message.id },
    { messageId: message.id },
  );
  const toolItem = terminalItem(
    id(2),
    4,
    "tool_call",
    { toolName: "territory.act" },
    {
      status: "success",
      summary: "已把蓝色茶杯放到桌上。",
      modelContent: { applied: true },
    },
  );
  runs.appendEvent({
    event: {
      type: "run.completed",
      run: {
        ...runFixture,
        status: "completed",
        latestSequence: 6,
        endedAt: message.createdAt,
      },
    },
    streamId: runFixture.id,
    sequence: 6,
    occurredAt: message.createdAt,
  });
  const event: ActivityEvent = {
    id: id(3),
    actor: "user",
    startedAt: now,
    details: {
      source: "active_app",
      appName: "Notes",
      windowTitle: "新的行程确认",
    },
  };
  activities.insertEvent(event, now);
  const utterance: CognitionEvidence = {
    id: id(10),
    personaId: runFixture.persona.personaId,
    chatId: runFixture.chatId,
    actor: provisional ? "agent" : "user",
    kind: "utterance",
    source: { kind: "run", id: runFixture.id, fragment: messageItem.id },
    text: "缩短的解释不充当原文。",
    observedAt: message.createdAt,
    receivedAt: message.createdAt,
    receiptSequence: 1,
  };
  const effect: CognitionEvidence = {
    ...utterance,
    id: id(11),
    actor: "agent",
    kind: "effect",
    source: { kind: "run", id: runFixture.id, fragment: toolItem.id },
    receiptSequence: 2,
  };
  const fresh: CognitionEvidence = {
    id: id(12),
    personaId: runFixture.persona.personaId,
    actor: "user",
    kind: "observation",
    source: { kind: "activity", id: event.id },
    text: "新的当前观察。",
    observedAt: now,
    receivedAt: now,
    receiptSequence: 3,
  };
  const raw: MemorySourceRecords = {
    getRun: (key) => runs.getRun(key),
    getRunItem: (key) => runs.getRunItem(key),
    getMessage: (key) => chats.getMessage(key),
    getActivityEvent: (key) => activities.getEvent(key),
  };
  const references: MemorySourceReferences = {
    hasChat: (key) => Boolean(chats.getChat(key)),
    getCanonicalSource: (key) => memory.getSourceMetadata(key),
    getRunSource: (key) => runs.getRunSourceReference(key),
    getRunItemSource: (key) => runs.getRunItemSourceReference(key),
    getMessageSource: (key) => chats.getMessageSourceReference(key),
    getActivitySource: (key) => activities.getEventSourceReference(key),
  };
  const originals = [utterance, effect].map((evidence) => {
    const source = cognitionMemorySource(evidence, raw)!;
    memory.registerSource(source);
    return source;
  });
  const describeSource = (evidence: CognitionEvidence) =>
    cognitionMemorySourceReference(evidence, references);
  const evidence = [utterance, effect, fresh];
  function intake(
    primaries: readonly CognitionEvidence[],
    history: readonly CognitionEvidence[] = [],
  ) {
    const handoff: CognitionMemoryHandoff = {
      id: id(20),
      personaId: runFixture.persona.personaId,
      situationId: id(21),
      committedAt: now,
      primaryEvidenceIds: primaries.map(({ id }) => id),
      historyEvidenceIds: history.map(({ id }) => id),
      contextGroups: [],
    };
    // Frozen Cognition references are the boundary input; all source resolution
    // and Memory intake below use the actual domain repositories and SQLite.
    return cognitionMemoryIntake(
      handoff,
      {
        memoryHandoffEvidence: (_handoff, ids) =>
          evidence.filter(({ id }) => ids.includes(id)),
        memoryHandoffContext: () => [],
      },
      describeSource,
      (value) => cognitionMemorySource(value, raw),
    );
  }
  return {
    database,
    chats,
    runs,
    memory,
    message,
    messageItem,
    event,
    utterance,
    effect,
    fresh,
    originals,
    describeSource,
    intake,
  };
}

describe("Memory source retirement when a Chat is deleted", () => {
  it.each(["delete", "expire_provisional", "clean_startup"] as const)(
    "%s keeps independent Memory and transfers the remaining mixed sources",
    (operation) => {
      const f = fixture(operation !== "delete");
      for (const source of [f.utterance, f.effect])
        expect(f.describeSource(source).kind).toBe("available");
      if (operation === "delete")
        expect(f.chats.deleteChat(chatFixture.id)).toBe(true);
      else if (operation === "expire_provisional")
        expect(f.chats.deleteProvisionalChat(chatFixture.id)).toBe(true);
      else expect(f.chats.deleteAllProvisionalChats()).toBe(1);
      expect(f.runs.getRun(runFixture.id)).toBeUndefined();
      expect(f.runs.getRunItem(f.messageItem.id)).toBeUndefined();
      expect(f.chats.getMessage(f.message.id)).toBeUndefined();
      for (const source of [f.utterance, f.effect])
        expect(f.describeSource(source)).toEqual({ kind: "unsupported" });
      for (const original of f.originals)
        expect(
          f.memory.getFormationSource(original.type, original.referenceId),
        ).toEqual(original);

      const work = f.intake([f.fresh, f.effect], [f.utterance])!;
      expect([...work.sources()]).toEqual([
        { sourceId: f.event.id, primary: true },
      ]);
      expect(work.resolveSource(f.event.id)?.content).toContain("新的行程确认");
      const enqueued = f.memory.enqueue(work, "formation-test", now);
      expect(f.memory.sourceCounts(enqueued.workId)).toEqual({
        primary: 1,
        context: 0,
      });
      expect([...f.memory.pendingWork()]).toHaveLength(1);
    },
  );

  it("does not promote context after every primary source was deleted", () => {
    const f = fixture();
    f.chats.deleteChat(chatFixture.id);
    expect(f.describeSource(f.fresh).kind).toBe("available");
    expect(f.intake([f.utterance, f.effect], [f.fresh])).toBeUndefined();
    expect([...f.memory.pendingWork()]).toEqual([]);
    expect(f.memory.getSourceMetadata(f.message.id)).toBeDefined();
  });

  it("keeps a missing Item distinct from a deleted Chat even with a canonical original", () => {
    const f = fixture();
    // Simulate an unavailable source record while its owner Chat still exists.
    f.database
      .prepare("DELETE FROM run_items WHERE id = ?")
      .run(f.messageItem.id);
    expect(f.chats.getChat(chatFixture.id)).toBeDefined();
    expect(f.memory.getSourceMetadata(f.message.id)).toBeDefined();
    expect(f.describeSource(f.utterance)).toEqual({
      kind: "missing",
      reference: f.messageItem.id,
    });
    expect(() => f.intake([f.fresh], [f.utterance])).toThrow(
      "Original source is unavailable",
    );
    expect([...f.memory.pendingWork()]).toEqual([]);
  });
});
