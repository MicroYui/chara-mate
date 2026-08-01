import { Type, type Static } from "@sinclair/typebox";
import type Database from "better-sqlite3";

import {
  EntityIdSchema,
  NonBlankStringSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";

const recordProperties = {
  apiKeyRef: Type.Optional(EntityIdSchema),
  baseUrl: NonBlankStringSchema,
  chatModel: Type.Optional(NonBlankStringSchema),
  createdAt: TimestampSchema,
  id: EntityIdSchema,
  imageGenerationEndpoint: Type.Optional(NonBlankStringSchema),
  imageModel: Type.Optional(NonBlankStringSchema),
  name: NonBlankStringSchema,
  realtimeEndpoint: Type.Optional(NonBlankStringSchema),
  realtimeModel: Type.Optional(NonBlankStringSchema),
  updatedAt: TimestampSchema,
};

const ProviderRecordSchema = Type.Union([
  Type.Object(
    { ...recordProperties, apiStyle: Type.Literal("openai-compatible") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...recordProperties,
      apiStyle: Type.Literal("azure-openai"),
      apiVersion: Type.Optional(NonBlankStringSchema),
    },
    { additionalProperties: false },
  ),
]);

export type ProviderRecord = Static<typeof ProviderRecordSchema>;

export interface ProviderProfileRepository {
  delete(profileId: string): ProviderRecord | undefined;
  get(profileId: string): ProviderRecord | undefined;
  list(): ProviderRecord[];
  listSecretReferences(): ReadonlySet<string>;
  save(record: ProviderRecord): ProviderRecord;
}

interface ProviderRow {
  api_key_ref: string | null;
  api_style: "openai-compatible" | "azure-openai";
  api_version: string | null;
  base_url: string;
  chat_model: string | null;
  created_at: string;
  id: string;
  image_generation_endpoint: string | null;
  image_model: string | null;
  name: string;
  realtime_endpoint: string | null;
  realtime_model: string | null;
  updated_at: string;
}

function optionalProperty<TValue>(
  key: string,
  value: TValue | null,
): Record<string, TValue> {
  return value === null ? {} : { [key]: value };
}

function mapRow(row: ProviderRow): ProviderRecord {
  const common = {
    ...optionalProperty("apiKeyRef", row.api_key_ref),
    apiStyle: row.api_style,
    ...optionalProperty("apiVersion", row.api_version),
    baseUrl: row.base_url,
    ...optionalProperty("chatModel", row.chat_model),
    createdAt: row.created_at,
    id: row.id,
    ...optionalProperty(
      "imageGenerationEndpoint",
      row.image_generation_endpoint,
    ),
    ...optionalProperty("imageModel", row.image_model),
    name: row.name,
    ...optionalProperty("realtimeEndpoint", row.realtime_endpoint),
    ...optionalProperty("realtimeModel", row.realtime_model),
    updatedAt: row.updated_at,
  };
  return parseSchema(ProviderRecordSchema, common);
}

export class ProviderRepository implements ProviderProfileRepository {
  readonly #deleteStatement: Database.Statement<[string]>;
  readonly #getStatement: Database.Statement<[string], ProviderRow>;
  readonly #listStatement: Database.Statement<[], ProviderRow>;
  readonly #upsertStatement: Database.Statement;

  constructor(database: Database.Database) {
    this.#getStatement = database.prepare(`
      SELECT * FROM provider_profiles WHERE id = ?
    `);
    this.#listStatement = database.prepare(`
      SELECT * FROM provider_profiles ORDER BY updated_at DESC, name ASC, id ASC
    `);
    this.#deleteStatement = database.prepare(`
      DELETE FROM provider_profiles WHERE id = ?
    `);
    this.#upsertStatement = database.prepare(`
      INSERT INTO provider_profiles (
        id, name, api_style, base_url, api_version, api_key_ref, chat_model,
        realtime_endpoint, realtime_model, image_generation_endpoint, image_model,
        created_at, updated_at
      ) VALUES (
        @id, @name, @apiStyle, @baseUrl, @apiVersion, @apiKeyRef, @chatModel,
        @realtimeEndpoint, @realtimeModel, @imageGenerationEndpoint, @imageModel,
        @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        api_style = excluded.api_style,
        base_url = excluded.base_url,
        api_version = excluded.api_version,
        api_key_ref = excluded.api_key_ref,
        chat_model = excluded.chat_model,
        realtime_endpoint = excluded.realtime_endpoint,
        realtime_model = excluded.realtime_model,
        image_generation_endpoint = excluded.image_generation_endpoint,
        image_model = excluded.image_model,
        updated_at = excluded.updated_at
    `);
  }

  delete(profileId: string): ProviderRecord | undefined {
    const existing = this.get(profileId);
    if (!existing) {
      return undefined;
    }
    this.#deleteStatement.run(profileId);
    return existing;
  }

  get(profileId: string): ProviderRecord | undefined {
    const row = this.#getStatement.get(profileId);
    return row ? mapRow(row) : undefined;
  }

  list(): ProviderRecord[] {
    return this.#listStatement.all().map(mapRow);
  }

  listSecretReferences(): ReadonlySet<string> {
    return new Set(
      this.list().flatMap((profile) =>
        profile.apiKeyRef ? [profile.apiKeyRef] : [],
      ),
    );
  }

  save(record: ProviderRecord): ProviderRecord {
    const value = parseSchema(ProviderRecordSchema, record);
    this.#upsertStatement.run({
      apiKeyRef: value.apiKeyRef ?? null,
      apiStyle: value.apiStyle,
      apiVersion:
        value.apiStyle === "azure-openai" ? (value.apiVersion ?? null) : null,
      baseUrl: value.baseUrl,
      chatModel: value.chatModel ?? null,
      createdAt: value.createdAt,
      id: value.id,
      imageGenerationEndpoint: value.imageGenerationEndpoint ?? null,
      imageModel: value.imageModel ?? null,
      name: value.name,
      realtimeEndpoint: value.realtimeEndpoint ?? null,
      realtimeModel: value.realtimeModel ?? null,
      updatedAt: value.updatedAt,
    });
    const saved = this.get(value.id);
    if (!saved) {
      throw new Error("Provider profile was not readable after save");
    }
    return saved;
  }
}
