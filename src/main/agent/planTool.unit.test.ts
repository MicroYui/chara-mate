import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../tools/toolRegistry";
import { registerPlanTool } from "./planTool";

const context = {
  itemId: "10000000-0000-4000-8000-000000000001",
  onDelta: () => undefined,
  runId: "10000000-0000-4000-8000-000000000002",
  signal: new AbortController().signal,
};

describe("plan.update Tool", () => {
  it("registers one user-visible Plan capability and returns the full snapshot", async () => {
    const registry = new ToolRegistry();
    registerPlanTool(registry);
    const update = {
      explanation: "开始验证。",
      plan: [
        { status: "completed" as const, step: "检查实现" },
        { status: "in_progress" as const, step: "运行测试" },
      ],
    };

    expect(registry.get("plan.update")?.descriptor).toMatchObject({
      effect: "read",
      idempotency: "idempotent",
      itemKind: "plan",
      namespace: "plan",
    });
    expect(
      registry.search("plan update current steps", 8)[0]?.descriptor.name,
    ).toBe("plan.update");
    await expect(
      registry.execute("plan.update", update, context),
    ).resolves.toMatchObject({ modelContent: update, status: "success" });
  });

  it("rejects ambiguous snapshots with multiple active steps", async () => {
    const registry = new ToolRegistry();
    registerPlanTool(registry);

    await expect(
      registry.execute(
        "plan.update",
        {
          plan: [
            { status: "in_progress", step: "第一步" },
            { status: "in_progress", step: "第二步" },
          ],
        },
        context,
      ),
    ).rejects.toThrow(/at most one in_progress/u);
  });
});
