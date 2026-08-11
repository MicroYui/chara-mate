import type { Static } from "@sinclair/typebox";

import type {
  AutomationCreateRequestSchema,
  AutomationCronExpressionSchema,
  AutomationDefinitionSchema,
  AutomationDetailResponseSchema,
  AutomationDetailSchema,
  AutomationEventEnvelopeSchema,
  AutomationEventSchema,
  AutomationFinishedStatusSchema,
  AutomationIdRequestSchema,
  AutomationListItemSchema,
  AutomationListResponseSchema,
  AutomationListSnapshotSchema,
  AutomationLocalTimeSchema,
  AutomationMutationResponseSchema,
  AutomationRunNowRequestSchema,
  AutomationRunNowResponseSchema,
  AutomationRunSchema,
  AutomationRunTriggerSchema,
  AutomationScheduleSchema,
  AutomationSchema,
  AutomationSetPausedRequestSchema,
  AutomationTaskKindSchema,
  AutomationTaskSchema,
  AutomationToolScopeSchema,
  AutomationUpdateRequestSchema,
} from "../schemas/automation";

export const AUTOMATION_CHANNELS = {
  create: "automation.create",
  get: "automation.get",
  list: "automation.list",
  runNow: "automation.runNow",
  setPaused: "automation.setPaused",
  subscribe: "automation.events.subscribe",
  update: "automation.update",
} as const;

export type AutomationLocalTime = Static<typeof AutomationLocalTimeSchema>;
export type AutomationCronExpression = Static<
  typeof AutomationCronExpressionSchema
>;
export type AutomationSchedule = Static<typeof AutomationScheduleSchema>;
export type AutomationToolScope = Static<typeof AutomationToolScopeSchema>;
export type AutomationTaskKind = Static<typeof AutomationTaskKindSchema>;
export type AutomationTask = Static<typeof AutomationTaskSchema>;
export type AutomationDefinition = Static<typeof AutomationDefinitionSchema>;
export type Automation = Static<typeof AutomationSchema>;
export type AutomationRunTrigger = Static<typeof AutomationRunTriggerSchema>;
export type AutomationRun = Static<typeof AutomationRunSchema>;
export type AutomationFinishedStatus = Static<
  typeof AutomationFinishedStatusSchema
>;
export type AutomationEvent = Static<typeof AutomationEventSchema>;
export type AutomationEventEnvelope = Static<
  typeof AutomationEventEnvelopeSchema
>;
export type AutomationListItem = Static<typeof AutomationListItemSchema>;
export type AutomationListSnapshot = Static<
  typeof AutomationListSnapshotSchema
>;
export type AutomationDetail = Static<typeof AutomationDetailSchema>;
export type AutomationCreateRequest = Static<
  typeof AutomationCreateRequestSchema
>;
export type AutomationUpdateRequest = Static<
  typeof AutomationUpdateRequestSchema
>;
export type AutomationIdRequest = Static<typeof AutomationIdRequestSchema>;
export type AutomationSetPausedRequest = Static<
  typeof AutomationSetPausedRequestSchema
>;
export type AutomationRunNowRequest = Static<
  typeof AutomationRunNowRequestSchema
>;
export type AutomationListResponse = Static<
  typeof AutomationListResponseSchema
>;
export type AutomationDetailResponse = Static<
  typeof AutomationDetailResponseSchema
>;
export type AutomationMutationResponse = Static<
  typeof AutomationMutationResponseSchema
>;
export type AutomationRunNowResponse = Static<
  typeof AutomationRunNowResponseSchema
>;

export interface AutomationApi {
  create(request: AutomationCreateRequest): Promise<AutomationMutationResponse>;
  get(request: AutomationIdRequest): Promise<AutomationDetailResponse>;
  list(): Promise<AutomationListResponse>;
  runNow(request: AutomationRunNowRequest): Promise<AutomationRunNowResponse>;
  setPaused(
    request: AutomationSetPausedRequest,
  ): Promise<AutomationMutationResponse>;
  subscribe(listener: (event: AutomationEventEnvelope) => void): () => void;
  update(request: AutomationUpdateRequest): Promise<AutomationMutationResponse>;
}
