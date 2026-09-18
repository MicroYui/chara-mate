import { describe, expect, it, vi } from "vitest";

import {
  attachmentFixture,
  chatFixture,
  messageFixture,
  runFixture,
  runItemFixture,
} from "../../../tests/fixtures/foundationContracts";
import { starterTerritorySnapshot } from "../../../tests/fixtures/territoryWorld";
import { DEFAULT_COMPANION_INITIATIVE_SETTINGS } from "../../shared/contracts/settings";
import type { Message } from "../../shared/contracts/chat";
import type { MemoryEvidenceReference } from "../../shared/contracts/memoryRecall";
import { TerritoryMomentService } from "./territoryMomentService";
import type { TerritoryWorldCandidateService } from "./territoryWorldCandidateService";

const proposal = {
  description: "紧张过后，还能抬头看见傍晚。",
  name: "散场后的余光",
  visualPrompt: "sunset light held by a small glass object",
};

function fixture(enabled = true) {
  const getRun = vi.fn(() => ({ ...runFixture, status: "running" as const }));
  const getMessage = vi.fn<(_id: string) => Message | undefined>(
    () => messageFixture,
  );
  const latestUserMessageId = vi.fn<() => string>(() => messageFixture.id);
  const getRunItem = vi.fn(() => ({
    ...runItemFixture,
    kind: "tool_call" as const,
  }));
  const toolSuppliedMemoryReferences = vi.fn<
    () => MemoryEvidenceReference[] | undefined
  >(() => []);
  const getSnapshot = vi.fn(() => ({
    chat: chatFixture,
    messages: [messageFixture],
    attachments: [attachmentFixture],
  }));
  const getCompanionInitiative = vi.fn(() => ({
    ...DEFAULT_COMPANION_INITIATIVE_SETTINGS,
    territoryMomentSurprisesEnabled: enabled,
  }));
  const createMoment = vi
    .fn<TerritoryWorldCandidateService["createMoment"]>()
    .mockResolvedValue({
      candidateId: starterTerritorySnapshot.candidates[0]!.id,
      snapshot: starterTerritorySnapshot,
    });
  const service = new TerritoryMomentService(
    { getRun, getRunItem, latestUserMessageId, toolSuppliedMemoryReferences },
    { getSnapshot, getMessage },
    { getSnapshot: () => starterTerritorySnapshot },
    { createMoment },
    { getCompanionInitiative },
    { validateEvidenceReferences: vi.fn(() => []) },
  );
  return {
    createMoment,
    getCompanionInitiative,
    getRun,
    getSnapshot,
    getMessage,
    latestUserMessageId,
    toolSuppliedMemoryReferences,
    service,
  };
}

describe("TerritoryMomentService", () => {
  it("binds the current running exchange to immutable host provenance and awaits completion", async () => {
    const { createMoment, service } = fixture();
    const signal = new AbortController().signal;
    await service.createForRun(
      runFixture.id,
      runItemFixture.id,
      proposal,
      signal,
    );
    const [momentKey, request, validate, passedSignal] =
      createMoment.mock.calls[0]!;
    expect(momentKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(passedSignal).toBe(signal);
    expect(validate).not.toThrow();
    expect(request).toMatchObject({
      itemContent: { name: proposal.name, description: proposal.description },
      sources: [
        {
          attachments: [
            {
              attachmentId: attachmentFixture.id,
              sha256: attachmentFixture.sha256,
            },
          ],
          chatId: runFixture.chatId,
          id: momentKey,
          kind: "chat_moment",
          messageId: messageFixture.id,
          momentKey,
          runId: runFixture.id,
        },
      ],
    });
    expect(JSON.stringify(request)).not.toContain(attachmentFixture.storageKey);
  });

  it("does not create a candidate after the user has disabled surprises", async () => {
    const { createMoment, service } = fixture(false);
    await expect(
      service.createForRun(
        runFixture.id,
        runItemFixture.id,
        proposal,
        new AbortController().signal,
      ),
    ).rejects.toThrow("许可已关闭");
    expect(createMoment).not.toHaveBeenCalled();
  });

  it("does not turn a message-free autonomous Run into a user chat moment", async () => {
    const { createMoment, getMessage, service } = fixture();
    getMessage.mockReturnValue(undefined);
    await expect(
      service.createForRun(
        runFixture.id,
        runItemFixture.id,
        proposal,
        new AbortController().signal,
      ),
    ).rejects.toThrow("用户消息来源");
    expect(createMoment).not.toHaveBeenCalled();
  });

  it.each(["permission", "message", "attachment", "steering"] as const)(
    "rechecks %s before a generated result can be applied",
    async (change) => {
      const f = fixture();
      await f.service.createForRun(
        runFixture.id,
        runItemFixture.id,
        proposal,
        new AbortController().signal,
      );
      if (change === "permission")
        f.getCompanionInitiative.mockReturnValue(
          DEFAULT_COMPANION_INITIATIVE_SETTINGS,
        );
      if (change === "message") f.getMessage.mockReturnValue(undefined);
      if (change === "steering")
        f.latestUserMessageId.mockReturnValue("new-turn");
      if (change === "attachment")
        f.getSnapshot.mockReturnValue({
          chat: chatFixture,
          messages: [messageFixture],
          attachments: [],
        });
      expect(f.createMoment.mock.calls[0]![2]).toThrow();
    },
  );
  it("preserves exact current and historical host references, including an empty valid set", async () => {
    const f = fixture();
    const references: MemoryEvidenceReference[] = [
      {
        memoryId: messageFixture.id,
        revisionId: runFixture.id,
        use: "history",
      },
    ];
    f.toolSuppliedMemoryReferences.mockReturnValue(references);
    await f.service.createForRun(
      runFixture.id,
      runItemFixture.id,
      proposal,
      new AbortController().signal,
    );
    expect(f.toolSuppliedMemoryReferences).toHaveBeenCalledWith(
      runFixture.id,
      runItemFixture.id,
    );
    expect(f.createMoment.mock.calls[0]![1].sources).toMatchObject([
      { memoryRevisions: references },
    ]);
    expect(f.createMoment.mock.calls[0]![2]).not.toThrow();
  });
  it("does not create from a missing model-to-tool binding", async () => {
    const f = fixture();
    f.toolSuppliedMemoryReferences.mockReturnValue(undefined);
    await expect(
      f.service.createForRun(
        runFixture.id,
        runItemFixture.id,
        proposal,
        new AbortController().signal,
      ),
    ).rejects.toThrow("用户消息来源");
    expect(f.createMoment).not.toHaveBeenCalled();
  });
});
