import type {
  MemoryHit,
  MemoryListRequest,
} from "../../shared/contracts/memory";

export interface RetrievalPipeline {
  search(query: MemoryListRequest, limit?: number): MemoryHit[];
}
