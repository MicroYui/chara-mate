import { ipcMain } from "electron";

import { AGENT_CHANNELS } from "../../shared/contracts/agent";
import {
  ResolveApprovalRequestSchema,
  ResolveApprovalResponseSchema,
  ResolveUserInputRequestSchema,
  ResolveUserInputResponseSchema,
  ResumeRunRequestSchema,
  RunCancelResponseSchema,
  RunMutationResponseSchema,
  StartRunSubmissionRequestSchema,
  CancelStartRequestSchema,
  CancelStartResponseSchema,
  StartRunResponseSchema,
  SteerRunRequestSchema,
  PendingApprovalRequestSchema,
  PendingApprovalResponseSchema,
} from "../../shared/schemas/agent";
import { RunCancelRequestSchema } from "../../shared/schemas/run";
import { parseSchema } from "../../shared/schemas/validation";
import { toAgentAppError } from "./agentError";
import type { AgentRuntime } from "./agentRuntime";

type AgentIpcRuntime = Pick<
  AgentRuntime,
  | "cancel"
  | "cancelStart"
  | "getPendingApproval"
  | "resolveApproval"
  | "resolveUserInput"
  | "resume"
  | "start"
  | "steer"
>;

export function registerAgentIpc(runtime: AgentIpcRuntime): () => void {
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
      const { requestId, ...request } = parseSchema(
        StartRunSubmissionRequestSchema,
        input,
      );
      return parseSchema(StartRunResponseSchema, {
        ok: true,
        value: await runtime.start(request, { requestId }),
      });
    } catch (error) {
      return parseSchema(StartRunResponseSchema, {
        error: toAgentAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(AGENT_CHANNELS.cancelStart, async (_event, input) => {
    try {
      const request = parseSchema(CancelStartRequestSchema, input);
      return parseSchema(CancelStartResponseSchema, {
        ok: true,
        value: await runtime.cancelStart(request),
      });
    } catch (error) {
      return parseSchema(CancelStartResponseSchema, {
        ok: false,
        error: toAgentAppError(error),
      });
    }
  });
  ipcMain.handle(AGENT_CHANNELS.steer, async (_event, input) => {
    try {
      const request = parseSchema(SteerRunRequestSchema, input);
      return parseSchema(RunMutationResponseSchema, {
        ok: true,
        value: await runtime.steer(request),
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
  ipcMain.handle(AGENT_CHANNELS.resolveApproval, async (_event, input) => {
    try {
      const request = parseSchema(ResolveApprovalRequestSchema, input);
      return parseSchema(ResolveApprovalResponseSchema, {
        ok: true,
        value: await runtime.resolveApproval(request),
      });
    } catch (error) {
      return parseSchema(ResolveApprovalResponseSchema, {
        error: toAgentAppError(error),
        ok: false,
      });
    }
  });
  ipcMain.handle(AGENT_CHANNELS.resolveUserInput, async (_event, input) => {
    try {
      const request = parseSchema(ResolveUserInputRequestSchema, input);
      return parseSchema(ResolveUserInputResponseSchema, {
        ok: true,
        value: await runtime.resolveUserInput(request),
      });
    } catch (error) {
      return parseSchema(ResolveUserInputResponseSchema, {
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
