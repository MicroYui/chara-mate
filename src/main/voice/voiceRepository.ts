import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import type {
  VoiceSessionRecord,
  VoiceTurnRecord,
} from "../../shared/contracts/voice";
import {
  VoiceSessionRecordSchema,
  VoiceTurnRecordSchema,
} from "../../shared/schemas/voice";
import { parseSchema } from "../../shared/schemas/validation";
import {
  sanitizeForPersistence,
  serializeForPersistence,
} from "../db/persistenceBoundary";

interface VoiceSessionRow {
  chat_id: string;
  connected_at: string | null;
  created_at: string;
  ended_at: string | null;
  error_json: string | null;
  generation: number;
  id: string;
  input_mode: string;
  instructions: string;
  last_run_id: string | null;
  muted: number;
  protocol_session_id: string | null;
  provider_json: string;
  status: string;
  voice: string;
}

interface VoiceTurnRow {
  assistant_item_id: string | null;
  assistant_message_id: string | null;
  assistant_transcript: string;
  audio_end_ms: number | null;
  ended_at: string | null;
  generation: number;
  id: string;
  instructions: string;
  interrupted: number;
  response_id: string | null;
  run_id: string | null;
  session_id: string;
  started_at: string;
  status: string;
  user_item_id: string | null;
  user_message_id: string | null;
  user_transcript: string;
  voice: string;
}

const sessionColumns = `
  id, chat_id, provider_json, voice, instructions, input_mode, status,
  generation, muted, protocol_session_id, last_run_id, created_at,
  connected_at, ended_at, error_json
`;

const turnColumns = `
  id, session_id, generation, status, run_id, user_message_id,
  assistant_message_id, user_item_id, assistant_item_id, response_id,
  user_transcript, assistant_transcript, voice, instructions, interrupted,
  audio_end_ms, started_at, ended_at
`;

function readJson(serialized: string): unknown {
  return JSON.parse(serialized);
}

function readSession(row: VoiceSessionRow): VoiceSessionRecord {
  return parseSchema(VoiceSessionRecordSchema, {
    chatId: row.chat_id,
    ...(row.connected_at === null ? {} : { connectedAt: row.connected_at }),
    createdAt: row.created_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.error_json === null ? {} : { error: readJson(row.error_json) }),
    generation: row.generation,
    id: row.id,
    inputMode: row.input_mode,
    instructions: row.instructions,
    ...(row.last_run_id === null ? {} : { lastRunId: row.last_run_id }),
    muted: row.muted === 1,
    ...(row.protocol_session_id === null
      ? {}
      : { protocolSessionId: row.protocol_session_id }),
    provider: readJson(row.provider_json),
    status: row.status,
    voice: row.voice,
  });
}

function readTurn(row: VoiceTurnRow): VoiceTurnRecord {
  return parseSchema(VoiceTurnRecordSchema, {
    ...(row.assistant_item_id === null
      ? {}
      : { assistantItemId: row.assistant_item_id }),
    ...(row.assistant_message_id === null
      ? {}
      : { assistantMessageId: row.assistant_message_id }),
    assistantTranscript: row.assistant_transcript,
    ...(row.audio_end_ms === null ? {} : { audioEndMs: row.audio_end_ms }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    generation: row.generation,
    id: row.id,
    instructions: row.instructions,
    interrupted: row.interrupted === 1,
    ...(row.response_id === null ? {} : { responseId: row.response_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    sessionId: row.session_id,
    startedAt: row.started_at,
    status: row.status,
    ...(row.user_item_id === null ? {} : { userItemId: row.user_item_id }),
    ...(row.user_message_id === null
      ? {}
      : { userMessageId: row.user_message_id }),
    userTranscript: row.user_transcript,
    voice: row.voice,
  });
}

export class VoiceRepository {
  constructor(private readonly database: Database.Database) {}

  insertSession(session: VoiceSessionRecord): VoiceSessionRecord {
    const value = sanitizeForPersistence(VoiceSessionRecordSchema, session);
    this.database
      .prepare(
        `INSERT INTO voice_sessions (${sessionColumns})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.chatId,
        serializeForPersistence(value.provider),
        value.voice,
        value.instructions,
        value.inputMode,
        value.status,
        value.generation,
        value.muted ? 1 : 0,
        value.protocolSessionId ?? null,
        value.lastRunId ?? null,
        value.createdAt,
        value.connectedAt ?? null,
        value.endedAt ?? null,
        value.error === undefined ? null : serializeForPersistence(value.error),
      );
    return value;
  }

  updateSession(session: VoiceSessionRecord): VoiceSessionRecord {
    const value = sanitizeForPersistence(VoiceSessionRecordSchema, session);
    const current = this.getSession(value.id);
    if (!current) throw new Error(`Voice session ${value.id} does not exist`);
    if (
      current.chatId !== value.chatId ||
      current.createdAt !== value.createdAt ||
      current.voice !== value.voice ||
      current.instructions !== value.instructions ||
      current.inputMode !== value.inputMode ||
      !isDeepStrictEqual(current.provider, value.provider)
    ) {
      throw new Error(`Voice session ${value.id} changed immutable identity`);
    }
    if (isDeepStrictEqual(current, value)) return current;
    const result = this.database
      .prepare(
        `UPDATE voice_sessions
         SET status = ?, generation = ?, muted = ?, protocol_session_id = ?,
             last_run_id = ?, connected_at = ?, ended_at = ?, error_json = ?
         WHERE id = ?`,
      )
      .run(
        value.status,
        value.generation,
        value.muted ? 1 : 0,
        value.protocolSessionId ?? null,
        value.lastRunId ?? null,
        value.connectedAt ?? null,
        value.endedAt ?? null,
        value.error === undefined ? null : serializeForPersistence(value.error),
        value.id,
      );
    if (result.changes !== 1) {
      throw new Error(`Voice session ${value.id} changed concurrently`);
    }
    return value;
  }

  getSession(sessionId: string): VoiceSessionRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${sessionColumns} FROM voice_sessions WHERE id = ?`)
      .get(sessionId) as VoiceSessionRow | undefined;
    return row ? readSession(row) : undefined;
  }

  listActiveSessions(): VoiceSessionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT ${sessionColumns}
         FROM voice_sessions
         WHERE status IN ('connecting', 'active')
         ORDER BY created_at, id`,
      )
      .all() as VoiceSessionRow[];
    return rows.map(readSession);
  }

  getLatestInterruptedSession(chatId: string): VoiceSessionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${sessionColumns}
         FROM voice_sessions
         WHERE chat_id = ? AND status = 'interrupted' AND last_run_id IS NOT NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(chatId) as VoiceSessionRow | undefined;
    return row ? readSession(row) : undefined;
  }

  insertTurn(turn: VoiceTurnRecord): VoiceTurnRecord {
    const value = sanitizeForPersistence(VoiceTurnRecordSchema, turn);
    this.database
      .prepare(
        `INSERT INTO voice_turns (${turnColumns})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.sessionId,
        value.generation,
        value.status,
        value.runId ?? null,
        value.userMessageId ?? null,
        value.assistantMessageId ?? null,
        value.userItemId ?? null,
        value.assistantItemId ?? null,
        value.responseId ?? null,
        value.userTranscript,
        value.assistantTranscript,
        value.voice,
        value.instructions,
        value.interrupted ? 1 : 0,
        value.audioEndMs ?? null,
        value.startedAt,
        value.endedAt ?? null,
      );
    return value;
  }

  updateTurn(turn: VoiceTurnRecord): VoiceTurnRecord {
    const value = sanitizeForPersistence(VoiceTurnRecordSchema, turn);
    const current = this.getTurn(value.id);
    if (!current) throw new Error(`Voice turn ${value.id} does not exist`);
    if (
      current.sessionId !== value.sessionId ||
      current.generation !== value.generation ||
      current.startedAt !== value.startedAt ||
      current.voice !== value.voice
    ) {
      throw new Error(`Voice turn ${value.id} changed immutable identity`);
    }
    if (isDeepStrictEqual(current, value)) return current;
    const result = this.database
      .prepare(
        `UPDATE voice_turns
         SET status = ?, instructions = ?, run_id = ?, user_message_id = ?,
             assistant_message_id = ?, user_item_id = ?,
             assistant_item_id = ?, response_id = ?, user_transcript = ?,
             assistant_transcript = ?, interrupted = ?, audio_end_ms = ?,
             ended_at = ?
         WHERE id = ?`,
      )
      .run(
        value.status,
        value.instructions,
        value.runId ?? null,
        value.userMessageId ?? null,
        value.assistantMessageId ?? null,
        value.userItemId ?? null,
        value.assistantItemId ?? null,
        value.responseId ?? null,
        value.userTranscript,
        value.assistantTranscript,
        value.interrupted ? 1 : 0,
        value.audioEndMs ?? null,
        value.endedAt ?? null,
        value.id,
      );
    if (result.changes !== 1) {
      throw new Error(`Voice turn ${value.id} changed concurrently`);
    }
    return value;
  }

  getTurn(turnId: string): VoiceTurnRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${turnColumns} FROM voice_turns WHERE id = ?`)
      .get(turnId) as VoiceTurnRow | undefined;
    return row ? readTurn(row) : undefined;
  }

  getCurrentTurn(sessionId: string): VoiceTurnRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${turnColumns}
         FROM voice_turns
         WHERE session_id = ? AND status IN ('listening', 'responding')
         ORDER BY generation DESC
         LIMIT 1`,
      )
      .get(sessionId) as VoiceTurnRow | undefined;
    return row ? readTurn(row) : undefined;
  }

  listTurns(sessionId: string): VoiceTurnRecord[] {
    const rows = this.database
      .prepare(
        `SELECT ${turnColumns}
         FROM voice_turns
         WHERE session_id = ?
         ORDER BY generation, id`,
      )
      .all(sessionId) as VoiceTurnRow[];
    return rows.map(readTurn);
  }
}
