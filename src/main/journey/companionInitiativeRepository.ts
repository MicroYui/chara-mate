import { Type, type Static } from "@sinclair/typebox";
import type Database from "better-sqlite3";

import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import { sanitizeForPersistence } from "../db/persistenceBoundary";

export const COMPANION_INITIATIVE_HISTORY_LIMIT = 3;

export const CompanionInitiativeOutcomeSchema = Type.Union([
  Type.Literal("shown"),
  Type.Literal("replied"),
  Type.Literal("dismissed"),
  Type.Literal("expired"),
  Type.Literal("interrupted"),
]);

const CompanionInitiativeRecordSchema = Type.Object(
  {
    appId: Type.Optional(NonBlankStringSchema),
    appName: Type.Optional(NonBlankStringSchema),
    grounding: NonBlankStringSchema,
    id: EntityIdSchema,
    kind: Type.Union([
      Type.Literal("invitation"),
      Type.Literal("continuation"),
    ]),
    message: NonBlankStringSchema,
    outcome: CompanionInitiativeOutcomeSchema,
    shownAt: TimestampSchema,
    sourceKind: Type.Union([
      Type.Literal("activity"),
      Type.Literal("memory_event"),
    ]),
    updatedAt: TimestampSchema,
    windowTitle: Type.Optional(NonBlankStringSchema),
  },
  { additionalProperties: false },
);

export type CompanionInitiativeOutcome = Static<
  typeof CompanionInitiativeOutcomeSchema
>;
export type CompanionInitiativeRecord = Static<
  typeof CompanionInitiativeRecordSchema
>;

export type NewCompanionInitiativeRecord = Omit<
  CompanionInitiativeRecord,
  "outcome" | "updatedAt"
>;

export interface CompanionInitiativeHistory {
  listRecent(): readonly CompanionInitiativeRecord[];
  recordShown(input: NewCompanionInitiativeRecord): void;
}

interface CompanionInitiativeRecordRow {
  readonly app_id: string | null;
  readonly app_name: string;
  readonly grounding: string;
  readonly id: string;
  readonly kind: string;
  readonly message: string;
  readonly outcome: string;
  readonly shown_at: string;
  readonly source_kind: string;
  readonly updated_at: string;
  readonly window_title: string;
}

const RECORD_COLUMNS = `
  id, source_kind, kind, app_id, app_name, window_title, grounding, message,
  outcome, shown_at, updated_at
`;

function readRecord(
  row: CompanionInitiativeRecordRow,
): CompanionInitiativeRecord {
  return parseSchema(CompanionInitiativeRecordSchema, {
    ...(row.app_id === null ? {} : { appId: row.app_id }),
    ...(row.source_kind === "activity" ? { appName: row.app_name } : {}),
    grounding: row.grounding,
    id: row.id,
    kind: row.kind,
    message: row.message,
    outcome: row.outcome,
    shownAt: row.shown_at,
    sourceKind: row.source_kind,
    updatedAt: row.updated_at,
    ...(row.source_kind === "activity"
      ? { windowTitle: row.window_title }
      : {}),
  });
}

export class CompanionInitiativeRepository implements CompanionInitiativeHistory {
  constructor(private readonly database: Database.Database) {}

  listRecent(): CompanionInitiativeRecord[] {
    return (
      this.database
        .prepare(
          `SELECT ${RECORD_COLUMNS}
           FROM companion_initiative_records
           ORDER BY shown_at DESC, id DESC
           LIMIT ?`,
        )
        .all(
          COMPANION_INITIATIVE_HISTORY_LIMIT,
        ) as CompanionInitiativeRecordRow[]
    ).map(readRecord);
  }

  recordShown(input: NewCompanionInitiativeRecord): void {
    const record = sanitizeForPersistence(CompanionInitiativeRecordSchema, {
      ...input,
      outcome: "shown",
      updatedAt: input.shownAt,
    });
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO companion_initiative_records (
             id, source_kind, kind, app_id, app_name, window_title, grounding,
             message, outcome, shown_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.sourceKind,
          record.kind,
          record.appId ?? null,
          record.appName ?? "CharaMate",
          record.windowTitle ?? "重要时刻",
          record.grounding,
          record.message,
          record.outcome,
          record.shownAt,
          record.updatedAt,
        );
      this.database
        .prepare(
          `DELETE FROM companion_initiative_records
           WHERE id NOT IN (
             SELECT id
             FROM companion_initiative_records
             ORDER BY shown_at DESC, id DESC
             LIMIT ?
           )`,
        )
        .run(COMPANION_INITIATIVE_HISTORY_LIMIT);
    })();
  }

  updateOutcome(
    id: string,
    outcome: CompanionInitiativeOutcome,
    updatedAt: string,
  ): boolean {
    const record = this.database
      .prepare(
        `SELECT ${RECORD_COLUMNS}
         FROM companion_initiative_records
         WHERE id = ?`,
      )
      .get(id) as CompanionInitiativeRecordRow | undefined;
    if (!record) return false;
    const next = sanitizeForPersistence(CompanionInitiativeRecordSchema, {
      ...readRecord(record),
      outcome: record.outcome === "replied" ? "replied" : outcome,
      updatedAt,
    });
    return (
      this.database
        .prepare(
          `UPDATE companion_initiative_records
           SET outcome = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(next.outcome, next.updatedAt, next.id).changes === 1
    );
  }
}
