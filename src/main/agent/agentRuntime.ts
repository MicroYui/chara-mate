import { isDeepStrictEqual } from "node:util";
import { Type } from "@sinclair/typebox";

import type {
  ActivityVisualLookupResult,
  ActivityVisualMatch,
} from "../../shared/contracts/activity";
import {
  ActivityImageTargetSchema,
  ActivityVisualReferenceSchema,
} from "../../shared/schemas/activity";

import { suppliedMemoryReferences } from "./memorySuppliedReferences";

import { modelTimeContext, modelTimeInstructions } from "./modelTimeContext";
import type {
  ApprovalDecision,
  ApprovalNavigationTarget,
  CancelStartRequest,
  CancelStartResult,
  ResolveApprovalRequest,
  ResolveUserInputRequest,
  ResumeRunRequest,
  StartRunRequest,
  SteerRunRequest,
} from "../../shared/contracts/agent";
import type { Message } from "../../shared/contracts/chat";
import type { JsonValue } from "../../shared/contracts/primitives";
import type { PersonaSnapshot } from "../../shared/contracts/persona";
import type {
  Approval,
  AppError,
  ArtifactKind,
  ArtifactReference,
  PlanUpdate,
  RequestUserInputArguments,
  Run,
  RunCancelRequest,
  RunCancelResult,
  UserInputResolution,
  InputRequestResolution,
} from "../../shared/contracts/run";
import type {
  ToolDefinition,
  ToolRegistry,
  ToolResultContextMeasurement,
} from "../tools/toolRegistry";
import { fitsInputBudget, modelInputBudget } from "../providers/inputBudget";
import type { ToolDescriptor, ToolResult } from "../../shared/contracts/tool";
import { ToolResultSchema } from "../../shared/schemas/tool";
import {
  PlanUpdateSchema,
  RequestUserInputArgumentsSchema,
  UserInputResolutionSchema,
  InputRequestResolutionSchema,
} from "../../shared/schemas/run";
import { parseSchema } from "../../shared/schemas/validation";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { redactText } from "../../shared/pure/redaction";
import type { ChatRepository } from "../chat/chatRepository";
import type { ChatService } from "../chat/chatService";
import type { ChatTitleGenerator } from "../chat/chatTitleService";
import {
  ACTIVITY_OBSERVE_TOOL_NAME,
  ACTIVITY_SEARCH_TOOL_NAME,
} from "../activity/activityTool";
import type {
  CognitionDispatchRequest,
  CognitionServiceContract,
} from "../cognition/cognitionTypes";
import {
  createCognitionContextInput,
  cognitionContextTokenHeadroom,
  estimatedCognitionContextTokens,
  isCognitionContextInput,
  isOrdinaryCognitionContextInput,
  retainedCognitionContextInputs,
  LOCAL_COGNITION_READ_BUDGET_BYTES,
  materializeCognitionContextInput,
  shareSelectedObservationBodies,
} from "./cognitionContext";
import {
  MEMORY_FORMATION_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME,
} from "../memory/memoryTool";
import { COMPANIONSHIP_UPDATE_TOOL_NAME } from "../journey/companionshipTool";
import { IMPORTANT_MOMENT_OUTREACH_TOOL_NAME } from "../journey/importantMomentOutreachTool";
import { TERRITORY_MOMENT_SURPRISES_TOOL_NAME } from "../journey/territoryMomentSurprisesTool";
import { TERRITORY_PROPOSE_MOMENT_TOOL_NAME } from "../territory/territoryMomentTool";
import type { ChatModelRuntime } from "../providers/providerService";
import { ProviderError, toProviderAppError } from "../providers/providerError";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { CheckpointPhase } from "./checkpointRepository";
import type { CheckpointRepository } from "./checkpointRepository";
import {
  ContextCompiler,
  isCurrentPlanContextInput,
  retainedToolContextInputs,
  type ContextInputMeasurement,
} from "./contextCompiler";
import {
  collectModelTurn,
  supportsStrictToolSchema,
  type CollectedModelTurn,
  type ModelAllowedTool,
  type ModelContextLimits,
  type ModelFunctionCall,
  type ModelFunctionTool,
  type ModelProvider,
  type ModelRequest,
  type ModelToolNamespace,
} from "./modelProvider";
import { detectToolCycle, semanticToolSignature } from "./loopGuard";
import {
  CHAT_INTERNAL_TOOL_NAMES,
  requiresApproval,
  toolAllowedInExecution,
} from "./approvalPolicy";
import { AgentError } from "./agentError";
import {
  AttachmentInputError,
  type AttachmentInputProvider,
  type PreparedAttachmentInput,
} from "./attachmentInput";
import { ChatContextService } from "./chatContextService";
import {
  ImageInputError,
  IMAGE_REFERENCE_TYPE,
  imageInputKey,
  type ImageInputSource,
  type ImageInputProvider,
  type PreparedImageInput,
} from "./imageInput";
import {
  isMemoryContextInput,
  materializeMemoryContextInput,
} from "./memoryContext";
import {
  executionInstructions,
  TEXT_AGENT_BASE_INSTRUCTIONS,
} from "./agentInstructions";
import { CharacterContextCompiler } from "../persona/characterContext";
import { COLLABORATION_DISPATCH_TOOL_NAME } from "./collaborationTool";
import type { RunRepository } from "./runRepository";
import type { RunEventWriter } from "./runEventWriter";
import {
  checkpointJson,
  decodeRuntimeCheckpoint,
  type PendingInputRequest,
  type PendingToolCall,
  type RuntimeCheckpointState,
} from "./runtimeCheckpoint";

const APPROVAL_RUN_LIFETIME = "9999-12-31T23:59:59.999Z";
const TERMINAL_STATUSES = new Set<Run["status"]>([
  "interrupted",
  "completed",
  "failed",
  "cancelled",
]);

const USER_ATTACHMENT_KINDS = new Set<ArtifactKind>([
  "file",
  "directory",
  "image",
  "audio",
  "video",
]);

const ALWAYS_LOADED_CLIENT_TOOLS = new Set([
  ACTIVITY_OBSERVE_TOOL_NAME,
  "companion.life",
  "file.list",
  "file.read",
  "file.search",
  "file.write",
  "file.patch",
  "file.trash",
  "command.run",
  "plan.update",
  MEMORY_FORMATION_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME,
  COMPANIONSHIP_UPDATE_TOOL_NAME,
  IMPORTANT_MOMENT_OUTREACH_TOOL_NAME,
  TERRITORY_MOMENT_SURPRISES_TOOL_NAME,
  TERRITORY_PROPOSE_MOMENT_TOOL_NAME,
  COLLABORATION_DISPATCH_TOOL_NAME,
]);
const USER_INPUT_NAMESPACE = "interaction";
const USER_INPUT_TOOL_NAME = "request_user_input";
const USER_INPUT_ALLOWED_TOOL = {
  name: USER_INPUT_TOOL_NAME,
  namespace: USER_INPUT_NAMESPACE,
} as const;
const USER_INPUT_TOOL: ModelFunctionTool = {
  deferLoading: false,
  description:
    "Ask the user one to three concise structured questions and wait for the answers before continuing the same run.",
  inputSchema: RequestUserInputArgumentsSchema,
  name: USER_INPUT_TOOL_NAME,
  namespace: USER_INPUT_NAMESPACE,
  strict: supportsStrictToolSchema(RequestUserInputArgumentsSchema),
};
const IMAGE_INSPECT_NAMESPACE = "image";
const IMAGE_INSPECT_TOOL_NAME = "image.inspect";
const IMAGE_INSPECT_ALLOWED_TOOL = {
  name: IMAGE_INSPECT_TOOL_NAME,
  namespace: IMAGE_INSPECT_NAMESPACE,
} as const;
const ImageInspectArgumentsSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Absolute path, workspace-relative path, or artifact storage key",
      }),
    ),
    activity: Type.Optional(ActivityImageTargetSchema),
  },
  { additionalProperties: false, minProperties: 1, maxProperties: 1 },
);
const ActivityImageSourceSchema = Type.Object(
  { activity: ActivityVisualReferenceSchema },
  { additionalProperties: false },
);
const IMAGE_INSPECT_TOOL: ModelFunctionTool = {
  deferLoading: false,
  description:
    "Read real image pixels. Supply exactly one of path or activity. To find a past desktop/window image, call this tool with {activity:{search:{...}}}, using literal text, time or surface; the result contains references, not pixels. Then call this tool with {activity:{reference:...}} to read one exact image. {activity:{current:true}} reads the actual latest available capture, never a substitute for missing past images. Source references already supplied in context can be read directly. Captured contents do not prove what the user read, intended or preferred.",
  inputSchema: ImageInspectArgumentsSchema,
  name: IMAGE_INSPECT_TOOL_NAME,
  namespace: IMAGE_INSPECT_NAMESPACE,
  strict: supportsStrictToolSchema(ImageInspectArgumentsSchema),
};

interface ProviderRuntimeFactory {
  createChatModelRuntime(
    profileId: string,
    modelId?: string,
  ): Promise<ChatModelRuntime>;
}

interface PendingSteering {
  readonly content: string;
}

interface RunPreparation {
  readonly abort: AbortController;
  readonly signal: AbortSignal;
  readonly task: Promise<unknown>;
  readonly requestId?: string;
  runId?: string;
  active?: ActiveRun;
}

interface ActiveRun {
  startRequestId?: string;
  readonly abort: AbortController;
  data: RuntimeCheckpointState;
  generation: number;
  readonly imageCache: Map<string, PreparedImageInput>;
  readonly limits: ModelContextLimits;
  readonly provider: ModelProvider;
  readonly runId: string;
  readonly steering: PendingSteering[];
  inputRevision: number;
  cognitionInputRevision: number;
  readonly steeringWaiters: Set<() => void>;
  readonly tools: ToolRegistry;
  interruptRequested: boolean;
  interruptionError?: AppError;
  task?: Promise<void>;
  readonly inputWaiters: Map<
    string,
    (resolution: InputRequestResolution) => void
  >;
  readonly waiters: Map<string, (decision: ApprovalDecision) => void>;
}

class GuardTerminalError extends Error {
  constructor(readonly appError: NonNullable<Run["error"]>) {
    super(appError.message);
    this.name = "GuardTerminalError";
  }
}

class RunDeltaBatcher {
  #scheduled: NodeJS.Immediate | undefined;

  constructor(private readonly flushPending: () => void) {}

  schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      this.flushPending();
    });
  }

  flush(): void {
    if (this.#scheduled) {
      clearImmediate(this.#scheduled);
      this.#scheduled = undefined;
    }
    this.flushPending();
  }
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function messageInput(content: string): JsonValue {
  return { content, role: "user", type: "message" };
}

function imageMessageReference(
  text: string,
  sources: readonly ImageInputSource[],
): JsonValue {
  return {
    content: [
      { text, type: "input_text" },
      ...sources.map((source) => ({ source, type: IMAGE_REFERENCE_TYPE })),
    ],
    role: "user",
    type: "message",
  };
}

function attachmentContext(
  attachments: readonly ArtifactReference[],
  prepared: ReadonlyMap<string, PreparedAttachmentInput>,
  originalContent: string,
): string {
  if (attachments.length === 0) return originalContent;
  const descriptions: string[] = [];
  for (const attachment of attachments) {
    const input = prepared.get(attachment.artifactId);
    if (attachment.kind === "image") {
      descriptions.push(
        `- ${attachment.displayName}: image pixels included in this message`,
      );
      continue;
    }
    if (input?.text !== undefined) {
      const text = input.text.trim();
      if (text && !originalContent.includes(text)) {
        descriptions.push(
          `- ${attachment.displayName}: user-supplied attachment content follows\n\n<attachment name=${JSON.stringify(attachment.displayName)}>\n${input.text}\n</attachment>`,
        );
      } else {
        descriptions.push(
          `- ${attachment.displayName}: text content is already included in the user message`,
        );
      }
      continue;
    }
    descriptions.push(
      `- ${attachment.displayName}: attached file reference (content was not parsed)`,
    );
  }
  return `${originalContent}\n\nAttached local artifacts:\n${descriptions.join("\n")}`;
}

async function materializeModelInput(
  value: JsonValue,
  images: ImageInputProvider | undefined,
  cache: Map<string, PreparedImageInput>,
  signal?: AbortSignal,
): Promise<JsonValue> {
  signal?.throwIfAborted();
  if (Array.isArray(value)) {
    const materialized: JsonValue[] = [];
    for (const item of shareSelectedObservationBodies(value)) {
      materialized.push(
        await materializeModelInput(item, images, cache, signal),
      );
    }
    return materialized;
  }
  if (typeof value !== "object" || value === null) return value;
  if (isCognitionContextInput(value))
    return materializeCognitionContextInput(value);
  if (isMemoryContextInput(value)) {
    return materializeMemoryContextInput(value);
  }
  if (value["type"] === IMAGE_REFERENCE_TYPE) {
    if (!images) {
      throw new ImageInputError("图片引用已失效，无法恢复真实像素。");
    }
    const source = parseImageInputSource(value["source"]);
    const key = imageInputKey(source);
    // Activity owns source/revision/asset availability. Recheck it for each
    // materialization; an in-memory image must not conceal source reclamation.
    let prepared = typeof source === "string" ? cache.get(key) : undefined;
    if (!prepared) {
      prepared = await images.prepare(source, signal);
      signal?.throwIfAborted();
      cache.set(key, prepared);
    }
    return prepared.content;
  }
  const materialized: Record<string, JsonValue> = {};
  for (const [name, nested] of Object.entries(value)) {
    materialized[name] = await materializeModelInput(
      nested,
      images,
      cache,
      signal,
    );
  }
  return materialized;
}

function developerInput(content: string): JsonValue {
  return { content, role: "developer", type: "message" };
}

function outputItemType(value: JsonValue): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const type = value["type"];
  return typeof type === "string" ? type : undefined;
}

function contextSafeOutputItems(
  items: readonly JsonValue[],
): readonly JsonValue[] {
  return items.filter((item) => {
    const type = outputItemType(item);
    return type !== "reasoning" && type !== "compaction";
  });
}

function toolOutput(callId: string, result: ToolResult): JsonValue {
  return {
    call_id: callId,
    output: JSON.stringify(result),
    type: "function_call_output",
  };
}

function completedToolState(
  data: RuntimeCheckpointState,
  pending: PendingToolCall,
  descriptor: ToolDescriptor | undefined,
  result: ToolResult,
): RuntimeCheckpointState {
  const next = { ...data };
  delete next.pendingTool;
  delete next.allowedTools;
  let input = hasToolOutput(data.input, pending.callId)
    ? data.input
    : [...data.input, toolOutput(pending.callId, result)];
  const planUpdated =
    descriptor?.itemKind === "plan" && result.status === "success";
  if (planUpdated)
    input = input.filter((item) => !isCurrentPlanContextInput(item));
  return {
    ...next,
    ...(planUpdated
      ? { currentPlan: parseCurrentPlan(pending.arguments) }
      : {}),
    boundaries: [],
    recoveryAttemptedKeys: [],
    input,
    handoff: {
      ...data.handoff,
      ...(planUpdated
        ? {}
        : {
            currentProgress: [
              ...data.handoff.currentProgress,
              `${pending.name}: ${result.summary}`,
            ],
          }),
      nextSteps: [],
    },
  };
}

function inputRequestOutput(
  callId: string,
  resolution:
    | InputRequestResolution
    | Omit<
        Extract<InputRequestResolution, { status: "context_available" }>,
        "resolvedAt"
      >,
): JsonValue {
  // Acceptance time belongs to the durable event, not to the premeasured input.
  const output =
    resolution.status === "context_available"
      ? {
          status: resolution.status,
          attemptId: resolution.attemptId,
          evidenceIds: resolution.evidenceIds,
        }
      : resolution;
  return {
    call_id: callId,
    output: JSON.stringify(output),
    type: "function_call_output",
  };
}

function userInputSummary(resolution: UserInputResolution): string {
  if (resolution.status === "cancelled") {
    return "The user cancelled the structured input request.";
  }
  return `The user supplied structured answers: ${JSON.stringify(
    resolution.answers,
  )}`;
}

function parseCurrentPlan(value: JsonValue): PlanUpdate {
  const update = parseSchema(PlanUpdateSchema, value);
  if (update.plan.filter(({ status }) => status === "in_progress").length > 1) {
    throw new TypeError("A plan may contain at most one in_progress step");
  }
  return update;
}

function isUserInputCall(call: ModelFunctionCall): boolean {
  return (
    (call.name === USER_INPUT_TOOL_NAME &&
      (call.namespace === undefined ||
        call.namespace === USER_INPUT_NAMESPACE)) ||
    call.name === `${USER_INPUT_NAMESPACE}.${USER_INPUT_TOOL_NAME}`
  );
}

function isImageInspectCall(call: ModelFunctionCall): boolean {
  return (
    (call.name === "inspect" && call.namespace === IMAGE_INSPECT_NAMESPACE) ||
    call.name === IMAGE_INSPECT_TOOL_NAME
  );
}

function parseImageInputSource(value: JsonValue | undefined): ImageInputSource {
  if (typeof value === "string" && value.trim()) return value;
  return parseSchema(ActivityImageSourceSchema, value);
}

function containsImageInput(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsImageInput);
  if (typeof value !== "object" || value === null) return false;
  if (value["type"] === "input_image" || value["type"] === IMAGE_REFERENCE_TYPE)
    return true;
  return Object.values(value).some(containsImageInput);
}

function parseUserInputArguments(
  value: Readonly<Record<string, JsonValue>>,
): RequestUserInputArguments {
  const input = parseSchema(RequestUserInputArgumentsSchema, value);
  const questionIds = new Set<string>();
  for (const question of input.questions) {
    if (questionIds.has(question.id)) {
      throw new TypeError(`Duplicate input question id: ${question.id}`);
    }
    questionIds.add(question.id);
    const optionLabels = new Set<string>();
    for (const option of question.options) {
      if (optionLabels.has(option.label)) {
        throw new TypeError(
          `Duplicate option label for ${question.id}: ${option.label}`,
        );
      }
      optionLabels.add(option.label);
    }
  }
  return input;
}

function validateUserInputResolution(
  questions: readonly RequestUserInputArguments["questions"][number][],
  resolution: UserInputResolution,
): UserInputResolution {
  const parsed = parseSchema(UserInputResolutionSchema, resolution);
  if (parsed.status === "cancelled") return parsed;
  if (parsed.answers.length !== questions.length) {
    throw new TypeError("Every input question must be answered exactly once");
  }
  const questionById = new Map(
    questions.map((question) => [question.id, question] as const),
  );
  const answered = new Set<string>();
  for (const answer of parsed.answers) {
    const question = questionById.get(answer.questionId);
    if (!question || answered.has(answer.questionId)) {
      throw new TypeError(`Invalid input answer id: ${answer.questionId}`);
    }
    answered.add(answer.questionId);
    if (answer.value.kind === "option") {
      const selectedLabel = answer.value.label;
      if (!question.options.some(({ label }) => label === selectedLabel)) {
        throw new TypeError(
          `Unknown option for ${answer.questionId}: ${selectedLabel}`,
        );
      }
    }
  }
  return parsed;
}

function hasToolOutput(input: readonly JsonValue[], callId: string): boolean {
  return input.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      item["type"] === "function_call_output" &&
      item["call_id"] === callId,
  );
}

function toolDisplayOutput(result: ToolResult, toolName?: string): string {
  if (
    toolName === MEMORY_FORMATION_TOOL_NAME ||
    toolName === IMPORTANT_MOMENT_OUTREACH_TOOL_NAME ||
    toolName === TERRITORY_MOMENT_SURPRISES_TOOL_NAME ||
    toolName === TERRITORY_PROPOSE_MOMENT_TOOL_NAME ||
    toolName === MEMORY_SEARCH_TOOL_NAME ||
    toolName === ACTIVITY_SEARCH_TOOL_NAME ||
    toolName === ACTIVITY_OBSERVE_TOOL_NAME
  ) {
    return result.summary;
  }
  return typeof result.modelContent === "string"
    ? result.modelContent
    : JSON.stringify(result.modelContent, null, 2);
}

function unexpectedToolResult(error: unknown): ToolResult {
  const message = redactText(
    error instanceof Error ? error.message : "Tool 执行遇到未知错误。",
  );
  const modelContent = { message } satisfies JsonValue;
  return {
    artifacts: [],
    error: {
      code:
        error instanceof TypeError ? "TOOL.INVALID_ARGUMENTS" : "TOOL.FAILED",
      message,
      retryable: false,
    },
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "error",
    summary: "工具执行失败",
  };
}

function rejectedToolResult(reason?: string): ToolResult {
  const modelContent = {
    decision: "rejected",
    ...(reason ? { reason } : {}),
  } satisfies JsonValue;
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "rejected",
    summary: "用户拒绝了本次操作",
  };
}

function chatModeToolResult(): ToolResult {
  const modelContent = {
    code: "TOOL.MODE_NOT_ALLOWED",
    message:
      "Chat mode only allows idempotent read-only capabilities. Ask the user to switch explicitly to Agent mode for this action.",
  } satisfies JsonValue;
  return {
    artifacts: [],
    error: {
      code: "TOOL.MODE_NOT_ALLOWED",
      message: "Chat 模式只允许幂等只读能力；该操作需要明确切换到 Agent 模式。",
      retryable: false,
    },
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "error",
    summary: "Chat 模式未执行有副作用的能力",
  };
}

function toolScopeResult(): ToolResult {
  const modelContent = {
    code: "TOOL.SCOPE_NOT_ALLOWED",
    message: "This capability is outside the Tool scope saved for this Run.",
  } satisfies JsonValue;
  return {
    artifacts: [],
    error: {
      code: "TOOL.SCOPE_NOT_ALLOWED",
      message: "该能力不在本次 Run 保存的 Tool 范围内。",
      retryable: false,
    },
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "rejected",
    summary: "能力不在本次 Run 的 Tool 范围内",
  };
}

function imageInspectionResult(
  image: PreparedImageInput,
  source: ImageInputSource,
  observation?: ActivityVisualMatch,
): ToolResult {
  const modelContent = {
    byteLength: image.byteLength,
    height: image.height,
    loaded: true,
    source,
    ...(observation ? { observation: asJsonValue(observation) } : {}),
    mediaType: image.mediaType,
    width: image.width,
  } satisfies JsonValue;
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success",
    summary: "已读取图片真实像素",
  };
}

function imageInspectionError(error: unknown): ToolResult {
  const message = redactText(
    error instanceof Error ? error.message : "图片读取失败。",
  );
  const modelContent = {
    code: "IMAGE.INPUT_UNAVAILABLE",
    message,
  } satisfies JsonValue;
  return {
    artifacts: [],
    error: {
      code: "IMAGE.INPUT_UNAVAILABLE",
      message,
      retryable: false,
    },
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "error",
    summary: "图片读取失败",
  };
}

function visualLookupToolResult(
  lookup: ActivityVisualLookupResult,
): ToolResult {
  const modelContent = asJsonValue(lookup);
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success",
    summary: `找到 ${String(lookup.observations.length)} 个画面来源${lookup.complete ? "" : "，另有未返回范围"}；尚未读取像素`,
  };
}

function visualLookupPrefix(
  lookup: ActivityVisualLookupResult,
  count: number,
): ActivityVisualLookupResult {
  if (count === lookup.observations.length) return lookup;
  const observations = lookup.observations.slice(0, count);
  const last = observations.at(-1);
  return {
    ...lookup,
    observations,
    complete: false,
    omittedReason: "context_budget",
    continuation: {
      ...lookup.request,
      ...(last ? { before: last.position } : {}),
    },
  };
}

function cancelledToolResult(): ToolResult {
  return {
    artifacts: [],
    modelContent: { cancelled: true },
    retryable: false,
    status: "cancelled",
    summary: "操作已取消",
  };
}

function namespaceDescription(
  namespace: string,
  tools: readonly ToolDefinition[],
): string {
  const sources = [
    ...new Set(tools.map(({ descriptor }) => descriptor.source)),
  ];
  return `${namespace} capabilities from ${sources.join(" and ")}`;
}

function modelFunctionTool(definition: ToolDefinition): ModelFunctionTool {
  return {
    deferLoading: !ALWAYS_LOADED_CLIENT_TOOLS.has(definition.descriptor.name),
    description: definition.descriptor.description,
    inputSchema: definition.descriptor.inputSchema as Readonly<
      Record<string, unknown>
    >,
    name: definition.descriptor.name,
    namespace: definition.descriptor.namespace,
    strict:
      definition.descriptor.source === "builtin" &&
      supportsStrictToolSchema(definition.descriptor.inputSchema),
  };
}

function groupModelTools(
  definitions: readonly ToolDefinition[],
): ModelToolNamespace[] {
  const grouped = new Map<string, ToolDefinition[]>();
  for (const definition of definitions) {
    const tools = grouped.get(definition.descriptor.namespace) ?? [];
    tools.push(definition);
    grouped.set(definition.descriptor.namespace, tools);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([namespace, tools]) => ({
      description: namespaceDescription(namespace, tools),
      name: namespace,
      tools: tools
        .sort((left, right) =>
          left.descriptor.name.localeCompare(right.descriptor.name),
        )
        .map(modelFunctionTool),
    }));
}

function withUserInputTool(
  namespaces: readonly ModelToolNamespace[],
): ModelToolNamespace[] {
  const existing = namespaces.find(({ name }) => name === USER_INPUT_NAMESPACE);
  if (!existing) {
    return [
      {
        description: "Structured interaction with the user",
        name: USER_INPUT_NAMESPACE,
        tools: [USER_INPUT_TOOL],
      },
      ...namespaces,
    ];
  }
  return namespaces.map((namespace) =>
    namespace === existing
      ? { ...namespace, tools: [USER_INPUT_TOOL, ...namespace.tools] }
      : namespace,
  );
}

function withImageInspectTool(
  namespaces: readonly ModelToolNamespace[],
): ModelToolNamespace[] {
  const existing = namespaces.find(
    ({ name }) => name === IMAGE_INSPECT_NAMESPACE,
  );
  if (!existing) {
    return [
      ...namespaces,
      {
        description: "Semantic inspection of local images",
        name: IMAGE_INSPECT_NAMESPACE,
        tools: [IMAGE_INSPECT_TOOL],
      },
    ];
  }
  return namespaces.map((namespace) =>
    namespace === existing
      ? { ...namespace, tools: [IMAGE_INSPECT_TOOL, ...namespace.tools] }
      : namespace,
  );
}

function searchOutputTools(
  definitions: readonly ToolDefinition[],
): JsonValue[] {
  return groupModelTools(definitions).map((namespace) => ({
    description: namespace.description,
    name: namespace.name,
    tools: namespace.tools.map((tool) => ({
      defer_loading: false,
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema as JsonValue,
      strict: tool.strict,
      type: "function",
    })),
    type: "namespace",
  }));
}

function loadedToolNames(
  input: readonly JsonValue[],
): ReadonlySet<string> | undefined {
  const names = new Set<string>();
  let foundSearchOutput = false;
  for (const value of input) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    if (value["type"] !== "tool_search_output") continue;
    foundSearchOutput = true;
    const namespaces = value["tools"];
    if (!Array.isArray(namespaces)) continue;
    for (const namespaceValue of namespaces) {
      if (
        typeof namespaceValue !== "object" ||
        namespaceValue === null ||
        Array.isArray(namespaceValue)
      ) {
        continue;
      }
      const namespace = namespaceValue["name"];
      const tools = namespaceValue["tools"];
      if (typeof namespace !== "string" || !Array.isArray(tools)) continue;
      for (const toolValue of tools) {
        if (
          typeof toolValue !== "object" ||
          toolValue === null ||
          Array.isArray(toolValue)
        ) {
          continue;
        }
        const name = toolValue["name"];
        if (typeof name !== "string") continue;
        names.add(name);
        if (!name.startsWith(`${namespace}.`)) {
          names.add(`${namespace}.${name}`);
        }
      }
    }
  }
  return foundSearchOutput ? names : undefined;
}

function uniqueAllowedTools(
  tools: readonly ModelAllowedTool[],
): ModelAllowedTool[] {
  return [
    ...new Map(
      tools.map((tool) => [`${tool.namespace}\u0000${tool.name}`, tool]),
    ).values(),
  ];
}

function initialCheckpoint(
  currentInput: JsonValue,
  memoryContext: JsonValue | undefined,
  recentUser: string,
  priorContext: readonly JsonValue[],
  toolNames?: readonly string[],
  interactionEnabled = true,
  nativeWebSearchEnabled = true,
): RuntimeCheckpointState {
  return {
    boundaries: [],
    currentUserInput: currentInput,
    forcedCompactionAttempted: false,
    handoff: {
      constraints: [],
      currentProgress: [],
      decisions: [],
      nextSteps: [],
    },
    input: [
      ...priorContext,
      ...(memoryContext ? [memoryContext] : []),
      currentInput,
    ],
    ...(interactionEnabled ? {} : { interactionEnabled: false }),
    ...(nativeWebSearchEnabled ? {} : { nativeWebSearchEnabled: false }),
    latestUserInput: currentInput,
    recentUsers: [recentUser],
    recoveryAttemptedKeys: [],
    ...(toolNames === undefined
      ? {}
      : { toolNames: [...new Set(toolNames)].sort() }),
    version: 1,
  };
}

export interface RunAllocationReservation {
  /** Reads the persisted reservation before and after asynchronous preflight. */
  existing(): Run | undefined;
  /** Called within the transaction that persists Run + run.started. */
  bind(runId: string): void;
}

export class AgentRuntime {
  readonly #active = new Map<string, ActiveRun>();
  readonly #preparations = new Set<RunPreparation>();
  #closed = false;
  #stopping: Promise<void> | undefined;
  readonly #characterContext = new CharacterContextCompiler();
  readonly #chatContext: ChatContextService;

  constructor(
    private readonly chats: ChatRepository,
    private readonly chatTurns: ChatService,
    private readonly runs: RunRepository,
    private readonly checkpoints: CheckpointRepository,
    private readonly writer: RunEventWriter,
    private readonly tools: ToolRegistry,
    private readonly providers: ProviderRuntimeFactory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly personas: {
      getActiveSnapshot(): PersonaSnapshot;
    },
    private readonly contextCompiler = new ContextCompiler(),
    private readonly additionalInstructions: (run: Run) => string = () => "",
    private readonly chatTitles?: ChatTitleGenerator,
    private readonly images?: ImageInputProvider,
    private readonly cognition?: Pick<CognitionServiceContract, "prepareTurn">,
    chatContext?: ChatContextService,
    private readonly attachmentInputs?: AttachmentInputProvider,
    private readonly beforeUserInteraction: (
      continuingRunId?: string,
    ) => Promise<void> = () => Promise.resolve(),
  ) {
    this.#chatContext =
      chatContext ?? new ChatContextService(chats, clock, runs);
  }

  async initialize(): Promise<void> {
    return this.#prepare({}, async (preparation) => {
      for (const run of this.runs.listRunsByStatus([
        "queued",
        "running",
        "waiting_approval",
        "needs_input",
      ])) {
        preparation.signal.throwIfAborted();
        preparation.runId = run.id;
        const checkpoint = this.checkpoints.get(run.id);
        if (
          checkpoint &&
          (run.status === "waiting_approval" ||
            checkpoint.phase === "input" ||
            checkpoint.phase === "approval")
        ) {
          try {
            const modelRuntime = await this.providers.createChatModelRuntime(
              run.provider.profileId,
              run.provider.modelId,
            );
            preparation.signal.throwIfAborted();
            const data = decodeRuntimeCheckpoint(checkpoint.context);
            const limits =
              data.contextLimits ??
              (await modelRuntime.provider.resolveContextLimits(
                run.provider.modelId,
                preparation.signal,
              ));
            preparation.signal.throwIfAborted();
            const active = this.#createActiveRun(
              run.id,
              modelRuntime.provider,
              limits,
              data,
              checkpoint.generation,
            );
            this.#restoreSteering(active, checkpoint.lastCompletedSequence);
            this.#launch(active, checkpoint.phase, preparation);
            continue;
          } catch {
            preparation.signal.throwIfAborted();
            // Fall through to an explicit interrupted boundary below.
          }
        }
        for (const item of this.runs.listRunItems(run.id)) {
          if (item.status === "running") {
            this.writer.completeItem(item.id, {
              error: {
                code: "AGENT.APP_INTERRUPTED",
                message: "应用在这个边界中断，可从最近 checkpoint 继续。",
                retryable: true,
              },
              status: "interrupted",
            });
          }
        }
        for (const message of this.chats.listRunMessages(run.id)) {
          if (message.status === "streaming") {
            this.chats.updateMessage({
              ...message,
              status: "interrupted",
              updatedAt: this.clock.now(),
            });
          }
        }
        this.writer.transition(run.id, "interrupted", {
          code: "AGENT.APP_INTERRUPTED",
          message: "上次运行被应用退出中断，可从最近边界继续。",
          retryable: true,
        });
      }
    });
  }

  async start(
    request: StartRunRequest,
    options?: {
      readonly requestId?: string;
      readonly onRunAllocated?: (runId: string) => void;
      readonly signal?: AbortSignal;
    },
  ): Promise<Run> {
    return this.#prepare(options ?? {}, async (preparation) => {
      await this.beforeUserInteraction();
      preparation.signal.throwIfAborted();
      const modelRuntime = await this.providers.createChatModelRuntime(
        request.providerProfileId,
      );
      preparation.signal.throwIfAborted();
      return this.#start(
        preparation,
        request,
        modelRuntime,
        this.personas.getActiveSnapshot(),
        undefined,
        true,
        true,
        true,
        undefined,
        options?.onRunAllocated,
      );
    });
  }

  async startAutomation(
    request: StartRunRequest,
    options: {
      readonly modelId: string;
      readonly persona: PersonaSnapshot;
      readonly toolNames?: readonly string[];
    },
  ): Promise<Run> {
    return this.#prepare({}, async (preparation) => {
      const modelRuntime = await this.providers.createChatModelRuntime(
        request.providerProfileId,
        options.modelId,
      );
      preparation.signal.throwIfAborted();
      return this.#start(
        preparation,
        request,
        modelRuntime,
        options.persona,
        options.toolNames,
        false,
      );
    });
  }

  async startAssistantInitiated(
    request: StartRunRequest,
    options: {
      readonly modelId: string;
      readonly onStarted?: (run: Run) => void;
      readonly allocation?: RunAllocationReservation;
      readonly prepareCognitionContext?: CognitionDispatchRequest["prepareContext"];
      readonly quietCompletionAllowed?: true;
      readonly persona: PersonaSnapshot;
      readonly toolNames?: readonly string[];
    },
  ): Promise<Run> {
    return this.#prepare({}, async (preparation) => {
      const modelRuntime = await this.providers.createChatModelRuntime(
        request.providerProfileId,
        options.modelId,
      );
      preparation.signal.throwIfAborted();
      return this.#start(
        preparation,
        request,
        modelRuntime,
        options.persona,
        options.toolNames ?? [],
        false,
        false,
        false,
        options.onStarted,
        undefined,
        options.allocation,
        options.prepareCognitionContext,
        options.quietCompletionAllowed,
      );
    });
  }

  async startInlineConversation(
    request: StartRunRequest,
    options: {
      readonly onRunAllocated: (runId: string) => void;
      readonly signal?: AbortSignal;
    },
  ): Promise<Run> {
    return this.#prepare(options, async (preparation) => {
      await this.beforeUserInteraction();
      preparation.signal.throwIfAborted();
      const modelRuntime = await this.providers.createChatModelRuntime(
        request.providerProfileId,
      );
      preparation.signal.throwIfAborted();
      return this.#start(
        preparation,
        request,
        modelRuntime,
        this.personas.getActiveSnapshot(),
        undefined,
        true,
        false,
        true,
        undefined,
        options.onRunAllocated,
      );
    });
  }

  async #start(
    preparation: RunPreparation,
    request: StartRunRequest,
    modelRuntime: ChatModelRuntime,
    persona: PersonaSnapshot,
    toolNames?: readonly string[],
    recordTriggerMessage = true,
    interactionEnabled = true,
    nativeWebSearchEnabled = true,
    onStarted?: (run: Run) => void,
    onRunAllocated?: (runId: string) => void,
    allocation?: RunAllocationReservation,
    prepareCognitionContext?: CognitionDispatchRequest["prepareContext"],
    quietCompletionAllowed?: true,
  ): Promise<Run> {
    const signal = preparation.signal;
    const preflightSignal = signal;
    return this.chatTurns.runSerializedTurn(request.chatId, async () => {
      signal?.throwIfAborted();
      const existing = allocation?.existing();
      if (existing) return existing;
      const limits = await modelRuntime.provider.resolveContextLimits(
        modelRuntime.snapshot.modelId,
        signal,
      );
      signal?.throwIfAborted();
      const preparedAttachments = new Map<string, PreparedAttachmentInput>();
      let resolvedAttachments = [...request.attachments];
      const localAttachments = request.attachments.filter(
        ({ kind }) => kind === "file" || kind === "image",
      );
      if (localAttachments.length > 0 && this.attachmentInputs) {
        try {
          for (const attachment of localAttachments) {
            const prepared = await this.attachmentInputs.prepare(attachment);
            signal?.throwIfAborted();
            if (
              (attachment.byteLength !== undefined &&
                attachment.byteLength !== prepared.byteLength) ||
              (attachment.sha256 !== undefined &&
                attachment.sha256 !== prepared.sha256)
            ) {
              throw new AttachmentInputError(
                `附件“${attachment.displayName}”已发生变化，请重新选择后发送。`,
              );
            }
            preparedAttachments.set(attachment.artifactId, prepared);
          }
          resolvedAttachments = request.attachments.map((attachment) => {
            const prepared = preparedAttachments.get(attachment.artifactId);
            return prepared
              ? {
                  ...attachment,
                  byteLength: prepared.byteLength,
                  sha256: prepared.sha256,
                }
              : attachment;
          });
        } catch (error) {
          signal?.throwIfAborted();
          throw new AgentError(
            "AGENT.ATTACHMENT_INPUT_INVALID",
            error instanceof AttachmentInputError
              ? error.message
              : "附件读取失败，请检查文件后重试。",
            false,
          );
        }
      }
      const imageAttachments = resolvedAttachments.filter(
        ({ kind }) => kind === "image",
      );
      const preparedImages: PreparedImageInput[] = [];
      if (imageAttachments.length > 0) {
        if (limits.supportsVision === false) {
          throw new AgentError(
            "AGENT.IMAGE_INPUT_UNAVAILABLE",
            "当前模型明确不支持图片输入，请选择支持视觉输入的模型。",
            false,
          );
        }
        if (!this.images) {
          throw new AgentError(
            "AGENT.IMAGE_INPUT_INVALID",
            "当前环境无法读取图片输入。",
            false,
          );
        }
        try {
          for (const { storageKey } of imageAttachments) {
            preparedImages.push(await this.images.prepare(storageKey, signal));
            signal?.throwIfAborted();
          }
        } catch (error) {
          signal?.throwIfAborted();
          throw new AgentError(
            "AGENT.IMAGE_INPUT_INVALID",
            error instanceof ImageInputError
              ? error.message
              : "图片读取失败，请检查文件后重试。",
            false,
          );
        }
      }
      const modelText = attachmentContext(
        resolvedAttachments,
        preparedAttachments,
        request.content,
      );
      const currentInput =
        preparedImages.length > 0
          ? imageMessageReference(
              modelText,
              imageAttachments.map(({ storageKey }) => storageKey),
            )
          : recordTriggerMessage
            ? messageInput(modelText)
            : ({
                content: modelText,
                role: "developer",
                type: "message",
              } satisfies JsonValue);
      const runId = this.ids.generate();
      const preparingAt = this.clock.now();
      const prospectiveRun: Run = {
        chatId: request.chatId,
        createdAt: preparingAt,
        execution: request.execution,
        id: runId,
        latestSequence: 1,
        persona,
        provider: modelRuntime.snapshot,
        source: "text",
        startedAt: preparingAt,
        status: "running",
      };
      const requestOptions = {
        ...(toolNames === undefined ? {} : { toolNames }),
        interactionEnabled,
        nativeWebSearchEnabled,
      };
      const imageCache = new Map<string, PreparedImageInput>();
      imageAttachments.forEach((attachment, index) => {
        const image = preparedImages[index];
        if (image) imageCache.set(attachment.storageKey, image);
      });
      const measureInput: ContextInputMeasurement = async (input, options) => {
        signal.throwIfAborted();
        const materialized = await materializeModelInput(
          input as JsonValue,
          this.images,
          imageCache,
          signal,
        );
        signal.throwIfAborted();
        return modelRuntime.provider.measureInput(
          this.#modelRequest(
            prospectiveRun,
            materialized as JsonValue[],
            requestOptions,
            limits,
          ),
          signal,
          options,
        );
      };
      // Only optional conversational context uses remaining token headroom.
      // A selected action has already chosen its necessary basis; materialize
      // that complete set under a separate read-resource allowance, then count
      // the full input together with tools, instructions and conversation.
      const shell = prepareCognitionContext
        ? undefined
        : await measureInput([currentInput]);
      const materialBudget = {
        maxTokens: shell ? cognitionContextTokenHeadroom(shell, limits) : 0,
      };
      const backgroundFrameFits =
        materialBudget.maxTokens >=
        estimatedCognitionContextTokens({
          text: "",
          situationIds: [],
          intentIds: [],
          evidenceIds: [],
        });
      const cognition = prepareCognitionContext
        ? prepareCognitionContext({
            // Selected local raw-read guard; complete required material is
            // measured independently of the full request token limit. See
            // COGNITION-DYNAMIC-ACTION-BUDGET for observed resource costs.
            maxReadBytes: LOCAL_COGNITION_READ_BUDGET_BYTES,
            signal,
          })
        : backgroundFrameFits
          ? await this.cognition?.prepareTurn({
              personaId: persona.personaId,
              chatId: request.chatId,
              currentInput: request.content,
              resourceBudget: {
                maxReadBytes: LOCAL_COGNITION_READ_BUDGET_BYTES,
              },
              contextBudget: materialBudget,
              signal,
            })
          : undefined;
      signal.throwIfAborted();
      const memoryContext =
        cognition &&
        (prepareCognitionContext || cognition.text || cognition.evidencePack)
          ? createCognitionContextInput(cognition)
          : undefined;
      const preparedContext = await this.#chatContext.prepare({
        additionalInput: [
          ...(memoryContext ? [memoryContext] : []),
          currentInput,
        ],
        chatId: request.chatId,
        limits,
        modelId: modelRuntime.snapshot.modelId,
        provider: modelRuntime.provider,
        measureInput,
        signal: preflightSignal,
      });
      signal?.throwIfAborted();
      const now = this.clock.now();
      signal?.throwIfAborted();
      const reserved = allocation?.existing();
      if (reserved) return reserved;
      preparation.runId = runId;
      onRunAllocated?.(runId);
      signal.throwIfAborted();
      this.writer.startRun(
        {
          chatId: request.chatId,
          createdAt: now,
          execution: request.execution,
          id: runId,
          latestSequence: 1,
          persona,
          provider: modelRuntime.snapshot,
          source: "text",
          startedAt: now,
          status: "running",
        },
        allocation ? (runId) => allocation.bind(runId) : undefined,
      );

      if (preparedContext.compacted) {
        const compactionItem = this.writer.startItem(
          runId,
          "context_compaction",
          { scope: "chat" },
        );
        this.writer.completeItem(compactionItem.id, {
          displayOutput:
            "已整理较早会话内容，并保留当前目标、近期原文与长期记忆。",
          output: {
            chatContextGeneration: preparedContext.snapshot?.generation ?? 0,
            coveredThroughMessageId:
              preparedContext.snapshot?.coveredThroughMessageId ?? null,
          },
          status: "completed",
        });
      }

      if (recordTriggerMessage) {
        const userMessage = this.chats.insertMessage({
          chatId: request.chatId,
          content: request.content,
          createdAt: now,
          id: this.ids.generate(),
          role: "user",
          runId,
          status: "completed",
          updatedAt: now,
        });
        for (const attachment of resolvedAttachments) {
          if (!USER_ATTACHMENT_KINDS.has(attachment.kind)) continue;
          this.chats.insertAttachment({
            chatId: request.chatId,
            createdAt: now,
            displayName: attachment.displayName,
            id: attachment.artifactId,
            kind: attachment.kind as Exclude<ArtifactKind, "log" | "data">,
            ...(attachment.mediaType
              ? { mediaType: attachment.mediaType }
              : {}),
            ...(attachment.byteLength === undefined
              ? {}
              : { byteLength: attachment.byteLength }),
            messageId: userMessage.id,
            ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
            storageKey: attachment.storageKey,
          });
        }
        const userItem = this.writer.startItem(runId, "user_message", {
          attachmentIds: resolvedAttachments.map(
            ({ artifactId }) => artifactId,
          ),
          content: request.content,
          messageId: userMessage.id,
        });
        this.writer.completeItem(userItem.id, {
          output: { messageId: userMessage.id },
          status: "completed",
        });
      }
      const state = this.#createActiveRun(
        runId,
        modelRuntime.provider,
        limits,
        {
          ...initialCheckpoint(
            currentInput,
            memoryContext,
            request.content,
            preparedContext.input,
            toolNames,
            interactionEnabled,
            nativeWebSearchEnabled,
          ),
          ...(quietCompletionAllowed ? { quietCompletionAllowed } : {}),
        },
        0,
      );
      // Initial preparation already supplied this input, including a selected
      // autonomous action whose basis must not be prepared a second time.
      state.cognitionInputRevision = state.inputRevision;
      imageAttachments.forEach((attachment, index) => {
        const prepared = preparedImages[index];
        if (prepared) state.imageCache.set(attachment.storageKey, prepared);
      });
      this.#saveCheckpoint(state, "model");
      const started = this.#requireRun(runId);
      onStarted?.(started);
      this.#launch(state, "model", preparation);
      return started;
    });
  }

  async steer(request: SteerRunRequest): Promise<{ runId: string }> {
    this.#assertOpen();
    const active = this.#active.get(request.runId);
    const run = this.#requireRun(request.runId);
    if (
      !active ||
      active.abort.signal.aborted ||
      (run.status !== "running" &&
        run.status !== "waiting_approval" &&
        !(run.status === "needs_input" && active.data.pendingInput))
    ) {
      throw new AgentError(
        "AGENT.RUN_NOT_ACTIVE",
        "该 Run 当前不能接收追加消息。",
        false,
      );
    }
    const inputRevision = active.inputRevision;
    const checkpoint = this.checkpoints.get(run.id);
    const pendingInput = active.data.pendingInput;
    const pendingTool = active.data.pendingTool;
    if (
      run.status !== "running" &&
      (!checkpoint ||
        (run.status === "needs_input" &&
          this.runs.getRunItem(pendingInput!.itemId)?.status !==
            "waiting_input") ||
        (run.status === "waiting_approval" &&
          (!pendingTool?.approvalId ||
            this.runs.getApproval(pendingTool.approvalId)?.status !==
              "pending")))
    ) {
      throw new AgentError(
        "AGENT.RUN_NOT_ACTIVE",
        "该 Run 的等待边界已变化，请按当前状态继续。",
        false,
      );
    }
    return this.#prepare({ runId: run.id }, async (preparation) => {
      await this.beforeUserInteraction(run.id);
      preparation.signal.throwIfAborted();
      const current = this.#requireRun(run.id);
      if (
        this.#active.get(run.id) !== active ||
        active.abort.signal.aborted ||
        active.inputRevision !== inputRevision ||
        !["running", "waiting_approval", "needs_input"].includes(
          current.status,
        ) ||
        (current.status === "needs_input" && !active.data.pendingInput) ||
        // A running model may legitimately progress while yielding. A message
        // submitted to an existing wait must still target that exact boundary.
        (run.status !== "running" &&
          ((current.status !== run.status && current.status !== "running") ||
            !isDeepStrictEqual(this.checkpoints.get(run.id), checkpoint) ||
            !isDeepStrictEqual(active.data.pendingInput, pendingInput) ||
            !isDeepStrictEqual(active.data.pendingTool, pendingTool)))
      ) {
        throw new AgentError(
          "AGENT.RUN_NOT_ACTIVE",
          "追加消息等待执行权时 Run 已变化，请按当前状态继续。",
          false,
        );
      }
      this.#queueSteering(active, current, request);
      if (current.status === "needs_input" && active.data.pendingInput) {
        this.#supersedePendingInput(active, request.requestedAt);
      }
      if (current.status === "waiting_approval") {
        this.#supersedePendingApproval(active, request.requestedAt);
      }
      return { runId: run.id };
    });
  }

  async resume(request: ResumeRunRequest): Promise<{ runId: string }> {
    this.#assertOpen();
    const run = this.#requireRun(request.runId);
    if (run.source === "voice") {
      throw new AgentError(
        "AGENT.VOICE_SESSION_REQUIRED",
        "这个 Run 需要重新进入语音后继续。",
        false,
      );
    }
    if (run.status !== "interrupted" && run.status !== "needs_input") {
      throw new AgentError(
        "AGENT.RUN_NOT_RESUMABLE",
        "该 Run 当前不处于可继续状态。",
        false,
      );
    }
    if (this.#active.has(run.id)) {
      throw new AgentError(
        "AGENT.RUN_NOT_ACTIVE",
        "该 Run 已经在继续执行。",
        false,
      );
    }
    const checkpoint = this.checkpoints.get(run.id);
    if (!checkpoint) {
      throw new AgentError(
        "AGENT.CHECKPOINT_UNAVAILABLE",
        "没有找到可恢复的 Agent checkpoint。",
        false,
      );
    }
    const data = decodeRuntimeCheckpoint(checkpoint.context);
    return this.#prepare({ runId: run.id }, async (preparation) => {
      await this.beforeUserInteraction(run.id);
      preparation.signal.throwIfAborted();
      const modelRuntime = await this.providers.createChatModelRuntime(
        run.provider.profileId,
        run.provider.modelId,
      );
      preparation.signal.throwIfAborted();
      const limits =
        data.contextLimits ??
        (await modelRuntime.provider.resolveContextLimits(
          run.provider.modelId,
          preparation.signal,
        ));
      preparation.signal.throwIfAborted();
      if (
        !isDeepStrictEqual(this.#requireRun(run.id), run) ||
        this.#active.has(run.id) ||
        !isDeepStrictEqual(this.checkpoints.get(run.id), checkpoint)
      ) {
        throw new AgentError(
          "AGENT.RUN_NOT_RESUMABLE",
          "等待恢复期间 Run 或 checkpoint 已变化。",
          false,
        );
      }
      this.writer.resume(run.id);
      const active = this.#createActiveRun(
        run.id,
        modelRuntime.provider,
        limits,
        data,
        checkpoint.generation,
      );
      this.#restoreSteering(active, checkpoint.lastCompletedSequence);
      this.#launch(active, checkpoint.phase, preparation);
      return { runId: run.id };
    });
  }

  #restoreSteering(active: ActiveRun, afterSequence: number): void {
    for (const content of this.runs.steeringMessagesAfter(
      active.runId,
      afterSequence,
    )) {
      active.steering.push({ content });
      active.inputRevision += 1;
    }
  }

  async cancel(request: RunCancelRequest): Promise<RunCancelResult> {
    return this.#prepare<RunCancelResult>({}, async (preparation) => {
      const preparing = [...this.#preparations].filter(
        ({ runId }) => runId === request.runId,
      );
      for (const entry of preparing)
        entry.abort.abort(
          new AgentError(
            "AGENT.PREPARATION_CANCELLED",
            "已停止本次执行准备。",
            false,
          ),
        );
      await Promise.allSettled(preparing.map(({ task }) => task));
      preparation.signal.throwIfAborted();
      const run = this.#requireRun(request.runId);
      if (TERMINAL_STATUSES.has(run.status)) {
        return {
          outcome: "already_terminal",
          runId: run.id,
          status: run.status as Extract<
            Run["status"],
            "interrupted" | "completed" | "failed" | "cancelled"
          >,
        };
      }
      const active = this.#active.get(run.id);
      if (!active) {
        for (const item of this.runs.listRunItems(run.id)) {
          if (item.status === "waiting_input") {
            this.writer.completeItem(item.id, { status: "cancelled" });
          }
        }
        this.writer.transition(run.id, "cancelled");
        return { outcome: "accepted", runId: run.id };
      }
      active.abort.abort(
        new DOMException("Run cancelled by user", "AbortError"),
      );
      await active.task;
      return { outcome: "accepted", runId: run.id };
    });
  }

  getPendingApproval(): Approval | null {
    return this.runs.getLatestPendingApproval() ?? null;
  }

  getApprovalNavigation(approvalId: string): ApprovalNavigationTarget {
    const approval = this.runs.getApproval(approvalId);
    if (!approval) {
      throw new AgentError(
        "AGENT.APPROVAL_NOT_PENDING",
        "审批请求不存在。",
        false,
      );
    }
    const run = this.#requireRun(approval.runId);
    return {
      approvalId: approval.id,
      chatId: run.chatId,
      itemId: approval.itemId,
      runId: run.id,
    };
  }

  async resolveApproval(request: ResolveApprovalRequest): Promise<Approval> {
    this.#assertOpen();
    const approval = this.runs.getApproval(request.approvalId);
    if (!approval) {
      throw new AgentError(
        "AGENT.APPROVAL_NOT_PENDING",
        "审批请求不存在。",
        false,
      );
    }
    if (approval.status !== "pending") return approval;
    const active = this.#active.get(approval.runId);
    if (!active) {
      throw new AgentError(
        "AGENT.RUN_NOT_ACTIVE",
        "请先继续该 Run，再处理审批。",
        false,
      );
    }
    const run = this.#requireRun(approval.runId);
    const checkpoint = this.checkpoints.get(run.id);
    const item = this.runs.getRunItem(approval.itemId);
    if (
      run.status !== "waiting_approval" ||
      item?.status !== "waiting_approval" ||
      !checkpoint ||
      active.abort.signal.aborted ||
      active.data.pendingTool?.approvalId !== approval.id
    ) {
      throw new AgentError(
        "AGENT.APPROVAL_NOT_PENDING",
        "审批与当前 Run 的等待边界不一致。",
        false,
      );
    }
    const inputRevision = active.inputRevision;
    return this.#prepare({ runId: run.id }, async (preparation) => {
      await this.beforeUserInteraction(run.id);
      preparation.signal.throwIfAborted();
      if (
        this.#active.get(run.id) !== active ||
        active.abort.signal.aborted ||
        active.inputRevision !== inputRevision ||
        !isDeepStrictEqual(this.#requireRun(run.id), run) ||
        !isDeepStrictEqual(this.checkpoints.get(run.id), checkpoint) ||
        !isDeepStrictEqual(this.runs.getApproval(approval.id), approval) ||
        !isDeepStrictEqual(this.runs.getRunItem(approval.itemId), item) ||
        active.data.pendingTool?.approvalId !== approval.id
      ) {
        throw new AgentError(
          "AGENT.APPROVAL_NOT_PENDING",
          "等待执行权期间审批或 Run 已变化。",
          false,
        );
      }
      const resolved = this.writer.resolveApproval({
        ...approval,
        decidedAt: request.decidedAt,
        ...(request.reason === undefined
          ? {}
          : { decisionReason: request.reason }),
        status: request.decision,
      });
      active.waiters.get(approval.id)?.(request.decision);
      active.waiters.delete(approval.id);
      return resolved;
    });
  }

  async continueWithCognitionContext(request: {
    readonly runId: string;
    readonly itemId: string;
    readonly attemptId: string;
    readonly requestedAt: string;
    readonly signal: AbortSignal;
    readonly prepareContext: CognitionDispatchRequest["prepareContext"];
    readonly assertCurrent: () => void;
    readonly onAccepted: (receipt: {
      resolvedAt: string;
      evidenceIds: string[];
    }) => void;
  }): Promise<{ runId: string }> {
    this.#assertOpen();
    const run = this.#requireRun(request.runId);
    const item = this.runs.getRunItem(request.itemId);
    const notPending = () =>
      new AgentError(
        "AGENT.INPUT_NOT_PENDING",
        "环境补充与当前等待问题不一致。",
        false,
      );
    if (!item || item.runId !== run.id || item.kind !== "input_request") {
      throw notPending();
    }
    if (item.status === "completed") {
      const prior = parseSchema(InputRequestResolutionSchema, item.output);
      if (
        prior.status === "context_available" &&
        prior.attemptId === request.attemptId
      ) {
        return { runId: run.id };
      }
      throw notPending();
    }
    const checkpoint = this.checkpoints.get(run.id);
    if (
      !checkpoint ||
      run.status !== "needs_input" ||
      item.status !== "waiting_input"
    ) {
      throw notPending();
    }
    const data = decodeRuntimeCheckpoint(checkpoint.context);
    const pending = data.pendingInput;
    if (!pending || pending.itemId !== item.id) throw notPending();
    const previousActive = this.#active.get(run.id);
    const inputRevision = previousActive?.inputRevision;
    return this.#prepare(
      { runId: run.id, signal: request.signal },
      async (preparation) => {
        let active = previousActive;
        const signal = previousActive
          ? AbortSignal.any([preparation.signal, previousActive.abort.signal])
          : preparation.signal;
        const assertBoundary = () => {
          signal.throwIfAborted();
          active?.abort.signal.throwIfAborted();
          request.assertCurrent();
          if (
            this.#active.get(run.id) !== previousActive ||
            previousActive?.inputRevision !== inputRevision ||
            (previousActive &&
              previousActive.data.pendingInput?.itemId !== item.id) ||
            !isDeepStrictEqual(this.#requireRun(run.id), run) ||
            !isDeepStrictEqual(this.runs.getRunItem(item.id), item) ||
            !isDeepStrictEqual(this.checkpoints.get(run.id), checkpoint)
          )
            throw notPending();
        };
        const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
          try {
            const result = await operation();
            assertBoundary();
            return result;
          } catch (error) {
            assertBoundary();
            throw error;
          }
        };
        assertBoundary();
        if (!active) {
          const runtime = await checked(() =>
            this.providers.createChatModelRuntime(
              run.provider.profileId,
              run.provider.modelId,
            ),
          );
          const limits =
            data.contextLimits ??
            (await checked(() =>
              runtime.provider.resolveContextLimits(
                run.provider.modelId,
                signal,
              ),
            ));
          active = this.#createActiveRun(
            run.id,
            runtime.provider,
            limits,
            data,
            checkpoint.generation,
          );
          this.#restoreSteering(active, checkpoint.lastCompletedSequence);
        }
        const target = active;
        const context = request.prepareContext({
          maxReadBytes: LOCAL_COGNITION_READ_BUDGET_BYTES,
          signal,
        });
        assertBoundary();
        if (
          context.decisionAttemptId !== request.attemptId ||
          context.evidenceIds.length === 0
        ) {
          throw new TypeError(
            "Environment continuation requires its complete selected context",
          );
        }
        const availability = {
          status: "context_available" as const,
          attemptId: request.attemptId,
          evidenceIds: context.evidenceIds,
        };
        if (hasToolOutput(data.input, pending.callId)) throw notPending();
        const projected: RuntimeCheckpointState = {
          ...target.data,
          input: [
            ...data.input.filter(
              (value) => !isOrdinaryCognitionContextInput(value),
            ),
            createCognitionContextInput(context),
            inputRequestOutput(pending.callId, availability),
          ],
        };
        delete (projected as { lastUsage?: unknown }).lastUsage;
        delete (projected as { lastRequestBytes?: number }).lastRequestBytes;
        const modelInput = await checked(() =>
          materializeModelInput(
            projected.input as JsonValue,
            this.images,
            target.imageCache,
            signal,
          ),
        );
        const modelRequest = this.#modelRequest(
          run,
          modelInput as JsonValue[],
          projected,
          target.limits,
          target.tools,
        );
        const budget = modelInputBudget(
          target.limits,
          modelRequest.maxOutputTokens,
        );
        let measurement = await checked(() =>
          target.provider.measureInput(modelRequest, signal),
        );
        if (
          !fitsInputBudget(measurement, budget) &&
          measurement.exactInputTokens === undefined
        ) {
          measurement = await checked(() =>
            target.provider.measureInput(modelRequest, signal, {
              requireExact: true,
            }),
          );
        }
        if (!fitsInputBudget(measurement, budget)) {
          throw new ProviderError(
            "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
            "环境补充无法与当前完整请求共同容纳。",
            false,
          );
        }
        assertBoundary();
        const resolution = parseSchema(InputRequestResolutionSchema, {
          ...availability,
          resolvedAt: this.clock.now(),
        });
        let accepted = false;
        let publicationError: unknown;
        const abortOwnedPreparation = () => {
          target.interruptRequested = this.#closed;
          target.abort.abort(preparation.abort.signal.reason);
        };
        try {
          try {
            this.writer.resolveInput(item.id, resolution, {
              commit: (_resolved, resumed) => {
                assertBoundary();
                this.checkpoints.save({
                  runId: run.id,
                  context: checkpointJson(projected),
                  generation: checkpoint.generation + 1,
                  lastCompletedSequence: resumed.latestSequence,
                  phase: "input",
                  updatedAt: resolution.resolvedAt,
                });
                request.onAccepted({
                  resolvedAt: resolution.resolvedAt,
                  evidenceIds: [...context.evidenceIds],
                });
              },
              afterCommit: () => {
                accepted = true;
                target.data = projected;
                target.generation = checkpoint.generation + 1;
                // Only Stop/shutdown owns the accepted Run; PFC cancellation does not.
                preparation.abort.signal.addEventListener(
                  "abort",
                  abortOwnedPreparation,
                  { once: true },
                );
                if (preparation.abort.signal.aborted) abortOwnedPreparation();
              },
            });
          } catch (error) {
            if (!accepted) throw error;
            publicationError = error;
          }
          if (previousActive) {
            target.inputWaiters.get(item.id)?.(resolution);
            target.inputWaiters.delete(item.id);
          } else if (this.#closed) {
            this.writer.transition(run.id, "interrupted", {
              code: "AGENT.APP_INTERRUPTED",
              message: "应用退出中断了执行，可从已接纳的上下文继续。",
              retryable: true,
            });
          } else {
            // This is an existing Run, not a child owned by the PFC preparation.
            this.#launch(target, "input");
          }
          if (publicationError !== undefined) {
            throw publicationError instanceof Error
              ? publicationError
              : new Error("Input resolution publication failed", {
                  cause: publicationError,
                });
          }
          return { runId: run.id };
        } finally {
          preparation.abort.signal.removeEventListener(
            "abort",
            abortOwnedPreparation,
          );
        }
      },
    );
  }

  async resolveUserInput(request: ResolveUserInputRequest): Promise<Run> {
    this.#assertOpen();
    const run = this.#requireRun(request.runId);
    const item = this.runs.getRunItem(request.itemId);
    if (!item || item.runId !== run.id || item.kind !== "input_request") {
      throw new AgentError(
        "AGENT.INPUT_NOT_PENDING",
        "补充问题不存在或不属于该 Run。",
        false,
      );
    }
    const input = parseUserInputArguments(
      item.input as Readonly<Record<string, JsonValue>>,
    );
    const resolution = validateUserInputResolution(
      input.questions,
      request.resolution,
    );
    if (item.status === "completed") return run;
    if (item.status !== "waiting_input" || run.status !== "needs_input") {
      throw new AgentError(
        "AGENT.INPUT_NOT_PENDING",
        "该补充问题当前不能回答。",
        false,
      );
    }

    const checkpoint = this.checkpoints.get(run.id);
    if (!checkpoint) {
      throw new AgentError(
        "AGENT.CHECKPOINT_UNAVAILABLE",
        "没有找到补充问题对应的 Agent checkpoint。",
        false,
      );
    }
    const previousActive = this.#active.get(run.id);
    const inputRevision = previousActive?.inputRevision;
    const checkpointData = decodeRuntimeCheckpoint(checkpoint.context);
    if (
      checkpointData.pendingInput?.itemId !== item.id ||
      previousActive?.abort.signal.aborted ||
      (previousActive && previousActive.data.pendingInput?.itemId !== item.id)
    ) {
      throw new AgentError(
        "AGENT.INPUT_NOT_PENDING",
        "补充问题与当前 checkpoint 不一致。",
        false,
      );
    }
    return this.#prepare({ runId: run.id }, async (preparation) => {
      await this.beforeUserInteraction(run.id);
      preparation.signal.throwIfAborted();
      let active = previousActive;
      let launchAfterResolution = false;
      if (!active) {
        const modelRuntime = await this.providers.createChatModelRuntime(
          run.provider.profileId,
          run.provider.modelId,
        );
        preparation.signal.throwIfAborted();
        const data = decodeRuntimeCheckpoint(checkpoint.context);
        const limits =
          data.contextLimits ??
          (await modelRuntime.provider.resolveContextLimits(
            run.provider.modelId,
            preparation.signal,
          ));
        preparation.signal.throwIfAborted();
        active = this.#createActiveRun(
          run.id,
          modelRuntime.provider,
          limits,
          data,
          checkpoint.generation,
        );
        this.#restoreSteering(active, checkpoint.lastCompletedSequence);
        launchAfterResolution = true;
      }
      if (active.data.pendingInput?.itemId !== item.id) {
        throw new AgentError(
          "AGENT.INPUT_NOT_PENDING",
          "补充问题与当前 checkpoint 不一致。",
          false,
        );
      }

      if (
        this.#active.get(run.id) !== previousActive ||
        active.abort.signal.aborted ||
        previousActive?.inputRevision !== inputRevision ||
        !isDeepStrictEqual(this.#requireRun(run.id), run) ||
        !isDeepStrictEqual(this.checkpoints.get(run.id), checkpoint) ||
        !isDeepStrictEqual(this.runs.getRunItem(item.id), item)
      ) {
        throw new AgentError(
          "AGENT.INPUT_NOT_PENDING",
          "等待执行权期间补充问题或 Run 已变化。",
          false,
        );
      }
      this.writer.resolveInput(item.id, resolution);
      active.inputWaiters.get(item.id)?.(resolution);
      active.inputWaiters.delete(item.id);
      if (launchAfterResolution) this.#launch(active, "input", preparation);
      return this.#requireRun(run.id);
    });
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AgentError(
        "AGENT.APP_SHUTTING_DOWN",
        "应用正在退出，不能开始新的执行准备。",
        false,
      );
    }
  }

  #prepare<TResult>(
    scope: {
      readonly requestId?: string;
      readonly runId?: string;
      readonly signal?: AbortSignal;
    },
    operation: (preparation: RunPreparation) => Promise<TResult>,
  ): Promise<TResult> {
    try {
      this.#assertOpen();
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("Execution preparation failed", { cause: error }),
      );
    }
    if (
      scope.requestId &&
      ([...this.#preparations].some(
        ({ requestId }) => requestId === scope.requestId,
      ) ||
        [...this.#active.values()].some(
          ({ startRequestId }) => startRequestId === scope.requestId,
        ))
    ) {
      return Promise.reject(
        new AgentError(
          "AGENT.REQUEST_IN_PROGRESS",
          "这次发送仍在处理中。",
          false,
        ),
      );
    }
    const abort = new AbortController();
    const signal = scope.signal
      ? AbortSignal.any([abort.signal, scope.signal])
      : abort.signal;
    // Register before entering any user callback or asynchronous dependency.
    const task = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation(preparation);
      })
      .finally(async () => {
        try {
          // Only a Run launched by this operation belongs to its cancellation.
          // An existing target of steer/approval is not an allocated child.
          const active = preparation.active;
          if (signal.aborted && active) {
            active.interruptRequested = this.#closed;
            active.abort.abort(signal.reason);
            await active.task;
          }
        } finally {
          this.#preparations.delete(preparation);
        }
      });
    const preparation: RunPreparation = {
      abort,
      signal,
      task,
      ...(scope.requestId ? { requestId: scope.requestId } : {}),
      ...(scope.runId ? { runId: scope.runId } : {}),
    };
    this.#preparations.add(preparation);
    return task;
  }

  async cancelStart(request: CancelStartRequest): Promise<CancelStartResult> {
    return this.#prepare<CancelStartResult>({}, async (control) => {
      const preparing = [...this.#preparations].find(
        ({ requestId }) => requestId === request.requestId,
      );
      const active = [...this.#active.values()].find(
        ({ startRequestId }) => startRequestId === request.requestId,
      );
      if (!preparing && !active) {
        return { requestId: request.requestId, outcome: "not_pending" };
      }
      preparing?.abort.abort(
        new AgentError(
          "AGENT.PREPARATION_CANCELLED",
          "已停止本次发送准备。",
          false,
        ),
      );
      if (active) {
        active.abort.abort(
          new DOMException("Run cancelled by user", "AbortError"),
        );
      }
      if (preparing) await Promise.allSettled([preparing.task]);
      await active?.task;
      control.signal.throwIfAborted();
      const runId = active?.runId ?? preparing?.runId;
      const run = runId ? this.runs.getRun(runId) : undefined;
      if (run)
        await this.cancel({ runId: run.id, requestedAt: request.requestedAt });
      return {
        requestId: request.requestId,
        outcome: "accepted",
        ...(run ? { runId: run.id } : {}),
      };
    });
  }

  interruptAll(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#closed = true;
    const reason = new AgentError(
      "AGENT.APP_SHUTTING_DOWN",
      "应用退出中断了执行准备。",
      false,
    );
    const preparing = [...this.#preparations];
    for (const entry of preparing) entry.abort.abort(reason);
    const tasks = [...this.#active.values()].map((active) => {
      active.interruptRequested = true;
      active.abort.abort(
        new DOMException("Application is shutting down", "AbortError"),
      );
      return active.task;
    });
    this.#stopping = Promise.allSettled([
      ...preparing.map(({ task }) => task),
      ...tasks,
    ]).then(() => undefined);
    return this.#stopping;
  }

  #createActiveRun(
    runId: string,
    provider: ModelProvider,
    limits: ModelContextLimits,
    data: RuntimeCheckpointState,
    generation: number,
  ): ActiveRun {
    const latestPlanItem = this.runs
      .listRunItems(runId)
      .findLast(
        ({ kind, status }) => kind === "plan" && status === "completed",
      );
    const restoredData =
      latestPlanItem?.input === undefined
        ? data
        : { ...data, currentPlan: parseCurrentPlan(latestPlanItem.input) };
    const contextLimits = restoredData.contextLimits ?? limits;
    return {
      abort: new AbortController(),
      data:
        restoredData.contextLimits === undefined
          ? { ...restoredData, contextLimits }
          : restoredData,
      generation,
      imageCache: new Map(),
      inputWaiters: new Map(),
      limits: contextLimits,
      provider,
      runId,
      steering: [],
      inputRevision: 0,
      // A recovered user conversation reads current committed state at its next
      // request. Autonomous-only recovery retains its already selected basis.
      cognitionInputRevision: [
        restoredData.currentUserInput,
        restoredData.latestUserInput,
      ].some(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          value["role"] === "user",
      )
        ? -1
        : 0,
      steeringWaiters: new Set(),
      tools: this.tools,
      interruptRequested: false,
      waiters: new Map(),
    };
  }

  #launch(
    active: ActiveRun,
    phase: CheckpointPhase = "model",
    preparation?: RunPreparation,
  ): void {
    if (preparation) preparation.active = active;
    if (preparation?.requestId) active.startRequestId = preparation.requestId;
    if (preparation?.signal.aborted) {
      active.interruptRequested = this.#closed;
      active.abort.abort(preparation.signal.reason);
    }
    if (TERMINAL_STATUSES.has(this.#requireRun(active.runId).status)) return;
    this.#active.set(active.runId, active);
    const task = this.#drive(active, phase)
      .catch((error: unknown) => this.#handleDriveFailure(active, error))
      .finally(() => {
        if (this.#active.get(active.runId) === active) {
          this.#active.delete(active.runId);
        }
      });
    active.task = task;
  }

  async #drive(active: ActiveRun, phase: CheckpointPhase): Promise<void> {
    if (phase === "input" || active.data.pendingInput) {
      await this.#resumeInputBoundary(active);
    }
    if (phase === "tool" || phase === "approval") {
      const canContinue = await this.#resumePendingBoundary(active, phase);
      if (!canContinue) return;
    } else if (active.data.pendingTool) {
      const inferredPhase = active.data.pendingTool.toolItemId
        ? "tool"
        : active.data.pendingTool.approvalId
          ? "approval"
          : undefined;
      if (inferredPhase) {
        const canContinue = await this.#resumePendingBoundary(
          active,
          inferredPhase,
        );
        if (!canContinue) return;
      }
    }

    while (true) {
      active.abort.signal.throwIfAborted();
      const shouldRecordChatUsage =
        active.data.chatContextUsageRecorded !== true;
      const turn = await this.#modelTurn(active);
      const turnInputRevision = turn.inputRevision;
      const checkpointWithoutAllowedTools = { ...active.data };
      delete checkpointWithoutAllowedTools.allowedTools;
      const nextInput = [
        ...active.data.input,
        ...contextSafeOutputItems(turn.outputItems),
      ];
      active.data = {
        ...checkpointWithoutAllowedTools,
        boundaries: active.data.boundaries,
        chatContextUsageRecorded: true,
        forcedCompactionAttempted: false,
        input: nextInput,
        lastRequestBytes: turn.requestBytes,
        lastUsage: turn.usage,
      };
      if (
        shouldRecordChatUsage &&
        turn.usage.inputTokens !== undefined &&
        !active.data.input.some(containsImageInput)
      ) {
        const run = this.#requireRun(active.runId);
        this.#chatContext.recordUsage({
          chatId: run.chatId,
          inputTokens: turn.usage.inputTokens,
          modelId: run.provider.modelId,
          requestBytes: turn.requestBytes,
        });
      }

      for (const searchCall of turn.toolSearchCalls) {
        const selected = this.#searchTools(
          active,
          searchCall.query,
          searchCall.limit,
        );
        const allowedTools = selected.map(({ descriptor }) => ({
          name: descriptor.name,
          namespace: descriptor.namespace,
        }));
        active.data = {
          ...active.data,
          ...(allowedTools.length === 0 ? {} : { allowedTools }),
          input: [
            ...active.data.input,
            {
              call_id: searchCall.callId,
              execution: "client",
              status: "completed",
              tools: searchOutputTools(selected),
              type: "tool_search_output",
            },
          ],
        };
      }

      for (const call of turn.functionCalls) {
        if (active.inputRevision !== turnInputRevision) {
          this.#skipSupersededCall(active, call);
        } else {
          await this.#handleToolCall(active, call);
        }
      }
      const hadSteering = active.inputRevision !== turnInputRevision;
      if (turn.status === "cancelled" && !hadSteering) {
        await this.#awaitSteering(active);
      }
      this.#mergeSteering(active);
      this.#saveCheckpoint(active, "model");

      if (
        turn.status === "cancelled" ||
        turn.toolSearchCalls.length > 0 ||
        turn.functionCalls.length > 0 ||
        hadSteering
      ) {
        continue;
      }
      if (turn.text.trim() || active.data.quietCompletionAllowed) {
        const completedRun = this.writer.transition(active.runId, "completed");
        this.checkpoints.delete(active.runId);
        if (turn.text.trim()) {
          await this.#generateFirstTurnTitle(active, completedRun, turn.text);
        }
        return;
      }
      throw new GuardTerminalError({
        code: "AGENT.EMPTY_RESPONSE",
        message: "模型没有给出可验证的回答或下一步动作。",
        retryable: false,
      });
    }
  }

  async #generateFirstTurnTitle(
    active: ActiveRun,
    run: Run,
    assistantContent: string,
  ): Promise<void> {
    if (!this.chatTitles) return;
    const firstUserMessage = this.chats
      .listMessages(run.chatId)
      .find(({ role, status }) => role === "user" && status === "completed");
    if (!firstUserMessage || firstUserMessage.runId !== run.id) return;
    await this.chatTitles.generate({
      assistantContent,
      chatId: run.chatId,
      firstUserContent: firstUserMessage.content,
      modelId: run.provider.modelId,
      provider: active.provider,
      signal: active.abort.signal,
    });
  }

  #availableTools(
    active: Pick<ActiveRun, "tools" | "runId"> & {
      readonly data: Pick<RuntimeCheckpointState, "toolNames">;
    },
    run = this.#requireRun(active.runId),
  ) {
    return active.tools
      .list()
      .filter(
        (definition) =>
          toolAllowedInExecution(run.execution, definition.descriptor) &&
          this.#toolSelected(active, definition.descriptor.name),
      );
  }

  #toolSelected(
    active: { readonly data: Pick<RuntimeCheckpointState, "toolNames"> },
    name: string,
  ): boolean {
    return (
      active.data.toolNames === undefined ||
      active.data.toolNames.includes(name)
    );
  }

  #toolAvailable(active: ActiveRun, name: string): boolean {
    return this.#availableTools(active).some(
      ({ descriptor }) => descriptor.name === name,
    );
  }

  #toolAllowedByLoadedScope(active: ActiveRun, name: string): boolean {
    if (ALWAYS_LOADED_CLIENT_TOOLS.has(name)) return true;
    if (active.data.allowedTools) {
      return active.data.allowedTools.some((tool) => tool.name === name);
    }
    const loaded = loadedToolNames(active.data.input);
    return loaded === undefined || loaded.has(name);
  }

  #searchTools(active: ActiveRun, query: string, limit: number) {
    const available = new Set(
      this.#availableTools(active)
        .filter(
          ({ descriptor }) => !ALWAYS_LOADED_CLIENT_TOOLS.has(descriptor.name),
        )
        .map(({ descriptor }) => descriptor.name),
    );
    return active.tools.search(query, limit, available);
  }

  #modelRequest(
    run: Run,
    input: readonly JsonValue[],
    options: Pick<
      RuntimeCheckpointState,
      | "toolNames"
      | "interactionEnabled"
      | "nativeWebSearchEnabled"
      | "allowedTools"
    >,
    limits: ModelContextLimits,
    tools: ToolRegistry = this.tools,
  ): ModelRequest {
    const registeredTools = this.#availableTools(
      { tools, runId: run.id, data: options },
      run,
    );
    const groupedToolNamespaces = groupModelTools(registeredTools);
    const baseToolNamespaces =
      options.interactionEnabled === false
        ? groupedToolNamespaces
        : withUserInputTool(groupedToolNamespaces);
    const toolNamespaces =
      this.images &&
      limits.supportsVision !== false &&
      (options.toolNames === undefined ||
        options.toolNames.includes(IMAGE_INSPECT_TOOL_NAME))
        ? withImageInspectTool(baseToolNamespaces)
        : baseToolNamespaces;
    const extra = [
      this.#characterContext.compile(run.persona),
      this.additionalInstructions(run),
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const instructions = [
      TEXT_AGENT_BASE_INSTRUCTIONS,
      modelTimeInstructions(modelTimeContext(this.clock.now())),
      executionInstructions(run.execution),
      extra,
    ]
      .filter(Boolean)
      .join("\n\n");
    const alwaysLoadedAllowedTools = registeredTools
      .filter(({ descriptor }) =>
        ALWAYS_LOADED_CLIENT_TOOLS.has(descriptor.name),
      )
      .map(({ descriptor }) => ({
        name: descriptor.name,
        namespace: descriptor.namespace,
      }));
    const allowedTools = options.allowedTools
      ? uniqueAllowedTools([
          USER_INPUT_ALLOWED_TOOL,
          ...alwaysLoadedAllowedTools,
          ...(this.images &&
          limits.supportsVision !== false &&
          (options.toolNames === undefined ||
            options.toolNames.includes(IMAGE_INSPECT_TOOL_NAME))
            ? [IMAGE_INSPECT_ALLOWED_TOOL]
            : []),
          ...options.allowedTools,
        ])
      : undefined;
    return {
      ...(allowedTools === undefined ? {} : { allowedTools }),
      input,
      instructions,
      ...(limits.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: limits.maxOutputTokens }),
      modelId: run.provider.modelId,
      nativeWebSearch: options.nativeWebSearchEnabled !== false,
      toolNamespaces,
    };
  }

  async #modelTurn(active: ActiveRun): Promise<
    CollectedModelTurn & {
      readonly requestBytes: number;
      readonly inputRevision: number;
    }
  > {
    const run = this.#requireRun(active.runId);
    const item = this.writer.startItem(run.id, "assistant_message", {
      modelId: run.provider.modelId,
    });
    let message: Message | undefined;
    let visibleText = "";
    let pendingDelta = "";
    const flushDelta = () => {
      if (!pendingDelta) return;
      const now = this.clock.now();
      if (!message) {
        message = this.chats.insertMessage({
          chatId: run.chatId,
          content: visibleText,
          createdAt: now,
          id: this.ids.generate(),
          role: "assistant",
          runId: run.id,
          status: "streaming",
          updatedAt: now,
        });
      } else {
        message = this.chats.updateMessage({
          ...message,
          content: visibleText,
          updatedAt: now,
        });
      }
      this.writer.appendDelta(run.id, item.id, { text: pendingDelta });
      pendingDelta = "";
    };
    const deltaBatcher = new RunDeltaBatcher(flushDelta);
    let attemptedRequest: ModelRequest | undefined;
    let attemptedInputRevision: number | undefined;

    try {
      let inputRevision: number;
      let modelInput: JsonValue[];
      for (;;) {
        active.abort.signal.throwIfAborted();
        this.#mergeSteering(active);
        inputRevision = active.inputRevision;
        this.#removeStaleCognitionContext(active, inputRevision);
        // Remove stale optional state before finding space in the actual
        // request. Selected-action evidence and Tool results remain intact.
        await this.#compact(active, false);
        if (inputRevision !== active.inputRevision) continue;
        await this.#refreshCognitionContext(active, inputRevision);
        if (inputRevision !== active.inputRevision) continue;
        modelInput = (await materializeModelInput(
          active.data.input as JsonValue,
          this.images,
          active.imageCache,
          active.abort.signal,
        )) as JsonValue[];
        // Input received during any preparation await must share the latest
        // context in this request, without sending a redundant stale request.
        if (inputRevision === active.inputRevision) break;
      }
      active.abort.signal.throwIfAborted();
      const memoryReferences = suppliedMemoryReferences(active.data.input);
      const request = this.#modelRequest(
        run,
        modelInput,
        active.data,
        active.limits,
        active.tools,
      );
      attemptedRequest = request;
      attemptedInputRevision = inputRevision;
      const requestBytes = active.provider.estimateInput(request).wireBytes;
      const events = active.provider.stream(request, active.abort.signal);
      const turn = await collectModelTurn(events, (delta) => {
        visibleText += delta;
        pendingDelta += delta;
        deltaBatcher.schedule();
      });
      deltaBatcher.flush();
      const interrupted = turn.status === "cancelled";
      const displayText = turn.displayText ?? turn.text;
      const now = this.clock.now();
      const completedMessage: Message | undefined =
        message || displayText
          ? {
              ...(message ?? {
                chatId: run.chatId,
                createdAt: now,
                id: this.ids.generate(),
                role: "assistant" as const,
                runId: run.id,
              }),
              content: displayText,
              status: interrupted ? "interrupted" : "completed",
              updatedAt: now,
            }
          : undefined;
      this.writer.completeItem(
        item.id,
        {
          ...(displayText ? { displayOutput: displayText } : {}),
          output: asJsonValue({
            messageId: completedMessage?.id ?? null,
            ...(turn.assistantMessages === undefined
              ? {}
              : {
                  assistantMessages: turn.assistantMessages,
                }),
            responseId: turn.responseId,
            usage: turn.usage,
            memoryReferences,
            functionCallIds: turn.functionCalls.map(({ callId }) => callId),
          }),
          status: interrupted ? "interrupted" : "completed",
        },
        completedMessage
          ? () => {
              // Same SQLite transaction as the completed Item, before its event is published.
              if (message) this.chats.updateMessage(completedMessage);
              else this.chats.insertMessage(completedMessage);
            }
          : undefined,
      );
      message = completedMessage;
      return { ...turn, requestBytes, inputRevision };
    } catch (error) {
      // Publication may fail after the transaction committed. Do not rewrite a
      // durable completed Item/Message as a failed partial stream.
      if (this.runs.getRunItem(item.id)?.status !== "running") throw error;
      deltaBatcher.flush();
      const cancelled = active.abort.signal.aborted;
      const reportedError = active.data.input.some(containsImageInput)
        ? error instanceof ProviderError &&
          error.code === "PROVIDER.REQUEST_FAILED" &&
          !error.retryable
          ? new ProviderError(
              "PROVIDER.IMAGE_INPUT_UNAVAILABLE",
              "当前模型或 Provider 拒绝了图片输入，请选择支持视觉输入的模型。",
              false,
            )
          : error instanceof ImageInputError
            ? new ProviderError(
                "PROVIDER.IMAGE_INPUT_UNAVAILABLE",
                error.message,
                false,
              )
            : error
        : error;
      if (message?.status === "streaming") {
        this.chats.updateMessage({
          ...message,
          status: cancelled
            ? active.interruptRequested
              ? "interrupted"
              : "cancelled"
            : "failed",
          updatedAt: this.clock.now(),
        });
      }
      this.writer.completeItem(item.id, {
        error:
          reportedError instanceof ProviderError
            ? toProviderAppError(reportedError)
            : {
                code: cancelled ? "AGENT.CANCELLED" : "AGENT.MODEL_FAILED",
                message: cancelled ? "模型请求已取消。" : "模型请求没有完成。",
                retryable: !cancelled,
              },
        status: cancelled
          ? active.interruptRequested
            ? "interrupted"
            : "cancelled"
          : "failed",
      });
      if (
        reportedError instanceof ProviderError &&
        reportedError.code === "PROVIDER.CONTEXT_LIMIT_EXCEEDED" &&
        !active.data.forcedCompactionAttempted
      ) {
        active.data = { ...active.data, forcedCompactionAttempted: true };
        const durableCompactionApplied =
          active.data.chatContextUsageRecorded !== true &&
          active.data.lastUsage === undefined &&
          active.data.boundaries.length === 0
            ? await this.#compactChatContextForFirstRequest(active)
            : false;
        const changed =
          durableCompactionApplied ||
          (await this.#compact(active, true, attemptedRequest));
        if (changed || active.inputRevision !== attemptedInputRevision)
          return this.#modelTurn(active);
      }
      throw reportedError;
    }
  }

  async #handleToolCall(
    active: ActiveRun,
    call: ModelFunctionCall,
  ): Promise<void> {
    if (isUserInputCall(call)) {
      await this.#handleUserInputCall(active, call);
      return;
    }
    if (isImageInspectCall(call)) {
      await this.#handleImageInspectCall(active, call);
      return;
    }
    const resolvedName = this.#resolveToolName(active, call);
    const pending: PendingToolCall = {
      arguments: call.arguments,
      callId: call.callId,
      name: resolvedName,
      rawItem: call.rawItem,
    };
    const definition = active.tools.get(resolvedName);
    if (!definition) {
      const result = unexpectedToolResult(
        new TypeError(`Unknown Tool: ${resolvedName}`),
      );
      this.#recordToolResult(active, pending, undefined, result);
      return;
    }
    const run = this.#requireRun(active.runId);
    const internalPersistence = CHAT_INTERNAL_TOOL_NAMES.has(resolvedName);
    if (!toolAllowedInExecution(run.execution, definition.descriptor)) {
      this.#recordToolResult(active, pending, undefined, chatModeToolResult());
      return;
    }
    if (!this.#toolAllowedByLoadedScope(active, resolvedName)) {
      this.#recordToolResult(active, pending, undefined, toolScopeResult());
      return;
    }
    if (!this.#toolAvailable(active, resolvedName)) {
      this.#recordToolResult(active, pending, undefined, toolScopeResult());
      return;
    }
    try {
      active.tools.validateInput(resolvedName, call.arguments);
    } catch (error) {
      this.#recordToolResult(
        active,
        pending,
        definition.descriptor,
        unexpectedToolResult(error),
      );
      return;
    }

    if (internalPersistence) {
      await this.#executeTool(active, pending, definition);
      return;
    }

    if (requiresApproval(run.execution, definition.descriptor)) {
      const approvalItem = this.writer.startItem(run.id, "approval", {
        arguments: call.arguments,
        toolName: resolvedName,
      });
      const approval = this.writer.requestApproval({
        expiresAt: APPROVAL_RUN_LIFETIME,
        id: this.ids.generate(),
        itemId: approvalItem.id,
        parameterSummary: definition.summarize(call.arguments),
        requestedAt: this.clock.now(),
        runId: run.id,
        status: "pending",
        toolName: resolvedName,
      });
      const awaiting = {
        ...pending,
        approvalId: approval.id,
        approvalItemId: approvalItem.id,
      };
      active.data = {
        ...active.data,
        handoff: {
          ...active.data.handoff,
          nextSteps: [`等待审批：${definition.summarize(call.arguments)}`],
        },
        pendingTool: awaiting,
      };
      this.#saveCheckpoint(active, "approval");
      const decision = await this.#awaitApproval(active, approval.id);
      await this.#continueAfterApproval(active, awaiting, decision);
      return;
    }
    await this.#executeTool(active, pending, definition);
  }

  async #handleImageInspectCall(
    active: ActiveRun,
    call: ModelFunctionCall,
  ): Promise<void> {
    const pending: PendingToolCall = {
      arguments: call.arguments,
      callId: call.callId,
      name: IMAGE_INSPECT_TOOL_NAME,
      rawItem: call.rawItem,
    };
    if (!this.#toolSelected(active, IMAGE_INSPECT_TOOL_NAME)) {
      this.#recordToolResult(active, pending, undefined, toolScopeResult());
      return;
    }
    if (!this.images || active.limits.supportsVision === false) {
      this.#recordToolResult(
        active,
        pending,
        undefined,
        imageInspectionError(
          new Error(
            active.limits.supportsVision === false
              ? "当前模型明确不支持图片输入。"
              : "当前环境无法读取图片输入。",
          ),
        ),
      );
      return;
    }

    const item = this.writer.startItem(active.runId, "tool_call", {
      arguments: call.arguments,
      callId: call.callId,
      toolName: IMAGE_INSPECT_TOOL_NAME,
    });
    const executing = { ...pending, toolItemId: item.id };
    active.data = { ...active.data, pendingTool: executing };
    this.#saveCheckpoint(active, "tool");
    try {
      const target = parseSchema(ImageInspectArgumentsSchema, call.arguments);
      let source: ImageInputSource;
      if (target.path !== undefined) {
        source = parseImageInputSource(target.path);
      } else if (target.activity && "reference" in target.activity) {
        source = { activity: target.activity.reference };
      } else {
        const activity = this.images.activity;
        if (!activity) throw new ImageInputError("当前环境无法定位活动画面。");
        if (target.activity && "search" in target.activity) {
          const lookup = await activity.lookup(
            target.activity.search,
            { maxReadBytes: LOCAL_COGNITION_READ_BUDGET_BYTES },
            active.abort.signal,
          );
          this.#assertToolResultOwner(active, executing);
          const result = await this.#fitVisualLookup(active, executing, lookup);
          this.#assertToolResultOwner(active, executing);
          this.writer.completeItem(item.id, {
            displayOutput: result.summary,
            output: asJsonValue(result),
            status: "completed",
          });
          this.#assertToolResultOwner(active, executing);
          this.#recordToolResult(active, executing, undefined, result);
          return;
        }
        const observation = await activity.current(active.abort.signal);
        this.#assertToolResultOwner(active, executing);
        if (!observation) throw new ImageInputError("当前没有可用的采集画面。");
        source = { activity: observation.reference };
      }
      const prepared = await this.images.prepare(source, active.abort.signal);
      this.#assertToolResultOwner(active, executing);
      active.imageCache.set(imageInputKey(source), prepared);
      const result = imageInspectionResult(
        prepared,
        source,
        prepared.observation,
      );
      this.writer.completeItem(item.id, {
        displayOutput: `${prepared.width} × ${prepared.height} · ${prepared.mediaType}`,
        output: asJsonValue(result),
        status: "completed",
      });
      this.#recordInspectedImage(active, executing, result);
    } catch (error) {
      if (active.abort.signal.aborted) {
        const current = this.runs.getRunItem(item.id);
        if (current?.status === "running")
          this.writer.completeItem(item.id, {
            status: active.interruptRequested ? "interrupted" : "cancelled",
          });
        throw error;
      }
      this.#assertToolResultOwner(active, executing);
      const result = imageInspectionError(error);
      this.writer.completeItem(item.id, {
        displayOutput: toolDisplayOutput(result),
        error: result.error,
        output: asJsonValue(result),
        status: "failed",
      });
      this.#assertToolResultOwner(active, executing);
      this.#recordToolResult(active, executing, undefined, result);
    }
  }

  async #fitVisualLookup(
    active: ActiveRun,
    pending: PendingToolCall,
    lookup: ActivityVisualLookupResult,
  ): Promise<ToolResult> {
    const fits = async (count: number) => {
      const result = visualLookupToolResult(visualLookupPrefix(lookup, count));
      const measured = await this.#measureToolResult(
        active,
        pending,
        undefined,
        result,
      );
      return fitsInputBudget(measured.measurement, measured.inputBudgetTokens);
    };
    // A material read bound protects local memory. Only the complete request
    // decides how many observations can be supplied; continuation retains all
    // unreturned rows, without a fixed topK or a new per-tool token ceiling.
    for (;;) {
      const revision = active.inputRevision;
      if (await fits(lookup.observations.length))
        return visualLookupToolResult(lookup);
      if (!(await fits(0)))
        throw new RangeError("当前上下文无法容纳画面查询及未返回范围说明。");
      let low = 0;
      let high = lookup.observations.length;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (await fits(middle)) low = middle;
        else high = middle;
      }
      // A user correction during allocation changes the actual request. Do
      // not publish a prefix fitted against the previous user input.
      if (revision !== active.inputRevision) continue;
      return visualLookupToolResult(visualLookupPrefix(lookup, low));
    }
  }

  #recordInspectedImage(
    active: ActiveRun,
    pending: PendingToolCall,
    result: ToolResult,
  ): void {
    this.#assertToolResultOwner(active, pending);
    const content = result.modelContent;
    if (
      result.status !== "success" ||
      typeof content !== "object" ||
      content === null ||
      Array.isArray(content) ||
      content["loaded"] !== true
    ) {
      this.#recordToolResult(active, pending, undefined, result);
      return;
    }
    const source = parseImageInputSource(content["source"]);
    const inspectedImageInput = imageMessageReference(
      typeof source === "string"
        ? `Inspect the image loaded from ${source}. Base conclusions on its pixels, not its filename.`
        : `Inspect the retained Activity image captured at ${source.activity.capturedAt}. Its source and coverage are in the preceding Tool result. This is an observation at that time, not proof of the current screen or of what the user read or intended.`,
      [source],
    );
    const next = completedToolState(active.data, pending, undefined, result);
    active.data = {
      ...next,
      // Keep one materialized image at this call's boundary. A later inspect of
      // the same source must survive compaction with its own call and output.
      input: [
        ...next.input.filter(
          (value) => !isDeepStrictEqual(value, inspectedImageInput),
        ),
        inspectedImageInput,
      ],
    };
    this.#mergeSteering(active);
    this.#saveCheckpoint(active, "model");
  }

  async #handleUserInputCall(
    active: ActiveRun,
    call: ModelFunctionCall,
  ): Promise<void> {
    const input = parseUserInputArguments(call.arguments);
    const item = this.writer.startItem(
      active.runId,
      "input_request",
      asJsonValue(input),
    );
    const pending: PendingInputRequest = {
      callId: call.callId,
      itemId: item.id,
      questions: input.questions,
    };
    const withoutAllowedTools = { ...active.data };
    delete withoutAllowedTools.allowedTools;
    active.data = {
      ...withoutAllowedTools,
      boundaries: [],
      handoff: {
        ...active.data.handoff,
        nextSteps: ["等待用户补充信息"],
      },
      pendingInput: pending,
      recoveryAttemptedKeys: [],
    };
    this.#saveCheckpoint(active, "input");
    this.writer.requestInput(item.id);
    const resolution = await this.#awaitUserInput(active, item.id);
    this.#continueAfterUserInput(active, pending, resolution);
  }

  #continueAfterUserInput(
    active: ActiveRun,
    pending: PendingInputRequest,
    resolution: InputRequestResolution,
  ): void {
    active.abort.signal.throwIfAborted();
    active.inputRevision += 1;
    if (resolution.status === "context_available") {
      const receipt = inputRequestOutput(pending.callId, resolution);
      const hasContext = active.data.input.some(
        (value) =>
          isCognitionContextInput(value) &&
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          value["decisionAttemptId"] === resolution.attemptId &&
          isDeepStrictEqual(value["evidenceIds"], resolution.evidenceIds),
      );
      if (
        !hasContext ||
        !active.data.input.some((value) => isDeepStrictEqual(value, receipt))
      ) {
        throw new TypeError(
          "Accepted environment context is missing from the input checkpoint",
        );
      }
      const next = { ...active.data };
      delete next.pendingInput;
      delete next.lastUsage;
      delete next.lastRequestBytes;
      delete next.quietCompletionAllowed;
      active.data = {
        ...next,
        boundaries: [],
        handoff: {
          ...next.handoff,
          currentProgress: [
            ...next.handoff.currentProgress,
            "新的相关内容已到达",
          ],
          nextSteps: [],
        },
        recoveryAttemptedKeys: [],
      };
      this.#saveCheckpoint(active, "model");
      return;
    }
    const checkpointBoundary = { ...active.data };
    delete checkpointBoundary.pendingInput;
    delete checkpointBoundary.quietCompletionAllowed;
    const input = hasToolOutput(active.data.input, pending.callId)
      ? active.data.input
      : [...active.data.input, inputRequestOutput(pending.callId, resolution)];
    const latestUser = userInputSummary(resolution);
    active.data = {
      ...checkpointBoundary,
      boundaries: [],
      handoff: {
        ...checkpointBoundary.handoff,
        currentProgress: [
          ...checkpointBoundary.handoff.currentProgress,
          resolution.status === "answered"
            ? "已收到用户补充信息"
            : "用户取消了补充问题",
        ],
        nextSteps: [],
      },
      input,
      latestUserInput: messageInput(latestUser),
      recentUsers: [...checkpointBoundary.recentUsers, latestUser],
      recoveryAttemptedKeys: [],
    };
    this.#saveCheckpoint(active, "model");
  }

  #awaitUserInput(
    active: ActiveRun,
    itemId: string,
  ): Promise<InputRequestResolution> {
    active.abort.signal.throwIfAborted();
    const current = this.runs.getRunItem(itemId);
    if (current?.status === "completed" && current.output !== undefined) {
      return Promise.resolve(
        parseSchema(InputRequestResolutionSchema, current.output),
      );
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        active.inputWaiters.delete(itemId);
        reject(
          active.abort.signal.reason instanceof Error
            ? active.abort.signal.reason
            : new DOMException("Operation was aborted", "AbortError"),
        );
      };
      active.abort.signal.addEventListener("abort", abort, { once: true });
      active.inputWaiters.set(itemId, (resolution) => {
        active.abort.signal.removeEventListener("abort", abort);
        resolve(resolution);
      });
    });
  }

  #supersedePendingInput(active: ActiveRun, resolvedAt: string): void {
    const pending = active.data.pendingInput;
    if (!pending) return;
    const item = this.runs.getRunItem(pending.itemId);
    if (item?.status !== "waiting_input") return;
    // The free-text message remains a user message; it is not an invented
    // answer to one of the old question's options.
    const resolution: UserInputResolution = { status: "cancelled", resolvedAt };
    this.writer.resolveInput(item.id, resolution);
    active.inputWaiters.get(item.id)?.(resolution);
    active.inputWaiters.delete(item.id);
  }

  #supersedePendingApproval(active: ActiveRun, decidedAt: string): void {
    const approvalId = active.data.pendingTool?.approvalId;
    if (!approvalId) return;
    const approval = this.runs.getApproval(approvalId);
    if (approval?.status !== "pending") return;
    this.writer.resolveApproval({
      ...approval,
      decidedAt,
      decisionReason: "收到新消息，原动作未执行，需要重新决定。",
      status: "cancelled",
    });
    active.waiters.get(approvalId)?.("rejected");
    active.waiters.delete(approvalId);
  }

  #skipSupersededCall(active: ActiveRun, call: ModelFunctionCall): void {
    const name = this.#resolveToolName(active, call);
    const modelContent = {
      code: "TOOL.INPUT_CHANGED",
      message:
        "Not executed: input changed after this call was proposed. Reconsider the next action using the latest actual input and context; do not assume this call succeeded.",
    };
    const result: ToolResult = {
      artifacts: [],
      evidenceHash: toolEvidenceHash(modelContent),
      modelContent,
      retryable: false,
      status: "rejected",
      summary: "输入已更新，原调用未执行",
    };
    const item = this.writer.startItem(active.runId, "tool_call", {
      arguments: call.arguments,
      toolName: name,
    });
    this.writer.completeItem(item.id, {
      displayOutput: result.summary,
      output: asJsonValue(result),
      status: "cancelled",
    });
    this.#recordToolResult(
      active,
      {
        arguments: call.arguments,
        callId: call.callId,
        name,
        rawItem: call.rawItem,
      },
      active.tools.get(name)?.descriptor,
      result,
    );
  }

  async #continueAfterApproval(
    active: ActiveRun,
    pending: PendingToolCall,
    decision: ApprovalDecision,
  ): Promise<void> {
    const approval = pending.approvalId
      ? this.runs.getApproval(pending.approvalId)
      : undefined;
    const superseded = approval?.status === "cancelled";
    if (pending.approvalItemId) {
      const item = this.runs.getRunItem(pending.approvalItemId);
      if (item?.status === "waiting_approval" || item?.status === "running") {
        this.writer.completeItem(item.id, {
          output: {
            decision: superseded ? "cancelled" : decision,
            reason: approval?.decisionReason ?? null,
          },
          status: superseded ? "cancelled" : "completed",
        });
      }
    }
    const checkpointBoundary = { ...active.data };
    delete checkpointBoundary.allowedTools;
    delete checkpointBoundary.pendingTool;
    active.data = {
      ...checkpointBoundary,
      handoff: {
        ...active.data.handoff,
        decisions: [
          ...active.data.handoff.decisions,
          `${pending.name}: ${superseded ? "cancelled" : decision}`,
        ],
        nextSteps: [],
      },
    };
    if (superseded || active.steering.length > 0) {
      this.#skipSupersededCall(active, {
        arguments: pending.arguments,
        callId: pending.callId,
        name: pending.name,
        rawItem: pending.rawItem,
      });
      return;
    }
    if (decision === "rejected") {
      this.#recordToolResult(
        active,
        pending,
        active.tools.get(pending.name)?.descriptor,
        rejectedToolResult(approval?.decisionReason),
      );
      return;
    }
    const definition = active.tools.get(pending.name);
    if (!definition) {
      this.#recordToolResult(
        active,
        pending,
        undefined,
        unexpectedToolResult(new TypeError(`Unknown Tool: ${pending.name}`)),
      );
      return;
    }
    await this.#executeTool(active, pending, definition);
  }

  async #executeTool(
    active: ActiveRun,
    pending: PendingToolCall,
    definition: ToolDefinition,
  ): Promise<void> {
    const item = this.writer.startItem(
      active.runId,
      definition.descriptor.itemKind,
      definition.descriptor.itemKind === "plan" ||
        definition.descriptor.itemKind === "subtask"
        ? asJsonValue(pending.arguments)
        : {
            arguments: pending.arguments,
            callId: pending.callId,
            toolName: pending.name,
          },
    );
    const executing = { ...pending, toolItemId: item.id };
    const checkpointBoundary = { ...active.data };
    delete checkpointBoundary.allowedTools;
    delete checkpointBoundary.pendingTool;
    active.data = {
      ...checkpointBoundary,
      handoff: {
        ...active.data.handoff,
        nextSteps: [definition.summarize(pending.arguments)],
      },
      pendingTool: executing,
    };
    this.#saveCheckpoint(active, "tool");
    let result: ToolResult;
    let pendingDelta = "";
    const flushDelta = () => {
      if (!pendingDelta) return;
      this.writer.appendDelta(active.runId, item.id, { text: pendingDelta });
      pendingDelta = "";
    };
    const deltaBatcher = new RunDeltaBatcher(flushDelta);
    try {
      result = await active.tools.execute(pending.name, pending.arguments, {
        availableToolNames: this.#availableTools(active).map(
          ({ descriptor }) => descriptor.name,
        ),
        itemId: item.id,
        measureResult: (result) =>
          this.#measureToolResult(
            active,
            executing,
            definition.descriptor,
            result,
          ),
        onDelta: (delta) => {
          pendingDelta += delta;
          deltaBatcher.schedule();
        },
        providerProfileId: this.#requireRun(active.runId).provider.profileId,
        runId: active.runId,
        signal: active.abort.signal,
      });
      deltaBatcher.flush();
    } catch (error) {
      deltaBatcher.flush();
      if (active.abort.signal.aborted) {
        result = cancelledToolResult();
      } else {
        result = unexpectedToolResult(error);
      }
    }
    this.writer.completeItem(item.id, {
      artifacts: result.artifacts,
      displayOutput: toolDisplayOutput(result, pending.name),
      ...(result.error === undefined ? {} : { error: result.error }),
      output: asJsonValue(result),
      status:
        result.status === "success"
          ? "completed"
          : result.status === "cancelled"
            ? active.interruptRequested
              ? "interrupted"
              : "cancelled"
            : "failed",
    });
    if (active.abort.signal.aborted && active.interruptRequested) {
      active.abort.signal.throwIfAborted();
    }
    this.#recordToolResult(active, executing, definition.descriptor, result);
    if (active.abort.signal.aborted) active.abort.signal.throwIfAborted();
  }

  #recordToolResult(
    active: ActiveRun,
    pending: PendingToolCall,
    descriptor: ToolDescriptor | undefined,
    result: ToolResult,
  ): void {
    let next = completedToolState(active.data, pending, descriptor, result);
    if (result.status !== "success" && result.status !== "rejected") {
      let boundaries = active.data.boundaries;
      let allowedTools = active.data.allowedTools;
      let recoveryAttemptedKeys = active.data.recoveryAttemptedKeys;
      let input = next.input;
      boundaries = [
        ...boundaries,
        {
          retryable: result.retryable,
          signature: semanticToolSignature(
            pending.name,
            descriptor?.effect ?? "read",
            pending.arguments,
            result,
          ),
          toolName: pending.name,
        },
      ];
      const cycle = detectToolCycle(boundaries);
      if (cycle) {
        const candidates = descriptor
          ? active.tools
              .recoveryCandidates(pending.name)
              .filter(({ descriptor: candidate }) =>
                this.#toolAvailable(active, candidate.name),
              )
          : [];
        const recoveryKey = descriptor?.recoveryGroup
          ? `candidate:${descriptor.recoveryGroup}`
          : `candidate:${pending.name}`;
        const retryKey = `retry:${pending.name}`;
        if (
          candidates.length > 0 &&
          !recoveryAttemptedKeys.includes(recoveryKey)
        ) {
          recoveryAttemptedKeys = [...recoveryAttemptedKeys, recoveryKey];
          input = [
            ...input,
            developerInput(
              `No semantic progress was observed for ${pending.name}. Use one of these independent recovery capabilities if it can advance the same goal: ${candidates
                .map(({ descriptor: candidate }) => candidate.name)
                .join(
                  ", ",
                )}. Do not repeat the registered failing operation unchanged.`,
            ),
          ];
          allowedTools = candidates.map(({ descriptor: candidate }) => ({
            name: candidate.name,
            namespace: candidate.namespace,
          }));
        } else if (
          descriptor &&
          result.retryable &&
          descriptor.effect === "read" &&
          descriptor.idempotency === "idempotent" &&
          !recoveryAttemptedKeys.includes(retryKey)
        ) {
          recoveryAttemptedKeys = [...recoveryAttemptedKeys, retryKey];
          input = [
            ...input,
            developerInput(
              `The idempotent read operation ${pending.name} has repeated without progress. One bounded recovery attempt is allowed only with a materially changed argument or a new observation; otherwise report the limitation honestly.`,
            ),
          ];
          allowedTools = [
            { name: descriptor.name, namespace: descriptor.namespace },
          ];
        } else {
          throw new GuardTerminalError({
            code: "AGENT.NO_PROGRESS",
            details: {
              cycle: cycle.key,
              period: cycle.period,
              toolName: pending.name,
            },
            message: "重复操作没有产生新进展，且没有合法的恢复能力。",
            retryable: false,
          });
        }
      }
      next = {
        ...next,
        input,
        boundaries,
        recoveryAttemptedKeys,
        ...(allowedTools === undefined ? {} : { allowedTools }),
      };
    }
    active.data = next;
    this.#mergeSteering(active);
    this.#saveCheckpoint(active, "model");
  }

  async #resumePendingBoundary(
    active: ActiveRun,
    phase: CheckpointPhase,
  ): Promise<boolean> {
    const pending = active.data.pendingTool;
    if (!pending) return true;
    if (phase === "approval" && pending.approvalId) {
      if (active.steering.length > 0) {
        this.#supersedePendingApproval(active, this.clock.now());
      }
      const approval = this.runs.getApproval(pending.approvalId);
      if (!approval) {
        throw new GuardTerminalError({
          code: "AGENT.APPROVAL_LOST",
          message: "恢复时找不到原审批边界。",
          retryable: false,
        });
      }
      const decision =
        approval.status === "pending"
          ? await this.#awaitApproval(active, approval.id)
          : approval.status === "approved"
            ? "approved"
            : "rejected";
      await this.#continueAfterApproval(active, pending, decision);
      return true;
    }

    if (phase === "tool" && pending.toolItemId) {
      const item = this.runs.getRunItem(pending.toolItemId);
      if (
        (item?.status === "completed" || item?.status === "failed") &&
        item.output
      ) {
        const result = parseSchema(ToolResultSchema, item.output);
        if (pending.name === IMAGE_INSPECT_TOOL_NAME) {
          this.#recordInspectedImage(active, pending, result);
          return true;
        }
        this.#recordToolResult(
          active,
          pending,
          active.tools.get(pending.name)?.descriptor,
          result,
        );
        return true;
      }
      if (pending.name === IMAGE_INSPECT_TOOL_NAME) {
        if (item?.status === "running")
          this.writer.completeItem(item.id, { status: "interrupted" });
        await this.#handleImageInspectCall(active, {
          name: IMAGE_INSPECT_TOOL_NAME,
          callId: pending.callId,
          arguments: pending.arguments,
          rawItem: pending.rawItem,
        });
        return true;
      }
      const definition = active.tools.get(pending.name);
      if (!definition) {
        throw new GuardTerminalError({
          code: "AGENT.TOOL_UNAVAILABLE",
          message: `恢复时能力 ${pending.name} 已不可用。`,
          retryable: false,
        });
      }
      if (definition.descriptor.idempotency === "non_idempotent") {
        this.writer.transition(active.runId, "needs_input", {
          code: "AGENT.SIDE_EFFECT_UNKNOWN",
          details: { itemId: pending.toolItemId, toolName: pending.name },
          message:
            "中断发生在不可重复执行的动作边界，无法确认动作是否已生效；请检查实际状态后再发起下一步。",
          retryable: false,
        });
        return false;
      }
      const retryablePending = { ...pending };
      delete retryablePending.toolItemId;
      await this.#executeTool(active, retryablePending, definition);
    }
    return true;
  }

  async #resumeInputBoundary(active: ActiveRun): Promise<void> {
    const pending = active.data.pendingInput;
    if (!pending) {
      throw new GuardTerminalError({
        code: "AGENT.INPUT_LOST",
        message: "恢复时找不到原补充问题边界。",
        retryable: false,
      });
    }
    const item = this.runs.getRunItem(pending.itemId);
    if (!item || item.kind !== "input_request") {
      throw new GuardTerminalError({
        code: "AGENT.INPUT_LOST",
        message: "恢复时找不到原补充问题。",
        retryable: false,
      });
    }
    if (item.status === "running") this.writer.requestInput(item.id);
    if (active.steering.length > 0) {
      this.#supersedePendingInput(active, this.clock.now());
    }
    if (
      item.status !== "running" &&
      item.status !== "waiting_input" &&
      item.status !== "completed"
    ) {
      throw new GuardTerminalError({
        code: "AGENT.INPUT_LOST",
        message: "原补充问题已无法继续。",
        retryable: false,
      });
    }
    const resolution = await this.#awaitUserInput(active, item.id);
    this.#continueAfterUserInput(active, pending, resolution);
  }

  #awaitApproval(
    active: ActiveRun,
    approvalId: string,
  ): Promise<ApprovalDecision> {
    active.abort.signal.throwIfAborted();
    const current = this.runs.getApproval(approvalId);
    if (current?.status === "approved" || current?.status === "rejected") {
      return Promise.resolve(current.status);
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        active.waiters.delete(approvalId);
        const approval = this.runs.getApproval(approvalId);
        if (approval?.status === "pending" && !active.interruptRequested) {
          this.writer.resolveApproval({
            ...approval,
            decidedAt: this.clock.now(),
            decisionReason: "Run cancelled",
            status: "cancelled",
          });
        }
        reject(
          active.abort.signal.reason instanceof Error
            ? active.abort.signal.reason
            : new DOMException("Operation was aborted", "AbortError"),
        );
      };
      active.abort.signal.addEventListener("abort", abort, { once: true });
      active.waiters.set(approvalId, (decision) => {
        active.abort.signal.removeEventListener("abort", abort);
        resolve(decision);
      });
    });
  }

  #removeStaleCognitionContext(active: ActiveRun, inputRevision: number): void {
    if (!this.cognition || active.cognitionInputRevision === inputRevision)
      return;
    const next = { ...active.data };
    delete next.lastUsage;
    delete next.lastRequestBytes;
    active.data = {
      ...next,
      input: next.input.filter(
        (value) => !isOrdinaryCognitionContextInput(value),
      ),
    };
  }

  #assertToolResultOwner(active: ActiveRun, executing: PendingToolCall): void {
    active.abort.signal.throwIfAborted();
    const pending = active.data.pendingTool;
    if (
      this.#active.get(active.runId) !== active ||
      TERMINAL_STATUSES.has(this.#requireRun(active.runId).status) ||
      pending?.callId !== executing.callId ||
      pending.toolItemId !== executing.toolItemId
    ) {
      throw new DOMException(
        "Tool result owner is no longer active",
        "AbortError",
      );
    }
  }

  async #measureToolResult(
    active: ActiveRun,
    executing: PendingToolCall,
    descriptor: ToolDescriptor | undefined,
    result: ToolResult,
  ): Promise<ToolResultContextMeasurement> {
    if (result.status !== "success")
      throw new TypeError("Only successful Tool candidates can be allocated");
    for (;;) {
      this.#assertToolResultOwner(active, executing);
      this.#mergeSteering(active);
      const revision = active.inputRevision;
      this.#removeStaleCognitionContext(active, revision);
      const projected = completedToolState(
        active.data,
        executing,
        descriptor,
        result,
      );
      // Keep every real call, including later calls with unknown results. This
      // measures known work only; the next actual request is still fully guarded.
      const input = (await materializeModelInput(
        projected.input as JsonValue,
        this.images,
        active.imageCache,
        active.abort.signal,
      )) as JsonValue[];
      this.#assertToolResultOwner(active, executing);
      if (revision !== active.inputRevision) continue;
      const request = this.#modelRequest(
        this.#requireRun(active.runId),
        input,
        projected,
        active.limits,
        active.tools,
      );
      const measurement = await active.provider.measureInput(
        request,
        active.abort.signal,
      );
      this.#assertToolResultOwner(active, executing);
      if (revision !== active.inputRevision) continue;
      return {
        kind: "responses_request",
        measurement,
        inputBudgetTokens: modelInputBudget(
          active.limits,
          request.maxOutputTokens,
        ),
      };
    }
  }

  async #refreshCognitionContext(
    active: ActiveRun,
    inputRevision: number,
  ): Promise<void> {
    if (active.cognitionInputRevision === inputRevision) return;
    if (!this.cognition) {
      active.cognitionInputRevision = inputRevision;
      return;
    }
    const signal = active.abort.signal;
    const run = this.#requireRun(active.runId);
    const materialized = (await materializeModelInput(
      active.data.input as JsonValue,
      this.images,
      active.imageCache,
      active.abort.signal,
    )) as JsonValue[];
    signal.throwIfAborted();
    if (inputRevision !== active.inputRevision) return;
    const shell = await active.provider.measureInput(
      this.#modelRequest(
        run,
        materialized,
        active.data,
        active.limits,
        active.tools,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (inputRevision !== active.inputRevision) return;
    const maxTokens = cognitionContextTokenHeadroom(shell, active.limits);
    const minimumFrame = estimatedCognitionContextTokens({
      text: "",
      situationIds: [],
      intentIds: [],
      evidenceIds: [],
    });
    const context =
      maxTokens >= minimumFrame
        ? await this.cognition.prepareTurn({
            personaId: run.persona.personaId,
            chatId: run.chatId,
            currentInput: active.data.recentUsers.at(-1) ?? "",
            contextBudget: { maxTokens },
            resourceBudget: { maxReadBytes: LOCAL_COGNITION_READ_BUDGET_BYTES },
            signal,
          })
        : undefined;
    signal.throwIfAborted();
    if (inputRevision !== active.inputRevision) return;
    if (context && (context.text || context.evidencePack)) {
      active.data = {
        ...active.data,
        input: [createCognitionContextInput(context), ...active.data.input],
      };
    }
    active.cognitionInputRevision = inputRevision;
  }

  async #compactChatContextForFirstRequest(
    active: ActiveRun,
  ): Promise<boolean> {
    const run = this.#requireRun(active.runId);
    const currentInput = active.data.currentUserInput;
    if (!currentInput) return false;
    const latestInput = active.data.latestUserInput;
    const preservedUserInput = [
      currentInput,
      ...(latestInput &&
      JSON.stringify(latestInput) !== JSON.stringify(currentInput)
        ? [latestInput]
        : []),
    ];
    const memoryContexts = retainedCognitionContextInputs(active.data.input);
    const toolContexts = retainedToolContextInputs(active.data.input);
    const beforeBytes = Buffer.byteLength(
      JSON.stringify(active.data.input),
      "utf8",
    );
    const projection = await this.#chatContext.prepare({
      additionalInput: [
        ...memoryContexts,
        ...toolContexts,
        ...preservedUserInput,
      ],
      chatId: run.chatId,
      force: true,
      limits: active.limits,
      modelId: run.provider.modelId,
      provider: active.provider,
      measureInput: async (input, options) => {
        active.abort.signal.throwIfAborted();
        const materialized = await materializeModelInput(
          input as JsonValue,
          this.images,
          active.imageCache,
          active.abort.signal,
        );
        active.abort.signal.throwIfAborted();
        return active.provider.measureInput(
          this.#modelRequest(
            run,
            materialized as JsonValue[],
            active.data,
            active.limits,
            active.tools,
          ),
          active.abort.signal,
          options,
        );
      },
      signal: active.abort.signal,
    });
    active.abort.signal.throwIfAborted();
    if (!projection.compacted) return false;

    const withoutUsage = { ...active.data };
    delete withoutUsage.lastRequestBytes;
    delete withoutUsage.lastUsage;
    active.data = {
      ...withoutUsage,
      input: [
        ...projection.input,
        ...memoryContexts,
        ...toolContexts,
        ...preservedUserInput,
      ],
      recentUsers: active.data.recentUsers.slice(-1),
    };
    const afterBytes = Buffer.byteLength(
      JSON.stringify(active.data.input),
      "utf8",
    );
    const item = this.writer.startItem(active.runId, "context_compaction", {
      beforeBytes,
      scope: "chat",
    });
    this.writer.completeItem(item.id, {
      displayOutput: "已整理较早会话内容，并保留当前目标与长期记忆。",
      output: {
        afterBytes,
        beforeBytes,
        chatContextGeneration: projection.snapshot?.generation ?? 0,
      },
      status: "completed",
    });
    this.#saveCheckpoint(active, "model");
    return true;
  }

  async #compact(
    active: ActiveRun,
    force: boolean,
    previousRequest?: ModelRequest,
  ): Promise<boolean> {
    let compiledModelInput: JsonValue | undefined;
    const compiled = await this.contextCompiler.compile(
      {
        ...(active.data.currentPlan === undefined
          ? {}
          : { currentPlan: active.data.currentPlan }),
        ...(active.data.currentUserInput === undefined
          ? {}
          : { currentUserInput: active.data.currentUserInput }),
        items: active.data.input,
        ...(active.data.latestUserInput === undefined
          ? {}
          : { latestUserInput: active.data.latestUserInput }),
        ...(active.data.lastRequestBytes === undefined
          ? {}
          : { lastRequestBytes: active.data.lastRequestBytes }),
        ...(active.data.lastUsage === undefined
          ? {}
          : { lastUsage: active.data.lastUsage }),
        recentUsers: active.data.recentUsers,
      },
      active.limits,
      active.data.handoff,
      force,
      async (input, options) => {
        active.abort.signal.throwIfAborted();
        const materialized = await materializeModelInput(
          input as JsonValue,
          this.images,
          active.imageCache,
          active.abort.signal,
        );
        active.abort.signal.throwIfAborted();
        compiledModelInput = materialized;
        return active.provider.measureInput(
          this.#modelRequest(
            this.#requireRun(active.runId),
            materialized as JsonValue[],
            active.data,
            active.limits,
            active.tools,
          ),
          active.abort.signal,
          options,
        );
      },
    );
    active.abort.signal.throwIfAborted();
    const changed =
      compiled.compacted && this.#applyCompaction(active, compiled.input);
    // Persist changed Plan/input state even without byte reduction, but do not
    // resend a rejected request when only checkpoint metadata changed.
    return (
      changed &&
      (!previousRequest ||
        !isDeepStrictEqual(previousRequest.input, compiledModelInput))
    );
  }

  #applyCompaction(active: ActiveRun, input: readonly JsonValue[]): boolean {
    if (isDeepStrictEqual(active.data.input, input)) return false;
    const beforeBytes = Buffer.byteLength(
      JSON.stringify(active.data.input),
      "utf8",
    );
    const afterBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    const item =
      afterBytes < beforeBytes
        ? this.writer.startItem(active.runId, "context_compaction", {
            beforeBytes,
          })
        : undefined;
    const withoutUsage = { ...active.data };
    delete withoutUsage.lastUsage;
    active.data = {
      ...withoutUsage,
      input,
      lastRequestBytes: afterBytes,
      recentUsers: active.data.recentUsers.slice(-1),
    };
    if (item)
      this.writer.completeItem(item.id, {
        displayOutput:
          "已整理较早上下文，并保留当前计划、进度、决定、约束与下一步。",
        output: { afterBytes, beforeBytes },
        status: "completed",
      });
    this.#saveCheckpoint(active, "model");
    return true;
  }

  #mergeSteering(active: ActiveRun): void {
    if (active.steering.length === 0) return;
    const steering = active.steering.splice(0);
    const contents = steering.map(({ content }) => content);
    // Taking over a Run also removes its original quiet-life permission,
    // including when these user messages were restored after a crash.
    const next = { ...active.data };
    delete next.quietCompletionAllowed;
    active.data = {
      ...next,
      handoff: {
        ...active.data.handoff,
        constraints: [
          ...active.data.handoff.constraints,
          ...contents.map((content) => `Latest user steering: ${content}`),
        ],
      },
      input: [
        ...active.data.input,
        ...contents.map((content) => messageInput(content)),
      ],
      latestUserInput: messageInput(contents.at(-1) ?? ""),
      recentUsers: [...active.data.recentUsers, ...contents],
    };
  }

  #queueSteering(active: ActiveRun, run: Run, request: SteerRunRequest): void {
    const message = this.chats.insertMessage({
      chatId: run.chatId,
      content: request.content,
      createdAt: request.requestedAt,
      id: this.ids.generate(),
      role: "user",
      runId: run.id,
      status: "completed",
      updatedAt: request.requestedAt,
    });
    const item = this.writer.startItem(run.id, "user_message", {
      content: request.content,
      messageId: message.id,
      steering: true,
    });
    this.writer.completeItem(item.id, {
      output: { messageId: message.id },
      status: "completed",
    });
    active.steering.push({ content: request.content });
    active.inputRevision += 1;
    for (const resolve of active.steeringWaiters) resolve();
    active.steeringWaiters.clear();
  }

  #awaitSteering(active: ActiveRun): Promise<void> {
    if (active.steering.length > 0) return Promise.resolve();
    active.abort.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const steer = () => {
        active.abort.signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        active.steeringWaiters.delete(steer);
        reject(
          active.abort.signal.reason instanceof Error
            ? active.abort.signal.reason
            : new DOMException("Operation was aborted", "AbortError"),
        );
      };
      active.steeringWaiters.add(steer);
      active.abort.signal.addEventListener("abort", abort, { once: true });
    });
  }

  #saveCheckpoint(active: ActiveRun, phase: CheckpointPhase): void {
    this.#mergeSteering(active);
    const run = this.#requireRun(active.runId);
    active.generation += 1;
    this.checkpoints.save({
      context: checkpointJson(active.data),
      generation: active.generation,
      lastCompletedSequence: run.latestSequence,
      phase,
      runId: active.runId,
      updatedAt: this.clock.now(),
    });
  }

  #resolveToolName(active: ActiveRun, call: ModelFunctionCall): string {
    if (active.tools.get(call.name)) return call.name;
    const namespaced = call.namespace
      ? `${call.namespace}.${call.name}`
      : call.name;
    return active.tools.get(namespaced) ? namespaced : call.name;
  }

  #handleDriveFailure(active: ActiveRun, error: unknown): void {
    const run = this.runs.getRun(active.runId);
    if (!run || TERMINAL_STATUSES.has(run.status)) return;
    if (active.abort.signal.aborted) {
      // Quit releases the in-memory waiter; a durable question or approval is
      // still pending and will be restored by the next Runtime instance.
      if (
        active.interruptRequested &&
        (run.status === "needs_input" || run.status === "waiting_approval")
      )
        return;
      const pendingInput = active.data.pendingInput;
      if (pendingInput) {
        const inputItem = this.runs.getRunItem(pendingInput.itemId);
        if (
          inputItem?.status === "running" ||
          inputItem?.status === "waiting_input"
        ) {
          this.writer.completeItem(inputItem.id, {
            status: active.interruptRequested ? "interrupted" : "cancelled",
          });
        }
      }
      const pending = active.data.pendingTool;
      if (pending?.approvalItemId) {
        const approvalItem = this.runs.getRunItem(pending.approvalItemId);
        if (
          approvalItem?.status === "running" ||
          approvalItem?.status === "waiting_approval"
        ) {
          this.writer.completeItem(approvalItem.id, {
            status: active.interruptRequested ? "interrupted" : "cancelled",
          });
        }
      }
      if (active.interruptRequested) {
        this.#saveCheckpoint(active, "interrupted");
        this.writer.transition(
          active.runId,
          "interrupted",
          active.interruptionError ?? {
            code: "AGENT.APP_INTERRUPTED",
            message: "应用退出中断了当前边界，可稍后继续。",
            retryable: true,
          },
        );
      } else {
        this.writer.transition(active.runId, "cancelled");
        this.checkpoints.delete(active.runId);
      }
      return;
    }
    if (error instanceof GuardTerminalError) {
      this.writer.transition(active.runId, "failed", error.appError);
      return;
    }
    if (error instanceof ProviderError) {
      if (error.retryable) this.#saveCheckpoint(active, "interrupted");
      this.writer.transition(
        active.runId,
        error.retryable ? "interrupted" : "failed",
        toProviderAppError(error),
      );
      return;
    }
    this.#saveCheckpoint(active, "interrupted");
    this.writer.transition(active.runId, "failed", {
      code: "AGENT.RUNTIME_FAILED",
      message: error instanceof Error ? error.message : "Agent 运行失败。",
      retryable: false,
    });
  }

  #requireRun(runId: string): Run {
    const run = this.runs.getRun(runId);
    if (!run) {
      throw new AgentError("AGENT.RUN_NOT_FOUND", "Run 不存在。", false);
    }
    return run;
  }
}
