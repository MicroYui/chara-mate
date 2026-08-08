import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunEventService } from "../../src/main/agent/runEventService";
import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { openApplicationDatabase } from "../../src/main/db/database";
import type { RunEventEnvelope } from "../../src/shared/contracts/ipc";
import type { Run, RunItem } from "../../src/shared/contracts/run";
import { REDACTED_VALUE } from "../../src/shared/pure/redaction";
import { FakeClock } from "../fixtures/fakeClock";
import {
  approvalFixture,
  attachmentFixture,
  artifactFixture,
  chatFixture,
  FIXTURE_IDS,
  FIXTURE_TIMESTAMPS,
  messageFixture,
  runFixture,
  runItemFixture,
} from "../fixtures/foundationContracts";

const temporaryDirectories: string[] = [];

const OTHER_CHAT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THIRD_CHAT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOURTH_CHAT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createDatabase(): Promise<{
  database: Database.Database;
  databasePath: string;
}> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "chara-mate-chat-data-"),
  );
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "charamate.sqlite");
  return {
    database: openApplicationDatabase(databasePath),
    databasePath,
  };
}

function eventTime(sequence: number): string {
  return new Date(
    Date.parse(FIXTURE_TIMESTAMPS.created) + sequence * 1_000,
  ).toISOString();
}

function envelope(
  sequence: number,
  event: RunEventEnvelope["event"],
): RunEventEnvelope {
  return {
    event,
    occurredAt: eventTime(sequence),
    sequence,
    streamId: FIXTURE_IDS.run,
  };
}

function startedRun(): Run {
  return { ...runFixture, latestSequence: 1, status: "running" };
}

function startedItem(): RunItem {
  return {
    ...runItemFixture,
    artifacts: [],
    sequence: 2,
    status: "running",
  };
}

function chatService(
  chats: ChatRepository,
  runs: RunRepository,
  generatedId = OTHER_CHAT_ID,
): ChatService {
  return new ChatService(
    chats,
    runs,
    { generate: () => generatedId },
    new FakeClock(FIXTURE_TIMESTAMPS.updated),
  );
}

describe("Phase 1 Chat Data and Run event persistence", () => {
  it("manages, orders, searches and restores multiple Chats through the domain service", async () => {
    const { database, databasePath } = await createDatabase();
    const clock = new FakeClock(FIXTURE_TIMESTAMPS.created);
    const generatedIds = [FIXTURE_IDS.chat, OTHER_CHAT_ID, THIRD_CHAT_ID];
    const service = new ChatService(
      new ChatRepository(database),
      new RunRepository(database),
      { generate: () => generatedIds.shift() ?? FOURTH_CHAT_ID },
      clock,
    );

    const alpha = service.create({ title: "Alpha notes" });
    clock.advance(1_000);
    const beta = service.create({ title: "Project Beta" });
    clock.advance(1_000);
    const gamma = service.create({ title: "Gamma" });
    clock.advance(1_000);
    const pinnedAlpha = service.setPinned({ chatId: alpha.id, pinned: true });

    expect(service.list({ status: "active" }).map(({ id }) => id)).toEqual([
      alpha.id,
      gamma.id,
      beta.id,
    ]);
    expect(service.list({ query: "  BETA ", status: "active" })).toEqual([
      beta,
    ]);
    expect(pinnedAlpha.pinnedAt).toBe(clock.now());

    clock.advance(1_000);
    expect(
      service.rename({ chatId: beta.id, title: "  Beta renamed  " }).title,
    ).toBe("Beta renamed");
    clock.advance(1_000);
    const archived = service.archive({ chatId: alpha.id });
    expect(archived).toMatchObject({ status: "archived" });
    expect(service.list({ status: "active" }).map(({ id }) => id)).toEqual([
      beta.id,
      gamma.id,
    ]);
    expect(service.list({ status: "archived" })).toEqual([archived]);
    await expect(
      service.runSerializedTurn(alpha.id, () => Promise.resolve("never")),
    ).rejects.toMatchObject({ code: "CHAT.ARCHIVED" });

    clock.advance(1_000);
    const restored = service.restore({ chatId: alpha.id });
    expect(restored.status).toBe("active");
    expect(restored).not.toHaveProperty("archivedAt");
    expect(service.delete({ chatId: gamma.id })).toEqual({ chatId: gamma.id });
    expect(service.getSnapshot({ chatId: gamma.id })).toBeNull();
    database.close();

    const reopened = openApplicationDatabase(databasePath);
    const restoredService = chatService(
      new ChatRepository(reopened),
      new RunRepository(reopened),
    );
    expect(
      restoredService.list({ status: "active" }).map(({ id, title }) => ({
        id,
        title,
      })),
    ).toEqual([
      { id: alpha.id, title: "Alpha notes" },
      { id: beta.id, title: "Beta renamed" },
    ]);
    expect(restoredService.list({ status: "archived" })).toEqual([]);
    reopened.close();
  });

  it("serializes Turns within one Chat while allowing another Chat to proceed", async () => {
    const { database } = await createDatabase();
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    chats.insertChat(chatFixture);
    chats.insertChat({ ...chatFixture, id: OTHER_CHAT_ID, title: "Other" });
    const service = chatService(chats, runs);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });

    const first = service.runSerializedTurn(FIXTURE_IDS.chat, async () => {
      order.push("first:start");
      markFirstEntered();
      await firstGate;
      order.push("first:end");
      return "first";
    });
    await firstEntered;
    const second = service.runSerializedTurn(FIXTURE_IDS.chat, () => {
      order.push("second:start");
      order.push("second:end");
      return Promise.resolve("second");
    });
    const other = service.runSerializedTurn(OTHER_CHAT_ID, () => {
      order.push("other:start");
      order.push("other:end");
      return Promise.resolve("other");
    });

    await expect(other).resolves.toBe("other");
    expect(order).toEqual(["first:start", "other:start", "other:end"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(order).toEqual([
      "first:start",
      "other:start",
      "other:end",
      "first:end",
      "second:start",
      "second:end",
    ]);
    database.close();
  });

  it("uses the durable Run projection to prevent two active Turns for one Chat", async () => {
    const { database } = await createDatabase();
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    chats.insertChat(chatFixture);
    runs.appendEvent(envelope(1, { run: startedRun(), type: "run.started" }));
    const service = chatService(chats, runs);

    await expect(
      service.runSerializedTurn(FIXTURE_IDS.chat, () =>
        Promise.resolve("never"),
      ),
    ).rejects.toMatchObject({ code: "CHAT.TURN_ACTIVE" });

    const secondRunId = FOURTH_CHAT_ID;
    expect(() =>
      runs.appendEvent({
        event: {
          run: { ...startedRun(), id: secondRunId },
          type: "run.started",
        },
        occurredAt: eventTime(1),
        sequence: 1,
        streamId: secondRunId,
      }),
    ).toThrow(/UNIQUE/u);
    expect(runs.getSnapshot(FIXTURE_IDS.chat).runs).toEqual([startedRun()]);
    database.close();
  });

  it("persists a complete Chat snapshot and restores it after reopen", async () => {
    const { database, databasePath } = await createDatabase();
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    const service = chatService(chats, runs);

    chats.insertChat(chatFixture);
    runs.appendEvent(envelope(1, { run: startedRun(), type: "run.started" }));
    chats.insertMessage(messageFixture);
    chats.insertAttachment(attachmentFixture);

    expect(service.getSnapshot({ chatId: FIXTURE_IDS.chat })).toEqual({
      approvals: [],
      attachments: [attachmentFixture],
      chat: chatFixture,
      messages: [messageFixture],
      runItems: [],
      runs: [startedRun()],
    });
    expect(service.getSnapshot({ chatId: OTHER_CHAT_ID })).toBeNull();
    database.close();

    const reopened = openApplicationDatabase(databasePath);
    const restored = chatService(
      new ChatRepository(reopened),
      new RunRepository(reopened),
    ).getSnapshot({ chatId: FIXTURE_IDS.chat });
    expect(restored).toEqual({
      approvals: [],
      attachments: [attachmentFixture],
      chat: chatFixture,
      messages: [messageFixture],
      runItems: [],
      runs: [startedRun()],
    });
    reopened.close();
  });

  it("allows streaming message completion but keeps completed messages append-first", async () => {
    const { database } = await createDatabase();
    const chats = new ChatRepository(database);
    chats.insertChat(chatFixture);
    const streaming = {
      chatId: messageFixture.chatId,
      content: "Partial",
      createdAt: messageFixture.createdAt,
      id: messageFixture.id,
      role: messageFixture.role,
      status: "streaming" as const,
      updatedAt: messageFixture.updatedAt,
    };
    chats.insertMessage(streaming);
    const completed = {
      ...streaming,
      content: "Complete",
      status: "completed" as const,
      updatedAt: FIXTURE_TIMESTAMPS.updated,
    };

    expect(chats.updateMessage(completed)).toEqual(completed);
    expect(chats.updateMessage(completed)).toEqual(completed);
    expect(() =>
      chats.updateMessage({ ...completed, content: "Rewritten" }),
    ).toThrow(/append-first/u);
    expect(chats.getSnapshot(FIXTURE_IDS.chat)?.messages).toEqual([completed]);
    database.close();
  });

  it("projects a Run lifecycle and replays only contiguous events after a sequence", async () => {
    const { database } = await createDatabase();
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    chats.insertChat(chatFixture);

    const item = startedItem();
    const requestedApproval = {
      ...approvalFixture,
      itemId: item.id,
      status: "pending" as const,
    };
    const resolvedApproval = {
      ...requestedApproval,
      decidedAt: eventTime(4),
      decisionReason: "User approved once",
      status: "approved" as const,
    };
    const completedItem = {
      ...item,
      artifacts: [artifactFixture],
      displayOutput: "Tests passed",
      durationMs: 3_000,
      endedAt: eventTime(5),
      status: "completed" as const,
    };
    const completedRun = {
      ...startedRun(),
      endedAt: eventTime(6),
      latestSequence: 6,
      status: "completed" as const,
    };
    const events = [
      envelope(1, { run: startedRun(), type: "run.started" }),
      envelope(2, { item, type: "item.started" }),
      envelope(3, {
        approval: requestedApproval,
        type: "approval.requested",
      }),
      envelope(4, {
        approval: resolvedApproval,
        type: "approval.resolved",
      }),
      envelope(5, { item: completedItem, type: "item.completed" }),
      envelope(6, { run: completedRun, type: "run.completed" }),
    ];
    for (const event of events) {
      expect(runs.appendEvent(event)).toMatchObject({ inserted: true });
    }

    expect(
      runs.replay({ afterSequence: 2, streamId: FIXTURE_IDS.run }),
    ).toEqual({
      events: events.slice(2),
      latestSequence: 6,
      streamId: FIXTURE_IDS.run,
    });
    expect(runs.getSnapshot(FIXTURE_IDS.chat)).toEqual({
      approvals: [resolvedApproval],
      runItems: [completedItem],
      runs: [completedRun],
    });
    expect(() =>
      runs.appendEvent(
        envelope(7, {
          item: {
            ...startedItem(),
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            sequence: 7,
          },
          type: "item.started",
        }),
      ),
    ).toThrow(/already terminal/u);
    database.close();
  });

  it("projects text deltas into the visible item output while streaming", async () => {
    const { database } = await createDatabase();
    new ChatRepository(database).insertChat(chatFixture);
    const runs = new RunRepository(database);
    const item = startedItem();

    runs.appendEvent(envelope(1, { run: startedRun(), type: "run.started" }));
    runs.appendEvent(envelope(2, { item, type: "item.started" }));
    runs.appendEvent(
      envelope(3, {
        delta: { text: "first" },
        itemId: item.id,
        type: "item.delta",
      }),
    );
    runs.appendEvent(
      envelope(4, {
        delta: { text: " second" },
        itemId: item.id,
        type: "item.delta",
      }),
    );

    expect(runs.getRunItem(item.id)).toMatchObject({
      displayOutput: "first second",
      status: "running",
    });
    expect(runs.getRun(FIXTURE_IDS.run)?.latestSequence).toBe(4);
    database.close();
  });

  it("commits before broadcast and does not rebroadcast an idempotent append", async () => {
    const { database, databasePath } = await createDatabase();
    new ChatRepository(database).insertChat(chatFixture);
    const repository = new RunRepository(database);
    const publish = vi.fn((published: RunEventEnvelope) => {
      const observerDatabase = openApplicationDatabase(databasePath);
      const observed = new RunRepository(observerDatabase).replay({
        afterSequence: 0,
        streamId: FIXTURE_IDS.run,
      });
      observerDatabase.close();
      expect(observed.events).toEqual([published]);
    });
    const service = new RunEventService(repository, { publish });
    const first = envelope(1, {
      run: startedRun(),
      type: "run.started",
    });

    expect(service.append(first)).toEqual(first);
    expect(service.append(first)).toEqual(first);
    expect(publish).toHaveBeenCalledOnce();
    database.close();
  });

  it("rejects gaps, conflicting duplicates and invalid projections atomically", async () => {
    const { database } = await createDatabase();
    new ChatRepository(database).insertChat(chatFixture);
    const runs = new RunRepository(database);
    const first = envelope(1, {
      run: startedRun(),
      type: "run.started",
    });
    runs.appendEvent(first);

    expect(() =>
      runs.appendEvent(
        envelope(3, { item: startedItem(), type: "item.started" }),
      ),
    ).toThrow(/Expected run .* sequence 2/u);
    expect(() =>
      runs.appendEvent({ ...first, occurredAt: eventTime(9) }),
    ).toThrow(/different event/u);
    expect(() =>
      runs.appendEvent(
        envelope(2, {
          approval: approvalFixture,
          type: "approval.requested",
        }),
      ),
    ).toThrow(/does not belong/u);

    expect(
      runs.replay({ afterSequence: 0, streamId: FIXTURE_IDS.run }),
    ).toEqual({
      events: [first],
      latestSequence: 1,
      streamId: FIXTURE_IDS.run,
    });
    expect(runs.getSnapshot(FIXTURE_IDS.chat)).toEqual({
      approvals: [],
      runItems: [],
      runs: [startedRun()],
    });
    database.close();
  });

  it("redacts event and entity secrets before they reach SQLite or subscribers", async () => {
    const { database } = await createDatabase();
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    const secret = "sk-1234567890abcdef";
    const persistedChat = chats.insertChat({
      ...chatFixture,
      title: `api_key=${secret}`,
    });
    runs.appendEvent(envelope(1, { run: startedRun(), type: "run.started" }));
    const persistedEvent = runs.appendEvent(
      envelope(2, {
        item: {
          ...startedItem(),
          displayOutput: `Authorization: Bearer ${secret}`,
          input: { apiKey: secret },
        },
        type: "item.started",
      }),
    ).envelope;

    expect(persistedChat.title).toContain(REDACTED_VALUE);
    expect(JSON.stringify(persistedEvent)).not.toContain(secret);
    expect(
      JSON.stringify(
        runs.replay({
          afterSequence: 0,
          streamId: FIXTURE_IDS.run,
        }),
      ),
    ).not.toContain(secret);
    database.close();
  });

  it("enforces cross-Chat references and cascades one Chat as one data owner", async () => {
    const { database } = await createDatabase();
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    chats.insertChat(chatFixture);
    chats.insertChat({
      ...chatFixture,
      id: OTHER_CHAT_ID,
      title: "Other chat",
    });
    runs.appendEvent(envelope(1, { run: startedRun(), type: "run.started" }));
    const item = startedItem();
    runs.appendEvent(envelope(2, { item, type: "item.started" }));
    runs.appendEvent(
      envelope(3, {
        item: {
          ...item,
          artifacts: [artifactFixture],
          endedAt: eventTime(3),
          status: "completed",
        },
        type: "item.completed",
      }),
    );

    expect(() =>
      chats.insertMessage({ ...messageFixture, chatId: OTHER_CHAT_ID }),
    ).toThrow(/FOREIGN KEY/u);
    chats.insertMessage(messageFixture);
    expect(() =>
      chats.insertAttachment({
        ...attachmentFixture,
        chatId: OTHER_CHAT_ID,
      }),
    ).toThrow(/FOREIGN KEY/u);
    chats.insertAttachment(attachmentFixture);

    expect(chats.deleteChat(FIXTURE_IDS.chat)).toBe(true);
    for (const table of [
      "attachments",
      "messages",
      "run_events",
      "tool_artifacts",
      "run_items",
      "runs",
    ]) {
      const row = database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number };
      expect(row.count, table).toBe(0);
    }
    expect(chats.getSnapshot(OTHER_CHAT_ID)?.chat.id).toBe(OTHER_CHAT_ID);
    database.close();
  });

  it("refuses an unknown current-schema version without creating product tables", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "chara-mate-schema-version-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "charamate.sqlite");
    const raw = new Database(databasePath);
    raw.exec(
      `CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT`,
    );
    raw
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run("schema_version", "999");
    raw.close();

    expect(() => openApplicationDatabase(databasePath)).toThrow(
      /Unsupported database schema version: 999/u,
    );
    const inspection = new Database(databasePath, { readonly: true });
    const tables = inspection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[];
    inspection.close();
    expect(tables).toEqual([{ name: "app_metadata" }]);
  });
});
