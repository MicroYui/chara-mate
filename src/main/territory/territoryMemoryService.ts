import type { ActivityService } from "../activity/activityService";
import type { MemoryService } from "../memory/memoryService";
import { ActivityError } from "../activity/activityError";
import { MemoryError } from "../memory/memoryError";
import type { ActivityDigest } from "../../shared/contracts/activity";
import type { MemoryDetail, MemoryType } from "../../shared/contracts/memory";
import type {
  TerritoryCreateSourceCandidateRequest,
  TerritoryItemCandidate,
  TerritoryItemSource,
  TerritorySourceCandidateMutationResult,
} from "../../shared/contracts/territory";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import { TerritoryError } from "./territoryError";
import type { TerritoryRepository } from "./territoryRepository";
import type { TerritoryService } from "./territoryService";

const memoryCandidateNames: Readonly<Record<MemoryType, string>> = {
  activity_digest: "走过的日子",
  agent_learning: "共同学会的事",
  commitment: "记得要做的事",
  event: "某一天的微光",
  preference: "喜欢的事",
  procedure: "熟悉的做法",
  profile: "关于你的记忆",
  project: "一起完成的项目",
};

export class TerritoryMemoryService {
  constructor(
    private readonly repository: TerritoryRepository,
    private readonly territory: TerritoryService,
    private readonly memory: Pick<MemoryService, "get">,
    private readonly activity: Pick<ActivityService, "getDigest">,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  createSourceCandidate(
    request: TerritoryCreateSourceCandidateRequest,
  ): TerritorySourceCandidateMutationResult {
    const now = this.clock.now();
    const sceneId = this.repository.getActiveScene()?.sceneId ?? "forest-cabin";
    let source: TerritoryItemSource;
    let name: string;
    let description: string;
    let visualPrompt: string;

    if (request.source.kind === "memory") {
      let detail: MemoryDetail;
      try {
        detail = this.memory.get(request.source.memoryId);
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
      source = {
        id: detail.memory.id,
        kind: "memory",
        label: revision.content,
        occurredAt: revision.createdAt,
        revisionId: revision.id,
      };
      name = memoryCandidateNames[detail.memory.type];
      description = `把“${revision.content}”留成一件安静的小纪念。`;
      visualPrompt = `用一个温暖、可辨认的像素风小物象征这段记忆：${revision.content}`;
    } else {
      let digest: ActivityDigest;
      try {
        digest = this.activity.getDigest(request.source.digestId);
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
      source = {
        id: digest.id,
        kind: "activity_digest",
        label: `${digest.title}：${digest.summary}`,
        occurredAt: digest.periodEnd,
        revisionId: null,
      };
      name = digest.title;
      description = `把“${digest.title}”这段时间的脉络留成一件安静的小纪念。`;
      visualPrompt = `用一个温暖、可辨认的像素风小物象征这段活动脉络：${digest.summary}`;
    }

    const candidate: TerritoryItemCandidate = {
      createdAt: now,
      description,
      id: this.ids.generate(),
      itemId: null,
      name,
      sources: [source],
      status: "pending",
      suggestedSceneId: sceneId,
      updatedAt: now,
      visualPrompt,
    };
    const stored = this.repository.saveItemCandidate(candidate);
    return { candidateId: stored.id, snapshot: this.territory.getSnapshot() };
  }
}
