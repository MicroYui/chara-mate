import {
  AnimatedSprite,
  Assets,
  Graphics,
  Rectangle,
  Texture,
  type Application,
  type Container,
  type FrameObject,
} from "pixi.js";

import type { PetDescriptor, PetFacing } from "../../../shared/contracts/pet";
import type { TerritoryPetState } from "../../../shared/contracts/territoryWorld";
import { TERRITORY_WORLD_UNIT_PX } from "../../../shared/pure/territoryWorldScale";
import {
  getPetAtlasFrames,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
} from "../../character/petAtlas";
import { territoryWorldSortedDepth } from "./territoryWorldDepth";

export interface TerritoryWorldMovement {
  readonly id: number;
  readonly path: readonly TerritoryWorldRenderedPetPosition[];
}

export interface TerritoryWorldRenderedPetPosition {
  readonly x: number;
  readonly y: number;
}

type TerritoryWorldPetAnimation = "idle" | "running-left" | "running-right";

export interface TerritoryWorldPetController {
  destroy(): void;
  retarget(
    movement: TerritoryWorldMovement | null,
    petState: TerritoryPetState,
  ): void;
}

export interface TerritoryWorldPetRuntime {
  readonly app: Application;
  petController: TerritoryWorldPetController | undefined;
  root: Container | undefined;
}

interface TerritoryWorldPetLayerOptions {
  readonly accent: string;
  readonly animationSpeed: number;
  readonly initialPosition: TerritoryWorldRenderedPetPosition;
  readonly onMovementComplete: (movementId: number) => void;
  readonly onPetPositionChange: (
    position: TerritoryWorldRenderedPetPosition,
  ) => void;
  readonly pet: PetDescriptor | undefined;
  readonly root: Container;
  readonly runtime: TerritoryWorldPetRuntime;
}

function reportPosition(
  runtime: TerritoryWorldPetRuntime,
  movementId: number | null,
  position: TerritoryWorldRenderedPetPosition,
  callback: (position: TerritoryWorldRenderedPetPosition) => void,
): void {
  runtime.app.canvas.dataset["petGridX"] = String(position.x);
  runtime.app.canvas.dataset["petGridY"] = String(position.y);
  runtime.app.canvas.dataset["petMovementId"] =
    movementId === null ? "idle" : String(movementId);
  callback(position);
}

function horizontalFacing(
  from: TerritoryWorldRenderedPetPosition,
  to: TerritoryWorldRenderedPetPosition,
): PetFacing | null {
  if (from.x === to.x) return null;
  return to.x < from.x ? "left" : "right";
}

function firstFacing(
  path: readonly TerritoryWorldRenderedPetPosition[],
  fallback: PetFacing,
): PetFacing {
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    if (!previous || !current) continue;
    const facing = horizontalFacing(previous, current);
    if (facing) return facing;
  }
  return fallback;
}

function petDepth(position: TerritoryWorldRenderedPetPosition): number {
  return territoryWorldSortedDepth((position.y + 1) * TERRITORY_WORLD_UNIT_PX);
}

function continuousPath(
  current: TerritoryWorldRenderedPetPosition,
  movement: TerritoryWorldMovement,
  petState: TerritoryPetState,
): readonly TerritoryWorldRenderedPetPosition[] {
  const tail = movement.path.slice(1);
  if (tail.length > 0) return [{ ...current }, ...tail];
  return [{ ...current }, { ...petState.point }];
}

export async function renderTerritoryWorldPetLayer({
  accent,
  animationSpeed,
  initialPosition,
  onMovementComplete,
  onPetPositionChange,
  pet,
  root,
  runtime,
}: TerritoryWorldPetLayerOptions): Promise<TerritoryWorldPetController> {
  if (!pet) {
    let destroyed = false;
    let currentPosition = { ...initialPosition };
    const glow = new Graphics()
      .circle(0, 0, 19)
      .fill({ alpha: 0.3, color: accent })
      .circle(0, 0, 9)
      .fill({ alpha: 0.94, color: "#fff2c3" });
    const applyPosition = (
      position: TerritoryWorldRenderedPetPosition,
      movementId: number | null,
    ) => {
      currentPosition = { ...position };
      glow.position.set(
        (position.x + 0.5) * TERRITORY_WORLD_UNIT_PX,
        (position.y + 0.72) * TERRITORY_WORLD_UNIT_PX,
      );
      glow.zIndex = petDepth(position);
      reportPosition(runtime, movementId, position, onPetPositionChange);
    };
    root.addChild(glow);
    applyPosition(currentPosition, null);
    return {
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        glow.removeFromParent();
        glow.destroy();
      },
      retarget: (movement, petState) => {
        if (destroyed) return;
        if (!movement) {
          applyPosition(petState.point, null);
          return;
        }
        const destination = movement.path.at(-1) ?? petState.point;
        applyPosition(destination, movement.id);
        onMovementComplete(movement.id);
      },
    };
  }

  const atlasTexture = await Assets.load<Texture>(pet.spriteUrl);
  if (runtime.root !== root) {
    return {
      destroy: () => undefined,
      retarget: () => undefined,
    };
  }

  const textures: Texture[] = [];
  const createFrames = (
    animation: "idle" | "running-left" | "running-right",
  ): FrameObject[] => {
    const atlasFrames = getPetAtlasFrames(animation, pet.spriteVersionNumber);
    const nextTextures = atlasFrames.map(
      ({ column, row }) =>
        new Texture({
          frame: new Rectangle(
            column * PET_CELL_WIDTH,
            row * PET_CELL_HEIGHT,
            PET_CELL_WIDTH,
            PET_CELL_HEIGHT,
          ),
          source: atlasTexture.source,
        }),
    );
    textures.push(...nextTextures);
    return nextTextures.map((texture, index) => ({
      texture,
      time: atlasFrames[index]?.durationMs ?? 140,
    }));
  };
  const idleFrames = createFrames("idle");
  const runningFrames: Record<PetFacing, FrameObject[]> = {
    left: createFrames("running-left"),
    right: createFrames("running-right"),
  };
  const sprite = new AnimatedSprite({
    animationSpeed,
    autoPlay: true,
    loop: true,
    textures: idleFrames,
  });
  sprite.anchor.set(0.5, 1);
  sprite.width = 82;
  sprite.height = 89;
  root.addChild(sprite);

  let currentPosition = { ...initialPosition };
  let currentFacing: PetFacing = "right";
  let currentAnimation: TerritoryWorldPetAnimation = "idle";
  let currentMovementId: number | null = null;
  let destroyed = false;
  let tickerCallback: (() => void) | null = null;
  runtime.app.canvas.dataset["petAnimation"] = currentAnimation;

  const stopTicker = () => {
    if (!tickerCallback) return;
    runtime.app.ticker.remove(tickerCallback);
    tickerCallback = null;
  };
  const reportTextureRow = () => {
    runtime.app.canvas.dataset["petTextureRow"] = String(
      Math.round(sprite.texture.frame.y / PET_CELL_HEIGHT),
    );
  };
  const setFrames = (frames: FrameObject[]) => {
    const frame = sprite.currentFrame;
    sprite.textures = frames;
    sprite.gotoAndPlay(Math.min(frame, sprite.totalFrames - 1));
    reportTextureRow();
  };
  // Pixi normalizes assigned frame lists, so texture-array identity cannot
  // reliably tell whether the sprite is still showing idle frames.
  const setAnimation = (next: TerritoryWorldPetAnimation) => {
    if (currentAnimation === next) return;
    currentAnimation = next;
    setFrames(next === "idle" ? idleFrames : runningFrames[currentFacing]);
    runtime.app.canvas.dataset["petAnimation"] = next;
  };
  const setFacing = (next: PetFacing, running: boolean) => {
    currentFacing = next;
    setAnimation(running ? `running-${next}` : "idle");
    runtime.app.canvas.dataset["petFacing"] = next;
  };
  const applyPosition = (
    position: TerritoryWorldRenderedPetPosition,
    movementId: number | null,
  ) => {
    currentPosition = { ...position };
    currentMovementId = movementId;
    sprite.position.set(
      (position.x + 0.5) * TERRITORY_WORLD_UNIT_PX,
      (position.y + 1) * TERRITORY_WORLD_UNIT_PX,
    );
    sprite.zIndex = petDepth(position);
    reportTextureRow();
    reportPosition(runtime, movementId, position, onPetPositionChange);
  };
  const settle = (petState: TerritoryPetState) => {
    stopTicker();
    setFacing(petState.facing, false);
    applyPosition(petState.point, null);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      sprite.gotoAndStop(0);
    }
  };

  currentFacing = "right";
  setFacing(currentFacing, false);
  applyPosition(currentPosition, null);

  return {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      stopTicker();
      sprite.removeFromParent();
      sprite.destroy();
      for (const texture of textures) texture.destroy(false);
    },
    retarget: (movement, petState) => {
      if (destroyed) return;
      if (!movement) {
        settle(petState);
        return;
      }
      if (movement.id === currentMovementId) return;
      stopTicker();
      const path = continuousPath(currentPosition, movement, petState);
      let facing = firstFacing(path, petState.facing);
      setFacing(facing, true);
      applyPosition(currentPosition, movement.id);

      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const destination = path.at(-1) ?? currentPosition;
        facing = firstFacing([...path].reverse(), facing);
        setFacing(facing, true);
        applyPosition(destination, movement.id);
        onMovementComplete(movement.id);
        return;
      }

      const segmentDuration = 180 / Math.max(0.1, animationSpeed);
      let totalDuration = 0;
      const segments = path.slice(0, -1).map((from, index) => {
        const to = path[index + 1] ?? from;
        const duration =
          segmentDuration *
          Math.max(Math.abs(to.x - from.x) + Math.abs(to.y - from.y), 0.001);
        const startsAt = totalDuration;
        totalDuration += duration;
        return { duration, from, startsAt, to };
      });
      let elapsed = 0;
      tickerCallback = () => {
        elapsed += runtime.app.ticker.deltaMS;
        const segment =
          segments.find(
            ({ duration, startsAt }) => elapsed < startsAt + duration,
          ) ?? segments.at(-1);
        if (!segment) return;
        const nextFacing = horizontalFacing(segment.from, segment.to);
        if (nextFacing) setFacing(nextFacing, true);
        const progress = Math.min(
          1,
          Math.max(0, (elapsed - segment.startsAt) / segment.duration),
        );
        const position = {
          x: segment.from.x + (segment.to.x - segment.from.x) * progress,
          y: segment.from.y + (segment.to.y - segment.from.y) * progress,
        };
        applyPosition(position, movement.id);
        if (elapsed >= totalDuration) {
          stopTicker();
          onMovementComplete(movement.id);
        }
      };
      runtime.app.ticker.add(tickerCallback);
    },
  };
}
