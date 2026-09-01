import type { AppError } from "../../shared/contracts/run";

export type AgentErrorCode =
  | "AGENT.APPROVAL_NOT_PENDING"
  | "AGENT.ATTACHMENT_INPUT_INVALID"
  | "AGENT.CHECKPOINT_UNAVAILABLE"
  | "AGENT.INPUT_NOT_PENDING"
  | "AGENT.IMAGE_INPUT_INVALID"
  | "AGENT.IMAGE_INPUT_UNAVAILABLE"
  | "AGENT.RUN_NOT_ACTIVE"
  | "AGENT.RUN_NOT_FOUND"
  | "AGENT.RUN_NOT_RESUMABLE"
  | "AGENT.VOICE_SESSION_REQUIRED";

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function toAgentAppError(error: unknown): AppError {
  if (error instanceof AgentError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "AGENT.RUNTIME_FAILED",
    message: "Agent 运行失败，请从最近边界继续。",
    retryable: true,
  };
}
