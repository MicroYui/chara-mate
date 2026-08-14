import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RunRepository } from "../../src/main/agent/runRepository";
import { ChatRepository } from "../../src/main/chat/chatRepository";
import { ChatService } from "../../src/main/chat/chatService";
import { openApplicationDatabase } from "../../src/main/db/database";
import { JourneyRepository } from "../../src/main/journey/journeyRepository";
import { JourneyService } from "../../src/main/journey/journeyService";
import type { Run } from "../../src/shared/contracts/run";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";
import {
  automationDefinitionFixture,
  AUTOMATION_FIXTURE_IDS,
} from "../fixtures/automations";
import {
  FIXTURE_IDS,
  providerSnapshotFixture,
} from "../fixtures/foundationContracts";

const roots: string[] = [];
const NOW = "2026-08-13T09:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function harness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "charamate-journey-"));
  roots.push(root);
  const database = openApplicationDatabase(path.join(root, "app.sqlite"));
  const ids = new CryptoIdGenerator();
  const clock = new FakeClock(NOW);
  const chatRepository = new ChatRepository(database);
  const runRepository = new RunRepository(database);
  const chats = new ChatService(chatRepository, runRepository, ids, clock);
  const repository = new JourneyRepository(database);
  const runById = new Map<string, Run>();
  const published: unknown[] = [];
  const service = new JourneyService(
    repository,
    chats,
    { getRun: (runId) => runById.get(runId) },
    ids,
    clock,
    { publish: (snapshot) => published.push(snapshot) },
  );
  return {
    chats,
    clock,
    database,
    published,
    repository,
    runById,
    service,
  };
}

function sourceRun(chatId: string): Run {
  return {
    chatId,
    createdAt: NOW,
    endedAt: NOW,
    execution: { mode: "chat" },
    id: FIXTURE_IDS.run,
    latestSequence: 2,
    provider: providerSnapshotFixture,
    source: "text",
    startedAt: NOW,
    status: "completed",
  };
}

describe("Journey persistence and lifecycle", () => {
  it("attaches the current unfinished Session when a confirmed Journey grows from it", () => {
    const { chats, database, service } = harness();
    const home = chats.create({ title: "论文随聊" });
    const session = service.startSession({
      chatId: home.id,
      title: "一起梳理研究问题",
    });

    const journey = service.createJourney({
      homeChatId: home.id,
      purpose: "完成未来几个月的毕业论文",
      sessionId: session.id,
      title: "毕业论文",
    });

    expect(service.getSnapshot().activeSession).toMatchObject({
      chatId: home.id,
      id: session.id,
      journeyId: journey.id,
    });
    expect(service.getDetail({ journeyId: journey.id }).sessions).toEqual([
      expect.objectContaining({ id: session.id, journeyId: journey.id }),
    ]);
    database.close();
  });

  it("refuses to attach an ended Session or a Session from another Chat", () => {
    const { chats, database, service } = harness();
    const firstChat = chats.create({ title: "论文随聊" });
    const secondChat = chats.create({ title: "另一段对话" });
    const session = service.startSession({
      chatId: firstChat.id,
      title: "一起梳理研究问题",
    });

    expect(() =>
      service.createJourney({
        homeChatId: secondChat.id,
        purpose: "完成未来几个月的毕业论文",
        sessionId: session.id,
        title: "毕业论文",
      }),
    ).toThrow("当前对话里尚未结束");

    service.setSessionStatus({ sessionId: session.id, status: "ended" });
    expect(() =>
      service.createJourney({
        homeChatId: firstChat.id,
        purpose: "完成未来几个月的毕业论文",
        sessionId: session.id,
        title: "毕业论文",
      }),
    ).toThrow("当前对话里尚未结束");
    database.close();
  });

  it("keeps exactly one active Together Session and pauses the previous one", () => {
    const { chats, clock, database, service } = harness();
    const firstChat = chats.create({ title: "论文" });
    const secondChat = chats.create({ title: "电影" });
    const firstJourney = service.createJourney({
      homeChatId: firstChat.id,
      purpose: "完成毕业论文",
      title: "毕业论文",
    });
    const secondJourney = service.createJourney({
      homeChatId: secondChat.id,
      purpose: "一起看完电影系列",
      title: "电影共赏",
    });
    const firstSession = service.startSession({
      chatId: firstChat.id,
      journeyId: firstJourney.id,
      title: "整理研究问题",
    });

    clock.advance(60_000);
    const secondSession = service.startSession({
      chatId: secondChat.id,
      journeyId: secondJourney.id,
      title: "看第一部电影",
    });
    let snapshot = service.getSnapshot();
    expect(snapshot.activeSession?.id).toBe(secondSession.id);
    expect(
      snapshot.sessions.find(({ id }) => id === firstSession.id),
    ).toMatchObject({ status: "paused" });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM together_sessions WHERE status = 'active'",
        )
        .get(),
    ).toEqual({ count: 1 });

    clock.advance(60_000);
    snapshot = service.setSessionStatus({
      sessionId: firstSession.id,
      status: "active",
    });
    expect(snapshot.activeSession?.id).toBe(firstSession.id);
    expect(
      snapshot.sessions.find(({ id }) => id === secondSession.id),
    ).toMatchObject({ status: "paused" });
    database.close();
  });

  it("marks the exact current Chat for Agent semantic routing without exposing Chat IDs", () => {
    const { chats, database, service } = harness();
    const thesisChat = chats.create({ title: "论文" });
    const movieChat = chats.create({ title: "电影" });
    const thesis = service.createJourney({
      homeChatId: thesisChat.id,
      purpose: "完成毕业论文",
      title: "毕业论文",
    });
    const movie = service.createJourney({
      homeChatId: movieChat.id,
      purpose: "一起看完电影系列",
      title: "电影共赏",
    });
    service.startSession({
      chatId: thesisChat.id,
      journeyId: thesis.id,
      title: "修改论文引言",
    });
    service.startSession({
      chatId: movieChat.id,
      journeyId: movie.id,
      title: "看第一部电影",
    });

    const context = service.agentContextInstructions(movieChat.id);

    expect(context).toContain('"homeForCurrentChat":true');
    expect(context).toContain('"homeForCurrentChat":false');
    expect(context).toContain('"belongsToCurrentChat":true');
    expect(context).toContain('"belongsToCurrentChat":false');
    expect(context).not.toContain(movieChat.id);
    expect(context).not.toContain(thesisChat.id);
    database.close();
  });

  it("removes internal continuity with its ordinary Chat instead of blocking Chat deletion", () => {
    const { chats, database, service } = harness();
    const home = chats.create({ title: "准备求职" });
    const journey = service.createJourney({
      homeChatId: home.id,
      purpose: "找到下一份工作",
      title: "准备下一份工作",
    });
    service.startSession({
      chatId: home.id,
      journeyId: journey.id,
      title: "修改简历",
    });

    expect(chats.delete({ chatId: home.id })).toEqual({ chatId: home.id });
    expect(service.getSnapshot()).toEqual({ journeys: [], sessions: [] });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("turns a recovered active Session into paused without pretending completion", () => {
    const { chats, clock, database, repository, service } = harness();
    const home = chats.create({ title: "求职" });
    const journey = service.createJourney({
      homeChatId: home.id,
      purpose: "找到下一份工作",
      title: "求职同行",
    });
    const session = service.startSession({
      chatId: home.id,
      journeyId: journey.id,
      title: "修改简历",
    });
    clock.advance(60_000);

    const recovered = new JourneyService(
      repository,
      chats,
      { getRun: () => undefined },
      new CryptoIdGenerator(),
      clock,
      { publish: () => undefined },
    );
    recovered.initialize();

    const [recoveredSession] = recovered.getSnapshot().sessions;
    expect(recoveredSession).toMatchObject({
      id: session.id,
      pausedAt: clock.now(),
      status: "paused",
    });
    expect(recoveredSession?.resumeNote).toContain("上次停下");
    expect(
      recovered.getDetail({ journeyId: journey.id }).sessions[0],
    ).not.toHaveProperty("endedAt");
    database.close();
  });

  it("completes all unfinished Sessions, records closure, and does not revive them on reopen", () => {
    const { chats, clock, database, service } = harness();
    const home = chats.create({ title: "考试" });
    const journey = service.createJourney({
      homeChatId: home.id,
      purpose: "准备资格考试",
      title: "考试准备",
    });
    const first = service.startSession({
      chatId: home.id,
      journeyId: journey.id,
      title: "梳理考试范围",
    });
    service.setSessionStatus({
      resumeNote: "下次从第二章继续",
      sessionId: first.id,
      status: "paused",
    });
    const second = service.startSession({
      chatId: home.id,
      journeyId: journey.id,
      title: "复习第二章",
    });
    clock.advance(60_000);

    service.setJourneyStatus({
      closure: "我们一起走完了这段备考。",
      journeyId: journey.id,
      status: "completed",
    });
    let detail = service.getDetail({ journeyId: journey.id });
    expect(detail.journey).toMatchObject({
      completedAt: clock.now(),
      status: "completed",
    });
    expect(detail.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, status: "ended" }),
        expect.objectContaining({ id: second.id, status: "ended" }),
      ]),
    );
    expect(detail.moments.at(-1)).toMatchObject({
      content: "我们一起走完了这段备考。",
      kind: "closure",
    });

    service.setJourneyStatus({ journeyId: journey.id, status: "active" });
    detail = service.getDetail({ journeyId: journey.id });
    expect(detail.journey.status).toBe("active");
    expect(detail.sessions.every(({ status }) => status === "ended")).toBe(
      true,
    );
    expect(service.getSnapshot().activeSession).toBeUndefined();
    expect(detail.moments.at(-1)?.kind).toBe("reopened");
    database.close();
  });

  it("links one shared Memory to the active Journey and projects an agreed follow-up bubble", () => {
    const { chats, database, runById, service } = harness();
    const home = chats.create({ title: "论文" });
    const journey = service.createJourney({
      homeChatId: home.id,
      purpose: "完成毕业论文",
      title: "毕业论文",
    });
    const session = service.startSession({
      chatId: home.id,
      journeyId: journey.id,
      title: "确定研究问题",
    });
    const run = sourceRun(home.id);
    runById.set(run.id, run);
    service.linkMemoryForRun(
      run.id,
      "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "论文的研究问题已经收窄。",
    );
    service.linkMemoryForRun(
      run.id,
      "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "论文的研究问题已经收窄。",
    );
    expect(
      service
        .getDetail({ journeyId: journey.id })
        .moments.filter(({ kind }) => kind === "memory"),
    ).toEqual([
      expect.objectContaining({
        content: "论文的研究问题已经收窄。",
        memoryId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sessionId: session.id,
      }),
    ]);

    const schedule = vi.fn(() => AUTOMATION_FIXTURE_IDS.automation);
    const cancel = vi.fn();
    service.setFollowUpScheduler({ cancel, schedule });
    const followUp = service.scheduleFollowUp({
      journeyId: journey.id,
      message: "明晚想问问研究问题整理得怎么样。",
      runAt: "2026-08-14T12:00:00.000Z",
      sourceRunId: run.id,
    });
    expect(followUp).toMatchObject({
      automationId: AUTOMATION_FIXTURE_IDS.automation,
      status: "scheduled",
    });
    expect(schedule).toHaveBeenCalledTimes(1);

    const bubble = service.observeAutomation({
      automationId: AUTOMATION_FIXTURE_IDS.automation,
      automationRevision: 1,
      automationRunId: AUTOMATION_FIXTURE_IDS.run,
      chatId: home.id,
      definition: automationDefinitionFixture,
      runId: run.id,
      status: "completed",
      summary: "研究问题整理得怎么样了？",
      type: "automation.run.finished",
    });
    expect(bubble).toMatchObject({
      chatId: home.id,
      content: "研究问题整理得怎么样了？",
      id: run.id,
      journeyId: journey.id,
    });
    expect(
      service.getDetail({ journeyId: journey.id }).journey.followUp?.status,
    ).toBe("sent");
    database.close();
  });

  it("cancels the one scheduled follow-up when a Journey is completed", () => {
    const { chats, database, runById, service } = harness();
    const home = chats.create({ title: "论文" });
    const journey = service.createJourney({
      homeChatId: home.id,
      purpose: "完成毕业论文",
      title: "毕业论文",
    });
    const run = sourceRun(home.id);
    runById.set(run.id, run);
    const cancel = vi.fn();
    service.setFollowUpScheduler({
      cancel,
      schedule: () => AUTOMATION_FIXTURE_IDS.automation,
    });
    service.scheduleFollowUp({
      journeyId: journey.id,
      message: "明晚聊聊论文。",
      runAt: "2026-08-14T12:00:00.000Z",
      sourceRunId: run.id,
    });

    service.setJourneyStatus({
      journeyId: journey.id,
      status: "completed",
    });

    expect(cancel).toHaveBeenCalledWith(AUTOMATION_FIXTURE_IDS.automation);
    expect(
      service.getDetail({ journeyId: journey.id }).journey.followUp,
    ).toMatchObject({ status: "cancelled" });
    expect(() =>
      service.scheduleFollowUp({
        journeyId: journey.id,
        message: "再问一次。",
        runAt: "2026-08-15T12:00:00.000Z",
        sourceRunId: run.id,
      }),
    ).toThrow("不能再安排跟进");
    database.close();
  });
});
