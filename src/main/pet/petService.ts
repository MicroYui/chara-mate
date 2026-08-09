import type {
  PetCharacterSnapshot,
  PetAnimation,
  PetDescriptor,
  PetFacing,
  PetLibrarySnapshot,
  PetStoredState,
} from "../../shared/contracts/pet";
import type { Clock } from "../../shared/pure/clock";
import type { PetLibraryRepository } from "./petLibraryRepository";
import { PetError } from "./petError";
import type { PetStateRepository } from "./petStateRepository";

const DEFAULT_WIDTH = 192;
const DEFAULT_HEIGHT = 208;

type PetChangeListener = () => void;

export class PetService {
  private state: PetStoredState | undefined;
  private runtimeAnimation: PetAnimation = "idle";
  private readonly listeners = new Set<PetChangeListener>();

  constructor(
    private readonly library: PetLibraryRepository,
    private readonly states: PetStateRepository,
    private readonly clock: Clock,
  ) {}

  private requireState(): PetStoredState {
    if (!this.state) {
      throw new PetError("PET.STORAGE_FAILED", "桌宠状态尚未初始化。", false);
    }
    return this.state;
  }

  private save(next: PetStoredState, emit = true): void {
    this.states.save(next);
    this.state = next;
    if (emit) {
      for (const listener of this.listeners) listener();
    }
  }

  async initialize(): Promise<void> {
    const pets = await this.library.list();
    const saved = this.states.get();
    const activePetId = pets.some(({ id }) => id === saved?.activePetId)
      ? (saved?.activePetId ?? null)
      : (pets[0]?.id ?? null);
    const initial: PetStoredState = saved
      ? { ...saved, activePetId }
      : {
          activePetId,
          animationSpeed: 0.75,
          displayId: null,
          facing: "right",
          height: DEFAULT_HEIGHT,
          offsetX: 0,
          offsetY: 0,
          scale: 1,
          updatedAt: this.clock.now(),
          width: DEFAULT_WIDTH,
        };
    this.save(initial, false);
  }

  subscribe(listener: PetChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStoredState(): PetStoredState {
    return { ...this.requireState() };
  }

  async getLibrary(): Promise<PetLibrarySnapshot> {
    const state = this.requireState();
    const pets = await this.library.list();
    return {
      activePetId: pets.some(({ id }) => id === state.activePetId)
        ? state.activePetId
        : null,
      animationSpeed: state.animationSpeed,
      pets,
      scale: state.scale,
    };
  }

  async getCharacterSnapshot(): Promise<PetCharacterSnapshot> {
    const state = this.requireState();
    const pets = await this.library.list();
    return {
      activePet: pets.find(({ id }) => id === state.activePetId) ?? null,
      animation: this.runtimeAnimation,
      animationSpeed: state.animationSpeed,
      facing: state.facing,
      scale: state.scale,
    };
  }

  async importFrom(sourceDirectory: string): Promise<PetDescriptor> {
    const imported = await this.library.importFrom(sourceDirectory);
    this.save({
      ...this.requireState(),
      activePetId: imported.id,
      updatedAt: this.clock.now(),
    });
    return imported;
  }

  async select(petId: string): Promise<PetLibrarySnapshot> {
    const pets = await this.library.list();
    if (!pets.some(({ id }) => id === petId)) {
      throw new PetError("PET.NOT_FOUND", "找不到该桌宠。", false);
    }
    this.save({
      ...this.requireState(),
      activePetId: petId,
      updatedAt: this.clock.now(),
    });
    return this.getLibrary();
  }

  async setScale(scale: number): Promise<PetLibrarySnapshot> {
    this.save({
      ...this.requireState(),
      height: Math.round(DEFAULT_HEIGHT * scale),
      scale,
      updatedAt: this.clock.now(),
      width: Math.round(DEFAULT_WIDTH * scale),
    });
    return this.getLibrary();
  }

  async setAnimationSpeed(animationSpeed: number): Promise<PetLibrarySnapshot> {
    this.save({
      ...this.requireState(),
      animationSpeed,
      updatedAt: this.clock.now(),
    });
    return this.getLibrary();
  }

  setFacing(facing: PetFacing): void {
    const current = this.requireState();
    if (current.facing === facing) return;
    this.save({ ...current, facing, updatedAt: this.clock.now() });
  }

  setRuntimeAnimation(animation: PetAnimation): void {
    if (this.runtimeAnimation === animation) return;
    this.runtimeAnimation = animation;
    for (const listener of this.listeners) listener();
  }

  updatePlacement(
    placement: Pick<
      PetStoredState,
      "displayId" | "height" | "offsetX" | "offsetY" | "width"
    >,
  ): void {
    this.save(
      {
        ...this.requireState(),
        ...placement,
        updatedAt: this.clock.now(),
      },
      false,
    );
  }
}
