import type {
  TerritoryEditImageRequest,
  TerritoryGenerateImageRequest,
  TerritoryImageCandidate,
  TerritoryImageCandidateIdRequest,
  TerritoryImageMutationResult,
} from "../../shared/contracts/territory";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import {
  TerritoryEditImageRequestSchema,
  TerritoryGenerateImageRequestSchema,
  TerritoryImageCandidateIdRequestSchema,
} from "../../shared/schemas/territory";
import { parseSchema } from "../../shared/schemas/validation";
import type { TerritoryImageProvider } from "../providers/azureImageProvider";
import { ProviderError, toProviderAppError } from "../providers/providerError";
import {
  createGeneratedTerritoryItemManifest,
  generatedStructureFromManifest,
  generatedTerritoryItemId,
  memoryTerritoryItemId,
} from "./territoryGeneratedItem";
import { TerritoryError } from "./territoryError";
import { buildTerritoryImagePrompt } from "./territoryImagePrompt";
import type { TerritoryCandidateImages } from "./territoryCandidateStore";
import type { TerritoryRepository } from "./territoryRepository";
import type { TerritoryService } from "./territoryService";

export interface TerritoryImageRuntimeFactory {
  createImageProvider(profileId: string): Promise<TerritoryImageProvider>;
}

function candidateFailure(error: unknown) {
  if (error instanceof ProviderError) return toProviderAppError(error);
  if (error instanceof TerritoryError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "TERRITORY.IMAGE_PROCESSING_FAILED",
    message: "图片生成失败，请重试。",
    retryable: true,
  } as const;
}

export class TerritoryImageService {
  constructor(
    private readonly repository: TerritoryRepository,
    private readonly images: TerritoryCandidateImages,
    private readonly territory: TerritoryService,
    private readonly runtimes: TerritoryImageRuntimeFactory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  recoverInterruptedCandidates(): number {
    return this.repository.recoverInterruptedImageCandidates(
      {
        code: "TERRITORY.GENERATION_INTERRUPTED",
        message: "上次图片生成被应用退出中断，可以重新尝试。",
        retryable: true,
      },
      this.clock.now(),
    );
  }

  async generate(
    input: TerritoryGenerateImageRequest,
    signal?: AbortSignal,
  ): Promise<TerritoryImageMutationResult> {
    const request = parseSchema(TerritoryGenerateImageRequestSchema, input);
    const now = this.clock.now();
    const itemCandidate = request.itemCandidateId
      ? this.repository.getItemCandidate(request.itemCandidateId)
      : undefined;
    if (request.itemCandidateId && !itemCandidate) {
      throw new TerritoryError(
        "TERRITORY.CANDIDATE_NOT_FOUND",
        "找不到这个记忆物件候选。",
        false,
      );
    }
    let structure = request.structure ?? null;
    if (itemCandidate?.itemId) {
      if (request.structure) {
        throw new TerritoryError(
          "TERRITORY.INVALID_CANDIDATE_STATE",
          "已有记忆物件的新版本会沿用原有尺寸、占地和插槽。",
          false,
        );
      }
      const item = this.repository.getItem(itemCandidate.itemId);
      if (!item) {
        throw new TerritoryError(
          "TERRITORY.INVALID_CANDIDATE_STATE",
          "记忆候选对应的领地物件不存在。",
          false,
        );
      }
      structure = generatedStructureFromManifest(item.manifest);
    }
    const candidate: TerritoryImageCandidate = {
      acceptedItemId: null,
      createdAt: now,
      description: request.description.trim(),
      editInstruction: null,
      error: null,
      id: this.ids.generate(),
      itemCandidateId: request.itemCandidateId ?? null,
      name: request.name.trim(),
      operation: "generate",
      providerProfileId: request.providerProfileId,
      sceneId: request.sceneId,
      sourceCandidateId: null,
      sourceSnapshots: itemCandidate?.sources ?? [],
      status: "generating",
      structure,
      updatedAt: now,
      visualPrompt: request.visualPrompt.trim(),
    };
    createGeneratedTerritoryItemManifest(candidate);
    this.repository.createImageCandidate(candidate);
    return this.execute(candidate.id, signal);
  }

  async edit(
    input: TerritoryEditImageRequest,
    signal?: AbortSignal,
  ): Promise<TerritoryImageMutationResult> {
    const request = parseSchema(TerritoryEditImageRequestSchema, input);
    const source = this.requireCandidate(request.candidateId);
    if (source.status !== "ready" && source.status !== "accepted") {
      throw new TerritoryError(
        "TERRITORY.INVALID_CANDIDATE_STATE",
        "只有已有预览的图片候选可以继续修改。",
        false,
      );
    }
    const now = this.clock.now();
    const candidate: TerritoryImageCandidate = {
      acceptedItemId: null,
      createdAt: now,
      description: source.description,
      editInstruction: request.instruction.trim(),
      error: null,
      id: this.ids.generate(),
      itemCandidateId: source.itemCandidateId,
      name: source.name,
      operation: "edit",
      providerProfileId: source.providerProfileId,
      sceneId: source.sceneId,
      sourceCandidateId: source.id,
      sourceSnapshots: source.sourceSnapshots ?? [],
      status: "generating",
      structure: source.structure,
      updatedAt: now,
      visualPrompt: source.visualPrompt,
    };
    this.repository.createImageCandidate(candidate);
    return this.execute(candidate.id, signal);
  }

  async retry(
    input: TerritoryImageCandidateIdRequest,
    signal?: AbortSignal,
  ): Promise<TerritoryImageMutationResult> {
    const request = parseSchema(TerritoryImageCandidateIdRequestSchema, input);
    this.requireCandidate(request.candidateId);
    this.repository.retryImageCandidate(request.candidateId, this.clock.now());
    return this.execute(request.candidateId, signal);
  }

  async confirm(
    input: TerritoryImageCandidateIdRequest,
  ): Promise<TerritoryImageMutationResult> {
    const request = parseSchema(TerritoryImageCandidateIdRequestSchema, input);
    const candidate = this.requireCandidate(request.candidateId);
    if (candidate.status === "accepted") {
      return {
        candidateId: candidate.id,
        snapshot: this.territory.getSnapshot(),
      };
    }
    if (candidate.status !== "ready") {
      throw new TerritoryError(
        "TERRITORY.INVALID_CANDIDATE_STATE",
        "图片生成完成后才能加入收藏库。",
        false,
      );
    }

    const root = this.rootCandidate(candidate);
    const itemId = candidate.itemCandidateId
      ? memoryTerritoryItemId(candidate.itemCandidateId)
      : generatedTerritoryItemId(root.id);
    const assetId = generatedTerritoryItemId(candidate.id);
    const revision =
      this.repository.findDefinitionRevisionByAsset(itemId, assetId) ??
      this.repository.nextDefinitionRevision(itemId);

    await this.territory.installGeneratedItem({
      itemId,
      manifest: createGeneratedTerritoryItemManifest(candidate, {
        assetId,
        definitionId: itemId,
        revision,
      }),
      sourceImagePath: await this.images.resolve(candidate.id),
    });
    this.repository.acceptImageCandidate(
      candidate.id,
      itemId,
      this.clock.now(),
    );
    return {
      candidateId: candidate.id,
      snapshot: this.territory.getSnapshot(),
    };
  }

  private async execute(
    candidateId: string,
    signal?: AbortSignal,
  ): Promise<TerritoryImageMutationResult> {
    const candidate = this.requireCandidate(candidateId);
    if (candidate.status !== "generating") {
      throw new TerritoryError(
        "TERRITORY.INVALID_CANDIDATE_STATE",
        "图片候选当前没有等待执行的请求。",
        false,
      );
    }
    try {
      const provider = await this.runtimes.createImageProvider(
        candidate.providerProfileId,
      );
      const prompt = buildTerritoryImagePrompt(candidate);
      let generated: Buffer;
      if (candidate.operation === "generate") {
        generated = await provider.generate(prompt, signal);
      } else {
        if (!candidate.sourceCandidateId) {
          throw new TerritoryError(
            "TERRITORY.INVALID_CANDIDATE_STATE",
            "编辑候选缺少来源图片。",
            false,
          );
        }
        generated = await provider.edit(
          await this.images.read(candidate.sourceCandidateId),
          prompt,
          signal,
        );
      }
      await this.images.save(candidate.id, generated);
      this.repository.markImageCandidateReady(candidate.id, this.clock.now());
    } catch (error) {
      this.repository.markImageCandidateFailed(
        candidate.id,
        candidateFailure(error),
        this.clock.now(),
      );
    }
    return { candidateId, snapshot: this.territory.getSnapshot() };
  }

  private requireCandidate(candidateId: string): TerritoryImageCandidate {
    const candidate = this.repository.getImageCandidate(candidateId);
    if (!candidate) {
      throw new TerritoryError(
        "TERRITORY.CANDIDATE_NOT_FOUND",
        "找不到这个图片候选。",
        false,
      );
    }
    return candidate;
  }

  private rootCandidate(
    candidate: TerritoryImageCandidate,
  ): TerritoryImageCandidate {
    let root = candidate;
    const visited = new Set<string>();
    while (root.sourceCandidateId) {
      if (visited.has(root.id)) {
        throw new TerritoryError(
          "TERRITORY.INVALID_CANDIDATE_STATE",
          "图片候选版本链存在循环。",
          false,
        );
      }
      visited.add(root.id);
      root = this.requireCandidate(root.sourceCandidateId);
    }
    return root;
  }
}
