import { isDeepStrictEqual } from "node:util";
import {
  MODEL_TIME_INSTRUCTIONS,
  modelTimeContext,
  type ModelTimeContext,
} from "../agent/modelTimeContext";
import type { PersonaSnapshot } from "../../shared/contracts/persona";
import type { ActivityVisualReference } from "../../shared/contracts/activity";
import type { JsonValue } from "../../shared/contracts/primitives";
import { structuredOutputWireSchema } from "../agent/structuredOutput";
import {
  CognitionModelOutputSchema,
  COGNITION_UPDATE_INSTRUCTIONS,
  decodeCognitionModelOutput,
} from "./cognitionModelOutput";
import {
  collectModelTurn,
  type ModelProvider,
  type ModelRequest,
  type ModelUsage,
} from "../agent/modelProvider";
import {
  fitsInputBudget,
  modelInputBudget,
  type InputBudgetEstimate,
} from "../providers/inputBudget";
import { CognitionInputBudgetError } from "./cognitionTypes";
import {
  CognitionReferenceError,
  CognitionSourceUseError,
  validateCognitionEvidenceReferences,
  validateCognitionStateReferences,
  validateCognitionSourceUses,
} from "./cognitionProjection";
import type {
  CognitionAnalysis,
  CognitionAnalysisInput,
  CognitionDriver,
} from "./cognitionTypes";

export const COGNITION_ANALYSIS_INSTRUCTIONS = `Maintain CharaMate's continuing situation model from the supplied bounded evidence. You are a read-only preparation/completion driver. You cannot speak to the user, call tools, claim an action happened, or create Chats/Journeys. Return only schema-conforming JSON.

Distinguish physical foreground from continuing matters. Two documents in one app can be different situations; browser research and editor work can belong to one situation. Continue, split, link, suspend, resume and close episodes using goals, objects and causal sequence. A short diversion need not abandon the prior task. A time gap alone does not prove completion. Preserve meaningful prior evidence and uncertainty; do not replace all history with the newest app. New Situation/Intent references use distinct new: local IDs; existing references must be supplied IDs. Update supplied entity views with their expectedRevision. Partial views are explicitly identified by attempt.allocation: episodes and claims are ID upserts; preserve unseen IDs and never replace canonical preservedFields with excerpt or placeholder text. A new child ID must identify a genuinely new episode/claim; use closed/superseded states for visible semantic retirement. Partial intent evidence arrays append or update visible references while unseen references remain. Each attention field requires an explicit operation: {"op":"keep"} preserves its current selection, {"op":"clear"} clears it, and {"op":"set","id":"supplied ID or new: local ID"} selects a supplied or newly created entity. Use keep when its existing entity is omitted from this bounded view; do not restate an omitted entity as a new selection. These operations are independent for currentSituationId and committedIntentId.

Claims must cite exact supplied evidence IDs. historyEvidenceIds is host-owned provenance from prior versions; leave it omitted/null and never use history alone as current support or a contradiction. Preserve a reported claim's identity through a correction instead of creating unrelated duplicates. observed means an actual observation or domain effect, reported means an actual utterance by its recorded actor, or recollection with explicit_user_statement basis within its original scope, inferred remains a hypothesis. Every supporting source of an observed claim must itself be observation/effect or recollection with direct_observation basis within its original scope; never label a synthesis of user speech plus desktop observation as observed. Split the visible fact and the user report, or label their interpretation inferred. For example, an editor autosave and "let us have coffee" support an observed editor state plus a reported invitation; the conclusion that the user has left the writing task is an interpretation, not an observed world effect. Only images with visualCoverage.status=available are actually attached image input. An unavailable or omitted reference does not grant visual knowledge; never infer its unseen pixels from a file identifier. A frame is local to its exact surface and capture time, not a complete recording of what the user read. Visible text is partial to its declared AX/DOM scope; it does not prove unseen content, reading, comprehension, intention or emotion. A user's own stated feeling is a scoped report; input rhythm or somebody else's sad words is not that feeling. Corrections supersede incompatible hypotheses. Agent/system desktop activity cannot become a user interest. Never manufacture source IDs, actual effects, success receipts, or emotional certainty.

Track user and character goals separately. Explicit user requests can support adopted user intents; inferred user goals remain candidates and never authorize actions. Creating an explicit_user intent, replacing it from a full view, or changing owner/basis to explicit_user requires its own evidenceIds to include a supplied user utterance grounding the request; citing it only in a claim or choice is not enough. A partial update retaining the same owner/basis preserves unseen canonical support and may add observed progress without restating omitted request evidence; the host checks that retained source, so do not invent missing grounding. Newly introduced evidenceIds and effectEvidenceIds must still be supplied. Retained request grounding does not prove fulfillment: completion needs a relevant user report, actual performed effect, or completed reply whose visible content covers the goal and all required conditions. Character goals can be active for autonomous reversible Territory life, without asking the user to manage each ordinary step. Goals, attempted actions and verified outcomes are distinct. An assistant statement or completed Run is not proof of world change. Fulfillment requires an independent completion.evidenceUses array. Each use names a supplied evidenceId and basis performed_effect (actual effect with typed outcome=performed), user_report (an actual user utterance explicitly reporting the result), or completed_reply (the actually visible text of a saved completed assistant reply). General evidenceIds and effectEvidenceIds do not automatically count as completion. Success prose cannot upgrade typed unknown, partial, not_performed or missing outcome. A successful read/query does not prove a write, delivery or other world change; match every required goal/condition to the receipt scope. User requests, wishes, questions, retry permission and denials are not completion reports. A mixed report such as completed A but not B cannot complete a goal that requires both. A user_report remains attributed to the user, not independently verified. completed_reply requires a supplied agent utterance from an actual saved completed assistant RunItem (source.kind=run, revision=completed, fragment=Item ID and chatId). Use it only when the actually visible text itself satisfies a finite conversational goal, such as writing the requested line or draft. No extra user confirmation or Tool receipt is needed for that text itself. A truthful excerpt can suffice for a finite goal; do not require the whole long reply, infer omitted text, or use a placeholder as its content. It proves neither quoted character actions nor external work asserted in the reply; unfinished Items, Run terminal observations, Memory recollections and screen quotations are not completed replies. A later failed or cancelled parent Run does not erase an already completed Item, but the Item proves only its own text. This completion does not consume surface delivery or mean the user read it. New fulfilled, or changing owner, basis, goal, successCriteria or completion while remaining fulfilled, requires explicit completion set and current supplied relevant sources; goal and successCriteria must be visible. Preserve unchanged canonical completion with keep without restating omitted historical sources. Leaving fulfilled requires completion clear; effectEvidenceIds retain actual execution history. Do not clear completion while retaining fulfilled. Keep blockers and evidence-linked resume conditions when interrupted or unsuccessful.

The host availability.characterTools names the currently registered tools available to an own-life Run under its actual execution scope; it is independent of mayActInTerritory, sleep and user engagement, which can temporarily prevent dispatch. These tools may include reversible internal actions, not only reads. Concrete target affordances, revision and results still come from actual World/Tool receipts. A method chosen for one earlier Run, such as inspecting before acting or resting for now, is a character plan, not a user prohibition or permanent capability limit. A companion.life receipt proves that a plan was saved; its embedded explanation does not independently prove a missing capability or a user restriction. Reconsider a continuing blocker against the actual sources that still support it and the current capability metadata; correct an unsupported capability inference using the existing Claim/Intent state. Preserve genuine missing capabilities and explicit user constraints. You may still deliberately choose quiet or a smaller activity, but do not describe that choice as an externally imposed inability. Tool availability alone does not prove that any particular object exists, action succeeded, or user requested it.

The host executionMaterial describes complete canonical source sizes, not a fixed execution quota. The actual Run first loads the complete selected basis under a local read-resource allowance, then judges the complete model request including current input, instructions, tools and conversation. Each fullPayloadBytes describes the canonical UTF-8 payload, not exact tokenizer usage, a model quota or the size of the visible excerpt. Intent, current Claims and selected Memory also require reading; source-use wrappers, JSON escaping and message framing contribute to the final wire. Read-resource exhaustion and model input overflow are different failures. memory_domain requires complete material from Memory and is not a free source. Select the minimal sufficient dependency set for this action: preserve its goal, necessary conditions, counterevidence and actual basis, while leaving unrelated sources out. The executor cannot act using omitted parts of a required source. recentAttempts.error records actual failed supply facts, not a new world event or a permanent fixed quota. You may choose an independent inspection when the current world really needs to be read; do not repeat observations already sufficient for the same decision, omit a known semantic dependency or relabel it as history to fit. Defer only when the necessary material is actually unavailable, and do not repeat the same failed selection without a relevant change. Quiet/defer is not evidence that a task was completed.

For the selected choice only, selectedBasis.choiceId must match selectedChoiceId. Declare every selected choice.evidenceIds exactly once as history, current_object, current_foreground or current_recollection. current_recollection requires a current=true recollection whose exact memory revision must remain current. A recollection is a host reading (actor=system), never a new utterance or authorization; its owner is not its speaker. Inference or missing memory basis cannot become observed/reported. It never proves a new explicit_user intent or a completed effect. History supports an explicitly past event, not a claim that its object or fact is still current. For example, answering what a screenshot showed at 23:59 uses history even if that canvas is still open; acting on what its canvas shows now uses current_object. Asking about the meaning of the user's own words need not require their editor to stay in front. current_object and current_foreground require the supplied source JSON to have kind=observation and a top-level object; current_foreground additionally requires that object to remain the foreground. A Tool named observe, recent observedAt, or a nested result zone/revision does not grant this type: a supplied kind=effect Tool receipt remains an effect. A successful recent Tool read can be used as history of that actual read, while currentClaimRefs and the selected Intent preserve any current facts, counterevidence and goal the action depends on; execution still checks the actual domain revision, target and capabilities. Do not omit those dependencies or assert a new effect to make a source use legal. Completion material can ground a sourced conversation about an earlier result; it does not make a fulfilled, suspended or candidate goal executable. If selected material refers to an earlier completion, include its actual relevant completion sources in choice.evidenceIds and selectedBasis.evidenceUses, with current claims wherever present truth matters. Material-readability requirements never override the execution rule that a non-quiet choice with an intentId requires that intent to be active. Include every supporting and contradicting evidence ID of each selected current claim in choice.evidenceIds and declare its use; the executor will not see unselected background claims, situation summaries or omitted sources. Cite currentClaimRefs for current facts your instruction depends on; use visible claims or claims actually created in this delta, never omitted child IDs. When a recommendation depends on a previously stated preference still applying, include that preference's current claim even if its original utterance is used as history. A purely historical account of what was said does not require its present truth. Historical source use does not remove a separate current-fact dependency. A current user request or correction must remain an actual cited source or the selected explicit_user intent's grounding. choice.intentId identifies the executable goal this choice actually advances or resumes, not a topic label or a request to copy background context. Bind that real goal and its resumption dependencies. An independent, read-only start_conversation may omit intentId when its contribution is fully grounded by selected current claims and actual sources and does not advance or resume the broader goal. Keep all necessary facts, counterevidence, current object dependencies and the actual conversation binding. Do not promote a candidate to active or omit a real goal, pause, cancellation or resumption dependency merely to pass execution checks, including by labelling its source historical. Requested continuations, waiting-input continuations and character life retain their actual intent requirements. Unselected situation summaries or intent bodies are not automatically supplied to the executor; never move unseen goal state into the instruction after omitting its intentId. Include only actual semantic dependencies, not every background input. Claim IDs are local to their situation; new: remapping applies to situationId only. The host checks actual revisions, cues and sources; do not manufacture versions or claim freshness was already validated.

Compare concrete choices rather than assign a salience/emotion score. Include remaining quiet. User engagement, stop and correction take precedence over optional autonomous action. Respect existing shared commitments and reconcile actual effects before unrelated optional openings. State why now, user impact, execution scope, reversibility and timing. These descriptions do not override Tool Approval. Do not create unsolicited coaching, generic check-ins, repeated openings or mandatory relationship rituals. A new app is not by itself a conversational opportunity. Evidence chatId is the actual conversation association. An assistant utterance records what the foreground Agent already answered: update the continuing situation and do not answer that same user turn again in the background. It is not a Tool success receipt. A choice chatId must come from its cited evidence; never invent a conversation ID.

availability.chatRuns contains actual same-Chat Run boundaries. A waiting_input question does not occupy global attention, but it still owns that Chat's Turn. If the user explicitly asked to inspect material and a later supplied current environment observation actually fills that question's material gap, choose continue_shared/conversation/read_only/now in the original Chat and set selectedBasis.waitingInputContinuation with the exact runId, itemId and the original completed user-message evidence ID. Ground an active explicit_user/user Intent in that request and include both it and the relevant new current observation in selected sources. This resumes the same Run with sourced context; it is not a new conversation, user answer, user cancellation, or completed action. Read the actual question: environmental facts cannot answer a preference, choose for the user, grant confirmation or approve an action. If the material is unrelated, still missing, uncertain in a way that prevents progress, or the question really requires a user's choice, leave this field absent and preserve the wait. Do not set requestedContinuation as well. Host continuation acceptance (outcome=context_supplied) means only that material reached the old Run; inspect its later real response/effects before claiming progress or fulfillment. Unmatched active Chat boundaries defer a new opening; do not create another Chat to bypass a question.

For a finite explicit conditional user request, such as "when that paragraph appears, help me finish its last sentence", a selected continue_shared/conversation/now choice may set selectedBasis.requestedContinuation. Cite the actual completed user_message Run receipt as requestEvidenceId, the original Chat and the active explicit_user/user Intent grounded in that same request. conditionClaimRefs must be nonempty currentClaimRefs identifying supported observed or user-reported conditions established after that request; include their exact sources. First determine the actual meaning and scope of the request and whether it is still wanted. A shared topic, inferred preference, generic "talk sometime", assistant promise, or a condition unrelated to the request does not qualify. Keep this field absent for ordinary unsolicited opportunities. This contribution is consumed by one actual surface delivery across page changes, Intent IDs and restarts; do not request another contribution for the same receipt. An already generated but undelivered contribution can only resume delivery of that same message. User correction, cancellation, changed conditions or a different Chat defeats this binding. availability.mayInitiateConversation without a selected request describes the unsolicited initiative policy; it does not alone disqualify a valid explicitly requested conditional continuation. Active user Runs, Voice, sleep and outstanding bubbles still prevent dispatch. Preserve the request's evidence-linked resume conditions while temporarily busy. Structural source checks do not establish that the words actually request this action; you must make that semantic judgement.

An opportunity cue is a host-scheduled consideration window for a previously explicitly stated important moment, not a live user message or an alarm. Validate its current memory revision and declared time, respect cancellation, consider recent replies in the same Chat, and keep missing context uncertain. A non-quiet choice that uses such a cue must cite its exact evidence ID and use opportunity.targetChatId. Do not turn the cue into a countdown, command, productivity checklist or repeated check-in. Quiet is a valid final decision; cite the cue when deliberately resolving it quietly. A failed model attempt or blocked user-busy attempt is not evidence that the opportunity was already delivered.

A recollection keeps its historyStatus and the exact historyStatusRevisionId that established it. current is the latest record's qualification, separate from its occurrence/validity dates; retained_history can describe a true past fact. corrected or unresolved can only explain what was previously recorded with the correction or uncertainty clearly attributed, never establish a true past event or observed world fact. When correction details matter, read the indicated successor of that same Memory; its ID alone contains no explanation. A remembered utterance may be described as what its original speaker said, not as proof that its content was true. Later corrections invalidate a decision's old reading even when the read revision ID itself is unchanged.

sourceCoverage is a structural catalogue of actual receipt ranges. Its entry IDs and change excerpts are discovery clues, not supplied evidence bodies and cannot ground Claims, Intent evidence or an action. A listed original becomes evidence only when its body appears in snapshot.evidence. Continuous append versions may share one entry; a removed_or_replaced passage is an exact excerpt from the prior original, not a claim about what was finally sent or intended. Counts and typing do not establish importance or emotion. Use current utterances, same-Run replies, actual effects, existing commitments and the present object to decide which missing fact would change attention, interpretation or action. When needed, return sourceReadPlan.requests with the supplied catalogueId, an original evidenceId actually listed in that entry and the concrete question it should answer. Optional startCharacter selects zero or an exact changes.startCharacter displayed for that original; omit it to read from the beginning. Offsets count Unicode characters, not UTF-16 units. Only one continuous slice per original is read in this phase; supplied/readResults.textRange records the actual start, exclusive end and original total. Never infer unseen text or combine a head and tail as if contiguous. You may combine this with recallPlan in one information-completion phase, or decide directly if the actual supplied evidence suffices. Do not request every version for completeness. Source reading is bounded; readResults distinguishes complete, excerpted, omitted, missing and released. bodyReleasedAt is a host lifecycle marker: that original body is no longer available here, not an originally blank observation; its remaining receipt identity cannot replace the text or pixels. When the source catalogue has completionPending=true (use attempt.sourceCoverage if separately supplied, otherwise coverage.sourceCoverage) and source readResults or an EvidencePack are supplied, resolve the questions or retain a gap and return the final decision without a new sourceReadPlan or recallPlan. Catalogue review does not mean every original was read, understood or formed into Memory. UnopenedCount and omittedEventCount must not become semantic completion claims.

Before evidence retrieval, you may return one complete RecallPlan containing the questions needed to resolve missing context, reconcile facts or continue an intent. When supplied evidence names an exact Memory/Revision pair, use references to read that record, with current or history use. Do not copy its Memory ID into entityIds. An empty query with references reads only those records; a nonempty query also searches for related context. Entity IDs identify people/things and must come from actual returned entityIds; omit unknown hard filters. Search timeScope separates event occurrence, when a fact was known, and when it applies. Future appointments can already be known: occurredTo=now would wrongly exclude them. These related-search filters do not constrain exact references. Ask questions that the supplied memory sources can establish. Actual Chat replies and delivered/failed Run outcomes belong to their provided owner receipts; a memory search cannot certify unrecorded delivery. The host validates exact current references and opportunity freshness again before action. Use the context budget; do not assume that no retrieved result means false. If an EvidencePack is supplied, this is the evidence-completion phase: return the final grounded delta/decision, omit recallPlan, and retain unresolved questions or defer when coverage is missing/conflicting. Do not enter recursive planning. Memory source references only support their recorded basis and time scope; old memory never overrules a present correction without explanation.

The analysis coverage describes allocation omissions. passiveSpans are exact local counts over declared original source ranges, not rewritten evidence or a personal preference. Pure operation counts/idle receipts need no per-event semantic model call; their locally represented range can advance the consumption watermark without interpreting content. They do not prove emotion, comprehension or an intended goal. Update only supplied situations and intents under their declared allocation; omitted records remain unchanged and cannot be declared closed, fulfilled or abandoned. An INCOMPLETE EXCERPT is only a partial receipt. visibility.truncated=true also means the source adapter captured only part of the original content; a complete read of that stored prefix does not recover the omitted original text. Cite its source but retain uncertainty about omitted text; keep the original source available for subsequent inspection. A partial Persona projection does not authorize inventing the missing preferences. When moreEvidencePending is true, later evidence has not yet been analyzed: prioritize reconstructing continuity, avoid optional action based on an incomplete backlog.

Instructions for an actual Run are concise intent and evidence context, not a fabricated user request. Output rationale is a short assessable reason, not hidden chain of thought. Keep summaries compact while preserving uncertainty, cross-object continuity, unfinished intentions and the distinctions between planned/generated/collected/placed/modified outcomes.

Emit compact JSON without formatting whitespace outside strings.

${MODEL_TIME_INSTRUCTIONS}

${COGNITION_UPDATE_INSTRUCTIONS}`;

export interface ModelCognitionDriverOptions {
  readonly getTimeContext?: () => ModelTimeContext;
  readonly getPersona: (personaId: string) => PersonaSnapshot;
  readonly createRuntime: () => Promise<{
    provider: ModelProvider;
    modelId: string;
  }>;
  readonly onUsage?: (usage: ModelUsage, attemptId: string) => void;
  readonly resolveVisual?: (
    reference: ActivityVisualReference,
    signal: AbortSignal,
  ) => Promise<
    | { status: "available"; bytes: Uint8Array; mediaType: "image/png" }
    | { status: "unavailable"; reason: string }
  >;
}

export class ModelCognitionDriver implements CognitionDriver {
  constructor(private readonly options: ModelCognitionDriverOptions) {}

  async analyze(
    input: CognitionAnalysisInput,
    signal: AbortSignal,
  ): Promise<CognitionAnalysis> {
    signal.throwIfAborted();
    const persona = this.options.getPersona(input.attempt.personaId);
    if (persona.personaId !== input.attempt.personaId) {
      throw new Error("Cognition persona does not match its evidence");
    }
    const runtime = await this.options.createRuntime();
    signal.throwIfAborted();
    const limits = await runtime.provider.resolveContextLimits(
      runtime.modelId,
      signal,
    );
    const timeContext = (this.options.getTimeContext ?? modelTimeContext)();
    const visualCoverage: {
      evidenceId: string;
      status: "available" | "unavailable" | "omitted";
      reason?: string;
    }[] = [];
    const { sourceCoverage, ...attempt } = input.attempt;
    // Omit only a duplicate; keep distinct supplied material and host input intact.
    const modelInput =
      sourceCoverage &&
      (!input.coverage?.sourceCoverage ||
        isDeepStrictEqual(sourceCoverage, input.coverage.sourceCoverage))
        ? {
            ...input,
            attempt,
            coverage: {
              ...input.coverage,
              sourceCoverage: input.coverage?.sourceCoverage ?? sourceCoverage,
            },
          }
        : input;
    const contextMessage = {
      type: "message",
      role: "developer",
      content: JSON.stringify({
        ...modelInput,
        persona,
        visualCoverage,
        timeContext,
      }),
    };
    const request = {
      modelId: runtime.modelId,
      instructions: COGNITION_ANALYSIS_INSTRUCTIONS,
      input: [contextMessage] as JsonValue[],
      structuredOutput: {
        name: "charamate_cognition_analysis_v8",
        schema: structuredOutputWireSchema(CognitionModelOutputSchema),
      },
      toolNamespaces: [],
    };
    const budget = modelInputBudget(limits);
    let measurement: InputBudgetEstimate;
    const fits = async (): Promise<boolean> => {
      signal.throwIfAborted();
      measurement = await runtime.provider.measureInput(request, signal);
      signal.throwIfAborted();
      return fitsInputBudget(measurement, budget);
    };
    if (!(await fits())) {
      const projectPersona = (length: number): string => {
        const omittedFields: string[] = [];
        const partial = Object.fromEntries(
          Object.entries(persona).map(([key, value]) => {
            if (
              typeof value === "string" &&
              ![
                "personaId",
                "revisionCreatedAt",
                "displayName",
                "defaultVoice",
              ].includes(key) &&
              value.length > length
            ) {
              omittedFields.push(key);
              return [key, value.slice(0, length)];
            }
            if (Array.isArray(value) && value.join("\n").length > length) {
              omittedFields.push(key);
              return [key, []];
            }
            return [key, value];
          }),
        );
        return JSON.stringify({
          ...modelInput,
          timeContext,
          visualCoverage,
          persona: partial,
          personaCoverage: {
            partial: true,
            omittedFields,
            note: "Persona fields were excerpted for the complete request allocation; omitted text remains unknown. Persona identity and revision are unchanged.",
          },
        });
      };
      let lower = 0;
      let upper = JSON.stringify(persona).length;
      contextMessage.content = projectPersona(0);
      if (await fits()) {
        while (lower < upper) {
          const candidate = Math.ceil((lower + upper) / 2);
          contextMessage.content = projectPersona(candidate);
          if (await fits()) lower = candidate;
          else upper = candidate - 1;
        }
        contextMessage.content = projectPersona(lower);
      }
    }
    if (!(await fits())) {
      throw new CognitionInputBudgetError(measurement!, budget);
    }
    // Every attached image is an actually supplied evidence source, never a path or
    // base64 string hidden in JSON text. Latest versions of one surface share one slot.
    const latest = new Map<string, (typeof input.snapshot.evidence)[number]>();
    for (const evidence of input.snapshot.evidence) {
      const visual = evidence.visual;
      if (!visual) continue;
      const key = `${visual.surface.id}:${visual.surface.epoch}`;
      const previous = latest.get(key);
      if (
        !previous ||
        previous.visual!.capturedAt < visual.capturedAt ||
        (previous.visual!.capturedAt === visual.capturedAt &&
          previous.receiptSequence < evidence.receiptSequence)
      )
        latest.set(key, evidence);
    }
    const currentKey = input.snapshot.attention.foregroundObject?.key;
    const visuals = [...latest.values()].sort(
      (left, right) =>
        Number(right.object?.key === currentKey) -
          Number(left.object?.key === currentKey) ||
        right.visual!.capturedAt.localeCompare(left.visual!.capturedAt) ||
        right.receiptSequence - left.receiptSequence,
    );
    const updateCoverage = (): void => {
      const context = JSON.parse(contextMessage.content) as Record<
        string,
        JsonValue
      >;
      context["visualCoverage"] = visualCoverage;
      contextMessage.content = JSON.stringify(context);
    };
    for (const evidence of visuals) {
      const reference = evidence.visual!;
      const coverage = {
        evidenceId: evidence.id,
        status: "unavailable" as "available" | "unavailable" | "omitted",
        reason: "Visual resolver is unavailable.",
      };
      visualCoverage.push(coverage);
      if (limits.supportsVision === false) {
        coverage.reason = "The selected model does not support image input.";
      } else if (this.options.resolveVisual) {
        const result = await this.options.resolveVisual(reference, signal);
        signal.throwIfAborted();
        if (result.status === "unavailable") coverage.reason = result.reason;
        else {
          coverage.status = "available";
          delete (coverage as { reason?: string }).reason;
          const message: JsonValue = {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  evidenceId: evidence.id,
                  visual: reference,
                  note: "Actual pixels for this supplied evidence only. The surface, capture time and declared partial visibility bound what can be inferred.",
                }),
              },
              {
                type: "input_image",
                image_url: `data:${result.mediaType};base64,${Buffer.from(result.bytes).toString("base64")}`,
                detail: "auto",
              },
            ],
          };
          request.input.push(message);
          updateCoverage();
          if (!(await fits())) {
            request.input.pop();
            coverage.status = "omitted";
            coverage.reason =
              "Image omitted by the complete request input allocation; pixels were not supplied to the model.";
          }
        }
      }
      updateCoverage();
    }
    if (!(await fits()))
      throw new CognitionInputBudgetError(measurement!, budget);
    const generate = async (modelRequest: ModelRequest) => {
      signal.throwIfAborted();
      const assertPersona = (): void => {
        if (
          this.options.getPersona(persona.personaId).revision !==
          persona.revision
        )
          throw new Error("Persona revision changed during cognition analysis");
      };
      assertPersona();
      const turn = await collectModelTurn(
        runtime.provider.stream(modelRequest, signal),
      );
      this.options.onUsage?.(turn.usage, input.attempt.id);
      signal.throwIfAborted();
      assertPersona();
      if (
        turn.status !== "completed" ||
        turn.functionCalls.length ||
        turn.toolSearchCalls.length
      )
        throw new Error(
          "Cognition read-only analysis did not complete without tools",
        );
      const proposal: unknown = JSON.parse(turn.text);
      return {
        proposal,
        analysis: decodeCognitionModelOutput(proposal, input),
      };
    };
    const evidence = new Map(
      input.snapshot.evidence.map((source) => [source.id, source]),
    );
    const validate = (analysis: CognitionAnalysis): void => {
      validateCognitionEvidenceReferences(analysis, input);
      validateCognitionStateReferences(analysis, input);
      validateCognitionSourceUses(
        analysis.decision.selectedBasis.evidenceUses,
        evidence,
      );
    };
    const first = await generate(request);
    try {
      validate(first.analysis);
      return first.analysis;
    } catch (error) {
      if (
        !(error instanceof CognitionSourceUseError) &&
        !(error instanceof CognitionReferenceError)
      )
        throw error;
      const correctionRequest: ModelRequest = {
        ...request,
        input: [
          ...request.input,
          {
            type: "message",
            role: "developer",
            content: JSON.stringify({
              validationFeedback: {
                note: "The complete prior proposal failed the supplied-reference or source type-use check and none of its delta has been committed. Return one complete replacement in the same output schema. Diagnostic field paths address the decoded proposal; parent/child IDs and suppliedPaths locate the corresponding original input or this proposal's new declarations. Check references exactly, without guessing a similar ID. A retained state reference is not supplied source content and cannot expand selectedBasis or authorize a new completion. Likewise, an omitted state target may remain only in its original existing relation; that relation does not supply the target for a new link, choice or attention selection. Use actual supplied entities or this proposal's declared new: entities for new relations, without deleting supported history to pass validation. Reconsider the declared references and source uses while preserving every independently supported update, necessary currentClaimRef, counterevidence and selected Intent dependency. These diagnostics are not new evidence, permission, a world change or proof of freshness. Do not invent object fields, relabel the actual sources or remove semantic dependencies merely to pass validation. All original source and execution contracts still apply.",
                proposal: first.proposal,
                issues: error.issues,
              },
            }),
          },
        ],
      };
      const correctionMeasurement = await runtime.provider.measureInput(
        correctionRequest,
        signal,
      );
      signal.throwIfAborted();
      if (!fitsInputBudget(correctionMeasurement, budget))
        throw new RangeError(
          `Cognition proposal correction exceeds the complete model input budget: ${error.message}`,
          { cause: error },
        );
      const corrected = await generate(correctionRequest);
      validate(corrected.analysis);
      return corrected.analysis;
    }
  }
}
