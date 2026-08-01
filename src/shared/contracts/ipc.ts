import type { Static } from "@sinclair/typebox";

import type {
  IpcRequestSchema,
  IpcResponseSchema,
  RunEventEnvelopeSchema,
  RunEventReplayRequestSchema,
  RunEventReplayResponseSchema,
  RunEventSchema,
} from "../schemas/ipc";

export type RunEvent = Static<typeof RunEventSchema>;
export type RunEventEnvelope = Static<typeof RunEventEnvelopeSchema>;
export type RunEventReplayRequest = Static<typeof RunEventReplayRequestSchema>;
export type RunEventReplayResponse = Static<
  typeof RunEventReplayResponseSchema
>;
export type IpcRequest = Static<typeof IpcRequestSchema>;
export type IpcResponse = Static<typeof IpcResponseSchema>;

export interface RunEventsApi {
  replay(request: RunEventReplayRequest): Promise<RunEventReplayResponse>;
  subscribe(listener: (event: RunEventEnvelope) => void): () => void;
}
