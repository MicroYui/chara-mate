import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../tests/fixtures/fakeClock";
import type {
  ActivityEvent,
  ActivityEventDetails,
} from "../../shared/contracts/activity";
import type { ToolResult } from "../../shared/contracts/tool";
import type { ToolExecutionContext } from "../tools/toolRegistry";
import { openApplicationDatabase } from "../db/database";
import { MemoryRepository } from "../memory/memoryRepository";
import { MemoryService } from "../memory/memoryService";
import { ToolRegistry } from "../tools/toolRegistry";
import { ActivityAssetStore } from "./activityAssetStore";
import { ActivityRepository } from "./activityRepository";
import { ActivityService } from "./activityService";
import { registerActivityTool } from "./activityTool";
import type {
  ActivityObserveInput,
  ActivityTextObservation,
} from "./activityObservation";
import { visualSurfaceFixture } from "./activityVisual.fixture";

const NOW = "2026-03-08T03:00:00.000Z";
const OLD = "2026-03-08T02:01:09.000Z";
const NEW = "2026-03-08T02:05:00.000Z";
let serial = 0;
const ids = {
  generate: () =>
    `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "activity-text-"));
  const database = openApplicationDatabase(path.join(root, "app.sqlite"));
  const repository = new ActivityRepository(database);
  const clock = new FakeClock(NOW);
  repository.initialize(NOW);
  const service = new ActivityService(
    repository,
    new MemoryService(
      new MemoryRepository(database),
      { search: () => [] },
      ids,
      clock,
    ),
    new ActivityAssetStore(path.join(root, "assets")),
    ids,
    clock,
    "UTC",
  );
  const registry = new ToolRegistry();
  registerActivityTool(registry, service);
  cleanups.push(() => {
    if (database.open) database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const add = (
    text: string,
    startedAt = OLD,
    overrides: Partial<ActivityEventDetails & { source: "active_app" }> = {},
    actor: ActivityEvent["actor"] = "unknown",
  ) => {
    const event: ActivityEvent = {
      id: ids.generate(),
      actor,
      startedAt,
      endedAt: startedAt,
      details: {
        source: "active_app",
        appName: "Safari",
        windowTitle: "夜灯工作坊｜周末安排",
        contentStatus: "available",
        content: { source: "accessibility", scope: "viewport", text },
        ...overrides,
      },
    };
    repository.insertEvent(event, NOW);
    return event;
  };
  const read = async (
    request: ActivityObserveInput,
    options: Partial<ToolExecutionContext> = {},
  ) => {
    const measured: ToolResult[] = [];
    const result = await registry.execute("activity.observe", request, {
      itemId: "item",
      runId: "run",
      onDelta: () => undefined,
      signal: new AbortController().signal,
      measureResult: (candidate) => {
        measured.push(structuredClone(candidate));
        return Promise.resolve({
          kind: "responses_request",
          inputBudgetTokens: 258000,
          measurement: {
            exactInputTokens: JSON.stringify(candidate).length,
            estimatedTokens: 0,
            wireBytes: Buffer.byteLength(JSON.stringify(candidate)),
            unknownKinds: [],
          },
        });
      },
      ...options,
    });
    return {
      result,
      observation: result.modelContent as ActivityTextObservation,
      measured,
    };
  };
  return { root, database, repository, service, registry, clock, add, read };
}

describe("Activity retained text observation", () => {
  it("reads the newer retained workshop text directly before any PFC or Memory formation", async () => {
    const f = fixture();
    // Original retained observations from the closed throughput story (a069/a205).
    // Only SQLite receivedAt is a fixture time; actor, source text and event identity are unchanged.
    const observations: ActivityEvent[] = [
      {
        id: "9f605215-78e9-4b3b-acd0-8da26fe0822f",
        actor: "unknown",
        startedAt: "2026-03-08T02:01:09.000Z",
        endedAt: "2026-03-08T02:01:09.000Z",
        details: {
          source: "active_app",
          appName: "Safari",
          windowTitle: "夜灯工作坊｜周末安排",
          boundary: "content",
          surface: {
            id: "workshop-booking",
            epoch: "mock-desktop-1",
            displayId: "mock-display",
            windowId: "workshop-booking",
            processId: 42,
            appName: "Safari",
            windowTitle: "夜灯工作坊｜周末安排",
            bounds: {
              x: 0,
              y: 0,
              width: 1280,
              height: 800,
            },
            scaleFactor: 1,
            clipped: false,
          },
          contentStatus: "available",
          content: {
            source: "accessibility",
            scope: "viewport",
            text: "木岸手作空间，周六下午三点，二楼小教室。当天正门电梯检修，预约参加者可从院内侧门走坡道到教室。费用含灯罩，店内播放轻音乐。预约说明\n本次手作记录准备从材料、摆放方式和活动经过三个方面整理。先列出已有东西，再记录还没有确定的部分。\n正文还在编辑，括号里的句子是备选说法。页面边缘有目录和上一页的链接，当前窗口只显示其中一段。\n今天把标题改得短了一点，也删去几处重复的描述。剩下的文字还需要读一遍，暂时没有发送给别人。\n照片说明按从左到右的顺序排列，第一张是桌面，第二张是入口，第三张是结束后收起来的物品。\n名单中的条目采用原来的编号，显示顺序不代表优先程度。空白位置之后再补，不先填猜测的信息。\n附记：页内色块只是排版占位；是否采用这种设计尚未决定。修改会保留当前稿与上次稿的区别。\n本次手作记录准备从材料、摆放方式和活动经过三个方面整理。先列出已有东西，再记录还没有确定的部分。\n正文还在编辑，括号里的句子是备选说法。页面边缘有目录和上一页的链接，当前窗口只显示其中一段。\n今天把标题改得短了一点，也删去几处重复的描述。剩下的文字还需要读一遍，暂时没有发送给别人。\n照片说明按从左到右的顺序排列，第一张是桌面，第二张是入口，第三张是结束后收起来的物品。\n名单中的条目采用原来的编号，显示顺序不代表优先程度。空白位置之后再补，不先填猜测的信息。\n附记：页内色块只是排版占位；是否采用这种设计尚未决定。修改会保留当前稿与上次稿的区别。\n本次手作记录准备从材料、摆放方式和活动经过三个方面整理。先列出已有东西，再记录还没有确定的部分。\n正文还在编辑，括号里的句子是备选说法。页面边缘有目录和上一页的链接，当前窗口只显示其中一段。\n今天把标题改得短了一点，也删去几处重复的描述。剩下的文字还需要读一遍，暂时没有发送给别人。\n照片说明按从左到右的顺序排列，第一张是桌面，第二张是入口，第三张是结束后收起来的物品。\n名单中的条目采用原来的编号，显示顺序不代表优先程度。空白位置之后再补，不先填猜测的信息。\n附记：页内色块只是排版占位；是否采用这种设计尚未",
          },
        },
      },
      {
        id: "e3cb431d-5547-4e39-add8-0f44a47e74b3",
        actor: "unknown",
        startedAt: "2026-03-08T02:03:25.000Z",
        endedAt: "2026-03-08T02:03:25.000Z",
        details: {
          source: "active_app",
          appName: "Safari",
          windowTitle: "夜灯工作坊｜周末安排",
          boundary: "content",
          surface: {
            id: "workshop-booking",
            epoch: "mock-desktop-1",
            displayId: "mock-display",
            windowId: "workshop-booking",
            processId: 42,
            appName: "Safari",
            windowTitle: "夜灯工作坊｜周末安排",
            bounds: {
              x: 0,
              y: 0,
              width: 1280,
              height: 800,
            },
            scaleFactor: 1,
            clipped: false,
          },
          contentStatus: "available",
          content: {
            source: "accessibility",
            scope: "viewport",
            text: "场次更新：原周六下午三点的夜灯课改为周六四点半，地点仍是木岸二楼小教室。预约说明更新完成，活动未开始。课程页面\n本次手作记录准备从材料、摆放方式和活动经过三个方面整理。先列出已有东西，再记录还没有确定的部分。\n正文还在编辑，括号里的句子是备选说法。页面边缘有目录和上一页的链接，当前窗口只显示其中一段。\n今天把标题改得短了一点，也删去几处重复的描述。剩下的文字还需要读一遍，暂时没有发送给别人。\n照片说明按从左到右的顺序排列，第一张是桌面，第二张是入口，第三张是结束后收起来的物品。\n名单中的条目采用原来的编号，显示顺序不代表优先程度。空白位置之后再补，不先填猜测的信息。\n附记：页内色块只是排版占位；是否采用这种设计尚未决定。修改会保留当前稿与上次稿的区别。\n本次手作记录准备从材料、摆放方式和活动经过三个方面整理。先列出已有东西，再记录还没有确定的部分。\n正文还在编辑，括号里的句子是备选说法。页面边缘有目录和上一页的链接，当前窗口只显示其中一段。\n今天把标题改得短了一点，也删去几处重复的描述。剩下的文字还需要读一遍，暂时没有发送给别人。\n照片说明按从左到右的顺序排列，第一张是桌面，第二张是入口，第三张是结束后收起来的物品。\n名单中的条目采用原来的编号，显示顺序不代表优先程度。空白位置之后再补，不先填猜测的信息。\n附记：页内色块只是排版占位；是否采用这种设计尚未",
          },
        },
      },
    ];
    for (const event of observations) f.repository.insertEvent(event, NOW);
    const latest = observations[1]!;
    const { observation, measured, result } = await f.read({
      latest: { query: "夜灯工作坊" },
    });
    expect(observation).toMatchObject({
      retainedOnly: true,
      liveScreen: false,
      status: "available",
      observation: {
        eventId: latest.id,
        actor: "unknown",
        observedAt: latest.startedAt,
        receivedAt: NOW,
      },
      content: {
        text:
          latest.details.source === "active_app"
            ? latest.details.content!.text
            : "",
        scope: "viewport",
        captureTruncated: "unknown",
        coverage: { storedTextComplete: true },
      },
    });
    expect(measured.at(-1)).toEqual(result);
    expect(
      f.database.prepare("SELECT COUNT(*) AS n FROM cognition_evidence").get(),
    ).toEqual({ n: 0 });
    expect(
      f.database.prepare("SELECT COUNT(*) AS n FROM activity_episodes").get(),
    ).toEqual({ n: 0 });
    expect(
      (await f.read({ latest: { query: "四点半" } })).observation.status,
    ).toBe("missing");
  });

  it.each(["unavailable", "protected"] as const)(
    "keeps a newer %s observation instead of falling back to old available text",
    async (status) => {
      const f = fixture();
      const old = f.add("旧页面正文", OLD);
      const newest = f.add("must not be exposed", NEW, {
        contentStatus: status,
      });
      const current = (await f.read({ latest: { query: "Safari" } }))
        .observation;
      expect(current).toMatchObject({
        status,
        reference: { eventId: newest.id },
      });
      expect(current.content).toBeUndefined();
      const previous = (
        await f.read({
          latest: {
            query: "Safari",
            before: { startedAt: NEW, eventId: newest.id },
          },
        })
      ).observation;
      expect(previous.reference?.eventId).toBe(old.id);
      expect(previous.content?.text).toBe("旧页面正文");
    },
  );

  it("uses literal location, surface epoch, inclusive time and time/id order", async () => {
    const f = fixture();
    f.add("body needle", OLD, { windowTitle: "other" });
    const first = f.add("first", NEW, {
      windowTitle: "100%_surface",
      surface: visualSurfaceFixture,
    });
    const second = f.add("second", NEW, {
      windowTitle: "100%_surface",
      surface: visualSurfaceFixture,
    });
    f.add("other epoch", NEW, {
      windowTitle: "100%_surface",
      surface: { ...visualSurfaceFixture, epoch: "other" },
    });
    const request = {
      latest: {
        query: "100%_",
        periodStart: NEW,
        periodEnd: NEW,
        surface: {
          id: visualSurfaceFixture.id,
          epoch: visualSurfaceFixture.epoch,
        },
      },
    };
    expect((await f.read(request)).observation.reference?.eventId).toBe(
      second.id,
    );
    expect(
      (
        await f.read({
          latest: {
            ...request.latest,
            before: { startedAt: NEW, eventId: second.id },
          },
        })
      ).observation.reference?.eventId,
    ).toBe(first.id);
    expect(
      (await f.read({ latest: { query: "body needle" } })).observation.status,
    ).toBe("missing");
    await expect(
      f.read({ latest: { periodStart: NOW, periodEnd: OLD } }),
    ).rejects.toThrow("start must not follow");
  });

  it("reads retained DOM while paused without changing actor, capture scope or the original timestamp", async () => {
    const f = fixture();
    const event: ActivityEvent = {
      id: ids.generate(),
      actor: "agent",
      startedAt: OLD,
      endedAt: OLD,
      details: {
        source: "managed_browser",
        url: "https://example.test/schedule",
        domain: "example.test",
        title: "Schedule",
        contentStatus: "available",
        content: {
          source: "dom",
          scope: "focused_element",
          text: "retained DOM",
          truncated: true,
        },
      },
    };
    f.repository.insertEvent(event, NOW);
    f.service.setPaused(true);
    expect(
      (await f.read({ latest: { query: "example.test/schedule" } }))
        .observation,
    ).toMatchObject({
      paused: true,
      liveScreen: false,
      observation: {
        eventId: event.id,
        source: "managed_browser",
        actor: "agent",
        observedAt: OLD,
        receivedAt: NOW,
      },
      content: {
        source: "dom",
        scope: "focused_element",
        captureTruncated: "reported",
        text: "retained DOM",
      },
    });
    expect(f.service.isPaused()).toBe(true);
  });

  it("fits complete Tool results and reads every grapheme exactly once through fixed-event continuation", async () => {
    const f = fixture();
    const text = "页首🙂👩🏽‍💻家庭👨‍👩‍👧‍👦".repeat(150);
    const original = f.add(text);
    const signal = new AbortController().signal;
    const budget = 2700;
    const envelopeSize = (result: ToolResult) =>
      JSON.stringify({
        instructions: "current context ".repeat(60),
        input: [
          {
            type: "function_call_output",
            call_id: "actual-call",
            output: JSON.stringify(result),
          },
        ],
      }).length;
    const measured: ToolResult[] = [];
    let request: ActivityObserveInput = { latest: {} };
    let joined = "";
    let pages = 0;
    do {
      const { result, observation } = await f.read(request, {
        signal,
        measureResult: (candidate) => {
          measured.push(structuredClone(candidate));
          if (measured.length === 1)
            f.add("newer event must not replace the selected body", NEW);
          const size = envelopeSize(candidate);
          return Promise.resolve({
            kind: "responses_request",
            inputBudgetTokens: budget,
            measurement: {
              exactInputTokens: size,
              estimatedTokens: size,
              wireBytes: size,
              unknownKinds: [],
            },
          });
        },
      });
      expect(observation.reference?.eventId).toBe(original.id);
      expect(envelopeSize(result)).toBeLessThanOrEqual(budget);
      expect(measured.at(-1)).toEqual(result);
      expect(observation.content!.coverage.start).toBe(joined.length);
      const content = observation.content!;
      const segments = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      }).segment(text);
      expect(
        content.coverage.end === text.length ||
          segments.containing(content.coverage.end)?.index ===
            content.coverage.end,
      ).toBe(true);
      joined += content.text;
      pages++;
      if (!observation.next) break;
      expect(observation.next.offset).toBeGreaterThan(content.coverage.start);
      request = { reference: observation.next };
    } while (joined.length < text.length);
    expect(pages).toBeGreaterThan(1);
    expect(joined).toBe(text);
    await expect(
      f.read({ reference: { eventId: original.id, offset: 3 } }),
    ).rejects.toThrow("character boundary");
  });

  it("reports an input limit without a non-progressing next reference when no body fits", async () => {
    const f = fixture();
    f.add("🙂");
    const { observation } = await f.read(
      { latest: {} },
      {
        measureResult: (candidate) => {
          const hasBody = Boolean(
            (candidate.modelContent as ActivityTextObservation).content,
          );
          return Promise.resolve({
            kind: "realtime_submission",
            inputBudgetTokens: 100,
            conversationOccupancy: "unknown",
            capacityBasis: "user_limit_only",
            measurement: {
              exactInputTokens: hasBody ? 101 : 10,
              estimatedTokens: 0,
              wireBytes: 0,
              unknownKinds: [],
            },
          });
        },
      },
    );
    expect(observation.status).toBe("input_limit");
    expect(observation.next).toBeUndefined();
    expect(observation.content).toBeUndefined();
  });

  it("reports the latest oversized raw source without reading its body or falling back", async () => {
    const f = fixture();
    f.add("older");
    const large = f.add("x".repeat(16 * 1024 * 1024), NEW);
    const getEvent = vi.spyOn(f.repository, "getEvent");
    const { observation } = await f.read({ latest: {} });
    expect(observation).toMatchObject({
      status: "resource_limit",
      reference: { eventId: large.id },
    });
    expect(observation.content).toBeUndefined();
    expect(getEvent).not.toHaveBeenCalled();
  });

  it.each(["cleanup", "change"] as const)(
    "discards the selected text after %s during the real asynchronous result measure",
    async (mutation) => {
      const f = fixture();
      const event = f.add("selected original");
      f.service.setSourceRetentionGuard(() => new Set());
      f.clock.advance(86_400_000);
      f.service.distill();
      const gate = latch();
      let calls = 0;
      const reading = f.read(
        { reference: { eventId: event.id } },
        {
          measureResult: async (candidate) => {
            if (++calls === 1) await gate.promise;
            return {
              kind: "responses_request",
              inputBudgetTokens: 258000,
              measurement: {
                exactInputTokens: JSON.stringify(candidate).length,
                estimatedTokens: 0,
                wireBytes: 0,
                unknownKinds: [],
              },
            };
          },
        },
      );
      expect(f.database.inTransaction).toBe(false);
      if (mutation === "cleanup") {
        await f.service.cleanup(true);
        f.add(
          "a new observation cannot replace the cleaned reference",
          f.clock.now(),
        );
      } else
        f.database
          .prepare(
            "UPDATE activity_events SET details_json=json_set(details_json,'$.content.text',?) WHERE id=?",
          )
          .run("replacement", event.id);
      gate.resolve();
      const { observation } = await reading;
      expect(observation).toMatchObject({
        status: mutation === "cleanup" ? "missing" : "source_changed",
        reference: { eventId: event.id },
      });
      expect(observation.content).toBeUndefined();
      if (mutation === "cleanup")
        expect(
          (await f.read({ reference: { eventId: event.id } })).observation
            .status,
        ).toBe("missing");
    },
  );

  it("prioritizes cancellation before reads and after pending measurement, without holding the database open", async () => {
    const f = fixture();
    f.add("original");
    const before = new AbortController();
    before.abort();
    const query = vi.spyOn(f.database, "prepare");
    await expect(
      f.read({ latest: {} }, { signal: before.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
    const controller = new AbortController();
    const gate = latch();
    const reading = f.read(
      { latest: {} },
      {
        signal: controller.signal,
        measureResult: async () => {
          await gate.promise;
          return {
            kind: "responses_request",
            inputBudgetTokens: 258000,
            measurement: {
              exactInputTokens: 1,
              estimatedTokens: 1,
              wireBytes: 1,
              unknownKinds: [],
            },
          };
        },
      },
    );
    expect(f.database.inTransaction).toBe(false);
    controller.abort();
    f.database.close();
    gate.resolve();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });

  it("requires exactly one locator and the real complete-result measurement owner", async () => {
    const f = fixture();
    expect(() => f.registry.validateInput("activity.observe", {})).toThrow(
      "Invalid arguments",
    );
    await expect(
      f.registry.execute(
        "activity.observe",
        { latest: {}, reference: { eventId: ids.generate() } },
        {
          itemId: "i",
          runId: "r",
          signal: new AbortController().signal,
          onDelta: () => undefined,
        },
      ),
    ).rejects.toThrow("Invalid arguments");
    await expect(
      f.registry.execute(
        "activity.observe",
        { latest: {} },
        {
          itemId: "i",
          runId: "r",
          signal: new AbortController().signal,
          onDelta: () => undefined,
        },
      ),
    ).rejects.toThrow("measurement owner");
  });
});
