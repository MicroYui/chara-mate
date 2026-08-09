import type {
  MemoryClaimSlot,
  MemoryType,
} from "../../shared/contracts/memory";

export type MemoryClaimCardinality = "set" | "single";

export interface MemoryClaimDefinition {
  readonly cardinality: MemoryClaimCardinality;
  readonly type: Extract<MemoryType, "preference" | "profile">;
}

const definitions = {
  "preference.communication_style": {
    cardinality: "single",
    type: "preference",
  },
  "preference.dislikes": { cardinality: "set", type: "preference" },
  "preference.food": { cardinality: "set", type: "preference" },
  "preference.hobbies": { cardinality: "set", type: "preference" },
  "preference.likes": { cardinality: "set", type: "preference" },
  "preference.media": { cardinality: "set", type: "preference" },
  "preference.music": { cardinality: "set", type: "preference" },
  "preference.response_style": {
    cardinality: "single",
    type: "preference",
  },
  "preference.schedule": { cardinality: "single", type: "preference" },
  "preference.tools": { cardinality: "set", type: "preference" },
  "preference.travel": { cardinality: "set", type: "preference" },
  "profile.birth_date": { cardinality: "single", type: "profile" },
  "profile.home_location": { cardinality: "single", type: "profile" },
  "profile.languages": { cardinality: "set", type: "profile" },
  "profile.name": { cardinality: "single", type: "profile" },
  "profile.occupation": { cardinality: "single", type: "profile" },
  "profile.pronouns": { cardinality: "set", type: "profile" },
  "profile.timezone": { cardinality: "single", type: "profile" },
} as const satisfies Record<MemoryClaimSlot, MemoryClaimDefinition>;

export function memoryClaimDefinition(
  slot: MemoryClaimSlot,
): MemoryClaimDefinition {
  return definitions[slot];
}
