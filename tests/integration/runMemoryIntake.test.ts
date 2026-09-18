import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  messageMemorySourceMetadata,
  toolMemorySourceMetadata,
} from "../../src/main/app/memoryFormationSources";
import { RunRepository } from "../../src/main/agent/runRepository";
import { runMemoryIntake } from "../../src/main/app/runMemoryIntake";
import type { MemoryFormationIntake } from "../../src/shared/contracts/memoryRecall";

function readMaterial(intake: MemoryFormationIntake | undefined) {
  if (!intake) return;
  const refs = [...intake.sources()];
  return {
    ...intake.episode,
    sources: refs.map(({ sourceId }) => {
      const source = intake.resolveSource(sourceId);
      if (!source) throw new Error("Fixture source unavailable");
      return source;
    }),
    evidenceSourceIds: refs
      .filter(({ primary }) => primary)
      .map(({ sourceId }) => sourceId),
  };
}
function runMaterial(...args: Parameters<typeof runMemoryIntake>) {
  return readMaterial(runMemoryIntake(...args));
}
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import type { Message } from "../../src/shared/contracts/chat";
import type { Run, RunItem } from "../../src/shared/contracts/run";
import {
  chatFixture,
  messageFixture,
  runFixture,
} from "../fixtures/foundationContracts";

const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function time(second: number): string {
  return new Date(
    Date.parse(runFixture.createdAt) + second * 1_000,
  ).toISOString();
}

function setup() {
  const database = openApplicationDatabase(":memory:");
  databases.push(database);
  const chats = new ChatRepository(database);
  const runs = new RunRepository(database);
  chats.insertChat(chatFixture);
  function run(value: number, options: Partial<Run> = {}, active = false): Run {
    const started: Run = { ...runFixture, id: id(value), ...options };
    runs.appendEvent({
      event: { type: "run.started", run: started },
      streamId: started.id,
      sequence: 1,
      occurredAt: started.createdAt,
    });
    if (active) return started;
    const completed: Run = {
      ...started,
      status: "completed",
      latestSequence: 2,
      endedAt: time(300),
    };
    runs.appendEvent({
      event: { type: "run.completed", run: completed },
      streamId: started.id,
      sequence: 2,
      occurredAt: completed.endedAt!,
    });
    return completed;
  }
  function message(
    run: Run,
    value: number,
    second: number,
    options: Partial<Message> = {},
  ): Message {
    return chats.insertMessage({
      ...messageFixture,
      id: id(value),
      runId: run.id,
      chatId: run.chatId,
      content: `消息 ${value}`,
      createdAt: time(second),
      updatedAt: time(second),
      ...options,
    });
  }
  function tool(run: Run, value: number, second: number): RunItem {
    const sequence = runs.getRun(run.id)!.latestSequence + 1;
    const item: RunItem = {
      id: id(value),
      runId: run.id,
      sequence,
      artifacts: [],
      kind: "tool_call",
      status: "running",
      input: { toolName: "territory.generate_item" },
      startedAt: time(second),
    };
    runs.appendEvent({
      event: { type: "item.started", item },
      streamId: run.id,
      sequence,
      occurredAt: time(second),
    });
    const completed: RunItem = {
      ...item,
      status: "completed",
      endedAt: time(second + 1),
      output: {
        status: "ok",
        summary: "已放好小灯塔",
        modelContent: { applied: true },
      },
    };
    runs.appendEvent({
      event: { type: "item.completed", item: completed },
      streamId: run.id,
      sequence: sequence + 1,
      occurredAt: time(second + 1),
    });
    return completed;
  }
  return { database, chats, runs, run, message, tool };
}

describe("Run memory formation sources", () => {
  it("uses the preceding exchange for context and keeps current sources as primary", () => {
    const value = setup();
    const old = value.run(1);
    const prior = value.run(2, { source: "voice" });
    const current = value.run(3);
    value.message(old, 101, 1);
    const context = value.message(prior, 102, 2, { content: "阿澄不吃花生。" });
    const primary = value.message(current, 103, 3, {
      content: "我现在可以吃香菜了。",
    });
    const episode = runMaterial(current, value.runs, value.chats);
    expect(episode?.sources.map(({ id }) => id)).toEqual([
      context.id,
      primary.id,
    ]);
    expect(episode?.sources[0]).toMatchObject({
      type: "voice",
      content: context.content,
    });
    expect(episode?.sources[1]).toMatchObject({
      type: "chat",
      content: primary.content,
    });
    expect(episode?.evidenceSourceIds).toEqual([primary.id]);
    expect(runMaterial(current, value.runs, value.chats)).toEqual(episode);
  });

  it("does not search past a completed message without a Run", () => {
    const value = setup();
    const prior = value.run(1);
    const current = value.run(2);
    value.message(prior, 101, 1);
    const boundary: Message = {
      ...messageFixture,
      id: id(102),
      createdAt: time(2),
    };
    delete boundary.runId;
    value.chats.insertMessage(boundary);
    const primary = value.message(current, 103, 3);
    expect(
      [...value.chats.memoryFormationMessageReferences(current.id)].map(
        ({ id }) => value.chats.getMessage(id),
      ),
    ).toEqual([primary]);
  });

  it("chooses the predecessor before excluding blank content and skips incomplete messages", () => {
    const value = setup();
    const older = value.run(1);
    const blank = value.run(2);
    const failed = value.run(3);
    const current = value.run(4);
    value.message(older, 101, 1);
    value.message(blank, 102, 2, { content: "   " });
    value.message(failed, 103, 3, { status: "failed" });
    const primary = value.message(current, 104, 4);
    const episode = runMaterial(current, value.runs, value.chats);
    expect(episode?.sources.map(({ id }) => id)).toEqual([primary.id]);
    expect(episode?.evidenceSourceIds).toEqual([primary.id]);
  });

  it("retains interleaved replies from the selected exchange using timestamp and ID order", () => {
    const value = setup();
    const prior = value.run(1);
    const current = value.run(2);
    const before = value.message(prior, 101, 1);
    const first = value.message(current, 102, 1);
    const after = value.message(prior, 103, 1, { role: "assistant" });
    const last = value.message(current, 104, 2, { role: "assistant" });
    expect(
      [...value.chats.memoryFormationMessageReferences(current.id)].map(
        ({ id }) => value.chats.getMessage(id),
      ),
    ).toEqual([before, first, after, last]);
    expect(
      runMaterial(current, value.runs, value.chats)?.evidenceSourceIds,
    ).toEqual([first.id, last.id]);
  });

  it("dates new formation by primary material even when an earlier exchange has a later reply", () => {
    const value = setup();
    const prior = value.run(1);
    const current = value.run(2);
    value.message(prior, 101, 1);
    const primary = value.message(current, 102, 2);
    const context = value.message(prior, 103, 3, { role: "assistant" });
    const intake = runMemoryIntake(current, value.runs, value.chats)!;
    expect(intake.episode.recordedAt).toBe(primary.createdAt);
    expect([...intake.sources()]).toContainEqual({
      sourceId: context.id,
      primary: false,
    });
  });

  it("does not truncate a long current Run or include another Chat", () => {
    const value = setup();
    value.chats.insertChat({ ...chatFixture, id: id(900) });
    const other = value.run(1, { chatId: id(900) });
    const current = value.run(2);
    value.message(other, 101, 1);
    const messages = Array.from({ length: 257 }, (_, index) =>
      value.message(current, 1_000 + index, index + 2),
    );
    expect(
      [...value.chats.memoryFormationMessageReferences(current.id)].map(
        ({ id }) => value.chats.getMessage(id),
      ),
    ).toEqual(messages);
    const episode = runMaterial(current, value.runs, value.chats);
    expect(episode?.sources).toHaveLength(257);
    expect(episode?.evidenceSourceIds).toEqual(messages.map(({ id }) => id));
  });

  it("forms only from actual Tool output when the current Run has no completed message", () => {
    const value = setup();
    const prior = value.run(1);
    const current = value.run(2, {}, true);
    value.message(prior, 101, 1);
    value.message(current, 102, 2, { status: "streaming" });
    expect(runMaterial(current, value.runs, value.chats)).toBeUndefined();
    const item = value.tool(current, 201, 3);
    const episode = runMaterial(current, value.runs, value.chats);
    expect(episode?.sources).toHaveLength(1);
    expect(episode?.sources[0]).toMatchObject({
      id: item.id,
      type: "tool",
      speaker: "tool",
    });
    expect(episode?.evidenceSourceIds).toEqual([item.id]);
  });

  it("keeps the actual Tool boundary, excluding later messages and the boundary item itself", () => {
    const value = setup();
    const prior = value.run(1);
    const current = value.run(2, {}, true);
    const context = value.message(prior, 101, 1);
    const primary = value.message(current, 102, 2);
    const before = value.tool(current, 201, 3);
    const through = value.tool(current, 202, 6);
    value.message(current, 103, 7, { role: "assistant" });
    const episode = runMaterial(current, value.runs, value.chats, through.id);
    expect(episode?.sources.map(({ id }) => id)).toEqual([
      context.id,
      primary.id,
      before.id,
    ]);
    expect(episode?.evidenceSourceIds).toEqual([primary.id, before.id]);
    expect(episode?.recordedAt).toBe(before.endedAt);
    expect(() =>
      runMaterial(current, value.runs, value.chats, id(999)),
    ).toThrow("boundary item is unavailable");
  });
});

describe("canonical source references", () => {
  it("reads only reference fields from the same two completed exchanges", () => {
    const value = setup();
    const old = value.run(1);
    const prior = value.run(2, { source: "voice" });
    const current = value.run(3);
    value.message(old, 101, 1, {
      content: "不在本次来源范围内。".repeat(10000),
    });
    const context = value.message(prior, 102, 2, {
      content: "同一份很长的上下文。".repeat(10000),
    });
    const primary = value.message(current, 103, 3, {
      content: "用户的新消息。",
    });
    const refs = [...value.chats.memoryFormationMessageReferences(current.id)];
    expect(refs.map(({ id }) => id)).toEqual([context.id, primary.id]);
    expect(refs.every((ref) => !Object.hasOwn(ref, "content"))).toBe(true);
    expect(messageMemorySourceMetadata(prior, refs[0]!)).toEqual({
      id: context.id,
      referenceId: prior.chatId,
      type: "voice",
      speaker: "user",
      occurredAt: context.createdAt,
    });
    expect(messageMemorySourceMetadata(current, refs[1]!)).toEqual({
      id: primary.id,
      referenceId: current.chatId,
      type: "chat",
      speaker: "user",
      occurredAt: primary.createdAt,
    });
  });
  it("matches JavaScript nonblank semantics including Unicode whitespace and NUL", () => {
    const value = setup();
    const current = value.run(1);
    const inputs = [
      "",
      " ",
      "\t\r\n",
      "\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
      "\u0085",
      "\u180e",
      "\u200b",
      "\0",
      " \0 ",
      "甲",
      "🪴",
      "\ufeff正文\u3000",
    ];
    for (const [index, content] of inputs.entries()) {
      const message = value.message(current, 100 + index, index, { content });
      expect(value.chats.getMessageSourceReference(message.id)?.hasText).toBe(
        Boolean(content.trim()),
      );
    }
  });
  it("preserves nullish tool metadata rules and never returns modelContent", () => {
    const value = setup();
    const current = value.run(1, {}, true);
    const item = value.tool(current, 101, 2);
    const ref = value.runs.getRunItemSourceReference(item.id)!;
    expect(toolMemorySourceMetadata(current, ref)).toEqual({
      id: item.id,
      referenceId: current.id,
      type: "tool",
      speaker: "tool",
      occurredAt: item.endedAt,
    });
    expect(ref).not.toHaveProperty("output");
    const update = value.database.prepare(
      "UPDATE run_items SET input_json=?,output_json=? WHERE id=?",
    );
    for (const [input, output, expectedName, expectedMessage, hasOutput] of [
      [
        { toolName: null, name: "a", messageId: "input" },
        {
          messageId: null,
          status: "unknown",
          summary: "待核验",
          modelContent: "z".repeat(10000),
        },
        "a",
        "input",
        true,
      ],
      [
        { toolName: 0, name: "a", messageId: "input" },
        { messageId: 0, status: 0, summary: "结果" },
        undefined,
        undefined,
        false,
      ],
      [
        { toolName: [], name: "a", messageId: "input" },
        { messageId: [], status: "ok", summary: {} },
        undefined,
        undefined,
        false,
      ],
      [
        { toolName: "", name: "b", messageId: "input" },
        { messageId: "", status: "", summary: "" },
        "",
        "",
        true,
      ],
    ] as const) {
      update.run(JSON.stringify(input), JSON.stringify(output), item.id);
      const actual = value.runs.getRunItemSourceReference(item.id)!;
      expect(actual.toolName).toBe(expectedName);
      expect(actual.messageId).toBe(expectedMessage);
      expect(actual.hasToolOutput).toBe(hasOutput);
    }
    // The SQL fixture above varies scalar shapes; production terminal Items are immutable.
  });
  it("does not hold a SQLite cursor across source-reference yields", () => {
    const value = setup();
    const current = value.run(1);
    value.message(current, 101, 1);
    value.message(current, 102, 2);
    const refs = value.chats.memoryFormationMessageReferences(current.id);
    const iterator = refs[Symbol.iterator]();
    expect(iterator.next().done).toBe(false);
    expect(() =>
      value.database.transaction(() =>
        value.database
          .prepare("UPDATE chats SET title=? WHERE id=?")
          .run("读取中仍可提交", current.chatId),
      )(),
    ).not.toThrow();
    expect(iterator.next().done).toBe(false);
    expect(iterator.next().done).toBe(true);
  });
});
