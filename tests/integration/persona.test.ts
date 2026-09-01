import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openApplicationDatabase } from "../../src/main/db/database";
import { PersonaRepository } from "../../src/main/persona/personaRepository";
import { PersonaService } from "../../src/main/persona/personaService";
import type {
  PersonaLibrarySnapshot,
  PersonaRevisionInput,
  PersonaSnapshot,
} from "../../src/shared/contracts/persona";
import type { IdGenerator } from "../../src/shared/pure/id";
import { FakeClock } from "../fixtures/fakeClock";

const roots: string[] = [];
const NOW = "2026-08-31T08:00:00.000Z";
const CUSTOM_PERSONA_ID = "90000000-0000-4000-8000-000000000001";

function revisionInput(snapshot: PersonaSnapshot): PersonaRevisionInput {
  return {
    addressStyle: snapshot.addressStyle,
    background: snapshot.background,
    defaultVoice: snapshot.defaultVoice,
    disabledExpressions: snapshot.disabledExpressions,
    displayName: snapshot.displayName,
    identity: snapshot.identity,
    initiativeStyle: snapshot.initiativeStyle,
    knowledgeBoundary: snapshot.knowledgeBoundary,
    motivations: snapshot.motivations,
    speechStyle: snapshot.speechStyle,
    styleName: snapshot.styleName,
    values: snapshot.values,
    voiceInstructions: snapshot.voiceInstructions,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("Persona persistence and selection", () => {
  it("seeds presets, copies one editable Persona and revisions it without rewriting history", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "charamate-persona-"));
    roots.push(root);
    const databasePath = path.join(root, "app.sqlite");
    const database = openApplicationDatabase(databasePath);
    const published: PersonaLibrarySnapshot[] = [];
    const service = new PersonaService(
      new PersonaRepository(database),
      { generate: () => CUSTOM_PERSONA_ID } satisfies IdGenerator,
      new FakeClock(NOW),
      { publish: (snapshot) => published.push(snapshot) },
    );

    const initial = service.initialize();
    expect(initial.personas).toHaveLength(4);
    expect(service.getActiveSnapshot()).toMatchObject({
      displayName: "Mika",
      revision: 1,
      styleName: "元气开朗",
    });

    const copied = service.copy({
      displayName: "Lumi",
      sourcePersonaId: initial.activePersonaId,
      styleName: "清醒温暖",
    });
    expect(copied.activePersonaId).toBe(initial.activePersonaId);
    expect(service.getSnapshot(CUSTOM_PERSONA_ID)).toMatchObject({
      displayName: "Lumi",
      revision: 1,
      styleName: "清醒温暖",
    });

    service.select({ personaId: CUSTOM_PERSONA_ID });
    const beforeUpdate = service.getActiveSnapshot();
    const editable = revisionInput(beforeUpdate);
    service.update({
      expectedRevision: beforeUpdate.revision,
      personaId: beforeUpdate.personaId,
      value: {
        ...editable,
        disabledExpressions: ["空泛鼓励"],
        speechStyle: "简洁、具体，允许轻微幽默。",
      },
    });
    const updated = service.getActiveSnapshot();
    expect(updated).toMatchObject({
      disabledExpressions: ["空泛鼓励"],
      personaId: CUSTOM_PERSONA_ID,
      revision: 2,
      speechStyle: "简洁、具体，允许轻微幽默。",
    });
    expect(beforeUpdate).toMatchObject({
      disabledExpressions: ["打起精神", "你应该马上", "作为一个AI"],
      revision: 1,
    });
    expect(published).toHaveLength(3);
    database.close();

    const reopened = openApplicationDatabase(databasePath);
    const repository = new PersonaRepository(reopened);
    expect(repository.getActiveSnapshot()).toEqual(updated);
    expect(repository.getLibrary().personas).toHaveLength(5);
    reopened.close();
  });
});
