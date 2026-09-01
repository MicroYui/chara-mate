import type {
  PersonaCopyRequest,
  PersonaLibrarySnapshot,
  PersonaSelectRequest,
  PersonaSnapshot,
  PersonaUpdateRequest,
} from "../../shared/contracts/persona";
import {
  PersonaCopyRequestSchema,
  PersonaSelectRequestSchema,
  PersonaUpdateRequestSchema,
} from "../../shared/schemas/persona";
import { parseSchema } from "../../shared/schemas/validation";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import type { PersonaRepository } from "./personaRepository";

export interface PersonaPublisher {
  publish(snapshot: PersonaLibrarySnapshot): void;
}

export class PersonaService {
  constructor(
    private readonly repository: PersonaRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly publisher: PersonaPublisher,
  ) {}

  initialize(): PersonaLibrarySnapshot {
    this.repository.initialize(this.clock.now());
    return this.repository.getLibrary();
  }

  getLibrary(): PersonaLibrarySnapshot {
    return this.repository.getLibrary();
  }

  getActiveSnapshot(): PersonaSnapshot {
    return this.repository.getActiveSnapshot();
  }

  getSnapshot(personaId: string): PersonaSnapshot {
    const snapshot = this.repository.getSnapshot(personaId);
    if (!snapshot) throw new Error("Persona 不存在。");
    return snapshot;
  }

  copy(input: PersonaCopyRequest): PersonaLibrarySnapshot {
    const request = parseSchema(PersonaCopyRequestSchema, input);
    const source = this.getSnapshot(request.sourcePersonaId);
    const now = this.clock.now();
    const snapshot: PersonaSnapshot = {
      ...source,
      displayName: request.displayName,
      personaId: this.ids.generate(),
      revision: 1,
      revisionCreatedAt: now,
      styleName: request.styleName,
    };
    const library = this.repository.insertCustom({ createdAt: now, snapshot });
    this.publisher.publish(library);
    return library;
  }

  update(input: PersonaUpdateRequest): PersonaLibrarySnapshot {
    const request = parseSchema(PersonaUpdateRequestSchema, input);
    const current = this.getSnapshot(request.personaId);
    const now = this.clock.now();
    const library = this.repository.updateCustom({
      expectedRevision: request.expectedRevision,
      snapshot: {
        ...request.value,
        personaId: current.personaId,
        revision: current.revision + 1,
        revisionCreatedAt: now,
      },
      updatedAt: now,
    });
    this.publisher.publish(library);
    return library;
  }

  select(input: PersonaSelectRequest): PersonaLibrarySnapshot {
    const request = parseSchema(PersonaSelectRequestSchema, input);
    const library = this.repository.select(request.personaId, this.clock.now());
    this.publisher.publish(library);
    return library;
  }
}
