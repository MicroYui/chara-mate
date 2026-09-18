import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { JsonValue, Timestamp } from "../../shared/contracts/primitives";
import type { RunItem } from "../../shared/contracts/run";
import { redactBoundaryValue } from "../../shared/pure/redaction";
import type { RunRepository } from "../agent/runRepository";
import type { AppLogger } from "./logger";

const DEV_TRACE_WINDOW = 500;

export interface RuntimeTrace {
  readonly at: Timestamp;
  readonly chatId: string;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly itemId?: string;
  readonly modelId: string;
  readonly payload?: JsonValue;
  readonly providerProfileId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly status?: string;
  readonly toolName?: string;
  readonly type: "run" | "model" | "tool" | "approval" | "context";
}

export interface RuntimeTraceFilter {
  readonly chatId?: string;
  readonly errorCode?: string;
  readonly modelId?: string;
  readonly providerProfileId?: string;
  readonly runId?: string;
  readonly status?: string;
  readonly toolName?: string;
}

export interface ToolMetric {
  readonly calls: number;
  readonly errors: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly toolName: string;
}

export interface RuntimeObservabilitySnapshot {
  readonly approvals: number;
  readonly cachedInputTokens: number;
  readonly contextCompactions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Coverage of recorded usage objects in this trace window, not HTTP calls. */
  readonly usageCoverage: {
    readonly reports: number;
    readonly cachedInputTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly runs: number;
  readonly tools: readonly ToolMetric[];
  readonly traces: readonly RuntimeTrace[];
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function toolName(item: RunItem): string | undefined {
  if (item.kind === "subtask") return "collaboration.dispatch";
  const input = record(item.input);
  const value = input?.["toolName"];
  return typeof value === "string" ? value : undefined;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0;
}

function traceType(item: RunItem): RuntimeTrace["type"] {
  if (item.kind === "assistant_message") return "model";
  if (item.kind === "approval") return "approval";
  if (item.kind === "context_compaction") return "context";
  return "tool";
}

export class RuntimeObservability {
  readonly #traces: RuntimeTrace[] = [];

  constructor(
    private readonly runs: RunRepository,
    private readonly logger: AppLogger,
  ) {}

  record(envelope: RunEventEnvelope): void {
    if (envelope.event.type === "item.delta") return;
    const run = this.runs.getRun(envelope.streamId);
    if (!run) return;
    let trace: RuntimeTrace;
    if (
      envelope.event.type === "item.started" ||
      envelope.event.type === "item.completed"
    ) {
      const item = envelope.event.item;
      const itemToolName = toolName(item);
      trace = {
        at: envelope.occurredAt,
        chatId: run.chatId,
        ...(item.durationMs === undefined
          ? {}
          : { durationMs: item.durationMs }),
        ...(item.error?.code ? { errorCode: item.error.code } : {}),
        itemId: item.id,
        modelId: run.provider.modelId,
        ...(item.output === undefined
          ? {}
          : { payload: redactBoundaryValue(item.output) as JsonValue }),
        providerProfileId: run.provider.profileId,
        runId: run.id,
        sequence: envelope.sequence,
        status: item.status,
        ...(itemToolName ? { toolName: itemToolName } : {}),
        type: traceType(item),
      };
    } else if (
      envelope.event.type === "approval.requested" ||
      envelope.event.type === "approval.resolved"
    ) {
      trace = {
        at: envelope.occurredAt,
        chatId: run.chatId,
        itemId: envelope.event.approval.itemId,
        modelId: run.provider.modelId,
        providerProfileId: run.provider.profileId,
        runId: run.id,
        sequence: envelope.sequence,
        status: envelope.event.approval.status,
        toolName: envelope.event.approval.toolName,
        type: "approval",
      };
    } else {
      trace = {
        at: envelope.occurredAt,
        chatId: run.chatId,
        ...(run.error?.code ? { errorCode: run.error.code } : {}),
        modelId: run.provider.modelId,
        providerProfileId: run.provider.profileId,
        runId: run.id,
        sequence: envelope.sequence,
        status: run.status,
        type: "run",
      };
    }
    this.#traces.push(trace);
    if (this.#traces.length > DEV_TRACE_WINDOW) this.#traces.shift();
    this.logger.info("RUNTIME_TRACE", { trace });
  }

  snapshot(filter: RuntimeTraceFilter = {}): RuntimeObservabilitySnapshot {
    const traces = this.#traces.filter((trace) =>
      Object.entries(filter).every(
        ([key, value]) => !value || trace[key as keyof RuntimeTrace] === value,
      ),
    );
    const completedRuns = traces.filter(
      ({ status, type }) =>
        type === "run" &&
        (status === "completed" ||
          status === "failed" ||
          status === "cancelled" ||
          status === "interrupted" ||
          status === "needs_input"),
    );
    const completedTools = traces.filter(
      ({ durationMs, toolName: name, type }) =>
        type === "tool" && name !== undefined && durationMs !== undefined,
    );
    const toolNames = [
      ...new Set(completedTools.flatMap((trace) => trace.toolName ?? [])),
    ];
    const usage = traces.flatMap((trace) => {
      const output = record(trace.payload);
      if (trace.type === "model") {
        const value = record(output?.["usage"]);
        return value ? [value] : [];
      }
      if (trace.toolName !== "collaboration.dispatch") return [];
      const modelContent = record(output?.["modelContent"]);
      const children = modelContent?.["children"];
      return Array.isArray(children)
        ? children.flatMap((child) => {
            const value = record(record(child)?.["usage"]);
            return value ? [value] : [];
          })
        : [];
    });
    const token = (name: string) =>
      usage.reduce(
        (total, value) =>
          total + (typeof value[name] === "number" ? value[name] : 0),
        0,
      );
    return {
      approvals: traces.filter(
        ({ status, type }) => type === "approval" && status === "pending",
      ).length,
      cachedInputTokens: token("cachedInputTokens"),
      contextCompactions: traces.filter(
        ({ durationMs, type }) =>
          type === "context" && durationMs !== undefined,
      ).length,
      inputTokens: token("inputTokens"),
      outputTokens: token("outputTokens"),
      usageCoverage: {
        reports: usage.length,
        cachedInputTokens: usage.filter(
          (value) => typeof value["cachedInputTokens"] === "number",
        ).length,
        inputTokens: usage.filter(
          (value) => typeof value["inputTokens"] === "number",
        ).length,
        outputTokens: usage.filter(
          (value) => typeof value["outputTokens"] === "number",
        ).length,
      },
      runs: completedRuns.length,
      tools: toolNames
        .map((name) => {
          const matching = completedTools.filter(
            ({ toolName }) => toolName === name,
          );
          const durations = matching.flatMap(
            ({ durationMs }) => durationMs ?? [],
          );
          return {
            calls: matching.length,
            errors: matching.filter(({ status }) => status === "failed").length,
            p50Ms: percentile(durations, 0.5),
            p95Ms: percentile(durations, 0.95),
            toolName: name,
          };
        })
        .sort((left, right) => left.toolName.localeCompare(right.toolName)),
      traces: [...traces].reverse(),
    };
  }
}
