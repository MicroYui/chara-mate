import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pixiMocks = vi.hoisted(() => {
  class MockAnimatedSprite {
    static readonly instances: MockAnimatedSprite[] = [];

    readonly anchor = { set: vi.fn() };
    currentFrame = 0;
    height = 0;
    readonly position = { set: vi.fn() };
    textureAssignments = 1;
    totalFrames: number;
    width = 0;
    zIndex = 0;
    private frameObjects: unknown[];

    constructor({ textures }: { readonly textures: unknown[] }) {
      this.frameObjects = textures;
      this.totalFrames = textures.length;
      MockAnimatedSprite.instances.push(this);
    }

    get textures(): unknown[] {
      return [...this.frameObjects];
    }

    get texture(): { readonly frame: { readonly y: number } } {
      const frame = this.frameObjects[this.currentFrame] as {
        readonly texture: { readonly frame: { readonly y: number } };
      };
      return frame.texture;
    }

    set textures(value: unknown[]) {
      this.frameObjects = value;
      this.totalFrames = value.length;
      this.textureAssignments += 1;
    }

    readonly destroy = vi.fn();
    readonly gotoAndPlay = vi.fn((frame: number) => {
      this.currentFrame = frame;
    });
    readonly gotoAndStop = vi.fn((frame: number) => {
      this.currentFrame = frame;
    });
    readonly removeFromParent = vi.fn();
  }

  class MockTexture {
    readonly frame: { readonly y: number };
    readonly source: unknown;

    constructor(
      options: {
        readonly frame?: { readonly y: number };
        readonly source?: unknown;
      } = {},
    ) {
      this.frame = options.frame ?? { y: 0 };
      this.source = options.source ?? {};
    }

    readonly destroy = vi.fn();
  }

  class MockGraphics {
    circle(): this {
      return this;
    }

    destroy(): void {}

    fill(): this {
      return this;
    }

    removeFromParent(): void {}

    readonly position = { set: vi.fn() };
    zIndex = 0;
  }

  class MockRectangle {
    readonly x: number;
    readonly y: number;

    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }
  }

  return { MockAnimatedSprite, MockGraphics, MockRectangle, MockTexture };
});

vi.mock("pixi.js", () => ({
  AnimatedSprite: pixiMocks.MockAnimatedSprite,
  Assets: {
    load: vi.fn(() =>
      Promise.resolve(new pixiMocks.MockTexture({ source: {} })),
    ),
  },
  Graphics: pixiMocks.MockGraphics,
  Rectangle: pixiMocks.MockRectangle,
  Texture: pixiMocks.MockTexture,
}));

import type { PetDescriptor } from "../../../shared/contracts/pet";
import type { TerritoryPetState } from "../../../shared/contracts/territoryWorld";
import {
  renderTerritoryWorldPetLayer,
  type TerritoryWorldPetRuntime,
} from "./territoryWorldPetLayer";

const pet: PetDescriptor = {
  description: "测试桌宠",
  displayName: "测试桌宠",
  id: "test-pet",
  spriteHeight: 2288,
  spriteUrl: "chara-mate-pet://test-pet/spritesheet.png",
  spriteVersionNumber: 2,
  spriteWidth: 1536,
};

const initialPetState: TerritoryPetState = {
  behavior: "idle",
  facing: "right",
  point: { x: 0, y: 0 },
  updatedAt: "2026-08-14T00:00:00.000Z",
  zoneId: "10000000-0000-4000-8000-000000000001",
};

describe("Territory World pet animation", () => {
  beforeEach(() => {
    pixiMocks.MockAnimatedSprite.instances.length = 0;
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("switches out of idle for same-facing and vertical movement", async () => {
    const callbacks = new Set<() => void>();
    const canvas = { dataset: {} as Record<string, string> };
    const root = { addChild: vi.fn() };
    const runtime = {
      app: {
        canvas,
        ticker: {
          add: (callback: () => void) => callbacks.add(callback),
          deltaMS: 16,
          remove: (callback: () => void) => callbacks.delete(callback),
        },
      },
      petController: undefined,
      root,
    } as unknown as TerritoryWorldPetRuntime;
    const controller = await renderTerritoryWorldPetLayer({
      accent: "#ffffff",
      animationSpeed: 1,
      initialPosition: initialPetState.point,
      onMovementComplete: vi.fn(),
      onPetPositionChange: vi.fn(),
      pet,
      root: root as never,
      runtime,
    });
    const sprite = pixiMocks.MockAnimatedSprite.instances.at(-1);

    expect(sprite).toBeDefined();
    expect(canvas.dataset["petAnimation"]).toBe("idle");
    expect(canvas.dataset["petTextureRow"]).toBe("0");
    expect(sprite?.textureAssignments).toBe(1);

    controller.retarget(
      {
        id: 1,
        path: [initialPetState.point, { x: 2, y: 0 }],
      },
      { ...initialPetState, point: { x: 2, y: 0 } },
    );
    expect(canvas.dataset["petAnimation"]).toBe("running-right");
    expect(canvas.dataset["petTextureRow"]).toBe("1");
    expect(sprite?.textureAssignments).toBe(2);

    controller.retarget(null, {
      ...initialPetState,
      point: { x: 2, y: 0 },
    });
    expect(canvas.dataset["petAnimation"]).toBe("idle");
    expect(canvas.dataset["petTextureRow"]).toBe("0");

    controller.retarget(
      {
        id: 2,
        path: [
          { x: 2, y: 0 },
          { x: 2, y: 2 },
        ],
      },
      { ...initialPetState, point: { x: 2, y: 2 } },
    );
    expect(canvas.dataset["petAnimation"]).toBe("running-right");
    expect(canvas.dataset["petTextureRow"]).toBe("1");
    expect(sprite?.textureAssignments).toBe(4);

    controller.destroy();
  });
});
