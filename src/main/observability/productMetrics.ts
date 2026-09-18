import type {
  MemoryCanonicalStorageStats,
  MemorySourceReclamation,
} from "../../shared/contracts/memoryRecall";
import type Database from "better-sqlite3";

export interface ProductMetricsSnapshot {
  readonly image: {
    readonly assets: Record<"edited" | "generated" | "packaged", number>;
    readonly assetBytes: Record<"edited" | "generated" | "packaged", number>;
    readonly candidates: Record<
      | "applied"
      | "cancelled"
      | "draft"
      | "failed"
      | "generating"
      | "ready"
      | "stale",
      number
    >;
  };
  readonly memory: {
    readonly active: number;
    readonly pendingCandidates: number;
    readonly revisions: number;
    readonly usages: number;
    readonly canonical: MemoryCanonicalStorageStats;
  };
  readonly storage: {
    readonly activityAssetBytes: number;
    readonly attachmentBytes: number;
    readonly sqliteAllocatedBytes: number;
    readonly sqliteReclaimableBytes: number;
    readonly territoryAssetBytes: number;
  };
}

export interface ProductMetricsReader {
  snapshot(): ProductMetricsSnapshot;
}

interface NumberRow {
  readonly value: number;
}

interface GroupedAssetRow {
  readonly bytes: number;
  readonly count: number;
  readonly key: "edited" | "generated" | "packaged";
}

interface GroupedCandidateRow {
  readonly count: number;
  readonly key: keyof ProductMetricsSnapshot["image"]["candidates"];
}

function zeroAssets() {
  return { edited: 0, generated: 0, packaged: 0 };
}

function zeroCandidates() {
  return {
    applied: 0,
    cancelled: 0,
    draft: 0,
    failed: 0,
    generating: 0,
    ready: 0,
    stale: 0,
  };
}

export const emptyProductMetricsSnapshot = (): ProductMetricsSnapshot => ({
  image: {
    assetBytes: zeroAssets(),
    assets: zeroAssets(),
    candidates: zeroCandidates(),
  },
  memory: {
    active: 0,
    pendingCandidates: 0,
    revisions: 0,
    usages: 0,
    canonical: {
      presentSources: 0,
      releasedSources: 0,
      rawUtf16Bytes: 0,
      quoteUtf8Bytes: 0,
    },
  },
  storage: {
    activityAssetBytes: 0,
    attachmentBytes: 0,
    sqliteAllocatedBytes: 0,
    sqliteReclaimableBytes: 0,
    territoryAssetBytes: 0,
  },
});

export class ProductMetrics implements ProductMetricsReader {
  constructor(
    private readonly database: Database.Database,
    private readonly memory: Pick<
      MemorySourceReclamation,
      "canonicalStorageStats"
    >,
  ) {}

  snapshot(): ProductMetricsSnapshot {
    const scalar = (sql: string): number =>
      (this.database.prepare(sql).get() as NumberRow | undefined)?.value ?? 0;
    const assets = zeroAssets();
    const assetBytes = zeroAssets();
    for (const row of this.database
      .prepare(
        `SELECT origin AS key, COUNT(*) AS count,
                COALESCE(SUM(byte_length), 0) AS bytes
           FROM territory_world_assets
          GROUP BY origin`,
      )
      .all() as GroupedAssetRow[]) {
      assets[row.key] = row.count;
      assetBytes[row.key] = row.bytes;
    }
    const candidates = zeroCandidates();
    for (const row of this.database
      .prepare(
        `SELECT status AS key, COUNT(*) AS count
           FROM territory_change_candidates
          GROUP BY status`,
      )
      .all() as GroupedCandidateRow[]) {
      candidates[row.key] = row.count;
    }
    const pageSize = this.database.pragma("page_size", {
      simple: true,
    }) as number;
    const pageCount = this.database.pragma("page_count", {
      simple: true,
    }) as number;
    const freePages = this.database.pragma("freelist_count", {
      simple: true,
    }) as number;
    return {
      image: { assetBytes, assets, candidates },
      memory: {
        active: scalar(
          "SELECT COUNT(*) AS value FROM memories WHERE status = 'active' AND deleted_at IS NULL",
        ),
        pendingCandidates: scalar(
          "SELECT COUNT(*) AS value FROM memory_candidates WHERE status = 'pending'",
        ),
        revisions: scalar("SELECT COUNT(*) AS value FROM memory_revisions"),
        usages: scalar("SELECT COUNT(*) AS value FROM memory_usage"),
        canonical: this.memory.canonicalStorageStats(),
      },
      storage: {
        activityAssetBytes: scalar(
          "SELECT COALESCE(SUM(byte_length), 0) AS value FROM activity_assets",
        ),
        attachmentBytes: scalar(
          "SELECT COALESCE(SUM(byte_length), 0) AS value FROM attachments",
        ),
        sqliteAllocatedBytes: pageCount * pageSize,
        sqliteReclaimableBytes: freePages * pageSize,
        territoryAssetBytes: scalar(
          "SELECT COALESCE(SUM(byte_length), 0) AS value FROM territory_world_assets",
        ),
      },
    };
  }
}
