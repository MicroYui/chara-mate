import type { FormationModelMock } from "./formationModel";
import type { CognitionAnalysisInput } from "../../src/main/cognition/cognitionTypes";
import type { MemoryEvidenceSelector } from "../../src/main/memory/memoryModels";

/** Scripted Provider replies for desktop lifecycle acceptance. These deliberately
 * do not claim to evaluate model quality; every Memory quote comes from a real Run. */
export function companionModelReply(
  body: string,
  characterLife = false,
): string | undefined {
  const request = JSON.parse(body) as {
    text?: { format?: { name?: string } };
    input?: Array<{ content?: string; type?: string }>;
  };
  const name = request.text?.format?.name;
  if (
    !name ||
    ![
      "charamate_cognition_analysis_v8",
      "memory_formation",
      "memory_evidence_selection_v2",
    ].includes(name)
  )
    return undefined;
  const content = request.input?.find(
    ({ type, content }) => type === "message" && typeof content === "string",
  )?.content;
  if (!content) throw new Error("Missing structured companion input");
  if (name === "charamate_cognition_analysis_v8") {
    const input = JSON.parse(content) as CognitionAnalysisInput;
    const intent = characterLife
      ? input.snapshot.intents.find(
          ({ owner, status, blockers }) =>
            owner === "character" &&
            status === "active" &&
            !blockers.includes("autonomous_life_paused"),
        )
      : undefined;
    const ownLife =
      intent &&
      !input.availability.userEngaged &&
      input.availability.mayActInTerritory;
    return JSON.stringify({
      delta: {
        createSituations: [],
        updateSituations: [],
        createIntents: [],
        updateIntents: [],
        attention: {
          currentSituationId: { op: "keep" },
          committedIntentId: { op: "keep" },
        },
      },
      decision: {
        selectedChoiceId: ownLife ? "life" : "quiet",
        selectedBasis: {
          choiceId: ownLife ? "life" : "quiet",
          evidenceUses: [],
          currentClaimRefs: [],
        },
        reason: "Scripted desktop lifecycle scenario",
        choices: [
          {
            id: "quiet",
            kind: "remain_quiet",
            evidenceIds: [],
            rationale: "No new contribution is required",
            userImpact: "none",
            executionScope: "none",
            reversibility: "read_only",
            timing: "now",
            resumeConditions: [],
          },
          ...(ownLife
            ? [
                {
                  id: "life",
                  kind: "continue_character",
                  intentId: intent.id,
                  evidenceIds: [],
                  rationale:
                    "Continue the character's recorded local intention",
                  userImpact: "none",
                  executionScope: "territory",
                  reversibility: "undoable",
                  timing: "now",
                  resumeConditions: [],
                  instruction:
                    "Observe the room, sleep in the actual bed, then pause your own life.",
                },
              ]
            : []),
        ],
      },
    });
  }
  if (name === "memory_evidence_selection_v2") {
    const input = JSON.parse(content) as Parameters<
      MemoryEvidenceSelector["select"]
    >[0];
    const candidates = input.candidates
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(
        ({ candidate: { content, current } }) =>
          current && content.includes("爱好"),
      );
    return JSON.stringify({
      selected: candidates.map(({ candidateIndex }) => ({
        candidateIndex,
        questionIndices: input.plan.questions.map((_, index) => index),
      })),
      coverage: input.plan.questions.map((_, questionIndex) => ({
        questionIndex,
        status: candidates.length ? "supported" : "missing",
        candidateIndices: candidates.map(
          ({ candidateIndex }) => candidateIndex,
        ),
      })),
    });
  }
  const input = JSON.parse(content) as Parameters<
    FormationModelMock["form"]
  >[0];
  const source = [...input.episode.sources]
    .reverse()
    .find(
      ({ id, speaker, content }) =>
        (!input.episode.evidenceSourceIds ||
          input.episode.evidenceSourceIds.includes(id)) &&
        speaker === "user" &&
        (content.includes("记忆更新测试") || content.includes("记忆形成测试")),
    );
  if (!source) return JSON.stringify({ entities: [], units: [] });
  const changed = source.content.includes("记忆更新测试");
  const existing = input.existing.find(
    ({ content, current }) => current && content.includes("爱好"),
  );
  return JSON.stringify({
    entities: [],
    units: [
      {
        operation: existing ? "revise" : "create",
        targetRevisionId: existing?.revisionId ?? null,
        content: changed ? "用户现在的爱好是游泳。" : "用户的爱好是徒步。",
        ...(existing
          ? {
              retainedCitations: [],
              priorDispositions: [
                {
                  scope: "revision",
                  revisionId: existing.revisionId,
                  disposition: "retained_history",
                  sourceId: source.id,
                  quote: source.content,
                },
              ],
            }
          : { type: "preference" }),
        semantics: {
          kind: "claim",
          owner: "user",
          basis: "explicit_user_statement",
          predicate: "hobby",
          objectValue: changed ? "游泳" : "徒步",
          qualifiers: [],
        },
        entityKeys: [],
        citations: [{ sourceId: source.id, quote: source.content }],
        links: [],
      },
    ],
  });
}
