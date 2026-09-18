import {
  formationRuntime,
  formationResourceBudget,
} from "../fixtures/formationModel";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryForegroundActivity } from "../../src/main/app/memoryForegroundActivity";
import { RunEventService } from "../../src/main/agent/runEventService";
import { RunEventWriter } from "../../src/main/agent/runEventWriter";
import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { openApplicationDatabase } from "../../src/main/db/database";
import { LexicalRetrievalPipeline } from "../../src/main/memory/lexicalRetrievalPipeline";
import { estimateInputBudget } from "../../src/main/providers/inputBudget";
import type { MemoryConsolidationModel } from "../../src/main/memory/memoryConsolidation";
import { MemoryMaintenance } from "../../src/main/memory/memoryMaintenance";
import { MemoryRepository } from "../../src/main/memory/memoryRepository";
import { MemoryService } from "../../src/main/memory/memoryService";
import { searchMemoryVectors } from "../../src/main/memory/memoryVectorSearch";
import type { RunEventEnvelope } from "../../src/shared/contracts/ipc";
import type { VoiceSessionSnapshot } from "../../src/shared/contracts/voice";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { parseSchema } from "../../src/shared/schemas/validation";
import { VoiceSessionSnapshotSchema } from "../../src/shared/schemas/voice";
import {
  approvalFixture,
  chatFixture,
  runFixture,
} from "../fixtures/foundationContracts";
import { formationIntake } from "../fixtures/memoryFormation";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupRunEvents(
  maintenance: Pick<MemoryMaintenance, "setForegroundActive">,
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "memory-foreground-"));
  const database = openApplicationDatabase(path.join(directory, "app.sqlite"));
  const clock = { now: () => "2026-09-16T08:00:00.000Z" };
  const ids = new CryptoIdGenerator();
  const runs = new RunRepository(database);
  const observer = new MemoryForegroundActivity(runs, maintenance);
  const published: RunEventEnvelope[] = [];
  const events = new RunEventService(runs, {
    publish(envelope) {
      published.push(envelope);
      observer.observeRun(envelope);
    },
  });
  const writer = new RunEventWriter(runs, events, ids, clock);
  const chats = new ChatRepository(database);
  const start = () => {
    const chatId = randomUUID();
    chats.insertChat({ ...chatFixture, id: chatId });
    const run = { ...runFixture, id: randomUUID(), chatId };
    writer.startRun(run);
    return run;
  };
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
    return Promise.resolve();
  });
  return {
    database,
    clock,
    ids,
    runs,
    observer,
    published,
    events,
    writer,
    start,
  };
}

function voice(phase: VoiceSessionSnapshot["phase"]): VoiceSessionSnapshot {
  return parseSchema(VoiceSessionSnapshotSchema, {
    sessionId: randomUUID(),
    chatId: chatFixture.id,
    createdAt: "2026-09-16T08:00:00.000Z",
    generation: 1,
    inputMode: "hands_free",
    muted: false,
    persona: runFixture.persona,
    voice: "verse",
    userTranscript: "",
    assistantTranscript: "",
    phase,
  });
}

describe("foreground execution and the single Memory maintenance owner", () => {
  it("waits for every concurrent Run and ignores duplicate appends and event replay", () => {
    const setForegroundActive = vi.fn();
    const f = setupRunEvents({ setForegroundActive });
    const first = f.start(),
      second = f.start();
    expect(setForegroundActive.mock.calls).toEqual([[true]]);
    f.writer.transition(first.id, "completed");
    expect(setForegroundActive.mock.calls).toEqual([[true]]);
    f.events.append(f.published[0]!);
    f.events.replay({ streamId: first.id, afterSequence: 0 });
    expect(setForegroundActive.mock.calls).toEqual([[true]]);
    f.writer.transition(second.id, "failed");
    expect(setForegroundActive.mock.calls).toEqual([[true], [false]]);
  });

  it("uses committed approval, input, resume and interruption states", () => {
    const setForegroundActive = vi.fn();
    const f = setupRunEvents({ setForegroundActive });
    const run = f.start();
    const item = f.writer.startItem(run.id, "tool_call");
    const approval = {
      ...approvalFixture,
      id: randomUUID(),
      runId: run.id,
      itemId: item.id,
    };
    f.writer.requestApproval(approval);
    expect(f.runs.getRun(run.id)?.status).toBe("waiting_approval");
    expect(setForegroundActive.mock.calls).toEqual([[true], [false]]);
    f.writer.resolveApproval({
      ...approval,
      status: "approved",
      decidedAt: f.clock.now(),
    });
    expect(setForegroundActive.mock.calls.at(-1)).toEqual([true]);
    f.writer.completeItem(item.id, { status: "completed" });
    const input = f.writer.startItem(run.id, "input_request", {
      questions: [{ id: "choice", question: "选择一项", options: [] }],
    });
    f.writer.requestInput(input.id);
    expect(setForegroundActive.mock.calls.at(-1)).toEqual([false]);
    f.writer.resolveInput(input.id, {
      status: "cancelled",
      resolvedAt: f.clock.now(),
    });
    expect(setForegroundActive.mock.calls.at(-1)).toEqual([true]);
    f.writer.transition(run.id, "interrupted");
    expect(setForegroundActive.mock.calls.at(-1)).toEqual([false]);
    f.writer.resume(run.id);
    expect(setForegroundActive.mock.calls.at(-1)).toEqual([true]);
    f.writer.transition(run.id, "cancelled");
    expect(setForegroundActive.mock.calls).toEqual([
      [true],
      [false],
      [true],
      [false],
      [true],
      [false],
      [true],
      [false],
    ]);
  });

  it("tracks Voice independently of text completion and does not treat transcript deltas as new activity", () => {
    const setForegroundActive = vi.fn();
    const f = setupRunEvents({ setForegroundActive });
    f.observer.observeVoice(voice("connecting"));
    const run = f.start();
    const item = f.writer.startItem(run.id, "assistant_message");
    f.writer.appendDelta(run.id, item.id, { text: "一句话" });
    f.writer.completeItem(item.id, { status: "completed" });
    f.writer.transition(run.id, "completed");
    for (const phase of [
      "listening",
      "thinking",
      "using_tool",
      "waiting_approval",
      "speaking",
    ] as const)
      f.observer.observeVoice(voice(phase));
    expect(setForegroundActive.mock.calls).toEqual([[true]]);
    f.observer.observeVoice(voice("paused"));
    expect(setForegroundActive.mock.calls.at(-1)).toEqual([false]);
    const second = f.start();
    f.observer.observeVoice(voice("resuming"));
    f.observer.observeVoice(voice("interrupted"));
    f.observer.observeVoice(null);
    expect(setForegroundActive.mock.calls).toEqual([[true], [false], [true]]);
    f.writer.transition(second.id, "completed");
    expect(setForegroundActive.mock.calls.at(-1)).toEqual([false]);
    f.observer.observeVoice(voice("failed"));
    expect(setForegroundActive).toHaveBeenCalledTimes(4);
  });

  it("aborts real consolidation without partial revisions and resumes only after all execution is idle", async () => {
    const f = setupRunEvents({
      setForegroundActive: (active) => maintenance.setForegroundActive(active),
    });
    const repository = new MemoryRepository(f.database);
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let firstSignal: AbortSignal | undefined;
    const consolidate = vi.fn<MemoryConsolidationModel["consolidate"]>(
      (_input, _execution, signal) => {
        if (!firstSignal) {
          firstSignal = signal;
          signalEntered();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                const reason: unknown = signal.reason;
                reject(
                  reason instanceof Error
                    ? reason
                    : new Error("Foreground interruption"),
                );
              },
              {
                once: true,
              },
            );
          });
        }
        return Promise.resolve({
          disposition: "retain_originals",
          reason: "测试消费保留原始事实",
          dependencies: [],
          citations: [],
        });
      },
    );
    const memory = new MemoryService(
      repository,
      new LexicalRetrievalPipeline(f.database, repository, f.clock),
      f.ids,
      f.clock,
      {
        formation: formationRuntime({
          version: "foreground-integration",
          form: ({ episode }) =>
            Promise.resolve({
              entities: [],
              units: episode.sources.map((source) => ({
                operation: "create",
                content: source.content,
                type: "event",
                semantics: {
                  kind: "episode",
                  owner: "user",
                  basis: "explicit_user_statement",
                  qualifiers: {},
                },
                entityKeys: [],
                citations: [{ sourceId: source.id, quote: source.content }],
                links: [],
              })),
            }),
        }),
        consolidation: {
          version: "foreground-integration",
          bind: () =>
            Promise.resolve({
              version: "foreground-integration",
              measureInput: (input) =>
                Promise.resolve({
                  measurement: estimateInputBudget(input),
                  budget: 258000,
                }),
              consolidate,
            }),
        },
        formationResourceBudget,
        formationContextBudget: () => ({ maxTokens: 12000 }),
        embedding: {
          modelKey: "foreground-numeric-fixture",
          dimensions: 2,
          splitDocument: (text) => Promise.resolve([text]),
          embedDocuments: (texts) =>
            Promise.resolve(texts.map(() => new Float32Array([1, 0]))),
          embedQuery: () => Promise.resolve(new Float32Array([1, 0])),
        },
        vectorSearch: {
          search: ({ query, plan, modelKey, now, limit }) =>
            Promise.resolve(
              searchMemoryVectors(
                query,
                repository.recall.vectors(plan, modelKey, now),
                limit,
              ),
            ),
        },
        selector: {
          select: ({ plan, candidates }) =>
            Promise.resolve({
              selected: candidates.map(({ revisionId }) => ({
                revisionId,
                questionIds: plan.questions.map(({ id }) => id),
              })),
              coverage: plan.questions.map(({ id }) => ({
                questionId: id,
                status: "supported",
                revisionIds: candidates.map(({ revisionId }) => revisionId),
              })),
            }),
        },
      },
    );
    for (const content of [
      "我们周末一起整理阳台。",
      "下雨时先整理屋内，不搬室外的花盆。",
    ]) {
      const work = memory.enqueueEpisode(
        formationIntake({
          id: randomUUID(),
          version: "1",
          recordedAt: f.clock.now(),
          sources: [
            {
              id: randomUUID(),
              referenceId: randomUUID(),
              type: "chat",
              speaker: "user",
              content,
              occurredAt: f.clock.now(),
            },
          ],
        }),
      );
      await memory.formEpisode(work.workId);
    }
    await memory.indexPending();
    const before = f.database
      .prepare("SELECT * FROM memory_revisions ORDER BY id")
      .all();
    const onError = vi.fn();
    const maintenance = new MemoryMaintenance(memory, { onError });
    cleanups.push(() => maintenance.shutdown());
    maintenance.start();
    await entered;
    const first = f.start(),
      second = f.start();
    expect(firstSignal?.aborted).toBe(true);
    await maintenance.idle();
    expect([...repository.learning.pending()].length).toBeGreaterThan(0);
    expect(
      f.database.prepare("SELECT * FROM memory_revisions ORDER BY id").all(),
    ).toEqual(before);
    expect(consolidate).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    f.observer.observeVoice(voice("listening"));
    f.writer.transition(first.id, "completed");
    f.writer.transition(second.id, "completed");
    await maintenance.idle();
    expect(consolidate).toHaveBeenCalledOnce();
    f.observer.observeVoice(null);
    await maintenance.idle();
    expect(consolidate.mock.calls.length).toBeGreaterThan(1);
    expect([...repository.learning.pending()]).toEqual([]);
    expect(
      f.database.prepare("SELECT * FROM memory_revisions ORDER BY id").all(),
    ).toEqual(before);
    await maintenance.shutdown();
    const calls = consolidate.mock.calls.length;
    const afterClose = f.start();
    f.writer.transition(afterClose.id, "completed");
    expect(consolidate).toHaveBeenCalledTimes(calls);
  });
});
