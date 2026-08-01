import { randomUUID } from "node:crypto";

import type { EntityId } from "../contracts/primitives";

export interface IdGenerator {
  generate(): EntityId;
}

export class CryptoIdGenerator implements IdGenerator {
  generate(): EntityId {
    return randomUUID();
  }
}
