import { describe, expect, it } from "vitest";

import type { Message } from "../../shared/contracts/chat";
import type { RunItem } from "../../shared/contracts/run";
import {
  detectEvolutionTriggers,
  evolutionToolSignature,
} from "./evolutionTrigger";

const timestamp = "2026-08-13T00:00:00.000Z";

function message(content: string): Message {
  return {
    chatId: "00000000-0000-4000-8000-000000000001",
    content,
    createdAt: timestamp,
    id: "00000000-0000-4000-8000-000000000002",
    role: "user",
    status: "completed",
    updatedAt: timestamp,
  };
}

function item(
  kind: RunItem["kind"],
  input: NonNullable<RunItem["input"]>,
  displayOutput?: string,
): RunItem {
  return {
    artifacts: [],
    ...(displayOutput ? { displayOutput } : {}),
    endedAt: timestamp,
    id: crypto.randomUUID(),
    input,
    kind,
    runId: "00000000-0000-4000-8000-000000000003",
    sequence: 1,
    startedAt: timestamp,
    status: "completed",
  };
}

describe("Evolution trigger selection", () => {
  it("triggers on explicit correction and teaching without a Tool-count rule", () => {
    const result = detectEvolutionTriggers({
      hasPriorToolSignature: () => false,
      items: [],
      messages: [message("不对，以后按这套流程做，请记住。")],
    });
    expect(result.triggers).toEqual([
      "explicit_correction",
      "explicit_teaching",
    ]);
  });

  it("requires a completed effect plus objective evidence for verified success", () => {
    const result = detectEvolutionTriggers({
      hasPriorToolSignature: () => false,
      items: [
        item("file_change", { path: "report.md" }),
        item("tool_call", { toolName: "verify" }, "验证通过"),
      ],
      messages: [message("处理这份一次性报告")],
    });
    expect(result.triggers).toContain("verified_success");
  });

  it("recognizes the second identical tool sequence as repeated", () => {
    const items = [
      item("tool_call", {
        arguments: { path: "a" },
        toolName: "files.read",
      }),
      item("command", { command: "npm test" }),
    ];
    const signature = evolutionToolSignature(items);
    expect(signature).toHaveLength(64);
    const result = detectEvolutionTriggers({
      hasPriorToolSignature: (candidate) => candidate === signature,
      items,
      messages: [message("继续")],
    });
    expect(result.triggers).toEqual(["repeated_pattern"]);
  });

  it("skips routine runs without a durable signal", () => {
    const result = detectEvolutionTriggers({
      hasPriorToolSignature: () => false,
      items: [item("tool_call", { toolName: "calculator" }, "4")],
      messages: [message("2 + 2 是多少？")],
    });
    expect(result.triggers).toEqual([]);
  });
});
