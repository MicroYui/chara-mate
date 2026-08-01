import type { Timestamp } from "../contracts/primitives";

export interface Clock {
  now(): Timestamp;
}

export class SystemClock implements Clock {
  now(): Timestamp {
    return new Date().toISOString();
  }
}
