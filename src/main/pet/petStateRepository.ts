import type Database from "better-sqlite3";

import type { PetStoredState } from "../../shared/contracts/pet";

interface PetStateRow {
  active_pet_id: string | null;
  animation_speed: number;
  display_id: string | null;
  facing: PetStoredState["facing"];
  height: number;
  offset_x: number;
  offset_y: number;
  scale: number;
  updated_at: string;
  width: number;
}

export class PetStateRepository {
  constructor(private readonly database: Database.Database) {}

  get(): PetStoredState | undefined {
    const row = this.database
      .prepare(
        `SELECT active_pet_id, animation_speed, display_id, offset_x, offset_y,
                width, height, scale, facing, updated_at
         FROM pet_character_state
         WHERE state_id = 'character'`,
      )
      .get() as PetStateRow | undefined;

    return row
      ? {
          activePetId: row.active_pet_id,
          animationSpeed: row.animation_speed,
          displayId: row.display_id,
          facing: row.facing,
          height: row.height,
          offsetX: row.offset_x,
          offsetY: row.offset_y,
          scale: row.scale,
          updatedAt: row.updated_at,
          width: row.width,
        }
      : undefined;
  }

  save(state: PetStoredState): void {
    this.database
      .prepare(
        `INSERT INTO pet_character_state (
           state_id, active_pet_id, animation_speed, display_id, offset_x,
           offset_y, width, height, scale, facing, updated_at
         ) VALUES ('character', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(state_id) DO UPDATE SET
           active_pet_id = excluded.active_pet_id,
           animation_speed = excluded.animation_speed,
           display_id = excluded.display_id,
           offset_x = excluded.offset_x,
           offset_y = excluded.offset_y,
           width = excluded.width,
           height = excluded.height,
           scale = excluded.scale,
           facing = excluded.facing,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.activePetId,
        state.animationSpeed,
        state.displayId,
        state.offsetX,
        state.offsetY,
        state.width,
        state.height,
        state.scale,
        state.facing,
        state.updatedAt,
      );
  }
}
