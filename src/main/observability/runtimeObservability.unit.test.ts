import { describe, expect, it } from "vitest";

import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { Approval, Run, RunItem } from "../../shared/contracts/run";
import type { RunRepository } from "../agent/runRepository";
import { DevDashboard } from "./devDashboard";
import type { AppLogger } from "./logger";
import { RuntimeObservability } from "./runtimeObservability";

const NOW = "2026-08-08T12:00:00.000Z";
const RUN_ID = "10000000-0000-4000-8000-000000000001";
const CHAT_ID = "10000000-0000-4000-8000-000000000002";
const ITEM_ID = "10000000-0000-4000-8000-000000000003";
const TOOL_ITEM_ID = "10000000-0000-4000-8000-000000000004";
const CONTEXT_ITEM_ID = "10000000-0000-4000-8000-000000000005";
const APPROVAL_ID = "10000000-0000-4000-8000-000000000006";

function logger(): AppLogger {
  return {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
}

function envelope(
  sequence: number,
  event: RunEventEnvelope["event"],
): RunEventEnvelope {
  return { event, occurredAt: NOW, sequence, streamId: RUN_ID };
}

function item(
  id: string,
  kind: RunItem["kind"],
  durationMs: number,
  input?: RunItem["input"],
  output?: RunItem["output"],
): RunItem {
  return {
    artifacts: [],
    durationMs,
    endedAt: NOW,
    id,
    ...(input === undefined ? {} : { input }),
    kind,
    ...(output === undefined ? {} : { output }),
    runId: RUN_ID,
    sequence: 2,
    startedAt: NOW,
    status: "completed",
  };
}

function fixture() {
  const run: Run = {
    chatId: CHAT_ID,
    createdAt: NOW,
    execution: { approvalMode: "request_approval", mode: "agent" },
    id: RUN_ID,
    latestSequence: 1,
    provider: {
      apiStyle: "openai-compatible",
      modelId: "gpt-5.6-sol",
      profileId: "10000000-0000-4000-8000-000000000007",
      profileName: "Test",
    },
    startedAt: NOW,
    status: "running",
  };
  let currentRun = run;
  const runs = {
    getRun: (runId: string) => (runId === RUN_ID ? currentRun : undefined),
  } as unknown as RunRepository;
  const observability = new RuntimeObservability(runs, logger());
  const approval: Approval = {
    expiresAt: "9999-12-31T23:59:59.999Z",
    id: APPROVAL_ID,
    itemId: TOOL_ITEM_ID,
    parameterSummary: "写入 notes.txt",
    requestedAt: NOW,
    runId: RUN_ID,
    status: "pending",
    toolName: "file.write",
  };

  observability.record(envelope(1, { run, type: "run.started" }));
  observability.record(
    envelope(2, {
      item: item(ITEM_ID, "assistant_message", 12, undefined, {
        apiKey: "sk-never-observe-this",
        usage: {
          cachedInputTokens: 40,
          inputTokens: 100,
          outputTokens: 20,
        },
      }),
      type: "item.completed",
    }),
  );
  observability.record(
    envelope(3, {
      item: item(
        TOOL_ITEM_ID,
        "file_change",
        25,
        { toolName: "file.write" },
        { status: "success" },
      ),
      type: "item.completed",
    }),
  );
  observability.record(
    envelope(4, {
      item: item(CONTEXT_ITEM_ID, "context_compaction", 4),
      type: "item.completed",
    }),
  );
  observability.record(envelope(5, { approval, type: "approval.requested" }));
  currentRun = {
    ...run,
    endedAt: NOW,
    latestSequence: 6,
    status: "completed",
  };
  observability.record(envelope(6, { run: currentRun, type: "run.completed" }));
  return observability;
}

describe("Phase 2 runtime observability", () => {
  it("aggregates completed boundaries once and redacts trace payloads", () => {
    const observability = fixture();
    const snapshot = observability.snapshot();

    expect(snapshot.runs).toBe(1);
    expect(snapshot.approvals).toBe(1);
    expect(snapshot.contextCompactions).toBe(1);
    expect(snapshot.inputTokens).toBe(100);
    expect(snapshot.cachedInputTokens).toBe(40);
    expect(snapshot.outputTokens).toBe(20);
    expect(snapshot.tools).toEqual([
      {
        calls: 1,
        errors: 0,
        p50Ms: 25,
        p95Ms: 25,
        toolName: "file.write",
      },
    ]);
    const modelTrace = snapshot.traces.find(({ type }) => type === "model");
    expect(modelTrace?.payload).toMatchObject({ apiKey: "[REDACTED]" });
    expect(JSON.stringify(snapshot)).not.toContain("sk-never-observe-this");
    expect(
      observability.snapshot({ toolName: "file.write" }).traces,
    ).toHaveLength(2);
  });

  it("serves the read-only loopback dashboard and API filters", async () => {
    const dashboard = new DevDashboard(fixture());
    const baseUrl = await dashboard.start();
    try {
      const html = await fetch(baseUrl).then((response) => response.text());
      expect(html).toContain("CharaMate Dev Dashboard");
      const response = await fetch(
        new URL("/dev/api/events?toolName=file.write", baseUrl),
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('"toolName":"file.write"');
      expect(body).not.toContain('"type":"model"');
    } finally {
      await dashboard.close();
    }
  });
});
