import type {
  RunEventEnvelope,
  RunEventReplayRequest,
  RunEventReplayResponse,
} from "../../shared/contracts/ipc";
import type { RunRepository } from "./runRepository";

export interface RunEventPublisher {
  publish(envelope: RunEventEnvelope): void;
}

export class RunEventService {
  constructor(
    private readonly repository: RunRepository,
    private readonly publisher: RunEventPublisher,
  ) {}

  append(envelope: RunEventEnvelope): RunEventEnvelope {
    const result = this.repository.appendEvent(envelope);
    if (result.inserted) {
      this.publisher.publish(result.envelope);
    }
    return result.envelope;
  }

  replay(request: RunEventReplayRequest): RunEventReplayResponse {
    return this.repository.replay(request);
  }
}
