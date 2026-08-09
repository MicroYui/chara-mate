import type {
  ApprovalDecision,
  ResolveApprovalRequest,
} from "../../shared/contracts/agent";
import type { Message } from "../../shared/contracts/chat";
import type { JsonValue } from "../../shared/contracts/primitives";
import type {
  Approval,
  AppError,
  Run,
  RunCancelRequest,
  RunCancelResult,
  RunExecution,
} from "../../shared/contracts/run";
import type { ToolResult } from "../../shared/contracts/tool";
import type {
  VoiceClientCommand,
  VoiceConnection,
  VoiceDriverEvent,
  VoiceDriverEventRequest,
  VoiceHistoryMessage,
  VoicePreviewConnection,
  VoicePreviewRequest,
  VoiceQuickStartRequest,
  VoiceSessionRecord,
  VoiceSessionRequest,
  VoiceSessionSnapshot,
  VoiceStartRequest,
  VoiceTurnRecord,
} from "../../shared/contracts/voice";
import { VOICE_CHAT_FALLBACK_TITLE } from "../../shared/contracts/voice";
import type { VoiceSettingsConfig } from "../../shared/contracts/settings";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import {
  requiresApproval,
  toolAllowedInExecution,
} from "../agent/approvalPolicy";
import { AgentError } from "../agent/agentError";
import { realtimeAgentInstructions } from "../agent/agentInstructions";
import { createMemoryContextInput } from "../agent/memoryContext";
import type { RunRepository } from "../agent/runRepository";
import type { RunEventWriter } from "../agent/runEventWriter";
import type { SettingsRepository } from "../app/settingsRepository";
import type { ChatRepository } from "../chat/chatRepository";
import type { ChatService } from "../chat/chatService";
import type { ChatTitleGenerator } from "../chat/chatTitleService";
import type { MemoryService } from "../memory/memoryService";
import type {
  ProviderService,
  RealtimeProviderRuntime,
} from "../providers/providerService";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { ToolDefinition, ToolRegistry } from "../tools/toolRegistry";
import type {
  AzureRealtimeFunctionTool,
  AzureWebRtcSessionIssuer,
} from "./azureWebRtcSession";
import { VoiceError } from "./voiceError";
import type { VoiceMetrics } from "./voiceMetrics";
import type { VoiceRepository } from "./voiceRepository";

const APPROVAL_RUN_LIFETIME = "9999-12-31T23:59:59.999Z";
const TERMINAL_RUN_STATUSES = new Set<Run["status"]>([
  "interrupted",
  "completed",
  "failed",
  "cancelled",
]);

interface PreparedRealtimeTools {
  readonly aliases: Map<string, ToolDefinition>;
  readonly configs: AzureRealtimeFunctionTool[];
}

interface PreparedVoiceStart {
  readonly configured: VoiceSettingsConfig;
  readonly defaultInstructions: string;
  readonly issued: VoicePreviewConnection;
  readonly providerRuntime: RealtimeProviderRuntime;
  readonly realtimeTools: PreparedRealtimeTools;
}

interface AssistantOutput {
  readonly messageId: string;
  readonly parts: Map<string, AssistantOutputPart>;
  readonly responseId: string;
  readonly runItemId: string;
  readonly turnId: string;
}

interface AssistantOutputPart {
  readonly outputIndex: number;
  readonly protocolItemId: string;
  readonly responseId: string;
  readonly responseOrder: number;
  text: string;
}

interface AssistantOutputSelection {
  readonly output: AssistantOutput;
  readonly part: AssistantOutputPart;
}

interface PendingVoiceTool {
  readonly abort: AbortController;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly callId: string;
  readonly definition: ToolDefinition;
  readonly generation: number;
  readonly instructions: string;
  readonly responseId: string;
  readonly runId: string;
  readonly turnId: string;
  approvalId?: string;
  approvalItemId?: string;
  toolItemId?: string;
}

interface ActiveVoice {
  readonly assistantOutputs: Map<string, AssistantOutput>;
  audioPlaying: boolean;
  readonly chatProviderProfileId: string;
  readonly configuredInstructions: string;
  readonly defaultInstructions: string;
  readonly execution: RunExecution;
  readonly functionResponses: Set<string>;
  readonly inputTurns: Map<string, string>;
  nextResponseOrder: number;
  pendingTool?: PendingVoiceTool;
  record: VoiceSessionRecord;
  readonly responseOrders: Map<string, number>;
  readonly responseTurns: Map<string, string>;
  realtimeTools: PreparedRealtimeTools;
  readonly runMemoryIds: Map<string, readonly string[]>;
  readonly runTurns: Map<string, string>;
  snapshot: VoiceSessionSnapshot;
  readonly turnAborts: Map<string, AbortController>;
  readonly turns: Map<string, VoiceTurnRecord>;
}

export interface VoiceServicePublisher {
  command(command: VoiceClientCommand): void;
  snapshot(snapshot: VoiceSessionSnapshot | null): void;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function realtimeAlias(name: string): string {
  return name.replaceAll(".", "_").replaceAll("-", "_");
}

function stringChoices(schema: unknown): readonly string[] | undefined {
  const value = object(schema);
  if (!value) return undefined;
  if (typeof value["const"] === "string") return [value["const"]];
  if (
    Array.isArray(value["enum"]) &&
    value["enum"].every((item) => typeof item === "string")
  ) {
    return value["enum"];
  }
  if (!Array.isArray(value["anyOf"])) return undefined;
  const choices = value["anyOf"].map(stringChoices);
  if (choices.some((items) => !items)) return undefined;
  return [...new Set(choices.flatMap((items) => items ?? []))];
}

function mergePropertySchema(
  current: JsonValue | undefined,
  candidate: JsonValue,
): JsonValue {
  if (!current) {
    const choices = stringChoices(candidate);
    return choices ? { enum: [...choices], type: "string" } : candidate;
  }
  if (JSON.stringify(current) === JSON.stringify(candidate)) return current;
  const choices = [stringChoices(current), stringChoices(candidate)];
  if (choices.every((items) => items)) {
    return {
      enum: [...new Set(choices.flatMap((items) => items ?? []))],
      type: "string",
    };
  }
  const variants = [current, candidate].flatMap((schema) => {
    const anyOf = object(schema)?.["anyOf"];
    return Array.isArray(anyOf) ? (anyOf as JsonValue[]) : [schema];
  });
  return {
    anyOf: variants.filter(
      (schema, index) =>
        variants.findIndex(
          (candidateSchema) =>
            JSON.stringify(candidateSchema) === JSON.stringify(schema),
        ) === index,
    ),
  };
}

function realtimeParameters(name: string, schema: JsonValue): JsonValue {
  const root = object(schema);
  if (root?.["type"] === "object") return schema;
  const alternatives = root?.["anyOf"];
  if (
    Array.isArray(alternatives) &&
    alternatives.every((candidate) => object(candidate)?.["type"] === "object")
  ) {
    const objects = alternatives.map((candidate) => object(candidate)!);
    const properties: Record<string, JsonValue> = {};
    for (const candidate of objects) {
      const candidateProperties = object(candidate["properties"]);
      if (!candidateProperties) continue;
      for (const [property, propertySchema] of Object.entries(
        candidateProperties,
      )) {
        properties[property] = mergePropertySchema(
          properties[property],
          propertySchema as JsonValue,
        );
      }
    }
    const requiredLists = objects.map((candidate) =>
      Array.isArray(candidate["required"])
        ? candidate["required"].filter(
            (property): property is string => typeof property === "string",
          )
        : [],
    );
    const required =
      requiredLists[0]?.filter((property) =>
        requiredLists.every((properties) => properties.includes(property)),
      ) ?? [];
    return {
      ...(objects.every(
        (candidate) => candidate["additionalProperties"] === false,
      )
        ? { additionalProperties: false }
        : {}),
      properties,
      ...(required.length ? { required } : {}),
      type: "object",
    };
  }
  throw new VoiceError(
    "VOICE.UNSUPPORTED_TOOL_SCHEMA",
    `Realtime 工具 ${name} 的输入必须是对象。`,
    false,
  );
}

function prepareRealtimeTools(
  registry: ToolRegistry,
  execution: RunExecution,
): PreparedRealtimeTools {
  const aliases = new Map<string, ToolDefinition>();
  const configs: AzureRealtimeFunctionTool[] = [];
  for (const definition of registry.list()) {
    if (!toolAllowedInExecution(execution, definition.descriptor)) continue;
    const alias = realtimeAlias(definition.descriptor.name);
    const existing = aliases.get(alias);
    if (existing) {
      throw new VoiceError(
        "VOICE.TOOL_ALIAS_COLLISION",
        `Realtime 工具名冲突：${existing.descriptor.name} 与 ${definition.descriptor.name}。`,
        false,
      );
    }
    aliases.set(alias, definition);
    configs.push({
      description: definition.descriptor.description,
      name: alias,
      parameters: realtimeParameters(
        definition.descriptor.name,
        definition.descriptor.inputSchema,
      ),
      type: "function",
    });
  }
  return { aliases, configs };
}

function history(messages: readonly Message[]): VoiceHistoryMessage[] {
  return messages
    .filter(
      ({ content, status }) => status === "completed" && content.trim().length,
    )
    .map(({ content, role }) => ({ content, role }));
}

function memoryEvidence(
  memory: MemoryService | undefined,
  query: string,
): { readonly content?: string; readonly ids: readonly string[] } {
  if (!memory) return { ids: [] as readonly string[] };
  const hits = memory.search(query.trim() ? { query } : {}, "context", 8);
  const value = createMemoryContextInput(hits);
  const content = object(value)?.["content"];
  return {
    ...(typeof content === "string" ? { content } : {}),
    ids: hits.map(({ memory: item }) => item.id),
  };
}

function parseToolArguments(
  serialized: string,
): Readonly<Record<string, JsonValue>> {
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Tool arguments must be a JSON object");
  }
  return parsed as Readonly<Record<string, JsonValue>>;
}

function unexpectedToolResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : "工具执行失败。";
  const modelContent = {
    code: "TOOL.EXECUTION_FAILED",
    message,
  } satisfies JsonValue;
  return {
    artifacts: [],
    error: {
      code: "TOOL.EXECUTION_FAILED",
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

function cancelledToolResult(): ToolResult {
  return {
    artifacts: [],
    modelContent: { cancelled: true },
    retryable: false,
    status: "cancelled",
    summary: "操作已取消",
  };
}

function toolItemStatus(
  result: ToolResult,
): "completed" | "failed" | "cancelled" {
  if (result.status === "success") return "completed";
  if (result.status === "cancelled") return "cancelled";
  return "failed";
}

export class VoiceService {
  #active: ActiveVoice | undefined;

  constructor(
    private readonly repository: VoiceRepository,
    private readonly settings: SettingsRepository,
    private readonly providers: ProviderService,
    private readonly issuer: AzureWebRtcSessionIssuer,
    private readonly tools: ToolRegistry,
    private readonly runs: RunRepository,
    private readonly writer: RunEventWriter,
    private readonly chatTurns: ChatService,
    private readonly chats: ChatRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly publisher: VoiceServicePublisher,
    private readonly skillInstructions: () => string = () => "",
    private readonly chatTitles?: ChatTitleGenerator,
    private readonly memory?: MemoryService,
    private readonly onPhaseChanged: (
      phase: VoiceSessionSnapshot["phase"] | "idle",
    ) => void = () => undefined,
    private readonly metrics?: VoiceMetrics,
  ) {}

  initialize(): void {
    const endedAt = this.clock.now();
    for (const session of this.repository.listActiveSessions()) {
      const turn = this.repository.getCurrentTurn(session.id);
      if (turn) {
        this.repository.updateTurn({
          ...turn,
          endedAt,
          interrupted: true,
          status: "interrupted",
        });
      }
      this.repository.updateSession({
        ...session,
        endedAt,
        status: "interrupted",
      });
    }
  }

  getActive(): VoiceSessionSnapshot | null {
    return this.#active?.snapshot ?? null;
  }

  getMemoryContextIds(runId: string): readonly string[] {
    return this.#active?.runMemoryIds.get(runId) ?? [];
  }

  shutdown(): void {
    const active = this.#active;
    if (!active) return;
    this.#interruptCurrentTurn(
      active,
      this.clock.now(),
      undefined,
      "interrupted",
    );
    this.#publishCommand({
      sessionId: active.record.id,
      type: "session.close",
    });
    this.#finish(active, "interrupted", {
      code: "VOICE.APP_INTERRUPTED",
      message: "应用退出中断了语音会话。",
      retryable: true,
    });
    this.#active = undefined;
  }

  async preview(request: VoicePreviewRequest): Promise<VoicePreviewConnection> {
    const runtime = await this.providers.createRealtimeProviderRuntime(
      request.providerProfileId,
    );
    return this.issuer.issue(runtime, {
      instructions: request.instructions,
      voice: request.voice,
    });
  }

  async start(request: VoiceStartRequest): Promise<VoiceConnection> {
    if (
      this.#active?.record.status === "interrupted" &&
      this.#active.record.chatId === request.chatId
    ) {
      return this.#reconnect(this.#active, request.requestedAt);
    }
    this.#assertCanStart(request.chatId);
    const prepared = await this.#prepareStart(request.execution);
    this.#assertCanStart(request.chatId);
    return this.#activate(request, prepared);
  }

  async quickStart(request: VoiceQuickStartRequest): Promise<VoiceConnection> {
    this.#assertCanStart();
    const execution = {
      approvalMode: "full_access",
      mode: "agent",
    } as const;
    const prepared = await this.#prepareStart(execution);
    this.#assertCanStart();
    const chat = this.chatTurns.create({ title: VOICE_CHAT_FALLBACK_TITLE });
    try {
      return this.#activate(
        {
          chatId: chat.id,
          chatProviderProfileId: this.#chatTitleProfileId(
            prepared.providerRuntime.snapshot.profileId,
          ),
          execution,
          requestedAt: request.requestedAt,
        },
        prepared,
      );
    } catch (error) {
      this.chatTurns.delete({ chatId: chat.id });
      throw error;
    }
  }

  async #prepareStart(execution: RunExecution): Promise<PreparedVoiceStart> {
    const configured = this.settings.getVoice();
    const providerRuntime = await this.providers.createRealtimeProviderRuntime(
      configured.providerProfileId,
    );
    const realtimeTools = prepareRealtimeTools(this.tools, execution);
    const defaultInstructions = this.#instructions(
      configured.instructions,
      execution,
    );
    const issued = await this.issuer.issue(providerRuntime, {
      instructions: defaultInstructions,
      tools: realtimeTools.configs,
      voice: configured.voice,
    });
    return {
      configured,
      defaultInstructions,
      issued,
      providerRuntime,
      realtimeTools,
    };
  }

  #activate(
    request: VoiceStartRequest,
    prepared: PreparedVoiceStart,
  ): VoiceConnection {
    const id = this.ids.generate();
    const createdAt = request.requestedAt;
    const recordValue = this.repository.insertSession({
      chatId: request.chatId,
      createdAt,
      generation: 0,
      id,
      inputMode: prepared.configured.inputMode,
      instructions: prepared.defaultInstructions,
      muted: false,
      provider: prepared.providerRuntime.snapshot,
      status: "connecting",
      voice: prepared.configured.voice,
    });
    const snapshot: VoiceSessionSnapshot = {
      assistantTranscript: "",
      chatId: request.chatId,
      createdAt,
      generation: 0,
      inputMode: prepared.configured.inputMode,
      muted: false,
      phase: "connecting",
      sessionId: id,
      userTranscript: "",
      voice: prepared.configured.voice,
    };
    this.#active = {
      assistantOutputs: new Map(),
      audioPlaying: false,
      chatProviderProfileId: request.chatProviderProfileId,
      configuredInstructions: prepared.configured.instructions,
      defaultInstructions: prepared.defaultInstructions,
      execution: request.execution,
      functionResponses: new Set(),
      inputTurns: new Map(),
      nextResponseOrder: 0,
      record: recordValue,
      responseOrders: new Map(),
      responseTurns: new Map(),
      realtimeTools: prepared.realtimeTools,
      runMemoryIds: new Map(),
      runTurns: new Map(),
      snapshot,
      turnAborts: new Map(),
      turns: new Map(),
    };
    this.metrics?.startSession(id, createdAt);
    this.#publishSnapshot();
    return {
      ...prepared.issued,
      history: history(this.chats.listMessages(request.chatId)),
      inputMode: prepared.configured.inputMode,
      sessionId: id,
      voice: prepared.configured.voice,
    };
  }

  #assertCanStart(chatId?: string): void {
    if (this.#active) {
      throw new VoiceError(
        "VOICE.ALREADY_ACTIVE",
        "已有一个语音会话正在进行。",
        false,
      );
    }
    if (chatId && this.runs.getActiveRun(chatId)) {
      throw new VoiceError(
        "VOICE.RUN_ACTIVE",
        "请先结束当前 Run，再进入语音。",
        false,
      );
    }
  }

  end(request: VoiceSessionRequest): null {
    const active = this.#requireActive(request.sessionId);
    this.#publishCommand({
      enabled: false,
      sessionId: active.record.id,
      type: "capture.set",
    });
    this.#interruptCurrentTurn(
      active,
      this.clock.now(),
      undefined,
      "cancelled",
    );
    this.#publishCommand({
      sessionId: active.record.id,
      type: "session.close",
    });
    this.#finish(active, "completed");
    return null;
  }

  cancelRun(request: RunCancelRequest): Promise<RunCancelResult> {
    const run = this.runs.getRun(request.runId);
    if (!run)
      throw new AgentError("AGENT.RUN_NOT_FOUND", "Run 不存在。", false);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return Promise.resolve({
        outcome: "already_terminal",
        runId: run.id,
        status: run.status as
          "interrupted" | "completed" | "failed" | "cancelled",
      });
    }
    const active = this.#active;
    const turn = active ? this.#turnForRun(active, run.id) : undefined;
    if (active && turn) {
      this.#interruptTurn(
        active,
        turn,
        request.requestedAt,
        undefined,
        "cancelled",
      );
      this.#publishCommand({
        generation: turn.generation,
        ...(turn.responseId ? { responseId: turn.responseId } : {}),
        sessionId: active.record.id,
        type: "response.cancel",
      });
      this.#setPhase(active, "listening");
    } else {
      this.#closeRun(run, "cancelled");
    }
    return Promise.resolve({ outcome: "accepted", runId: run.id });
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
    const active = this.#active;
    const pending = active?.pendingTool;
    if (!active || !pending || pending.approvalId !== approval.id) {
      throw new AgentError(
        "AGENT.RUN_NOT_ACTIVE",
        "该语音 Run 已不再等待审批。",
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
    if (pending.approvalItemId) {
      this.writer.completeItem(pending.approvalItemId, {
        output: {
          decision: request.decision,
          reason: request.reason ?? null,
        },
        status: "completed",
      });
    }
    this.#setCapture(active, true);
    void this.#continueAfterApproval(
      active,
      pending,
      request.decision,
      request.reason,
    );
    return resolved;
  }

  setMuted(sessionId: string, muted: boolean): VoiceSessionSnapshot {
    const active = this.#requireActive(sessionId);
    active.record = this.repository.updateSession({ ...active.record, muted });
    active.snapshot = { ...active.snapshot, muted };
    this.#setCapture(active, true);
    this.#publishSnapshot();
    return active.snapshot;
  }

  async report(
    request: VoiceDriverEventRequest,
  ): Promise<VoiceSessionSnapshot> {
    const active = this.#requireActive(request.sessionId);
    const event = request.event;
    if (event.type === "session.ready") {
      active.record = this.repository.updateSession({
        ...active.record,
        connectedAt: request.occurredAt,
        protocolSessionId: event.protocolSessionId,
        status: "active",
      });
      this.metrics?.connected(active.record.id, request.occurredAt);
      this.#setPhase(active, "listening");
      this.#setCapture(active, true);
    } else if (event.type === "speech.started") {
      this.metrics?.speechStarted(
        active.record.id,
        event.itemId,
        request.occurredAt,
        event.assistantItemId,
      );
      const interrupted = this.#currentTurn(active);
      if (interrupted) {
        this.#publishCommand({
          generation: interrupted.generation,
          ...(interrupted.responseId
            ? { responseId: interrupted.responseId }
            : {}),
          sessionId: active.record.id,
          type: "response.cancel",
        });
      }
      active.audioPlaying = false;
      this.#interruptCurrentTurn(
        active,
        request.occurredAt,
        event.audioEndMs,
        "interrupted",
      );
      this.#startTurn(active, request.occurredAt, event.itemId);
    } else if (event.type === "speech.stopped") {
      this.metrics?.speechStopped(
        active.record.id,
        event.itemId,
        request.occurredAt,
      );
    } else if (event.type === "transcript.user.delta") {
      this.#appendUserTranscript(active, event.itemId, event.delta);
    } else if (event.type === "transcript.user.completed") {
      await this.#acceptTranscript(
        active,
        event.itemId,
        event.transcript,
        request.occurredAt,
      );
      const turn = this.#turnForInput(active, event.itemId);
      if (turn && !turn.interrupted) {
        this.metrics?.transcriptCompleted(
          active.record.id,
          event.itemId,
          turn.generation,
          request.occurredAt,
        );
      }
    } else if (event.type === "transcript.user.failed") {
      const turn = this.#turnForInput(active, event.itemId);
      if (turn) this.#failTurn(active, turn, request.occurredAt, false);
      this.#setPhase(active, "failed", {
        code: event.code,
        message: event.message,
        retryable: true,
      });
    } else if (event.type === "response.started") {
      this.#responseStarted(active, event, request.occurredAt);
    } else if (event.type === "transcript.assistant.delta") {
      this.#appendAssistantTranscript(active, event);
    } else if (event.type === "transcript.assistant.done") {
      this.#completeAssistantTranscript(active, event);
    } else if (event.type === "tool.call") {
      active.functionResponses.add(event.responseId);
      this.metrics?.toolCallReceived(active.record.id, request.occurredAt);
      void this.#handleToolCall(active, event);
    } else if (event.type === "audio.started") {
      const turn = this.#turnForResponse(active, event.responseId);
      if (turn && turn.id === active.snapshot.turnId && !turn.interrupted) {
        active.audioPlaying = true;
        this.metrics?.audioStarted(
          active.record.id,
          event.generation,
          request.occurredAt,
        );
        this.#setPhase(active, "speaking");
      } else {
        this.metrics?.discardedLateEvent();
      }
    } else if (event.type === "audio.stopped") {
      active.audioPlaying = false;
      const turn = event.responseId
        ? this.#turnForResponse(active, event.responseId)
        : this.#currentTurn(active);
      const run = turn?.runId ? this.runs.getRun(turn.runId) : undefined;
      if (turn?.id === active.snapshot.turnId && run?.status === "completed") {
        this.#setPhase(active, "listening");
      }
    } else if (event.type === "response.done") {
      this.metrics?.responseUsage(event.usage);
      this.#responseDone(active, event, request.occurredAt);
    } else if (event.type === "item.truncated") {
      this.metrics?.truncated(
        active.record.id,
        event.itemId,
        request.occurredAt,
      );
      const turn = this.#currentTurn(active);
      if (turn?.interrupted) {
        const updated = this.repository.updateTurn({
          ...turn,
          audioEndMs: event.audioEndMs,
        });
        active.turns.set(updated.id, updated);
      }
    } else if (event.type === "connection.closed") {
      this.metrics?.disconnected();
      this.#interruptCurrentTurn(
        active,
        request.occurredAt,
        undefined,
        "interrupted",
      );
      this.#finish(active, "interrupted", {
        code: "VOICE.CONNECTION_CLOSED",
        message: event.reason || "Realtime 连接已断开。",
        retryable: true,
      });
    } else if (event.type === "server.error") {
      const turn = this.#currentTurn(active);
      if (turn) this.#failTurn(active, turn, request.occurredAt, false);
      this.#setPhase(active, "failed", {
        code: event.code,
        message: event.message,
        retryable: false,
      });
    }
    return active.snapshot;
  }

  async #reconnect(
    active: ActiveVoice,
    requestedAt: string,
  ): Promise<VoiceConnection> {
    const runtime = await this.providers.createRealtimeProviderRuntime(
      active.record.provider.profileId,
    );
    if (
      runtime.snapshot.apiStyle !== active.record.provider.apiStyle ||
      runtime.snapshot.modelId !== active.record.provider.modelId ||
      runtime.snapshot.profileName !== active.record.provider.profileName
    ) {
      throw new VoiceError(
        "VOICE.PROVIDER_CHANGED",
        "Realtime Provider 已改变，请结束当前语音后重新开始。",
        false,
      );
    }
    active.realtimeTools = prepareRealtimeTools(this.tools, active.execution);
    const issued = await this.issuer.issue(runtime, {
      instructions: active.defaultInstructions,
      tools: active.realtimeTools.configs,
      voice: active.record.voice,
    });
    const reconnecting: VoiceSessionRecord = {
      ...active.record,
      status: "connecting",
    };
    delete reconnecting.connectedAt;
    delete reconnecting.endedAt;
    delete reconnecting.error;
    delete reconnecting.protocolSessionId;
    active.record = this.repository.updateSession(reconnecting);
    active.audioPlaying = false;
    active.functionResponses.clear();
    active.nextResponseOrder = 0;
    active.responseOrders.clear();
    active.responseTurns.clear();
    const snapshot = { ...active.snapshot };
    delete snapshot.connectedAt;
    delete snapshot.error;
    active.snapshot = { ...snapshot, phase: "connecting" };
    this.metrics?.startReconnect(active.record.id, requestedAt);
    this.#publishSnapshot();
    return {
      ...issued,
      history: history(this.chats.listMessages(active.record.chatId)),
      inputMode: active.record.inputMode,
      sessionId: active.record.id,
      voice: active.record.voice,
    };
  }

  #instructions(
    configured: string,
    execution: RunExecution,
    context?: string,
  ): string {
    return realtimeAgentInstructions({
      configured,
      execution,
      ...(context === undefined ? {} : { memoryContext: context }),
      now: this.clock.now(),
      skills: this.skillInstructions(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
  }

  #requireActive(sessionId: string): ActiveVoice {
    const active = this.#active;
    if (!active) {
      throw new VoiceError("VOICE.NOT_ACTIVE", "当前没有语音会话。", false);
    }
    if (active.record.id !== sessionId) {
      throw new VoiceError(
        "VOICE.SESSION_MISMATCH",
        "语音事件不属于当前会话。",
        false,
      );
    }
    return active;
  }

  #startTurn(
    active: ActiveVoice,
    startedAt: string,
    userItemId?: string,
  ): VoiceTurnRecord {
    const generation = active.record.generation + 1;
    active.record = this.repository.updateSession({
      ...active.record,
      generation,
    });
    const turn = this.repository.insertTurn({
      assistantTranscript: "",
      generation,
      id: this.ids.generate(),
      instructions: active.defaultInstructions,
      interrupted: false,
      sessionId: active.record.id,
      startedAt,
      status: "listening",
      ...(userItemId ? { userItemId } : {}),
      userTranscript: "",
      voice: active.record.voice,
    });
    active.turns.set(turn.id, turn);
    active.turnAborts.set(turn.id, new AbortController());
    if (userItemId) active.inputTurns.set(userItemId, turn.id);
    const snapshot = { ...active.snapshot };
    delete snapshot.error;
    delete snapshot.runId;
    active.snapshot = {
      ...snapshot,
      assistantTranscript: "",
      generation,
      phase: "listening",
      turnId: turn.id,
      userTranscript: "",
    };
    this.#publishSnapshot();
    return turn;
  }

  #appendUserTranscript(active: ActiveVoice, itemId: string, delta: string) {
    const turn = this.#turnForInput(active, itemId);
    if (!turn || turn.interrupted) return;
    const updated = { ...turn, userTranscript: turn.userTranscript + delta };
    active.turns.set(updated.id, updated);
    if (active.snapshot.turnId === updated.id) {
      active.snapshot = {
        ...active.snapshot,
        userTranscript: updated.userTranscript,
      };
      this.#publishSnapshot();
    }
  }

  async #acceptTranscript(
    active: ActiveVoice,
    itemId: string,
    transcript: string,
    occurredAt: string,
  ): Promise<void> {
    const current =
      this.#turnForInput(active, itemId) ??
      this.#startTurn(active, occurredAt, itemId);
    active.inputTurns.set(itemId, current.id);
    if (current.interrupted || current.id !== active.snapshot.turnId) return;
    const evidence = memoryEvidence(this.memory, transcript);
    const instructions = this.#instructions(
      active.configuredInstructions,
      active.execution,
      evidence.content,
    );
    let turn = this.repository.updateTurn({
      ...current,
      instructions,
      status: "responding",
      userItemId: itemId,
      userTranscript: transcript,
    });
    active.turns.set(turn.id, turn);
    active.snapshot = {
      ...active.snapshot,
      phase: "thinking",
      userTranscript: transcript,
    };
    this.#publishSnapshot();
    this.chatTurns.adoptFirstMessageTitle(
      active.record.chatId,
      VOICE_CHAT_FALLBACK_TITLE,
      transcript,
    );
    await this.chatTurns.runSerializedTurn(active.record.chatId, () => {
      const runId = this.ids.generate();
      this.writer.startRun({
        chatId: active.record.chatId,
        createdAt: occurredAt,
        execution: active.execution,
        id: runId,
        latestSequence: 1,
        provider: active.record.provider,
        source: "voice",
        startedAt: occurredAt,
        status: "running",
      });
      const userMessage = this.chats.insertMessage({
        chatId: active.record.chatId,
        content: transcript,
        createdAt: occurredAt,
        id: this.ids.generate(),
        role: "user",
        runId,
        status: "completed",
        updatedAt: occurredAt,
      });
      const userItem = this.writer.startItem(runId, "user_message", {
        attachmentIds: [],
        content: transcript,
        messageId: userMessage.id,
      });
      this.writer.completeItem(userItem.id, {
        output: { messageId: userMessage.id },
        status: "completed",
      });
      turn = this.repository.updateTurn({
        ...turn,
        runId,
        userMessageId: userMessage.id,
      });
      active.turns.set(turn.id, turn);
      active.runTurns.set(runId, turn.id);
      active.runMemoryIds.set(runId, evidence.ids);
      active.record = this.repository.updateSession({
        ...active.record,
        lastRunId: runId,
      });
      active.snapshot = { ...active.snapshot, runId };
      this.#publishSnapshot();
      this.#publishCommand({
        generation: turn.generation,
        instructions,
        requestId: this.ids.generate(),
        sessionId: active.record.id,
        type: "response.create",
      });
    });
  }

  #responseStarted(
    active: ActiveVoice,
    event: Extract<VoiceDriverEvent, { type: "response.started" }>,
    occurredAt: string,
  ) {
    const turn = this.#turnForGeneration(active, event.generation);
    if (!turn || turn.interrupted) {
      this.metrics?.discardedLateEvent();
      return;
    }
    active.responseTurns.set(event.responseId, turn.id);
    active.responseOrders.set(event.responseId, active.nextResponseOrder);
    active.nextResponseOrder += 1;
    const updated = this.repository.updateTurn({
      ...turn,
      responseId: event.responseId,
      status: "responding",
    });
    active.turns.set(updated.id, updated);
    this.metrics?.responseStarted(active.record.id, occurredAt);
    if (!active.audioPlaying) this.#setPhase(active, "thinking");
  }

  #ensureAssistantOutput(
    active: ActiveVoice,
    turn: VoiceTurnRecord,
    responseId: string,
    protocolItemId: string,
    outputIndex: number,
  ): AssistantOutputSelection | undefined {
    const existingOutput = active.assistantOutputs.get(turn.id);
    const existingPart = existingOutput?.parts.get(protocolItemId);
    if (existingOutput && existingPart) {
      return { output: existingOutput, part: existingPart };
    }
    if (!turn.runId) return undefined;
    const run = this.runs.getRun(turn.runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return undefined;
    let output = existingOutput;
    if (!output) {
      const now = this.clock.now();
      const message = this.chats.insertMessage({
        chatId: active.record.chatId,
        content: "",
        createdAt: now,
        id: this.ids.generate(),
        role: "assistant",
        runId: run.id,
        status: "streaming",
        updatedAt: now,
      });
      const item = this.writer.startItem(run.id, "assistant_message", {
        modelId: active.record.provider.modelId,
        responseId,
      });
      output = {
        messageId: message.id,
        parts: new Map(),
        responseId,
        runItemId: item.id,
        turnId: turn.id,
      };
      active.assistantOutputs.set(turn.id, output);
      const current = active.turns.get(turn.id) ?? turn;
      const updated = this.repository.updateTurn({
        ...current,
        assistantItemId: protocolItemId,
        assistantMessageId: message.id,
      });
      active.turns.set(updated.id, updated);
    }
    let responseOrder = active.responseOrders.get(responseId);
    if (responseOrder === undefined) {
      responseOrder = active.nextResponseOrder;
      active.nextResponseOrder += 1;
      active.responseOrders.set(responseId, responseOrder);
    }
    const part = {
      outputIndex,
      protocolItemId,
      responseId,
      responseOrder,
      text: "",
    };
    output.parts.set(protocolItemId, part);
    return { output, part };
  }

  #appendAssistantTranscript(
    active: ActiveVoice,
    event: Extract<VoiceDriverEvent, { type: "transcript.assistant.delta" }>,
  ) {
    const turn = this.#turnForResponse(active, event.responseId);
    if (!turn || turn.interrupted) return;
    const selected = this.#ensureAssistantOutput(
      active,
      turn,
      event.responseId,
      event.itemId,
      event.outputIndex,
    );
    if (!selected) return;
    selected.part.text += event.delta;
    this.writer.appendDelta(turn.runId!, selected.output.runItemId, {
      text: event.delta,
    });
    this.#syncAssistantOutput(active, turn, selected.output);
  }

  #completeAssistantTranscript(
    active: ActiveVoice,
    event: Extract<VoiceDriverEvent, { type: "transcript.assistant.done" }>,
  ) {
    const turn = this.#turnForResponse(active, event.responseId);
    if (!turn || turn.interrupted) return;
    if (
      !event.transcript.trim() &&
      !active.assistantOutputs.get(turn.id)?.parts.has(event.itemId)
    ) {
      return;
    }
    const selected = this.#ensureAssistantOutput(
      active,
      turn,
      event.responseId,
      event.itemId,
      event.outputIndex,
    );
    if (!selected) return;
    if (event.transcript || !selected.part.text) {
      selected.part.text = event.transcript;
    }
    this.#syncAssistantOutput(active, turn, selected.output);
  }

  #assistantOutputText(output: AssistantOutput): string {
    return [...output.parts.values()]
      .sort(
        (left, right) =>
          left.responseOrder - right.responseOrder ||
          left.outputIndex - right.outputIndex ||
          left.protocolItemId.localeCompare(right.protocolItemId),
      )
      .map(({ text }) => text.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  #syncAssistantOutput(
    active: ActiveVoice,
    turn: VoiceTurnRecord,
    output: AssistantOutput,
  ) {
    const assistantTranscript = this.#assistantOutputText(output);
    const message = this.chats.getMessage(output.messageId);
    if (message?.status === "streaming") {
      this.chats.updateMessage({
        ...message,
        content: assistantTranscript,
        updatedAt: this.clock.now(),
      });
    }
    const current = active.turns.get(turn.id) ?? turn;
    const updated = this.repository.updateTurn({
      ...current,
      assistantTranscript,
    });
    active.turns.set(updated.id, updated);
    if (active.snapshot.turnId === updated.id) {
      active.snapshot = { ...active.snapshot, assistantTranscript };
      this.#publishSnapshot();
    }
  }

  async #handleToolCall(
    active: ActiveVoice,
    event: Extract<VoiceDriverEvent, { type: "tool.call" }>,
  ): Promise<void> {
    const turn = this.#turnForResponse(active, event.responseId);
    if (
      !turn?.runId ||
      turn.interrupted ||
      turn.generation !== event.generation
    ) {
      this.metrics?.discardedLateEvent();
      return;
    }
    if (active.pendingTool) {
      this.#sendStandaloneToolResult(
        active,
        turn,
        event,
        unexpectedToolResult(new Error("另一个工具仍在执行。")),
      );
      return;
    }
    const definition = active.realtimeTools.aliases.get(event.name);
    let argumentsValue: Readonly<Record<string, JsonValue>>;
    try {
      if (!definition) throw new Error(`Unknown Tool: ${event.name}`);
      argumentsValue = parseToolArguments(event.arguments);
      this.tools.validateInput(definition.descriptor.name, argumentsValue);
    } catch (error) {
      this.#sendStandaloneToolResult(
        active,
        turn,
        event,
        unexpectedToolResult(error),
      );
      return;
    }
    const pending: PendingVoiceTool = {
      abort: new AbortController(),
      arguments: argumentsValue,
      callId: event.callId,
      definition,
      generation: event.generation,
      instructions: turn.instructions,
      responseId: event.responseId,
      runId: turn.runId,
      turnId: turn.id,
    };
    active.pendingTool = pending;
    if (requiresApproval(active.execution, definition.descriptor)) {
      const approvalItem = this.writer.startItem(turn.runId, "approval", {
        arguments: argumentsValue,
        toolName: definition.descriptor.name,
      });
      const approval = this.writer.requestApproval({
        expiresAt: APPROVAL_RUN_LIFETIME,
        id: this.ids.generate(),
        itemId: approvalItem.id,
        parameterSummary: definition.summarize(argumentsValue),
        requestedAt: this.clock.now(),
        runId: turn.runId,
        status: "pending",
        toolName: definition.descriptor.name,
      });
      pending.approvalId = approval.id;
      pending.approvalItemId = approvalItem.id;
      this.#setCapture(active, false);
      this.#setPhase(active, "waiting_approval");
      return;
    }
    await this.#executeTool(active, pending);
  }

  async #continueAfterApproval(
    active: ActiveVoice,
    pending: PendingVoiceTool,
    decision: ApprovalDecision,
    reason?: string,
  ) {
    if (active.pendingTool !== pending) return;
    if (decision === "rejected") {
      this.#sendToolResult(active, pending, rejectedToolResult(reason));
      return;
    }
    await this.#executeTool(active, pending);
  }

  async #executeTool(active: ActiveVoice, pending: PendingVoiceTool) {
    const run = this.runs.getRun(pending.runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;
    this.#setPhase(active, "using_tool");
    const item = this.writer.startItem(
      pending.runId,
      pending.definition.descriptor.itemKind,
      pending.definition.descriptor.itemKind === "plan"
        ? pending.arguments
        : {
            arguments: pending.arguments,
            callId: pending.callId,
            toolName: pending.definition.descriptor.name,
          },
    );
    pending.toolItemId = item.id;
    let result: ToolResult;
    try {
      result = await this.tools.execute(
        pending.definition.descriptor.name,
        pending.arguments,
        {
          itemId: item.id,
          onDelta: (delta) => {
            const current = this.runs.getRunItem(item.id);
            if (current?.status === "running") {
              this.writer.appendDelta(pending.runId, item.id, { text: delta });
            }
          },
          runId: pending.runId,
          signal: pending.abort.signal,
        },
      );
    } catch (error) {
      result = pending.abort.signal.aborted
        ? cancelledToolResult()
        : unexpectedToolResult(error);
    }
    const currentRun = this.runs.getRun(pending.runId);
    const currentItem = this.runs.getRunItem(item.id);
    if (!currentRun || TERMINAL_RUN_STATUSES.has(currentRun.status)) return;
    if (currentItem?.status === "running") {
      this.writer.completeItem(item.id, {
        artifacts: result.artifacts,
        displayOutput: result.error?.message ?? result.summary,
        ...(result.error ? { error: result.error } : {}),
        output: result,
        status: toolItemStatus(result),
      });
    }
    this.#sendToolResult(active, pending, result);
  }

  #sendStandaloneToolResult(
    active: ActiveVoice,
    turn: VoiceTurnRecord,
    event: Extract<VoiceDriverEvent, { type: "tool.call" }>,
    result: ToolResult,
  ) {
    if (!turn.runId) return;
    const item = this.writer.startItem(turn.runId, "tool_call", {
      arguments: event.arguments,
      callId: event.callId,
      toolName: event.name,
    });
    this.writer.completeItem(item.id, {
      displayOutput: result.error?.message ?? result.summary,
      ...(result.error ? { error: result.error } : {}),
      output: result,
      status: toolItemStatus(result),
    });
    this.#publishCommand({
      callId: event.callId,
      generation: event.generation,
      instructions: turn.instructions,
      output: JSON.stringify(result),
      requestId: this.ids.generate(),
      sessionId: active.record.id,
      type: "tool.result",
    });
  }

  #sendToolResult(
    active: ActiveVoice,
    pending: PendingVoiceTool,
    result: ToolResult,
  ) {
    if (active.pendingTool !== pending) return;
    delete active.pendingTool;
    const run = this.runs.getRun(pending.runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;
    this.#publishCommand({
      callId: pending.callId,
      generation: pending.generation,
      instructions: pending.instructions,
      output: JSON.stringify(result),
      requestId: this.ids.generate(),
      sessionId: active.record.id,
      type: "tool.result",
    });
    this.#setPhase(active, "thinking");
  }

  #responseDone(
    active: ActiveVoice,
    event: Extract<VoiceDriverEvent, { type: "response.done" }>,
    occurredAt: string,
  ) {
    const turn = this.#turnForResponse(active, event.responseId);
    if (!turn || turn.interrupted) return;
    if (event.status === "failed" || event.status === "incomplete") {
      this.#failTurn(active, turn, occurredAt, false, {
        code: "VOICE.RESPONSE_FAILED",
        message: event.statusReason || "语音回答没有完成。",
        retryable: event.status === "incomplete",
      });
      return;
    }
    if (event.status === "cancelled") return;
    if (active.functionResponses.has(event.responseId)) return;
    this.#completeTurn(active, turn, occurredAt);
  }

  #completeTurn(active: ActiveVoice, turn: VoiceTurnRecord, endedAt: string) {
    if (!turn.runId || turn.interrupted || turn.status === "completed") return;
    const run = this.runs.getRun(turn.runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;
    const output = active.assistantOutputs.get(turn.id);
    if (output) {
      const text = this.#assistantOutputText(output);
      const message = this.chats.getMessage(output.messageId);
      if (message?.status === "streaming") {
        this.chats.updateMessage({
          ...message,
          content: text,
          status: "completed",
          updatedAt: endedAt,
        });
      }
      const item = this.runs.getRunItem(output.runItemId);
      if (item?.status === "running") {
        this.writer.completeItem(item.id, {
          displayOutput: text,
          output: {
            messageId: output.messageId,
            responseId: output.responseId,
          },
          status: "completed",
        });
      }
    }
    this.writer.transition(run.id, "completed");
    const current = active.turns.get(turn.id) ?? turn;
    const updated = this.repository.updateTurn({
      ...current,
      endedAt,
      status: "completed",
    });
    active.turns.set(updated.id, updated);
    active.turnAborts.delete(updated.id);
    if (updated.assistantTranscript.trim()) {
      void this.#generateTitle(active, run, updated.assistantTranscript);
    }
    this.#setPhase(active, active.audioPlaying ? "speaking" : "listening");
  }

  async #generateTitle(
    active: ActiveVoice,
    run: Run,
    assistantContent: string,
  ) {
    if (!this.chatTitles) return;
    const firstUserMessage = this.chats
      .listMessages(run.chatId)
      .find(({ role, status }) => role === "user" && status === "completed");
    if (!firstUserMessage || firstUserMessage.runId !== run.id) return;
    let chatRuntime;
    try {
      chatRuntime = await this.providers.createChatModelRuntime(
        active.chatProviderProfileId,
      );
    } catch {
      return;
    }
    await this.chatTitles.generate({
      assistantContent,
      chatId: run.chatId,
      firstUserContent: firstUserMessage.content,
      modelId: chatRuntime.snapshot.modelId,
      provider: chatRuntime.provider,
      signal: new AbortController().signal,
    });
  }

  #chatTitleProfileId(fallbackProfileId: string): string {
    try {
      return this.providers.getDefaultChatProfileId();
    } catch {
      return fallbackProfileId;
    }
  }

  #interruptCurrentTurn(
    active: ActiveVoice,
    endedAt: string,
    audioEndMs: number | undefined,
    status: "interrupted" | "cancelled",
  ) {
    const turn = this.#currentTurn(active);
    if (turn) this.#interruptTurn(active, turn, endedAt, audioEndMs, status);
  }

  #interruptTurn(
    active: ActiveVoice,
    turn: VoiceTurnRecord,
    endedAt: string,
    audioEndMs: number | undefined,
    status: "interrupted" | "cancelled",
  ) {
    if (turn.status === "completed" || turn.status === "interrupted") return;
    active.turnAborts.get(turn.id)?.abort();
    active.turnAborts.delete(turn.id);
    this.#cancelPendingTool(active, turn, endedAt);
    if (turn.runId) {
      const run = this.runs.getRun(turn.runId);
      if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
        this.#closeRun(run, status);
      }
    }
    const updated = this.repository.updateTurn({
      ...turn,
      ...(audioEndMs === undefined ? {} : { audioEndMs }),
      endedAt,
      interrupted: true,
      status: "interrupted",
    });
    active.turns.set(updated.id, updated);
  }

  #cancelPendingTool(
    active: ActiveVoice,
    turn: VoiceTurnRecord,
    endedAt: string,
  ) {
    const pending = active.pendingTool;
    if (pending?.turnId === turn.id) {
      pending.abort.abort();
      if (pending.approvalId) {
        const approval = this.runs.getApproval(pending.approvalId);
        if (approval?.status === "pending") {
          this.writer.resolveApproval({
            ...approval,
            decidedAt: endedAt,
            decisionReason: "Voice turn interrupted",
            status: "cancelled",
          });
        }
      }
      delete active.pendingTool;
    }
  }

  #closeRun(run: Run, status: "interrupted" | "cancelled") {
    for (const item of this.runs.listRunItems(run.id)) {
      if (
        item.status === "running" ||
        item.status === "waiting_approval" ||
        item.status === "waiting_input"
      ) {
        this.writer.completeItem(item.id, { status });
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
    const current = this.runs.getRun(run.id);
    if (current && !TERMINAL_RUN_STATUSES.has(current.status)) {
      this.writer.transition(run.id, status);
    }
  }

  #failTurn(
    active: ActiveVoice,
    turn: VoiceTurnRecord,
    endedAt: string,
    interrupted: boolean,
    error?: AppError,
  ) {
    if (turn.status === "completed" || turn.status === "interrupted") return;
    this.#cancelPendingTool(active, turn, endedAt);
    if (turn.runId) {
      const run = this.runs.getRun(turn.runId);
      if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
        for (const item of this.runs.listRunItems(run.id)) {
          if (
            item.status === "running" ||
            item.status === "waiting_approval" ||
            item.status === "waiting_input"
          ) {
            this.writer.completeItem(item.id, {
              ...(error ? { error } : {}),
              status: interrupted ? "interrupted" : "failed",
            });
          }
        }
        this.writer.transition(
          run.id,
          interrupted ? "interrupted" : "failed",
          error,
        );
      }
    }
    const updated = this.repository.updateTurn({
      ...turn,
      endedAt,
      interrupted,
      status: interrupted ? "interrupted" : "failed",
    });
    active.turns.set(updated.id, updated);
    this.#setPhase(active, interrupted ? "interrupted" : "failed", error);
  }

  #currentTurn(active: ActiveVoice): VoiceTurnRecord | undefined {
    const id = active.snapshot.turnId;
    return id ? active.turns.get(id) : undefined;
  }

  #turnForGeneration(active: ActiveVoice, generation: number) {
    return [...active.turns.values()].find(
      (turn) => turn.generation === generation,
    );
  }

  #turnForInput(active: ActiveVoice, itemId: string) {
    const id = active.inputTurns.get(itemId);
    return id ? active.turns.get(id) : undefined;
  }

  #turnForResponse(active: ActiveVoice, responseId: string) {
    const id = active.responseTurns.get(responseId);
    return id ? active.turns.get(id) : undefined;
  }

  #turnForRun(active: ActiveVoice, runId: string) {
    const id = active.runTurns.get(runId);
    return id ? active.turns.get(id) : undefined;
  }

  #setCapture(active: ActiveVoice, enabled: boolean) {
    this.#publishCommand({
      enabled:
        enabled &&
        !active.record.muted &&
        active.record.inputMode === "hands_free" &&
        active.record.status === "active",
      sessionId: active.record.id,
      type: "capture.set",
    });
  }

  #setPhase(
    active: ActiveVoice,
    phase: VoiceSessionSnapshot["phase"],
    error?: AppError,
  ) {
    const snapshot = { ...active.snapshot };
    delete snapshot.error;
    active.snapshot = {
      ...snapshot,
      ...(error ? { error } : {}),
      phase,
    };
    this.#publishSnapshot();
  }

  #finish(
    active: ActiveVoice,
    status: "completed" | "interrupted",
    error?: AppError,
  ) {
    const endedAt = this.clock.now();
    active.record = this.repository.updateSession({
      ...active.record,
      endedAt,
      ...(error ? { error } : {}),
      status,
    });
    active.snapshot = {
      ...active.snapshot,
      ...(error ? { error } : {}),
      phase: status === "interrupted" ? "interrupted" : "listening",
    };
    this.#publishSnapshot();
    if (status === "completed") {
      this.#active = undefined;
      this.#publishSnapshot();
    }
  }

  #publishCommand(command: VoiceClientCommand): void {
    try {
      this.publisher.command(command);
    } catch {
      // Renderer projection failure cannot roll back durable Voice state.
    }
  }

  #publishSnapshot(): void {
    try {
      this.publisher.snapshot(this.#active?.snapshot ?? null);
      this.onPhaseChanged(this.#active?.snapshot.phase ?? "idle");
    } catch {
      // Renderer projection failure cannot roll back durable Voice state.
    }
  }
}
