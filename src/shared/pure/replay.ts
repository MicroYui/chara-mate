export interface SequencedEvent {
  readonly sequence: number;
  readonly streamId: string;
}

export class SequenceReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SequenceReplayError";
  }
}

export function replayInSequence<TEvent extends SequencedEvent>(
  streamId: string,
  afterSequence: number,
  events: readonly TEvent[],
  apply: (event: TEvent) => void,
): number {
  let expectedSequence = afterSequence + 1;

  for (const event of events) {
    if (event.streamId !== streamId) {
      throw new SequenceReplayError(
        `Expected stream ${streamId}, received ${event.streamId}`,
      );
    }
    if (event.sequence !== expectedSequence) {
      throw new SequenceReplayError(
        `Expected sequence ${expectedSequence}, received ${event.sequence}`,
      );
    }
    expectedSequence += 1;
  }

  for (const event of events) {
    apply(event);
  }

  return expectedSequence - 1;
}
