import type {
  RunEventEnvelope,
  RunEventReplayRequest,
  RunEventReplayResponse,
} from "../../shared/contracts/ipc";
import type { InputResolutionProjection, RunRepository } from "./runRepository";
import type { RunItem } from "../../shared/contracts/run";

export interface RunEventPublisher {
  publish(envelope: RunEventEnvelope): void;
}

export class RunEventService {
  constructor(
    private readonly repository: RunRepository,
    private readonly publisher: RunEventPublisher,
  ) {}

  append(
    envelope: RunEventEnvelope,
    bindAllocation?: (runId: string) => void,
    projectAssistantMessage?: (item: RunItem) => void,
    inputResolution?: InputResolutionProjection,
  ): RunEventEnvelope {
    const result = this.repository.appendEvent(
      envelope,
      bindAllocation,
      projectAssistantMessage,
      inputResolution,
    );
    if (result.inserted) {
      inputResolution?.afterCommit();
      this.publisher.publish(result.envelope);
    }
    return result.envelope;
  }

  replay(request: RunEventReplayRequest): RunEventReplayResponse {
    return this.repository.replay(request);
  }
}
