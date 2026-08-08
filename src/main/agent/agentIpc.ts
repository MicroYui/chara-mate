import { ipcMain } from "electron";

import { AGENT_CHANNELS } from "../../shared/contracts/agent";
import {
  ResolveApprovalRequestSchema,
  ResolveApprovalResponseSchema,
  ResumeRunRequestSchema,
  RunCancelResponseSchema,
  RunMutationResponseSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  SteerRunRequestSchema,
  PendingApprovalRequestSchema,
  PendingApprovalResponseSchema,
} from "../../shared/schemas/agent";
import { RunCancelRequestSchema } from "../../shared/schemas/run";
import { parseSchema } from "../../shared/schemas/validation";
import { toAgentAppError } from "./agentError";
import type { AgentRuntime } from "./agentRuntime";

export function registerAgentIpc(runtime: AgentRuntime): () => void {
  ipcMain.handle(AGENT_CHANNELS.pendingApproval, (_event, input) => {
    try {
      parseSchema(PendingApprovalRequestSchema, input);
      return parseSchema(PendingApprovalResponseSchema, {
        ok: true,
        value: runtime.getPendingApproval(),
      });
    } catch (error) {
      return parseSchema(PendingApprovalResponseSchema, {
        error: toAgentAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(AGENT_CHANNELS.start, async (_event, input) => {
    try {
      const request = parseSchema(StartRunRequestSchema, input);
      return parseSchema(StartRunResponseSchema, {
        ok: true,
        value: await runtime.start(request),
      });
    } catch (error) {
      return parseSchema(StartRunResponseSchema, {
        error: toAgentAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(AGENT_CHANNELS.steer, (_event, input) => {
    try {
      const request = parseSchema(SteerRunRequestSchema, input);
      return parseSchema(RunMutationResponseSchema, {
        ok: true,
        value: runtime.steer(request),
      });
    } catch (error) {
      return parseSchema(RunMutationResponseSchema, {
        error: toAgentAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(AGENT_CHANNELS.resume, async (_event, input) => {
    try {
      const request = parseSchema(ResumeRunRequestSchema, input);
      return parseSchema(RunMutationResponseSchema, {
        ok: true,
        value: await runtime.resume(request),
      });
    } catch (error) {
      return parseSchema(RunMutationResponseSchema, {
        error: toAgentAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(AGENT_CHANNELS.cancel, async (_event, input) => {
    try {
      const request = parseSchema(RunCancelRequestSchema, input);
      return parseSchema(RunCancelResponseSchema, {
        ok: true,
        value: await runtime.cancel(request),
      });
    } catch (error) {
      return parseSchema(RunCancelResponseSchema, {
        error: toAgentAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(AGENT_CHANNELS.resolveApproval, (_event, input) => {
    try {
      const request = parseSchema(ResolveApprovalRequestSchema, input);
      return parseSchema(ResolveApprovalResponseSchema, {
        ok: true,
        value: runtime.resolveApproval(request),
      });
    } catch (error) {
      return parseSchema(ResolveApprovalResponseSchema, {
        error: toAgentAppError(error),
        ok: false,
      });
    }
  });

  return () => {
    for (const channel of Object.values(AGENT_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
