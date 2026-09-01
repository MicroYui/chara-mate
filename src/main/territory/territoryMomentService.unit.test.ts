import { describe, expect, it, vi } from "vitest";

import { DEFAULT_COMPANION_INITIATIVE_SETTINGS } from "../../shared/contracts/settings";
import type { TerritoryCreateChangeCandidateRequest } from "../../shared/contracts/territoryWorld";
import { defaultPersonaSnapshot } from "../persona/personaPresets";
import { TerritoryMomentService } from "./territoryMomentService";

const now = "2026-09-01T09:00:00.000Z";
const runId = "10000000-0000-4000-8000-000000000001";
const chatId = "10000000-0000-4000-8000-000000000002";
const messageId = "10000000-0000-4000-8000-000000000003";
const attachmentId = "10000000-0000-4000-8000-000000000004";
const candidateId = "10000000-0000-4000-8000-000000000005";
const revisionId = "10000000-0000-4000-8000-000000000006";
const zoneId = "10000000-0000-4000-8000-000000000007";

describe("TerritoryMomentService", () => {
  it("binds a completed in-Run proposal to immutable host provenance", () => {
    const beginCreateMoment = vi.fn(() => ({
      completion: Promise.resolve({ candidateId, snapshot: {} }),
      initial: { candidateId, snapshot: {} },
    }));
    const service = new TerritoryMomentService(
      {
        getRun: () => ({
          chatId,
          createdAt: now,
          endedAt: now,
          execution: { mode: "chat" },
          id: runId,
          latestSequence: 5,
          persona: defaultPersonaSnapshot(now),
          provider: {
            apiStyle: "openai-compatible",
            modelId: "model",
            profileId: "10000000-0000-4000-8000-000000000008",
            profileName: "Provider",
          },
          source: "text",
          startedAt: now,
          status: "completed",
        }),
        listRunItems: () => [
          {
            artifacts: [],
            id: "10000000-0000-4000-8000-000000000009",
            input: {
              arguments: {
                description: "紧张过后，还能抬头看见傍晚。",
                name: "散场后的余光",
                visualPrompt: "sunset light held by a small glass object",
              },
              callId: "moment-1",
              toolName: "territory.propose_moment",
            },
            kind: "tool_call",
            runId,
            sequence: 3,
            status: "completed",
          },
        ],
        listRunsByStatus: () => [],
      },
      {
        getSnapshot: () => ({
          attachments: [
            {
              byteLength: 128,
              chatId,
              createdAt: now,
              displayName: "sunset.jpg",
              id: attachmentId,
              kind: "image",
              mediaType: "image/jpeg",
              messageId,
              sha256:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              storageKey: "/private/path/sunset.jpg",
            },
          ],
          chat: {
            createdAt: now,
            id: chatId,
            isProvisional: false,
            status: "active",
            title: "分享结束",
            updatedAt: now,
          },
          messages: [],
        }),
        listRunMessages: () => [
          {
            chatId,
            content: "分享结束了",
            createdAt: now,
            id: messageId,
            role: "user",
            runId,
            status: "completed",
            updatedAt: now,
          },
        ],
      },
      { get: () => undefined },
      {
        getSnapshot: () =>
          ({
            world: {
              activeZoneId: zoneId,
              currentRevision: { id: revisionId },
            },
          }) as never,
      },
      { beginCreateMoment } as never,
      {
        getCompanionInitiative: () => ({
          ...DEFAULT_COMPANION_INITIATIVE_SETTINGS,
          territoryMomentSurprisesEnabled: true,
        }),
      },
      { warn: vi.fn() },
    );

    expect(service.materializeCompletedRun(runId)).toBe(candidateId);
    expect(beginCreateMoment).toHaveBeenCalledTimes(1);
    const [momentKey, request] = beginCreateMoment.mock.calls[0] as unknown as [
      string,
      TerritoryCreateChangeCandidateRequest,
    ];
    expect(momentKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(request).toMatchObject({
      itemContent: {
        description: "紧张过后，还能抬头看见傍晚。",
        name: "散场后的余光",
      },
      sources: [
        {
          attachments: [
            {
              attachmentId,
              displayName: "sunset.jpg",
              mediaType: "image/jpeg",
              sha256:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          ],
          chatId,
          id: momentKey,
          kind: "chat_moment",
          messageId,
          momentKey,
          runId,
        },
      ],
    });
    expect(JSON.stringify(request)).not.toContain("/private/path");
  });

  it("keeps silence when the separate permission is disabled", () => {
    const beginCreateMoment = vi.fn(() => {
      throw new Error("A disabled permission must not create a candidate.");
    });
    const service = new TerritoryMomentService(
      {
        getRun: vi.fn(),
        listRunItems: vi.fn(),
        listRunsByStatus: () => [],
      },
      { getSnapshot: vi.fn(), listRunMessages: vi.fn() },
      { get: vi.fn() },
      { getSnapshot: vi.fn() },
      { beginCreateMoment },
      {
        getCompanionInitiative: () => DEFAULT_COMPANION_INITIATIVE_SETTINGS,
      },
      { warn: vi.fn() },
    );

    expect(service.materializeCompletedRun(runId)).toBeUndefined();
    expect(beginCreateMoment).not.toHaveBeenCalled();
  });
});
