import { describe, expect, it, vi } from "vitest";

import type { Run } from "../../shared/contracts/run";
import { ToolRegistry } from "../tools/toolRegistry";
import {
  COMPANIONSHIP_UPDATE_TOOL_NAME,
  registerCompanionshipTool,
} from "./companionshipTool";
import type { JourneyService } from "./journeyService";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const CHAT_ID = "33333333-3333-4333-8333-333333333333";
const JOURNEY_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-08-13T09:00:00.000Z";

const run: Run = {
  chatId: CHAT_ID,
  createdAt: NOW,
  execution: { mode: "chat" },
  id: RUN_ID,
  latestSequence: 1,
  provider: {
    apiStyle: "openai-compatible",
    modelId: "gpt-example",
    profileId: "66666666-6666-4666-8666-666666666666",
    profileName: "Test provider",
  },
  source: "text",
  startedAt: NOW,
  status: "running",
};

const emptyInput = {
  content: null,
  currentPosition: null,
  followUpAt: null,
  followUpMessage: null,
  journeyId: null,
  nextStep: null,
  purpose: null,
  recap: null,
  resumeNote: null,
  sessionId: null,
  title: null,
};

function context() {
  return {
    availableToolNames: [COMPANIONSHIP_UPDATE_TOOL_NAME],
    itemId: ITEM_ID,
    onDelta: () => undefined,
    providerProfileId: run.provider.profileId,
    runId: RUN_ID,
    signal: new AbortController().signal,
  };
}

describe("companionship.update", () => {
  it("creates a Journey in the source Chat and uses the Tool item as its idempotency key", async () => {
    const createJourney = vi.fn(() => ({
      createdAt: NOW,
      homeChatId: CHAT_ID,
      id: ITEM_ID,
      purpose: "完成毕业论文",
      status: "active" as const,
      title: "毕业论文",
      updatedAt: NOW,
    }));
    const registry = new ToolRegistry();
    registerCompanionshipTool(registry, {
      getRun: () => run,
      journeys: { createJourney } as unknown as JourneyService,
    });

    const result = await registry.execute(
      COMPANIONSHIP_UPDATE_TOOL_NAME,
      {
        ...emptyInput,
        action: "create_journey",
        purpose: "完成毕业论文",
        sessionId: SESSION_ID,
        title: "毕业论文",
      },
      context(),
    );

    expect(result).toMatchObject({
      status: "success",
      summary:
        "Internal companionship state updated. Do not mention this tool result to the user.",
    });
    expect(createJourney).toHaveBeenCalledWith({
      homeChatId: CHAT_ID,
      operationId: ITEM_ID,
      purpose: "完成毕业论文",
      sessionId: SESSION_ID,
      title: "毕业论文",
    });
    expect(result.modelContent).toMatchObject({
      action: "create_journey",
      navigateChatId: CHAT_ID,
    });
  });

  it("starts a Session only through the supplied semantic action and preserves exact IDs", async () => {
    const startSession = vi.fn(() => ({
      chatId: CHAT_ID,
      createdAt: NOW,
      id: ITEM_ID,
      journeyId: JOURNEY_ID,
      status: "active" as const,
      title: "一起整理研究问题",
      updatedAt: NOW,
    }));
    const registry = new ToolRegistry();
    registerCompanionshipTool(registry, {
      getRun: () => run,
      journeys: { startSession } as unknown as JourneyService,
    });

    const result = await registry.execute(
      COMPANIONSHIP_UPDATE_TOOL_NAME,
      {
        ...emptyInput,
        action: "start_session",
        journeyId: JOURNEY_ID,
        title: "一起整理研究问题",
      },
      context(),
    );

    expect(startSession).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      journeyId: JOURNEY_ID,
      operationId: ITEM_ID,
      title: "一起整理研究问题",
    });
    expect(result.modelContent).toMatchObject({
      action: "start_session",
      session: { journeyId: JOURNEY_ID },
    });
  });

  it("requires the full flat schema and a real source Run", async () => {
    const registry = new ToolRegistry();
    registerCompanionshipTool(registry, {
      getRun: () => undefined,
      journeys: {} as JourneyService,
    });

    await expect(
      registry.execute(
        COMPANIONSHIP_UPDATE_TOOL_NAME,
        {
          action: "pause_session",
          sessionId: SESSION_ID,
        },
        context(),
      ),
    ).rejects.toThrow(
      `Invalid arguments for ${COMPANIONSHIP_UPDATE_TOOL_NAME}`,
    );
    await expect(
      registry.execute(
        COMPANIONSHIP_UPDATE_TOOL_NAME,
        {
          ...emptyInput,
          action: "pause_session",
          sessionId: SESSION_ID,
        },
        context(),
      ),
    ).rejects.toThrow("Companionship source Run is unavailable");
  });
});
