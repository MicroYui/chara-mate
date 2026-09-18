import type {
  ActivityPerception,
  ActivityActor,
  ActivityApplicationLifecycle,
} from "../../shared/contracts/activity";
import type { Timestamp } from "../../shared/contracts/primitives";
import { Type, type Static } from "@sinclair/typebox";
import {
  ActivitySurfaceSchema,
  ActivityVisualPositionSchema,
} from "../../shared/schemas/activity";
import {
  EntityIdSchema,
  TimestampSchema,
} from "../../shared/schemas/primitives";

export interface ForegroundActivityObservation extends ActivityPerception {
  readonly actor: ActivityActor;
  readonly lifecycle?: ActivityApplicationLifecycle;
  readonly appId?: string;
  readonly appName: string;
  readonly eventId: string;
  readonly observedAt: Timestamp;
  readonly windowTitle?: string;
}

export interface ForegroundActivityObserver {
  observeForeground(observation: ForegroundActivityObservation): void;
}

const TextReferenceSchema = Type.Object(
  {
    eventId: EntityIdSchema,
    offset: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  },
  { additionalProperties: false },
);

export const ActivityObserveInputSchema = Type.Object(
  {
    latest: Type.Optional(
      Type.Object(
        {
          query: Type.Optional(
            Type.String({
              description:
                "Literal location text in app name/id, window title, domain or URL; never filters the observed body.",
            }),
          ),
          surface: Type.Optional(
            Type.Pick(ActivitySurfaceSchema, ["id", "epoch"], {
              additionalProperties: false,
            }),
          ),
          periodStart: Type.Optional(TimestampSchema),
          periodEnd: Type.Optional(TimestampSchema),
          before: Type.Optional(ActivityVisualPositionSchema),
        },
        { additionalProperties: false },
      ),
    ),
    reference: Type.Optional(TextReferenceSchema),
  },
  { additionalProperties: false, minProperties: 1, maxProperties: 1 },
);

export type ActivityObserveInput = Static<typeof ActivityObserveInputSchema>;

export type ActivityTextObservation = {
  retainedOnly: true;
  liveScreen: false;
  paused: boolean;
  status:
    | "available"
    | "unavailable"
    | "protected"
    | "missing"
    | "resource_limit"
    | "input_limit"
    | "source_changed";
  reference?: { eventId: string; offset: number };
  observation?: {
    eventId: string;
    source: string;
    actor: ActivityActor;
    observedAt: Timestamp;
    receivedAt: Timestamp;
    position: { startedAt: Timestamp; eventId: string };
    location?: {
      appName?: string;
      appId?: string;
      windowTitle?: string;
      url?: string;
      domain?: string;
      surface?: { id: string; epoch: string };
    };
  };
  content?: {
    source: "accessibility" | "dom";
    scope: "focused_element" | "viewport";
    captureTruncated: "reported" | "unknown";
    text: string;
    coverage: {
      offsetUnit: "utf16_code_unit";
      start: number;
      end: number;
      total: number;
      storedTextComplete: boolean;
    };
  };
  next?: { eventId: string; offset: number };
};
