import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunEventService } from "../../src/main/agent/runEventService";
import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatDataService } from "../../src/main/chat/chatDataService";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import type { RunEventEnvelope } from "../../src/shared/contracts/ipc";
import type { Run, RunItem } from "../../src/shared/contracts/run";
import { REDACTED_VALUE } from "../../src/shared/pure/redaction";
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

describe("Phase 1 Chat Data and Run event persistence", () => {
  it("persists a complete Chat snapshot and restores it after reopen", async () => {
    const { database, databasePath } = await createDatabase();
    const chats = new ChatRepository(database);
    const runs = new RunRepository(database);
    const service = new ChatDataService(chats, runs);

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
    const restored = new ChatDataService(
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
