import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { ProactiveOpportunityRepository } from "./proactiveOpportunityRepository";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("ProactiveOpportunityRepository", () => {
  it("creates one opportunity per revision and claims it once", () => {
    database = new Database(":memory:");
    database.exec(CURRENT_SCHEMA_SQL);
    database
      .prepare(
        "INSERT INTO chats (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        "Presentation",
        "2026-09-01T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
      );
    database.transaction(() => {
      database!
        .prepare(
          `INSERT INTO memories (
             id, type, status, current_revision_id, importance, confidence,
             created_at, updated_at
           ) VALUES (?, 'event', 'active', ?, 0.5, 1, ?, ?)`,
        )
        .run(
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
          "2026-09-01T00:00:00.000Z",
          "2026-09-01T00:00:00.000Z",
        );
      database!
        .prepare(
          `INSERT INTO memory_revisions (
             id, memory_id, content, occurs_at, time_zone, important_moment,
             source_type, reason, created_at
           ) VALUES (?, ?, ?, ?, ?, 1, 'chat', ?, ?)`,
        )
        .run(
          "33333333-3333-4333-8333-333333333333",
          "22222222-2222-4222-8222-222222222222",
          "明天下午三点做 presentation，有点紧张",
          "2026-09-02T07:00:00.000Z",
          "Asia/Shanghai",
          "用户明确说明",
          "2026-09-01T00:00:00.000Z",
        );
    })();
    const repository = new ProactiveOpportunityRepository(database);
    const input = {
      evaluateAt: "2026-09-02T06:30:00.000Z",
      id: "44444444-4444-4444-8444-444444444444",
      now: "2026-09-01T00:00:00.000Z",
      reason: "明确未来重要事件",
      sourceMemoryId: "22222222-2222-4222-8222-222222222222",
      sourceRevisionId: "33333333-3333-4333-8333-333333333333",
      targetChatId: "11111111-1111-4111-8111-111111111111",
    };

    expect(repository.insert(input).id).toBe(input.id);
    expect(
      repository.insert({
        ...input,
        id: "55555555-5555-4555-8555-555555555555",
      }).id,
    ).toBe(input.id);
    expect(repository.earliestPendingAt()).toBe(input.evaluateAt);
    expect(repository.claimNextDue("2026-09-02T06:29:59.999Z")).toBeUndefined();
    expect(repository.claimNextDue(input.evaluateAt)?.state).toBe("evaluating");
    expect(repository.claimNextDue(input.evaluateAt)).toBeUndefined();

    repository.cancelOpenForMemory(
      input.sourceMemoryId,
      "2026-09-01T00:01:00.000Z",
    );
    expect(
      repository.reopenCancelled(input.id, {
        evaluateAt: input.evaluateAt,
        now: "2026-09-01T00:02:00.000Z",
        reason: input.reason,
        targetChatId: input.targetChatId,
      }),
    ).toBe(true);
    expect(repository.get(input.id)).toMatchObject({ state: "pending" });
    expect(repository.get(input.id)).not.toHaveProperty("claimedAt");
    expect(repository.claimNextDue(input.evaluateAt)?.id).toBe(input.id);
  });
});
