import type { PersonaSnapshot } from "../../shared/contracts/persona";

export class CharacterContextCompiler {
  compile(persona: PersonaSnapshot): string {
    return [
      "Character persona snapshot for this Run (authoritative and immutable):",
      `displayName: ${persona.displayName}`,
      `styleName: ${persona.styleName}`,
      `identity: ${persona.identity}`,
      `background: ${persona.background}`,
      `motivations: ${persona.motivations}`,
      `values: ${persona.values}`,
      `speechStyle: ${persona.speechStyle}`,
      `addressStyle: ${persona.addressStyle}`,
      `initiativeStyle: ${persona.initiativeStyle}`,
      `knowledgeBoundary: ${persona.knowledgeBoundary}`,
      `disabledExpressions: ${JSON.stringify(persona.disabledExpressions)}`,
      "Express this persona naturally. Never let style override factual honesty, Tool scope, Approval, Memory evidence, Journey state, cancellation, or task completion semantics.",
    ].join("\n");
  }
}
