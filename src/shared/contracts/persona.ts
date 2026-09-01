import type { Static } from "@sinclair/typebox";

import type {
  PersonaCopyRequestSchema,
  PersonaKindSchema,
  PersonaLibraryResponseSchema,
  PersonaLibrarySnapshotSchema,
  PersonaRecordSchema,
  PersonaRevisionInputSchema,
  PersonaSelectRequestSchema,
  PersonaSnapshotSchema,
  PersonaUpdateRequestSchema,
  PersonaVoiceSchema,
} from "../schemas/persona";

export const PERSONA_CHANNELS = {
  changed: "persona.changed",
  copy: "persona.copy",
  getLibrary: "persona.getLibrary",
  select: "persona.select",
  update: "persona.update",
} as const;

export type PersonaVoice = Static<typeof PersonaVoiceSchema>;
export type PersonaRevisionInput = Static<typeof PersonaRevisionInputSchema>;
export type PersonaSnapshot = Static<typeof PersonaSnapshotSchema>;
export type PersonaKind = Static<typeof PersonaKindSchema>;
export type PersonaRecord = Static<typeof PersonaRecordSchema>;
export type PersonaLibrarySnapshot = Static<
  typeof PersonaLibrarySnapshotSchema
>;
export type PersonaCopyRequest = Static<typeof PersonaCopyRequestSchema>;
export type PersonaSelectRequest = Static<typeof PersonaSelectRequestSchema>;
export type PersonaUpdateRequest = Static<typeof PersonaUpdateRequestSchema>;
export type PersonaLibraryResponse = Static<
  typeof PersonaLibraryResponseSchema
>;

export interface PersonaApi {
  copy(request: PersonaCopyRequest): Promise<PersonaLibraryResponse>;
  getLibrary(): Promise<PersonaLibraryResponse>;
  select(request: PersonaSelectRequest): Promise<PersonaLibraryResponse>;
  subscribeChanged(
    listener: (snapshot: PersonaLibrarySnapshot) => void,
  ): () => void;
  update(request: PersonaUpdateRequest): Promise<PersonaLibraryResponse>;
}
