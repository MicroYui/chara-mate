import type {
  ApprovalDecision,
  ApprovalNavigationTarget,
  ResolveApprovalRequest,
  ResumeRunRequest,
  StartRunRequest,
  SteerRunRequest,
} from "../../shared/contracts/agent";
import type { Message } from "../../shared/contracts/chat";
import type { JsonValue } from "../../shared/contracts/primitives";
import type {
  Approval,
  ArtifactKind,
  Run,
  RunCancelRequest,
  RunCancelResult,
} from "../../shared/contracts/run";
import type { ToolDefinition, ToolRegistry } from "../tools/toolRegistry";
import type { ToolDescriptor, ToolResult } from "../../shared/contracts/tool";
import { ToolResultSchema } from "../../shared/schemas/tool";
import { parseSchema } from "../../shared/schemas/validation";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { redactText } from "../../shared/pure/redaction";
import type { ChatRepository } from "../chat/chatRepository";
import type { ChatService } from "../chat/chatService";
import type { ChatTitleGenerator } from "../chat/chatTitleService";
import type { ChatModelRuntime } from "../providers/providerService";
import { ProviderError, toProviderAppError } from "../providers/providerError";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { CheckpointPhase } from "./checkpointRepository";
import type { CheckpointRepository } from "./checkpointRepository";
import { ContextCompiler } from "./contextCompiler";
import {
  collectModelTurn,
  supportsStrictToolSchema,
  type CollectedModelTurn,
  type ModelContextLimits,
  type ModelFunctionCall,
  type ModelFunctionTool,
  type ModelProvider,
  type ModelToolNamespace,
} from "./modelProvider";
import { detectToolCycle, semanticToolSignature } from "./loopGuard";
import { requiresApproval } from "./approvalPolicy";
import { AgentError } from "./agentError";
import type { RunRepository } from "./runRepository";
import type { RunEventWriter } from "./runEventWriter";
import {
  checkpointJson,
  decodeRuntimeCheckpoint,
  type PendingToolCall,
  type RuntimeCheckpointState,
} from "./runtimeCheckpoint";

const APPROVAL_RUN_LIFETIME = "9999-12-31T23:59:59.999Z";
const BASE_INSTRUCTIONS = `You are CharaMate's single Agent Runtime.
Complete the user's actual goal using the available capabilities. When capabilities are needed, use the native tool search interface and then call only a loaded tool.
Use Provider-native web search for current public information. Use the managed browser for webpage interaction or authenticated state, and macOS Computer only when the managed browser cannot access the needed interface.
Treat every structured Tool Result as an observation: a rejected or failed action is not success. Change strategy when an operation makes no progress, and state honestly when a required result could not be obtained.
For genuinely multi-step Agent work, call the always-loaded plan.update tool directly before other work, keep at most one step in_progress, and send the complete current plan again after meaningful progress. Do not search for plan.update, substitute a prose checklist, create a plan for simple work, or repeat the plan in prose because the product displays it.
Only give a final answer when the user goal is complete or when the remaining limitation is explicit. Never claim that an external action happened without a successful Tool Result.
Visible progress may be concise, but do not expose hidden reasoning.`;

const TERMINAL_STATUSES = new Set<Run["status"]>([
  "needs_input",
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

const ALWAYS_LOADED_CLIENT_TOOLS = new Set(["plan.update"]);

interface ProviderRuntimeFactory {
  createChatModelRuntime(profileId: string): Promise<ChatModelRuntime>;
}

interface PendingSteering {
  readonly content: string;
}

interface ActiveRun {
  readonly abort: AbortController;
  data: RuntimeCheckpointState;
  generation: number;
  readonly limits: ModelContextLimits;
  readonly provider: ModelProvider;
  readonly runId: string;
  readonly steering: PendingSteering[];
  interruptRequested: boolean;
  task?: Promise<void>;
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

function toolDisplayOutput(result: ToolResult): string {
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
      "Chat mode cannot execute capabilities. Explain the limitation or ask the user to switch explicitly to Agent mode.",
  } satisfies JsonValue;
  return {
    artifacts: [],
    error: {
      code: "TOOL.MODE_NOT_ALLOWED",
      message: "Chat 模式不能执行 Tool；请明确切换到 Agent 模式。",
      retryable: false,
    },
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "error",
    summary: "Chat 模式未执行工具",
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

function initialCheckpoint(
  content: string,
  priorMessages: readonly Message[],
): RuntimeCheckpointState {
  return {
    boundaries: [],
    forcedCompactionAttempted: false,
    handoff: {
      constraints: [],
      currentProgress: [],
      decisions: [],
      nextSteps: [],
    },
    input: [
      ...priorMessages
        .filter(
          (message) =>
            message.status === "completed" && message.content.trim().length > 0,
        )
        .map((message): JsonValue => ({
          content: message.content,
          role: message.role,
          type: "message",
        })),
      messageInput(content),
    ],
    recentUsers: [content],
    recoveryAttemptedKeys: [],
    version: 1,
  };
}

export class AgentRuntime {
  readonly #active = new Map<string, ActiveRun>();

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
    private readonly contextCompiler = new ContextCompiler(),
    private readonly additionalInstructions: () => string = () => "",
    private readonly chatTitles?: ChatTitleGenerator,
  ) {}

  async initialize(): Promise<void> {
    for (const run of this.runs.listRunsByStatus([
      "queued",
      "running",
      "waiting_approval",
    ])) {
      if (run.status === "waiting_approval") {
        const checkpoint = this.checkpoints.get(run.id);
        if (checkpoint) {
          try {
            const modelRuntime = await this.providers.createChatModelRuntime(
              run.provider.profileId,
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

  async start(request: StartRunRequest): Promise<Run> {
    return this.chatTurns.runSerializedTurn(request.chatId, async () => {
      const priorMessages = this.chats.listMessages(request.chatId);
      const modelRuntime = await this.providers.createChatModelRuntime(
        request.providerProfileId,
      );
      const limits = await modelRuntime.provider.resolveContextLimits(
        modelRuntime.snapshot.modelId,
      );
      const now = this.clock.now();
      const runId = this.ids.generate();
      this.writer.startRun({
        chatId: request.chatId,
        createdAt: now,
        execution: request.execution,
        id: runId,
        latestSequence: 1,
        provider: modelRuntime.snapshot,
        startedAt: now,
        status: "running",
      });

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
          ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
          ...(attachment.byteLength === undefined
            ? {}
            : { byteLength: attachment.byteLength }),
          messageId: userMessage.id,
          ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
          storageKey: attachment.storageKey,
        });
      }
      const userItem = this.writer.startItem(runId, "user_message", {
        attachmentIds: request.attachments.map(({ artifactId }) => artifactId),
        content: request.content,
        messageId: userMessage.id,
      });
      this.writer.completeItem(userItem.id, {
        output: { messageId: userMessage.id },
        status: "completed",
      });

      const content =
        request.attachments.length === 0
          ? request.content
          : `${request.content}\n\nAttached local artifacts:\n${request.attachments
              .map(
                ({ displayName, storageKey }) =>
                  `- ${displayName}: ${storageKey}`,
              )
              .join("\n")}`;
      const state = this.#createActiveRun(
        runId,
        modelRuntime.provider,
        limits,
        initialCheckpoint(content, priorMessages),
        0,
      );
      this.#saveCheckpoint(state, "model");
      this.#launch(state);
      return this.#requireRun(runId);
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
    return { runId: run.id };
  }

  async resume(request: ResumeRunRequest): Promise<{ runId: string }> {
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
    const modelRuntime = await this.providers.createChatModelRuntime(
      run.provider.profileId,
    );
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
          "needs_input" | "interrupted" | "completed" | "failed" | "cancelled"
        >,
      };
    }
    const active = this.#active.get(run.id);
    if (!active) {
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

  async interruptAll(): Promise<void> {
    const tasks = [...this.#active.values()].flatMap((active) => {
      if (this.runs.getRun(active.runId)?.status === "waiting_approval") {
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
    const contextLimits = data.contextLimits ?? limits;
    return {
      abort: new AbortController(),
      data:
        data.contextLimits === undefined ? { ...data, contextLimits } : data,
      generation,
      limits: contextLimits,
      provider,
      runId,
      steering: [],
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
      const requestBytes = Buffer.byteLength(
        JSON.stringify(active.data.input),
        "utf8",
      );
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
        forcedCompactionAttempted: false,
        input: nextInput,
        lastRequestBytes: requestBytes,
        lastUsage: turn.usage,
      };

      for (const searchCall of turn.toolSearchCalls) {
        const selected = this.tools.search(searchCall.query, searchCall.limit);
        active.data = {
          ...active.data,
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
      this.#mergeSteering(active);
      this.#saveCheckpoint(active, "model");

      if (
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
      const toolNamespaces =
        run.execution.mode === "agent"
          ? groupModelTools(this.tools.list())
          : [];
      const extra = this.additionalInstructions().trim();
      const instructions = [
        BASE_INSTRUCTIONS,
        `Current timestamp: ${this.clock.now()}. User system time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}. Interpret relative dates such as today in that time zone.`,
        run.execution.mode === "chat"
          ? "This Run is Chat mode. Do not call external-effect tools; explain what the user can do or ask them to switch explicitly to Agent mode."
          : "This Run is Agent mode. Follow its approval decisions and continue after structured rejection when a legitimate alternative exists.",
        extra,
      ]
        .filter(Boolean)
        .join("\n\n");
      const allowedTools = active.data.allowedTools;
      const events = active.provider.stream(
        {
          ...(allowedTools === undefined ? {} : { allowedTools }),
          input: active.data.input,
          instructions,
          ...(active.limits.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: active.limits.maxOutputTokens }),
          modelId: run.provider.modelId,
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
      if (message) {
        message = this.chats.updateMessage({
          ...message,
          content: turn.text,
          status: "completed",
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
        status: "completed",
      });
      return turn;
    } catch (error) {
      deltaBatcher.flush();
      const cancelled = active.abort.signal.aborted;
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
          error instanceof ProviderError
            ? toProviderAppError(error)
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
        error instanceof ProviderError &&
        error.code === "PROVIDER.CONTEXT_LIMIT_EXCEEDED" &&
        !active.data.forcedCompactionAttempted
      ) {
        active.data = { ...active.data, forcedCompactionAttempted: true };
        this.#compact(active, true);
        return this.#modelTurn(active);
      }
      throw error;
    }
  }

  async #handleToolCall(
    active: ActiveRun,
    call: ModelFunctionCall,
  ): Promise<void> {
    const resolvedName = this.#resolveToolName(call);
    const pending: PendingToolCall = {
      arguments: call.arguments,
      callId: call.callId,
      name: resolvedName,
      rawItem: call.rawItem,
    };
    const definition = this.tools.get(resolvedName);
    if (!definition) {
      const result = unexpectedToolResult(
        new TypeError(`Unknown Tool: ${resolvedName}`),
      );
      this.#recordToolResult(active, pending, undefined, result);
      return;
    }
    const run = this.#requireRun(active.runId);
    if (run.execution.mode === "chat") {
      this.#recordToolResult(active, pending, undefined, chatModeToolResult());
      return;
    }
    try {
      this.tools.validateInput(resolvedName, call.arguments);
    } catch (error) {
      this.#recordToolResult(
        active,
        pending,
        definition.descriptor,
        unexpectedToolResult(error),
      );
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
        this.tools.get(pending.name)?.descriptor,
        rejectedToolResult(approval?.decisionReason),
      );
      return;
    }
    const definition = this.tools.get(pending.name);
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
      definition.descriptor.itemKind === "plan"
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
      result = await this.tools.execute(pending.name, pending.arguments, {
        itemId: item.id,
        onDelta: (delta) => {
          pendingDelta += delta;
          deltaBatcher.schedule();
        },
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
      displayOutput: toolDisplayOutput(result),
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
          ? this.tools.recoveryCandidates(pending.name)
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
    active.data = {
      ...checkpointWithoutPending,
      ...(allowedTools === undefined ? {} : { allowedTools }),
      boundaries,
      handoff: {
        ...checkpointWithoutPending.handoff,
        currentProgress: [
          ...checkpointWithoutPending.handoff.currentProgress,
          `${pending.name}: ${result.summary}`,
        ],
        nextSteps: [],
      },
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
          this.tools.get(pending.name)?.descriptor,
          result,
        );
        return true;
      }
      const definition = this.tools.get(pending.name);
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
        items: active.data.input,
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

  #compact(active: ActiveRun, force: boolean): void {
    const compiled = this.contextCompiler.compile(
      {
        items: active.data.input,
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
      displayOutput: "已整理较早上下文，并保留当前进度、决定、约束与下一步。",
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
      recentUsers: [...active.data.recentUsers, ...contents],
    };
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

  #resolveToolName(call: ModelFunctionCall): string {
    if (this.tools.get(call.name)) return call.name;
    const namespaced = call.namespace
      ? `${call.namespace}.${call.name}`
      : call.name;
    return this.tools.get(namespaced) ? namespaced : call.name;
  }

  #handleDriveFailure(active: ActiveRun, error: unknown): void {
    const run = this.runs.getRun(active.runId);
    if (!run || TERMINAL_STATUSES.has(run.status)) return;
    if (active.abort.signal.aborted) {
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
        this.writer.transition(active.runId, "interrupted", {
          code: "AGENT.APP_INTERRUPTED",
          message: "应用退出中断了当前边界，可稍后继续。",
          retryable: true,
        });
      } else {
        this.writer.transition(active.runId, "cancelled");
      }
      return;
    }
    if (error instanceof GuardTerminalError) {
      this.writer.transition(active.runId, "failed", error.appError);
      return;
    }
    if (error instanceof ProviderError && error.retryable) {
      this.#saveCheckpoint(active, "interrupted");
      this.writer.transition(
        active.runId,
        "interrupted",
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
