import { describe, expect, it } from "vitest";

import { defaultPersonaSnapshot } from "./personaPresets";
import { CharacterContextCompiler } from "./characterContext";

describe("CharacterContextCompiler", () => {
  it("compiles the immutable Persona fields used by text and Agent responses", () => {
    const persona = {
      ...defaultPersonaSnapshot("2026-08-31T08:00:00.000Z"),
      displayName: "Lumi",
      disabledExpressions: ["空泛鼓励", "替用户下结论"],
      speechStyle: "先给具体回应，再补一小句轻松的观察。",
      styleName: "清醒温暖",
    };

    const instructions = new CharacterContextCompiler().compile(persona);

    expect(instructions).toContain("displayName: Lumi");
    expect(instructions).toContain("styleName: 清醒温暖");
    expect(instructions).toContain(persona.identity);
    expect(instructions).toContain(persona.speechStyle);
    expect(instructions).toContain(
      'disabledExpressions: ["空泛鼓励","替用户下结论"]',
    );
    expect(instructions).toContain("Never let style override factual honesty");
    expect(instructions).not.toContain(persona.voiceInstructions);
  });
});
