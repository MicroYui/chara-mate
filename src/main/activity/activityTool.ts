import { Type, type Static } from "@sinclair/typebox";

import type { JsonValue } from "../../shared/contracts/primitives";
import { TimestampSchema } from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { ActivityService } from "./activityService";
import type { ToolResult } from "../../shared/contracts/tool";
import { fitsInputBudget } from "../providers/inputBudget";
import {
  ActivityObserveInputSchema,
  type ActivityTextObservation,
} from "./activityObservation";

export const ACTIVITY_SEARCH_TOOL_NAME = "activity.search";
export const ACTIVITY_OBSERVE_TOOL_NAME = "activity.observe";

function observationResult(observation: ActivityTextObservation): ToolResult {
  const modelContent = { ...observation } satisfies JsonValue;
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success",
    summary:
      observation.status === "available"
        ? "已读取保留的活动文字"
        : "活动文字当前不可供给",
  };
}

const ActivitySearchInputSchema = Type.Object(
  {
    periodEnd: Type.Optional(TimestampSchema),
    periodStart: Type.Optional(TimestampSchema),
    query: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

type ActivitySearchInput = Static<typeof ActivitySearchInputSchema>;

export function registerActivityTool(
  registry: ToolRegistry,
  activity: Pick<ActivityService, "search" | "observe">,
): void {
  registry.register({
    descriptor: {
      description:
        "Search compact observations from the user's retained Activity Episodes. Use when the user asks about actual software/site usage, recent activity history, or observed routines and supplied context is insufficient. Omit query for an overall usage overview; for a named app, site, or topic, rewrite it into a concise evidence phrase. Set periodStart/periodEnd only when the user explicitly asks for a time range. Results are bounded aggregates and intentionally contain no internal IDs, screenshots, window-title evidence, or full provenance. An actor=user aggregate has explicit user activity attribution. actor=unknown only establishes foreground visibility on the desktop; do not present it as time the user operated, read or understood that app. Known agent/system work is excluded. Neither kind establishes preference, occupation, intent, purpose or emotion from duration.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: ActivitySearchInputSchema,
      itemKind: "tool_call",
      name: ACTIVITY_SEARCH_TOOL_NAME,
      namespace: "activity",
      source: "builtin",
      summary: "搜索活动习惯",
    },
    execute: (input) => {
      const request: ActivitySearchInput = parseSchema(
        ActivitySearchInputSchema,
        input,
      );
      const result = activity.search(request);
      const modelContent = {
        observedBehaviorOnly: true,
        patterns: result.patterns.map((pattern) => ({ ...pattern })),
        periodEnd: result.periodEnd,
        periodStart: result.periodStart,
      } satisfies JsonValue;
      return Promise.resolve({
        artifacts: [],
        evidenceHash: toolEvidenceHash(modelContent),
        modelContent,
        retryable: false,
        status: "success" as const,
        summary:
          modelContent.patterns.length > 0
            ? `找到 ${String(modelContent.patterns.length)} 条活动模式`
            : "没有找到相关活动模式",
      });
    },
    summarize: (input) => {
      const query = input["query"];
      return `搜索活动习惯${typeof query === "string" && query.trim() ? `：${query.trim()}` : "概览"}`;
    },
  });
  registry.register({
    descriptor: {
      description:
        "Read original AX/DOM text already retained by Activity. latest selects the newest location match, including protected or unavailable observations, without falling back to older available text. query matches app/window/URL metadata only. reference and next keep the exact event; offsets are UTF-16 code units at character boundaries. Results identify actual observation and persistence times, actor, location, scope, reported capture truncation and the returned text range. A finished retained-text range is not a complete page or live screen. Paused capture does not forbid reading retained text and this tool never resumes or forces capture. Unknown/agent/system actor does not establish user reading or intent. Use image.inspect when pixels are required.",
      effect: "read",
      idempotency: "idempotent",
      inputSchema: ActivityObserveInputSchema,
      itemKind: "tool_call",
      name: ACTIVITY_OBSERVE_TOOL_NAME,
      namespace: "activity",
      source: "builtin",
      summary: "读取已观察的活动文字",
    },
    execute: async (input, context) => {
      const measureResult = context.measureResult;
      if (!measureResult)
        throw new Error(
          "Activity observation requires the current Tool result measurement owner",
        );
      const request = parseSchema(ActivityObserveInputSchema, input);
      const observation = await activity.observe(
        request,
        async (candidate) => {
          context.signal.throwIfAborted();
          const measured = await measureResult(observationResult(candidate));
          context.signal.throwIfAborted();
          return fitsInputBudget(
            measured.measurement,
            measured.inputBudgetTokens,
          );
        },
        context.signal,
      );
      context.signal.throwIfAborted();
      return observationResult(observation);
    },
    summarize: () => "读取已观察的活动文字",
  });
}
