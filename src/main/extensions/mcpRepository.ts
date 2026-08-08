import type Database from "better-sqlite3";

import type { AppError } from "../../shared/contracts/run";
import type { Timestamp } from "../../shared/contracts/primitives";
import { serializeForPersistence } from "../db/persistenceBoundary";

export interface PersistedSecretField {
  readonly name: string;
  readonly secretRef: string;
}

export type PersistedMcpTransport =
  | {
      readonly args: readonly string[];
      readonly command: string;
      readonly cwd?: string;
      readonly environment: readonly PersistedSecretField[];
      readonly type: "stdio";
    }
  | {
      readonly headers: readonly PersistedSecretField[];
      readonly type: "streamable_http";
      readonly url: string;
    };

export interface McpServerRecord {
  readonly createdAt: Timestamp;
  readonly enabled: boolean;
  readonly id: string;
  readonly lastConnectedAt?: Timestamp;
  readonly lastError?: AppError;
  readonly name: string;
  readonly transport: PersistedMcpTransport;
  readonly updatedAt: Timestamp;
}

interface McpServerRow {
  created_at: Timestamp;
  enabled: number;
  id: string;
  last_connected_at: Timestamp | null;
  last_error_json: string | null;
  name: string;
  transport_json: string;
  updated_at: Timestamp;
}

function readRecord(row: McpServerRow): McpServerRecord {
  return {
    createdAt: row.created_at,
    enabled: row.enabled === 1,
    id: row.id,
    ...(row.last_connected_at
      ? { lastConnectedAt: row.last_connected_at }
      : {}),
    ...(row.last_error_json
      ? { lastError: JSON.parse(row.last_error_json) as AppError }
      : {}),
    name: row.name,
    transport: JSON.parse(row.transport_json) as PersistedMcpTransport,
    updatedAt: row.updated_at,
  };
}

export function transportSecretReferences(
  transport: PersistedMcpTransport,
): ReadonlySet<string> {
  const fields =
    transport.type === "stdio" ? transport.environment : transport.headers;
  return new Set(fields.map(({ secretRef }) => secretRef));
}

export class McpRepository {
  constructor(private readonly database: Database.Database) {}

  delete(id: string): McpServerRecord | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    this.database.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    return current;
  }

  get(id: string): McpServerRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .get(id) as McpServerRow | undefined;
    return row ? readRecord(row) : undefined;
  }

  list(): McpServerRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM mcp_servers ORDER BY updated_at DESC, id")
        .all() as McpServerRow[]
    ).map(readRecord);
  }

  listSecretReferences(): ReadonlySet<string> {
    return new Set(
      this.list().flatMap((record) => [
        ...transportSecretReferences(record.transport),
      ]),
    );
  }

  save(record: McpServerRecord): McpServerRecord {
    this.database
      .prepare(
        `INSERT INTO mcp_servers (
           id, name, enabled, transport_json, created_at, updated_at,
           last_connected_at, last_error_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           enabled = excluded.enabled,
           transport_json = excluded.transport_json,
           updated_at = excluded.updated_at,
           last_connected_at = excluded.last_connected_at,
           last_error_json = excluded.last_error_json`,
      )
      .run(
        record.id,
        record.name,
        record.enabled ? 1 : 0,
        serializeForPersistence(record.transport),
        record.createdAt,
        record.updatedAt,
        record.lastConnectedAt ?? null,
        record.lastError === undefined
          ? null
          : serializeForPersistence(record.lastError),
      );
    const saved = this.get(record.id);
    if (!saved) throw new Error("MCP server was not readable after save");
    return saved;
  }

  updateConnection(
    id: string,
    lastConnectedAt: Timestamp | undefined,
    error: AppError | undefined,
  ): McpServerRecord {
    const current = this.get(id);
    if (!current) throw new Error(`MCP server ${id} does not exist`);
    return this.save({
      createdAt: current.createdAt,
      enabled: current.enabled,
      id: current.id,
      ...(lastConnectedAt === undefined ? {} : { lastConnectedAt }),
      ...(error === undefined ? {} : { lastError: error }),
      name: current.name,
      transport: current.transport,
      updatedAt: current.updatedAt,
    });
  }
}
