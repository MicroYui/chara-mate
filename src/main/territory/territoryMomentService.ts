import { createHash } from "node:crypto";

import type { CompanionInitiativeSettings } from "../../shared/contracts/settings";
import type {
  TerritoryCandidateMutationResult,
  TerritoryChatMomentAttachment,
  TerritoryChatMomentSourceSnapshot,
  TerritoryCreateChangeCandidateRequest,
} from "../../shared/contracts/territoryWorld";
import type { ChatRepository } from "../chat/chatRepository";
import type { RunRepository } from "../agent/runRepository";
import type { MemoryService } from "../memory/memoryService";
import { TerritoryError } from "./territoryError";
import type { TerritoryWorldCandidateService } from "./territoryWorldCandidateService";
import type { TerritoryWorldRepository } from "./territoryWorldRepository";
import type { TerritoryMomentProposal } from "./territoryMomentTool";
import { assertTerritoryMemorySources } from "./territoryWorldMemoryService";

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
      | "getRun"
      | "getRunItem"
      | "latestUserMessageId"
      | "toolSuppliedMemoryReferences"
    >,
    private readonly chats: Pick<ChatRepository, "getSnapshot" | "getMessage">,
    private readonly territory: Pick<TerritoryWorldRepository, "getSnapshot">,
    private readonly candidates: Pick<
      TerritoryWorldCandidateService,
      "createMoment"
    >,
    private readonly settings: {
      getCompanionInitiative(): CompanionInitiativeSettings;
    },
    private readonly memory: Pick<MemoryService, "validateEvidenceReferences">,
  ) {}

  async createForRun(
    runId: string,
    itemId: string,
    proposal: TerritoryMomentProposal,
    signal: AbortSignal,
  ): Promise<TerritoryCandidateMutationResult> {
    signal.throwIfAborted();
    this.assertPermission();
    const run = this.runs.getRun(runId);
    const item = this.runs.getRunItem(itemId);
    const messageId =
      item?.runId === runId
        ? this.runs.latestUserMessageId(runId, item.sequence)
        : undefined;
    const userMessage = messageId
      ? this.chats.getMessage(messageId)
      : undefined;
    const memoryRevisions = this.runs.toolSuppliedMemoryReferences(
      runId,
      itemId,
    );
    const chatSnapshot = run ? this.chats.getSnapshot(run.chatId) : undefined;
    if (
      !run ||
      run.status !== "running" ||
      !userMessage ||
      userMessage.status !== "completed" ||
      userMessage.runId !== runId ||
      userMessage.role !== "user" ||
      !chatSnapshot ||
      memoryRevisions === undefined
    ) {
      throw new TerritoryError(
        "TERRITORY.SOURCE_NOT_FOUND",
        "这次领地回响没有有效的用户消息来源。",
        false,
      );
    }
    const messageAttachments = chatSnapshot.attachments.filter(
      ({ messageId }) => messageId === userMessage.id,
    );
    if (messageAttachments.some(({ sha256 }) => !sha256)) {
      throw new TerritoryError(
        "TERRITORY.SOURCE_NOT_FOUND",
        "这次分享的附件还没有可核实的内容。",
        false,
      );
    }
    const attachments: TerritoryChatMomentAttachment[] = messageAttachments.map(
      (attachment) => ({
        attachmentId: attachment.id,
        displayName: attachment.displayName,
        ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
        sha256: attachment.sha256!,
      }),
    );
    const momentKey = stableMomentKey(runId, userMessage.id, attachments);
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
    const assertSourceValid = () => {
      this.assertPermission();
      const currentRun = this.runs.getRun(runId);
      const currentMessage = this.chats.getMessage(userMessage.id);
      const currentChat = this.chats.getSnapshot(run.chatId);
      if (
        !currentRun ||
        currentRun.status !== "running" ||
        !currentMessage ||
        this.runs.latestUserMessageId(runId) !== userMessage.id ||
        currentMessage.status !== "completed" ||
        currentMessage.content !== userMessage.content ||
        !currentChat ||
        currentRun.persona.personaId !== source.personaRef.personaId ||
        currentRun.persona.revision !== source.personaRef.revision ||
        attachments.some(
          (attachment) =>
            !currentChat.attachments.some(
              (entry) =>
                entry.id === attachment.attachmentId &&
                entry.messageId === userMessage.id &&
                entry.sha256 === attachment.sha256,
            ),
        )
      ) {
        throw new TerritoryError(
          "TERRITORY.SOURCE_NOT_FOUND",
          "这次领地回响的消息或附件来源已变化，未应用创作。",
          false,
        );
      }
      assertTerritoryMemorySources(this.memory, run.persona.personaId, [
        source,
      ]);
    };
    const snapshot = this.territory.getSnapshot();
    const request: TerritoryCreateChangeCandidateRequest = {
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: "item",
      itemContent: { description: proposal.description, name: proposal.name },
      lockedInstanceIds: [],
      prompt: `${proposal.name}：${proposal.visualPrompt}`,
      providerProfileId: null,
      scope: { kind: "zone", zoneId: snapshot.world.activeZoneId },
      sources: [source],
    };
    return this.candidates.createMoment(
      momentKey,
      request,
      assertSourceValid,
      signal,
    );
  }

  private assertPermission(): void {
    if (
      !this.settings.getCompanionInitiative().territoryMomentSurprisesEnabled
    ) {
      throw new TerritoryError(
        "TERRITORY.SOURCE_NOT_FOUND",
        "领地惊喜许可已关闭，这次创作没有应用。",
        false,
      );
    }
  }
}
