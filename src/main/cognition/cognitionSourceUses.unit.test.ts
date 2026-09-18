import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_SQL } from "../db/schema/current";
import { CognitionRepository } from "./cognitionRepository";
import {
  CognitionConflictError,
  CognitionSourceUseError,
  validateCognitionSourceUses,
} from "./cognitionProjection";
import type {
  CognitionAnalysis,
  CognitionEvidence,
  CognitionSelectedBasis,
} from "./cognitionTypes";

const now = "2026-09-16T09:00:00.000Z";
const personaId = "11111111-1111-4111-8111-111111111111";
function source(extra: Partial<CognitionEvidence> = {}): CognitionEvidence {
  return {
    id: randomUUID(),
    personaId,
    kind: "effect",
    actor: "agent",
    source: { kind: "run", id: randomUUID() },
    text: "读取房间成功，圆凳可坐；尚未坐下",
    observedAt: now,
    receivedAt: now,
    receiptSequence: 1,
    effect: {
      runId: randomUUID(),
      description: "房间读取成功，未改变世界",
      sourceRefs: [],
      callId: "read",
      outcome: "performed",
      worldChange: "unchanged",
    },
    ...extra,
  };
}
function check(
  value: CognitionEvidence,
  use: CognitionSelectedBasis["evidenceUses"][number]["use"],
) {
  return () =>
    validateCognitionSourceUses(
      [{ evidenceId: value.id, use }],
      new Map([[value.id, value]]),
    );
}

describe("supplied source type eligibility", () => {
  it.each(["current_object", "current_foreground"] as const)(
    "accepts %s only for an actual observation with a top-level object",
    (use) => {
      const object = { key: "fixture:page", identity: "adapter" as const };
      expect(check(source({ kind: "observation", object }), use)).not.toThrow();
      expect(check(source({ kind: "observation" }), use)).toThrow(
        "object=absent",
      );
      expect(check(source({ object }), use)).toThrow("kind=effect");
    },
  );
  it("does not infer an observation object from nested read output or its fresh timestamp", () => {
    const read = source({
      text: JSON.stringify({
        tool: "territory.observe",
        status: "success",
        result: { object: { key: "room" }, revision: "current" },
      }),
    });
    expect(check(read, "current_object")).toThrow(
      `Evidence ${read.id}: use=current_object, kind=effect, object=absent`,
    );
    expect(check(read, "history")).not.toThrow();
  });
  it("limits current recollection use to a current reading without upgrading old readings", () => {
    const reading = source({
      kind: "recollection",
      actor: "system",
      recollection: {
        current: true,
        historyStatus: "current",
        type: "event",
        recordedAt: now,
      },
    });
    expect(check(reading, "current_recollection")).not.toThrow();
    expect(
      check(
        {
          ...reading,
          recollection: { ...reading.recollection!, current: false },
        },
        "current_recollection",
      ),
    ).toThrow("Current recollection basis requires a current memory reading");
    expect(
      check(
        {
          ...reading,
          recollection: { ...reading.recollection!, current: false },
        },
        "history",
      ),
    ).not.toThrow();
    expect(check(source(), "current_recollection")).toThrow("kind=effect");
  });
  it("reports each invalid use without mutating sources or declarations", () => {
    const read = source(),
      terminal = source({ kind: "observation" });
    const uses: CognitionSelectedBasis["evidenceUses"] = [
      { evidenceId: read.id, use: "current_object" },
      { evidenceId: terminal.id, use: "current_foreground" },
    ];
    const before = structuredClone({ read, terminal, uses });
    let error: unknown;
    try {
      validateCognitionSourceUses(
        uses,
        new Map([
          [read.id, read],
          [terminal.id, terminal],
        ]),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CognitionConflictError);
    expect(error).toBeInstanceOf(CognitionSourceUseError);
    expect((error as CognitionSourceUseError).issues).toMatchObject([
      {
        field: "decision.selectedBasis.evidenceUses[0].use",
        actualKind: "effect",
        typeEligibleUses: ["history"],
      },
      {
        field: "decision.selectedBasis.evidenceUses[1].use",
        actualKind: "observation",
        hasObject: false,
        typeEligibleUses: ["history"],
      },
    ]);
    expect({ read, terminal, uses }).toEqual(before);
  });
  it("keeps unknown IDs outside the bounded semantic correction", () => {
    let error: unknown;
    try {
      validateCognitionSourceUses(
        [{ evidenceId: randomUUID(), use: "current_object" }],
        new Map(),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CognitionConflictError);
    expect(error).not.toBeInstanceOf(CognitionSourceUseError);
  });

  it("rolls the complete failed transaction back and commits legal history with its current claim and Intent intact", () => {
    const db = new Database(":memory:");
    try {
      db.exec(CURRENT_SCHEMA_SQL);
      db.prepare(
        "INSERT INTO personas(id,kind,current_revision,created_at,updated_at) VALUES (?,'custom',1,?,?)",
      ).run(personaId, now, now);
      const repo = new CognitionRepository(db, { readBudgetBytes: 32_768 });
      const read = source();
      const { receivedAt, receiptSequence, ...readInput } = read;
      expect(repo.ingest(readInput, now).evidence).toMatchObject({
        receivedAt,
        receiptSequence,
      });
      const proposal: CognitionAnalysis = {
        delta: {
          createSituations: [
            {
              localId: "new:room",
              value: {
                status: "current",
                title: "读过的房间",
                summary: "圆凳可坐但尚未坐下",
                objectRefs: [],
                episodes: [],
                claims: [
                  {
                    id: "read-result",
                    text: "本次读取返回圆凳可达可坐",
                    basis: "observed",
                    state: "supported",
                    evidenceIds: [read.id],
                    contradictingEvidenceIds: [],
                  },
                ],
                unresolved: [],
                relatedSituationIds: [],
              },
            },
          ],
          updateSituations: [],
          createIntents: [
            {
              localId: "new:rest",
              value: {
                owner: "character",
                basis: "character",
                status: "active",
                goal: "到圆凳坐下休息",
                successCriteria: ["实际坐下"],
                evidenceIds: [read.id],
                effectEvidenceIds: [],
                blockers: [],
                resumeConditions: [],
                progress: "已读取当前房间，尚未坐下",
              },
            },
          ],
          updateIntents: [],
          attention: {
            currentSituationId: "new:room",
            committedIntentId: "new:rest",
          },
        },
        decision: {
          choices: [
            {
              id: "sit",
              kind: "continue_character",
              situationId: "new:room",
              intentId: "new:rest",
              evidenceIds: [read.id],
              instruction: "依据刚读取的世界版本检查并坐下，不能把读取当完成。",
              rationale: "当前圆凳可供休息",
              userImpact: "none",
              executionScope: "territory",
              reversibility: "undoable",
              timing: "now",
              resumeConditions: [],
            },
          ],
          selectedChoiceId: "sit",
          selectedBasis: {
            choiceId: "sit",
            evidenceUses: [{ evidenceId: read.id, use: "current_object" }],
            currentClaimRefs: [
              { situationId: "new:room", claimId: "read-result" },
            ],
          },
          reason: "延续已有休息目标",
        },
      };
      const attempt = repo.createAttempt(
        repo.readSnapshot(personaId, now),
        "semantic_change",
        now,
      );
      repo.saveAttempt({ ...attempt, status: "analyzing" });
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cognition_%' ORDER BY name",
        )
        .all() as { name: string }[];
      const dump = () =>
        tables.map(({ name }) => ({
          name,
          rows: db
            .prepare(`SELECT * FROM ${name}`)
            .all()
            .map((row) => JSON.stringify(row))
            .sort(),
        }));
      const before = dump();
      expect(() => repo.commitAnalysis(attempt.id, proposal, now)).toThrow(
        CognitionSourceUseError,
      );
      expect(dump()).toEqual(before);
      proposal.decision.selectedBasis.evidenceUses[0]!.use = "history";
      const committed = repo.commitAnalysis(attempt.id, proposal, now);
      const after = repo.getSnapshot(personaId, now);
      expect(after.situations[0]!.claims[0]!.evidenceIds).toEqual([read.id]);
      expect(after.intents[0]).toMatchObject({
        status: "active",
        goal: "到圆凳坐下休息",
        effectEvidenceIds: [],
      });
      expect(committed.decision!.selectedBasis.currentClaimRefs).toHaveLength(
        1,
      );
      expect(committed.decision!.choices[0]!.intentId).toBe(
        after.intents[0]!.id,
      );
      expect(repo.actionFreshness(committed, now)).toMatchObject({
        current: true,
      });
    } finally {
      db.close();
    }
  });
});
