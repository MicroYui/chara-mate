import { createHash } from "node:crypto";

import type { RunEventEnvelope } from "../../shared/contracts/ipc";
import type { CompanionInitiativeSettings } from "../../shared/contracts/settings";
import type { JsonValue } from "../../shared/contracts/primitives";
import type {
  TerritoryChatMomentAttachment,
  TerritoryChatMomentSourceSnapshot,
  TerritoryCreateChangeCandidateRequest,
} from "../../shared/contracts/territoryWorld";
import type { ChatRepository } from "../chat/chatRepository";
import type { CheckpointRepository } from "../agent/checkpointRepository";
import { decodeRuntimeCheckpoint } from "../agent/runtimeCheckpoint";
import { memoryContextRevisionReferences } from "../agent/memoryContext";
import type { RunRepository } from "../agent/runRepository";
import type { AppLogger } from "../observability/logger";
import type { TerritoryWorldCandidateService } from "./territoryWorldCandidateService";
import type { TerritoryWorldRepository } from "./territoryWorldRepository";
import {
  parseTerritoryMomentProposal,
  TERRITORY_PROPOSE_MOMENT_TOOL_NAME,
} from "./territoryMomentTool";

function inputRecord(
  value: unknown,
): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : undefined;
}

function stableMomentKey(
  runId: string,
  messageId: string,
  attachments: readonly TerritoryChatMomentAttachment[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        attachments: attachments.map(({ attachmentId, sha256 }) => ({
          attachmentId,
          sha256,
        })),
        messageId,
        runId,
        version: 1,
      }),
    )
    .digest("hex");
}

export class TerritoryMomentService {
  constructor(
    private readonly runs: Pick<
      RunRepository,
      "getRun" | "listRunItems" | "listRunsByStatus"
    >,
    private readonly chats: Pick<
      ChatRepository,
      "getSnapshot" | "listRunMessages"
    >,
    private readonly checkpoints: Pick<CheckpointRepository, "get">,
    private readonly territory: Pick<TerritoryWorldRepository, "getSnapshot">,
    private readonly candidates: Pick<
      TerritoryWorldCandidateService,
      "beginCreateMoment"
    >,
    private readonly settings: {
      getCompanionInitiative(): CompanionInitiativeSettings;
    },
    private readonly logger: Pick<AppLogger, "warn">,
  ) {}

  initialize(): void {
    for (const run of this.runs.listRunsByStatus(["completed"])) {
      this.materializeCompletedRun(run.id);
    }
  }

  observeRun(envelope: RunEventEnvelope): void {
    if (envelope.event.type !== "run.completed") return;
    this.materializeCompletedRun(envelope.event.run.id);
  }

  materializeCompletedRun(runId: string): string | undefined {
    try {
      if (
        !this.settings.getCompanionInitiative().territoryMomentSurprisesEnabled
      ) {
        return undefined;
      }
      const run = this.runs.getRun(runId);
      if (!run || run.status !== "completed") return undefined;
      const proposalItem = this.runs.listRunItems(runId).findLast((item) => {
        if (item.kind !== "tool_call" || item.status !== "completed") {
          return false;
        }
        return (
          inputRecord(item.input)?.["toolName"] ===
          TERRITORY_PROPOSE_MOMENT_TOOL_NAME
        );
      });
      const proposalInput = inputRecord(proposalItem?.input)?.["arguments"];
      const proposalRecord = inputRecord(proposalInput);
      if (!proposalRecord) return undefined;
      const proposal = parseTerritoryMomentProposal(proposalRecord);
      const userMessage = this.chats
        .listRunMessages(runId)
        .findLast(
          (message) =>
            message.role === "user" && message.status === "completed",
        );
      if (!userMessage) return undefined;
      const chatSnapshot = this.chats.getSnapshot(run.chatId);
      if (!chatSnapshot) return undefined;
      const messageAttachments = chatSnapshot.attachments.filter(
        ({ messageId }) => messageId === userMessage.id,
      );
      if (messageAttachments.some(({ sha256 }) => !sha256)) {
        this.logger.warn("TERRITORY_MOMENT_ATTACHMENT_UNVERIFIED", {
          messageId: userMessage.id,
          runId,
        });
        return undefined;
      }
      const attachments: TerritoryChatMomentAttachment[] =
        messageAttachments.map((attachment) => ({
          attachmentId: attachment.id,
          displayName: attachment.displayName,
          ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
          sha256: attachment.sha256!,
        }));
      const momentKey = stableMomentKey(runId, userMessage.id, attachments);
      const checkpoint = this.checkpoints.get(runId);
      const memoryRevisions = checkpoint
        ? [
            ...new Map(
              decodeRuntimeCheckpoint(checkpoint.context)
                .input.flatMap(memoryContextRevisionReferences)
                .map((reference) => [
                  `${reference.memoryId}:${reference.revisionId}`,
                  reference,
                ]),
            ).values(),
          ]
        : [];
      const source: TerritoryChatMomentSourceSnapshot = {
        attachments,
        chatId: run.chatId,
        id: momentKey,
        kind: "chat_moment",
        label: proposal.name,
        memoryRevisions,
        messageId: userMessage.id,
        momentKey,
        occurredAt: userMessage.createdAt,
        personaRef: {
          personaId: run.persona.personaId,
          revision: run.persona.revision,
        },
        runId,
      };
      const snapshot = this.territory.getSnapshot();
      const request: TerritoryCreateChangeCandidateRequest = {
        baseRevisionId: snapshot.world.currentRevision.id,
        intent: "item",
        itemContent: {
          description: proposal.description,
          name: proposal.name,
        },
        lockedInstanceIds: [],
        prompt: `${proposal.name}：${proposal.visualPrompt}`,
        providerProfileId: null,
        scope: { kind: "zone", zoneId: snapshot.world.activeZoneId },
        sources: [source],
      };
      const job = this.candidates.beginCreateMoment(momentKey, request);
      void job.completion.catch((error: unknown) => {
        this.logger.warn("TERRITORY_MOMENT_GENERATION_ERROR", {
          error,
          momentKey,
          runId,
        });
      });
      return job.initial.candidateId;
    } catch (error) {
      this.logger.warn("TERRITORY_MOMENT_MATERIALIZE_ERROR", {
        error,
        runId,
      });
      return undefined;
    }
  }
}
