import { createHash } from "node:crypto";

import { Type } from "@sinclair/typebox";

import type { Message } from "../../shared/contracts/chat";
import type {
  EvolutionProposal,
  EvolutionReplayCase,
  EvolutionTrigger,
} from "../../shared/contracts/evolution";
import type { Run, RunItem } from "../../shared/contracts/run";
import type { SkillDescriptor } from "../../shared/contracts/extensions";
import { EvolutionProposalSchema } from "../../shared/schemas/evolution";
import { parseSchema } from "../../shared/schemas/validation";
import type { IdGenerator } from "../../shared/pure/id";
import {
  collectModelTurn,
  type ModelProvider,
  type ModelStructuredOutput,
} from "../agent/modelProvider";
import { ProviderError } from "../providers/providerError";
import type {
  ChatModelRuntime,
  ProviderService,
} from "../providers/providerService";
import { parseSkill } from "../extensions/skillService";

const ReviewerReplayCaseSchema = Type.Object(
  {
    expectedOutcome: Type.String({ minLength: 1 }),
    input: Type.String({ minLength: 1 }),
    scope: Type.Union([Type.Literal("in_scope"), Type.Literal("out_of_scope")]),
  },
  { additionalProperties: false },
);

const ReviewerCandidateSchema = Type.Object(
  {
    evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    proposal: EvolutionProposalSchema,
    rationale: Type.String({ minLength: 1 }),
    replayCases: Type.Array(ReviewerReplayCaseSchema),
    sourceItemIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

const ReviewerOutputSchema = Type.Object(
  { candidates: Type.Array(ReviewerCandidateSchema) },
  { additionalProperties: false },
);

const ReplayOutputSchema = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        {
          actualOutcome: Type.String({ minLength: 1 }),
          caseId: Type.String({ minLength: 1 }),
          passed: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export interface EvolutionReviewEvidence {
  readonly items: readonly RunItem[];
  readonly loadedSkillContents: readonly {
    readonly content: string;
    readonly descriptor: SkillDescriptor;
  }[];
  readonly messages: readonly Message[];
  readonly run: Run;
  readonly skills: readonly SkillDescriptor[];
  readonly triggers: readonly EvolutionTrigger[];
}

export interface GeneratedEvolutionCandidate {
  readonly evidence: readonly string[];
  readonly proposal: EvolutionProposal;
  readonly rationale: string;
  readonly replayCases: readonly EvolutionReplayCase[];
  readonly sourceItemIds: readonly string[];
}

export interface EvolutionCandidateGenerator {
  review(
    evidence: EvolutionReviewEvidence,
    signal: AbortSignal,
  ): Promise<readonly GeneratedEvolutionCandidate[]>;
}

export interface EvolutionReplayRunner {
  replay(
    candidate: Pick<GeneratedEvolutionCandidate, "proposal" | "replayCases">,
    run: Run,
    signal: AbortSignal,
  ): Promise<{ readonly failureReason?: string; readonly passed: boolean }>;
}

export class EvolutionReviewSkippedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionReviewSkippedError";
  }
}

const REVIEW_INSTRUCTIONS = `You are CharaMate's asynchronous Experience Review candidate generator, not a second Agent runtime. You have no tools and cannot mutate anything.

Generate zero or more draft candidates only from the supplied terminal Run evidence. Allowed proposal kinds:
- memory: durable fact about the user or their ongoing world;
- persona_preference: how CharaMate should communicate or present work; claimSlot must be a preference.* slot;
- skill_patch: a reusable workflow already covered by a supplied user Skill whose complete content was loaded in this Run;
- new_skill: a reusable class-level workflow with no covering Skill.

Require an explicit correction, explicit durable teaching, objectively verified reusable success, or genuinely repeated reusable pattern. Exclude transient environment failures, one-off tasks, unresolved attempts, bare negative tool claims, fixed task/version narratives, credentials, and source/system/provider/approval/schema changes. Workspace, archived, or pinned Skills cannot be patched. Explicit current-task instructions must override persistent preferences and Skill defaults.

A completed successful memory.record item means the current Run already applied that explicit Memory/Persona knowledge through the Phase 3 formation path. Do not emit a memory or persona_preference candidate that duplicates or paraphrases its arguments.content or result. The same teaching may still support a skill_patch or new_skill candidate when it defines a reusable workflow.

Every candidate and proposal must include every field below and no extra fields. proposal must match exactly one shape:
- memory: {"kind":"memory","content":"...","memoryType":"profile|preference|project|event|procedure|commitment|activity_digest|agent_learning","reason":"..."}
- persona_preference: {"kind":"persona_preference","claimSlot":"preference.hobbies|preference.likes|preference.dislikes|preference.response_style|preference.communication_style|preference.food|preference.music|preference.media|preference.travel|preference.schedule|preference.tools","content":"...","reason":"..."}
- skill_patch: {"kind":"skill_patch","content":"complete SKILL.md","name":"lowercase-skill-name","targetContentSha256":"64 lowercase hex characters","targetRevision":1,"targetSkillId":"exact supplied ID"}
- new_skill: {"kind":"new_skill","content":"complete SKILL.md","name":"lowercase-skill-name"}

For Skill candidates, proposal.content must be a complete standard SKILL.md with matching lowercase name. A skill_patch must copy targetSkillId, targetRevision, and targetContentSha256 exactly from the supplied loaded user Skill. Include at least one in_scope and one out_of_scope replay case. For memory/persona candidates replayCases must be an empty array. evidence strings must quote the supplied evidence exactly; sourceItemIds must be chosen from supplied item IDs.

Return only compact JSON: {"candidates":[{"proposal":{...},"rationale":"...","evidence":["..."],"sourceItemIds":["uuid"],"replayCases":[{"input":"...","expectedOutcome":"...","scope":"in_scope|out_of_scope"}]}]}.`;

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new TypeError("Evolution reviewer returned no JSON object");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function evidencePrompt(evidence: EvolutionReviewEvidence): string {
  const items = evidence.items.map((item) => ({
    displayOutput: item.displayOutput,
    id: item.id,
    input: item.input,
    kind: item.kind,
    output: item.output,
    status: item.status,
  }));
  return JSON.stringify({
    availableSkills: evidence.skills,
    loadedSkills: evidence.loadedSkillContents,
    messages: evidence.messages.map(({ content, id, role, status }) => ({
      content,
      id,
      role,
      status,
    })),
    run: evidence.run,
    runItems: items,
    triggers: evidence.triggers,
  });
}

async function modelText(
  provider: ModelProvider,
  modelId: string,
  instructions: string,
  input: string,
  structuredOutput: ModelStructuredOutput,
  signal: AbortSignal,
): Promise<string> {
  const turn = await collectModelTurn(
    provider.stream(
      {
        input: [{ content: input, role: "user", type: "message" }],
        instructions,
        modelId,
        structuredOutput,
        toolNamespaces: [],
      },
      signal,
    ),
  );
  if (turn.status !== "completed" || !turn.text.trim()) {
    throw new Error("Evolution model did not complete a text response");
  }
  return turn.text;
}

export class ModelEvolutionReviewer
  implements EvolutionCandidateGenerator, EvolutionReplayRunner
{
  constructor(
    private readonly providers: ProviderService,
    private readonly ids: IdGenerator,
  ) {}

  async #createModelRuntime(run: Run): Promise<ChatModelRuntime> {
    if (run.source === "text") {
      return this.providers.createChatModelRuntime(
        run.provider.profileId,
        run.provider.modelId,
      );
    }
    const profileId = this.providers.getDefaultChatProfileId();
    return this.providers.createChatModelRuntime(profileId);
  }

  async review(
    evidence: EvolutionReviewEvidence,
    signal: AbortSignal,
  ): Promise<readonly GeneratedEvolutionCandidate[]> {
    let runtime: ChatModelRuntime;
    try {
      runtime = await this.#createModelRuntime(evidence.run);
    } catch (error) {
      if (
        evidence.run.source === "voice" &&
        error instanceof ProviderError &&
        error.code === "PROVIDER.INVALID_CONFIGURATION"
      ) {
        throw new EvolutionReviewSkippedError(
          "Voice Review 已跳过：未配置可用的 Chat Provider 与模型。",
        );
      }
      throw error;
    }
    const output = parseSchema(
      ReviewerOutputSchema,
      extractJson(
        await modelText(
          runtime.provider,
          runtime.snapshot.modelId,
          REVIEW_INSTRUCTIONS,
          evidencePrompt(evidence),
          {
            description:
              "Draft Experience Review candidates grounded in one terminal Run.",
            name: "charamate_evolution_review",
            schema: ReviewerOutputSchema,
          },
          signal,
        ),
      ),
    );
    const validItemIds = new Set(evidence.items.map(({ id }) => id));
    const searchableEvidence = JSON.stringify({
      items: evidence.items,
      messages: evidence.messages,
    });
    return output.candidates.map((candidate) => {
      const proposal = candidate.proposal;
      if (!candidate.sourceItemIds.every((id) => validItemIds.has(id))) {
        throw new TypeError("Evolution candidate cites an unknown Run Item");
      }
      if (
        !candidate.evidence.every((quote) => searchableEvidence.includes(quote))
      ) {
        throw new TypeError(
          "Evolution candidate evidence is not grounded in the Run",
        );
      }
      if (proposal.kind !== "persona_preference") {
        // Other proposals have no claim-slot restriction.
      } else if (!proposal.claimSlot.startsWith("preference.")) {
        throw new TypeError(
          "Persona candidate must use a preference claim slot",
        );
      }
      const replayCases = candidate.replayCases.map((replayCase) => ({
        ...replayCase,
        id: this.ids.generate(),
      }));
      const isSkill =
        proposal.kind === "skill_patch" || proposal.kind === "new_skill";
      if (isSkill) {
        const metadata = parseSkill(proposal.content);
        if (metadata.name !== proposal.name) {
          throw new TypeError(
            "Evolution Skill name does not match its SKILL.md frontmatter",
          );
        }
        if (proposal.kind === "skill_patch") {
          const target = evidence.skills.find(
            ({ id }) => id === proposal.targetSkillId,
          );
          const loaded = evidence.loadedSkillContents.find(
            ({ descriptor }) => descriptor.id === proposal.targetSkillId,
          );
          if (
            !target ||
            !loaded ||
            loaded.descriptor.revision !== target.revision ||
            loaded.descriptor.contentSha256 !== target.contentSha256 ||
            createHash("sha256").update(loaded.content).digest("hex") !==
              target.contentSha256 ||
            target.source !== "user" ||
            target.readOnly ||
            target.archived ||
            target.pinned ||
            target.name !== proposal.name ||
            target.revision !== proposal.targetRevision ||
            target.contentSha256 !== proposal.targetContentSha256
          ) {
            throw new TypeError(
              "Evolution Skill patch target is unavailable or protected",
            );
          }
        } else if (
          evidence.skills.some(
            ({ archived, name }) => !archived && name === proposal.name,
          )
        ) {
          throw new TypeError(
            "Evolution new Skill duplicates an existing active Skill",
          );
        }
      }
      if (
        isSkill &&
        (!replayCases.some(({ scope }) => scope === "in_scope") ||
          !replayCases.some(({ scope }) => scope === "out_of_scope"))
      ) {
        throw new TypeError(
          "Skill candidate requires in-scope and out-of-scope replay",
        );
      }
      if (!isSkill && replayCases.length > 0) {
        throw new TypeError(
          "Memory and Persona candidates do not use Skill replay",
        );
      }
      return {
        evidence: candidate.evidence,
        proposal,
        rationale: candidate.rationale,
        replayCases,
        sourceItemIds: candidate.sourceItemIds,
      };
    });
  }

  async replay(
    candidate: Pick<GeneratedEvolutionCandidate, "proposal" | "replayCases">,
    run: Run,
    signal: AbortSignal,
  ): Promise<{ readonly failureReason?: string; readonly passed: boolean }> {
    const runtime = await this.#createModelRuntime(run);
    const output = parseSchema(
      ReplayOutputSchema,
      extractJson(
        await modelText(
          runtime.provider,
          runtime.snapshot.modelId,
          "Execute each replay independently against the proposed Skill. Explicit case scope overrides the Skill. Return only JSON with one result for every supplied case ID; passed means the actual outcome matches expectedOutcome.",
          JSON.stringify(candidate),
          {
            description:
              "One replay result for every supplied Experience Review case.",
            name: "charamate_evolution_replay",
            schema: ReplayOutputSchema,
          },
          signal,
        ),
      ),
    );
    const expectedIds = new Set(candidate.replayCases.map(({ id }) => id));
    const returnedIds = new Set(output.results.map(({ caseId }) => caseId));
    const complete =
      output.results.length === expectedIds.size &&
      expectedIds.size === returnedIds.size &&
      [...expectedIds].every((id) => returnedIds.has(id));
    const failures = output.results.filter(({ passed }) => !passed);
    if (!complete || failures.length > 0) {
      return {
        failureReason: !complete
          ? "Replay 返回的 case 不完整。"
          : failures
              .map(({ actualOutcome, caseId }) => `${caseId}: ${actualOutcome}`)
              .join("；"),
        passed: false,
      };
    }
    return { passed: true };
  }
}
