import type { MemoryFormationIntake } from "../../shared/contracts/memoryRecall";
import type { Run } from "../../shared/contracts/run";
import type { ChatRepository } from "../chat/chatRepository";
import type { RunRepository } from "../agent/runRepository";
import {
  createMemoryFormationIntake,
  messageMemorySourceMetadata,
  toolMemorySourceMetadata,
  messageMemorySource,
  toolMemorySource,
  type MemorySourceMetadata,
} from "./memoryFormationSources";

/** Only stable references enter the work queue; raw bodies are requested by Memory when missing. */
export function runMemoryIntake(
  run: Run,
  runs: RunRepository,
  chats: ChatRepository,
  throughItemId?: string,
): MemoryFormationIntake | undefined {
  const through = throughItemId
    ? runs.getRunItemSourceReference(throughItemId)
    : undefined;
  if (throughItemId && (!through || through.runId !== run.id))
    throw new Error("Memory formation boundary item is unavailable");
  const suppliedRunIds = new Set<string>([run.id]);
  const sources: Array<{ source: MemorySourceMetadata; primary: boolean }> = [];
  const resolvers = new Map<
    string,
    () => ReturnType<typeof messageMemorySource>
  >();
  for (const message of chats.memoryFormationMessageReferences(run.id)) {
    if (through && message.createdAt > (through.startedAt ?? run.createdAt))
      continue;
    const sourceRun =
      message.runId === run.id
        ? run
        : message.runId
          ? runs.getRunSourceReference(message.runId)
          : undefined;
    const source = sourceRun
      ? messageMemorySourceMetadata(sourceRun, message)
      : undefined;
    if (!source || !sourceRun) continue;
    suppliedRunIds.add(sourceRun.id);
    sources.push({ source, primary: message.runId === run.id });
    resolvers.set(source.id, () => {
      const original = chats.getMessage(source.id);
      return original ? messageMemorySource(sourceRun, original) : undefined;
    });
  }
  for (const item of runs.memoryFormationItemReferences(run.id)) {
    if (through && item.sequence >= through.sequence) break;
    const source = toolMemorySourceMetadata(run, item);
    if (!source) continue;
    sources.push({ source, primary: true });
    resolvers.set(source.id, () => {
      const original = runs.getRunItem(source.id);
      return original ? toolMemorySource(run, original) : undefined;
    });
  }
  return createMemoryFormationIntake({
    id: run.id,
    personaId: run.persona.personaId,
    availableMemoryReferences: [...suppliedRunIds].flatMap((id) =>
      runs.suppliedMemoryReferences(
        id,
        id === run.id ? through?.sequence : undefined,
      ),
    ),
    sources,
    resolveSource: (id) => resolvers.get(id)?.(),
  });
}
