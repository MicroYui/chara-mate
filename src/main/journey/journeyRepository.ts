import type Database from "better-sqlite3";

import type {
  Journey,
  JourneyMoment,
  TogetherSession,
} from "../../shared/contracts/journey";
import {
  JourneyFollowUpSchema,
  JourneyMomentSchema,
  JourneySchema,
  TogetherSessionSchema,
} from "../../shared/schemas/journey";
import { parseSchema } from "../../shared/schemas/validation";
import { sanitizeForPersistence } from "../db/persistenceBoundary";

interface JourneyRow {
  completed_at: string | null;
  created_at: string;
  current_position: string | null;
  follow_up_json: string | null;
  home_chat_id: string;
  id: string;
  next_step: string | null;
  paused_at: string | null;
  purpose: string;
  status: string;
  title: string;
  updated_at: string;
}

interface TogetherSessionRow {
  chat_id: string;
  created_at: string;
  ended_at: string | null;
  id: string;
  journey_id: string | null;
  paused_at: string | null;
  recap: string | null;
  resume_note: string | null;
  status: string;
  title: string;
  updated_at: string;
}

interface JourneyMomentRow {
  content: string;
  created_at: string;
  id: string;
  journey_id: string;
  kind: string;
  memory_id: string | null;
  occurred_at: string;
  session_id: string | null;
}

function readJourney(row: JourneyRow): Journey {
  const followUp =
    row.follow_up_json === null
      ? undefined
      : parseSchema(
          JourneyFollowUpSchema,
          JSON.parse(row.follow_up_json) as unknown,
        );
  return parseSchema(JourneySchema, {
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    createdAt: row.created_at,
    ...(row.current_position === null
      ? {}
      : { currentPosition: row.current_position }),
    ...(followUp ? { followUp } : {}),
    homeChatId: row.home_chat_id,
    id: row.id,
    ...(row.next_step === null ? {} : { nextStep: row.next_step }),
    ...(row.paused_at === null ? {} : { pausedAt: row.paused_at }),
    purpose: row.purpose,
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
  });
}

function readSession(row: TogetherSessionRow): TogetherSession {
  return parseSchema(TogetherSessionSchema, {
    chatId: row.chat_id,
    createdAt: row.created_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    id: row.id,
    ...(row.journey_id === null ? {} : { journeyId: row.journey_id }),
    ...(row.paused_at === null ? {} : { pausedAt: row.paused_at }),
    ...(row.recap === null ? {} : { recap: row.recap }),
    ...(row.resume_note === null ? {} : { resumeNote: row.resume_note }),
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
  });
}

function readMoment(row: JourneyMomentRow): JourneyMoment {
  return parseSchema(JourneyMomentSchema, {
    content: row.content,
    createdAt: row.created_at,
    id: row.id,
    journeyId: row.journey_id,
    kind: row.kind,
    ...(row.memory_id === null ? {} : { memoryId: row.memory_id }),
    occurredAt: row.occurred_at,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
  });
}

const JOURNEY_COLUMNS = `
  id, home_chat_id, title, purpose, status, current_position, next_step,
  follow_up_json, created_at, updated_at, paused_at, completed_at
`;

const SESSION_COLUMNS = `
  id, journey_id, chat_id, title, status, resume_note, recap,
  created_at, updated_at, paused_at, ended_at
`;

const MOMENT_COLUMNS = `
  id, journey_id, session_id, memory_id, kind, content, occurred_at, created_at
`;

export class JourneyRepository {
  constructor(private readonly database: Database.Database) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  insertJourney(journey: Journey): Journey {
    const value = sanitizeForPersistence(JourneySchema, journey);
    this.database
      .prepare(
        `INSERT INTO journeys (
          id, home_chat_id, title, purpose, status, current_position, next_step,
          follow_up_json, created_at, updated_at, paused_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.homeChatId,
        value.title,
        value.purpose,
        value.status,
        value.currentPosition ?? null,
        value.nextStep ?? null,
        value.followUp ? JSON.stringify(value.followUp) : null,
        value.createdAt,
        value.updatedAt,
        value.pausedAt ?? null,
        value.completedAt ?? null,
      );
    return value;
  }

  updateJourney(journey: Journey): Journey {
    const value = sanitizeForPersistence(JourneySchema, journey);
    const result = this.database
      .prepare(
        `UPDATE journeys SET
          title = ?, purpose = ?, status = ?, current_position = ?,
          next_step = ?, follow_up_json = ?, updated_at = ?, paused_at = ?,
          completed_at = ?
        WHERE id = ? AND home_chat_id = ? AND created_at = ?`,
      )
      .run(
        value.title,
        value.purpose,
        value.status,
        value.currentPosition ?? null,
        value.nextStep ?? null,
        value.followUp ? JSON.stringify(value.followUp) : null,
        value.updatedAt,
        value.pausedAt ?? null,
        value.completedAt ?? null,
        value.id,
        value.homeChatId,
        value.createdAt,
      );
    if (result.changes !== 1) throw new Error(`Journey ${value.id} is stale`);
    return value;
  }

  getJourney(journeyId: string): Journey | undefined {
    const row = this.database
      .prepare(`SELECT ${JOURNEY_COLUMNS} FROM journeys WHERE id = ?`)
      .get(journeyId) as JourneyRow | undefined;
    return row ? readJourney(row) : undefined;
  }

  getJourneyByHomeChat(chatId: string): Journey | undefined {
    const row = this.database
      .prepare(`SELECT ${JOURNEY_COLUMNS} FROM journeys WHERE home_chat_id = ?`)
      .get(chatId) as JourneyRow | undefined;
    return row ? readJourney(row) : undefined;
  }

  listJourneys(): Journey[] {
    return (
      this.database
        .prepare(
          `SELECT ${JOURNEY_COLUMNS} FROM journeys
           ORDER BY
             CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
             updated_at DESC, id`,
        )
        .all() as JourneyRow[]
    ).map(readJourney);
  }

  insertSession(session: TogetherSession): TogetherSession {
    const value = sanitizeForPersistence(TogetherSessionSchema, session);
    this.database
      .prepare(
        `INSERT INTO together_sessions (
          id, journey_id, chat_id, title, status, resume_note, recap,
          created_at, updated_at, paused_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.journeyId ?? null,
        value.chatId,
        value.title,
        value.status,
        value.resumeNote ?? null,
        value.recap ?? null,
        value.createdAt,
        value.updatedAt,
        value.pausedAt ?? null,
        value.endedAt ?? null,
      );
    return value;
  }

  updateSession(session: TogetherSession): TogetherSession {
    const value = sanitizeForPersistence(TogetherSessionSchema, session);
    const result = this.database
      .prepare(
        `UPDATE together_sessions SET
          journey_id = ?, chat_id = ?, title = ?, status = ?, resume_note = ?,
          recap = ?, updated_at = ?, paused_at = ?, ended_at = ?
        WHERE id = ? AND created_at = ?`,
      )
      .run(
        value.journeyId ?? null,
        value.chatId,
        value.title,
        value.status,
        value.resumeNote ?? null,
        value.recap ?? null,
        value.updatedAt,
        value.pausedAt ?? null,
        value.endedAt ?? null,
        value.id,
        value.createdAt,
      );
    if (result.changes !== 1) throw new Error(`Session ${value.id} is stale`);
    return value;
  }

  getSession(sessionId: string): TogetherSession | undefined {
    const row = this.database
      .prepare(`SELECT ${SESSION_COLUMNS} FROM together_sessions WHERE id = ?`)
      .get(sessionId) as TogetherSessionRow | undefined;
    return row ? readSession(row) : undefined;
  }

  getActiveSession(): TogetherSession | undefined {
    const row = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM together_sessions
         WHERE status = 'active' LIMIT 1`,
      )
      .get() as TogetherSessionRow | undefined;
    return row ? readSession(row) : undefined;
  }

  listSessions(): TogetherSession[] {
    return (
      this.database
        .prepare(
          `SELECT ${SESSION_COLUMNS} FROM together_sessions
           ORDER BY
             CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
             updated_at DESC, id`,
        )
        .all() as TogetherSessionRow[]
    ).map(readSession);
  }

  listJourneySessions(journeyId: string): TogetherSession[] {
    return (
      this.database
        .prepare(
          `SELECT ${SESSION_COLUMNS} FROM together_sessions
           WHERE journey_id = ? ORDER BY created_at DESC, id`,
        )
        .all(journeyId) as TogetherSessionRow[]
    ).map(readSession);
  }

  listUnfinishedJourneySessions(journeyId: string): TogetherSession[] {
    return (
      this.database
        .prepare(
          `SELECT ${SESSION_COLUMNS} FROM together_sessions
           WHERE journey_id = ? AND status IN ('active', 'paused')
           ORDER BY updated_at DESC, id`,
        )
        .all(journeyId) as TogetherSessionRow[]
    ).map(readSession);
  }

  findActiveSessionForChat(chatId: string): TogetherSession | undefined {
    const row = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM together_sessions
         WHERE chat_id = ? AND status = 'active' LIMIT 1`,
      )
      .get(chatId) as TogetherSessionRow | undefined;
    return row ? readSession(row) : undefined;
  }

  insertMoment(moment: JourneyMoment): JourneyMoment {
    const value = sanitizeForPersistence(JourneyMomentSchema, moment);
    this.database
      .prepare(
        `INSERT INTO journey_moments (
          id, journey_id, session_id, memory_id, kind, content,
          occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.journeyId,
        value.sessionId ?? null,
        value.memoryId ?? null,
        value.kind,
        value.content,
        value.occurredAt,
        value.createdAt,
      );
    return value;
  }

  listMoments(journeyId: string): JourneyMoment[] {
    return (
      this.database
        .prepare(
          `SELECT ${MOMENT_COLUMNS} FROM journey_moments
           WHERE journey_id = ? ORDER BY occurred_at, created_at, rowid`,
        )
        .all(journeyId) as JourneyMomentRow[]
    ).map(readMoment);
  }

  getMoment(momentId: string): JourneyMoment | undefined {
    const row = this.database
      .prepare(`SELECT ${MOMENT_COLUMNS} FROM journey_moments WHERE id = ?`)
      .get(momentId) as JourneyMomentRow | undefined;
    return row ? readMoment(row) : undefined;
  }

  hasMemoryMoment(journeyId: string, memoryId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM journey_moments
           WHERE journey_id = ? AND memory_id = ? LIMIT 1`,
        )
        .get(journeyId, memoryId),
    );
  }

  findJourneyByFollowUpAutomation(automationId: string): Journey | undefined {
    const row = this.database
      .prepare(
        `SELECT ${JOURNEY_COLUMNS} FROM journeys
         WHERE json_extract(follow_up_json, '$.automationId') = ? LIMIT 1`,
      )
      .get(automationId) as JourneyRow | undefined;
    return row ? readJourney(row) : undefined;
  }
}
