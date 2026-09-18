import { describe, expect, it, vi } from "vitest";
import type {
  CognitionEvidence,
  CognitionMemoryHandoff,
} from "../../shared/contracts/cognition";
import type { MemoryFormationSource } from "../../shared/contracts/memoryRecall";
import { cognitionMemoryIntake } from "./cognitionMemoryIntake";
import type { MemorySourceResolution } from "./memoryFormationSources";

const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const now = "2026-09-15T07:00:00.000Z";
function fixture() {
  const evidence: CognitionEvidence[] = Array.from({ length: 4 }, (_, n) => ({
    id: id(n + 1),
    personaId: id(90),
    actor: n === 1 ? "agent" : "user",
    kind: n === 1 ? "effect" : "utterance",
    source: { kind: "run", id: id(40), fragment: id(50 + n) },
    text: "认知摘要不能替代原话",
    observedAt: now,
    receivedAt: now,
    receiptSequence: n + 1,
  }));
  const sources: MemoryFormationSource[] = evidence.map((e, n) => ({
    id: id(100 + n),
    referenceId: id(40),
    type: n === 1 ? "tool" : "chat",
    speaker: n === 1 ? "tool" : "user",
    content: [
      "教程是帮表妹看的，我自己喜欢冲洗胶片。",
      '{"status":"ok","summary":"已收藏，未放入房间"}',
      "昨天不喜欢香菜。",
      '我命名为 "小灯"。\n路径 C:\\notes。',
    ][n]!,
    occurredAt: now,
  }));
  const handoff: CognitionMemoryHandoff = {
    id: id(80),
    personaId: id(90),
    situationId: id(91),
    committedAt: now,
    primaryEvidenceIds: [id(1), id(2)],
    historyEvidenceIds: [],
    contextGroups: [],
  };
  const read = vi.fn((_h: CognitionMemoryHandoff, ids: readonly string[]) =>
    evidence.filter((e) => ids.includes(e.id)),
  );
  const context = vi.fn<
    (
      handoff: CognitionMemoryHandoff,
      ids: readonly string[],
    ) => CognitionEvidence[]
  >(() => []);
  const describeSource = vi.fn(
    (e: CognitionEvidence): MemorySourceResolution => {
      const raw = sources[evidence.findIndex(({ id }) => id === e.id)];
      if (!raw) return { kind: "unsupported" };
      const { id, type, referenceId, speaker, occurredAt } = raw;
      const source = { id, type, referenceId, speaker, occurredAt };
      return { kind: "available", source };
    },
  );
  const resolve = vi.fn(
    (e: CognitionEvidence) =>
      sources[evidence.findIndex(({ id }) => id === e.id)],
  );
  const cognition = {
    memoryHandoffEvidence: read,
    memoryHandoffContext: context,
  };
  const intake = () =>
    cognitionMemoryIntake(handoff, cognition, describeSource, resolve);
  return {
    evidence,
    sources,
    handoff,
    read,
    context,
    describeSource,
    resolve,
    intake,
  };
}

describe("Cognition canonical Memory intake", () => {
  it("freezes attributed references and resolves original text only on demand", () => {
    const f = fixture();
    const work = f.intake()!;
    expect(f.resolve).not.toHaveBeenCalled();
    expect([...work.sources()]).toEqual([
      { sourceId: id(100), primary: true },
      { sourceId: id(101), primary: true },
    ]);
    expect(work.resolveSource(id(100))).toEqual(f.sources[0]);
    expect(work.resolveSource(id(101))?.content).toContain("未放入房间");
    expect(work.resolveSource(id(999))).toBeUndefined();
    expect(JSON.stringify(work)).not.toContain("认知摘要");
  });
  it("keeps episode identity stable across ordering, handoff and summary changes", () => {
    const f = fixture();
    const first = f.intake()!;
    f.handoff.primaryEvidenceIds.reverse();
    f.handoff.id = id(81);
    f.evidence.reverse();
    f.evidence.forEach((e) => {
      e.text = "另一种解释";
    });
    // Resolve by source identity, independently of metadata iteration order.
    f.describeSource.mockImplementation((e) => ({
      kind: "available",
      source: {
        id: e.id === id(1) ? id(100) : id(101),
        referenceId: id(40),
        type: e.kind === "effect" ? "tool" : "chat",
        speaker: e.kind === "effect" ? "tool" : "user",
        occurredAt: now,
      },
    }));
    expect(f.intake()?.episode).toEqual(first.episode);
  });
  it("uses history and earlier context without counting them as fresh confirmation", () => {
    const f = fixture();
    f.handoff.primaryEvidenceIds = [id(2)];
    f.handoff.historyEvidenceIds = [id(3)];
    f.context.mockReturnValue([f.evidence[0]!, f.evidence[1]!]);
    const work = f.intake()!;
    expect([...work.sources()]).toEqual([
      { sourceId: id(100), primary: false },
      { sourceId: id(101), primary: true },
      { sourceId: id(102), primary: false },
    ]);
    expect(f.context).toHaveBeenCalledWith(f.handoff, [id(2)]);
    expect(work.episode.recordedAt).toBe(f.sources[1]!.occurredAt);
  });
  it("only canonical accepted anchors determine context and rejects missing evidence", () => {
    const f = fixture();
    f.describeSource.mockImplementation((e) =>
      e.id === id(2)
        ? { kind: "unsupported" }
        : { kind: "available", source: f.sources[0]! },
    );
    f.intake();
    expect(f.context).toHaveBeenCalledWith(f.handoff, [id(1)]);
    f.read.mockReturnValue([f.evidence[0]!]);
    expect(() => f.intake()).toThrow("Original source is unavailable");
  });
  it("keeps missing sources distinguishable from ineligible material", () => {
    const f = fixture();
    f.describeSource.mockReturnValue({ kind: "unsupported" });
    expect(f.intake()).toBeUndefined();
    expect(f.context).not.toHaveBeenCalled();
    f.describeSource.mockReturnValue({ kind: "missing", reference: id(30) });
    expect(() => f.intake()).toThrow(id(30));
  });
  it("preserves exact quoted text and changes work version when references or use change", () => {
    const f = fixture();
    const first = f.intake()!;
    f.handoff.historyEvidenceIds = [id(4)];
    const next = f.intake()!;
    expect(next.episode.id).toBe(first.episode.id);
    expect(next.episode.version).not.toBe(first.episode.version);
    expect(next.resolveSource(id(103))?.content).toBe(f.sources[3]!.content);
    const quoted = next.resolveSource(id(103))!;
    expect(quoted.content).toBe('我命名为 "小灯"。\n路径 C:\\notes。');
  });
});
