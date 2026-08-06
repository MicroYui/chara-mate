// Installs Pixi's static uniform synchronizers for a strict CSP (no unsafe-eval).
import "pixi.js/unsafe-eval";
import {
  AnimatedSprite,
  Application,
  Assets,
  Rectangle,
  Texture,
  type FrameObject,
} from "pixi.js";
import { useEffect, useRef, useState } from "react";

import type {
  PetAnimation,
  PetCharacterSnapshot,
} from "../../shared/contracts/pet";
import {
  animationLoops,
  getPetAtlasFrames,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
} from "./petAtlas";
import styles from "./CharacterApp.module.css";

interface PixiPetCanvasProps {
  readonly animation: PetAnimation;
  readonly animationSpeed: number;
  readonly lookAngleDegrees: number;
  readonly onReady: () => void;
  readonly pet: NonNullable<PetCharacterSnapshot["activePet"]>;
}

interface PixiRuntime {
  readonly app: Application;
  readonly host: HTMLDivElement;
  sprite: AnimatedSprite | undefined;
  textures: Texture[];
}

function destroyAnimation(runtime: PixiRuntime): void {
  if (runtime.sprite) {
    runtime.app.stage.removeChild(runtime.sprite);
    runtime.sprite.destroy();
    runtime.sprite = undefined;
  }
  for (const texture of runtime.textures) texture.destroy(false);
  runtime.textures = [];
}

function fitSprite(runtime: PixiRuntime): void {
  if (!runtime.sprite) return;
  runtime.sprite.width = runtime.app.screen.width;
  runtime.sprite.height = runtime.app.screen.height;
}

export function PixiPetCanvas({
  animation,
  animationSpeed,
  lookAngleDegrees,
  onReady,
  pet,
}: PixiPetCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<PixiRuntime | null>(null);
  const animationSpeedRef = useRef(animationSpeed);
  const [loadError, setLoadError] = useState<string | null>(null);
  const effectiveLookAngle =
    pet.spriteVersionNumber === 2 ? lookAngleDegrees : 0;
  const renderKey = `${pet.id}:${pet.spriteVersionNumber}:${animation}:${String(effectiveLookAngle)}`;
  const [readyKey, setReadyKey] = useState("");
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let initialized = false;
    const app = new Application();
    const resizeObserver = new ResizeObserver(() => {
      const runtime = runtimeRef.current;
      if (runtime?.app === app) fitSprite(runtime);
    });

    void app
      .init({
        antialias: false,
        autoDensity: true,
        backgroundAlpha: 0,
        preference: "webgl",
        resolution: window.devicePixelRatio,
        resizeTo: host,
      })
      .then(() => {
        initialized = true;
        if (cancelled) {
          app.destroy(true, { children: true });
          return;
        }
        host.append(app.canvas);
        runtimeRef.current = { app, host, sprite: undefined, textures: [] };
        setRuntimeGeneration((generation) => generation + 1);
        resizeObserver.observe(host);
        onReady();
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("无法初始化桌宠渲染器。");
        }
      });

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      const runtime = runtimeRef.current;
      if (runtime?.app === app) {
        destroyAnimation(runtime);
        runtimeRef.current = null;
      }
      if (initialized) app.destroy(true, { children: true });
    };
  }, [onReady]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    let cancelled = false;

    void Assets.load<Texture>(pet.spriteUrl)
      .then((atlasTexture) => {
        if (cancelled) return;
        destroyAnimation(runtime);
        const atlasFrames = getPetAtlasFrames(
          animation,
          pet.spriteVersionNumber,
          effectiveLookAngle,
        );
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
        const frames: FrameObject[] = textures.map((texture, index) => ({
          texture,
          time: atlasFrames[index]?.durationMs ?? 120,
        }));
        const reducedMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        const sprite = new AnimatedSprite({
          animationSpeed: animationSpeedRef.current,
          autoPlay: !reducedMotion && frames.length > 1,
          loop: animationLoops(animation),
          textures: frames,
        });
        runtime.textures = textures;
        runtime.sprite = sprite;
        runtime.app.stage.addChild(sprite);
        fitSprite(runtime);
        if (reducedMotion || frames.length === 1) sprite.gotoAndStop(0);
        setLoadError(null);
        setReadyKey(renderKey);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("无法读取桌宠 spritesheet。");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [animation, effectiveLookAngle, pet, renderKey, runtimeGeneration]);

  useEffect(() => {
    animationSpeedRef.current = animationSpeed;
    if (runtimeRef.current?.sprite) {
      runtimeRef.current.sprite.animationSpeed = animationSpeed;
    }
  }, [animationSpeed]);

  return (
    <div
      className={styles["canvasHost"]}
      data-pet-render-ready={readyKey === renderKey || undefined}
      ref={hostRef}
    >
      {loadError ? <span role="alert">{loadError}</span> : null}
    </div>
  );
}
