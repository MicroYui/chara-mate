import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CognitionAnalysis,
  CognitionEvidenceInput,
  CognitionSourceCoverage,
} from "../../shared/contracts/cognition";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";
import { selectAnalysisSnapshot } from "./cognitionProjection";
import { readEvidence, readEvidenceMetadata } from "./cognitionSnapshotReader";
import { CognitionService } from "./cognitionService";
import type { CognitionAnalysisInput } from "./cognitionTypes";
import {
  readSourceCatalogue,
  validateSourceReadPlan,
} from "./cognitionSourceCatalogue";

const now = "2026-09-16T08:00:00.000Z";
const databases: Database.Database[] = [];
const services: CognitionService[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  databases.splice(0).forEach((database) => database.close());
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    );
});
function fixture(path = ":memory:") {
  const database = new Database(path);
  databases.push(database);
  database.exec(CURRENT_SCHEMA_SQL);
  const personaId = randomUUID();
  database
    .prepare(
      "INSERT INTO personas (id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
    )
    .run(personaId, now, now);
  const repository = new CognitionRepository(database, {
    readBudgetBytes: 32_768,
  });
  const input = (
    text: string,
    extra: Partial<CognitionEvidenceInput> = {},
  ): CognitionEvidenceInput => {
    const id = randomUUID();
    return {
      id,
      personaId,
      actor: "user",
      source: { kind: "activity", id },
      kind: "observation",
      boundary: "content",
      observedAt: now,
      text,
      object: {
        key: "writer:letter",
        identity: "adapter",
        title: "给同事的草稿",
      },
      visibility: {
        status: "available",
        scope: "focused_element",
        source: "accessibility",
      },
      ...extra,
    };
  };
  const publish = (text: string, extra: Partial<CognitionEvidenceInput> = {}) =>
    repository.ingest(input(text, extra), now).evidence;
  const select = () => repository.readSnapshot(personaId, now, 32_768);
  function start() {
    const selection = select();
    const attempt = repository.createAttempt(
      selection,
      "semantic_change",
      now,
      selection.coverage.allocation,
      undefined,
      selection.coverage.sourceCoverage,
    );
    return repository.saveAttempt({ ...attempt, status: "analyzing" });
  }
  return { database, personaId, repository, input, publish, select, start };
}
function quiet(): CognitionAnalysis {
  return {
    delta: {
      createSituations: [],
      updateSituations: [],
      createIntents: [],
      updateIntents: [],
      attention: {},
    },
    decision: {
      choices: [
        {
          id: "quiet",
          kind: "remain_quiet",
          evidenceIds: [],
          rationale: "继续安静陪伴",
          userImpact: "none",
          executionScope: "none",
          reversibility: "read_only",
          timing: "now",
          resumeConditions: [],
        },
      ],
      selectedChoiceId: "quiet",
      selectedBasis: {
        choiceId: "quiet",
        evidenceUses: [],
        currentClaimRefs: [],
      },
      reason: "没有新的行动需求",
    },
  };
}
function plan(coverage: CognitionSourceCoverage, evidenceId: string) {
  return {
    requests: [
      {
        catalogueId: coverage.entries[0]!.id,
        evidenceId,
        question: "撤回的草稿说了什么，最终是否仍保留这个约定？",
      },
    ],
  };
}

describe("selective original-source reading", () => {
  it("retains the pending catalogue predecessor until its replacement boundary is reviewed", () => {
    const directory = mkdtempSync(join(tmpdir(), "cm-source-retain-page-"));
    directories.push(directory);
    const f = fixture(join(directory, "app.sqlite"));
    const previous = f.publish("临时约定不可提交。", {
      actor: "unknown",
      sourceEpoch: "editor-one",
    });
    const first = f.start();
    const committed = f.repository.commitAnalysis(first.id, quiet(), now);
    f.repository.saveAttempt({
      ...committed,
      status: "settled",
      outcome: "quiet",
    });
    f.publish("撤回上述约定，之后再安排。", {
      actor: "unknown",
      sourceEpoch: "editor-one",
    });
    // Actual maintenance entry must not release the only pending page boundary
    // before the next SnapshotReader has had a chance to expose its clue.
    expect(f.repository.releaseEvidenceBody(previous.id, now)).toBeUndefined();
    expect(
      f.repository.protectedCanonicalSources([
        { candidateId: previous.id, references: [previous.source] },
      ]),
    ).toEqual([{ candidateId: previous.id, reasons: ["decision"] }]);
    const second = f.start();
    expect(second.sourceCoverage!.entries[0]!.changes[0]!.evidenceId).toBe(
      previous.id,
    );
    const done = f.repository.commitAnalysis(second.id, quiet(), now);
    f.repository.saveAttempt({ ...done, status: "settled", outcome: "quiet" });
    expect(
      f.repository.protectedCanonicalSources([
        { candidateId: previous.id, references: [previous.source] },
      ]),
    ).toEqual([]);
    expect(f.repository.releaseEvidenceBody(previous.id, now)).toBeDefined();
    expect(f.repository.evidenceBodyStatus(f.personaId, previous.id)).toBe(
      "released",
    );
  });

  it("keeps the replaced passage at a successfully reviewed page boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "cm-source-page-"));
    directories.push(directory);
    const f = fixture(join(directory, "app.sqlite"));
    const previous = f.publish("明天十点不要提交，我还没有征得同意。", {
      actor: "unknown",
      sourceEpoch: "editor-one",
    });
    const first = f.start();
    const committed = f.repository.commitAnalysis(first.id, quiet(), now);
    f.repository.saveAttempt({
      ...committed,
      status: "settled",
      outcome: "quiet",
    });
    expect(
      f.repository.getAttention(f.personaId, now)
        .catalogueReviewedThroughSequence,
    ).toBe(previous.receiptSequence);
    expect(f.select().snapshot.situations).toHaveLength(0);
    const next = f.publish("之后再安排。", {
      actor: "unknown",
      sourceEpoch: "editor-one",
    });
    const selection = f.select();
    const coverage = selection.coverage.sourceCoverage!;
    expect(coverage.fromSequence).toBe(previous.receiptSequence);
    expect(coverage.eventCount).toBe(1);
    expect(coverage.entries[0]).toMatchObject({
      fromSequence: next.receiptSequence,
      throughSequence: next.receiptSequence,
      eventCount: 1,
      changes: [{ evidenceId: previous.id, replacedByEvidenceId: next.id }],
    });
    expect(coverage.entries[0]!.changes[0]!.excerpt).toContain("不要提交");
    expect(
      coverage.supplied.some(({ evidenceId }) => evidenceId === previous.id),
    ).toBe(false);
    expect(
      selection.snapshot.evidence.some(({ id }) => id === previous.id),
    ).toBe(false);
    expect(() =>
      validateSourceReadPlan(coverage, plan(coverage, previous.id)),
    ).not.toThrow();
  });

  it.each([
    ["actor", { actor: "agent" }],
    ["epoch", { sourceEpoch: "other-editor-epoch" }],
    ["object", { object: { key: "another-object", identity: "adapter" } }],
    [
      "scope",
      {
        visibility: {
          status: "available",
          scope: "viewport",
          source: "accessibility",
        },
      },
    ],
    [
      "unavailable",
      {
        visibility: {
          status: "unavailable",
          scope: "focused_element",
          source: "accessibility",
        },
      },
    ],
    ["missing text", {}],
  ] satisfies [string, Partial<CognitionEvidenceInput>][])(
    "does not compare a page predecessor across a different %s",
    (_label, change) => {
      const f = fixture();
      const previous = f.publish("原来可见的暂定安排。", {
        actor: "unknown",
        sourceEpoch: "editor-one",
      });
      const first = f.start();
      const committed = f.repository.commitAnalysis(first.id, quiet(), now);
      f.repository.saveAttempt({
        ...committed,
        status: "settled",
        outcome: "quiet",
      });
      const incoming = f.input("新的内容。", {
        actor: "unknown",
        sourceEpoch: "editor-one",
        ...change,
      });
      if (_label === "missing text") delete incoming.text;
      f.repository.ingest(incoming, now);
      const selection = f.select();
      expect(selection.coverage.sourceCoverage!.entries[0]!.changes).toEqual(
        [],
      );
      expect(
        selection.coverage.sourceCoverage!.entries[0]!.omittedChangeCount,
      ).toBe(0);
      expect(
        f.repository
          .protectedCanonicalSources([
            { candidateId: previous.id, references: [previous.source] },
          ])
          .flatMap(({ reasons }) => reasons),
      ).not.toContain("decision");
    },
  );

  it("counts an unexpanded boundary clue without inserting its predecessor into the reviewed range", () => {
    const f = fixture();
    const previous = f.publish(
      "很长的背景段落。".repeat(200) + "临时约定不可提交。",
    );
    const first = f.start();
    const committed = f.repository.commitAnalysis(first.id, quiet(), now);
    f.repository.saveAttempt({
      ...committed,
      status: "settled",
      outcome: "quiet",
    });
    const next = f.publish("很长的背景段落。".repeat(200) + "之后再安排。");
    const attention = f.repository.getAttention(f.personaId, now);
    const full = readSourceCatalogue(f.database, attention, 8_192);
    const onlyIdentity = structuredClone(full);
    onlyIdentity.entries[0]!.changes = [];
    onlyIdentity.entries[0]!.omittedChangeCount = 1;
    const maxBytes = Buffer.byteLength(JSON.stringify(onlyIdentity)) + 8;
    const small = readSourceCatalogue(f.database, attention, maxBytes);
    expect(small).toMatchObject({
      fromSequence: previous.receiptSequence,
      throughSequence: next.receiptSequence,
      eventCount: 1,
      unopenedCount: 1,
      omittedEventCount: 0,
      entries: [{ changes: [], omittedChangeCount: 1 }],
    });
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(
      maxBytes,
    );
  });

  it("compares only the immediately preceding receipt and does not search older matching objects", () => {
    const f = fixture();
    f.publish("旧窗口内容。");
    f.publish("另一个窗口内容。", {
      object: { key: "other-object", identity: "adapter" },
    });
    const first = f.start();
    const committed = f.repository.commitAnalysis(first.id, quiet(), now);
    f.repository.saveAttempt({
      ...committed,
      status: "settled",
      outcome: "quiet",
    });
    f.publish("旧窗口的新内容。");
    const next = f.select();
    expect(next.coverage.sourceCoverage!.entries[0]!.changes).toEqual([]);
  });

  it("keeps due work unconsumed while an actual source-read completion is pending", () => {
    const directory = mkdtempSync(join(tmpdir(), "cm-source-wake-"));
    directories.push(directory);
    const f = fixture(join(directory, "app.sqlite"));
    const old = f.publish("地图旁的小桌已有线索，稍后核对。");
    f.publish("另一段当前可见正文。");
    const intentId = randomUUID();
    f.repository.saveIntent({
      id: intentId,
      personaId: f.personaId,
      revision: 1,
      owner: "character",
      basis: "character",
      status: "active",
      goal: "继续探索住处",
      successCriteria: [],
      evidenceIds: [],
      effectEvidenceIds: [],
      blockers: [],
      resumeConditions: [],
      progress: "",
      nextWakeAt: now,
      createdAt: now,
      updatedAt: now,
    });
    f.repository.updateAttention(f.personaId, now, (state) => ({
      ...state,
      nextWakeAt: now,
    }));
    const attempt = f.start();
    const pending = f.repository.commitAnalysis(
      attempt.id,
      { ...quiet(), sourceReadPlan: plan(attempt.sourceCoverage!, old.id) },
      now,
    );
    expect(pending.status).toBe("awaiting_recall");
    expect(f.repository.getIntent(intentId)?.nextWakeAt).toBe(now);
    expect(f.repository.getAttention(f.personaId, now).nextWakeAt).toBe(now);
    const supplied = f.select();
    expect(supplied.snapshot.evidence.map(({ id }) => id)).toContain(old.id);
    const completion = f.repository.saveAttempt({
      ...pending,
      status: "analyzing",
      sourceCoverage: supplied.coverage.sourceCoverage!,
      dependencies: {
        ...pending.dependencies,
        evidenceIds: supplied.snapshot.evidence.map(({ id }) => id),
      },
    });
    f.repository.commitAnalysis(
      completion.id,
      quiet(),
      now,
      supplied.snapshot.evidence,
    );
    expect(f.repository.getIntent(intentId)?.nextWakeAt).toBeUndefined();
    expect(
      f.repository.getAttention(f.personaId, now).nextWakeAt,
    ).toBeUndefined();
  });

  it("keeps unidentified objects separate and preserves exact interaction counts under their actual actor", () => {
    const f = fixture();
    for (const text of ["无对象来源甲", "无对象来源乙"]) {
      const source = f.input(text);
      delete source.object;
      f.repository.ingest(source, now);
    }
    f.publish("可见材料", {
      actor: "unknown",
      interaction: { clicks: 1, keystrokes: 4, scrolls: 2 },
    });
    f.publish("可见材料补充", {
      actor: "unknown",
      interaction: { clicks: 2, keystrokes: 8, scrolls: 1 },
    });
    f.publish("可见材料补充", {
      actor: "user",
      interaction: { clicks: 1, keystrokes: 0, scrolls: 0 },
    });
    const read = f.select();
    expect(
      read.coverage.sourceCoverage?.entries.map(({ actor, eventCount }) => [
        actor,
        eventCount,
      ]),
    ).toEqual([
      ["user", 1],
      ["user", 1],
      ["unknown", 2],
      ["user", 1],
    ]);
    expect(read.coverage.sourceCoverage?.entries[2]?.interaction).toEqual({
      clicks: 3,
      keystrokes: 12,
      scrolls: 3,
    });
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(32_768);
  });

  it("a successfully consumed body prefix covers its identities, while reviewed unopened versions never become consumed bodies", () => {
    const f = fixture();
    const first = f.publish("用户亲口说的安排", { kind: "utterance" });
    const read = f.select();
    const attempt = f.repository.createAttempt(
      read,
      "semantic_change",
      now,
      read.coverage.allocation,
    );
    f.repository.saveAttempt({ ...attempt, status: "analyzing" });
    const committed = f.repository.commitAnalysis(attempt.id, quiet(), now);
    f.repository.saveAttempt({
      ...committed,
      status: "settled",
      outcome: "quiet",
    });
    expect(
      f.repository.getAttention(f.personaId, now)
        .catalogueReviewedThroughSequence,
    ).toBe(first.receiptSequence);
    f.publish("同一个对象的中间版本");
    f.publish("同一个对象的最终版本");
    const next = f.start();
    const done = f.repository.commitAnalysis(next.id, quiet(), now);
    f.repository.saveAttempt({ ...done, status: "settled", outcome: "quiet" });
    expect(f.repository.getAttention(f.personaId, now)).toMatchObject({
      analyzedThroughSequence: first.receiptSequence,
      catalogueReviewedThroughSequence: 3,
    });
  });

  it("reviews one append sequence without claiming body exposure or rescheduling every version", () => {
    const f = fixture();
    const ids = Array.from(
      { length: 100 },
      (_, index) => f.publish("正文" + "字".repeat(index)).id,
    );
    const attempt = f.start();
    expect(attempt.sourceCoverage?.entries).toHaveLength(1);
    expect(attempt.sourceCoverage?.eventCount).toBe(100);
    expect(attempt.sourceCoverage?.unopenedCount).toBe(99);
    expect(attempt.dependencies.receivedThroughSequence).toBe(100);
    expect(attempt.throughSequence).toBe(0);
    expect(attempt.dependencies.evidenceIds).toEqual([ids.at(-1)]);
    const committed = f.repository.commitAnalysis(attempt.id, quiet(), now);
    expect(f.repository.actionFreshness(committed, now)).toEqual({
      current: true,
    });
    const attention = f.repository.getAttention(f.personaId, now);
    expect(attention.catalogueReviewedThroughSequence).toBe(100);
    expect(attention.analyzedThroughSequence).toBe(0);
    expect(f.repository.hasReviewableInput(f.personaId)).toBe(false);
    expect(f.repository.hasUnanalyzedMeaning(f.personaId)).toBe(true);
    expect(
      (
        f.database
          .prepare("SELECT count(*) AS n FROM cognition_evidence")
          .get() as { n: number }
      ).n,
    ).toBe(100);
  });

  it("finds a removed passage late in a long original without using a beginning-only excerpt", () => {
    const f = fixture();
    const prefix = "背景材料。".repeat(4_000);
    f.publish(prefix);
    const removed = f.publish(prefix + "明天十点不要提交，我还没有征得同意。");
    f.publish(prefix + "之后再安排。");
    const selection = f.select();
    const catalogue = selection.coverage.sourceCoverage!;
    expect(catalogue.entries[0]?.changes[0]?.excerpt).toContain("不要提交");
    expect(catalogue.entries[0]?.changes[0]?.startCharacter).toBeGreaterThan(
      10_000,
    );
    expect(
      selection.snapshot.evidence.some(({ id }) => id === removed.id),
    ).toBe(false);
    expect(() =>
      validateSourceReadPlan(catalogue, plan(catalogue, removed.id)),
    ).not.toThrow();
    expect(() =>
      validateSourceReadPlan(catalogue, plan(catalogue, randomUUID())),
    ).toThrow(/listed/);
  });

  it("rebuilds transient directory literals from protected originals after a crash before model completion", () => {
    const directory = mkdtempSync(join(tmpdir(), "cognition-source-reopen-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const f = fixture(path);
    const old = f.publish("本来打算邀请苏晴，但还没有确认她是否方便。");
    f.publish("邀请先留空，等本人确认。");
    const attempt = f.start();
    expect(attempt.sourceCoverage?.entries[0]?.changes[0]?.excerpt).toContain(
      "苏晴",
    );
    const stored = f.repository.getAttempt(attempt.id)!;
    expect(stored.status).toBe("analyzing");
    expect(stored.sourceCoverage?.entries[0]?.changes[0]).not.toHaveProperty(
      "excerpt",
    );
    expect(stored.sourceCoverage?.entries[0]?.changes[0]?.evidenceId).toBe(
      old.id,
    );
    expect(f.repository.releaseEvidenceBody(old.id, now)).toBeUndefined();
    expect(
      f.repository.protectedCanonicalSources([
        { candidateId: old.id, references: [old.source] },
      ])[0]?.reasons,
    ).toContain("unanalysed");
    f.database.close();
    databases.splice(databases.indexOf(f.database), 1);
    const reopened = new Database(path);
    databases.push(reopened);
    const repository = new CognitionRepository(reopened, {
      readBudgetBytes: 32_768,
    });
    const previous = repository.getAttempt(attempt.id)!;
    // Same interrupted-attempt transition as Service.initialize; no success was committed.
    repository.saveAttempt({
      ...previous,
      status: "superseded",
      outcome: "interrupted",
    });
    expect(repository.hasReviewableInput(f.personaId)).toBe(true);
    expect(
      repository.getAttention(f.personaId, now)
        .catalogueReviewedThroughSequence,
    ).toBe(0);
    const fresh = repository.readSnapshot(f.personaId, now);
    expect(
      fresh.coverage.sourceCoverage?.entries[0]?.changes[0]?.excerpt,
    ).toContain("苏晴");
    expect(fresh.coverage.sourceCoverage?.readPlan).toBeUndefined();
    expect(readEvidence(reopened, old.id, 32_768)?.evidence.text).toBe(
      old.text,
    );
    expect(repository.releaseEvidenceBody(old.id, now)).toBeUndefined();
  });

  it("recovers an explicitly selected Unicode tail without pretending that its unseen head was read", () => {
    const directory = mkdtempSync(join(tmpdir(), "cognition-tail-reopen-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const f = fixture(path);
    const prefix = "🙂中文材料".repeat(4_000);
    f.publish(prefix);
    const old = f.publish(prefix + "先不要邀请苏晴；她还没有确认是否方便。🪴");
    f.publish(prefix + "暂时留空。");
    const attempt = f.start();
    const change = attempt.sourceCoverage!.entries[0]!.changes.find(
      (item) => item.evidenceId === old.id,
    )!;
    expect(change.excerpt).toContain("不要邀请苏晴");
    expect(change.startCharacter).toBeGreaterThan(10_000);
    const requested = plan(attempt.sourceCoverage!, old.id);
    const tailPlan = {
      requests: [
        { ...requested.requests[0]!, startCharacter: change.startCharacter },
      ],
    };
    expect(() =>
      validateSourceReadPlan(attempt.sourceCoverage, {
        requests: [
          {
            ...tailPlan.requests[0]!,
            startCharacter: change.startCharacter + 1,
          },
        ],
      }),
    ).toThrow(/position/);
    const head = readEvidence(f.database, old.id, 2_048)!;
    expect(head.evidence.text).not.toContain("不要邀请苏晴");
    const tail = readEvidence(
      f.database,
      old.id,
      2_048,
      change.startCharacter,
    )!;
    expect(tail.evidence.text).toContain("不要邀请苏晴");
    expect(tail.excerpted).toBe(true);
    expect(tail.textRange?.totalCharacters).toBe(Array.from(old.text!).length);
    expect(tail.textRange?.startCharacter).toBe(change.startCharacter);
    const realSlice = Array.from(old.text!)
      .slice(tail.textRange!.startCharacter, tail.textRange!.endCharacter)
      .join("");
    expect(
      tail.evidence.text?.startsWith(realSlice + "\n[INCOMPLETE EXCERPT:"),
    ).toBe(true);
    expect(tail.evidence.text).not.toContain("\ud83d\n");
    const pending = f.repository.commitAnalysis(
      attempt.id,
      { ...quiet(), sourceReadPlan: tailPlan },
      now,
    );
    f.repository.saveAttempt({
      ...pending,
      status: "superseded",
      outcome: "interrupted",
    });
    expect(f.repository.releaseEvidenceBody(old.id, now)).toBeUndefined();
    f.database.close();
    databases.splice(databases.indexOf(f.database), 1);
    const reopened = new Database(path);
    databases.push(reopened);
    const repository = new CognitionRepository(reopened, {
      readBudgetBytes: 32_768,
    });
    const recovered = repository.readSnapshot(f.personaId, now);
    expect(
      recovered.coverage.sourceCoverage?.readPlan?.requests[0]?.startCharacter,
    ).toBe(change.startCharacter);
    expect(
      recovered.snapshot.evidence.find((item) => item.id === old.id)?.text,
    ).toContain("不要邀请苏晴");
    expect(
      recovered.coverage.sourceCoverage?.readResults?.find(
        (item) => item.evidenceId === old.id,
      ),
    ).toEqual({
      evidenceId: old.id,
      status: "excerpted",
      textRange: tail.textRange,
    });
    expect(
      repository.getAttention(f.personaId, now)
        .catalogueReviewedThroughSequence,
    ).toBe(0);
  });

  it("shortens an actual Unicode text range when the completion projection has less space", () => {
    const f = fixture();
    const prefix = "🙂背景".repeat(4_000);
    f.publish(prefix);
    const old = f.publish(
      prefix + "先确认是否方便。" + "🪴后续材料".repeat(5_000),
    );
    f.publish(prefix + "暂时留空。");
    const attempt = f.start();
    const position = attempt.sourceCoverage!.entries[0]!.changes.find(
      (change) => change.evidenceId === old.id,
    )!.startCharacter;
    const request = plan(attempt.sourceCoverage!, old.id);
    f.repository.commitAnalysis(
      attempt.id,
      {
        ...quiet(),
        sourceReadPlan: {
          requests: [{ ...request.requests[0]!, startCharacter: position }],
        },
      },
      now,
    );
    const expanded = f.select();
    const actual = expanded.snapshot.evidence.find(
      (item) => item.id === old.id,
    )!;
    const supplied = expanded.coverage.sourceCoverage!.supplied.find(
      (item) => item.evidenceId === old.id,
    )!;
    const selected = selectAnalysisSnapshot(
      {
        ...expanded.snapshot,
        evidence: [actual],
        situations: [],
        intents: [],
        recentAttempts: [],
      },
      8192,
      {
        ...expanded.coverage,
        sourceCoverage: {
          ...expanded.coverage.sourceCoverage!,
          entries: [],
          supplied: [supplied],
        },
      },
    );
    const range = selected.coverage.sourceCoverage!.supplied[0]!.textRange!;
    expect(range.startCharacter).toBe(position);
    expect(range.endCharacter).toBeLessThan(supplied.textRange!.endCharacter);
    const exact = Array.from(old.text!)
      .slice(range.startCharacter, range.endCharacter)
      .join("");
    expect(
      selected.snapshot.evidence[0]!.text?.startsWith(
        exact + "\n[INCOMPLETE EXCERPT:",
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(
      8192,
    );
  });

  it("reports a requested source omitted when the current user consumes the actual body budget", () => {
    const f = fixture();
    const old = f.publish("稍后再邀请苏晴，需要先确认。");
    f.publish("暂时留空。");
    const attempt = f.start();
    f.repository.commitAnalysis(
      attempt.id,
      { ...quiet(), sourceReadPlan: plan(attempt.sourceCoverage!, old.id) },
      now,
    );
    const currentMessage = f.input("这是当前真实用户消息。".repeat(20_000), {
      kind: "utterance",
      source: { kind: "message", id: randomUUID() },
    });
    delete currentMessage.boundary;
    delete currentMessage.object;
    delete currentMessage.visibility;
    f.repository.ingest(currentMessage, now);
    const recovered = f.select();
    expect(Buffer.byteLength(JSON.stringify(recovered))).toBeLessThanOrEqual(
      32_768,
    );
    expect(recovered.snapshot.evidence.some((item) => item.id === old.id)).toBe(
      false,
    );
    expect(recovered.coverage.sourceCoverage?.readResults).toContainEqual({
      evidenceId: old.id,
      status: "omitted",
    });
    expect(readEvidence(f.database, old.id, 1)).toBeUndefined();
    expect(f.repository.releaseEvidenceBody(old.id, now)).toBeUndefined();
  });

  it("does not let a catalogue reference ground a new claim", () => {
    const f = fixture();
    const old = f.publish("下个月一起去看展。");
    f.publish("改成暂时留空。");
    const attempt = f.start();
    const output = quiet();
    output.delta.createSituations.push({
      localId: "new:plan",
      value: {
        title: "看展",
        summary: "未来安排",
        status: "current",
        objectRefs: [],
        episodes: [],
        claims: [
          {
            id: "date",
            text: "已有看展约定",
            basis: "observed",
            state: "supported",
            evidenceIds: [old.id],
            contradictingEvidenceIds: [],
          },
        ],
        unresolved: [],
        relatedSituationIds: [],
      },
    });
    expect(() =>
      f.repository.commitAnalysis(attempt.id, output, now),
    ).toThrow();
    expect(
      f.repository.getAttention(f.personaId, now)
        .catalogueReviewedThroughSequence,
    ).toBe(0);
  });

  it("persists a concrete read plan without advancing, then recovers its real body after restart", () => {
    const f = fixture();
    const old = f.publish("可能周末去看展，还没决定。");
    f.publish("这个周末先不约了。");
    const attempt = f.start();
    const pending = f.repository.commitAnalysis(
      attempt.id,
      { ...quiet(), sourceReadPlan: plan(attempt.sourceCoverage!, old.id) },
      now,
    );
    expect(pending.status).toBe("awaiting_recall");
    expect(
      f.repository.getAttention(f.personaId, now)
        .catalogueReviewedThroughSequence,
    ).toBe(0);
    f.repository.saveAttempt({
      ...pending,
      status: "superseded",
      outcome: "interrupted",
    });
    const restarted = new CognitionRepository(f.database, {
      readBudgetBytes: 32_768,
    });
    const recovered = restarted.readSnapshot(f.personaId, now);
    expect(recovered.coverage.sourceCoverage?.recoveredFromAttemptId).toBe(
      attempt.id,
    );
    expect(
      recovered.coverage.sourceCoverage?.readPlan?.requests[0]?.question,
    ).toContain("撤回");
    expect(
      recovered.snapshot.evidence.find(({ id }) => id === old.id)?.text,
    ).toBe(old.text);
    expect(recovered.coverage.sourceCoverage?.readResults).toContainEqual({
      evidenceId: old.id,
      status: "complete",
      textRange: {
        startCharacter: 0,
        endCharacter: Array.from(old.text!).length,
        totalCharacters: Array.from(old.text!).length,
      },
    });
    const next = f.start();
    f.repository.commitAnalysis(next.id, quiet(), now);
    expect(
      f.repository.getAttention(f.personaId, now)
        .catalogueReviewedThroughSequence,
    ).toBe(2);
  });

  it("releases the PFC consumer after review while keeping a still-active claim source", () => {
    const f = fixture();
    const old = f.publish("早期草稿。");
    const current = f.publish("保留这个事实。");
    const attempt = f.start();
    const output = quiet();
    output.delta.createSituations.push({
      localId: "new:fact",
      value: {
        title: "实际页面",
        summary: "文字当前可见",
        status: "current",
        objectRefs: [],
        episodes: [],
        claims: [
          {
            id: "visible",
            text: current.text!,
            basis: "observed",
            state: "supported",
            evidenceIds: [current.id],
            contradictingEvidenceIds: [],
          },
        ],
        unresolved: [],
        relatedSituationIds: [],
      },
    });
    const committed = f.repository.commitAnalysis(attempt.id, output, now);
    f.repository.saveAttempt({
      ...committed,
      status: "settled",
      outcome: "quiet",
    });
    const candidates = [old, current].map((e) => ({
      candidateId: e.id,
      references: [e.source],
    }));
    const uses = f.repository.protectedCanonicalSources(candidates);
    expect(
      uses.find(({ candidateId }) => candidateId === old.id),
    ).toBeUndefined();
    expect(
      uses.find(({ candidateId }) => candidateId === current.id)?.reasons,
    ).toContain("claim");
  });

  it("keeps the current physical view, then only its pending replacement comparison until review", () => {
    const f = fixture();
    const view = f.publish("尚未变化的实际前台正文。");
    const attempt = f.start();
    const committed = f.repository.commitAnalysis(attempt.id, quiet(), now);
    f.repository.saveAttempt({
      ...committed,
      status: "settled",
      outcome: "quiet",
    });
    const original = { candidateId: view.id, references: [view.source] };
    expect(
      f.repository.protectedCanonicalSources([original])[0]?.reasons,
    ).toContain("current_view");
    f.publish("同一对象的真实新版本。");
    expect(f.repository.protectedCanonicalSources([original])).toEqual([
      { candidateId: view.id, reasons: ["decision"] },
    ]);
    const next = f.start();
    const reviewed = f.repository.commitAnalysis(next.id, quiet(), now);
    f.repository.saveAttempt({
      ...reviewed,
      status: "settled",
      outcome: "quiet",
    });
    expect(f.repository.protectedCanonicalSources([original])).toEqual([]);
  });

  it("retires only an unreferenced reviewed body, preserving its receipt and explicit absence", () => {
    const f = fixture();
    const old = f.publish("重复的中间草稿。".repeat(200));
    f.publish("目前真实可见的末稿。");
    expect(f.repository.releaseEvidenceBody(old.id, now)).toBeUndefined();
    const attempt = f.start();
    const committed = f.repository.commitAnalysis(attempt.id, quiet(), now);
    f.repository.saveAttempt({
      ...committed,
      status: "settled",
      outcome: "quiet",
    });
    expect(f.repository.nextReclaimableEvidenceBody(0)?.id).toBe(old.id);
    const released = f.repository.releaseEvidenceBody(old.id, now)!;
    expect(released.payloadBytesBefore).toBeGreaterThan(
      released.payloadBytesAfter,
    );
    expect(readEvidence(f.database, old.id, 32_768)).toBeUndefined();
    const metadata = readEvidenceMetadata(f.database, old.id)!;
    expect(metadata.bodyReleasedAt).toBe(now);
    expect(metadata.source).toEqual(old.source);
    expect(metadata.receiptSequence).toBe(old.receiptSequence);
    expect(f.repository.evidenceBodyStatus(f.personaId, old.id)).toBe(
      "released",
    );
    expect(
      f.repository.actionMaterialSources(f.personaId, [old.id]).sources,
    ).toEqual([{ evidenceId: old.id, resolution: "unavailable" }]);
    expect(f.repository.releaseEvidenceBody(old.id, now)).toBeUndefined();
  });

  it.each(["failed", "superseded"] as const)(
    "retains a %s pending read after catalogue review, then releases each stale qualification",
    (status) => {
      for (const changed of ["generation", "review", "completion"] as const) {
        const f = fixture();
        const old = f.publish("这段旧原文仍是未完成读取的请求对象。");
        // A distinct next object prevents the page-boundary predecessor from
        // independently retaining old; only the pending read may protect it.
        f.publish("当前另一个对象。", {
          object: { key: "other-window", identity: "adapter" },
        });
        const attempt = f.start();
        const pending = f.repository.commitAnalysis(
          attempt.id,
          { ...quiet(), sourceReadPlan: plan(attempt.sourceCoverage!, old.id) },
          now,
        );
        f.repository.saveAttempt({
          ...pending,
          status,
          error: "The source read was interrupted before completion.",
        });
        // Exact host prestate: a reviewed prefix, with a wider outstanding plan.
        // It does not manufacture supplied body content or complete that plan.
        f.repository.updateAttention(f.personaId, now, (state) => ({
          ...state,
          catalogueReviewedThroughSequence: old.receiptSequence,
        }));
        const candidate = { candidateId: old.id, references: [old.source] };
        expect(f.repository.protectedCanonicalSources([candidate])).toEqual([
          { candidateId: old.id, reasons: ["decision"] },
        ]);
        expect(f.repository.releaseEvidenceBody(old.id, now)).toBeUndefined();
        if (changed === "generation") {
          f.repository.ingest(
            {
              id: randomUUID(),
              personaId: f.personaId,
              actor: "user",
              kind: "control",
              control: "user_correction",
              source: { kind: "system", id: randomUUID() },
              observedAt: now,
            },
            now,
          );
        } else if (changed === "review") {
          f.repository.updateAttention(f.personaId, now, (state) => ({
            ...state,
            catalogueReviewedThroughSequence:
              pending.sourceCoverage!.throughSequence,
          }));
        } else {
          f.repository.saveAttempt({
            ...f.repository.getAttempt(pending.id)!,
            sourceCoverage: {
              ...pending.sourceCoverage!,
              completionPending: false,
            },
          });
        }
        expect(f.repository.protectedCanonicalSources([candidate])).toEqual([]);
        expect(f.repository.releaseEvidenceBody(old.id, now)).toBeDefined();
      }
    },
  );

  it("does not retire a pending source plan even when the caller attempts a direct release", () => {
    const f = fixture();
    const old = f.publish("暂时的疑问需要回看。");
    f.publish("当前新稿。");
    const attempt = f.start();
    f.repository.commitAnalysis(
      attempt.id,
      { ...quiet(), sourceReadPlan: plan(attempt.sourceCoverage!, old.id) },
      now,
    );
    expect(f.repository.releaseEvidenceBody(old.id, now)).toBeUndefined();
    expect(readEvidence(f.database, old.id, 32_768)?.evidence.text).toBe(
      old.text,
    );
  });

  it("reports catalogue overflow rather than silently marking unlisted objects as reviewed", () => {
    const f = fixture();
    for (let index = 0; index < 30; index += 1)
      f.publish(`第 ${index} 个对象`, {
        object: { key: `object:${index}`, identity: "adapter" },
      });
    const catalogue = readSourceCatalogue(
      f.database,
      f.repository.getAttention(f.personaId, now),
      2_048,
    );
    expect(catalogue.omittedEventCount).toBeGreaterThan(0);
    expect(catalogue.eventCount + catalogue.omittedEventCount).toBe(30);
    expect(catalogue.throughSequence).toBeLessThan(30);
  });

  it("does not let a departed long window consume the current-view allocation", () => {
    const f = fixture();
    const old = f.publish("旧窗口长文".repeat(20000), {
      boundary: "window",
      object: { key: "old", identity: "adapter", title: "已经离开的页面" },
    });
    const current = f.publish("当前屏幕只显示这一段", {
      boundary: "window",
      object: { key: "new", identity: "adapter", title: "正在显示的页面" },
    });
    const selected = f.select();
    expect(selected.coverage.currentViewEvidenceId).toBe(current.id);
    expect(
      selected.snapshot.evidence.find((item) => item.id === current.id)?.text,
    ).toBe(current.text);
    expect(
      selected.coverage.sourceCoverage?.entries.find(
        (entry) => entry.firstEvidenceId === old.id,
      )?.requiresBody,
    ).toBe(false);
  });

  it("keeps a same-object edit sequence together across content and keyboard boundaries", () => {
    const f = fixture();
    for (let index = 0; index < 20; index += 1)
      f.publish("正在写" + "字".repeat(index), {
        boundary: index % 2 ? "interaction" : "content",
        ...(index % 2
          ? { interaction: { clicks: 0, keystrokes: 1, scrolls: 0 } }
          : {}),
      });
    const catalogue = readSourceCatalogue(
      f.database,
      f.repository.getAttention(f.personaId, now),
      8192,
    );
    expect(catalogue.entries).toHaveLength(1);
    expect(catalogue.eventCount).toBe(20);
  });

  it("shares disappeared-passage clues without allowing the first long source to hide later changes", () => {
    const f = fixture();
    for (let index = 0; index < 8; index += 1)
      f.publish(
        "共同前言".repeat(2000) +
          `版本${index}的具体安排` +
          "后文".repeat(2000),
      );
    const catalogue = readSourceCatalogue(
      f.database,
      f.repository.getAttention(f.personaId, now),
      8192,
    );
    expect(Buffer.byteLength(JSON.stringify(catalogue))).toBeLessThanOrEqual(
      8192,
    );
    expect(catalogue.entries[0]?.changes).toHaveLength(7);
    expect(catalogue.entries[0]?.changes.at(-1)?.excerpt).toContain(
      "版本6的具体安排",
    );
  });

  it("runs a real Service information-completion phase without calling Memory for a local source request", async () => {
    const f = fixture();
    const prefix = "🙂背景材料".repeat(4_000);
    f.publish(prefix);
    const old = f.publish(prefix + "这个约定需要先问朋友。");
    f.publish(prefix + "暂不作约定。");
    const inputs: CognitionAnalysisInput[] = [];
    const memory = {
      validateEvidenceReferences: () => [],
      resolveEvidence: () => ({
        status: "resolved" as const,
        items: [],
        readCost: { rawValueBytes: 0, rowCount: 0 },
      }),
      recall: vi.fn(() =>
        Promise.resolve({
          items: [],
          coverage: [],
          gaps: [],
          estimatedTokens: 0,
          truncated: false,
          incompleteReasons: [],
        }),
      ),
    };
    const errors: unknown[] = [];
    const service = new CognitionService({
      repository: f.repository,
      driver: {
        analyze: (input) => {
          inputs.push(structuredClone(input));
          return Promise.resolve(
            inputs.length === 1
              ? {
                  ...quiet(),
                  sourceReadPlan: {
                    requests: [
                      {
                        ...plan(input.attempt.sourceCoverage!, old.id)
                          .requests[0]!,
                        startCharacter:
                          input.attempt.sourceCoverage!.entries[0]!.changes.find(
                            (change) => change.evidenceId === old.id,
                          )!.startCharacter,
                      },
                    ],
                  },
                }
              : quiet(),
          );
        },
      },
      memory,
      runtime: {
        availability: () => ({
          characterTools: [],
          userEngaged: false,
          activeUserRunIds: [],
          chatRuns: [],
          activeVoice: false,
          sleeping: false,
          hasOutstandingBubble: false,
          mayInitiateConversation: true,
          mayActInTerritory: true,
        }),
        dispatch: () => Promise.reject(Error("quiet should not dispatch")),
        yieldCharacterRun: async () => {},
        reconcileRun: () => ({ terminal: false, evidence: [] }),
      },
      clock: { now: () => now },
      activePersonaId: () => f.personaId,
      analysisReadBudgetBytes: 32_768,
      analysisBudgetTokens: 8_192,
      batchWindowMs: 0,
      onError: (error) => errors.push(error),
    });
    services.push(service);
    service.initialize();
    await service.runDue(now);
    expect(errors).toEqual([]);
    expect(inputs).toHaveLength(2);
    expect(
      inputs[0]!.coverage?.sourceCoverage?.entries[0]?.changes[0]?.excerpt,
    ).toContain("问朋友");
    expect(
      f.repository.getAttempt(inputs[0]!.attempt.id)?.sourceCoverage?.entries[0]
        ?.changes[0],
    ).not.toHaveProperty("excerpt");
    expect(
      inputs[1]!.snapshot.evidence.find(({ id }) => id === old.id)?.text,
    ).toContain("这个约定需要先问朋友。");
    expect(inputs[1]!.attempt.dependencies.evidenceIds).toContain(old.id);
    expect(inputs[1]!.attempt.sourceCoverage?.readResults).toContainEqual({
      evidenceId: old.id,
      status: "excerpted",
      textRange: {
        startCharacter:
          inputs[0]!.attempt.sourceCoverage!.entries[0]!.changes.find(
            (change) => change.evidenceId === old.id,
          )!.startCharacter,
        endCharacter: Array.from(old.text!).length,
        totalCharacters: Array.from(old.text!).length,
      },
    });
    expect(memory.recall).not.toHaveBeenCalled();
    expect(
      f.repository.getAttention(f.personaId, now)
        .catalogueReviewedThroughSequence,
    ).toBe(3);
    expect(f.repository.hasReviewableInput(f.personaId)).toBe(false);
  });
});
