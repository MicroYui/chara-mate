import type { Timestamp } from "../../shared/contracts/primitives";

export interface ForegroundActivityObservation {
  readonly appId?: string;
  readonly appName: string;
  readonly eventId: string;
  readonly observedAt: Timestamp;
  readonly windowTitle?: string;
}

export interface ForegroundActivityObserver {
  observeForeground(observation: ForegroundActivityObservation): void;
}
