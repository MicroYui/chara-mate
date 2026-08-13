import { Type, type Static } from "@sinclair/typebox";

import type { JsonValue } from "../../shared/contracts/primitives";
import type { Run } from "../../shared/contracts/run";
import type { ToolResult } from "../../shared/contracts/tool";
import { redactText } from "../../shared/pure/redaction";
import { NonBlankStringSchema } from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { ChatModelRuntime } from "../providers/providerService";
import type { ToolDefinition, ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import { collectModelTurn, type ModelUsage } from "./modelProvider";

export const COLLABORATION_DISPATCH_TOOL_NAME = "collaboration.dispatch";

const CollaborationReadSchema = Type.Object(
  {
    input: Type.Record(Type.String(), Type.Unknown()),
    resourceClaim: NonBlankStringSchema,
    toolName: Type.String({ pattern: "^[a-z][a-z0-9._-]*[a-z0-9]$" }),
  },
  { additionalProperties: false },
);

const CollaborationSubtaskSchema = Type.Object(
  {
    goal: NonBlankStringSchema,
    id: Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }),
    reads: Type.Array(CollaborationReadSchema, { minItems: 1 }),
    resourceClaims: Type.Array(NonBlankStringSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const CollaborationDispatchSchema = Type.Object(
  {
    subtasks: Type.Array(CollaborationSubtaskSchema, {
      maxItems: 2,
      minItems: 2,
    }),
  },
  { additionalProperties: false },
);

export type CollaborationDispatch = Static<typeof CollaborationDispatchSchema>;

interface CollaborationDependencies {
  createChatModelRuntime(
    profileId: string,
    modelId?: string,
  ): Promise<ChatModelRuntime>;
  getRun(runId: string): Run | undefined;
}

interface ChildEvidence {
  readonly artifacts: ToolResult["artifacts"];
  readonly evidenceHash?: string;
  readonly resourceClaim: string;
  readonly status: ToolResult["status"];
  readonly summary: string;
  readonly toolName: string;
}

interface CompletedChild {
  readonly evidence: readonly ChildEvidence[];
  readonly goal: string;
  readonly id: string;
  readonly resourceClaims: readonly string[];
  readonly status: "completed" | "limited";
  readonly summary: string;
  readonly usage: ModelUsage;
}

interface FailedChild {
  readonly evidence: readonly ChildEvidence[];
  readonly error: string;
  readonly goal: string;
  readonly id: string;
  readonly resourceClaims: readonly string[];
  readonly retryable: boolean;
  readonly status: "failed";
}

type ChildResult = CompletedChild | FailedChild;

const BLOCKED_CHILD_NAMESPACES = new Set(["browser", "computer"]);

function asRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Collaboration read input must be a JSON object");
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function normalizedClaim(value: string): string {
  return value.trim().normalize("NFC");
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function availableReadDefinition(
  registry: ToolRegistry,
  toolName: string,
  availableToolNames: ReadonlySet<string> | undefined,
): ToolDefinition {
  const definition = registry.get(toolName);
  if (!definition) throw new TypeError(`Unknown child read Tool: ${toolName}`);
  const descriptor = definition.descriptor;
  if (availableToolNames && !availableToolNames.has(toolName)) {
    throw new TypeError(
      `Child read Tool is outside this Run scope: ${toolName}`,
    );
  }
  if (
    descriptor.effect !== "read" ||
    descriptor.idempotency !== "idempotent" ||
    descriptor.itemKind !== "tool_call" ||
    descriptor.name === COLLABORATION_DISPATCH_TOOL_NAME
  ) {
    throw new TypeError(
      `Child Tool must be an ordinary idempotent read: ${toolName}`,
    );
  }
  if (BLOCKED_CHILD_NAMESPACES.has(descriptor.namespace)) {
    throw new TypeError(
      `Mutable ${descriptor.namespace} sessions cannot be shared with child tasks`,
    );
  }
  return definition;
}

function validateDispatch(
  input: Readonly<Record<string, JsonValue>>,
  registry: ToolRegistry,
  availableToolNames: ReadonlySet<string> | undefined,
): CollaborationDispatch {
  const dispatch = parseSchema(CollaborationDispatchSchema, input);
  const ids = new Set<string>();
  const claimedBy = new Map<string, string>();
  const callsBy = new Map<string, string>();

  for (const subtask of dispatch.subtasks) {
    if (ids.has(subtask.id)) {
      throw new TypeError(`Duplicate collaboration subtask id: ${subtask.id}`);
    }
    ids.add(subtask.id);
    const localClaims = new Set<string>();
    for (const rawClaim of subtask.resourceClaims) {
      const claim = normalizedClaim(rawClaim);
      if (localClaims.has(claim)) {
        throw new TypeError(
          `Duplicate resource claim in ${subtask.id}: ${claim}`,
        );
      }
      const owner = claimedBy.get(claim);
      if (owner) {
        throw new TypeError(
          `Resource claim ${claim} is shared by ${owner} and ${subtask.id}`,
        );
      }
      localClaims.add(claim);
      claimedBy.set(claim, subtask.id);
    }

    const usedClaims = new Set<string>();
    for (const read of subtask.reads) {
      const claim = normalizedClaim(read.resourceClaim);
      if (!localClaims.has(claim)) {
        throw new TypeError(
          `Read claim ${claim} is not owned by subtask ${subtask.id}`,
        );
      }
      const definition = availableReadDefinition(
        registry,
        read.toolName,
        availableToolNames,
      );
      const readInput = asRecord(read.input);
      registry.validateInput(definition.descriptor.name, readInput);
      const callKey = `${definition.descriptor.name}:${canonicalJson(readInput)}`;
      const callOwner = callsBy.get(callKey);
      if (callOwner && callOwner !== subtask.id) {
        throw new TypeError(
          `The same read operation is shared by ${callOwner} and ${subtask.id}`,
        );
      }
      callsBy.set(callKey, subtask.id);
      usedClaims.add(claim);
    }
    for (const claim of localClaims) {
      if (!usedClaims.has(claim)) {
        throw new TypeError(
          `Resource claim ${claim} has no bounded read in subtask ${subtask.id}`,
        );
      }
    }
  }
  return dispatch;
}

function childPrompt(
  subtask: CollaborationDispatch["subtasks"][number],
  evidence: readonly (ChildEvidence & { readonly content: JsonValue })[],
): string {
  return JSON.stringify({
    evidence: evidence.map(({ content, ...entry }) => ({ ...entry, content })),
    goal: subtask.goal,
    resourceClaims: subtask.resourceClaims,
  });
}

function publicEvidence(
  evidence: readonly (ChildEvidence & { readonly content: JsonValue })[],
): ChildEvidence[] {
  return evidence.map(
    ({
      artifacts,
      evidenceHash,
      resourceClaim,
      status,
      summary,
      toolName,
    }) => ({
      artifacts,
      ...(evidenceHash ? { evidenceHash } : {}),
      resourceClaim,
      status,
      summary,
      toolName,
    }),
  );
}

async function runChild(
  subtask: CollaborationDispatch["subtasks"][number],
  registry: ToolRegistry,
  runtime: ChatModelRuntime,
  run: Run,
  context: Parameters<ToolDefinition["execute"]>[1],
): Promise<ChildResult> {
  context.signal.throwIfAborted();
  context.onDelta(`子任务 ${subtask.id}：正在读取声明资源\n`);
  const evidence: Array<ChildEvidence & { readonly content: JsonValue }> = [];
  try {
    for (const read of subtask.reads) {
      context.signal.throwIfAborted();
      const result = await registry.execute(
        read.toolName,
        asRecord(read.input),
        {
          ...context,
          onDelta: () => undefined,
        },
      );
      evidence.push({
        artifacts: result.artifacts,
        content: result.modelContent,
        ...(result.evidenceHash ? { evidenceHash: result.evidenceHash } : {}),
        resourceClaim: normalizedClaim(read.resourceClaim),
        status: result.status,
        summary: result.summary,
        toolName: read.toolName,
      });
    }

    context.signal.throwIfAborted();
    context.onDelta(`子任务 ${subtask.id}：正在独立分析\n`);
    const turn = await collectModelTurn(
      runtime.provider.stream(
        {
          input: [
            {
              content: childPrompt(subtask, evidence),
              role: "user",
              type: "message",
            },
          ],
          instructions:
            "You are a read-only child of CharaMate's current Agent Run. Complete only the assigned goal from the supplied bounded observations. Do not claim actions, ask the user, call tools, or broaden scope. Return a concise evidence-linked summary for the parent Agent, explicitly naming uncertainty or failed observations. Reply in the language used by the goal.",
          modelId: run.provider.modelId,
          nativeWebSearch: false,
          toolNamespaces: [],
        },
        context.signal,
      ),
    );
    context.signal.throwIfAborted();
    if (turn.status !== "completed" || !turn.text.trim()) {
      throw new Error(`Subtask ${subtask.id} returned no completed summary`);
    }
    context.onDelta(`子任务 ${subtask.id}：已完成\n`);
    return {
      evidence: publicEvidence(evidence),
      goal: subtask.goal,
      id: subtask.id,
      resourceClaims: subtask.resourceClaims.map(normalizedClaim),
      status: evidence.every(({ status }) => status === "success")
        ? "completed"
        : "limited",
      summary: turn.text.trim(),
      usage: turn.usage,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    return failedChild(subtask, error, publicEvidence(evidence));
  }
}

function failedChild(
  subtask: CollaborationDispatch["subtasks"][number],
  error: unknown,
  evidence: readonly ChildEvidence[] = [],
): FailedChild {
  return {
    evidence,
    error: redactText(
      error instanceof Error ? error.message : "子任务执行失败。",
    ),
    goal: subtask.goal,
    id: subtask.id,
    resourceClaims: subtask.resourceClaims.map(normalizedClaim),
    retryable:
      typeof error === "object" &&
      error !== null &&
      "retryable" in error &&
      error.retryable === true,
    status: "failed",
  };
}

function uniqueArtifacts(children: readonly ChildResult[]) {
  const artifacts = children.flatMap((child) =>
    child.evidence.flatMap((entry) => entry.artifacts),
  );
  return [
    ...new Map(
      artifacts.map((artifact) => [artifact.artifactId, artifact]),
    ).values(),
  ];
}

export function registerCollaborationTool(
  registry: ToolRegistry,
  dependencies: CollaborationDependencies,
): void {
  registry.register({
    descriptor: {
      description:
        "Agent-only collaboration capability. Call it directly only when the current goal contains exactly two concrete, independent, read-only branches whose latency or coverage likely justifies extra model work. Declare disjoint resource claims and exact bounded read Tool calls for each child. Never use it for simple work, dependencies between branches, writes, approvals, or Browser/Computer sessions. The host validates the plan, runs both children concurrently, and returns both summaries for the parent to join.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: CollaborationDispatchSchema,
      itemKind: "subtask",
      name: COLLABORATION_DISPATCH_TOOL_NAME,
      namespace: "collaboration",
      recoveryGroup: "collaboration.read",
      source: "builtin",
      summary: "并行协作",
    },
    execute: async (input, context) => {
      const run = dependencies.getRun(context.runId);
      if (!run || run.execution.mode !== "agent") {
        throw new TypeError(
          "Parallel collaboration is available only in Agent mode",
        );
      }
      const availableToolNames = context.availableToolNames
        ? new Set(context.availableToolNames)
        : undefined;
      const dispatch = validateDispatch(input, registry, availableToolNames);
      const runtime = await dependencies.createChatModelRuntime(
        run.provider.profileId,
        run.provider.modelId,
      );
      const settled = await Promise.allSettled(
        dispatch.subtasks.map((subtask) =>
          runChild(subtask, registry, runtime, run, context),
        ),
      );
      context.signal.throwIfAborted();
      const children = settled.map((entry, index): ChildResult => {
        const subtask = dispatch.subtasks[index]!;
        return entry.status === "fulfilled"
          ? entry.value
          : failedChild(subtask, entry.reason);
      });
      const failed = children.filter(
        (child): child is FailedChild => child.status === "failed",
      );
      const modelContent = JSON.parse(
        JSON.stringify({ children, joinRequired: true }),
      ) as JsonValue;
      if (failed.length > 0) {
        const retryable = failed.some((child) => child.retryable);
        return {
          artifacts: uniqueArtifacts(children),
          error: {
            code: "AGENT.COLLABORATION_FAILED",
            details: { failedChildIds: failed.map(({ id }) => id) },
            message: `${String(failed.length)} 个并行子任务没有完成；父 Agent 可使用已返回的证据继续。`,
            retryable,
          },
          evidenceHash: toolEvidenceHash(modelContent),
          modelContent,
          retryable,
          status: "error",
          summary: `${String(2 - failed.length)}/2 个只读子任务已完成`,
        } satisfies ToolResult;
      }
      return {
        artifacts: uniqueArtifacts(children),
        evidenceHash: toolEvidenceHash(modelContent),
        modelContent,
        retryable: false,
        status: "success",
        summary: children.some(({ status }) => status === "limited")
          ? "两个只读子任务已完成，其中包含受限观察"
          : "两个只读子任务已完成",
      } satisfies ToolResult;
    },
    summarize: (input) => {
      const subtasks = input["subtasks"];
      if (!Array.isArray(subtasks)) return "并行分析两个只读子任务";
      const goals = subtasks.flatMap((subtask) => {
        if (
          typeof subtask !== "object" ||
          subtask === null ||
          Array.isArray(subtask) ||
          typeof subtask["goal"] !== "string"
        ) {
          return [];
        }
        return [subtask["goal"]];
      });
      return `并行分析：${goals.join("；")}`;
    },
  });
}
