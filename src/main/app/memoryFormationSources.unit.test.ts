import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../../shared/contracts/activity";
import type { CognitionEvidence } from "../../shared/contracts/cognition";
import type { RunItem } from "../../shared/contracts/run";
import {
  messageFixture,
  runFixture,
  runItemFixture,
} from "../../../tests/fixtures/foundationContracts";
import {
  cognitionMemorySource,
  messageMemorySource,
  toolMemorySource,
  type MemorySourceRecords,
} from "./memoryFormationSources";

const evidence: CognitionEvidence = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  personaId: runFixture.persona.personaId,
  actor: "user",
  kind: "utterance",
  source: { kind: "run", id: runFixture.id, fragment: runItemFixture.id },
  text: "A shortened Cognition view, never the formation source.",
  observedAt: "2026-08-01T08:01:00.000Z",
  receivedAt: "2026-08-01T08:01:00.000Z",
  receiptSequence: 1,
};
function records(item: RunItem): MemorySourceRecords {
  return {
    getRun: () => runFixture,
    getRunItem: () => item,
    getMessage: () => messageFixture,
    getActivityEvent: () => undefined,
  };
}

describe("canonical formation sources", () => {
  it("uses the persisted message identity, text, original channel and timestamp from every entrance", () => {
    const item: RunItem = {
      ...runItemFixture,
      kind: "user_message",
      status: "completed",
      output: { messageId: messageFixture.id },
    };
    expect(cognitionMemorySource(evidence, records(item))).toEqual(
      messageMemorySource(runFixture, messageFixture),
    );
    expect(cognitionMemorySource(evidence, records(item))).toMatchObject({
      id: messageFixture.id,
      content: messageFixture.content,
      occurredAt: messageFixture.createdAt,
    });
    const voice = { ...runFixture, source: "voice" as const };
    expect(
      cognitionMemorySource(evidence, {
        ...records(item),
        getRun: () => voice,
      }),
    ).toEqual(messageMemorySource(voice, messageFixture));
  });

  it("preserves the same actual failed Tool result instead of claiming a completed effect", () => {
    const item: RunItem = {
      ...runItemFixture,
      status: "failed",
      input: { toolName: "territory.generate_item" },
      output: {
        status: "error",
        summary: "image generation failed",
        modelContent: { applied: false },
      },
    };
    const source = cognitionMemorySource(
      { ...evidence, actor: "agent", kind: "effect" },
      records(item),
    );
    expect(source).toEqual(toolMemorySource(runFixture, item));
    expect(source?.content).toContain('"applied":false');
    expect(source?.id).toBe(item.id);
  });

  it.each(["user", "unknown"] as const)(
    "keeps the original %s Activity attribution across close and retention, excluding agent desktop activity",
    (actor) => {
      const event: ActivityEvent = {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        actor,
        startedAt: messageFixture.createdAt,
        details: {
          source: "active_app",
          appName: "Editor",
          windowTitle: "notes.txt",
        },
      };
      const observation: CognitionEvidence = {
        ...evidence,
        kind: "observation",
        actor,
        source: { kind: "activity", id: event.id },
      };
      const source = cognitionMemorySource(observation, {
        ...records(runItemFixture),
        getActivityEvent: () => event,
      });
      expect(source).toMatchObject({
        id: event.id,
        referenceId: event.id,
        type: "activity_event",
        speaker: "environment",
      });
      expect(
        cognitionMemorySource(observation, {
          ...records(runItemFixture),
          getActivityEvent: () => ({ ...event, endedAt: evidence.observedAt }),
        }),
      ).toEqual(source);
      expect(
        cognitionMemorySource(observation, {
          ...records(runItemFixture),
          getActivityEvent: () => undefined,
          getActivitySourceSnapshot: () => source,
        }),
      ).toEqual(source);
      expect(
        cognitionMemorySource(observation, {
          ...records(runItemFixture),
          getActivityEvent: () => undefined,
          getActivitySourceSnapshot: () =>
            source ? { ...source, referenceId: evidence.id } : undefined,
        }),
      ).toBeUndefined();
      expect(
        cognitionMemorySource(
          { ...observation, actor: "agent" },
          { ...records(runItemFixture), getActivityEvent: () => event },
        ),
      ).toBeUndefined();
    },
  );
});
