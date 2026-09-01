import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CompanionInitiativeRepository } from "./companionInitiativeRepository";

const records = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("CompanionInitiativeRepository", () => {
  it("keeps only the latest three records and preserves a replied outcome", () => {
    database = new Database(":memory:");
    database.exec(CURRENT_SCHEMA_SQL);
    const repository = new CompanionInitiativeRepository(database);

    for (const [index, id] of records.entries()) {
      const acceptedAt = `2026-08-28T09:0${index}:00.000Z`;
      repository.recordAccepted({
        acceptedAt,
        appName: "Text Editor",
        grounding: `Window ${index} is visible.`,
        id,
        kind: "invitation",
        message: `第 ${index + 1} 次主动消息`,
        sourceKind: "activity",
        windowTitle: `document-${index}.md`,
      });
    }

    expect(repository.listRecent().map(({ id }) => id)).toEqual([
      records[3],
      records[2],
      records[1],
    ]);
    expect(
      repository.updateOutcome(
        records[3]!,
        "replied",
        "2026-08-28T09:04:00.000Z",
      ),
    ).toBe(true);
    repository.updateOutcome(
      records[3]!,
      "interrupted",
      "2026-08-28T09:05:00.000Z",
    );
    expect(repository.listRecent()[0]).toMatchObject({
      id: records[3],
      outcome: "replied",
      updatedAt: "2026-08-28T09:05:00.000Z",
    });
    expect(
      repository.updateOutcome(
        records[0]!,
        "expired",
        "2026-08-28T09:05:00.000Z",
      ),
    ).toBe(false);
  });
});
