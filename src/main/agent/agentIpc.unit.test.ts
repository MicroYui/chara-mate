import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type CancelStartRequest,
  AGENT_CHANNELS,
} from "../../shared/contracts/agent";
import {
  approvalFixture,
  FIXTURE_TIMESTAMPS,
  runFixture,
} from "../../../tests/fixtures/foundationContracts";
import { AgentError } from "./agentError";
import { ProviderError } from "../providers/providerError";
import { registerAgentIpc } from "./agentIpc";

type IpcHandler = (event: unknown, input: unknown) => unknown;
const electron = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
  };
});
vi.mock("electron", () => ({ ipcMain: electron.ipcMain }));

const approved = {
  ...approvalFixture,
  status: "approved" as const,
  decidedAt: FIXTURE_TIMESTAMPS.updated,
};

function runtime(): Parameters<typeof registerAgentIpc>[0] {
  return {
    cancelStart: ({ requestId }) =>
      Promise.resolve({ requestId, outcome: "not_pending" }),
    cancel: () =>
      Promise.resolve({ outcome: "accepted", runId: runFixture.id }),
    getPendingApproval: () => approvalFixture,
    resolveApproval: () => Promise.resolve(approved),
    resolveUserInput: () => Promise.resolve(runFixture),
    resume: () => Promise.resolve({ runId: runFixture.id }),
    start: () => Promise.resolve(runFixture),
    steer: () => Promise.resolve({ runId: runFixture.id }),
  };
}

beforeEach(() => {
  electron.handlers.clear();
  vi.clearAllMocks();
});

describe("async user continuation IPC", () => {
  it.each(["steer", "approval"] as const)(
    "waits for the actual %s result before validating the existing response JSON",
    async (method) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const value = runtime();
      value.steer = async () => {
        await gate;
        return { runId: runFixture.id };
      };
      value.resolveApproval = async () => {
        await gate;
        return approved;
      };
      const unregister = registerAgentIpc(value);
      const channel =
        method === "steer"
          ? AGENT_CHANNELS.steer
          : AGENT_CHANNELS.resolveApproval;
      const input =
        method === "steer"
          ? {
              runId: runFixture.id,
              requestedAt: FIXTURE_TIMESTAMPS.updated,
              content: "继续刚才的任务。",
            }
          : {
              approvalId: approvalFixture.id,
              decidedAt: FIXTURE_TIMESTAMPS.updated,
              decision: "approved",
            };
      let settled = false;
      const result = Promise.resolve(
        electron.handlers.get(channel)!({}, input),
      ).then((output) => {
        settled = true;
        return output;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      expect(await result).toEqual({
        ok: true,
        value: method === "steer" ? { runId: runFixture.id } : approved,
      });
      unregister();
      expect(electron.handlers.size).toBe(0);
    },
  );

  it.each(["steer", "approval"] as const)(
    "projects a %s rejection after await as the existing typed error response",
    async (method) => {
      const value = runtime();
      const fail = () =>
        Promise.reject(
          new AgentError("AGENT.RUN_NOT_ACTIVE", "原 Run 已变化。", false),
        );
      value.steer = fail;
      value.resolveApproval = fail;
      const unregister = registerAgentIpc(value);
      const channel =
        method === "steer"
          ? AGENT_CHANNELS.steer
          : AGENT_CHANNELS.resolveApproval;
      const input =
        method === "steer"
          ? {
              runId: runFixture.id,
              requestedAt: FIXTURE_TIMESTAMPS.updated,
              content: "继续刚才的任务。",
            }
          : {
              approvalId: approvalFixture.id,
              decidedAt: FIXTURE_TIMESTAMPS.updated,
              decision: "approved",
            };
      expect(await electron.handlers.get(channel)!({}, input)).toEqual({
        ok: false,
        error: {
          code: "AGENT.RUN_NOT_ACTIVE",
          message: "原 Run 已变化。",
          retryable: false,
        },
      });
      unregister();
    },
  );
});

it.each([
  {
    code: "PROVIDER.CONTEXT_LIMIT_EXCEEDED",
    message: "完整输入超过当前模型限额。",
    retryable: false,
  },
  {
    code: "PROVIDER.UNAVAILABLE",
    message: "Provider 服务暂时不可用（HTTP 503）。",
    retryable: true,
  },
] as const)(
  "preserves $code before any Run exists",
  async ({ code, message, retryable }) => {
    const value = runtime();
    value.start = () =>
      Promise.reject(new ProviderError(code, message, retryable));
    const unregister = registerAgentIpc(value);
    try {
      expect(
        await electron.handlers.get(AGENT_CHANNELS.start)!(
          {},
          {
            requestId: "20000000-0000-4000-8000-000000000001",
            attachments: [],
            chatId: runFixture.chatId,
            content: "继续聊聊。",
            execution: { mode: "chat" },
            providerProfileId: runFixture.provider.profileId,
            requestedAt: FIXTURE_TIMESTAMPS.created,
          },
        ),
      ).toEqual({ ok: false, error: { code, message, retryable } });
    } finally {
      unregister();
    }
  },
);

it("passes submission identity outside the Run payload and waits for cancelStart", async () => {
  const value = runtime();
  value.start = vi.fn(() => Promise.resolve(runFixture));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  value.cancelStart = vi.fn(async ({ requestId }: CancelStartRequest) => {
    await gate;
    return { requestId, outcome: "accepted" as const };
  });
  const unregister = registerAgentIpc(value);
  const requestId = "20000000-0000-4000-8000-000000000001";
  const request = {
    attachments: [],
    chatId: runFixture.chatId,
    content: "准备消息",
    execution: { mode: "chat" },
    providerProfileId: runFixture.provider.profileId,
    requestedAt: FIXTURE_TIMESTAMPS.created,
  };
  try {
    expect(
      await electron.handlers.get(AGENT_CHANNELS.start)!(
        {},
        { ...request, requestId },
      ),
    ).toEqual({ ok: true, value: runFixture });
    expect(value.start).toHaveBeenCalledWith(request, { requestId });
    let settled = false;
    const stopping = Promise.resolve(
      electron.handlers.get(AGENT_CHANNELS.cancelStart)!(
        {},
        {
          requestId,
          requestedAt: FIXTURE_TIMESTAMPS.updated,
        },
      ),
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await stopping).toEqual({
      ok: true,
      value: { requestId, outcome: "accepted" },
    });
  } finally {
    release();
    unregister();
  }
});
