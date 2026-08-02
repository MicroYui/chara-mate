import type Database from "better-sqlite3";

import type { Timestamp } from "../../shared/contracts/primitives";

export interface WindowPlacement {
  height: number;
  isMaximized: boolean;
  updatedAt: Timestamp;
  width: number;
  x: number;
  y: number;
}

interface WindowPlacementRow {
  height: number;
  is_maximized: number;
  updated_at: string;
  width: number;
  x: number;
  y: number;
}

export class WindowPlacementRepository {
  constructor(private readonly database: Database.Database) {}

  get(windowId: string): WindowPlacement | undefined {
    const row = this.database
      .prepare(
        `SELECT x, y, width, height, is_maximized, updated_at
         FROM window_placements
         WHERE window_id = ?`,
      )
      .get(windowId) as WindowPlacementRow | undefined;
    return row
      ? {
          height: row.height,
          isMaximized: row.is_maximized === 1,
          updatedAt: row.updated_at,
          width: row.width,
          x: row.x,
          y: row.y,
        }
      : undefined;
  }

  save(windowId: string, placement: WindowPlacement): void {
    this.database
      .prepare(
        `INSERT INTO window_placements (
           window_id, x, y, width, height, is_maximized, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(window_id) DO UPDATE SET
           x = excluded.x,
           y = excluded.y,
           width = excluded.width,
           height = excluded.height,
           is_maximized = excluded.is_maximized,
           updated_at = excluded.updated_at`,
      )
      .run(
        windowId,
        placement.x,
        placement.y,
        placement.width,
        placement.height,
        placement.isMaximized ? 1 : 0,
        placement.updatedAt,
      );
  }
}
