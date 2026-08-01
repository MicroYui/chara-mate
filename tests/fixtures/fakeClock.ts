import type { Timestamp } from "../../src/shared/contracts/primitives";
import type { Clock } from "../../src/shared/pure/clock";

export class FakeClock implements Clock {
  constructor(private current: Timestamp) {}

  advance(milliseconds: number): void {
    this.current = new Date(
      Date.parse(this.current) + milliseconds,
    ).toISOString();
  }

  now(): Timestamp {
    return this.current;
  }
}
