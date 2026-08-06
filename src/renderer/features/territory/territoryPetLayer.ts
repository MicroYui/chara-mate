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
import type { TerritoryActiveScene } from "../../../shared/contracts/territory";
import {
  getPetAtlasFrames,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
} from "../../character/petAtlas";
import { TERRITORY_TILE_SIZE } from "./territoryArt";

export interface RenderedPetPosition {
  readonly x: number;
  readonly y: number;
}

export interface TerritoryMovement {
  readonly id: number;
  readonly path: readonly RenderedPetPosition[];
}

interface TerritoryPetRuntime {
  readonly app: Application;
  root: Container | undefined;
  textures: Texture[];
  tickerCallback: (() => void) | undefined;
}

interface TerritoryPetLayerOptions {
  readonly animationSpeed: number;
  readonly movement: TerritoryMovement | null;
  readonly onMovementComplete: (movementId: number) => void;
  readonly onPetPositionChange: (position: RenderedPetPosition) => void;
  readonly pet: PetDescriptor | undefined;
  readonly root: Container;
  readonly runtime: TerritoryPetRuntime;
  readonly scene: TerritoryActiveScene;
}

const OBJECT_DEPTH_BASE = 10_000;

function reportPetPosition(
  runtime: TerritoryPetRuntime,
  movement: TerritoryMovement | null,
  position: RenderedPetPosition,
  onPetPositionChange: (position: RenderedPetPosition) => void,
): void {
  runtime.app.canvas.dataset["petGridX"] = String(position.x);
  runtime.app.canvas.dataset["petGridY"] = String(position.y);
  runtime.app.canvas.dataset["petMovementId"] = movement
    ? String(movement.id)
    : "idle";
  onPetPositionChange(position);
}

function reportPetFacing(
  runtime: TerritoryPetRuntime,
  facing: PetFacing,
): void {
  runtime.app.canvas.dataset["petFacing"] = facing;
}

function horizontalFacing(
  from: RenderedPetPosition,
  to: RenderedPetPosition,
): PetFacing | null {
  if (to.x === from.x) return null;
  return to.x < from.x ? "left" : "right";
}

function firstHorizontalFacing(
  path: readonly RenderedPetPosition[],
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

function lastHorizontalFacing(
  path: readonly RenderedPetPosition[],
  fallback: PetFacing,
): PetFacing {
  for (let index = path.length - 1; index > 0; index -= 1) {
    const previous = path[index - 1];
    const current = path[index];
    if (!previous || !current) continue;
    const facing = horizontalFacing(previous, current);
    if (facing) return facing;
  }
  return fallback;
}

export async function renderTerritoryPetLayer({
  animationSpeed,
  movement,
  onMovementComplete,
  onPetPositionChange,
  pet,
  root,
  runtime,
  scene,
}: TerritoryPetLayerOptions): Promise<void> {
  const path = movement?.path.length ? movement.path : [scene.pet];
  const first = path[0] ?? scene.pet;
  const petDepth = (position: RenderedPetPosition) =>
    OBJECT_DEPTH_BASE + (position.y + 1) * TERRITORY_TILE_SIZE + 0.5;
  if (!pet) {
    delete runtime.app.canvas.dataset["petFacing"];
    const glow = new Graphics()
      .circle(0, 0, 19)
      .fill({ alpha: 0.28, color: scene.definition.palette.accent });
    glow.circle(0, 0, 9).fill({ alpha: 0.9, color: "#fff2c3" });
    glow.position.set(
      (first.x + 0.5) * TERRITORY_TILE_SIZE,
      (first.y + 0.62) * TERRITORY_TILE_SIZE,
    );
    glow.zIndex = petDepth(first);
    root.addChild(glow);
    reportPetPosition(runtime, movement, first, onPetPositionChange);
    if (movement) onMovementComplete(movement.id);
    return;
  }

  const running = path.length > 1;
  let facing = firstHorizontalFacing(path, scene.pet.facing);
  const atlasTexture = await Assets.load<Texture>(pet.spriteUrl);
  if (runtime.root !== root) return;
  const createFrames = (
    animation: "idle" | "running-left" | "running-right",
  ): FrameObject[] => {
    const atlasFrames = getPetAtlasFrames(animation, pet.spriteVersionNumber);
    const textures = atlasFrames.map(
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
    runtime.textures.push(...textures);
    return textures.map((texture, index) => ({
      texture,
      time: atlasFrames[index]?.durationMs ?? 140,
    }));
  };
  const runningFrames: Record<PetFacing, FrameObject[]> | null = running
    ? {
        left: createFrames("running-left"),
        right: createFrames("running-right"),
      }
    : null;
  const frames = runningFrames ? runningFrames[facing] : createFrames("idle");
  const sprite = new AnimatedSprite({
    animationSpeed,
    autoPlay: frames.length > 1,
    loop: true,
    textures: frames,
  });
  sprite.anchor.set(0.5, 1);
  sprite.width = 82;
  sprite.height = 89;
  sprite.position.set(
    (first.x + 0.5) * TERRITORY_TILE_SIZE,
    (first.y + 1) * TERRITORY_TILE_SIZE,
  );
  sprite.zIndex = petDepth(first);
  root.addChild(sprite);
  reportPetFacing(runtime, facing);
  reportPetPosition(runtime, movement, first, onPetPositionChange);

  const setFacing = (nextFacing: PetFacing) => {
    if (facing === nextFacing || !runningFrames) return;
    const currentFrame = sprite.currentFrame;
    const wasPlaying = sprite.playing;
    facing = nextFacing;
    sprite.textures = runningFrames[nextFacing];
    const restoredFrame = Math.min(currentFrame, sprite.totalFrames - 1);
    if (wasPlaying) sprite.gotoAndPlay(restoredFrame);
    else sprite.gotoAndStop(restoredFrame);
    reportPetFacing(runtime, facing);
  };

  if (!movement || path.length <= 1) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      sprite.gotoAndStop(0);
    }
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const destination = path.at(-1) ?? first;
    setFacing(lastHorizontalFacing(path, facing));
    sprite.position.set(
      (destination.x + 0.5) * TERRITORY_TILE_SIZE,
      (destination.y + 1) * TERRITORY_TILE_SIZE,
    );
    sprite.zIndex = petDepth(destination);
    reportPetPosition(runtime, movement, destination, onPetPositionChange);
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
  const tick = () => {
    elapsed += runtime.app.ticker.deltaMS;
    const segment =
      segments.find(
        ({ duration, startsAt }) => elapsed < startsAt + duration,
      ) ?? segments.at(-1);
    if (!segment) return;
    const segmentFacing = horizontalFacing(segment.from, segment.to);
    if (segmentFacing) setFacing(segmentFacing);
    const progress = Math.min(
      1,
      Math.max(0, (elapsed - segment.startsAt) / segment.duration),
    );
    const position = {
      x: segment.from.x + (segment.to.x - segment.from.x) * progress,
      y: segment.from.y + (segment.to.y - segment.from.y) * progress,
    };
    sprite.position.set(
      (position.x + 0.5) * TERRITORY_TILE_SIZE,
      (position.y + 1) * TERRITORY_TILE_SIZE,
    );
    sprite.zIndex = petDepth(position);
    reportPetPosition(runtime, movement, position, onPetPositionChange);
    if (elapsed >= totalDuration) {
      runtime.app.ticker.remove(tick);
      runtime.tickerCallback = undefined;
      onMovementComplete(movement.id);
    }
  };
  runtime.tickerCallback = tick;
  runtime.app.ticker.add(tick);
}
