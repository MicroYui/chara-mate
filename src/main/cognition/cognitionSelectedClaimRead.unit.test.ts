import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import {
  CognitionMaterialResourceError,
  readSelectedActionMaterial,
} from "./cognitionActionContext";
import { CognitionRepository } from "./cognitionRepository";
import type {
  CognitionAnalysis,
  CognitionClaim,
  CognitionDecisionAttempt,
  CognitionPreparedContext,
} from "./cognitionTypes";

const now = "2026-09-17T12:00:00.000Z";
const databases: Database.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((database) => database.close());
});

function fixture(claimCount = 16) {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(CURRENT_SCHEMA_SQL);
  const personaId = randomUUID();
  database
    .prepare(
      "INSERT INTO personas (id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
    )
    .run(personaId, now, now);
  const repository = new CognitionRepository(database, {
    readBudgetBytes: 64 * 1024,
  });
  const evidence = [0, 1].map((index) => {
    const id = randomUUID();
    return repository.ingest(
      {
        id,
        personaId,
        actor: "unknown",
        source: { kind: "activity", id },
        observedAt: now,
        kind: "observation",
        boundary: "content",
        object: {
          key: `document-${index}`,
          identity: "adapter",
          appName: "Editor",
        },
        visibility: {
          status: "available",
          source: "accessibility",
          scope: "focused_element",
        },
        text: `材料 ${index} 含各编号的例外与取消条件。`,
      },
      now,
    ).evidence;
  });
  const situations: CognitionAnalysis["delta"]["createSituations"] =
    evidence.map((source, index) => ({
      localId: `new:situation-${index}`,
      value: {
        status: "current",
        title: `材料 ${index}`,
        summary: "只记录可见材料",
        objectRefs: [],
        episodes: [],
        unresolved: [],
        relatedSituationIds: [],
        claims: [
          ...Array.from(
            { length: claimCount },
            (_, claimIndex): CognitionClaim => ({
              id: `claim-${claimIndex}`,
              text: `材料 ${index} 编号 ${claimIndex}：周五可取；下雨则取消。引文包含“引号”、\\路径与 🐱。`,
              basis: "observed",
              state: "supported",
              evidenceIds: [source.id],
              contradictingEvidenceIds: [],
            }),
          ),
          {
            id: "unselected",
            text: `未选的完整条款 ${index}。`.repeat(1024),
            basis: "observed",
            state: "supported",
            evidenceIds: [source.id],
            contradictingEvidenceIds: [],
          },
        ],
      },
    }));
  // Deliberately interleave situations and reverse claim order. Claim IDs repeat
  // across situations, so a join on claimId alone cannot satisfy this fixture.
  const currentClaimRefs = Array.from({ length: claimCount }, (_, ordinal) =>
    situations
      .slice()
      .reverse()
      .map(({ localId }) => ({
        situationId: localId,
        claimId: `claim-${claimCount - ordinal - 1}`,
      })),
  ).flat();
  const output: CognitionAnalysis = {
    delta: {
      createSituations: situations,
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
          evidenceIds: evidence.map(({ id }) => id),
          rationale: "保存实际供给的材料",
          userImpact: "none",
          executionScope: "none",
          reversibility: "read_only",
          timing: "now",
          resumeConditions: [],
        },
      ],
      selectedChoiceId: "quiet",
      reason: "读取边界的机械回归",
      selectedBasis: {
        choiceId: "quiet",
        currentClaimRefs,
        evidenceUses: evidence.map(({ id }) => ({
          evidenceId: id,
          use: "history",
        })),
      },
    },
  };
  const read = repository.readSnapshot(personaId, now, 1024 * 1024);
  let attempt = repository.createAttempt(read, "semantic_change", now);
  attempt = repository.saveAttempt({ ...attempt, status: "analyzing" });
  attempt = repository.commitAnalysis(
    attempt.id,
    output,
    now,
    read.snapshot.evidence,
  );
  if (!attempt.actionReadSet || attempt.status !== "ready")
    throw new Error("Fixture did not commit an actual ready action read set");
  const expectedClaims = attempt.actionReadSet.claims.map(
    ({ situationId, claimId }) => {
      const claim = {
        ...repository
          .getSituation(situationId)!
          .claims.find(({ id }) => id === claimId)!,
      };
      delete claim.historyEvidenceIds;
      return { situationId, claim };
    },
  );
  const evidenceBytes = evidence.reduce((sum, { id }) => {
    const row = database
      .prepare("SELECT payload_json FROM cognition_evidence WHERE id=?")
      .get(id) as { payload_json: string };
    return sum + Buffer.byteLength(row.payload_json, "utf8");
  }, 0);
  const rawBytes = expectedClaims.reduce(
    (sum, { claim }) => sum + Buffer.byteLength(JSON.stringify(claim), "utf8"),
    evidenceBytes,
  );
  return {
    database,
    repository,
    personaId,
    evidence,
    attempt,
    expectedClaims,
    rawBytes,
  };
}

function body(context: CognitionPreparedContext) {
  return JSON.parse(context.text.slice(context.text.indexOf("\n") + 1)) as {
    claims: { situationId: string; claim: CognitionClaim }[];
    evidence: unknown[];
  };
}

/** Observe actual SQLite virtual-table input evaluation, not a JS query mock.
 * The scalar receives only the Situation ID and returns true; its CASE keeps
 * the identical JSON inside SQLite. This diagnostic is outside timing runs. */
function observeClaimScans(database: Database.Database) {
  const observed: { situationId: string; inTransaction: boolean }[] = [];
  database.function("observe_claim_scan", (id) => {
    if (typeof id !== "string")
      throw new TypeError("Expected a SQLite text Situation ID");
    observed.push({ situationId: id, inTransaction: database.inTransaction });
    return 1;
  });
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation((sql) =>
    prepare(
      sql.replace(
        "json_each(s.payload_json,'$.claims')",
        "json_each(CASE WHEN observe_claim_scan(s.id) THEN s.payload_json END,'$.claims')",
      ),
    ),
  );
  return observed;
}

function withClaims(
  attempt: CognitionDecisionAttempt,
  claims: NonNullable<CognitionDecisionAttempt["actionReadSet"]>["claims"],
): CognitionDecisionAttempt {
  return { ...attempt, actionReadSet: { ...attempt.actionReadSet!, claims } };
}

describe("selected claim material from SQLite", () => {
  it("opens each selected Situation claims array once per statement and preserves complete order and bytes", () => {
    const f = fixture();
    const first = f.attempt.actionReadSet!.claims[0]!;
    const stored = f.repository.getSituation(first.situationId)!;
    const historyId = f.evidence.find(
      ({ id }) =>
        !stored.claims
          .find(({ id: claimId }) => claimId === first.claimId)!
          .evidenceIds.includes(id),
    )!.id;
    // Install existing host-owned historical provenance as a persisted read
    // fixture. createSituations cannot assign it; no model output is credited.
    f.database
      .prepare("UPDATE cognition_situations SET payload_json=? WHERE id=?")
      .run(
        JSON.stringify({
          ...stored,
          claims: stored.claims.map((claim) =>
            claim.id === first.claimId
              ? { ...claim, historyEvidenceIds: [historyId] }
              : claim,
          ),
        }),
        stored.id,
      );
    expect(
      f.repository
        .getSituation(stored.id)!
        .claims.find(({ id }) => id === first.claimId)!.historyEvidenceIds,
    ).toEqual([historyId]);
    const scans = observeClaimScans(f.database);
    let remaining: number | undefined;
    const context = f.repository.readActionContext(
      f.attempt,
      f.rawBytes,
      (value, rest) => {
        expect(f.database.inTransaction).toBe(true);
        remaining = rest;
        return value;
      },
    );
    expect(body(context).claims).toEqual(f.expectedClaims);
    expect(body(context).evidence).toHaveLength(2);
    expect(context.text).not.toContain("未选的完整条款");
    expect(context.text).not.toContain("historyEvidenceIds");
    expect(remaining).toBe(0);
    const situations = [
      ...new Set(f.expectedClaims.map(({ situationId }) => situationId)),
    ];
    expect(scans).toHaveLength(situations.length * 2);
    for (const situationId of situations)
      expect(
        scans.filter((entry) => entry.situationId === situationId),
      ).toHaveLength(2);
    expect(scans.every(({ inTransaction }) => inTransaction)).toBe(true);
  });

  it("resource rejection still measures all selected bytes but does not issue the body statement", () => {
    const f = fixture();
    const scans = observeClaimScans(f.database);
    const complete = vi.fn((context: CognitionPreparedContext) => context);
    expect(() =>
      f.repository.readActionContext(f.attempt, f.rawBytes - 1, complete),
    ).toThrow(CognitionMaterialResourceError);
    expect(complete).not.toHaveBeenCalled();
    expect(scans).toHaveLength(2);
    expect(scans.every(({ inTransaction }) => inTransaction)).toBe(true);
    expect(f.database.inTransaction).toBe(false);
    // A later ordinary read is not poisoned by the rejected read transaction.
    expect(
      body(
        f.repository.readActionContext(
          f.attempt,
          f.rawBytes,
          (context) => context,
        ),
      ).claims,
    ).toEqual(f.expectedClaims);
  });

  it("preserves duplicate selected positions instead of silently deduplicating their body or cost", () => {
    const f = fixture(2);
    const refs = f.attempt.actionReadSet!.claims;
    const selected = withClaims(f.attempt, [refs[2]!, refs[0]!, refs[2]!]);
    const material = f.database.transaction(() =>
      readSelectedActionMaterial(f.database, selected, Number.MAX_SAFE_INTEGER),
    )();
    expect(body(material.context).claims).toEqual([
      f.expectedClaims[2],
      f.expectedClaims[0],
      f.expectedClaims[2],
    ]);
    expect(material.readCost.rowCount).toBe(5);
    const withoutDuplicate = f.database.transaction(() =>
      readSelectedActionMaterial(
        f.database,
        withClaims(f.attempt, [refs[2]!, refs[0]!]),
        Number.MAX_SAFE_INTEGER,
      ),
    )();
    expect(
      material.readCost.rawValueBytes - withoutDuplicate.readCost.rawValueBytes,
    ).toBe(
      Buffer.byteLength(JSON.stringify(f.expectedClaims[2]!.claim), "utf8"),
    );
  });

  it.each(["missing-claim", "missing-situation", "other-persona"])(
    "keeps %s unavailable before considering a small read allocation",
    (kind) => {
      const f = fixture(1);
      const original = f.attempt.actionReadSet!.claims[0]!;
      let changed = { ...original, claimId: "absent" };
      if (kind === "missing-situation")
        changed = { ...original, situationId: randomUUID() };
      if (kind === "other-persona") {
        const otherPersona = randomUUID();
        f.database
          .prepare(
            "INSERT INTO personas (id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
          )
          .run(otherPersona, now, now);
        f.database
          .prepare("UPDATE cognition_situations SET persona_id=? WHERE id=?")
          .run(otherPersona, original.situationId);
        changed = original;
      }
      expect(() =>
        f.repository.readActionContext(
          withClaims(f.attempt, [changed]),
          1,
          (context) => context,
        ),
      ).toThrow(
        /^Required selected intent, claim or evidence is unavailable$/u,
      );
      expect(f.database.inTransaction).toBe(false);
    },
  );

  it("rejects an ambiguous duplicate stored claim instead of selecting the first matching row", () => {
    const f = fixture(1);
    const ref = f.attempt.actionReadSet!.claims[0]!;
    const situation = f.repository.getSituation(ref.situationId)!;
    const claim = situation.claims.find(({ id }) => id === ref.claimId)!;
    // Malformed persisted input is a boundary fixture, not a production writer.
    f.database
      .prepare("UPDATE cognition_situations SET payload_json=? WHERE id=?")
      .run(
        JSON.stringify({
          ...situation,
          claims: [...situation.claims, { ...claim, text: "另一条冲突正文" }],
        }),
        situation.id,
      );
    expect(() =>
      f.repository.readActionContext(
        withClaims(f.attempt, [ref]),
        Number.MAX_SAFE_INTEGER,
        (context) => context,
      ),
    ).toThrow(/^Required selected intent, claim or evidence is unavailable$/u);
  });

  it("does not scan Situation claims when only evidence is selected", () => {
    const f = fixture(1);
    const scans = observeClaimScans(f.database);
    const context = f.repository.readActionContext(
      withClaims(f.attempt, []),
      f.rawBytes,
      (value) => value,
    );
    expect(body(context).claims).toEqual([]);
    expect(body(context).evidence).toHaveLength(2);
    expect(scans).toEqual([]);
  });
});
