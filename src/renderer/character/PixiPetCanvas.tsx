// Installs Pixi's static uniform synchronizers for a strict CSP (no unsafe-eval).
import "pixi.js/unsafe-eval";
import {
  AnimatedSprite,
  Application,
  Assets,
  Rectangle,
  Texture,
  type FrameObject,
  type Ticker,
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

const PET_RENDER_FPS = 15;

interface PixiPetCanvasProps {
  readonly animation: PetAnimation;
  readonly animationSpeed: number;
  readonly lookAngleDegrees: number;
  readonly onReady: () => void;
  readonly pet: NonNullable<PetCharacterSnapshot["activePet"]>;
}

interface PixiRuntime {
  readonly app: Application;
  readonly animations: Map<string, CachedAnimation>;
  readonly handleVisibilityChange: () => void;
  readonly host: HTMLDivElement;
  atlasUrl: string | undefined;
  renderTimer: number | undefined;
  sprite: AnimatedSprite | undefined;
  readonly updateAnimation: (ticker: Ticker) => void;
}

interface CachedAnimation {
  readonly frames: FrameObject[];
  readonly textures: Texture[];
}

function destroySprite(runtime: PixiRuntime): void {
  if (runtime.sprite) {
    runtime.app.stage.removeChild(runtime.sprite);
    runtime.sprite.destroy();
    runtime.sprite = undefined;
  }
}

function destroyAnimations(runtime: PixiRuntime): void {
  for (const animation of runtime.animations.values()) {
    for (const texture of animation.textures) texture.destroy(false);
  }
  runtime.animations.clear();
}

function destroyRuntime(runtime: PixiRuntime): void {
  document.removeEventListener(
    "visibilitychange",
    runtime.handleVisibilityChange,
  );
  stopRendering(runtime);
  runtime.app.ticker.remove(runtime.updateAnimation);
  destroySprite(runtime);
  destroyAnimations(runtime);
}

function startRendering(runtime: PixiRuntime): void {
  if (runtime.renderTimer !== undefined || document.hidden) return;
  runtime.app.ticker.update(performance.now());
  runtime.renderTimer = window.setInterval(() => {
    runtime.app.ticker.update(performance.now());
  }, 1_000 / PET_RENDER_FPS);
}

function stopRendering(runtime: PixiRuntime): void {
  if (runtime.renderTimer === undefined) return;
  window.clearInterval(runtime.renderTimer);
  runtime.renderTimer = undefined;
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
        autoStart: false,
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
        const runtime: PixiRuntime = {
          animations: new Map(),
          app,
          atlasUrl: undefined,
          handleVisibilityChange: () => {
            if (document.hidden) stopRendering(runtime);
            else startRendering(runtime);
          },
          host,
          renderTimer: undefined,
          sprite: undefined,
          updateAnimation: (ticker) => runtime.sprite?.update(ticker),
        };
        app.ticker.add(runtime.updateAnimation);
        document.addEventListener(
          "visibilitychange",
          runtime.handleVisibilityChange,
        );
        startRendering(runtime);
        runtimeRef.current = runtime;
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
        destroyRuntime(runtime);
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
        if (runtime.atlasUrl !== pet.spriteUrl) {
          destroySprite(runtime);
          destroyAnimations(runtime);
          runtime.atlasUrl = pet.spriteUrl;
        }
        const atlasFrames = getPetAtlasFrames(
          animation,
          pet.spriteVersionNumber,
          effectiveLookAngle,
        );
        const animationKey = `${pet.spriteVersionNumber}:${animation}:${String(effectiveLookAngle)}`;
        let cached = runtime.animations.get(animationKey);
        if (!cached) {
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
          cached = {
            frames: textures.map((texture, index) => ({
              texture,
              time: atlasFrames[index]?.durationMs ?? 120,
            })),
            textures,
          };
          runtime.animations.set(animationKey, cached);
        }
        const reducedMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        let sprite = runtime.sprite;
        if (!sprite) {
          sprite = new AnimatedSprite({
            animationSpeed: animationSpeedRef.current,
            autoPlay: false,
            autoUpdate: false,
            loop: animationLoops(animation),
            textures: cached.frames,
          });
          runtime.sprite = sprite;
          runtime.app.stage.addChild(sprite);
        } else {
          sprite.stop();
          sprite.textures = cached.frames;
          sprite.animationSpeed = animationSpeedRef.current;
          sprite.loop = animationLoops(animation);
        }
        fitSprite(runtime);
        sprite.gotoAndStop(0);
        if (!reducedMotion && cached.frames.length > 1) sprite.play();
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
  }, [
    animation,
    effectiveLookAngle,
    pet.id,
    pet.spriteUrl,
    pet.spriteVersionNumber,
    renderKey,
    runtimeGeneration,
  ]);

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
