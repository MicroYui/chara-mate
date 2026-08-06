import type { Static } from "@sinclair/typebox";

import type {
  CodexPetManifestSchema,
  PetAnimationSchema,
  PetAnimationSpeedRequestSchema,
  PetCharacterSnapshotSchema,
  PetDescriptorSchema,
  PetDragPointSchema,
  PetDragResultSchema,
  PetFacingSchema,
  PetImportResponseSchema,
  PetLibraryResponseSchema,
  PetLibrarySnapshotSchema,
  PetMainNavigationSchema,
  PetMainTargetSchema,
  PetManifestSchema,
  PetScaleRequestSchema,
  PetSelectRequestSchema,
  PetSpriteVersionSchema,
  PetStoredStateSchema,
} from "../schemas/pet";

export const PET_CHANNELS = {
  characterChanged: "pet.character.changed",
  characterGetSnapshot: "pet.character.getSnapshot",
  characterReady: "pet.character.ready",
  dragEnd: "pet.character.dragEnd",
  dragMove: "pet.character.dragMove",
  dragStart: "pet.character.dragStart",
  focusMain: "pet.character.focusMain",
  getLibrary: "pet.library.get",
  importFromFolder: "pet.library.importFromFolder",
  libraryChanged: "pet.library.changed",
  openMain: "pet.main.open",
  select: "pet.library.select",
  setAnimationSpeed: "pet.library.setAnimationSpeed",
  setScale: "pet.library.setScale",
  showContextMenu: "pet.character.showContextMenu",
} as const;

export type PetSpriteVersion = Static<typeof PetSpriteVersionSchema>;
export type PetFacing = Static<typeof PetFacingSchema>;
export type PetAnimation = Static<typeof PetAnimationSchema>;
export type PetAnimationSpeedRequest = Static<
  typeof PetAnimationSpeedRequestSchema
>;
export type CodexPetManifest = Static<typeof CodexPetManifestSchema>;
export type PetManifest = Static<typeof PetManifestSchema>;
export type PetMainNavigation = Static<typeof PetMainNavigationSchema>;
export type PetMainTarget = Static<typeof PetMainTargetSchema>;
export type PetDescriptor = Static<typeof PetDescriptorSchema>;
export type PetLibrarySnapshot = Static<typeof PetLibrarySnapshotSchema>;
export type PetCharacterSnapshot = Static<typeof PetCharacterSnapshotSchema>;
export type PetSelectRequest = Static<typeof PetSelectRequestSchema>;
export type PetScaleRequest = Static<typeof PetScaleRequestSchema>;
export type PetDragPoint = Static<typeof PetDragPointSchema>;
export type PetDragResult = Static<typeof PetDragResultSchema>;
export type PetStoredState = Static<typeof PetStoredStateSchema>;
export type PetLibraryResponse = Static<typeof PetLibraryResponseSchema>;
export type PetImportResponse = Static<typeof PetImportResponseSchema>;

export interface PetManagementApi {
  getLibrary(): Promise<PetLibraryResponse>;
  importFromFolder(): Promise<PetImportResponse>;
  select(request: PetSelectRequest): Promise<PetLibraryResponse>;
  setAnimationSpeed(
    request: PetAnimationSpeedRequest,
  ): Promise<PetLibraryResponse>;
  setScale(request: PetScaleRequest): Promise<PetLibraryResponse>;
  subscribeChanged(
    listener: (snapshot: PetLibrarySnapshot) => void,
  ): () => void;
  subscribeOpenMain(listener: (target: PetMainTarget) => void): () => void;
}

export interface CharacterWindowApi {
  endDrag(point: PetDragPoint): Promise<PetDragResult>;
  focusMain(): void;
  getSnapshot(): Promise<PetCharacterSnapshot>;
  markReady(): void;
  moveDrag(point: PetDragPoint): void;
  showContextMenu(): void;
  startDrag(point: PetDragPoint): Promise<PetDragResult>;
  subscribe(listener: (snapshot: PetCharacterSnapshot) => void): () => void;
}
