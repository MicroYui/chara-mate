import type { ToolResult } from "../../shared/contracts/tool";
import { VOICE_END_TOOL_NAME } from "../../shared/contracts/voice";
import type { ToolRegistry } from "../tools/toolRegistry";

interface VoiceToolDependencies {
  readonly requestEndAfterResponse: (runId: string) => void;
}

function scheduledEndResult(): ToolResult {
  return {
    artifacts: [],
    modelContent: {
      endAfterResponse: true,
      instruction:
        "Say one brief natural goodbye now. Do not call another tool or continue the conversation.",
    },
    retryable: false,
    status: "success",
    summary: "将在简短告别播放完毕后结束语音",
  };
}

export function registerVoiceTools(
  registry: ToolRegistry,
  dependencies: VoiceToolDependencies,
): void {
  registry.register({
    descriptor: {
      description:
        'End the current live voice call after one brief spoken goodbye. Call only when the user explicitly asks to hang up or clearly closes this call, for example "拜拜", "你挂了吧", "结束通话", or "hang up". Do not call merely because an answer is complete or when the user discusses goodbye without ending this call.',
      effect: "write",
      idempotency: "idempotent",
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      itemKind: "tool_call",
      name: VOICE_END_TOOL_NAME,
      namespace: "voice",
      source: "builtin",
      summary: "结束当前语音通话",
    },
    execute: (_input, context) => {
      dependencies.requestEndAfterResponse(context.runId);
      return Promise.resolve(scheduledEndResult());
    },
    summarize: () => "结束当前语音通话",
  });
}
