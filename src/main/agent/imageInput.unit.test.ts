import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityVisualReference } from "../../shared/contracts/activity";
import {
  visualPngFixture,
  visualSurfaceFixture,
} from "../activity/activityVisual.fixture";
import {
  ElectronImageInputProvider,
  ImageInputError,
  type ActivityImageInputs,
} from "./imageInput";

const electron = vi.hoisted(() => {
  const decoded = {
    isEmpty: vi.fn<() => boolean>(),
    getSize:
      vi.fn<(scaleFactor?: number) => { width: number; height: number }>(),
    toPNG: vi.fn<(options?: { scaleFactor: number }) => Buffer>(),
  };
  return {
    decoded,
    createFromBuffer: vi.fn<(bytes: Buffer) => typeof decoded>(),
  };
});

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: electron.createFromBuffer },
}));

// Every read calls the real filesystem. One test delays delivery of its actual
// result to put cancellation deterministically inside the asynchronous read.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const directories: string[] = [];
let imagePath: string;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function reference(): ActivityVisualReference {
  return {
    eventId: "10000000-0000-4000-8000-000000000001",
    artifactId: "20000000-0000-4000-8000-000000000001",
    contentRevision: createHash("sha256")
      .update(visualPngFixture)
      .digest("hex"),
    surface: visualSurfaceFixture,
    capturedAt: "2026-08-10T12:00:00.000Z",
    width: 1,
    height: 1,
    trigger: "frame",
  };
}

function activityInputs(resolve: ActivityImageInputs["resolve"]) {
  return {
    resolve: vi.fn(resolve),
    lookup: vi
      .fn<ActivityImageInputs["lookup"]>()
      .mockRejectedValue(
        new Error("prepare must not search for another frame"),
      ),
    current: vi
      .fn<ActivityImageInputs["current"]>()
      .mockRejectedValue(
        new Error("prepare must not select another current frame"),
      ),
  } satisfies ActivityImageInputs;
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
  electron.createFromBuffer.mockReset().mockReturnValue(electron.decoded);
  electron.decoded.isEmpty.mockReset().mockReturnValue(false);
  electron.decoded.getSize.mockReset().mockReturnValue({ width: 1, height: 1 });
  electron.decoded.toPNG
    .mockReset()
    .mockReturnValue(Buffer.from(visualPngFixture));
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "charamate-image-"),
  );
  directories.push(directory);
  imagePath = path.join(directory, "actual.png");
  await fs.writeFile(imagePath, visualPngFixture);
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("Electron image input", () => {
  it("reads the resolved local PNG bytes and keeps a normal source free of Activity provenance", async () => {
    const resolve = vi.fn<
      ConstructorParameters<typeof ElectronImageInputProvider>[0]
    >(() => Promise.resolve(imagePath));
    const controller = new AbortController();
    const provider = new ElectronImageInputProvider(resolve);
    const encoded = Buffer.from("mocked Electron encoding output");
    electron.decoded.toPNG.mockReturnValue(encoded);

    const prepared = await provider.prepare(
      "relative/canvas.png",
      controller.signal,
    );

    expect(resolve).toHaveBeenCalledWith(
      "relative/canvas.png",
      controller.signal,
    );
    expect(fs.readFile).toHaveBeenCalledWith(imagePath, {
      signal: controller.signal,
    });
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(1);
    expect(electron.createFromBuffer).toHaveBeenCalledWith(visualPngFixture);
    expect(electron.decoded.toPNG).toHaveBeenCalledWith({ scaleFactor: 1 });
    expect(prepared).toEqual({
      byteLength: encoded.length,
      content: {
        type: "input_image",
        detail: "auto",
        image_url: `data:image/png;base64,${encoded.toString("base64")}`,
      },
      width: 1,
      height: 1,
      mediaType: "image/png",
    });
  });

  it("does not resolve or read a local source when already cancelled", async () => {
    const resolve = vi.fn(() => Promise.resolve(imagePath));
    const controller = new AbortController();
    controller.abort();

    await expect(
      new ElectronImageInputProvider(resolve).prepare(
        imagePath,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(resolve).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(electron.createFromBuffer).not.toHaveBeenCalled();
  });

  it("passes cancellation into an actual file read and never decodes a late result", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const entered = gate();
    const releaseRead = gate();
    vi.mocked(fs.readFile).mockImplementationOnce(async (file, options) => {
      const read = actual.readFile(file, options);
      entered.release();
      try {
        return await read;
      } finally {
        await releaseRead.promise;
      }
    });
    const controller = new AbortController();
    const provider = new ElectronImageInputProvider((source) =>
      Promise.resolve(source),
    );
    const pending = provider.prepare(imagePath, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      await entered.promise;
      controller.abort();
    } finally {
      releaseRead.release();
    }
    await rejected;

    expect(fs.readFile).toHaveBeenCalledWith(imagePath, {
      signal: controller.signal,
    });
    expect(electron.createFromBuffer).not.toHaveBeenCalled();
  });

  it("decodes exact Activity resolver bytes through the same decoder and preserves owner provenance", async () => {
    const source = reference();
    const startedAt = "2026-08-10T12:00:00.005Z";
    const activity = activityInputs(async () => ({
      status: "available",
      bytes: await fs.readFile(imagePath),
      actor: "unknown",
      startedAt,
    }));
    const resolveLocal = vi.fn(() => Promise.resolve(imagePath));
    const controller = new AbortController();
    const provider = new ElectronImageInputProvider(resolveLocal, activity);
    const prepared = await provider.prepare(
      { activity: source },
      controller.signal,
    );

    expect(activity.resolve).toHaveBeenCalledWith(source, controller.signal);
    expect(resolveLocal).not.toHaveBeenCalled();
    expect(activity.lookup).not.toHaveBeenCalled();
    expect(activity.current).not.toHaveBeenCalled();
    expect(electron.createFromBuffer).toHaveBeenCalledTimes(1);
    expect(electron.createFromBuffer).toHaveBeenCalledWith(visualPngFixture);
    expect(prepared).toMatchObject({
      byteLength: visualPngFixture.length,
      width: 1,
      height: 1,
      content: {
        image_url: `data:image/png;base64,${visualPngFixture.toString("base64")}`,
      },
      observation: {
        reference: source,
        actor: "unknown",
        position: { eventId: source.eventId, startedAt },
      },
    });
  });

  it("rejects an Activity resolution that becomes available after cancellation", async () => {
    const entered = gate();
    const releaseResolver = gate();
    const activity = activityInputs(async () => {
      entered.release();
      await releaseResolver.promise;
      return {
        status: "available",
        bytes: await fs.readFile(imagePath),
        actor: "user",
        startedAt: reference().capturedAt,
      };
    });
    const controller = new AbortController();
    const provider = new ElectronImageInputProvider(
      () => Promise.resolve(imagePath),
      activity,
    );
    const pending = provider.prepare(
      { activity: reference() },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      await entered.promise;
      controller.abort();
    } finally {
      releaseResolver.release();
    }
    await rejected;
    expect(electron.createFromBuffer).not.toHaveBeenCalled();
    expect(activity.resolve).toHaveBeenCalledTimes(1);
  });

  it("preserves an Activity resolver failure without retrying or decoding", async () => {
    const error = new Error("Activity read failed");
    const activity = activityInputs(() => Promise.reject(error));
    const provider = new ElectronImageInputProvider(
      () => Promise.resolve(imagePath),
      activity,
    );

    await expect(provider.prepare({ activity: reference() })).rejects.toBe(
      error,
    );
    expect(activity.resolve).toHaveBeenCalledTimes(1);
    expect(electron.createFromBuffer).not.toHaveBeenCalled();
  });

  it("reports source_changed instead of reading a substitute local image or current frame", async () => {
    const activity = activityInputs(() =>
      Promise.resolve({ status: "unavailable", reason: "source_changed" }),
    );
    const resolveLocal = vi.fn(() => Promise.resolve(imagePath));
    const provider = new ElectronImageInputProvider(resolveLocal, activity);

    await expect(provider.prepare({ activity: reference() })).rejects.toEqual(
      new ImageInputError("活动画面不可用：source_changed。"),
    );
    expect(resolveLocal).not.toHaveBeenCalled();
    expect(activity.lookup).not.toHaveBeenCalled();
    expect(activity.current).not.toHaveBeenCalled();
    expect(electron.createFromBuffer).not.toHaveBeenCalled();
  });

  it("keeps an actual missing-file failure rather than producing image content", async () => {
    const missing = path.join(path.dirname(imagePath), "missing.png");
    const provider = new ElectronImageInputProvider(() =>
      Promise.resolve(missing),
    );

    await expect(provider.prepare("missing.png")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(electron.createFromBuffer).not.toHaveBeenCalled();
  });

  it("does not return successful image content after cancellation during synchronous encoding", async () => {
    const controller = new AbortController();
    electron.decoded.toPNG.mockImplementation(() => {
      controller.abort();
      return Buffer.from(visualPngFixture);
    });
    const provider = new ElectronImageInputProvider(() =>
      Promise.resolve(imagePath),
    );

    await expect(
      provider.prepare(imagePath, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(electron.decoded.toPNG).toHaveBeenCalledTimes(1);
    // The native call ran to completion; this proves no late success, not
    // preemption of Electron's synchronous native work.
  });

  it.each([
    {
      name: "undecodable image",
      configure: () => electron.decoded.isEmpty.mockReturnValue(true),
      message: "无法解码这张图片，请改用 PNG 或 JPEG。",
    },
    {
      name: "invalid dimensions",
      configure: () =>
        electron.decoded.getSize.mockReturnValue({ width: 0, height: 1 }),
      message: "图片尺寸无效。",
    },
    {
      name: "empty PNG encoding",
      configure: () => electron.decoded.toPNG.mockReturnValue(Buffer.alloc(0)),
      message: "图片编码失败。",
    },
  ])(
    "rejects $name rather than returning a usable image",
    async ({ configure, message }) => {
      configure();
      const provider = new ElectronImageInputProvider(() =>
        Promise.resolve(imagePath),
      );
      await expect(provider.prepare(imagePath)).rejects.toEqual(
        new ImageInputError(message),
      );
    },
  );
});
