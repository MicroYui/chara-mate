import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import {
  chatFixture,
  runFixture,
} from "../../../tests/fixtures/foundationContracts";
import { FakeClock } from "../../../tests/fixtures/fakeClock";
import type { JsonValue } from "../../shared/contracts/primitives";
import type { MemoryEvidenceReference } from "../../shared/contracts/memoryRecall";
import type { Run } from "../../shared/contracts/run";
import { CryptoIdGenerator } from "../../shared/pure/id";
import { ChatRepository } from "../chat/chatRepository";
import { openApplicationDatabase } from "../db/database";
import { RunRepository } from "./runRepository";
import { RunEventService } from "./runEventService";
import { RunEventWriter } from "./runEventWriter";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
function fixture(source: Run["source"] = "text") {
  const database = openApplicationDatabase(":memory:");
  databases.push(database);
  new ChatRepository(database).insertChat(chatFixture);
  const runs = new RunRepository(database);
  const clock = new FakeClock(runFixture.createdAt);
  const run = { ...runFixture, source };
  runs.appendEvent({
    event: { type: "run.started", run },
    streamId: run.id,
    sequence: 1,
    occurredAt: clock.now(),
  });
  const writer = new RunEventWriter(
    runs,
    new RunEventService(runs, { publish: () => undefined }),
    new CryptoIdGenerator(),
    clock,
  );
  const model = (
    refs: readonly MemoryEvidenceReference[],
    callIds: readonly string[],
    status: "completed" | "interrupted" = "completed",
  ) => {
    const item = writer.startItem(run.id, "assistant_message", {});
    return writer.completeItem(item.id, {
      status,
      output: { memoryReferences: [...refs], functionCallIds: [...callIds] },
    });
  };
  const tool = (callId: string, extra: Record<string, JsonValue> = {}) =>
    writer.startItem(run.id, "tool_call", {
      callId,
      toolName: "territory.propose_moment",
      arguments: {},
      ...extra,
    });
  return { database, runs, writer, model, tool, run, clock };
}
const memoryId = randomUUID(),
  revisionId = randomUUID();
const current: MemoryEvidenceReference = {
  memoryId,
  revisionId,
  use: "current",
};
const history: MemoryEvidenceReference = { ...current, use: "history" };

describe("Run request-bound Memory provenance", () => {
  it("binds siblings to the same model input, then uses only the next actual request snapshot", () => {
    const f = fixture();
    f.model([history], ["search", "moment"]);
    const search = f.tool("search");
    // A sibling search result is not evidence supplied to the model that already emitted both calls.
    f.writer.completeItem(search.id, {
      status: "completed",
      output: { memoryReferences: [current] },
    });
    const first = f.tool("moment");
    expect(f.runs.toolSuppliedMemoryReferences(f.run.id, first.id)).toEqual([
      history,
    ]);
    f.writer.completeItem(first.id, { status: "completed" });
    f.model([], ["after-compaction"]);
    const second = f.tool("after-compaction");
    expect(f.runs.toolSuppliedMemoryReferences(f.run.id, second.id)).toEqual(
      [],
    );
    // Appending later requests cannot change an earlier Tool's immutable binding.
    f.model([current], ["later"]);
    expect(f.runs.toolSuppliedMemoryReferences(f.run.id, first.id)).toEqual([
      history,
    ]);
  });

  it.each(["interrupted", "missing-stamp", "wrong-call"] as const)(
    "does not fall back past a latest %s model item",
    (failure) => {
      const f = fixture();
      f.model([current], ["wanted"]);
      if (failure === "missing-stamp") {
        const item = f.writer.startItem(f.run.id, "assistant_message", {});
        f.writer.completeItem(item.id, { status: "completed", output: {} });
      } else
        f.model(
          [history],
          failure === "wrong-call" ? ["other"] : ["wanted"],
          failure === "interrupted" ? "interrupted" : "completed",
        );
      const tool = f.tool("wanted");
      expect(
        f.runs.toolSuppliedMemoryReferences(f.run.id, tool.id),
      ).toBeUndefined();
      expect(
        f.runs.toolSuppliedMemoryReferences(randomUUID(), tool.id),
      ).toBeUndefined();
    },
  );

  it("uses the exact Voice Tool snapshot even if another response completed around it", () => {
    const f = fixture("voice");
    f.model([current], ["voice-call"]);
    const tool = f.tool("voice-call", { suppliedMemoryReferences: [history] });
    f.model([current], ["later"]);
    expect(f.runs.toolSuppliedMemoryReferences(f.run.id, tool.id)).toEqual([
      history,
    ]);
    const missing = f.tool("unattributed");
    expect(
      f.runs.toolSuppliedMemoryReferences(f.run.id, missing.id),
    ).toBeUndefined();
    const empty = f.tool("empty", { suppliedMemoryReferences: [] });
    expect(f.runs.toolSuppliedMemoryReferences(f.run.id, empty.id)).toEqual([]);
  });

  it("orders user turns by actual Run receipts, including same and older caller timestamps", () => {
    const f = fixture();
    const firstId = randomUUID(),
      secondId = randomUUID();
    const first = f.writer.startItem(f.run.id, "user_message", {
      messageId: firstId,
    });
    f.writer.completeItem(first.id, {
      status: "completed",
      output: { messageId: firstId },
    });
    f.model([], ["moment"]);
    const tool = f.tool("moment");
    f.clock.advance(-1000);
    const later = f.writer.startItem(f.run.id, "user_message", {
      messageId: secondId,
      steering: true,
    });
    f.writer.completeItem(later.id, {
      status: "completed",
      output: { messageId: secondId },
    });
    expect(f.runs.latestUserMessageId(f.run.id, tool.sequence)).toBe(firstId);
    expect(f.runs.latestUserMessageId(f.run.id)).toBe(secondId);
  });
});
