import { readFile } from "node:fs/promises";

import type {
  ActivityVisualLookupRequest,
  ActivityVisualLookupResult,
  ActivityActor,
  ActivityVisualMatch,
  ActivityVisualReference,
} from "../../shared/contracts/activity";
import type { JsonValue } from "../../shared/contracts/primitives";

export type ImageInputSource = string | { activity: ActivityVisualReference };
export const IMAGE_REFERENCE_TYPE = "charamate_image_reference";

export interface ActivityImageInputs {
  lookup(
    request: ActivityVisualLookupRequest,
    resourceBudget: { readonly maxReadBytes: number },
    signal?: AbortSignal,
  ): Promise<ActivityVisualLookupResult>;
  current(signal?: AbortSignal): Promise<ActivityVisualMatch | undefined>;
  resolve(
    reference: ActivityVisualReference,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly status: "available";
        readonly bytes: Buffer;
        readonly actor: ActivityActor;
        readonly startedAt: string;
      }
    | { readonly status: "unavailable"; readonly reason: string }
  >;
}

export function imageInputKey(source: ImageInputSource): string {
  return typeof source === "string" ? source : JSON.stringify(source);
}

export interface PreparedImageInput {
  readonly byteLength: number;
  readonly content: JsonValue;
  readonly height: number;
  readonly mediaType: "image/png";
  readonly width: number;
  readonly observation?: ActivityVisualMatch;
}

export interface ImageInputProvider {
  readonly activity?: ActivityImageInputs | undefined;
  prepare(
    source: ImageInputSource,
    signal?: AbortSignal,
  ): Promise<PreparedImageInput>;
}

export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageInputError";
  }
}

export class ElectronImageInputProvider implements ImageInputProvider {
  constructor(
    private readonly resolveSource: (
      source: string,
      signal?: AbortSignal,
    ) => Promise<string>,
    readonly activity?: ActivityImageInputs,
  ) {}

  async prepare(
    source: ImageInputSource,
    signal?: AbortSignal,
  ): Promise<PreparedImageInput> {
    signal?.throwIfAborted();
    let bytes: Buffer;
    let observation: ActivityVisualMatch | undefined;
    if (typeof source === "string") {
      const resolved = await this.resolveSource(source, signal);
      signal?.throwIfAborted();
      bytes = await readFile(resolved, signal ? { signal } : undefined);
    } else {
      if (!this.activity)
        throw new ImageInputError("当前环境无法读取活动画面。");
      const resolved = await this.activity.resolve(source.activity, signal);
      signal?.throwIfAborted();
      if (resolved.status !== "available")
        throw new ImageInputError(`活动画面不可用：${resolved.reason}。`);
      bytes = resolved.bytes;
      observation = {
        reference: source.activity,
        actor: resolved.actor,
        position: {
          startedAt: resolved.startedAt,
          eventId: source.activity.eventId,
        },
      };
    }
    signal?.throwIfAborted();
    const { nativeImage } = await import("electron");
    signal?.throwIfAborted();
    const decoded = nativeImage.createFromBuffer(bytes);
    if (decoded.isEmpty()) {
      throw new ImageInputError("无法解码这张图片，请改用 PNG 或 JPEG。");
    }
    const { height, width } = decoded.getSize(1);
    if (width < 1 || height < 1) {
      throw new ImageInputError("图片尺寸无效。");
    }

    // Provider detail=auto owns token-sensitive scaling. Main normalizes the
    // decoded representation to a single scale-factor PNG without inventing a
    // product-wide pixel cap that may conflict with the selected model.
    const encoded = decoded.toPNG({ scaleFactor: 1 });
    // Electron decoding/encoding is synchronous; cancellation is checked at
    // its boundaries, without claiming to preempt the native call itself.
    signal?.throwIfAborted();
    if (encoded.byteLength === 0) {
      throw new ImageInputError("图片编码失败。");
    }
    return {
      byteLength: encoded.byteLength,
      content: {
        detail: "auto",
        image_url: `data:image/png;base64,${encoded.toString("base64")}`,
        type: "input_image",
      },
      height,
      mediaType: "image/png",
      width,
      ...(observation ? { observation } : {}),
    };
  }
}
