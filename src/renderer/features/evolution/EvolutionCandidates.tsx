import {
  Archive,
  ArchiveRestore,
  Check,
  Pin,
  PinOff,
  RefreshCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  EvolutionApi,
  EvolutionCandidate,
  EvolutionCandidateKind,
  EvolutionProposal,
  EvolutionReview,
} from "../../../shared/contracts/evolution";
import styles from "./EvolutionCandidates.module.css";

const kindLabels: Record<EvolutionCandidateKind, string> = {
  memory: "记忆",
  new_skill: "新 Skill",
  persona_preference: "Persona 偏好",
  skill_patch: "Skill patch",
};

const statusLabels: Record<EvolutionCandidate["status"], string> = {
  accepted: "已接受 · 等待 replay",
  active: "已生效",
  archived: "已归档",
  draft: "待确认",
  rejected: "已拒绝",
  stale: "旧版本",
};

function proposalContent(proposal: EvolutionProposal): string {
  return proposal.content;
}

function withContent(
  proposal: EvolutionProposal,
  content: string,
): EvolutionProposal {
  return { ...proposal, content };
}

function defaultApi(): EvolutionApi | undefined {
  return typeof window === "undefined"
    ? undefined
    : window.charaMate?.evolution;
}

interface EvolutionCandidateCardProps {
  readonly allowEdit?: boolean;
  readonly api: EvolutionApi;
  readonly candidate: EvolutionCandidate;
  readonly compact?: boolean;
  readonly onChanged?: (candidate: EvolutionCandidate) => void;
}

export function EvolutionCandidateCard({
  allowEdit = false,
  api,
  candidate,
  compact = false,
  onChanged,
}: EvolutionCandidateCardProps) {
  const [edit, setEdit] = useState({
    content: proposalContent(candidate.proposal),
    version: candidate.updatedAt,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const content =
    edit.version === candidate.updatedAt
      ? edit.content
      : proposalContent(candidate.proposal);

  const mutate = async (
    operation: () => ReturnType<
      | EvolutionApi["acceptCandidate"]
      | EvolutionApi["archiveCandidate"]
      | EvolutionApi["rejectCandidate"]
      | EvolutionApi["restoreCandidate"]
      | EvolutionApi["retryReplay"]
      | EvolutionApi["setCandidatePinned"]
      | EvolutionApi["updateCandidate"]
    >,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await operation();
      if (response.ok) onChanged?.(response.value);
      else setError(response.error.message);
    } catch {
      setError("成长候选没有更新，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const changed = content.trim() !== proposalContent(candidate.proposal);
  const canDecide = candidate.status === "draft";
  const canEdit =
    allowEdit &&
    (candidate.status === "draft" ||
      (candidate.status === "accepted" &&
        candidate.replayResult.status === "failed"));
  const skillName =
    candidate.proposal.kind === "new_skill" ||
    candidate.proposal.kind === "skill_patch"
      ? candidate.proposal.name
      : undefined;
  const isSkillCandidate = Boolean(skillName);
  const isSettledSkillResult = Boolean(
    skillName &&
    candidate.activatedAt &&
    (candidate.status === "active" ||
      candidate.status === "stale" ||
      candidate.status === "archived"),
  );
  const settledSkillStatus =
    candidate.status === "archived"
      ? candidate.activatedSkillId
        ? "Skill 已归档"
        : "原 Skill 已删除"
      : "已保存为 Skill";
  const replayLabel =
    candidate.replayResult.status === "not_required"
      ? undefined
      : `replay · ${candidate.replayResult.status}`;
  const compactMeta = isSettledSkillResult
    ? candidate.status === "archived"
      ? candidate.activatedSkillId
        ? "可在 Settings → Skills 的“已归档”中恢复。"
        : "这里只保留本次学习来源，不能从这里恢复。"
      : candidate.status === "stale"
        ? "Skill 后来已更新；当前内容以 Settings → Skills 为准。"
        : "已成为 Agent Skill；请在 Settings → Skills 管理。"
    : replayLabel;

  return (
    <article
      className={styles["candidate"]}
      data-compact={compact || undefined}
      aria-label={isSettledSkillResult ? "已学会的 Skill" : "这次学到了什么"}
    >
      <header>
        <div>
          <small>{isSettledSkillResult ? "成长结果" : "这次学到了什么"}</small>
          <strong>
            {isSettledSkillResult ? skillName : kindLabels[candidate.kind]}
          </strong>
        </div>
        <span data-status={candidate.status}>
          {isSettledSkillResult
            ? settledSkillStatus
            : statusLabels[candidate.status]}
        </span>
      </header>
      <p className={styles["rationale"]}>{candidate.rationale}</p>
      {isSettledSkillResult ? null : canEdit ? (
        <textarea
          aria-label="候选内容"
          value={content}
          onChange={(event) =>
            setEdit({
              content: event.currentTarget.value,
              version: candidate.updatedAt,
            })
          }
        />
      ) : (
        <pre>{proposalContent(candidate.proposal)}</pre>
      )}
      {!compact ? (
        <details>
          <summary>证据与边界</summary>
          <ul>
            {candidate.evidence.map((evidence) => (
              <li key={evidence}>{evidence}</li>
            ))}
          </ul>
          <p>
            来源 Run：{candidate.sourceRunIds.join("、")}
            {replayLabel ? ` · ${replayLabel}` : ""}
          </p>
          {candidate.replayResult.failureReason ? (
            <p className={styles["error"]}>
              {candidate.replayResult.failureReason}
            </p>
          ) : null}
        </details>
      ) : compactMeta ? (
        <small className={styles["meta"]}>{compactMeta}</small>
      ) : null}
      {error ? (
        <p className={styles["error"]} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles["actions"]}>
        {canEdit && changed ? (
          <button
            disabled={busy || !content.trim()}
            type="button"
            onClick={() =>
              void mutate(() =>
                api.updateCandidate({
                  candidateId: candidate.id,
                  proposal: withContent(candidate.proposal, content.trim()),
                  rationale: candidate.rationale,
                  replayCases: candidate.replayCases,
                }),
              )
            }
          >
            保存修改
          </button>
        ) : null}
        {canDecide ? (
          <>
            <button
              disabled={busy}
              type="button"
              onClick={() =>
                void mutate(() =>
                  api.rejectCandidate({ candidateId: candidate.id }),
                )
              }
            >
              <X aria-hidden="true" size={13} />
              忽略
            </button>
            <button
              className={styles["primary"]}
              disabled={busy}
              type="button"
              onClick={() =>
                void mutate(() =>
                  api.acceptCandidate({ candidateId: candidate.id }),
                )
              }
            >
              <Check aria-hidden="true" size={13} />
              接受
            </button>
          </>
        ) : null}
        {candidate.status === "accepted" &&
        candidate.replayResult.status === "failed" ? (
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void mutate(() => api.retryReplay({ candidateId: candidate.id }))
            }
          >
            <RefreshCcw aria-hidden="true" size={13} />
            重试 replay
          </button>
        ) : null}
        {!isSkillCandidate && candidate.status === "archived" ? (
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void mutate(() =>
                api.restoreCandidate({ candidateId: candidate.id }),
              )
            }
          >
            <ArchiveRestore aria-hidden="true" size={13} />
            恢复
          </button>
        ) : !isSkillCandidate &&
          !canDecide &&
          candidate.status !== "accepted" ? (
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void mutate(() =>
                api.archiveCandidate({ candidateId: candidate.id }),
              )
            }
          >
            <Archive aria-hidden="true" size={13} />
            归档
          </button>
        ) : null}
        {!isSkillCandidate && candidate.status === "active" ? (
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void mutate(() =>
                api.setCandidatePinned({
                  candidateId: candidate.id,
                  pinned: !candidate.pinned,
                }),
              )
            }
          >
            {candidate.pinned ? (
              <PinOff aria-hidden="true" size={13} />
            ) : (
              <Pin aria-hidden="true" size={13} />
            )}
            {candidate.pinned ? "取消 pin" : "Pin"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function EvolutionCandidates({
  allowEdit = false,
  api = defaultApi(),
  chatId,
  compact = false,
  description,
  kinds,
}: {
  readonly allowEdit?: boolean;
  readonly api?: EvolutionApi;
  readonly chatId?: string;
  readonly compact?: boolean;
  readonly description?: string;
  readonly kinds?: readonly EvolutionCandidateKind[];
}) {
  const [candidates, setCandidates] = useState<EvolutionCandidate[]>([]);
  const [reviews, setReviews] = useState<EvolutionReview[]>([]);
  const [error, setError] = useState<string>();
  const [retryingRunId, setRetryingRunId] = useState<string>();
  const kindKey = kinds?.join(",") ?? "";

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const response = await api.list({
        ...(chatId ? { chatId } : {}),
        includeArchived: !compact,
      });
      if (response.ok) {
        setCandidates(response.value.candidates);
        setReviews(response.value.reviews);
        setError(undefined);
      } else setError(response.error.message);
    } catch {
      setError("无法读取成长候选。");
    }
  }, [api, chatId, compact]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .list({
        ...(chatId ? { chatId } : {}),
        includeArchived: !compact,
      })
      .then((response) => {
        if (!active) return;
        if (response.ok) {
          setCandidates(response.value.candidates);
          setReviews(response.value.reviews);
          setError(undefined);
        } else setError(response.error.message);
      })
      .catch(() => {
        if (active) setError("无法读取成长候选。");
      });
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "candidate.changed") {
        if (chatId && event.candidate.chatId !== chatId) return;
        setCandidates((current) => {
          const next = current.filter(({ id }) => id !== event.candidate.id);
          if (!compact || event.candidate.status !== "archived") {
            next.push(event.candidate);
          }
          return next.sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
          );
        });
        return;
      }
      if (chatId && event.review.chatId !== chatId) return;
      setReviews((current) => [
        ...current.filter(({ id }) => id !== event.review.id),
        event.review,
      ]);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, chatId, compact]);

  const filtered = useMemo(() => {
    const allowed = kindKey ? new Set(kindKey.split(",")) : undefined;
    return candidates.filter(
      (candidate) =>
        (!allowed || allowed.has(candidate.kind)) &&
        (!compact ||
          candidate.status === "draft" ||
          candidate.status === "accepted"),
    );
  }, [candidates, compact, kindKey]);
  const failedReviews = reviews.filter(({ status }) => status === "failed");
  const updateReview = (changed: EvolutionReview) => {
    setReviews((current) => [
      ...current.filter(({ id }) => id !== changed.id),
      changed,
    ]);
  };

  if (!api || (filtered.length === 0 && failedReviews.length === 0 && !error)) {
    return null;
  }
  return (
    <section
      className={styles["collection"]}
      data-compact={compact || undefined}
      aria-label="成长候选"
    >
      {!compact ? (
        <header className={styles["collectionHeader"]}>
          <div>
            <p>Experience Review</p>
            <h3>成长候选</h3>
            {description ? (
              <small className={styles["collectionDescription"]}>
                {description}
              </small>
            ) : null}
          </div>
          <button type="button" onClick={() => void load()}>
            <RefreshCcw aria-hidden="true" size={13} />
            刷新
          </button>
        </header>
      ) : null}
      {error ? (
        <p className={styles["error"]} role="alert">
          {error}
        </p>
      ) : null}
      {failedReviews.map((review) => (
        <article className={styles["reviewFailure"]} key={review.id}>
          <div>
            <strong>成长复盘未完成</strong>
            <small>{review.error?.message ?? "复盘没有完成。"}</small>
            <small>不影响现有 Memory。</small>
          </div>
          <div className={styles["failureActions"]}>
            <button
              disabled={retryingRunId === review.runId}
              type="button"
              onClick={() => {
                setRetryingRunId(review.runId);
                setError(undefined);
                void api
                  .retryReview({ runId: review.runId })
                  .then((response) => {
                    if (response.ok) updateReview(response.value);
                    else setError(response.error.message);
                  })
                  .catch(() => setError("复盘没有重试，请稍后再试。"))
                  .finally(() => setRetryingRunId(undefined));
              }}
            >
              <RefreshCcw aria-hidden="true" size={13} />
              重试
            </button>
            <button
              disabled={retryingRunId === review.runId}
              type="button"
              onClick={() => {
                setError(undefined);
                void api
                  .dismissReview({ runId: review.runId })
                  .then((response) => {
                    if (response.ok) updateReview(response.value);
                    else setError(response.error.message);
                  })
                  .catch(() => setError("复盘状态没有关闭，请稍后再试。"));
              }}
            >
              <X aria-hidden="true" size={13} />
              关闭
            </button>
          </div>
        </article>
      ))}
      <div className={styles["candidateList"]}>
        {filtered.map((candidate) => (
          <EvolutionCandidateCard
            allowEdit={allowEdit}
            api={api}
            candidate={candidate}
            compact={compact}
            key={candidate.id}
            onChanged={(changed) =>
              setCandidates((current) =>
                current.map((item) =>
                  item.id === changed.id ? changed : item,
                ),
              )
            }
          />
        ))}
      </div>
    </section>
  );
}
