import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  CURRENT_SCHEMA_SQL,
  CURRENT_SCHEMA_VERSION,
  METADATA_SCHEMA_SQL,
} from "./schema/current";
import { migrateV4ToV5 } from "./schema/migrateV4ToV5";
import { migrateV5ToV6 } from "./schema/migrateV5ToV6";
import { migrateV6ToV7 } from "./schema/migrateV6ToV7";
import { migrateV7ToV8 } from "./schema/migrateV7ToV8";
import { migrateV8ToV9 } from "./schema/migrateV8ToV9";
import { migrateV9ToV10 } from "./schema/migrateV9ToV10";
import { migrateV10ToV11 } from "./schema/migrateV10ToV11";
import { migrateV11ToV12 } from "./schema/migrateV11ToV12";
import { migrateV12ToV13 } from "./schema/migrateV12ToV13";
import { migrateV13ToV14 } from "./schema/migrateV13ToV14";
import { migrateV14ToV15 } from "./schema/migrateV14ToV15";
import { migrateV15ToV16 } from "./schema/migrateV15ToV16";
import { migrateV16ToV17 } from "./schema/migrateV16ToV17";
import { migrateV17ToV18 } from "./schema/migrateV17ToV18";
import { migrateV18ToV19 } from "./schema/migrateV18ToV19";
import { migrateV19ToV20 } from "./schema/migrateV19ToV20";
import { migrateV20ToV21 } from "./schema/migrateV20ToV21";

interface MetadataRow {
  value: string;
}

function initializeCurrentSchema(database: Database.Database): void {
  database.exec(METADATA_SCHEMA_SQL);
  const schemaVersion = database
    .prepare("SELECT value FROM app_metadata WHERE key = ?")
    .get("schema_version") as MetadataRow | undefined;

  let installedVersion = schemaVersion?.value;
  if (installedVersion === "4") {
    migrateV4ToV5(database);
    installedVersion = "5";
  }
  if (installedVersion === "5") {
    migrateV5ToV6(database);
    installedVersion = "6";
  }
  if (installedVersion === "6") {
    migrateV6ToV7(database);
    installedVersion = "7";
  }
  if (installedVersion === "7") {
    migrateV7ToV8(database);
    installedVersion = "8";
  }
  if (installedVersion === "8") {
    migrateV8ToV9(database);
    installedVersion = "9";
  }
  if (installedVersion === "9") {
    migrateV9ToV10(database);
    installedVersion = "10";
  }
  if (installedVersion === "10") {
    migrateV10ToV11(database);
    installedVersion = "11";
  }
  if (installedVersion === "11") {
    migrateV11ToV12(database);
    installedVersion = "12";
  }
  if (installedVersion === "12") {
    migrateV12ToV13(database);
    installedVersion = "13";
  }
  if (installedVersion === "13") {
    migrateV13ToV14(database);
    installedVersion = "14";
  }
  if (installedVersion === "14") {
    migrateV14ToV15(database);
    installedVersion = "15";
  }
  if (installedVersion === "15") {
    migrateV15ToV16(database);
    installedVersion = "16";
  }
  if (installedVersion === "16") {
    migrateV16ToV17(database);
    installedVersion = "17";
  }
  if (installedVersion === "17") {
    migrateV17ToV18(database);
    installedVersion = "18";
  }
  if (installedVersion === "18") {
    migrateV18ToV19(database);
    installedVersion = "19";
  }
  if (installedVersion === "19") {
    migrateV19ToV20(database);
    installedVersion = "20";
  }
  if (installedVersion === "20") {
    migrateV20ToV21(database);
    installedVersion = "21";
  }
  if (
    installedVersion !== undefined &&
    installedVersion !== CURRENT_SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported database schema version: ${installedVersion}`);
  }

  const installSchema = database.transaction(() => {
    database.exec(CURRENT_SCHEMA_SQL);
    database
      .prepare(
        "INSERT OR IGNORE INTO app_metadata (key, value) VALUES ('schema_version', ?)",
      )
      .run(CURRENT_SCHEMA_VERSION);
  });
  installSchema();
}

export function openApplicationDatabase(
  databasePath: string,
): Database.Database {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    initializeCurrentSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function verifyDatabaseRoundTrip(databasePath: string): true {
  const probeKey = `foundation-probe-${randomUUID()}`;
  const probeValue = randomUUID();
  let database = openApplicationDatabase(databasePath);

  const writeProbe = database.transaction(() => {
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run(probeKey, probeValue);
  });
  writeProbe();
  database.close();

  database = openApplicationDatabase(databasePath);
  const row = database
    .prepare("SELECT value FROM app_metadata WHERE key = ?")
    .get(probeKey) as MetadataRow | undefined;

  if (row?.value !== probeValue) {
    database.close();
    throw new Error("SQLite transaction did not survive close and reopen.");
  }

  database.prepare("DELETE FROM app_metadata WHERE key = ?").run(probeKey);
  database.close();
  return true;
}
