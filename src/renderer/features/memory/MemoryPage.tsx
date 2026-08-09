import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Map as MapIcon,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  MemoryApi,
  MemoryClaimOperation,
  MemoryClaimSlot,
  MemoryDetail,
  MemoryHit,
  MemoryListRequest,
  MemorySnapshot,
  MemorySource,
  MemorySourceType,
  MemoryStatus,
  MemoryType,
} from "../../../shared/contracts/memory";
import styles from "./MemoryPage.module.css";

const memoryTypes: ReadonlyArray<{ label: string; value: MemoryType }> = [
  { label: "画像", value: "profile" },
  { label: "偏好", value: "preference" },
  { label: "项目", value: "project" },
  { label: "事件", value: "event" },
  { label: "方法", value: "procedure" },
  { label: "约定", value: "commitment" },
  { label: "活动摘要", value: "activity_digest" },
  { label: "Agent 学习", value: "agent_learning" },
];

const sourceTypes: ReadonlyArray<{
  label: string;
  value: MemorySourceType;
}> = [
  { label: "Chat", value: "chat" },
  { label: "Voice", value: "voice" },
  { label: "Activity", value: "activity" },
  { label: "工具", value: "tool" },
  { label: "用户编辑", value: "user_edit" },
  { label: "蒸馏", value: "distillation" },
];

const typeLabel = new Map(
  memoryTypes.map(({ label, value }) => [value, label]),
);
const sourceLabel = new Map(
  sourceTypes.map(({ label, value }) => [value, label]),
);
const claimOperationLabel = new Map<MemoryClaimOperation, string>([
  ["create", "新建"],
  ["replace", "替换"],
  ["append", "追加"],
  ["remove", "移除"],
]);
const claimSlotLabel = new Map<MemoryClaimSlot, string>([
  ["profile.name", "姓名"],
  ["profile.pronouns", "称谓"],
  ["profile.home_location", "居住地"],
  ["profile.timezone", "时区"],
  ["profile.occupation", "职业"],
  ["profile.languages", "语言"],
  ["profile.birth_date", "生日"],
  ["preference.hobbies", "爱好"],
  ["preference.likes", "喜欢"],
  ["preference.dislikes", "不喜欢"],
  ["preference.response_style", "回答风格"],
  ["preference.communication_style", "沟通风格"],
  ["preference.food", "饮食"],
  ["preference.music", "音乐"],
  ["preference.media", "内容"],
  ["preference.travel", "出行"],
  ["preference.schedule", "时间安排"],
  ["preference.tools", "工具"],
]);

function currentContent(hit: MemoryHit): string {
  return hit.revision.content;
}

function dateLabel(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(timestamp));
}

function dateTimeLabel(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(timestamp));
}

function endOfLocalDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day! + 1, 0, 0, 0, -1).toISOString();
}

interface MemoryPageProps {
  readonly api?: MemoryApi;
  readonly onOpenSource?: (source: MemorySource) => void;
  readonly onOpenTerritory: () => void;
}

export function MemoryPage({
  api = window.charaMate.memory,
  onOpenSource,
  onOpenTerritory,
}: MemoryPageProps) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MemoryType | "">("");
  const [status, setStatus] = useState<MemoryStatus | "">("active");
  const [sourceType, setSourceType] = useState<MemorySourceType | "">("");
  const [asOfDate, setAsOfDate] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftType, setDraftType] = useState<MemoryType>("preference");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const detailSequence = useRef(0);
  const loadSequence = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const request = useMemo<MemoryListRequest>(
    () => ({
      ...(asOfDate ? { asOf: endOfLocalDate(asOfDate) } : {}),
      ...(includeDeleted ? { includeDeleted: true } : {}),
      ...(!status ? { includeInactive: true } : {}),
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(sourceType ? { sourceType } : {}),
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
    }),
    [asOfDate, includeDeleted, query, sourceType, status, type],
  );

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const response = await api.list(request);
      if (sequence !== loadSequence.current) return;
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setSnapshot(response.value);
      setError(null);
      if (
        selectedIdRef.current &&
        !response.value.memories.some(
          ({ memory }) => memory.id === selectedIdRef.current,
        )
      ) {
        detailSequence.current += 1;
        setSelectedId(null);
        setDetail(null);
      }
    } catch {
      if (sequence === loadSequence.current)
        setError("无法读取 Memory，请重试。");
    }
  }, [api, request]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    detailSequence.current += 1;
    setSelectedId(null);
    setDetail(null);
  }, [asOfDate]);

  const virtualizer = useVirtualizer({
    count: snapshot?.memories.length ?? 0,
    estimateSize: () => 78,
    getScrollElement: () => listRef.current,
    overscan: 6,
  });

  const openDetail = async (memoryId: string) => {
    const sequence = ++detailSequence.current;
    setSelectedId(memoryId);
    try {
      const response = await api.get({ memoryId });
      if (sequence !== detailSequence.current) return;
      if (response.ok) {
        const historicalHit = asOfDate
          ? snapshot?.memories.find(({ memory }) => memory.id === memoryId)
          : undefined;
        const nextDetail = (() => {
          if (!historicalHit) return response.value;
          const asOf = endOfLocalDate(asOfDate);
          const revisions = response.value.revisions.filter(
            ({ createdAt }) => createdAt <= asOf,
          );
          const sourceIds = new Set(
            revisions.flatMap(({ sourceIds: ids }) => ids),
          );
          const revisionIds = new Set(revisions.map(({ id }) => id));
          return {
            ...response.value,
            memory: historicalHit.memory,
            revisions,
            sources: response.value.sources.filter(({ id }) =>
              sourceIds.has(id),
            ),
            usages: response.value.usages.filter(
              ({ revisionId, usedAt }) =>
                revisionIds.has(revisionId) && usedAt <= asOf,
            ),
          };
        })();
        setDetail(nextDetail);
        setDraft(
          nextDetail.revisions.find(
            ({ id }) => id === nextDetail.memory.currentRevisionId,
          )?.content ?? "",
        );
        setError(null);
      } else setError(response.error.message);
    } catch {
      if (sequence === detailSequence.current)
        setError("无法读取这条记忆，请重试。");
    }
  };

  const mutate = async (
    operation: () => ReturnType<
      | MemoryApi["archive"]
      | MemoryApi["delete"]
      | MemoryApi["restore"]
      | MemoryApi["setPinned"]
      | MemoryApi["revise"]
    >,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await operation();
      if (response.ok) {
        setDetail(response.value);
        setDraft(
          response.value.revisions.find(
            ({ id }) => id === response.value.memory.currentRevisionId,
          )?.content ?? "",
        );
        await load();
      } else setError(response.error.message);
    } catch {
      setError("记忆没有更新，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const createMemory = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const response = await api.create({
        confidence: 1,
        content,
        importance: 0.5,
        reason: "用户在 Memory 页面创建",
        sources: [],
        type: draftType,
      });
      if (response.ok) {
        setCreating(false);
        setDraft("");
        await load();
        await openDetail(response.value.memory.id);
      } else setError(response.error.message);
    } catch {
      setError("新记忆没有保存，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const decideCandidate = async (candidateId: string, accept: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = accept
        ? await api.acceptCandidate({ candidateId })
        : await api.rejectCandidate({ candidateId });
      if (response.ok) await load();
      else setError(response.error.message);
    } catch {
      setError("候选状态没有更新，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const purgeMemory = async () => {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const response = await api.purge({ memoryId: detail.memory.id });
      if (response.ok) {
        detailSequence.current += 1;
        setDetail(null);
        setSelectedId(null);
        await load();
      } else setError(response.error.message);
    } catch {
      setError("记忆没有永久删除，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const activeRevision = detail?.revisions.find(
    ({ id }) => id === detail.memory.currentRevisionId,
  );
  const activeSourceIds = new Set(activeRevision?.sourceIds ?? []);
  const activeSources =
    detail?.sources.filter(({ id }) => activeSourceIds.has(id)) ?? [];
  const historical = Boolean(asOfDate);
  const restorable = Boolean(
    detail && (detail.memory.deletedAt || detail.memory.status === "archived"),
  );
  const canEdit = Boolean(
    !historical &&
    detail &&
    !detail.memory.deletedAt &&
    detail.memory.status === "active",
  );

  return (
    <section className={styles["page"]}>
      <div className={styles["toolbar"]}>
        <label className={styles["search"]}>
          <Search aria-hidden="true" size={15} />
          <input
            aria-label="搜索记忆"
            placeholder="搜索记忆内容"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <select
          aria-label="记忆类型"
          value={type}
          onChange={(event) =>
            setType(event.currentTarget.value as MemoryType | "")
          }
        >
          <option value="">全部类型</option>
          {memoryTypes.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          aria-label="记忆状态"
          value={status}
          onChange={(event) =>
            setStatus(event.currentTarget.value as MemoryStatus | "")
          }
        >
          <option value="">全部状态</option>
          <option value="active">当前有效</option>
          <option value="superseded">已被取代</option>
          <option value="archived">已归档</option>
        </select>
        <select
          aria-label="记忆来源"
          value={sourceType}
          onChange={(event) =>
            setSourceType(event.currentTarget.value as MemorySourceType | "")
          }
        >
          <option value="">全部来源</option>
          {sourceTypes.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <input
          aria-label="记忆截至日期"
          className={styles["dateFilter"]}
          type="date"
          value={asOfDate}
          onChange={(event) => setAsOfDate(event.currentTarget.value)}
        />
        <label className={styles["deletedToggle"]}>
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setIncludeDeleted(checked);
              if (checked) setStatus("");
            }}
          />
          含已删除
        </label>
        <button
          className={styles["primaryButton"]}
          disabled={historical}
          type="button"
          onClick={() => {
            detailSequence.current += 1;
            setCreating(true);
            setSelectedId(null);
            setDetail(null);
            setDraft("");
          }}
        >
          <Plus aria-hidden="true" size={15} /> 新记忆
        </button>
      </div>

      {error ? (
        <div className={styles["error"]} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles["workspace"]}>
        <aside className={styles["leftColumn"]}>
          {snapshot?.profile.length ? (
            <section className={styles["profile"]}>
              <span>Profile</span>
              {snapshot.profile.slice(0, 3).map((hit) => (
                <button
                  key={hit.memory.id}
                  type="button"
                  onClick={() => void openDetail(hit.memory.id)}
                >
                  {currentContent(hit)}
                </button>
              ))}
            </section>
          ) : null}
          {!historical && snapshot?.candidates.length ? (
            <section className={styles["candidates"]}>
              <header>
                <strong>待确认</strong>
                <span>{snapshot.candidates.length}</span>
              </header>
              {snapshot.candidates.map((candidate) => (
                <article key={candidate.id}>
                  <p>{candidate.content}</p>
                  <small>{candidate.reason}</small>
                  {candidate.claimOperation ? (
                    <small>
                      处理：{claimOperationLabel.get(candidate.claimOperation)}
                      {candidate.claimSlot
                        ? ` · 字段：${claimSlotLabel.get(candidate.claimSlot)}`
                        : ""}
                      {candidate.supersedesMemoryId ? " · 更新现有记忆" : ""}
                    </small>
                  ) : null}
                  <small>
                    来源：{sourceLabel.get(candidate.sourceType)} ·{" "}
                    {candidate.sourceLabels.join(" · ")}
                  </small>
                  <div>
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() => void decideCandidate(candidate.id, true)}
                    >
                      <Check aria-hidden="true" size={13} /> 接受
                    </button>
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() => void decideCandidate(candidate.id, false)}
                    >
                      <X aria-hidden="true" size={13} /> 忽略
                    </button>
                  </div>
                </article>
              ))}
            </section>
          ) : null}
          <div ref={listRef} className={styles["memoryList"]}>
            {snapshot && snapshot.memories.length === 0 ? (
              <p className={styles["empty"]}>没有符合筛选条件的记忆。</p>
            ) : (
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((row) => {
                  const hit = snapshot?.memories[row.index];
                  if (!hit) return null;
                  return (
                    <button
                      key={hit.memory.id}
                      className={styles["memoryRow"]}
                      data-selected={selectedId === hit.memory.id || undefined}
                      type="button"
                      style={{
                        height: row.size,
                        transform: `translateY(${String(row.start)}px)`,
                      }}
                      onClick={() => void openDetail(hit.memory.id)}
                    >
                      <span>
                        <em>{typeLabel.get(hit.memory.type)}</em>
                        {hit.memory.pinnedAt ? (
                          <Pin aria-label="已置顶" size={12} />
                        ) : null}
                        {hit.memory.deletedAt ? <i>已删除</i> : null}
                      </span>
                      <strong>{currentContent(hit)}</strong>
                      <small>{dateLabel(hit.memory.updatedAt)}</small>
                      <ChevronRight aria-hidden="true" size={14} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <main className={styles["detail"]}>
          {creating ? (
            <section className={styles["editor"]}>
              <p>New memory</p>
              <h2>记录一件值得长期保留的事</h2>
              <select
                value={draftType}
                onChange={(event) =>
                  setDraftType(event.currentTarget.value as MemoryType)
                }
              >
                {memoryTypes.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <textarea
                autoFocus
                aria-label="新记忆内容"
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
              <div>
                <button type="button" onClick={() => setCreating(false)}>
                  取消
                </button>
                <button
                  className={styles["primaryButton"]}
                  disabled={busy || !draft.trim()}
                  type="button"
                  onClick={() => void createMemory()}
                >
                  保存
                </button>
              </div>
            </section>
          ) : detail && activeRevision ? (
            <>
              <section className={styles["detailHeader"]}>
                <div>
                  <span>{typeLabel.get(detail.memory.type)}</span>
                  <h2>{activeRevision.content}</h2>
                  <p>
                    {historical
                      ? `截至 ${asOfDate} 的历史状态`
                      : `更新于 ${dateLabel(detail.memory.updatedAt)}`}{" "}
                    · {sourceLabel.get(activeRevision.sourceType)}
                  </p>
                </div>
                <div className={styles["actions"]}>
                  <button
                    disabled={historical}
                    type="button"
                    title="在领地中查看"
                    onClick={onOpenTerritory}
                  >
                    <MapIcon aria-hidden="true" size={15} />
                    领地
                  </button>
                  <button
                    disabled={busy || !canEdit}
                    type="button"
                    onClick={() =>
                      void mutate(() =>
                        api.setPinned({
                          memoryId: detail.memory.id,
                          pinned: !detail.memory.pinnedAt,
                        }),
                      )
                    }
                  >
                    {detail.memory.pinnedAt ? (
                      <PinOff aria-hidden="true" size={15} />
                    ) : (
                      <Pin aria-hidden="true" size={15} />
                    )}
                    {detail.memory.pinnedAt ? "取消置顶" : "置顶"}
                  </button>
                  {restorable ? (
                    <button
                      disabled={busy || historical}
                      type="button"
                      onClick={() =>
                        void mutate(() =>
                          api.restore({ memoryId: detail.memory.id }),
                        )
                      }
                    >
                      <ArchiveRestore aria-hidden="true" size={15} />
                      恢复
                    </button>
                  ) : (
                    <button
                      disabled={busy || historical}
                      type="button"
                      onClick={() =>
                        void mutate(() =>
                          api.archive({ memoryId: detail.memory.id }),
                        )
                      }
                    >
                      <Archive aria-hidden="true" size={15} />
                      归档
                    </button>
                  )}
                  <button
                    className={styles["dangerButton"]}
                    disabled={busy || historical}
                    type="button"
                    onClick={() => {
                      if (!detail.memory.deletedAt)
                        void mutate(() =>
                          api.delete({ memoryId: detail.memory.id }),
                        );
                      else if (
                        window.confirm("永久删除这条记忆及全部 Revision？")
                      )
                        void purgeMemory();
                    }}
                  >
                    <Trash2 aria-hidden="true" size={15} />
                    {detail.memory.deletedAt ? "永久删除" : "删除"}
                  </button>
                </div>
              </section>
              <section className={styles["editor"]}>
                <h3>当前内容</h3>
                <textarea
                  aria-label="编辑记忆内容"
                  disabled={!canEdit}
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                />
                <button
                  className={styles["primaryButton"]}
                  disabled={
                    busy ||
                    !canEdit ||
                    !draft.trim() ||
                    draft.trim() === activeRevision.content
                  }
                  type="button"
                  onClick={() =>
                    void mutate(() =>
                      api.revise({
                        content: draft.trim(),
                        memoryId: detail.memory.id,
                        reason: "用户在 Memory 页面编辑",
                        sources: [],
                      }),
                    )
                  }
                >
                  保存为新 Revision
                </button>
              </section>
              <section className={styles["timeline"]}>
                <h3>Revision 时间线</h3>
                {detail.revisions.map((revision) => {
                  const revisionSourceIds = new Set(revision.sourceIds);
                  const revisionSources = detail.sources.filter(({ id }) =>
                    revisionSourceIds.has(id),
                  );
                  return (
                    <article
                      key={revision.id}
                      data-current={
                        revision.id === detail.memory.currentRevisionId ||
                        undefined
                      }
                    >
                      <span />
                      <div>
                        <strong>{revision.content}</strong>
                        <small>
                          {dateLabel(revision.createdAt)} · {revision.reason} ·{" "}
                          {sourceLabel.get(revision.sourceType)}
                          {revisionSources.length
                            ? ` · ${revisionSources
                                .map(
                                  (source) =>
                                    source.label ?? source.referenceId,
                                )
                                .join("、")}`
                            : ""}
                        </small>
                      </div>
                    </article>
                  );
                })}
              </section>
              <section className={styles["sources"]}>
                <h3>当前 Revision 来源</h3>
                {activeSources.length ? (
                  activeSources.map((source) => {
                    const openable =
                      onOpenSource &&
                      (source.type === "activity" ||
                        source.type === "chat" ||
                        source.type === "voice");
                    const content = (
                      <>
                        <strong>{sourceLabel.get(source.type)}</strong>
                        <span>{source.label ?? source.referenceId}</span>
                        {openable ? (
                          <ChevronRight aria-hidden="true" size={13} />
                        ) : null}
                      </>
                    );
                    return openable ? (
                      <button
                        key={source.id}
                        aria-label={`${sourceLabel.get(source.type)} ${source.label ?? source.referenceId}`}
                        type="button"
                        onClick={() => onOpenSource?.(source)}
                      >
                        {content}
                      </button>
                    ) : (
                      <div key={source.id}>{content}</div>
                    );
                  })
                ) : (
                  <p>这条 Revision 由用户直接编辑。</p>
                )}
              </section>
              <section className={styles["usages"]}>
                <h3>被使用记录</h3>
                {detail.usages.length ? (
                  detail.usages.map((usage) => (
                    <div key={usage.id}>
                      <strong>
                        {usage.consumer === "context"
                          ? "上下文装配"
                          : "memory.search"}
                      </strong>
                      <span>
                        {dateTimeLabel(usage.usedAt)} ·{" "}
                        {detail.revisions.find(
                          ({ id }) => id === usage.revisionId,
                        )?.content ?? usage.revisionId}
                      </span>
                    </div>
                  ))
                ) : (
                  <p>这条记忆还没有被模型读取。</p>
                )}
              </section>
            </>
          ) : (
            <div className={styles["detailEmpty"]}>
              <strong>选择一条记忆</strong>
              <span>查看当前内容、来源和历史 Revision。</span>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
