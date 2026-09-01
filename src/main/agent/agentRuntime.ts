import type {
  ApprovalDecision,
  ApprovalNavigationTarget,
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
  PlanUpdate,
  RequestUserInputArguments,
  Run,
  RunCancelRequest,
  RunCancelResult,
  UserInputResolution,
} from "../../shared/contracts/run";
import type { ToolDefinition, ToolRegistry } from "../tools/toolRegistry";
import type { ToolDescriptor, ToolResult } from "../../shared/contracts/tool";
import { ToolResultSchema } from "../../shared/schemas/tool";
import {
  PlanUpdateSchema,
  RequestUserInputArgumentsSchema,
  UserInputResolutionSchema,
} from "../../shared/schemas/run";
import { parseSchema } from "../../shared/schemas/validation";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { redactText } from "../../shared/pure/redaction";
import type { ChatRepository } from "../chat/chatRepository";
import type { ChatService } from "../chat/chatService";
import type { ChatTitleGenerator } from "../chat/chatTitleService";
import { ACTIVITY_SEARCH_TOOL_NAME } from "../activity/activityTool";
import type { MemoryService } from "../memory/memoryService";
import {
  MEMORY_FORMATION_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME,
} from "../memory/memoryTool";
import { COMPANIONSHIP_UPDATE_TOOL_NAME } from "../journey/companionshipTool";
import { IMPORTANT_MOMENT_OUTREACH_TOOL_NAME } from "../journey/importantMomentOutreachTool";
import type { ChatModelRuntime } from "../providers/providerService";
import { ProviderError, toProviderAppError } from "../providers/providerError";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { CheckpointPhase } from "./checkpointRepository";
import type { CheckpointRepository } from "./checkpointRepository";
import { ContextCompiler, isCurrentPlanContextInput } from "./contextCompiler";
import {
  collectModelTurn,
  supportsStrictToolSchema,
  type CollectedModelTurn,
  type ModelAllowedTool,
  type ModelContextLimits,
  type ModelFunctionCall,
  type ModelFunctionTool,
  type ModelProvider,
  type ModelToolNamespace,
} from "./modelProvider";
import { detectToolCycle, semanticToolSignature } from "./loopGuard";
import { requiresApproval, toolAllowedInExecution } from "./approvalPolicy";
import { AgentError } from "./agentError";
import { ChatContextService } from "./chatContextService";
import {
  ImageInputError,
  type ImageInputProvider,
  type PreparedImageInput,
} from "./imageInput";
import {
  createMemoryContextInput,
  isMemoryContextInput,
  materializeMemoryContextInput,
} from "./memoryContext";
import { TEXT_AGENT_BASE_INSTRUCTIONS } from "./agentInstructions";
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
  "file.list",
  "file.read",
  "file.search",
  "file.write",
  "file.patch",
  "file.trash",
  "command.run",
  "plan.update",
  MEMORY_FORMATION_TOOL_NAME,
  COMPANIONSHIP_UPDATE_TOOL_NAME,
  IMPORTANT_MOMENT_OUTREACH_TOOL_NAME,
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
const IMAGE_REFERENCE_TYPE = "charamate_image_reference";
const IMAGE_INSPECT_ALLOWED_TOOL = {
  name: IMAGE_INSPECT_TOOL_NAME,
  namespace: IMAGE_INSPECT_NAMESPACE,
} as const;
const IMAGE_INSPECT_TOOL: ModelFunctionTool = {
  deferLoading: false,
  description:
    "Load the real pixels of a known local image or image artifact into the next model turn.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      path: {
        description:
          "Absolute path, workspace-relative path, or artifact storage key",
        minLength: 1,
        type: "string",
      },
    },
    required: ["path"],
    type: "object",
  },
  name: IMAGE_INSPECT_TOOL_NAME,
  namespace: IMAGE_INSPECT_NAMESPACE,
  strict: true,
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

interface ActiveRun {
  readonly abort: AbortController;
  data: RuntimeCheckpointState;
  generation: number;
  readonly imageCache: Map<string, PreparedImageInput>;
  readonly limits: ModelContextLimits;
  readonly provider: ModelProvider;
  readonly runId: string;
  readonly steering: PendingSteering[];
  readonly steeringWaiters: Set<() => void>;
  readonly tools: ToolRegistry;
  interruptRequested: boolean;
  interruptionError?: AppError;
  task?: Promise<void>;
  readonly inputWaiters: Map<string, (resolution: UserInputResolution) => void>;
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
  sources: readonly string[],
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

async function materializeModelInput(
  value: JsonValue,
  images: ImageInputProvider | undefined,
  cache: Map<string, PreparedImageInput>,
): Promise<JsonValue> {
  if (Array.isArray(value)) {
    const materialized: JsonValue[] = [];
    for (const item of value) {
      materialized.push(await materializeModelInput(item, images, cache));
    }
    return materialized;
  }
  if (typeof value !== "object" || value === null) return value;
  if (isMemoryContextInput(value)) {
    return materializeMemoryContextInput(value);
  }
  if (value["type"] === IMAGE_REFERENCE_TYPE) {
    const source = value["source"];
    if (typeof source !== "string" || !source || !images) {
      throw new ImageInputError("图片引用已失效，无法恢复真实像素。");
    }
    let prepared = cache.get(source);
    if (!prepared) {
      prepared = await images.prepare(source);
      cache.set(source, prepared);
    }
    return prepared.content;
  }
  const materialized: Record<string, JsonValue> = {};
  for (const [name, nested] of Object.entries(value)) {
    materialized[name] = await materializeModelInput(nested, images, cache);
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

function userInputOutput(
  callId: string,
  resolution: UserInputResolution,
): JsonValue {
  return {
    call_id: callId,
    output: JSON.stringify(resolution),
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

function imagePath(value: Readonly<Record<string, JsonValue>>): string {
  if (Object.keys(value).some((name) => name !== "path")) {
    throw new TypeError("image.inspect accepts only path");
  }
  const path = value["path"];
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new TypeError("image.inspect path must be a non-empty string");
  }
  return path;
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
    toolName === MEMORY_SEARCH_TOOL_NAME ||
    toolName === ACTIVITY_SEARCH_TOOL_NAME
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

function imageInspectionResult(image: PreparedImageInput): ToolResult {
  const modelContent = {
    byteLength: image.byteLength,
    height: image.height,
    loaded: true,
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

export class AgentRuntime {
  readonly #active = new Map<string, ActiveRun>();
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
    private readonly memory?: MemoryService,
    chatContext?: ChatContextService,
  ) {
    this.#chatContext = chatContext ?? new ChatContextService(chats, clock);
  }

  async initialize(): Promise<void> {
    for (const run of this.runs.listRunsByStatus([
      "queued",
      "running",
      "waiting_approval",
      "needs_input",
    ])) {
      const checkpoint = this.checkpoints.get(run.id);
      if (
        checkpoint &&
        (run.status === "waiting_approval" || checkpoint.phase === "input")
      ) {
        try {
          const modelRuntime = await this.providers.createChatModelRuntime(
            run.provider.profileId,
            run.provider.modelId,
          );
          const data = decodeRuntimeCheckpoint(checkpoint.context);
          const limits =
            data.contextLimits ??
            (await modelRuntime.provider.resolveContextLimits(
              run.provider.modelId,
            ));
          this.#launch(
            this.#createActiveRun(
              run.id,
              modelRuntime.provider,
              limits,
              data,
              checkpoint.generation,
            ),
            checkpoint.phase,
          );
          continue;
        } catch {
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
  }

  async start(
    request: StartRunRequest,
    options?: { readonly onRunAllocated?: (runId: string) => void },
  ): Promise<Run> {
    return this.#start(
      request,
      await this.providers.createChatModelRuntime(request.providerProfileId),
      this.personas.getActiveSnapshot(),
      undefined,
      true,
      true,
      true,
      undefined,
      options?.onRunAllocated,
    );
  }

  async startAutomation(
    request: StartRunRequest,
    options: {
      readonly modelId: string;
      readonly persona: PersonaSnapshot;
      readonly toolNames?: readonly string[];
    },
  ): Promise<Run> {
    return this.#start(
      request,
      await this.providers.createChatModelRuntime(
        request.providerProfileId,
        options.modelId,
      ),
      options.persona,
      options.toolNames,
    );
  }

  async startAssistantInitiated(
    request: StartRunRequest,
    options: {
      readonly modelId: string;
      readonly onStarted?: (run: Run) => void;
      readonly persona: PersonaSnapshot;
      readonly toolNames?: readonly string[];
    },
  ): Promise<Run> {
    return this.#start(
      request,
      await this.providers.createChatModelRuntime(
        request.providerProfileId,
        options.modelId,
      ),
      options.persona,
      options.toolNames ?? [],
      false,
      false,
      false,
      options.onStarted,
    );
  }

  async startInlineConversation(
    request: StartRunRequest,
    options: { readonly onRunAllocated: (runId: string) => void },
  ): Promise<Run> {
    return this.#start(
      request,
      await this.providers.createChatModelRuntime(request.providerProfileId),
      this.personas.getActiveSnapshot(),
      undefined,
      true,
      false,
      true,
      undefined,
      options.onRunAllocated,
    );
  }

  async #start(
    request: StartRunRequest,
    modelRuntime: ChatModelRuntime,
    persona: PersonaSnapshot,
    toolNames?: readonly string[],
    recordTriggerMessage = true,
    interactionEnabled = true,
    nativeWebSearchEnabled = true,
    onStarted?: (run: Run) => void,
    onRunAllocated?: (runId: string) => void,
  ): Promise<Run> {
    return this.chatTurns.runSerializedTurn(request.chatId, async () => {
      const limits = await modelRuntime.provider.resolveContextLimits(
        modelRuntime.snapshot.modelId,
      );
      const imageAttachments = request.attachments.filter(
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
            preparedImages.push(await this.images.prepare(storageKey));
          }
        } catch (error) {
          throw new AgentError(
            "AGENT.IMAGE_INPUT_INVALID",
            error instanceof ImageInputError
              ? error.message
              : "图片读取失败，请检查文件后重试。",
            false,
          );
        }
      }
      const modelText =
        request.attachments.length === 0
          ? request.content
          : `${request.content}\n\nAttached local artifacts:\n${request.attachments
              .map(({ displayName, kind, storageKey }) =>
                kind === "image"
                  ? `- ${displayName}: image pixels included in this message`
                  : `- ${displayName}: ${storageKey}`,
              )
              .join("\n")}`;
      const currentInput =
        preparedImages.length > 0
          ? imageMessageReference(
              modelText,
              imageAttachments.map(({ storageKey }) => storageKey),
            )
          : messageInput(modelText);
      const memoryContext = this.memory
        ? createMemoryContextInput(this.memory.selectContext(request.content))
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
        signal: new AbortController().signal,
      });
      const now = this.clock.now();
      const runId = this.ids.generate();
      onRunAllocated?.(runId);
      this.writer.startRun({
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
      });

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
        for (const attachment of request.attachments) {
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
          attachmentIds: request.attachments.map(
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
        initialCheckpoint(
          currentInput,
          memoryContext,
          request.content,
          preparedContext.input,
          toolNames,
          interactionEnabled,
          nativeWebSearchEnabled,
        ),
        0,
      );
      imageAttachments.forEach((attachment, index) => {
        const prepared = preparedImages[index];
        if (prepared) state.imageCache.set(attachment.storageKey, prepared);
      });
      this.#saveCheckpoint(state, "model");
      const started = this.#requireRun(runId);
      onStarted?.(started);
      this.#launch(state);
      return started;
    });
  }

  steer(request: SteerRunRequest): { runId: string } {
    const active = this.#active.get(request.runId);
    const run = this.#requireRun(request.runId);
    if (
      !active ||
      (run.status !== "running" && run.status !== "waiting_approval")
    ) {
      throw new AgentError(
        "AGENT.RUN_NOT_ACTIVE",
        "该 Run 当前不能接收追加消息。",
        false,
      );
    }
    this.#queueSteering(active, run, request);
    return { runId: run.id };
  }

  async resume(request: ResumeRunRequest): Promise<{ runId: string }> {
    const run = this.#requireRun(request.runId);
    if (run.source === "voice") {
      throw new AgentError(
        "AGENT.VOICE_SESSION_REQUIRED",
        "这个 Run 需要重新进入语音后继续。",
        false,
      );
    }
    return this.#resume(
      request,
      await this.providers.createChatModelRuntime(
        run.provider.profileId,
        run.provider.modelId,
      ),
    );
  }

  async #resume(
    request: ResumeRunRequest,
    modelRuntime: ChatModelRuntime,
  ): Promise<{ runId: string }> {
    const run = this.#requireRun(request.runId);
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
    const limits =
      data.contextLimits ??
      (await modelRuntime.provider.resolveContextLimits(run.provider.modelId));
    this.writer.resume(run.id);
    const active = this.#createActiveRun(
      run.id,
      modelRuntime.provider,
      limits,
      data,
      checkpoint.generation,
    );
    for (const item of this.runs.listRunItems(run.id)) {
      if (
        item.kind === "user_message" &&
        item.sequence > checkpoint.lastCompletedSequence &&
        typeof item.input === "object" &&
        item.input !== null &&
        !Array.isArray(item.input) &&
        typeof item.input["content"] === "string"
      ) {
        active.steering.push({ content: item.input["content"] });
      }
    }
    this.#launch(active, checkpoint.phase);
    return { runId: run.id };
  }

  async cancel(request: RunCancelRequest): Promise<RunCancelResult> {
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
    active.abort.abort(new DOMException("Run cancelled by user", "AbortError"));
    await active.task;
    return { outcome: "accepted", runId: run.id };
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

  resolveApproval(request: ResolveApprovalRequest): Approval {
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
  }

  async resolveUserInput(request: ResolveUserInputRequest): Promise<Run> {
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
    let active = this.#active.get(run.id);
    let launchAfterResolution = false;
    if (!active) {
      const modelRuntime = await this.providers.createChatModelRuntime(
        run.provider.profileId,
        run.provider.modelId,
      );
      const data = decodeRuntimeCheckpoint(checkpoint.context);
      const limits =
        data.contextLimits ??
        (await modelRuntime.provider.resolveContextLimits(
          run.provider.modelId,
        ));
      active = this.#createActiveRun(
        run.id,
        modelRuntime.provider,
        limits,
        data,
        checkpoint.generation,
      );
      launchAfterResolution = true;
    }
    if (active.data.pendingInput?.itemId !== item.id) {
      throw new AgentError(
        "AGENT.INPUT_NOT_PENDING",
        "补充问题与当前 checkpoint 不一致。",
        false,
      );
    }

    this.writer.resolveInput(item.id, resolution);
    active.inputWaiters.get(item.id)?.(resolution);
    active.inputWaiters.delete(item.id);
    if (launchAfterResolution) this.#launch(active, "input");
    return this.#requireRun(run.id);
  }

  async interruptAll(): Promise<void> {
    const tasks = [...this.#active.values()].flatMap((active) => {
      const status = this.runs.getRun(active.runId)?.status;
      if (status === "waiting_approval" || status === "needs_input") {
        return [];
      }
      return [
        (async () => {
          active.interruptRequested = true;
          active.abort.abort(
            new DOMException("Application is shutting down", "AbortError"),
          );
          await active.task;
        })(),
      ];
    });
    await Promise.allSettled(tasks);
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
      steeringWaiters: new Set(),
      tools: this.tools,
      interruptRequested: false,
      waiters: new Map(),
    };
  }

  #launch(active: ActiveRun, phase: CheckpointPhase = "model"): void {
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
      this.#mergeSteering(active);
      this.#compactIfNeeded(active);
      // Keep the byte baseline in the same persisted-reference representation
      // that ContextCompiler measures. Provider-only image pixels are
      // materialized below and must never inflate the checkpoint.
      const requestBytes = Buffer.byteLength(
        JSON.stringify(active.data.input),
        "utf8",
      );
      const shouldRecordChatUsage =
        active.data.chatContextUsageRecorded !== true;
      const turn = await this.#modelTurn(active);
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
        lastRequestBytes: requestBytes,
        lastUsage: turn.usage,
      };
      if (
        shouldRecordChatUsage &&
        !active.data.input.some(containsImageInput)
      ) {
        const run = this.#requireRun(active.runId);
        this.#chatContext.recordUsage({
          chatId: run.chatId,
          inputTokens: turn.usage.inputTokens,
          modelId: run.provider.modelId,
          requestBytes,
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
        await this.#handleToolCall(active, call);
      }
      const hadSteering = active.steering.length > 0;
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
      if (turn.text.trim()) {
        const completedRun = this.writer.transition(active.runId, "completed");
        this.checkpoints.delete(active.runId);
        await this.#generateFirstTurnTitle(active, completedRun, turn.text);
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

  #availableTools(active: ActiveRun, run = this.#requireRun(active.runId)) {
    return active.tools
      .list()
      .filter(
        (definition) =>
          toolAllowedInExecution(run.execution, definition.descriptor) &&
          this.#toolSelected(active, definition.descriptor.name),
      );
  }

  #toolSelected(active: ActiveRun, name: string): boolean {
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
    return active.tools
      .search(query, active.tools.list().length)
      .filter(({ descriptor }) => available.has(descriptor.name))
      .slice(0, limit);
  }

  async #modelTurn(active: ActiveRun): Promise<CollectedModelTurn> {
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

    try {
      const modelInput = (await materializeModelInput(
        active.data.input as JsonValue,
        this.images,
        active.imageCache,
      )) as JsonValue[];
      const registeredTools = this.#availableTools(active, run);
      const groupedToolNamespaces = groupModelTools(registeredTools);
      const baseToolNamespaces =
        active.data.interactionEnabled === false
          ? groupedToolNamespaces
          : withUserInputTool(groupedToolNamespaces);
      const toolNamespaces =
        run.execution.mode === "agent" &&
        this.images &&
        active.limits.supportsVision !== false &&
        this.#toolSelected(active, IMAGE_INSPECT_TOOL_NAME)
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
        `Current timestamp: ${this.clock.now()}. User system time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}. Interpret relative dates such as today in that time zone.`,
        run.execution.mode === "chat"
          ? "This Run is Chat mode. You may use the provided idempotent read-only query and plan tools. Never perform write, critical, or other external-effect actions; memory.record, companionship.update, and companion.important_moment_outreach are the only internal persistence exceptions. Ask the user to switch explicitly to Agent mode when another action is required."
          : "This Run is Agent mode. Follow its approval decisions and continue after structured rejection when a legitimate alternative exists.",
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
      const allowedTools = active.data.allowedTools
        ? uniqueAllowedTools([
            USER_INPUT_ALLOWED_TOOL,
            ...alwaysLoadedAllowedTools,
            ...(run.execution.mode === "agent" &&
            this.images &&
            active.limits.supportsVision !== false &&
            this.#toolSelected(active, IMAGE_INSPECT_TOOL_NAME)
              ? [IMAGE_INSPECT_ALLOWED_TOOL]
              : []),
            ...active.data.allowedTools,
          ])
        : undefined;
      const events = active.provider.stream(
        {
          ...(allowedTools === undefined ? {} : { allowedTools }),
          input: modelInput,
          instructions,
          ...(active.limits.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: active.limits.maxOutputTokens }),
          modelId: run.provider.modelId,
          nativeWebSearch: active.data.nativeWebSearchEnabled !== false,
          toolNamespaces,
        },
        active.abort.signal,
      );
      const turn = await collectModelTurn(events, (delta) => {
        visibleText += delta;
        pendingDelta += delta;
        deltaBatcher.schedule();
      });
      deltaBatcher.flush();
      const interrupted = turn.status === "cancelled";
      if (message) {
        message = this.chats.updateMessage({
          ...message,
          content: turn.text,
          status: interrupted ? "interrupted" : "completed",
          updatedAt: this.clock.now(),
        });
      }
      this.writer.completeItem(item.id, {
        ...(turn.text ? { displayOutput: turn.text } : {}),
        output: asJsonValue({
          messageId: message?.id ?? null,
          responseId: turn.responseId,
          usage: turn.usage,
        }),
        status: interrupted ? "interrupted" : "completed",
      });
      return turn;
    } catch (error) {
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
        if (!durableCompactionApplied) this.#compact(active, true);
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
    const internalPersistence =
      resolvedName === MEMORY_FORMATION_TOOL_NAME ||
      resolvedName === COMPANIONSHIP_UPDATE_TOOL_NAME ||
      resolvedName === IMPORTANT_MOMENT_OUTREACH_TOOL_NAME;
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
    const run = this.#requireRun(active.runId);
    if (run.execution.mode === "chat") {
      this.#recordToolResult(active, pending, undefined, chatModeToolResult());
      return;
    }
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
    let source: string;
    let prepared: PreparedImageInput;
    try {
      source = imagePath(call.arguments);
      prepared = await this.images.prepare(source);
    } catch (error) {
      const result = imageInspectionError(error);
      this.writer.completeItem(item.id, {
        displayOutput: toolDisplayOutput(result),
        error: result.error,
        output: asJsonValue(result),
        status: "failed",
      });
      this.#recordToolResult(
        active,
        { ...pending, toolItemId: item.id },
        undefined,
        result,
      );
      return;
    }

    const result = imageInspectionResult(prepared);
    const inspectedImageInput = imageMessageReference(
      `Inspect the image loaded from ${source}. Base conclusions on its pixels, not its filename.`,
      [source],
    );
    active.imageCache.set(source, prepared);
    this.writer.completeItem(item.id, {
      displayOutput: `${prepared.width} × ${prepared.height} · ${prepared.mediaType}`,
      output: asJsonValue(result),
      status: "completed",
    });
    const withoutAllowedTools = { ...active.data };
    delete withoutAllowedTools.allowedTools;
    active.data = {
      ...withoutAllowedTools,
      boundaries: [],
      handoff: {
        ...active.data.handoff,
        currentProgress: [
          ...active.data.handoff.currentProgress,
          `${IMAGE_INSPECT_TOOL_NAME}: ${result.summary}`,
        ],
        nextSteps: [],
      },
      input: [
        ...active.data.input,
        toolOutput(call.callId, result),
        inspectedImageInput,
      ],
      latestUserInput: inspectedImageInput,
      recoveryAttemptedKeys: [],
    };
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
    resolution: UserInputResolution,
  ): void {
    const checkpointBoundary = { ...active.data };
    delete checkpointBoundary.pendingInput;
    const input = hasToolOutput(active.data.input, pending.callId)
      ? active.data.input
      : [...active.data.input, userInputOutput(pending.callId, resolution)];
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
  ): Promise<UserInputResolution> {
    active.abort.signal.throwIfAborted();
    const current = this.runs.getRunItem(itemId);
    if (current?.status === "completed" && current.output !== undefined) {
      return Promise.resolve(
        parseSchema(UserInputResolutionSchema, current.output),
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

  async #continueAfterApproval(
    active: ActiveRun,
    pending: PendingToolCall,
    decision: ApprovalDecision,
  ): Promise<void> {
    const approval = pending.approvalId
      ? this.runs.getApproval(pending.approvalId)
      : undefined;
    if (pending.approvalItemId) {
      const item = this.runs.getRunItem(pending.approvalItemId);
      if (item?.status === "waiting_approval" || item?.status === "running") {
        this.writer.completeItem(item.id, {
          output: {
            decision,
            reason: approval?.decisionReason ?? null,
          },
          status: "completed",
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
          `${pending.name}: ${decision}`,
        ],
        nextSteps: [],
      },
    };
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
    const checkpointWithoutPending = { ...active.data };
    delete checkpointWithoutPending.pendingTool;
    const nextInput = hasToolOutput(active.data.input, pending.callId)
      ? active.data.input
      : [...active.data.input, toolOutput(pending.callId, result)];
    let boundaries = active.data.boundaries;
    let allowedTools = active.data.allowedTools;
    let recoveryAttemptedKeys = active.data.recoveryAttemptedKeys;
    let input = nextInput;
    if (result.status === "success" || result.status === "rejected") {
      boundaries = [];
      allowedTools = undefined;
      recoveryAttemptedKeys = [];
    } else {
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
    }
    const planUpdated =
      descriptor?.itemKind === "plan" && result.status === "success";
    if (planUpdated) {
      input = input.filter((item) => !isCurrentPlanContextInput(item));
    }
    const handoff = planUpdated
      ? {
          ...checkpointWithoutPending.handoff,
          nextSteps: [],
        }
      : {
          ...checkpointWithoutPending.handoff,
          currentProgress: [
            ...checkpointWithoutPending.handoff.currentProgress,
            `${pending.name}: ${result.summary}`,
          ],
          nextSteps: [],
        };
    active.data = {
      ...checkpointWithoutPending,
      ...(planUpdated
        ? { currentPlan: parseCurrentPlan(pending.arguments) }
        : {}),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      boundaries,
      handoff,
      input,
      recoveryAttemptedKeys,
    };
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
        this.#recordToolResult(
          active,
          pending,
          active.tools.get(pending.name)?.descriptor,
          result,
        );
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
        if (approval?.status === "pending") {
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

  #compactIfNeeded(active: ActiveRun): void {
    const compiled = this.contextCompiler.compile(
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
    );
    if (compiled.compacted) this.#applyCompaction(active, compiled.input);
  }

  async #compactChatContextForFirstRequest(
    active: ActiveRun,
  ): Promise<boolean> {
    const run = this.#requireRun(active.runId);
    const currentInput = active.data.currentUserInput;
    if (!currentInput) return false;
    const memoryContext = active.data.input.find(isMemoryContextInput);
    const beforeBytes = Buffer.byteLength(
      JSON.stringify(active.data.input),
      "utf8",
    );
    const projection = await this.#chatContext.prepare({
      additionalInput: [
        ...(memoryContext ? [memoryContext] : []),
        currentInput,
      ],
      chatId: run.chatId,
      force: true,
      limits: active.limits,
      modelId: run.provider.modelId,
      provider: active.provider,
      signal: active.abort.signal,
    });
    if (!projection.compacted) return false;

    const withoutUsage = { ...active.data };
    delete withoutUsage.lastRequestBytes;
    delete withoutUsage.lastUsage;
    active.data = {
      ...withoutUsage,
      input: [
        ...projection.input,
        ...(memoryContext ? [memoryContext] : []),
        currentInput,
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

  #compact(active: ActiveRun, force: boolean): void {
    const compiled = this.contextCompiler.compile(
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
    );
    if (compiled.compacted) this.#applyCompaction(active, compiled.input);
  }

  #applyCompaction(active: ActiveRun, input: readonly JsonValue[]): void {
    const beforeBytes = Buffer.byteLength(
      JSON.stringify(active.data.input),
      "utf8",
    );
    const afterBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    const item = this.writer.startItem(active.runId, "context_compaction", {
      beforeBytes,
    });
    const withoutUsage = { ...active.data };
    delete withoutUsage.lastUsage;
    active.data = {
      ...withoutUsage,
      input,
      lastRequestBytes: afterBytes,
      recentUsers: active.data.recentUsers.slice(-1),
    };
    this.writer.completeItem(item.id, {
      displayOutput:
        "已整理较早上下文，并保留当前计划、进度、决定、约束与下一步。",
      output: { afterBytes, beforeBytes },
      status: "completed",
    });
    this.#saveCheckpoint(active, "model");
  }

  #mergeSteering(active: ActiveRun): void {
    if (active.steering.length === 0) return;
    const steering = active.steering.splice(0);
    const contents = steering.map(({ content }) => content);
    active.data = {
      ...active.data,
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
