import { Type, type Static } from "@sinclair/typebox";

import type { JsonValue } from "../../shared/contracts/primitives";
import { TimestampSchema } from "../../shared/schemas/primitives";
import { parseSchema } from "../../shared/schemas/validation";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import type { ActivityService } from "./activityService";

export const ACTIVITY_SEARCH_TOOL_NAME = "activity.search";

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
  activity: Pick<ActivityService, "search">,
): void {
  registry.register({
    descriptor: {
      description:
        "Search compact observations from the user's retained Activity Episodes. Use when the user asks about actual software/site usage, recent activity history, or observed routines and supplied context is insufficient. Omit query for an overall usage overview; for a named app, site, or topic, rewrite it into a concise evidence phrase. Set periodStart/periodEnd only when the user explicitly asks for a time range. Results are bounded aggregates and intentionally contain no internal IDs, screenshots, window-title evidence, or full provenance. They describe observed behavior only: never infer preference, occupation, intent, or purpose from usage time.",
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
}
