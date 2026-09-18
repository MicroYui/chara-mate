import { Type, type TSchema } from "@sinclair/typebox";

import { AppErrorSchema } from "./error";
import { MemoryEvidenceReferenceSchema } from "./memoryRecall";
import {
  EntityIdSchema,
  NonBlankStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./primitives";
import { TerritoryRotationSchema } from "./territoryPrimitives";

export { TerritoryRotationSchema } from "./territoryPrimitives";

const structuredIdSchema = Type.String({
  maxLength: 96,
  pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
});

const colorSchema = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });

export const TerritoryWorldIdSchema = Type.Literal("territory");
export const TerritoryZoneIdSchema = EntityIdSchema;
export const TerritoryWorldRevisionIdSchema = EntityIdSchema;
export const TerritoryInstanceIdSchema = EntityIdSchema;
export const TerritoryGroupIdSchema = EntityIdSchema;
export const TerritoryCandidateIdSchema = EntityIdSchema;
export const TerritoryDefinitionIdSchema = structuredIdSchema;
export const TerritoryAssetIdSchema = structuredIdSchema;
export const TerritoryAssetPackIdSchema = structuredIdSchema;
export const TerritoryStyleProfileIdSchema = structuredIdSchema;

export const TerritoryLayerSchema = Type.Union([
  Type.Literal("terrain"),
  Type.Literal("underlay"),
  Type.Literal("structure"),
  Type.Literal("object"),
  Type.Literal("attachment"),
  Type.Literal("foreground"),
  Type.Literal("effect"),
]);

export const TerritoryDepthModeSchema = Type.Union([
  Type.Literal("flat"),
  Type.Literal("sorted"),
  Type.Literal("overlay"),
]);

export const TerritoryZoneKindSchema = Type.Union([
  Type.Literal("room"),
  Type.Literal("courtyard"),
  Type.Literal("garden"),
  Type.Literal("balcony"),
  Type.Literal("rooftop"),
  Type.Literal("outdoor"),
]);

export const TerritoryCandidateIntentSchema = Type.Union([
  Type.Literal("item"),
  Type.Literal("selection"),
  Type.Literal("zone"),
  Type.Literal("expansion"),
]);

export const TerritoryGridPointSchema = Type.Object(
  {
    x: Type.Integer({ minimum: 0 }),
    y: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TerritoryPixelPointSchema = Type.Object(
  { x: Type.Number(), y: Type.Number() },
  { additionalProperties: false },
);

export const TerritoryPositiveSizeSchema = Type.Object(
  {
    height: Type.Integer({ minimum: 1 }),
    width: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const TerritoryGridSizeSchema = Type.Object(
  {
    height: Type.Integer({ minimum: 1 }),
    width: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const TerritoryBoundsSchema = Type.Object(
  {
    height: Type.Integer({ minimum: 1 }),
    width: Type.Integer({ minimum: 1 }),
    x: Type.Integer(),
    y: Type.Integer(),
  },
  { additionalProperties: false },
);

export const TerritoryStyleProfileRefSchema = Type.Object(
  {
    id: TerritoryStyleProfileIdSchema,
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const TerritoryStyleProfileSchema = Type.Object(
  {
    id: TerritoryStyleProfileIdSchema,
    lightingDirection: NonBlankStringSchema,
    materialLanguage: NonBlankStringSchema,
    name: NonBlankStringSchema,
    outlineLanguage: NonBlankStringSchema,
    palette: Type.Object(
      {
        accent: colorSchema,
        ambient: colorSchema,
        dark: colorSchema,
        light: colorSchema,
        mid: colorSchema,
      },
      { additionalProperties: false },
    ),
    pixelScale: Type.Integer({ minimum: 1 }),
    referenceAssetIds: Type.Array(TerritoryAssetIdSchema, {
      uniqueItems: true,
    }),
    revision: Type.Integer({ minimum: 1 }),
    seasonTone: NonBlankStringSchema,
    shadowLanguage: NonBlankStringSchema,
    timeTone: NonBlankStringSchema,
  },
  { additionalProperties: false },
);

export const TerritoryZoneSchema = Type.Object(
  {
    bounds: TerritoryBoundsSchema,
    createdAt: TimestampSchema,
    id: TerritoryZoneIdSchema,
    kind: TerritoryZoneKindSchema,
    name: NonBlankStringSchema,
    status: Type.Union([Type.Literal("active"), Type.Literal("trashed")]),
    styleProfile: TerritoryStyleProfileRefSchema,
    trashedAt: Type.Union([TimestampSchema, Type.Null()]),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const TerritoryZoneConnectionSchema = Type.Object(
  {
    from: TerritoryGridPointSchema,
    fromZoneId: TerritoryZoneIdSchema,
    id: EntityIdSchema,
    kind: Type.Union([
      Type.Literal("doorway"),
      Type.Literal("path"),
      Type.Literal("stairs"),
    ]),
    to: TerritoryGridPointSchema,
    toZoneId: TerritoryZoneIdSchema,
  },
  { additionalProperties: false },
);

export const TerritoryAssetSchema = Type.Object(
  {
    byteLength: Type.Integer({ minimum: 1 }),
    createdAt: TimestampSchema,
    height: Type.Integer({ minimum: 1 }),
    id: TerritoryAssetIdSchema,
    mediaType: Type.Union([
      Type.Literal("image/png"),
      Type.Literal("application/vnd.charamate.pixi"),
    ]),
    origin: Type.Union([
      Type.Literal("packaged"),
      Type.Literal("generated"),
      Type.Literal("edited"),
    ]),
    sha256: Sha256Schema,
    width: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const TerritoryAssetPackSchema = Type.Object(
  {
    assets: Type.Array(
      Type.Object(
        {
          assetId: TerritoryAssetIdSchema,
          key: structuredIdSchema,
          layer: TerritoryLayerSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    createdAt: TimestampSchema,
    id: TerritoryAssetPackIdSchema,
    name: NonBlankStringSchema,
    revision: Type.Integer({ minimum: 1 }),
    styleProfile: TerritoryStyleProfileRefSchema,
  },
  { additionalProperties: false },
);

export const TerritoryAnchorKindSchema = Type.Union([
  Type.Literal("tabletop"),
  Type.Literal("bookshelf"),
  Type.Literal("wall"),
  Type.Literal("windowsill"),
  Type.Literal("ceiling"),
  Type.Literal("ground"),
  Type.Literal("seat"),
  Type.Literal("sleep"),
]);

export const TerritoryCapabilitySchema = Type.Union([
  Type.Literal("seatable"),
  Type.Literal("sleepable"),
  Type.Literal("light"),
  Type.Literal("ambient-animation"),
  Type.Literal("inspectable"),
  Type.Literal("memory-reveal"),
]);

const gridCellSchema = TerritoryGridPointSchema;

const tilePlacementRuleSchema = Type.Object(
  {
    collision: Type.Boolean(),
    mode: Type.Literal("tile"),
    span: TerritoryGridSizeSchema,
  },
  { additionalProperties: false },
);

const gridPlacementRuleSchema = Type.Object(
  {
    collisionCells: Type.Array(gridCellSchema, { uniqueItems: true }),
    footprintCells: Type.Array(gridCellSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    mode: Type.Literal("grid"),
  },
  { additionalProperties: false },
);

const attachmentPlacementRuleSchema = Type.Object(
  {
    allowedAnchors: Type.Array(TerritoryAnchorKindSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    attachmentAnchorPx: TerritoryPixelPointSchema,
    mode: Type.Literal("attachment"),
  },
  { additionalProperties: false },
);

const freePlacementRuleSchema = Type.Object(
  { mode: Type.Literal("free") },
  { additionalProperties: false },
);

export const TerritoryDefinitionSchema = Type.Object(
  {
    anchors: Type.Array(
      Type.Object(
        {
          anchorPx: TerritoryPixelPointSchema,
          id: structuredIdSchema,
          kind: TerritoryAnchorKindSchema,
          maxItemSizePx: TerritoryPositiveSizeSchema,
        },
        { additionalProperties: false },
      ),
      { uniqueItems: true },
    ),
    capabilities: Type.Array(TerritoryCapabilitySchema, {
      uniqueItems: true,
    }),
    createdAt: TimestampSchema,
    description: NonBlankStringSchema,
    id: TerritoryDefinitionIdSchema,
    layer: TerritoryLayerSchema,
    name: NonBlankStringSchema,
    placement: Type.Union([
      tilePlacementRuleSchema,
      gridPlacementRuleSchema,
      attachmentPlacementRuleSchema,
      freePlacementRuleSchema,
    ]),
    revision: Type.Integer({ minimum: 1 }),
    schemaVersion: Type.Literal(3),
    tags: Type.Array(structuredIdSchema, { uniqueItems: true }),
    transforms: Type.Object(
      {
        flippable: Type.Boolean(),
        rotations: Type.Array(TerritoryRotationSchema, {
          maxItems: 4,
          minItems: 1,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
    visual: Type.Object(
      {
        assetId: TerritoryAssetIdSchema,
        depthAnchorPx: TerritoryPixelPointSchema,
        depthMode: TerritoryDepthModeSchema,
        frame: Type.Union([structuredIdSchema, Type.Null()]),
        sizePx: TerritoryPositiveSizeSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const TerritoryDefinitionRefSchema = Type.Object(
  {
    id: TerritoryDefinitionIdSchema,
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const TerritoryMemorySourceSnapshotSchema = Type.Object(
  {
    id: EntityIdSchema,
    kind: Type.Literal("memory"),
    label: NonBlankStringSchema,
    occurredAt: TimestampSchema,
    revisionId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const TerritoryActivityDigestSourceSnapshotSchema = Type.Object(
  {
    id: EntityIdSchema,
    kind: Type.Literal("activity_digest"),
    label: NonBlankStringSchema,
    occurredAt: TimestampSchema,
    revisionId: Type.Null(),
  },
  { additionalProperties: false },
);

export const TerritoryChatMomentAttachmentSchema = Type.Object(
  {
    attachmentId: EntityIdSchema,
    displayName: NonBlankStringSchema,
    mediaType: Type.Optional(NonBlankStringSchema),
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
);

export const TerritoryChatMomentMemoryRevisionSchema =
  MemoryEvidenceReferenceSchema;

export const TerritoryChatMomentPersonaRefSchema = Type.Object(
  {
    personaId: EntityIdSchema,
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const TerritoryChatMomentSourceSnapshotSchema = Type.Object(
  {
    attachments: Type.Array(TerritoryChatMomentAttachmentSchema),
    chatId: EntityIdSchema,
    id: Sha256Schema,
    kind: Type.Literal("chat_moment"),
    label: NonBlankStringSchema,
    memoryRevisions: Type.Array(TerritoryChatMomentMemoryRevisionSchema),
    messageId: EntityIdSchema,
    momentKey: Sha256Schema,
    occurredAt: TimestampSchema,
    personaRef: TerritoryChatMomentPersonaRefSchema,
    runId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const TerritoryCharacterCreationSourceSnapshotSchema = Type.Object(
  {
    id: EntityIdSchema,
    kind: Type.Literal("character_creation"),
    label: NonBlankStringSchema,
    occurredAt: TimestampSchema,
    personaRef: TerritoryChatMomentPersonaRefSchema,
    runId: EntityIdSchema,
  },
  { additionalProperties: false },
);

export const TerritorySourceSnapshotSchema = Type.Union([
  TerritoryMemorySourceSnapshotSchema,
  TerritoryActivityDigestSourceSnapshotSchema,
  TerritoryChatMomentSourceSnapshotSchema,
  TerritoryCharacterCreationSourceSnapshotSchema,
]);

const transformProperties = {
  flipped: Type.Boolean(),
  offsetPx: TerritoryPixelPointSchema,
  rotation: TerritoryRotationSchema,
};

export const TerritoryInstancePlacementSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("collection") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...transformProperties,
      kind: Type.Literal("zone"),
      point: TerritoryGridPointSchema,
      zoneId: TerritoryZoneIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...transformProperties,
      anchorId: structuredIdSchema,
      kind: Type.Literal("attachment"),
      parentInstanceId: TerritoryInstanceIdSchema,
      zoneId: TerritoryZoneIdSchema,
    },
    { additionalProperties: false },
  ),
]);

export const TerritoryInstanceSchema = Type.Object(
  {
    createdAt: TimestampSchema,
    definition: TerritoryDefinitionRefSchema,
    favorite: Type.Boolean(),
    groupId: Type.Union([TerritoryGroupIdSchema, Type.Null()]),
    id: TerritoryInstanceIdSchema,
    locked: Type.Boolean(),
    placement: TerritoryInstancePlacementSchema,
    sources: Type.Array(TerritorySourceSnapshotSchema),
    status: Type.Union([Type.Literal("active"), Type.Literal("trashed")]),
    trashedAt: Type.Union([TimestampSchema, Type.Null()]),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const TerritoryGroupSchema = Type.Object(
  {
    createdAt: TimestampSchema,
    id: TerritoryGroupIdSchema,
    instanceIds: Type.Array(TerritoryInstanceIdSchema, {
      minItems: 2,
      uniqueItems: true,
    }),
    locked: Type.Boolean(),
    name: NonBlankStringSchema,
    template: Type.Boolean(),
    updatedAt: TimestampSchema,
    zoneId: TerritoryZoneIdSchema,
  },
  { additionalProperties: false },
);

export const TerritoryPetStateSchema = Type.Object(
  {
    behavior: Type.Union([
      Type.Literal("idle"),
      Type.Literal("walking"),
      Type.Literal("sitting"),
      Type.Literal("sleeping"),
      Type.Literal("observing"),
    ]),
    facing: Type.Union([Type.Literal("left"), Type.Literal("right")]),
    point: TerritoryGridPointSchema,
    updatedAt: TimestampSchema,
    zoneId: TerritoryZoneIdSchema,
  },
  { additionalProperties: false },
);

export const TerritoryPetActionSchema = Type.Union([
  Type.Literal("move"),
  Type.Literal("observe"),
  Type.Literal("sit"),
  Type.Literal("sleep"),
  Type.Literal("react"),
]);

export const TerritoryPetActionTargetSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("point"),
      point: TerritoryGridPointSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      instanceId: TerritoryInstanceIdSchema,
      kind: Type.Literal("instance"),
    },
    { additionalProperties: false },
  ),
]);

export const TerritoryInstanceLayoutSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("available"),
      rootInstanceId: TerritoryInstanceIdSchema,
      rootGridPoint: TerritoryGridPointSchema,
      originPx: TerritoryPixelPointSchema,
      sizePx: TerritoryPositiveSizeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("unavailable"),
      reason: Type.Union([
        Type.Literal("missing_definition"),
        Type.Literal("missing_parent"),
        Type.Literal("missing_anchor"),
        Type.Literal("invalid_attachment"),
        Type.Literal("cyclic_attachment"),
        Type.Literal("unplaced"),
      ]),
      referenceId: NonBlankStringSchema,
    },
    { additionalProperties: false },
  ),
]);

export const TerritoryObservationNodeSchema = Type.Object(
  {
    instanceId: TerritoryInstanceIdSchema,
    definition: TerritoryDefinitionRefSchema,
    placement: TerritoryInstancePlacementSchema,
    content: Type.Union([
      Type.Object(
        {
          status: Type.Literal("available"),
          name: NonBlankStringSchema,
          description: NonBlankStringSchema,
          layer: TerritoryLayerSchema,
          anchors: TerritoryDefinitionSchema.properties.anchors,
          visual: Type.Object(
            {
              sizePx: TerritoryPositiveSizeSchema,
              attachmentAnchorPx: Type.Union([
                TerritoryPixelPointSchema,
                Type.Null(),
              ]),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          status: Type.Literal("unavailable"),
          reason: Type.Literal("missing_definition"),
        },
        { additionalProperties: false },
      ),
    ]),
    layout: TerritoryInstanceLayoutSchema,
  },
  { additionalProperties: false },
);

export const TerritoryPetAffordanceSchema = Type.Object(
  {
    actions: Type.Array(TerritoryPetActionSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    capabilities: Type.Array(TerritoryCapabilitySchema, {
      uniqueItems: true,
    }),
    instanceId: TerritoryInstanceIdSchema,
    reachable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const TerritoryPetActionObservationSchema = Type.Object(
  {
    nodes: Type.Array(TerritoryObservationNodeSchema),
    pet: TerritoryPetStateSchema,
    revisionId: TerritoryWorldRevisionIdSchema,
    targets: Type.Array(TerritoryPetAffordanceSchema),
    zone: Type.Object(
      {
        bounds: TerritoryBoundsSchema,
        id: TerritoryZoneIdSchema,
        name: NonBlankStringSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const TerritoryPerformPetActionRequestSchema = Type.Object(
  {
    action: TerritoryPetActionSchema,
    expectedRevisionId: TerritoryWorldRevisionIdSchema,
    target: TerritoryPetActionTargetSchema,
  },
  { additionalProperties: false },
);

export const TerritoryWorldRevisionSummarySchema = Type.Object(
  {
    createdAt: TimestampSchema,
    id: TerritoryWorldRevisionIdSchema,
    label: NonBlankStringSchema,
    parentRevisionId: Type.Union([TerritoryWorldRevisionIdSchema, Type.Null()]),
    reason: Type.Union([
      Type.Literal("initial"),
      Type.Literal("direct"),
      Type.Literal("ai"),
      Type.Literal("restore"),
    ]),
    sequence: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const TerritoryWorldSummarySchema = Type.Object(
  {
    activeZoneId: TerritoryZoneIdSchema,
    connections: Type.Array(TerritoryZoneConnectionSchema),
    currentRevision: TerritoryWorldRevisionSummarySchema,
    id: TerritoryWorldIdSchema,
    name: NonBlankStringSchema,
    zones: Type.Array(TerritoryZoneSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const TerritoryWorldStateSchema = Type.Object(
  {
    activeZoneId: TerritoryZoneIdSchema,
    connections: Type.Array(TerritoryZoneConnectionSchema),
    groups: Type.Array(TerritoryGroupSchema),
    instances: Type.Array(TerritoryInstanceSchema),
    styles: Type.Array(TerritoryStyleProfileSchema, { minItems: 1 }),
    zones: Type.Array(TerritoryZoneSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const worldMutationBase = { changeId: EntityIdSchema };

export const TerritoryWorldMutationSchema = Type.Union([
  Type.Object(
    {
      ...worldMutationBase,
      kind: Type.Literal("active-zone.set"),
      zoneId: TerritoryZoneIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      kind: Type.Literal("zone.put"),
      zone: TerritoryZoneSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      kind: Type.Literal("zone.remove"),
      zoneId: TerritoryZoneIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      kind: Type.Literal("connection.put"),
      connection: TerritoryZoneConnectionSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      connectionId: EntityIdSchema,
      kind: Type.Literal("connection.remove"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      kind: Type.Literal("style.put"),
      style: TerritoryStyleProfileSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      assetPack: TerritoryAssetPackSchema,
      kind: Type.Literal("asset-pack.put"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      definition: TerritoryDefinitionSchema,
      kind: Type.Literal("definition.put"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      instance: TerritoryInstanceSchema,
      kind: Type.Literal("instance.put"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      instanceId: TerritoryInstanceIdSchema,
      kind: Type.Literal("instance.remove"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      group: TerritoryGroupSchema,
      kind: Type.Literal("group.put"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...worldMutationBase,
      groupId: TerritoryGroupIdSchema,
      kind: Type.Literal("group.remove"),
    },
    { additionalProperties: false },
  ),
]);

export const TerritoryWorldChangeSetSchema = Type.Object(
  {
    baseRevisionId: TerritoryWorldRevisionIdSchema,
    id: EntityIdSchema,
    label: NonBlankStringSchema,
    mutations: Type.Array(TerritoryWorldMutationSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const TerritoryCandidateScopeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("world") }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("zone"), zoneId: TerritoryZoneIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      bounds: TerritoryBoundsSchema,
      kind: Type.Literal("selection"),
      zoneId: TerritoryZoneIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      instanceIds: Type.Array(TerritoryInstanceIdSchema, {
        minItems: 1,
        uniqueItems: true,
      }),
      kind: Type.Literal("entities"),
      zoneId: TerritoryZoneIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      direction: Type.Union([
        Type.Literal("north"),
        Type.Literal("east"),
        Type.Literal("south"),
        Type.Literal("west"),
      ]),
      fromZoneId: TerritoryZoneIdSchema,
      kind: Type.Literal("expansion"),
    },
    { additionalProperties: false },
  ),
]);

export const TerritoryChangeCandidateSchema = Type.Object(
  {
    appliedRevisionId: Type.Union([
      TerritoryWorldRevisionIdSchema,
      Type.Null(),
    ]),
    baseRevisionId: TerritoryWorldRevisionIdSchema,
    changeSet: Type.Union([TerritoryWorldChangeSetSchema, Type.Null()]),
    createdAt: TimestampSchema,
    error: Type.Union([AppErrorSchema, Type.Null()]),
    id: TerritoryCandidateIdSchema,
    intent: TerritoryCandidateIntentSchema,
    lockedInstanceIds: Type.Array(TerritoryInstanceIdSchema, {
      uniqueItems: true,
    }),
    previewGroups: Type.Array(
      Type.Object(
        {
          action: Type.Union([
            Type.Literal("add"),
            Type.Literal("move"),
            Type.Literal("replace"),
            Type.Literal("delete"),
          ]),
          changeIds: Type.Array(EntityIdSchema, {
            minItems: 1,
            uniqueItems: true,
          }),
          instanceIds: Type.Array(TerritoryInstanceIdSchema, {
            uniqueItems: true,
          }),
          label: NonBlankStringSchema,
        },
        { additionalProperties: false },
      ),
    ),
    prompt: NonBlankStringSchema,
    providerProfileId: Type.Union([EntityIdSchema, Type.Null()]),
    scope: TerritoryCandidateScopeSchema,
    sources: Type.Array(TerritorySourceSnapshotSchema),
    status: Type.Union([
      Type.Literal("draft"),
      Type.Literal("generating"),
      Type.Literal("ready"),
      Type.Literal("failed"),
      Type.Literal("stale"),
      Type.Literal("cancelled"),
      Type.Literal("applied"),
    ]),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

export const TerritoryWorldSnapshotSchema = Type.Object(
  {
    assetPacks: Type.Array(TerritoryAssetPackSchema),
    assets: Type.Array(TerritoryAssetSchema),
    candidates: Type.Array(TerritoryChangeCandidateSchema),
    collection: Type.Array(TerritoryInstanceSchema),
    definitions: Type.Array(TerritoryDefinitionSchema),
    pet: TerritoryPetStateSchema,
    revisions: Type.Array(TerritoryWorldRevisionSummarySchema, {
      minItems: 1,
    }),
    styles: Type.Array(TerritoryStyleProfileSchema, { minItems: 1 }),
    trash: Type.Array(TerritoryInstanceSchema),
    world: TerritoryWorldSummarySchema,
  },
  { additionalProperties: false },
);

export const TerritoryZoneViewSchema = Type.Object(
  {
    definitions: Type.Array(TerritoryDefinitionSchema),
    groups: Type.Array(TerritoryGroupSchema),
    instances: Type.Array(TerritoryInstanceSchema),
    pet: Type.Union([TerritoryPetStateSchema, Type.Null()]),
    revisionId: TerritoryWorldRevisionIdSchema,
    style: TerritoryStyleProfileSchema,
    viewport: Type.Union([TerritoryBoundsSchema, Type.Null()]),
    zone: TerritoryZoneSchema,
  },
  { additionalProperties: false },
);

export const TerritoryEmptyRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const TerritoryGetZoneViewRequestSchema = Type.Object(
  {
    revisionId: TerritoryWorldRevisionIdSchema,
    viewport: Type.Optional(TerritoryBoundsSchema),
    zoneId: TerritoryZoneIdSchema,
  },
  { additionalProperties: false },
);

export const TerritoryCommitChangeSetRequestSchema = Type.Object(
  { changeSet: TerritoryWorldChangeSetSchema },
  { additionalProperties: false },
);

export const TerritoryRestoreRevisionRequestSchema = Type.Object(
  {
    expectedCurrentRevisionId: TerritoryWorldRevisionIdSchema,
    revisionId: TerritoryWorldRevisionIdSchema,
  },
  { additionalProperties: false },
);

export const TerritoryMovePetRequestSchema = Type.Object(
  {
    from: TerritoryGridPointSchema,
    interactionInstanceId: Type.Optional(TerritoryInstanceIdSchema),
    to: TerritoryGridPointSchema,
    zoneId: TerritoryZoneIdSchema,
  },
  { additionalProperties: false },
);

export const TerritoryEnterZoneRequestSchema = Type.Object(
  {
    fromZoneId: TerritoryZoneIdSchema,
    toZoneId: TerritoryZoneIdSchema,
  },
  { additionalProperties: false },
);

export const TerritoryCreateChangeCandidateRequestSchema = Type.Object(
  {
    baseRevisionId: TerritoryWorldRevisionIdSchema,
    intent: TerritoryCandidateIntentSchema,
    itemContent: Type.Optional(
      Type.Object(
        {
          description: NonBlankStringSchema,
          name: NonBlankStringSchema,
        },
        { additionalProperties: false },
      ),
    ),
    lockedInstanceIds: Type.Array(TerritoryInstanceIdSchema, {
      uniqueItems: true,
    }),
    prompt: NonBlankStringSchema,
    providerProfileId: Type.Union([EntityIdSchema, Type.Null()]),
    scope: TerritoryCandidateScopeSchema,
    sources: Type.Array(TerritorySourceSnapshotSchema),
  },
  { additionalProperties: false },
);

export const TerritoryCreateSourceCandidateRequestSchema = Type.Object(
  {
    source: Type.Union([
      Type.Object(
        { kind: Type.Literal("memory"), memoryId: EntityIdSchema },
        { additionalProperties: false },
      ),
      Type.Object(
        { digestId: EntityIdSchema, kind: Type.Literal("activity_digest") },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

export const TerritoryEditChangeCandidateRequestSchema = Type.Object(
  {
    candidateId: TerritoryCandidateIdSchema,
    excludedChangeIds: Type.Array(EntityIdSchema, { uniqueItems: true }),
    instruction: NonBlankStringSchema,
    lockedInstanceIds: Type.Array(TerritoryInstanceIdSchema, {
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export const TerritoryCandidateIdRequestSchema = Type.Object(
  { candidateId: TerritoryCandidateIdSchema },
  { additionalProperties: false },
);

export const TerritoryPurgeInstanceRequestSchema = Type.Object(
  { instanceId: TerritoryInstanceIdSchema },
  { additionalProperties: false },
);

function operationResponse<TValue extends TSchema>(value: TValue) {
  return Type.Union([
    Type.Object(
      { ok: Type.Literal(true), value },
      { additionalProperties: false },
    ),
    Type.Object(
      { error: AppErrorSchema, ok: Type.Literal(false) },
      { additionalProperties: false },
    ),
  ]);
}

export const TerritoryWorldSnapshotResponseSchema = operationResponse(
  TerritoryWorldSnapshotSchema,
);

export const TerritoryZoneViewResponseSchema = operationResponse(
  TerritoryZoneViewSchema,
);

export const TerritoryCandidateMutationResultSchema = Type.Object(
  {
    candidateId: TerritoryCandidateIdSchema,
    snapshot: TerritoryWorldSnapshotSchema,
  },
  { additionalProperties: false },
);

export const TerritoryCandidateMutationResponseSchema = operationResponse(
  TerritoryCandidateMutationResultSchema,
);

export const TerritoryMovePetResultSchema = Type.Object(
  {
    path: Type.Array(TerritoryGridPointSchema, { minItems: 1 }),
    snapshot: TerritoryWorldSnapshotSchema,
  },
  { additionalProperties: false },
);

export const TerritoryMovePetResponseSchema = operationResponse(
  TerritoryMovePetResultSchema,
);

export const TerritoryPetActionPerformedSchema = Type.Object(
  {
    action: TerritoryPetActionSchema,
    path: Type.Array(TerritoryGridPointSchema, { minItems: 1 }),
    snapshot: TerritoryWorldSnapshotSchema,
    targetInstanceId: Type.Union([TerritoryInstanceIdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
