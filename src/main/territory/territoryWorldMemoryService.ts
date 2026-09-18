import type { ActivityService } from "../activity/activityService";
import { ActivityError } from "../activity/activityError";
import type { MemoryService } from "../memory/memoryService";
import { MemoryError } from "../memory/memoryError";
import type { ActivityDigest } from "../../shared/contracts/activity";
import type { MemoryDetail, MemoryType } from "../../shared/contracts/memory";
import type { MemoryEvidenceReference } from "../../shared/contracts/memoryRecall";
import type {
  TerritoryCandidateMutationResult,
  TerritoryCreateChangeCandidateRequest,
  TerritoryCreateSourceCandidateRequest,
  TerritorySourceSnapshot,
} from "../../shared/contracts/territoryWorld";
import type { Clock } from "../../shared/pure/clock";
import { TerritoryError } from "./territoryError";
import {
  territorySourceItemContent,
  type TerritoryItemContent,
} from "./territoryWorldNarrative";
import type { TerritoryWorldRepository } from "./territoryWorldRepository";
import type {
  TerritoryWorldCandidateJob,
  TerritoryWorldCandidateService,
} from "./territoryWorldCandidateService";

const memoryObjectNames: Readonly<Record<MemoryType, string>> = {
  activity_digest: "走过的日子",
  agent_learning: "共同学会的事",
  commitment: "记得要做的事",
  event: "某一天的微光",
  preference: "喜欢的事",
  procedure: "熟悉的做法",
  profile: "关于你的记忆",
  project: "一起完成的项目",
};

function compactSourceLabel(value: string): string {
  const normalized = value.normalize("NFC").replaceAll(/\s+/gu, " ").trim();
  const characters = [...normalized];
  return characters.length > 120
    ? `${characters.slice(0, 119).join("")}…`
    : normalized;
}

function compactVisualContext(value: string): string {
  const parts = value
    .normalize("NFC")
    .replaceAll(/\s+/gu, " ")
    .split(/[；;]/u)
    .slice(0, 3)
    .join("；")
    .trim();
  const characters = [...parts];
  return characters.length > 240
    ? `${characters.slice(0, 239).join("")}…`
    : parts;
}

/** Memory owns current revision, persona scope and derived-source validity. */
export function assertTerritoryMemorySources(
  memory: Pick<MemoryService, "validateEvidenceReferences">,
  personaId: string,
  sources: readonly TerritorySourceSnapshot[],
): void {
  const byPersona = new Map<string, MemoryEvidenceReference[]>();
  for (const source of sources) {
    const owner =
      source.kind === "chat_moment" ? source.personaRef.personaId : personaId;
    const references = byPersona.get(owner) ?? [];
    if (source.kind === "memory") {
      if (!source.revisionId) {
        throw new TerritoryError(
          "TERRITORY.SOURCE_NOT_FOUND",
          "这次创作缺少有效的记忆版本。",
          false,
        );
      }
      references.push({
        memoryId: source.id,
        revisionId: source.revisionId,
        use: "current",
      });
    } else if (source.kind === "chat_moment") {
      references.push(...source.memoryRevisions);
    }
    if (references.length) byPersona.set(owner, references);
  }
  for (const [owner, references] of byPersona) {
    if (
      memory.validateEvidenceReferences({
        personaId: owner,
        references,
        usage: "grounding",
      }).length
    ) {
      throw new TerritoryError(
        "TERRITORY.SOURCE_NOT_FOUND",
        "这次创作引用的记忆或其依据已变化，未应用旧故事。",
        false,
      );
    }
  }
}

export class TerritoryWorldMemoryService {
  constructor(
    private readonly repository: TerritoryWorldRepository,
    private readonly memory: Pick<
      MemoryService,
      "get" | "validateEvidenceReferences"
    >,
    private readonly activity: Pick<ActivityService, "getDigest">,
    private readonly clock: Clock,
    private readonly activePersonaId: () => string,
    private readonly candidates?: TerritoryWorldCandidateService,
  ) {}

  async createSourceCandidate(
    request: TerritoryCreateSourceCandidateRequest,
  ): Promise<TerritoryCandidateMutationResult> {
    return this.beginSourceCandidate(request).completion;
  }

  beginSourceCandidate(
    request: TerritoryCreateSourceCandidateRequest,
  ): TerritoryWorldCandidateJob {
    const source =
      request.source.kind === "memory"
        ? this.readMemorySource(request.source.memoryId)
        : this.readActivitySource(request.source.digestId);
    const open = this.repository.findOpenCandidateBySource(
      source.snapshot.kind,
      source.snapshot.id,
    );
    const sameRevision = open?.sources.some(
      (entry) =>
        entry.kind === source.snapshot.kind &&
        entry.id === source.snapshot.id &&
        "revisionId" in entry &&
        entry.revisionId === source.snapshot.revisionId,
    );
    if (open && sameRevision) {
      const initial = {
        candidateId: open.id,
        snapshot: this.repository.getSnapshot(),
      };
      return { completion: Promise.resolve(initial), initial };
    }

    const snapshot = this.repository.getSnapshot();
    const existing = this.repository.findInstanceBySource(
      source.snapshot.kind,
      source.snapshot.id,
    );
    const prompt = existing
      ? `为“${source.name}”这个记忆物件生成一个与当前区域协调的新视觉版本：${source.description}`
      : `把“${source.name}”形成一件温暖、可辨认、与当前区域协调的像素风纪念物：${source.description}`;
    const candidateRequest: TerritoryCreateChangeCandidateRequest = {
      baseRevisionId: snapshot.world.currentRevision.id,
      intent: existing ? "selection" : "item",
      itemContent: source.itemContent,
      lockedInstanceIds: [],
      prompt,
      providerProfileId: null,
      scope: existing
        ? {
            instanceIds: [existing.id],
            kind: "entities",
            zoneId: snapshot.world.activeZoneId,
          }
        : { kind: "zone", zoneId: snapshot.world.activeZoneId },
      sources: [source.snapshot],
    };
    if (this.candidates) {
      const job = this.candidates.beginCreate(candidateRequest);
      // Only retire an obsolete preview after the new request was accepted.
      const retiring = open
        ? this.candidates.cancelCandidate(open.id)
        : Promise.resolve();
      return {
        initial: { ...job.initial, snapshot: this.repository.getSnapshot() },
        completion: Promise.all([retiring, job.completion]).then(
          ([, result]) => result,
        ),
      };
    }
    const initial = this.repository.createCandidate(
      candidateRequest,
      this.clock.now(),
    );
    if (open) {
      this.repository.cancelCandidate(open.id, this.clock.now());
      initial.snapshot = this.repository.getSnapshot();
    }
    return { completion: Promise.resolve(initial), initial };
  }

  private readMemorySource(memoryId: string): {
    description: string;
    itemContent: TerritoryItemContent;
    name: string;
    snapshot: Extract<TerritorySourceSnapshot, { kind: "memory" }>;
  } {
    let detail: MemoryDetail;
    try {
      detail = this.memory.get(memoryId);
    } catch (error) {
      if (
        !(error instanceof MemoryError) ||
        error.code !== "MEMORY.NOT_FOUND"
      ) {
        throw error;
      }
      throw new TerritoryError(
        "TERRITORY.SOURCE_NOT_FOUND",
        "找不到这条记忆，无法形成领地物件。",
        false,
      );
    }
    if (detail.memory.deletedAt) {
      throw new TerritoryError(
        "TERRITORY.SOURCE_NOT_FOUND",
        "这条记忆已删除，恢复后才能放入领地。",
        false,
      );
    }
    const revision = detail.revisions.find(
      ({ id }) => id === detail.memory.currentRevisionId,
    );
    if (!revision) {
      throw new TerritoryError(
        "TERRITORY.SOURCE_NOT_FOUND",
        "这条记忆缺少当前版本，无法形成领地物件。",
        false,
      );
    }
    assertTerritoryMemorySources(this.memory, this.activePersonaId(), [
      {
        id: detail.memory.id,
        kind: "memory",
        label: compactSourceLabel(revision.content),
        occurredAt: revision.createdAt,
        revisionId: revision.id,
      },
    ]);
    const itemContent = territorySourceItemContent({
      kind: "memory",
      name: memoryObjectNames[detail.memory.type],
      sourceText: revision.content,
    });
    return {
      description: compactVisualContext(revision.content),
      itemContent,
      name: itemContent.name,
      snapshot: {
        id: detail.memory.id,
        kind: "memory",
        label: compactSourceLabel(revision.content),
        occurredAt: revision.createdAt,
        revisionId: revision.id,
      },
    };
  }

  private readActivitySource(digestId: string): {
    description: string;
    itemContent: TerritoryItemContent;
    name: string;
    snapshot: Extract<TerritorySourceSnapshot, { kind: "activity_digest" }>;
  } {
    let digest: ActivityDigest;
    try {
      digest = this.activity.getDigest(digestId);
    } catch (error) {
      if (
        !(error instanceof ActivityError) ||
        error.code !== "ACTIVITY.DIGEST_NOT_FOUND"
      ) {
        throw error;
      }
      throw new TerritoryError(
        "TERRITORY.SOURCE_NOT_FOUND",
        "找不到这段 Activity 摘要，无法形成领地物件。",
        false,
      );
    }
    const itemContent = territorySourceItemContent({
      kind: "activity_digest",
      name: digest.title,
      sourceText: digest.summary,
    });
    return {
      description: compactVisualContext(digest.summary),
      itemContent,
      name: itemContent.name,
      snapshot: {
        id: digest.id,
        kind: "activity_digest",
        label: digest.title,
        occurredAt: digest.periodEnd,
        revisionId: null,
      },
    };
  }
}
