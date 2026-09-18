import { webcrypto } from "node:crypto";
import { access, readFile } from "node:fs/promises";

import { isDeepStrictEqual } from "node:util";

import type {
  ActivityActor,
  ActivityEvent,
  ActivitySurface,
  ActivityVisual,
  ActivityVisualReference,
} from "../../shared/contracts/activity";
import {
  ActivityVisualReferenceSchema,
  ActivityVisualSchema,
} from "../../shared/schemas/activity";
import { parseSchema } from "../../shared/schemas/validation";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { redactText } from "../../shared/pure/redaction";
import type { ActivityAssetStore } from "./activityAssetStore";
import type { ActivityRepository } from "./activityRepository";

/** Native pixels live only in the bounded capture working set until consumed. */
export interface ActivityVisualFrame {
  readonly actor: "agent" | "user" | "unknown";
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly visual: ActivityVisual;
}

export interface ActivityVisualContext {
  readonly actor: ActivityActor;
  readonly surface: ActivitySurface;
  readonly eventId: string;
}

export interface ActivityVisualObservation {
  readonly event: ActivityEvent & {
    readonly details: Extract<
      ActivityEvent["details"],
      { source: "screenshot" }
    > & { readonly visual: ActivityVisual };
  };
  readonly reference: ActivityVisualReference;
}

export type ActivityVisualResolution =
  | {
      readonly status: "available";
      readonly reference: ActivityVisualReference;
      readonly actor: ActivityActor;
      readonly startedAt: string;
      readonly bytes: Buffer;
      readonly mediaType: "image/png";
      readonly ocr: ActivityVisual["ocr"];
    }
  | {
      readonly status: "unavailable";
      readonly reason: "source_missing" | "source_changed" | "asset_missing";
    };

export async function visualContentRevision(bytes: Buffer): Promise<string> {
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes),
  );
  return Buffer.from(digest).toString("hex");
}

export function sameVisualSurface(
  a: ActivitySurface,
  b: ActivitySurface,
): boolean {
  return a.id === b.id && a.epoch === b.epoch && isDeepStrictEqual(a, b);
}

export function visualReference(
  event: ActivityEvent,
): ActivityVisualReference | undefined {
  const detail = event.details;
  if (detail.source !== "screenshot" || !detail.visual) return undefined;
  return {
    eventId: event.id,
    artifactId: detail.artifactId,
    contentRevision: detail.visual.contentRevision,
    surface: detail.visual.surface,
    capturedAt: detail.visual.capturedAt,
    width: detail.width,
    height: detail.height,
    trigger: detail.visual.trigger,
  };
}

/** Activity owns source validation, one latest frame and asset retention. */
export class ActivityVisualEvidence {
  #context: ActivityVisualContext | undefined;
  #latest: ActivityVisualFrame | undefined;
  #observation: ActivityVisualObservation | undefined;
  #generation = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repository: ActivityRepository,
    private readonly assets: ActivityAssetStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly paused: () => boolean,
    private readonly publish: (event: ActivityEvent) => void,
  ) {}

  setContext(context: ActivityVisualContext | undefined): void {
    if (
      context &&
      this.#context &&
      context.actor === this.#context.actor &&
      sameVisualSurface(context.surface, this.#context.surface)
    ) {
      this.#context = context;
      return;
    }
    this.#context = context;
    this.#latest = undefined;
    this.#observation = undefined;
    this.#generation += 1;
  }

  matchesSource(surface: ActivitySurface, actor: ActivityActor): boolean {
    return (
      !this.paused() &&
      this.#context?.actor === actor &&
      sameVisualSurface(this.#context.surface, surface)
    );
  }

  stage(frame: ActivityVisualFrame): boolean {
    if (!this.current(frame)) return false;
    parseSchema(ActivityVisualSchema, frame.visual);
    // A capture producer must redact OCR and its pixels together before staging.
    const text = frame.visual.ocr.lines.map((line) => line.text).join("\n");
    if (redactText(text) !== text)
      throw new Error("Visual OCR was not redacted before staging");
    if (this.#latest && frame.visual.sequence <= this.#latest.visual.sequence)
      return (
        frame.visual.sequence === this.#latest.visual.sequence &&
        frame.visual.contentRevision === this.#latest.visual.contentRevision
      );
    this.#latest = frame;
    return true;
  }

  /** Serialize asset writes, reuse and reclamation through the existing owner. */
  serializeAssets<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#queue.then(operation);
    this.#queue = task.catch(() => undefined);
    return task;
  }

  async consume(
    trigger: ActivityVisual["trigger"] = "frame",
    signal?: AbortSignal,
    notify = false,
  ): Promise<ActivityVisualObservation | undefined> {
    signal?.throwIfAborted();
    const frame = this.#latest;
    const context = this.#context;
    if (!frame || !context || !this.current(frame)) return undefined;
    const generation = this.#generation;
    return this.serializeAssets(async () => {
      signal?.throwIfAborted();
      if (generation !== this.#generation || !this.current(frame))
        return undefined;
      const source = this.repository.getEvent(context.eventId);
      if (
        !source ||
        source.actor !== frame.actor ||
        !("surface" in source.details) ||
        !source.details.surface ||
        !sameVisualSurface(source.details.surface, frame.visual.surface)
      )
        return undefined;
      if (
        this.#observation?.reference.contentRevision ===
          frame.visual.contentRevision &&
        (await this.resolve(this.#observation.reference, signal)).status ===
          "available"
      )
        return this.#observation;
      let existing = this.repository.findAssetByHash(
        frame.visual.contentRevision,
      );
      if (existing) {
        try {
          await access(this.assets.resolve(existing));
        } catch {
          existing = undefined;
        }
      }
      const asset =
        existing ??
        (await this.assets.save(
          this.ids.generate(),
          {
            bytes: frame.bytes,
            width: frame.width,
            height: frame.height,
            mediaType: "image/png",
          },
          frame.visual.capturedAt,
        ));
      const discard = async () => {
        if (!existing) await this.assets.remove([asset.storageKey]);
      };
      let committed = false;
      try {
        signal?.throwIfAborted();
        if (
          generation !== this.#generation ||
          !this.current(frame) ||
          !this.repository.getEvent(context.eventId)
        ) {
          await discard();
          return undefined;
        }
        if (asset.sha256 !== frame.visual.contentRevision)
          throw new Error("Visual bytes do not match their content revision");
        const now = this.clock.now();
        const event: ActivityVisualObservation["event"] = {
          id: this.ids.generate(),
          actor: frame.actor,
          startedAt: frame.visual.capturedAt,
          endedAt: frame.visual.capturedAt,
          details: {
            source: "screenshot",
            artifactId: asset.id,
            storageKey: asset.storageKey,
            width: asset.width,
            height: asset.height,
            mediaType: asset.mediaType,
            ocrText: frame.visual.ocr.lines.map((line) => line.text).join("\n"),
            visual: {
              ...frame.visual,
              trigger,
              triggerEventId: context.eventId,
            },
          },
        };
        if (existing) this.repository.insertEvent(event, now);
        else this.repository.insertScreenshot(asset, event, now);
        committed = true;
        const reference = parseSchema(
          ActivityVisualReferenceSchema,
          visualReference(event),
        );
        this.#observation = { event, reference };
        if (notify) this.publish(event);
        return this.#observation;
      } catch (error) {
        if (!committed) await discard();
        throw error;
      }
    });
  }

  async resolve(
    referenceInput: ActivityVisualReference,
    signal?: AbortSignal,
  ): Promise<ActivityVisualResolution> {
    const reference = parseSchema(
      ActivityVisualReferenceSchema,
      referenceInput,
    );
    signal?.throwIfAborted();
    const event = this.repository.getEvent(reference.eventId);
    if (!event) return { status: "unavailable", reason: "source_missing" };
    if (!isDeepStrictEqual(visualReference(event), reference))
      return { status: "unavailable", reason: "source_changed" };
    const asset = this.repository.getAsset(reference.artifactId);
    if (!asset || asset.sha256 !== reference.contentRevision)
      return { status: "unavailable", reason: "asset_missing" };
    let bytes: Buffer;
    try {
      bytes = await readFile(
        this.assets.resolve(asset),
        signal ? { signal } : undefined,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "unavailable", reason: "asset_missing" };
      throw error;
    }
    signal?.throwIfAborted();
    const current = this.repository.getEvent(reference.eventId);
    if (!current) return { status: "unavailable", reason: "source_missing" };
    if (!isDeepStrictEqual(visualReference(current), reference))
      return { status: "unavailable", reason: "source_changed" };
    if (
      !this.repository.getAsset(reference.artifactId) ||
      (await visualContentRevision(bytes)) !== reference.contentRevision
    )
      return { status: "unavailable", reason: "asset_missing" };
    signal?.throwIfAborted();
    const details = current.details;
    if (details.source !== "screenshot" || !details.visual)
      return { status: "unavailable", reason: "source_changed" };
    return {
      status: "available",
      reference,
      actor: current.actor,
      startedAt: current.startedAt,
      bytes,
      mediaType: "image/png",
      ocr: details.visual.ocr,
    };
  }

  async clear(): Promise<void> {
    this.setContext(undefined);
    await this.#queue;
  }

  private current(frame: ActivityVisualFrame): boolean {
    return (
      !this.paused() &&
      this.#context?.actor === frame.actor &&
      sameVisualSurface(this.#context.surface, frame.visual.surface)
    );
  }
}
